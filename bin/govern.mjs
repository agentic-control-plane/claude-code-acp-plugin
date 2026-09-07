#!/usr/bin/env node

// ACP Governance Hook — Pre- and Post-ToolUse interceptor
//
// Dispatches on input.hook_event_name:
//   PreToolUse  (default)  — /govern/tool-use   — can deny the call
//   PostToolUse            — /govern/tool-output — scans returned data
//
// PreToolUse flow (v0.5.0):
//   1. Call /govern/tool-use to get the policy decision (deny / ask / allow).
//   2. If decision is deny / ask, emit accordingly and exit.
//   3. If decision is allow AND the tool matches a vendor pattern (e.g.
//      Bash.gh, curl github.com), request a short-lived ACP-issued scoped
//      token from /api/v1/scoped-tokens, then mutate the Bash command to
//      prefix the token as an env var (`GH_TOKEN=<acp_token> gh ...`).
//      The user's local long-lived PAT is never read or used by the agent.
//   4. If the user hasn't connected the provider, emit deny with a clickable
//      connect URL so they can complete OAuth without leaving the IDE.
//   5. If the scoped-token endpoint isn't enabled (404), pass through —
//      existing local-credential workflows continue unchanged.
//
// Outcome categories — keep the prefixes distinct so a user can tell
// at-a-glance what happened:
//   "[ACP] Denied by policy: ..."            (policy said no — all tiers)
//   "[ACP] ⚠ UNGOVERNED: gateway unreachable" (interactive lapse — proceeded, logged)
//   "[ACP] Gateway unreachable ... stays blocked" (unattended tier fail-closed)
//
// Phase 1 of cross-arch credential brokering — see
// gatewaystack-connect/docs/cross-arch-governance-strategy.md (parent
// epic gatewaystack-connect#114, this work tracked at gatewaystack-connect#115).
//
// Unreachability posture (#385, 2026-07-21): interactive tier fails OPEN
// with a loud UNGOVERNED warning + ~/.acp/lapse.log entry (never-brick:
// an ACP outage must not freeze every governed session); subagent /
// background tiers fail CLOSED (nobody is watching — the block IS the
// safety net). Since v0.14.0 (gatewaystack-connect#902) an interactive
// lapse is also queued per session under ~/.acp/lapse-pending/ and carried
// on the session's next PostToolUse as `pre_lapse`, so the gateway gets a
// row for the call that ran ungoverned instead of only the local log. Note: before v0.6.5 this comment claimed fail-open while
// the code failed closed — the posture is now real, decided, and tested.
// Fails OPEN on /api/v1/scoped-tokens errors by default — server-side
// per-tenant policy can flip this to fail-closed. The plugin currently
// always fails open on token-request errors and surfaces a stderr warning;
// future versions will respect the server's `scopedTokensFailMode` policy.

import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join, isAbsolute } from "path";
import { createHash } from "crypto";
import { pathToFileURL, fileURLToPath } from "url";

// Data-plane base. Vendor egress proxying (e.g. GH_HOST → /api/v3) must
// stay on the main gateway — those routes are not served by the
// control-plane service.
const ACP_API =
  process.env.ACP_API_BASE || "https://api.agenticcontrolplane.com";

// Control-plane base for hook decisions + scoped-token exchange
// (gatewaystack-connect#246). These have a 4s budget and go to a dedicated
// service so they never queue behind model-proxy streams. Falls back to
// ACP_API_BASE for self-hosted single-service deployments. The run.app URL
// is Cloud Run's stable service address; a branded alias
// (govern.agenticcontrolplane.com) may replace it in a future release.
const ACP_GOVERN =
  process.env.ACP_GOVERN_BASE ||
  process.env.ACP_API_BASE ||
  "https://govern.agenticcontrolplane.com";

const PLUGIN_VERSION = "0.15.0";

// Console base for user-facing deep links (session receipt, #606).
const ACP_CONSOLE =
  process.env.ACP_CONSOLE_BASE || "https://cloud.agenticcontrolplane.com";

// Per-session receipt counters (Stop hook). Written best-effort on
// PostToolUse, read + cleared by handleStop.
const SESSION_STATS_DIR = join(homedir(), ".acp", "session-stats");

// Per-session pending lapse markers (gatewaystack-connect#902). Written on
// an interactive fail-open at PreToolUse, carried on the next PostToolUse
// as `pre_lapse`, and deleted once the gateway has acknowledged (2xx).
// Bounded to LAPSE_PENDING_CAP entries per session — lapse.log keeps the
// unbounded record. Every operation is best-effort: a marker failure must
// never touch the call path in either direction.
const LAPSE_PENDING_DIR = join(homedir(), ".acp", "lapse-pending");
const LAPSE_PENDING_CAP = 20;

function safeSessionFile(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
}

function lapsePendingPath(sessionId) {
  return join(LAPSE_PENDING_DIR, `${safeSessionFile(sessionId)}.json`);
}

function readPendingLapse(sessionId) {
  if (!sessionId || sessionId === "unknown") return null;
  try {
    const raw = JSON.parse(readFileSync(lapsePendingPath(sessionId), "utf8"));
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return raw.slice(-LAPSE_PENDING_CAP);
  } catch {
    return null;
  }
}

function recordPendingLapse(sessionId, toolName, detail) {
  if (!sessionId || sessionId === "unknown") return;
  try {
    mkdirSync(LAPSE_PENDING_DIR, { recursive: true });
    const list = readPendingLapse(sessionId) ?? [];
    list.push({
      at: new Date().toISOString(),
      tool: String(toolName ?? "unknown").slice(0, 120),
      detail: String(detail ?? "unknown").slice(0, 200),
    });
    writeFileSync(lapsePendingPath(sessionId), JSON.stringify(list.slice(-LAPSE_PENDING_CAP)));
  } catch { /* best-effort — lapse.log is the durable record */ }
}

function clearPendingLapse(sessionId) {
  if (!sessionId || sessionId === "unknown") return;
  try { unlinkSync(lapsePendingPath(sessionId)); } catch { /* absent is fine */ }
}

