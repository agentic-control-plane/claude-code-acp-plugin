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
        ACP_GOVERN_BASE: baseUrl,
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

test("(e) PostToolUse never sends a capabilities field", async () => {
  await runHook(postToolUse());
  const req = seen.find((s) => s.url === "/govern/tool-output");
  assert.ok(req, "expected a request to /govern/tool-output");
  assert.equal(Object.prototype.hasOwnProperty.call(req.body, "capabilities"), false);
});
