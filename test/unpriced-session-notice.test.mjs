// Plain-launch sessions are told their model calls are not priced or
// policy-checked — once per session, on an allowed call.
//
// Run with: node --test test/unpriced-session-notice.test.mjs
//
// This hook runs under plain `claude` too, where it sees tool calls but
// never model calls: only the <harness>-acp launchers route model traffic
// through the proxy, which is where pricing and model-call policy run.
// Production 2026-09-16: 0 of 69 external tenants had ever used a launcher,
// and nothing told them. Same logic as the installer's bundled engine
// (agenticcontrolplane.com PR #178); this is the copy that online installs
// and the marketplace plugin actually run.
//
// Spawn the real hook against a stub gateway, assert on the one stdout
// JSON object a hook run may write. Invariants:
//   1. Plain claude, first allowed call → the notice, as systemMessage,
//      with nothing that could change the call (no hookSpecificOutput).
//   2. Same session, later calls → silent. New session → fires once more.
//   3. No session_id → silence and no marker. Bias to silence.
//   4. Launched via a launcher (ACP_KEY in env) → silence, no marker; a
//      hand-rolled provider base URL at the ACP proxy counts as priced too.
//   5. A deny is byte-identical to today and carries no notice; the notice
//      then rides the session's first ALLOWED call.
//   6. Wire warning + notice on one call → ONE JSON object carrying both.
//   7. Clients without a launcher (cursor) get nothing; codex names
//      codex-acp.
//   8. Concurrency: N parallel hook processes for one session → exactly one
//      notice (exclusive-create marker).
//   9. Markers older than 7 days are pruned; the directory is capped.
//  10. Launcher absent on disk (marketplace-only install) → the notice
//      names the installer, not a path that does not exist.
//  11. --local mode never shows it.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, utimesSync, copyFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOVERN = join(ROOT, "bin", "govern.mjs");
const DECIDE = join(ROOT, "bin", "decide.mjs");
const LOOPBACK = [127, 0, 0, 1].join(".");

const NOTICE_HEAD = "[ACP] Tool calls in this session are checked and logged. Model calls are not: plain `claude` sends them straight to the provider, so they are neither priced nor policy-checked (tool-result redaction, model routing).";
const WITH_LAUNCHER = `${NOTICE_HEAD} For the cost X-ray and model-call policy, launch with \`claude-acp\` (~/.acp/bin/claude-acp). Shown once per session.`;
const WITHOUT_LAUNCHER = `${NOTICE_HEAD} For the cost X-ray and model-call policy, install the \`claude-acp\` launcher: curl -sf https://agenticcontrolplane.com/install.sh | bash. Shown once per session.`;
const WARNING = "[ACP billing] grace period: 3 days left";