// Context guard (gatewaystack-connect#1072): size a whole-file read before
// it happens. The engine's readIntent() says WHICH files a Read / cat / head
// / tail would pull into context; this measures them (lines + bytes) so the
// decision — local or gateway — can compare against the policy ceiling. Pure
// measurement, bounded (files over MEASURE_CAP_BYTES are estimated from
// size), never throws: an unmeasurable file is simply not guarded.
const MEASURE_CAP_BYTES = 8 * 1024 * 1024;
function measureFiles(paths, cwd) {
  const out = {};
  for (const p of paths || []) {
    try {
      const abs = isAbsolute(p) ? p : join(cwd || process.cwd(), p);
      const st = statSync(abs);
      if (!st.isFile()) continue;
      if (st.size > MEASURE_CAP_BYTES) { out[p] = { lines: Math.ceil(st.size / 40), bytes: st.size, estimated: true }; continue; }
      const buf = readFileSync(abs);
      let lines = 0;
      for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
      if (buf.length && buf[buf.length - 1] !== 10) lines++;
      out[p] = { lines, bytes: buf.length };
    } catch { /* missing / unreadable: the tool surfaces its own error */ }
  }
  return out;
}

/** { read, files } for the wire and the local engine, or undefined when the
 *  call is not a whole-file read. One parser (decide.mjs readIntent) sizes
 *  reads for every harness; the gateway does arithmetic, never shell syntax. */
async function readContext(input) {
  try {
    let mod;
    try { mod = await import(pathToFileURL(join(ACP_DIR, "decide.mjs")).href); }
    catch { mod = await import("./decide.mjs"); }
    if (typeof mod.readIntent !== "function") return undefined;
    const intent = mod.readIntent(input.tool_name, input.tool_input);
    if (!intent || intent.targeted) return undefined;
    const files = measureFiles(intent.paths, input.cwd);
    return Object.keys(files).length ? { read: intent, files } : undefined;
  } catch { return undefined; }
}

// Identifies the calling client to the server (per-client policy routing).
// Each client's hooks.json sets this env var at invocation time:
// "claude-code-plugin", "cursor", "codex", etc. Falls back to
// claude-code-plugin for backward compat.
const ACP_CLIENT = process.env.ACP_CLIENT || "claude-code-plugin";

// Client-side disable for shadow-mode counterfactual notices
// (gatewaystack-connect#607). The server also honors a tenant-level
// shadowNotices:false; this env var is the local one-sentence off switch.
const SHADOW_OFF = /^(off|0|false)$/i.test(process.env.ACP_SHADOW ?? "");

// Harness quirk switch. Codex adopted Claude Code's hook wire format but
// its parser only ACTS on permissionDecision "deny" — "ask" and
// updatedInput are rejected, which marks the hook run FAILED and lets the
// tool call proceed (fail-open on exactly the calls that needed review).
// Under codex we therefore (a) map ask → deny with the approval link in
// the message (approve on the dashboard, re-run, the grant admits it) and
// (b) skip updatedInput vendor-token injection. The Codex plugin's
// hooks.json sets ACP_HARNESS=codex.
const HARNESS = process.env.ACP_HARNESS || "claude-code";

// 200 KB ceiling on the tool_output payload we send to the backend. Matches
// the backend's scan ceiling.
const POST_HOOK_PAYLOAD_CEILING = 200 * 1024;

