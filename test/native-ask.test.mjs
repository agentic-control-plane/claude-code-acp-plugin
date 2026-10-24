// Tests for the native-ask capability declaration in bin/govern.mjs.
//
// Run with: node --test test/native-ask.test.mjs
//
// The hook declares to the gateway that this harness can render a native
// permission dialog (`capabilities: ["native_ask"]` on PreToolUse), so the
// gateway may answer a step_up with `decision: "ask"` instead of falling
// back to deny + a console link. Codex's parser only acts on "deny" (see
// the HARNESS note in bin/govern.mjs) so it must never declare the
// capability. Invariants under test:
//   a. Claude Code PreToolUse sends capabilities: ["native_ask"], the
//      permission_mode and call_id it was given.
//   b. Codex PreToolUse sends capabilities: [].
//   c. An "ask" verdict surfaces permissionDecision "ask" for Claude Code,
//      with the reason reaching both the model and the human.
//   d. The same verdict maps to "deny" under codex.
//   e. PostToolUse never sends a capabilities field at all.
//
// Each test spawns the real hook exactly the way a harness does — JSON on
// stdin — against a throwaway fixture HOME holding a workspace token, with
// ACP_GOVERN_BASE pointed at a local stub server that records what it saw.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "./_dev-base.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOVERN = join(ROOT, "bin", "govern.mjs");

let HOME;
let server;
let baseUrl;
// Requests the stub saw (parsed bodies), and what it answers next.
let seen = [];
let nextResponse = { decision: "allow" };

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "acp-native-ask-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  // A workspace token routes govern.mjs down the cloud path (never LOCAL).
  writeFileSync(join(HOME, ".acp", "credentials"), "gsk_test_deadbeef\n");

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* keep null */ }
      seen.push({ url: req.url, body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(nextResponse));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
  nextResponse = { decision: "allow" };
});

// NOTE: async spawn, not spawnSync — the stub server lives in THIS process.
function runHook(input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: {
        HOME,
        PATH: process.env.PATH,
        ACP_TEST_DEV_BASE: "1", ACP_GOVERN_BASE: baseUrl,
        CLAUDE_CODE_ENTRYPOINT: "cli",
        ACP_FIRST_ATTEMPT_MS: "1000",
        ACP_RETRY_ATTEMPT_MS: "1000",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const killer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(killer);
      try {
        assert.equal(status, 0, `hook exited ${status}: ${stderr}`);
        resolve(stdout.trim() ? JSON.parse(stdout) : null);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

const preToolUse = (overrides = {}) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git push" },
  tool_use_id: "call-native-ask-1",
  session_id: "sess-native-ask",
  cwd: "/tmp",
  permission_mode: "default",
  ...overrides,
});

const postToolUse = () => ({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "git push" },
  tool_response: "done",
  tool_use_id: "call-native-ask-1",
  session_id: "sess-native-ask",
  cwd: "/tmp",
});

test("(a) Claude Code PreToolUse declares native_ask and carries permission_mode + call_id", async () => {
  await runHook(preToolUse());
  const req = seen.find((s) => s.url === "/govern/tool-use");
  assert.ok(req, "expected a request to /govern/tool-use");
  assert.deepEqual(req.body.capabilities, ["native_ask"]);
  assert.equal(req.body.permission_mode, "default");
  assert.equal(req.body.call_id, "call-native-ask-1");
});

test("(b) Codex PreToolUse declares no capabilities", async () => {
  await runHook(preToolUse(), { ACP_HARNESS: "codex", ACP_CLIENT: "codex-plugin" });
  const req = seen.find((s) => s.url === "/govern/tool-use");
  assert.ok(req, "expected a request to /govern/tool-use");
  assert.deepEqual(req.body.capabilities, []);
});