let HOME;
let NOTICES;
let server;
let baseUrl;
let nextResponse = { decision: "allow" };

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "acp-unpriced-notice-test-"));
  NOTICES = join(HOME, ".acp", "session-notices");
  mkdirSync(join(HOME, ".acp", "bin"), { recursive: true });
  // A workspace token routes govern.mjs down the cloud path (never LOCAL).
  writeFileSync(join(HOME, ".acp", "credentials"), "gsk_test_deadbeef\n");
  // The launcher the installer writes; its presence picks the wording.
  writeFileSync(join(HOME, ".acp", "bin", "claude-acp"), "#!/bin/sh\n");
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url !== "/govern/tool-use") { res.end(JSON.stringify({ action: "pass" })); return; }
      res.end(JSON.stringify(raw.includes('"sandbox.deny"') ? { decision: "deny", reason: "sandbox deny" } : nextResponse));
    });
  });
  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
  baseUrl = `http://${LOOPBACK}:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  nextResponse = { decision: "allow" };
});

// Explicit env (never spread process.env): a launcher's ACP_KEY, or the
// runner's own provider base URLs, would silence the notice from outside.
function preHook(sessionId, { env = {}, tool = "Bash", home = HOME } = {}) {
  const input = {
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { command: "ls -la" },
    cwd: "/tmp",
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: { HOME: home, PATH: process.env.PATH, ACP_GOVERN_BASE: baseUrl, CLAUDE_CODE_ENTRYPOINT: "cli", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const killer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(killer);
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : null);
      } catch (e) {
        reject(new Error(`unparseable stdout: ${stdout}\nstderr: ${stderr}\n${e}`));
      }
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

const marker = (id) => join(NOTICES, `unpriced-${id}`);

test("plain claude: the first allowed call carries the notice, naming claude-acp, and nothing else", async () => {
  const out = await preHook("sess-plain-1");
  assert.ok(out, "expected output on stdout");
  assert.equal(out.systemMessage, WITH_LAUNCHER);
  assert.equal(out.hookSpecificOutput, undefined);
  assert.ok(!/governance/i.test(out.systemMessage), "never says governance");
  assert.ok(existsSync(marker("sess-plain-1")));
});

test("same session: the second and third calls are silent (once per session, not per tool call)", async () => {
  assert.equal(await preHook("sess-plain-1"), null);
  assert.equal(await preHook("sess-plain-1", { tool: "Read" }), null);
});

test("new session: the notice fires again, exactly once", async () => {
  const out = await preHook("sess-plain-2");
  assert.equal(out?.systemMessage, WITH_LAUNCHER);
  assert.equal(await preHook("sess-plain-2"), null);
});

test("no session id in the payload: silence, and no marker", async () => {
  const before = readdirSync(NOTICES).length;
  assert.equal(await preHook(undefined), null);
  assert.equal(readdirSync(NOTICES).length, before);
  assert.ok(!existsSync(marker("")));
});

test("launched via claude-acp (ACP_KEY in env): no notice, no marker", async () => {
  assert.equal(await preHook("sess-launched-1", { env: { ACP_KEY: "gsk_test_deadbeef" } }), null);
  assert.ok(!existsSync(marker("sess-launched-1")));
});

test("a hand-rolled provider base URL at the ACP proxy is priced too: silence", async () => {
  assert.equal(await preHook("sess-byo-1", { env: { ANTHROPIC_BASE_URL: "https://api.agenticcontrolplane.com/anthropic" } }), null);
  assert.equal(await preHook("sess-byo-2", { env: { OPENAI_BASE_URL: "https://api.agenticcontrolplane.com/v1" } }), null);
  assert.ok(!existsSync(marker("sess-byo-1")) && !existsSync(marker("sess-byo-2")));
});

test("a deny is unchanged and carries no notice; the notice then rides the session's first allowed call", async () => {
  const denied = await preHook("sess-deny-1", { tool: "sandbox.deny" });
  assert.equal(denied.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(denied.systemMessage, /^\[ACP\] Denied by policy: sandbox deny$/);
  assert.ok(!denied.hookSpecificOutput.permissionDecisionReason.includes("claude-acp"));
  assert.ok(!existsSync(marker("sess-deny-1")), "a deny must not consume the session's notice");
  const allowed = await preHook("sess-deny-1");
  assert.equal(allowed?.systemMessage, WITH_LAUNCHER);
  assert.equal(await preHook("sess-deny-1"), null);
});

test("an ask is unchanged and carries no notice", async () => {
  nextResponse = { decision: "ask", reason: "outward-facing" };
  const asked = await preHook("sess-ask-1");
  assert.equal(asked.hookSpecificOutput?.permissionDecision, "ask");
  assert.equal(asked.systemMessage, "[ACP] Approval required: outward-facing");
  assert.ok(!existsSync(marker("sess-ask-1")));
});

test("wire warning + notice on one call → ONE JSON object carrying both", async () => {
  nextResponse = { decision: "allow", warning: WARNING };
  const out = await preHook("sess-warn-1");
  assert.equal(out.systemMessage, `${WARNING} ${WITH_LAUNCHER}`);
  assert.equal(out.hookSpecificOutput, undefined);
  // And the warning alone on the next call, exactly as before.
  const again = await preHook("sess-warn-1");
  assert.equal(again.systemMessage, WARNING);
});

test("codex names codex-acp (both client spellings); cursor has no launcher and gets nothing", async () => {
  const codex = await preHook("sess-codex-1", { env: { ACP_CLIENT: "codex", ACP_HARNESS: "codex" } });
  assert.match(codex?.systemMessage ?? "", /plain `codex` .* install the `codex-acp` launcher/);
  const plugin = await preHook("sess-codex-2", { env: { ACP_CLIENT: "codex-plugin", ACP_HARNESS: "codex" } });
  assert.match(plugin?.systemMessage ?? "", /`codex-acp`/);
  assert.equal(await preHook("sess-cursor-1", { env: { ACP_CLIENT: "cursor" } }), null);
  assert.ok(!existsSync(marker("sess-cursor-1")));
});

test("concurrency: six parallel hook processes for one session yield exactly one notice", async () => {
  const outs = await Promise.all(Array.from({ length: 6 }, () => preHook("sess-parallel-1")));
  const notices = outs.filter((o) => o && o.systemMessage === WITH_LAUNCHER);
  assert.equal(notices.length, 1);
  assert.equal(outs.filter((o) => o === null).length, 5);
});

test("markers older than 7 days are pruned; live ones are kept; the directory is capped", async () => {
  const eightDaysAgo = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
  writeFileSync(marker("stale"), "x");
  utimesSync(marker("stale"), eightDaysAgo, eightDaysAgo);
  for (let i = 0; i < 150; i++) writeFileSync(marker(`bulk-${String(i).padStart(3, "0")}`), "x");
  await preHook("sess-prune-1");
  assert.ok(!existsSync(marker("stale")), "stale marker pruned");
  assert.ok(existsSync(marker("sess-prune-1")), "the marker just claimed survives");
  assert.ok(existsSync(marker("sess-plain-1")), "recent markers survive while under the cap");
  // Past the cap the newest win; the marker just claimed is among them.
  for (let i = 150; i < 400; i++) writeFileSync(marker(`bulk-${String(i).padStart(3, "0")}`), "x");
  await preHook("sess-prune-2");
  assert.ok(existsSync(marker("sess-prune-2")));
  assert.ok(readdirSync(NOTICES).length <= 200, `capped at 200, got ${readdirSync(NOTICES).length}`);
});

test("session ids are sanitised for the marker name and capped in length", async () => {
  const wild = "../../evil/../id with spaces/" + "x".repeat(300);
  const out = await preHook(wild);
  assert.equal(out?.systemMessage, WITH_LAUNCHER);
  const names = readdirSync(NOTICES).filter((n) => n.startsWith("unpriced-.._.._evil"));
  assert.equal(names.length, 1);
  assert.ok(names[0].length <= "unpriced-".length + 120);
  assert.ok(!existsSync(join(HOME, "evil")));
});

test("launcher absent on disk (marketplace-only install): the notice names the installer, not a missing path", async () => {
  const home = mkdtempSync(join(tmpdir(), "acp-unpriced-nolauncher-"));
  mkdirSync(join(home, ".acp"), { recursive: true });
  writeFileSync(join(home, ".acp", "credentials"), "gsk_test_deadbeef\n");
  try {
    const out = await preHook("sess-nolauncher-1", { home });
    assert.equal(out?.systemMessage, WITHOUT_LAUNCHER);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--local mode: no notice, no marker directory, the call is still audited locally", async () => {
  const home = mkdtempSync(join(tmpdir(), "acp-unpriced-local-"));
  mkdirSync(join(home, ".acp"), { recursive: true });
  copyFileSync(DECIDE, join(home, ".acp", "decide.mjs"));
  writeFileSync(join(home, ".acp", "policy.json"), JSON.stringify({ default: "allow", rules: {} }));
  try {
    const out = await preHook("sess-local-1", { home, env: { ACP_LOCAL: "1" } });
    assert.equal(out, null);
    assert.ok(!existsSync(join(home, ".acp", "session-notices")));
    assert.ok(existsSync(join(home, ".acp", "audit.jsonl")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