// Hostname-only form of ACP_API for env-var injection (e.g. GH_HOST).
// gh CLI accepts hostnames, not URLs — strip protocol + trailing slash.
const ACP_HOST = ACP_API.replace(/^https?:\/\//, "").replace(/\/$/, "");

// Phase 1+2 (cross-arch broker, gatewaystack-connect#114):
// Vendor patterns map matched Bash commands to a (provider, env-var,
// optional proxy-host) triple. Inlined here so govern.mjs is a single
// self-contained file that works in any install layout. Canonical copy
// also lives in lib/vendor-patterns.mjs for the test suite — keep both
// in sync.
//
// hostVar / hostValue (added in v0.6.0): when present, the rewritten
// command sets that env var to redirect the upstream tool through ACP's
// egress proxy. For gh CLI: GH_HOST=<acp-host> → gh routes to
// https://<acp-host>/api/v3/* (GitHub Enterprise URL convention) where
// ACP's proxy at /api/v3 verifies the scoped token and forwards to
// api.github.com with the user's real OAuth credential. Calls without
// hostVar/hostValue (curl, git push) issue a scoped token but the call
// still goes direct to the vendor with the token; in those cases the
// scoped token is only auditable, not actually validating against the
// proxy. Future versions will rewrite curl URLs too.
const VENDOR_PATTERNS = [
  // GitHub — gh CLI (full proxy: GH_HOST + GH_ENTERPRISE_TOKEN).
  // gh maps GH_TOKEN to github.com only; for any non-github.com host
  // (which an ACP-routed call is, by design) gh requires
  // GH_ENTERPRISE_TOKEN. Using the wrong env var causes gh to fall back
  // to its config-stored token, which is usually a stale acp_st_* from
  // a prior session — leading to 400 Bad Request from the gateway.
  {
    regex: /^gh(\s|$)/,
    provider: "github",
    envVar: "GH_ENTERPRISE_TOKEN",
    hostVar: "GH_HOST",
    hostValue: ACP_HOST,
  },
  // GitHub — direct REST via curl (token-only injection; proxy rewrite
  // would require URL substitution, deferred to a follow-up)
  { regex: /^curl\s+(.*\s)?(https?:\/\/)?api\.github\.com/, provider: "github", envVar: "GH_TOKEN" },
  // GitHub — git push over HTTPS (token-only injection)
  { regex: /^git\s+push\s+https:\/\/github\.com\//, provider: "github", envVar: "GH_TOKEN" },
];

function detectVendor(toolName, toolInput) {
  if (toolName !== "Bash") return null;
  const cmd = (toolInput?.command ?? "").toString().trim();
  if (!cmd) return null;
  for (const p of VENDOR_PATTERNS) {
    if (p.regex.test(cmd)) return p;
  }
  return null;
}

function readToken() {
  if (process.env.ACP_BEARER_TOKEN) return process.env.ACP_BEARER_TOKEN;
  // Both credential paths, in the same order as bin/mcp-auth-headers.sh —
  // these MUST stay in sync. When only proxy-key exists, the MCP helper
  // authenticates (tools appear, the key's lastUsedAt updates, the install
  // looks healthy) while a credentials-only hook reads nothing and no-ops:
  // governance silently absent on a machine that looks connected.
  for (const name of ["credentials", "proxy-key"]) {
    try {
      const value = readFileSync(join(homedir(), ".acp", name), "utf8").trim();
      if (value) return value;
    } catch { /* absent or unreadable — try the next path */ }
  }
  return null;
}

// Announce an uncredentialed session once, then stay quiet: loud enough that
// nobody can believe they're governed when they aren't, bounded so a long
// session isn't spammed on every tool call. The lapse line is written every
// time regardless — the log is the durable record even when the banner is
// deduped, and it's what makes the gap auditable after the fact.
function warnUncredentialed(input) {
  const sessionId = String(input?.session_id ?? "unknown");
  try {
    appendFileSync(
      join(homedir(), ".acp", "lapse.log"),
      `${new Date().toISOString()}\tUNGOVERNED\tno-credentials\tclient=${ACP_CLIENT}\tsession=${sessionId}\ttool=${input?.tool_name ?? "?"}\n`
    );
  } catch { /* the lapse log is best-effort — never block a call on it */ }

  const marker = join(homedir(), ".acp", "nocred-session");
  try {
    if (readFileSync(marker, "utf8").trim() === sessionId) return;
  } catch { /* no marker yet — this is the session's first call */ }
  try {
    mkdirSync(join(homedir(), ".acp"), { recursive: true });
    writeFileSync(marker, sessionId);
  } catch { /* best-effort — at worst the banner repeats */ }

  process.stdout.write(JSON.stringify({
    systemMessage:
      "[ACP] ⚠ UNGOVERNED: no API key found at ~/.acp/credentials — tool calls are running WITHOUT policy checks, and ACP has no record of them. " +
      "Get your key at https://cloud.agenticcontrolplane.com, then: echo 'YOUR_API_KEY' > ~/.acp/credentials — and restart this session.",
  }));
}

// Managed rollout, machine not enrolled: block the call and say how to enroll.
// The lapse line is still written (BLOCKED, not UNGOVERNED) so the gap stays
// auditable on the machine; the workspace can't see it yet because there is
// no credential to report under. PreToolUse gets a deny the harness acts on
// (Claude Code, Codex, Cursor all honor permissionDecision: "deny"); other
// events carry the message only, since there is nothing to block.
function blockUnenrolled(input) {
  const sessionId = String(input?.session_id ?? "unknown");
  try {
    appendFileSync(
      join(homedir(), ".acp", "lapse.log"),
      `${new Date().toISOString()}\tBLOCKED\tno-credentials\tclient=${ACP_CLIENT}\tsession=${sessionId}\ttool=${input?.tool_name ?? "?"}\n`
    );
  } catch { /* best-effort — the deny below is the enforcement, not the log */ }
  const reason =
    "[ACP] Not enrolled: this machine runs your organization's ACP policy, but no workspace credential is present at ~/.acp/credentials. " +
    `Enroll once: open ${ACP_CONSOLE}/plugin/authorize, then run: echo 'YOUR_API_KEY' > ~/.acp/credentials — and restart this session.`;
  const ev = typeof input?.hook_event_name === "string" ? input.hook_event_name : "PreToolUse";
  if (ev === "PreToolUse") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
      systemMessage: reason,
    }));
  } else {
    process.stdout.write(JSON.stringify({ systemMessage: reason }));
  }
}

const token = readToken();

// LOCAL mode — the no-login, on-device runtime (`install.sh --local`).
// Active when there is no workspace token AND either a local policy exists
// or ACP_LOCAL=1. Decisions are made on-device by decide.mjs against
// ~/.acp/policy.json; every call is logged to ~/.acp/audit.jsonl. None of
// the fetch() paths below are reachable — nothing leaves the machine.
const ACP_DIR = join(homedir(), ".acp");

// Managed rollouts. An admin who pushes this hook fleet-wide (Codex
// requirements.toml, Claude Code managed settings, Cursor enterprise hooks)
// sets ACP_REQUIRE_ENROLLMENT=1 in the managed hook command or managed env.
// It changes exactly one thing: a machine with no workspace credential BLOCKS
// each call with the enrollment step, instead of running it ungoverned with
// a warning. Nothing else moves — gateway-unreachable posture stays as it is
// (#385), and LOCAL mode is not a substitute, because managed means the
// workspace policy, not a per-laptop one.
const REQUIRE_ENROLLMENT = /^(1|true|required)$/i.test(process.env.ACP_REQUIRE_ENROLLMENT ?? "");

const LOCAL =
  !token &&
  !REQUIRE_ENROLLMENT &&
  (process.env.ACP_LOCAL === "1" || existsSync(join(ACP_DIR, "policy.json")));