test("(c) an ask verdict renders a native prompt for Claude Code", async () => {
  nextResponse = {
    decision: "ask",
    reason: "step_up by interactive tier policy for Bash.git. Yes runs it once…",
    approval_id: "ap1",
    approval_status: "pending",
  };
  const out = await runHook(preToolUse());
  assert.ok(out, "expected output on stdout");
  assert.equal(out.hookSpecificOutput?.permissionDecision, "ask");
  assert.match(out.hookSpecificOutput?.permissionDecisionReason ?? "", /^\[ACP\] Approval required:/);
  assert.match(out.systemMessage ?? "", /^\[ACP\] Approval required:/);
});

test("(d) the same verdict maps to deny under codex", async () => {
  nextResponse = {
    decision: "ask",
    reason: "step_up by interactive tier policy for Bash.git. Yes runs it once…",
    approval_id: "ap1",
    approval_status: "pending",
  };
  const out = await runHook(preToolUse(), { ACP_HARNESS: "codex", ACP_CLIENT: "codex-plugin" });
  assert.ok(out, "expected output on stdout");
  assert.equal(out.hookSpecificOutput?.permissionDecision, "deny");
});

test("(c2) a reason the gateway already branded is not prefixed again (gsc#1372)", async () => {
  const branded = "ACP (Agentic Control Plane) asks: step_up by interactive tier policy for Bash.git.";
  nextResponse = { decision: "ask", reason: branded, approval_id: "ap2", approval_status: "pending" };
  const out = await runHook(preToolUse());
  assert.ok(out, "expected output on stdout");
  const dialog = out.hookSpecificOutput?.permissionDecisionReason ?? "";
  assert.ok(dialog.startsWith(branded), `dialog should open with the gateway's own brand, got: ${dialog}`);
  assert.doesNotMatch(dialog, /\[ACP\] Approval required:/);
  assert.ok(out.systemMessage.startsWith(branded), `human line should open with the gateway's own brand, got: ${out.systemMessage}`);

  // A reason that already carries the plugin's own tag is left alone too.
  nextResponse = { decision: "ask", reason: "[ACP] already tagged", approval_id: "ap3", approval_status: "pending" };
  const tagged = await runHook(preToolUse());
  assert.ok(tagged.systemMessage.startsWith("[ACP] already tagged"));
});

// gsc#1699 ws2 item 2 (#1472): the human line on a hold names the next step
// — approve once here, or the one command that stops the asking for this
// tool — once per session per tool key, never in the model's dialog text.
// The reason shape today's gateway sends (govern/harnessAsk.ts
// harnessAskReason): three lines, plain text, and it already carries
// "yes = run once" and, when the line fits, "/acp-allow <ToolKey>".
const REAL_ASK = "ACP (Agentic Control Plane) asks: Push to origin main\n  git push --force origin main · rule Bash.git.push · yes = run once · /acp-allow Bash.git.push";
const REAL_ASK_NO_HINT = "ACP (Agentic Control Plane) asks: Fetch https://example.com\n  curl -sS https://example.com/some/very/long/path/that/pushed/the/line/past/its/limit · rule Bash.curl · yes = run once";
const REAL_FLOOR_ASK = "ACP (Agentic Control Plane) asks: Run a destructive command (destructive floor: force-push). This asks in every workspace and policy mode\n  git push --force origin main · rule Bash.git.push · yes = run once";

test("(f) a real gateway ask already names once/allow: the human gets only the one thing it lacks, /acp-why — once per session per key", async () => {
  const sid = "sess-hold-next-1";
  nextResponse = { decision: "ask", reason: REAL_ASK, approval_id: "ap4", approval_status: "pending" };
  const out = await runHook(preToolUse({ session_id: sid }));
  assert.equal(out.systemMessage, `${REAL_ASK}\n/acp-why explains.`, "nothing the dialog already says is repeated");
  // The dialog the model reads is unchanged: the gateway's reason + steer.
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.startsWith(`${REAL_ASK}\n\n`));
  assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /acp-why/);

  // Same tool key, same session: the hint does not repeat.
  const again = await runHook(preToolUse({ session_id: sid }));
  assert.equal(again.systemMessage, REAL_ASK);

  // The gateway dropped its /acp-allow hint for length: supply it, with
  // the key parsed from "· rule <ToolKey> ·", not from the command text.
  nextResponse = { decision: "ask", reason: REAL_ASK_NO_HINT, approval_id: "ap5", approval_status: "pending" };
  const other = await runHook(preToolUse({ session_id: sid, tool_input: { command: "curl https://example.com" } }));
  assert.equal(other.systemMessage, `${REAL_ASK_NO_HINT}\n/acp-allow Bash.curl to stop being asked for this tool. /acp-why explains.`);
});

