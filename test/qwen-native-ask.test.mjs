// Qwen Code: a gateway "ask" becomes Qwen's own confirmation prompt when a
// human can be asked, and a deny when nobody can.
//
// Run with: node --test test/qwen-native-ask.test.mjs
//
// Qwen runs the shared hook with ACP_CLIENT=qwen-code. Per PreToolUse call the
// hook sends attended: { claim, source: "permission_mode", mode } and declares
// native_ask only when the claim is true. The claim is true only for a known
// permission_mode, CI unset, no agent_id (not a subagent) and a controlling
// terminal. Invariants under test:
//   a. claim true → native_ask declared, attended claim true, ask stays ask
//      with the gateway reason unchanged at the front.
//   b. no terminal / CI / subagent / missing or unknown mode → claim false,
//      no native_ask, ask becomes deny carrying the gateway reason.
//   c. the same under ACP_HARNESS=qwen-code.
//   d. ACP_TEST_TTY is ignored without ACP_TEST_DEV_BASE=1.
//   e. a gateway timeout or error never produces "ask".
//
// The hook must see ACP_TEST_DEV_BASE / ACP_TEST_TTY verbatim, but
// _dev-base.mjs strips ACP_TEST_DEV_BASE from the spawn env; those two travel
// in a node --env-file instead.

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
let seen = [];
// What the stub answers next: a JSON body, an HTTP status, or no answer at all.
let nextResponse = { decision: "allow" };
let nextStatus = 200;
let hang = false;

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "acp-qwen-native-ask-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  writeFileSync(join(HOME, ".acp", "credentials"), "gsk_test_deadbeef\n");

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* keep null */ }
      seen.push({ url: req.url, body });
      if (hang && req.url === "/govern/tool-use") return; // never answer
      res.statusCode = nextStatus;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(nextResponse));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
  nextResponse = { decision: "allow" };
  nextStatus = 200;
  hang = false;
});