// Read stdin via async iteration, not readFileSync("/dev/stdin"): on Linux a
// non-blocking pipe makes the sync read throw EAGAIN, which would silently
// skip governance for every call. (Caught by CI on ubuntu in acp-install.)
// Read before the no-credentials check so the warning can name the session
// and the tool it let through.
let input;
try {
  process.stdin.setEncoding("utf8");
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

// Wired but uncredentialed: the hook runs on every call and has nothing to
// authenticate with, so each one proceeds unchecked. Never brick — but NEVER
// silently, the same contract the unreachable-gateway and missing-engine
// paths already honor. This branch was the exception, and that silence is
// what let installs sit ungoverned for weeks while the installer reported
// success and the server saw a workspace indistinguishable from unused.
if (!token && !LOCAL) {
  if (REQUIRE_ENROLLMENT) {
    blockUnenrolled(input);
    process.exit(0);
  }
  warnUncredentialed(input);
  process.exit(0);
}

if (LOCAL) {
  await runLocal(input);
  process.exit(0);
}

async function runLocal(input) {
  const audit = (obj) => {
    try {
      appendFileSync(join(ACP_DIR, "audit.jsonl"), JSON.stringify(obj) + "\n");
    } catch { /* audit is best-effort — never block the call on it */ }
  };
  const ev = typeof input.hook_event_name === "string" ? input.hook_event_name : "PreToolUse";
  if (ev === "PostToolUse") {
    audit({ ts: new Date().toISOString(), event: "post", client: ACP_CLIENT, tool: input.tool_name });
    return;
  }
  let policy = { default: "allow", rules: {} };
  try {
    policy = JSON.parse(readFileSync(join(ACP_DIR, "policy.json"), "utf8"));
  } catch { /* no/invalid policy → defaults above; the safety floor still applies */ }
  // The decision engine: prefer the installed copy (~/.acp/decide.mjs, kept
  // current by the installer), fall back to the copy bundled next to this
  // file (standalone plugin installs that never ran install.sh).
  let decide;
  try {
    ({ decide } = await import(pathToFileURL(join(ACP_DIR, "decide.mjs")).href));
  } catch {
    try {
      ({ decide } = await import("./decide.mjs"));
    } catch {
      // Engine missing/corrupt → never brick, but NEVER silently: say it
      // loud and leave an audit line, same contract as the cloud path.
      audit({ ts: new Date().toISOString(), event: "pre", client: ACP_CLIENT, tool: input.tool_name,
              decision: "allow", source: "fail-open", reason: "local engine unavailable (~/.acp/decide.mjs)" });
      process.stdout.write(JSON.stringify({
        systemMessage: "[ACP·local] ⚠ decision engine unavailable (~/.acp/decide.mjs) — this call ran UNGOVERNED and was allowed. Re-run the installer to restore it.",
      }));
      return;
    }
  }
  const ctx = await readContext(input);
  const d = decide(input.tool_name, input.tool_input, policy, { ...(ctx || {}), harness: HARNESS });
  audit({ ts: new Date().toISOString(), event: "pre", client: ACP_CLIENT, tool: input.tool_name,
          classified: d.classified, decision: d.decision, source: d.source, reason: d.reason,
          // Context guard ledger: what a whole-file read would have put in
          // context, whether it was blocked (enforce) or only measured (shadow).
          ...(d.contextGuard ? { contextGuard: { mode: d.contextGuard.mode, via: d.contextGuard.via, lines: d.contextGuard.lines,
                                                  effectiveLines: d.contextGuard.effectiveLines, estTokens: d.contextGuard.estTokens,
                                                  maxLines: d.contextGuard.maxLines } } : {}) });
  if (d.decision === "deny") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `[ACP] ${d.reason}` },
      systemMessage: `[ACP·local] Blocked: ${d.reason}`,
    }));
  } else if (d.decision === "ask") {
    // Same harness quirk as the cloud path: Codex's parser only acts on
    // "deny", so ask → deny with the fix in the message (edit the local
    // policy, re-run). No dashboard link — there is no dashboard in local.
    if (HARNESS === "codex") {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `[ACP] ${d.reason}` },
        systemMessage: `[ACP·local] Requires review (${d.reason}) — Codex can't ask mid-run, so the call is blocked. To allow it, set the rule in ~/.acp/policy.json and re-run.`,
      }));
    } else {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: `[ACP] ${d.reason}` },
      }));
    }
  }
  // allow → no output (silent allow, still logged to audit.jsonl)
}

const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "X-GS-Client": `${ACP_CLIENT}/${PLUGIN_VERSION}`,
};

/* ── Tier detection (gatewaystack-connect#692: truthful tier labels) ──
 *
 * The old permission_mode proxy was wrong in every case that matters:
 * headless/cron `claude -p` runs reported "interactive" (the loosest tier
 * for the most unattended shape), Task-spawned subagents inherit
 * permission_mode and reported "interactive", and auto mode — a human at
 * the terminal who chose it — reported "subagent".
 *
 * Real signals, most-restrictive-wins (an unattended session's subagent is
 * still unattended):
 *   1. bypassPermissions ................................. background
 *   2. headless/programmatic entrypoint or CI env ........ background
 *      (CLAUDE_CODE_ENTRYPOINT: "sdk-cli" is `claude -p`, "sdk-ts"/
 *      "sdk-py" are SDK-driven, "mcp" is `claude mcp serve`,
 *      "claude-code-github-action" is CI — nobody is watching any of
 *      them; "cli", IDE and desktop entrypoints are attended.)
 *   3. Task-spawned subagent (hook input carries agent_id) subagent
 *   4. everything else — a human at a terminal/IDE, including
 *      permission_mode "auto" ........................... interactive
 *
 * Detection failure NEVER bricks the call: fall back to "interactive"
 * (the fail-open tier) LOUDLY — lapse.log line + detectError signal in
 * tier_signals so the server audits the fallback.
 */
const HEADLESS_ENTRYPOINTS = ["sdk-cli", "sdk-ts", "sdk-py", "mcp", "claude-code-github-action"];

let _tierDetection = null;
function detectAgentTier() {
  const signals = {};
  try {
    if (input.permission_mode === "bypassPermissions") {
      signals.permissionMode = "bypassPermissions";
      return { tier: "background", signals };
    }
    const entry = process.env.CLAUDE_CODE_ENTRYPOINT || "";
    if (entry) signals.entrypoint = entry.slice(0, 32);
    const ci = /^(1|true|yes)$/i.test(process.env.CI ?? "");
    if (ci) signals.ci = true;
    if (HEADLESS_ENTRYPOINTS.includes(entry) || ci) {
      return { tier: "background", signals };
    }
    if (typeof input.agent_id === "string" && input.agent_id) {
      signals.agentId = true;
      return { tier: "subagent", signals };
    }
    return { tier: "interactive", signals };
  } catch (err) {
    // Fail open and LOUD — never brick a client on tier detection.
    signals.detectError = true;
    try {
      appendFileSync(join(homedir(), ".acp", "lapse.log"),
        JSON.stringify({ at: new Date().toISOString(), event: "tier-detect-error", tool: input.tool_name, detail: err?.message ?? "unknown" }) + "\n");
    } catch { /* best-effort */ }
    try {
      process.stderr.write(`[ACP] tier detection failed (${err?.message ?? "unknown"}) — reporting "interactive" for this call; the fallback is flagged to the server via tier_signals.\n`);
    } catch { /* best-effort */ }
    return { tier: "interactive", signals };
  }
}

function resolveAgentTier() {
  if (!_tierDetection) _tierDetection = detectAgentTier();
  return _tierDetection.tier;
}

function tierSignals() {
  if (!_tierDetection) _tierDetection = detectAgentTier();
  return _tierDetection.signals;
}