test("(f2) legacy prose 'step_up by … policy for <ToolKey>.' still yields the full next step, key without the sentence stop", async () => {
  nextResponse = { decision: "ask", reason: "step_up by interactive tier policy for Bash.git.push. Yes runs it once.", approval_id: "ap4b", approval_status: "pending" };
  const out = await runHook(preToolUse({ session_id: "sess-hold-legacy-1" }));
  const lines = out.systemMessage.split("\n");
  assert.equal(lines[0], "[ACP] Approval required: step_up by interactive tier policy for Bash.git.push. Yes runs it once.");
  assert.equal(lines[1], "Approve once here, or /acp-allow Bash.git.push to stop being asked for this tool. /acp-why explains.");
  assert.equal(lines.length, 2);
  assert.ok(!/governance|step-up/i.test(lines[1]), "plain words only");
});

test("(g) a safety-floor ask says no rule stops it, and never suggests /acp-allow — by action text or by rule_label", async () => {
  nextResponse = { decision: "ask", reason: REAL_FLOOR_ASK, approval_id: "ap6", approval_status: "pending" };
  const out = await runHook(preToolUse({ session_id: "sess-hold-floor-1", tool_input: { command: "git push --force" } }));
  assert.equal(out.systemMessage, `${REAL_FLOOR_ASK}\nThis is the safety floor, so no rule stops the asking. /acp-why explains.`);
  assert.doesNotMatch(out.systemMessage, /acp-allow/);

  nextResponse = { decision: "ask", reason: "ACP (Agentic Control Plane) asks: Remove ACP from this machine\n  acp-uninstall · rule Bash.acp-uninstall · yes = run once · /acp-allow Bash.acp-uninstall", rule_label: "uninstall floor: acp-uninstall", approval_id: "ap6b", approval_status: "pending" };
  const typed = await runHook(preToolUse({ session_id: "sess-hold-floor-2", tool_input: { command: "acp-uninstall" } }));
  assert.match(typed.systemMessage, /\nThis is the safety floor, so no rule stops the asking\. \/acp-why explains\.$/);
});

test("(h) an ask with no named rule gets the short hint and no /acp-allow guess", async () => {
  nextResponse = { decision: "ask", reason: "approval required", approval_id: "ap7", approval_status: "pending" };
  const out = await runHook(preToolUse({ session_id: "sess-hold-norule-1" }));
  assert.equal(out.systemMessage, "[ACP] Approval required: approval required\nApprove once here. /acp-why explains.");
});

test("(i) under codex the hold is a deny with the console route, and carries no terminal next-step line", async () => {
  nextResponse = { decision: "ask", reason: REAL_ASK, approval_id: "ap8", approval_status: "pending" };
  const out = await runHook(preToolUse({ session_id: "sess-hold-codex-1" }), { ACP_HARNESS: "codex", ACP_CLIENT: "codex-plugin" });
  assert.equal(out.hookSpecificOutput?.permissionDecision, "deny");
  assert.doesNotMatch(out.systemMessage ?? "", /Approve once here|acp-why/);
});

test("(e) PostToolUse never sends a capabilities field", async () => {
  await runHook(postToolUse());
  const req = seen.find((s) => s.url === "/govern/tool-output");
  assert.ok(req, "expected a request to /govern/tool-output");
  assert.equal(Object.prototype.hasOwnProperty.call(req.body, "capabilities"), false);
});