let envFiles = 0;
function hookEnvArgs(vars) {
  if (!vars) return [];
  const path = join(HOME, `hook-${++envFiles}.env`);
  writeFileSync(path, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  return [`--env-file=${path}`];
}

const TTY = { ACP_TEST_DEV_BASE: "1", ACP_TEST_TTY: "1" };
const NO_TTY = { ACP_TEST_DEV_BASE: "1", ACP_TEST_TTY: "0" };
const QWEN = { ACP_CLIENT: "qwen-code" };

// NOTE: async spawn, not spawnSync — the stub server lives in THIS process.
// `detached` gives the hook its own session, i.e. no controlling terminal.
function runHook(input, { env = QWEN, hookEnv = TTY, detached = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...hookEnvArgs(hookEnv), GOVERN], {
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
      detached,
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
  tool_input: { command: "echo probe" },
  tool_use_id: "call-qwen-ask-1",
  session_id: "sess-qwen-ask",
  cwd: "/tmp",
  permission_mode: "default",
  ...overrides,
});

const toolUse = () => {
  const req = seen.find((s) => s.url === "/govern/tool-use");
  assert.ok(req, "expected a request to /govern/tool-use");
  return req.body;
};

const BRANDED = "ACP (Agentic Control Plane) asks: step_up by interactive tier policy for Bash.echo.";
const askVerdict = () => ({ decision: "ask", reason: BRANDED, approval_id: "apq", approval_status: "pending" });

// -- (a) claim true ------------------------------------------------------------

for (const mode of ["default", "yolo"]) {
  test(`(a) permission_mode ${mode} with a terminal: attended claim true and native_ask`, async () => {
    await runHook(preToolUse({ permission_mode: mode }));
    const body = toolUse();
    assert.deepEqual(body.attended, { claim: true, source: "permission_mode", mode });
    assert.ok(body.capabilities.includes("native_ask"));
    assert.equal(body.permission_mode, mode);
  });
}

test("(a) plan, auto_edit and auto also claim true", async () => {
  for (const mode of ["plan", "auto_edit", "auto"]) {
    seen = [];
    await runHook(preToolUse({ permission_mode: mode }));
    const body = toolUse();
    assert.deepEqual(body.attended, { claim: true, source: "permission_mode", mode }, mode);
    assert.ok(body.capabilities.includes("native_ask"), mode);
  }
});

test("(a) claim true: a gateway ask is Qwen's own prompt, gateway reason first and unchanged", async () => {
  nextResponse = askVerdict();
  const out = await runHook(preToolUse({ permission_mode: "yolo" }));
  assert.equal(out.hookSpecificOutput?.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput?.permissionDecision, "ask");
  const reason = out.hookSpecificOutput?.permissionDecisionReason ?? "";
  assert.ok(reason.startsWith(BRANDED), `reason should open with the gateway's text, got: ${reason}`);
  assert.match(reason, /A human is being asked now in this terminal/);
});

// -- (b) claim false -----------------------------------------------------------

function assertNoClaim(body) {
  assert.equal(body.attended?.claim, false);
  assert.equal(body.attended?.source, "permission_mode");
  assert.ok(!body.capabilities.includes("native_ask"));
}

test("(b) no terminal: claim false, no native_ask", async () => {
  await runHook(preToolUse(), { hookEnv: NO_TTY });
  const body = toolUse();
  assertNoClaim(body);
  assert.deepEqual(body.attended, { claim: false, source: "permission_mode", mode: "default" });
});

test("(b) CI=1: claim false, no native_ask", async () => {
  await runHook(preToolUse(), { env: { ...QWEN, CI: "1" } });
  assertNoClaim(toolUse());
});

test("(b) subagent (agent_id in the payload): claim false, no native_ask", async () => {
  await runHook(preToolUse({ agent_id: "agent-7" }));
  assertNoClaim(toolUse());
});

test("(b) missing permission_mode: claim false, no native_ask", async () => {
  const input = preToolUse();
  delete input.permission_mode;
  await runHook(input);
  assertNoClaim(toolUse());
});

test("(b) unknown permission_mode: claim false, no native_ask", async () => {
  await runHook(preToolUse({ permission_mode: "bypassPermissions" }));
  const body = toolUse();
  assertNoClaim(body);
  assert.equal(body.attended.mode, "bypassPermissions");
});

test("(b) claim false: a gateway ask becomes a deny carrying the gateway reason and why", async () => {
  for (const [why, opts] of [
    ["there is no terminal", { hookEnv: NO_TTY }],
    ["this is a CI run", { env: { ...QWEN, CI: "1" } }],
    ["this is a subagent", { input: { agent_id: "agent-7" } }],
  ]) {
    nextResponse = askVerdict();
    const out = await runHook(preToolUse(opts.input), opts);
    assert.equal(out.hookSpecificOutput?.permissionDecision, "deny", why);
    const reason = out.hookSpecificOutput?.permissionDecisionReason ?? "";
    assert.ok(reason.startsWith(BRANDED), `${why}: ${reason}`);
    assert.ok(reason.includes(`Qwen Code cannot ask here (${why}), so this arrives as a block. Approve it in the ACP console, then run it again.`), `${why}: ${reason}`);
  }
  // An unbranded gateway reason is still carried unchanged.
  nextResponse = { decision: "ask", reason: "step_up for Bash.echo needs review", approval_id: "apq2", approval_status: "pending" };
  const out = await runHook(preToolUse(), { hookEnv: NO_TTY });
  assert.equal(out.hookSpecificOutput?.permissionDecision, "deny");
  assert.ok((out.hookSpecificOutput?.permissionDecisionReason ?? "").includes("step_up for Bash.echo needs review"));
});

// -- (c) identified by ACP_HARNESS ---------------------------------------------

test("(c) ACP_HARNESS=qwen-code: claim true asks, claim false denies", async () => {
  const env = { ACP_HARNESS: "qwen-code" };
  nextResponse = askVerdict();
  let out = await runHook(preToolUse({ permission_mode: "yolo" }), { env });
  let body = toolUse();
  assert.deepEqual(body.attended, { claim: true, source: "permission_mode", mode: "yolo" });
  assert.ok(body.capabilities.includes("native_ask"));
  assert.equal(out.hookSpecificOutput?.permissionDecision, "ask");
  assert.ok((out.hookSpecificOutput?.permissionDecisionReason ?? "").startsWith(BRANDED));

  seen = [];
  out = await runHook(preToolUse(), { env, hookEnv: NO_TTY });
  body = toolUse();
  assertNoClaim(body);
  assert.equal(out.hookSpecificOutput?.permissionDecision, "deny");
  assert.ok((out.hookSpecificOutput?.permissionDecisionReason ?? "").includes(BRANDED));
});

// -- (d) test override is test-only --------------------------------------------

test("(d) ACP_TEST_TTY is ignored without ACP_TEST_DEV_BASE=1", async () => {
  // Detached (POSIX setsid): the hook has no controlling terminal, so the real
  // check says no.
  // With the gate, the override wins (control) ...
  await runHook(preToolUse(), { hookEnv: { ACP_TEST_DEV_BASE: "1", ACP_TEST_TTY: "1" }, detached: true });
  assert.equal(toolUse().attended.claim, true);
  // ... without it, ACP_TEST_TTY=1 changes nothing.
  seen = [];
  await runHook(preToolUse(), { hookEnv: { ACP_TEST_TTY: "1" }, detached: true });
  assertNoClaim(toolUse());
});

// -- (e) outage never asks -----------------------------------------------------

test("(e) a gateway error or timeout under Qwen never produces ask", async () => {
  nextStatus = 500;
  nextResponse = { decision: "ask", reason: BRANDED };
  let out = await runHook(preToolUse());
  assert.notEqual(out?.hookSpecificOutput?.permissionDecision, "ask");

  nextStatus = 200;
  hang = true;
  out = await runHook(preToolUse(), {
    env: { ...QWEN, ACP_FIRST_ATTEMPT_MS: "300", ACP_RETRY_ATTEMPT_MS: "300" },
  });
  assert.notEqual(out?.hookSpecificOutput?.permissionDecision, "ask");
  // At an unattended tier the outage stays a deny.
  out = await runHook(preToolUse({ agent_id: "agent-7" }), {
    env: { ...QWEN, ACP_FIRST_ATTEMPT_MS: "300", ACP_RETRY_ATTEMPT_MS: "300" },
  });
  assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny");
});