// Tier-divergence notices (server flags client-reported ≠ enforced tier —
// e.g. an attended session on a scoped API key) arrive on EVERY call for
// the whole session; relay the first, dedupe the rest, same pattern as the
// uncredentialed-session banner. The server's audit row is the durable
// record — this marker only bounds terminal noise.
function firstTierNoticeThisSession() {
  const sessionId = String(input?.session_id ?? "unknown");
  const marker = join(homedir(), ".acp", "tier-notice-session");
  try {
    if (readFileSync(marker, "utf8").trim() === sessionId) return false;
  } catch { /* no marker yet */ }
  try {
    mkdirSync(join(homedir(), ".acp"), { recursive: true });
    writeFileSync(marker, sessionId);
  } catch { /* best-effort — at worst the notice repeats */ }
  return true;
}

/* ------------------------------------------------------------------ */
/* Scoped-token request (Phase 1 cross-arch broker)                    */
/* ------------------------------------------------------------------ */

async function requestScopedToken(provider) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${ACP_GOVERN}/api/v1/scoped-tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider,
        ttlSeconds: 600,
        reason: `${ACP_CLIENT} ${input.tool_name ?? "unknown"} in session ${input.session_id ?? "unknown"}`,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.status === 404) return { passThrough: true };
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      return {
        needsConnect: true,
        provider,
        connectUrl: body.connectUrl,
      };
    }
    if (!res.ok) {
      return { fail: true, status: res.status };
    }
    const body = await res.json().catch(() => null);
    if (!body || typeof body.token !== "string") {
      return { fail: true, status: res.status, reason: "malformed_response" };
    }
    return { token: body.token, expiresAt: body.expiresAt };
  } catch (err) {
    clearTimeout(timeout);
    return {
      fail: true,
      reason: err && err.name === "AbortError" ? "timeout" : (err?.message ?? "network_error"),
    };
  }
}

/* ------------------------------------------------------------------ */
/* PreToolUse                                                          */
/* ------------------------------------------------------------------ */

async function handlePreToolUse() {
  // Context guard: the gateway cannot see this machine's files, so the
  // hook measures what a whole-file read would pull in and sends it along.
  const toolContext = await readContext(input);
  const body = JSON.stringify({
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    session_id: input.session_id,
    call_id: input.tool_use_id,
    cwd: input.cwd,
    hook_event_name: "PreToolUse",
    agent_tier: resolveAgentTier(),
    permission_mode: input.permission_mode,
    tier_signals: tierSignals(),
    ...(toolContext ? { tool_context: toolContext } : {}),
  });

  // A deny is a control-flow event, not a full stop (gatewaystack-connect#692).
  // Two things have to be true for an agent to route around one instead of
  // abandoning the task:
  //
  //   1. The reason has to REACH THE MODEL. Claude Code reads
  //      hookSpecificOutput.permissionDecisionReason (hooks.ts:598-610) into
  //      blockingError, which is what the model sees; systemMessage goes to
  //      the human. For most of this hook's life the cloud path set only
  //      systemMessage, so every ACP deny arrived at the agent as the bare
  //      fallback "Hook PreToolUse:<tool> denied this tool" — indistinguishable
  //      from a harness bug, and impossible to re-plan on. That is the whole
  //      of #690's "no reason" mystery, seen from the client end.
  //   2. It has to say what to do NEXT. A denied call is one refused
  //      operation, not a refused task: say so, and name the way to ask for
  //      the capability rather than leaving the agent to guess or give up.
  //
  // Floors and governance-surface denies are the exception — they cannot be
  // allowed by policy or approval in any direction, so pointing an agent at
  // the proposal flow there would send it to file something no human can
  // approve. Those get the honest "this one is not negotiable" steer instead.
  // The server types every verdict by what the agent should DO about it
  // (HookResponse.kind). Prefer that over reading the prose: the wording of
  // a reason can change without anyone realizing it also changed the
  // instruction the agent acts on. The regex is the fallback for a gateway
  // older than the typed field.
  const UNPROPOSABLE = /^\s*(hardline floor|governance surface)\s*:/i;
  const STEER_BY_KIND = {
    terminal:
      "This one cannot be allowed by policy or approval — do not retry it or look for another route to the same effect. Carry on with the rest of the task and tell the operator what you needed.",
    retry:
      "Nothing is wrong with this call — there is just no capacity for it right now. Your task is NOT over: do other work, then retry this exact call shortly. Do not rewrite it to dodge the limit.",
    delegate:
      "This step is legitimate but only a human may perform it. Hand that one step over, and continue with everything else in your task.",
    reformulate:
      "This refused ONE operation, not your task — continue with everything else. If you believe you should have this capability, call acp_propose_rule (tool, tier, rationale) to draft a rule for a human to approve; it is never applied by you.",
  };
  function denyByPolicy(reason, kind) {
    const steer = STEER_BY_KIND[kind]
      || (UNPROPOSABLE.test(reason) ? STEER_BY_KIND.terminal : STEER_BY_KIND.reformulate);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[ACP] Denied by policy: ${reason}\n\n${steer}`,
      },
      systemMessage: `[ACP] Denied by policy: ${reason}`,
    }));
    process.exit(0);
  }
  // Unreachability posture (#385, decided 2026-07-21): fail-open is the
  // universal default and every lapse is LOUD (never-brick). An ACP outage
  // must not freeze every governed interactive session at once — a human is
  // present to read the warning. Unattended tiers (subagent/background/api)
  // have nobody watching, so for them the block IS the safety net: they
  // stay fail-closed. Policy denies are unaffected — this is only about
  // not being able to ASK the policy.
  function failPostureOnOutage(detail) {
    const tier = resolveAgentTier();
    if (tier === "interactive") {
      // Lapse, loudly, and leave an audit trail ACP never saw.
      try {
        appendFileSync(join(homedir(), ".acp", "lapse.log"),
          JSON.stringify({ at: new Date().toISOString(), tool: input.tool_name, tier, detail }) + "\n");
      } catch { /* the lapse log is best-effort — never block on it */ }
      // Queue the lapse for the session's next PostToolUse (#902) so the
      // gateway gets a row for the call it never saw.
      recordPendingLapse(input.session_id, input.tool_name, detail);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
        systemMessage: `[ACP] ⚠ UNGOVERNED: gateway unreachable (${detail}) — call proceeded WITHOUT policy check. Lapse logged to ~/.acp/lapse.log and queued for this session's next governed call.`,
      }));
      process.exit(0);
    }
    // Unattended tier: hold the line, say why honestly.
    const outageMsg = `[ACP] Gateway unreachable (${detail}) — ${tier} tier stays blocked when policy can't be consulted (fail-closed for unattended agents; interactive sessions fail open).`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        // An outage and a policy deny demand opposite responses: retry the
        // first, never the second. Told apart only if the model is told
        // which one this is — so name it, and say the call was never judged.
        permissionDecisionReason: `${outageMsg}\n\nThis is an availability failure, NOT a policy judgment about this call — nothing decided that the operation was wrong. Do other work that doesn't need this tool, and retry later; if every route is blocked this way, stop and report the outage rather than working around it.`,
      },
      systemMessage: outageMsg,
    }));
    process.exit(0);
  }
  // A 401/403 is NOT the gateway being down — it is this machine's key
  // being revoked, mistyped, or from a deleted workspace. Live session
  // 2026-09-07: a returning user's May key had been revoked; for six hours
  // every hook call read "gateway unreachable (HTTP 401)", which sounds
  // like our outage, and the user ran ungoverned until they happened to
  // visit the console. Same tier posture as an outage (interactive fails
  // open, unattended stays blocked), but the message names the cause and
  // the two fixes.
  function failPostureOnKeyRejected(status) {
    const tier = resolveAgentTier();
    const fix = "Fix: re-run the installer (curl -sf https://agenticcontrolplane.com/install.sh | bash) or create a key at https://cloud.agenticcontrolplane.com/settings/api-keys and save it: echo 'gsk_...' > ~/.acp/credentials";
    if (tier === "interactive") {
      try {
        appendFileSync(join(homedir(), ".acp", "lapse.log"),
          JSON.stringify({ at: new Date().toISOString(), tool: input.tool_name, tier, detail: `key rejected (HTTP ${status})` }) + "\n");
      } catch { /* best-effort */ }
      recordPendingLapse(input.session_id, input.tool_name, `key rejected (HTTP ${status})`);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
        systemMessage: `[ACP] ⚠ KEY REJECTED (HTTP ${status}): the key in ~/.acp/credentials is revoked or invalid — this call proceeded UNGOVERNED and unlogged, and every call will until it is fixed. ${fix}`,
      }));
      process.exit(0);
    }
    const msg = `[ACP] Key rejected (HTTP ${status}) — the key in ~/.acp/credentials is revoked or invalid; ${tier} tier stays blocked until it is fixed. ${fix}`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${msg}\n\nThis is a credential failure, NOT a policy judgment about this call. Tell the operator the key needs replacing; do not retry until it is.`,
      },
      systemMessage: msg,
    }));
    process.exit(0);
  }
  function denyGatewayError(status, statusText) {
    if (status === 401 || status === 403) { failPostureOnKeyRejected(status); return; }
    const detail = statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;
    failPostureOnOutage(detail);
  }
  function denyUnreachable(detail) {
    failPostureOnOutage(detail || "network error");
  }
  function ask(reason) {
    // Codex has no ask semantic on the wire (see HARNESS note): emit deny
    // with the approval deep link so the human approves out-of-band and
    // the re-run passes under the grant.
    const decision = HARNESS === "codex" ? "deny" : "ask";
    // Codex sees this as a hard deny, so it needs the out-of-band route
    // spelled out; Claude Code renders a prompt and the human answers it.
    const steer = decision === "deny"
      ? "Codex cannot ask mid-run, so this arrives as a block. A human approves it on the dashboard and the re-run passes under the grant — continue with the rest of your task meanwhile."
      : "A human is being asked now. This refused ONE operation, not your task.";
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: `[ACP] Approval required: ${reason}\n\n${steer}`,
      },
      systemMessage: `[ACP] Approval required: ${reason}`,
    }));
    process.exit(0);
  }

  // Step 1: policy check.
  //
  // Two attempts inside one budget, not one long one (gatewaystack-connect#690).
  // Confirmed 2026-08-13: a /govern/tool-use call took 4.635s and answered
  // HTTP 200 — an ALLOW — but the old single 4s attempt had already aborted,
  // and at an unattended tier the fail-closed posture turned that allow into
  // a deny. The tail is real but rare (9 requests over 2s in 3 days) and the
  // slow ones are cold starts, so the retry lands on a now-warm instance and
  // returns in the usual ~500ms. Splitting the budget keeps the total under
  // the harness's own hook timeout — a retry that overran it would be killed
  // mid-flight and denied with no reason at all, which is the failure this
  // fix exists to remove.
  const FIRST_ATTEMPT_MS = Number(process.env.ACP_FIRST_ATTEMPT_MS) || 2200;
  const RETRY_ATTEMPT_MS = Number(process.env.ACP_RETRY_ATTEMPT_MS) || 1600;

  async function askPolicy(budgetMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      return await fetch(`${ACP_GOVERN}/govern/tool-use`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  let policyAllowed = true;
  let tierNotice = null;
  let res;
  try {
    try {
      res = await askPolicy(FIRST_ATTEMPT_MS);
    } catch {
      // Only a transport failure (abort / network) reaches here — fetch
      // resolves for every HTTP status, so a 429 or a policy deny is never
      // re-rolled by this retry. A second failure falls through to the
      // fail-posture handler below.
      res = await askPolicy(RETRY_ATTEMPT_MS);
    }
    if (!res.ok) {
      // A 4xx carrying a decision body IS the verdict, not an outage: the
      // gateway answers rate-limit denies (429) and invalid-tool denies
      // (400) with {decision, reason}. Routing those through the outage
      // posture made interactive sessions fail OPEN on a deliberate deny —
      // rate limits were simply unenforced — while unattended tiers denied
      // with a misleading "gateway unreachable" message. 5xx and bodyless
      // 4xx (e.g. the auth guard's 401) keep the outage posture.
      if (res.status >= 400 && res.status < 500) {
        const verdict = await res.json().catch(() => null);
        if (verdict && verdict.decision === "deny") {
          denyByPolicy(verdict.reason || `denied (HTTP ${res.status})`, verdict.kind);
          return;
        }
        if (verdict && verdict.decision === "ask") {
          ask(verdict.reason || "approval required");
          return;
        }
      }
      denyGatewayError(res.status, res.statusText);
      return;
    }
    const data = await res.json();
    if (data.decision === "deny") {
      denyByPolicy(data.reason || "policy did not return a reason", data.kind);
      return;
    }
    if (data.decision === "ask") {
      ask(data.reason || "approval required");
      return;
    }
    // decision is allow (or unspecified) — continue to step 2.
    policyAllowed = true;
    // Tier-divergence flag (#692): the server enforced a different tier
    // than this client reported (never a deny by itself — the note rides
    // on whatever the policy decided). Relay it once per session so the
    // human learns the session's real tier without per-call spam.
    if (typeof data.notice === "string" && data.notice.trim() && firstTierNoticeThisSession()) {
      tierNotice = data.notice;
    }
  } catch (err) {
    const reason = err && err.name === "AbortError"
      ? "request timed out twice"
      : (err && err.message ? err.message : "network error");
    denyUnreachable(reason);
    return;
  }

  // A hook run may write exactly ONE stdout JSON object — every allow-path
  // exit funnels through here so the tier-divergence notice never produces
  // a second one.
  function exitAllow() {
    if (tierNotice) {
      process.stdout.write(JSON.stringify({ systemMessage: tierNotice }));
    }
    process.exit(0);
  }

  // Step 2 (Phase 1): if the tool matches a vendor pattern, request a
  // scoped token and inject it via updatedInput.command. The agent's
  // local PAT is never read; ACP brokers the credential.
  const vendor = detectVendor(input.tool_name, input.tool_input);
  if (!vendor || !policyAllowed) {
    exitAllow();
  }

  // Codex rejects updatedInput (see HARNESS note) — attempting injection
  // would mark the hook failed and run the tool anyway, minus the token.
  // Skip cleanly; the local-credential workflow continues unchanged.
  if (HARNESS === "codex") {
    exitAllow();
  }

  const tokenResult = await requestScopedToken(vendor.provider);

  // Feature flag off — pass through silently. Existing local-credential
  // workflow continues unchanged. This is the non-breaking opt-in path
  // for tenants that haven't enabled scopedTokensEnabled.
  if (tokenResult.passThrough) {
    exitAllow();
  }

  // User hasn't connected the provider via OAuth yet. Emit a deny with
  // a clickable markdown link in the systemMessage so the agent or user
  // can complete OAuth in their browser without leaving Claude Code,
  // then retry. This is the load-bearing UX from gatewaystack-connect#115.
  if (tokenResult.needsConnect) {
    const url = tokenResult.connectUrl
      || `${ACP_API}/integrations/${vendor.provider}/start`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
      systemMessage:
        `[ACP] Connection required for ${vendor.provider}\n\n` +
        `Click to connect: ${url}\n\n` +
        `After authorizing in your browser, retry your request. ACP will issue a short-lived token bound to your account; your local credentials are not touched.`,
    }));
    process.exit(0);
  }

  // Scoped-token request failed (5xx, network, malformed). Default
  // fail-mode is OPEN — let the existing local-credential workflow
  // proceed rather than blocking on ACP infrastructure issues. Surface
  // a stderr warning so the issue is visible to the user / debugger.
  // Server-side per-tenant `scopedTokensFailMode` will flip this to
  // closed in a future release.
  if (tokenResult.fail) {
    process.stderr.write(
      `[ACP] Scoped-token request failed (${tokenResult.reason ?? `HTTP ${tokenResult.status}`}); falling back to local credentials for this call.\n`
    );
    exitAllow();
  }

  // Success — inject the ACP-issued token via updatedInput.command.
  // Bash inherits the env var naturally when it executes the prefixed
  // command. For vendors with a `hostVar` (gh CLI: GH_HOST), also set
  // that to the ACP host so the upstream tool routes through ACP's
  // egress proxy at /api/v3/* (Phase 2). The agent's command keeps
  // working unchanged, but the call flows through ACP — credentials
  // never leave the gateway.
  if (tokenResult.token && input.tool_input?.command) {
    const original = String(input.tool_input.command);
    const envParts = [];
    if (vendor.hostVar && vendor.hostValue) {
      envParts.push(`${vendor.hostVar}=${vendor.hostValue}`);
    }
    envParts.push(`${vendor.envVar}=${tokenResult.token}`);
    const updated = `${envParts.join(" ")} ${original}`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...input.tool_input, command: updated },
      },
      ...(tierNotice ? { systemMessage: tierNotice } : {}),
    }));
    process.exit(0);
  }

  // No token + no failure case — should be unreachable, but exit safely.
  exitAllow();
}

/* ------------------------------------------------------------------ */
/* PostToolUse                                                         */
/* ------------------------------------------------------------------ */

async function handlePostToolUse() {
  let outputStr = "";
  try {
    const out = input.tool_response ?? input.tool_output ?? input.output;
    if (typeof out === "string") outputStr = out;
    else if (out !== undefined && out !== null) outputStr = JSON.stringify(out);
  } catch {
    process.exit(0);
  }
  if (Buffer.byteLength(outputStr, "utf8") > POST_HOOK_PAYLOAD_CEILING) {
    outputStr = outputStr.slice(0, POST_HOOK_PAYLOAD_CEILING);
  }
  // Lapses queued by a fail-open PreToolUse in this session (#902) ride
  // along; the marker is cleared only after the gateway acknowledged.
  const preLapse = readPendingLapse(input.session_id);
  const body = JSON.stringify({
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    tool_output: outputStr,
    session_id: input.session_id,
    call_id: input.tool_use_id,
    cwd: input.cwd,
    hook_event_name: "PostToolUse",
    agent_tier: resolveAgentTier(),
    tier_signals: tierSignals(),
    ...(preLapse ? { pre_lapse: preLapse } : {}),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${ACP_GOVERN}/govern/tool-output`, { method: "POST", headers, body, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) { process.exit(0); }
    if (preLapse) clearPendingLapse(input.session_id);
    const data = await res.json();
    // Receipt bookkeeping (#606): one governed call, plus what ACP said
    // about it. Counted only on a real server verdict — a call the
    // gateway never saw is not claimed as governed.
    const noticed = !SHADOW_OFF && typeof data.notice === "string" && data.notice.trim() !== "";
    bumpReceiptStats(input.session_id, {
      calls: 1,
      flagged: data.action === "redact" || data.action === "block" ? 1 : 0,
      notices: noticed ? 1 : 0,
    });
    if (data.action === "redact" || data.action === "block") {
      process.stdout.write(JSON.stringify({
        systemMessage: `[ACP] ${data.action === "block" ? "Blocked" : "Flagged"}: ${data.reason || "governance policy"}`,
      }));
    } else if (!SHADOW_OFF && typeof data.notice === "string" && data.notice.trim()) {
      // Shadow-mode counterfactual (gatewaystack-connect#607): the server
      // sends a fully-formed "[ACP shadow] …" line for audit-mode tenants —
      // what enforcement WOULD have done to the call that just ran. It is
      // advisory only and arrives with action "pass"; frequency caps are
      // server-side. ACP_SHADOW=off is the client-side belt to the server's
      // suspenders (the tenant-level shadowNotices:false disable).
      process.stdout.write(JSON.stringify({ systemMessage: data.notice }));
    }
  } catch {
    // silent pass-through
  } finally { clearTimeout(timeout); }
  process.exit(0);
}

// ── Session-start attestation (#403 paired arrival, the #375 lesson) ──
//
// At session start the hook proves what is actually running: the sha256
// of THIS file as loaded from disk, the plugin version, and whether the
// harness-grants file is present (capability must never arrive without
// authority — grants and hook are a pair). The gateway compares the hash
// against the first-seen hash for this version; a mismatch is the
// edited-hook signature and pages the founder. Fire-and-forget and
// fail-open in every branch: attestation is observability, and it must
// never delay or block a session — an absent attestation is itself the
// signal (the console shows the session as "unattested").
function sha256FileHex(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

async function handleSessionStart() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const hookHash = sha256FileHex(fileURLToPath(import.meta.url));
    if (!hookHash) process.exit(0);
    const grantsHash = sha256FileHex(join(homedir(), ".acp", "harness-grants.json"));
    const res = await fetch(`${ACP_GOVERN}/govern/attest`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        session_id: input.session_id,
        cwd: input.cwd,
        hook_event_name: "SessionStart",
        plugin_version: PLUGIN_VERSION,
        hook_hash: hookHash,
        grants_present: grantsHash !== null,
        ...(grantsHash ? { grants_hash: grantsHash } : {}),
        harness: HARNESS,
      }),
      signal: controller.signal,
    });
    // Upgrade notice (gatewaystack-connect#849): the attest response may
    // carry a `notice` when this plugin version is behind the registry's
    // latest — surfaced as SessionStart additionalContext so the MODEL
    // sees it and can drive the upgrade (behind a human approval; the
    // canonical installer is step_up-gated at the gateway). Once per
    // session by construction: attest runs at SessionStart only.
    // Canonical logic in lib/attestation.mjs (attestNoticeOutput).
    const data = await res.json().catch(() => null);
    if (data && typeof data.notice === "string" && data.notice.trim()) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: data.notice.trim(),
        },
      }));
    }
  } catch {
    // silent — absence of attestation is visible server-side by design
  } finally {
    clearTimeout(timeout);
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* Stop — session receipt (gatewaystack-connect#606)                    */
/* ------------------------------------------------------------------ */

// Canonical copy of the receipt logic lives in lib/receipt.mjs so tests
// can pin the contract; this file carries the same logic inline (it is
// deliberately self-contained, like vendor-patterns and attestation).
function receiptStatsPath(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return join(SESSION_STATS_DIR, `${safe}.json`);
}

function readReceiptStats(sessionId) {
  try {
    const raw = JSON.parse(readFileSync(receiptStatsPath(sessionId), "utf8"));
    return { calls: Number(raw.calls) || 0, flagged: Number(raw.flagged) || 0, notices: Number(raw.notices) || 0 };
  } catch {
    return { calls: 0, flagged: 0, notices: 0 };
  }
}

function bumpReceiptStats(sessionId, delta) {
  if (!sessionId || sessionId === "unknown") return;
  try {
    mkdirSync(SESSION_STATS_DIR, { recursive: true });
    const cur = readReceiptStats(sessionId);
    writeFileSync(receiptStatsPath(sessionId), JSON.stringify({
      calls: cur.calls + (delta.calls ?? 0),
      flagged: cur.flagged + (delta.flagged ?? 0),
      notices: cur.notices + (delta.notices ?? 0),
    }));
  } catch { /* bookkeeping must never touch the call path */ }
}

function clearReceiptStats(sessionId) {
  try { unlinkSync(receiptStatsPath(sessionId)); } catch { /* absent is fine */ }
  try {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of readdirSync(SESSION_STATS_DIR)) {
      const p = join(SESSION_STATS_DIR, f);
      try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch { /* skip */ }
    }
  } catch { /* prune is opportunistic */ }
}

function buildReceiptLine(stats, sessionId) {
  if (!stats || stats.calls <= 0) return null;
  const parts = [`${stats.calls} tool call${stats.calls === 1 ? "" : "s"} governed`];
  if (stats.flagged > 0) parts.push(`${stats.flagged} flagged`);
  if (stats.notices > 0) parts.push(`${stats.notices} shadow notice${stats.notices === 1 ? "" : "s"}`);
  return `[ACP] Session receipt: ${parts.join(" · ")} — review this session: ${ACP_CONSOLE}/sessions/${encodeURIComponent(String(sessionId))}`;
}

// One line at session end: what ACP governed, anything it said, and a
// deep link to THIS session's timeline. Purely local (reads the counters
// PostToolUse kept) — no network, no latency, silent when the session
// used no tools. The counters are cleared so a resumed session starts a
// fresh receipt, and stale files from crashed sessions are pruned.
function handleStop() {
  // stop_hook_active means WE are inside a stop-hook continuation —
  // never loop or double-print the receipt.
  if (input.stop_hook_active) process.exit(0);
  try {
    const msg = buildReceiptLine(readReceiptStats(input.session_id ?? "unknown"), input.session_id ?? "unknown");
    if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg }));
  } catch { /* a receipt failure must never disturb session end */ }
  clearReceiptStats(input.session_id ?? "unknown");
  process.exit(0);
}

const hookEvent = typeof input.hook_event_name === "string" ? input.hook_event_name : "PreToolUse";
if (hookEvent === "PostToolUse") handlePostToolUse();
else if (hookEvent === "SessionStart") handleSessionStart();
else if (hookEvent === "Stop") handleStop();
else handlePreToolUse();
