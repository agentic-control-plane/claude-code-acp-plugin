// Wire-level tests for tier detection in bin/govern.mjs
// (gatewaystack-connect#692: truthful tier labels).
//
// Run with: node --test test/tier-detection.test.mjs
//
// Each test spawns the real hook the way a harness does — JSON on stdin —
// against a local capture server standing in for the gateway, then asserts
// the agent_tier the hook actually put on the wire. The regressions these
// guard: headless/cron runs reporting "interactive" (the loosest tier for
// the most unattended shape), Task-spawned subagents being undetectable,
// and auto mode (a human at the terminal) reporting "subagent".

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOVERN = join(ROOT, "bin", "govern.mjs");

let HOME;
let server;
let baseUrl;
let captured;          // bodies the hook sent, in order
let nextResponse;      // what the fake gateway answers

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { captured.push({ path: req.url, body: JSON.parse(raw) }); } catch { captured.push({ path: req.url, body: null }); }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(nextResponse));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  // Fresh HOME per test: the tier-notice session marker and lapse log are
  // per-HOME state, and sharing one would leak dedupe across tests.
  if (HOME) rmSync(HOME, { recursive: true, force: true });
  HOME = mkdtempSync(join(tmpdir(), "acp-tier-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  captured = [];
  nextResponse = { decision: "allow", reason: "allowed by policy" };
});

// Spawn the hook with a fully controlled env. spawnSync would block the
// event loop and starve the capture server, so this is the async form.
function hook(inputObj, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: {
        HOME,
        PATH: process.env.PATH,
        ACP_BEARER_TOKEN: "test-token",
        ACP_SELF_HOST: "1", ACP_GOVERN_BASE: baseUrl,
        ACP_SELF_HOST: "1", ACP_API_BASE: baseUrl,
        // No CLAUDE_CODE_ENTRYPOINT / CI unless a test sets them — the
        // parent process may be running under CI itself.
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(inputObj));
  });
}

const pre = (extra = {}) => ({
  tool_name: "Bash",
  tool_input: { command: "echo hi" },
  session_id: "sess-1",
  hook_event_name: "PreToolUse",
  ...extra,
});

function sentTier() {
  assert.equal(captured.length, 1, "expected exactly one gateway call");
  return captured[0].body.agent_tier;
}

test("interactive terminal (entrypoint cli, default mode) reports interactive", async () => {
  await hook(pre({ permission_mode: "default" }), { CLAUDE_CODE_ENTRYPOINT: "cli" });
  assert.equal(sentTier(), "interactive");
});

test("auto mode is a HUMAN at the terminal — interactive, not subagent", async () => {
  await hook(pre({ permission_mode: "auto" }), { CLAUDE_CODE_ENTRYPOINT: "cli" });
  assert.equal(sentTier(), "interactive");
});

test("headless -p run (entrypoint sdk-cli) reports background, not interactive", async () => {
  await hook(pre({ permission_mode: "default" }), { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
  assert.equal(sentTier(), "background");
});

test("SDK-driven and CI entrypoints report background", async () => {
  for (const entry of ["sdk-ts", "sdk-py", "mcp", "claude-code-github-action"]) {
    captured = [];
    await hook(pre(), { CLAUDE_CODE_ENTRYPOINT: entry });
    assert.equal(sentTier(), "background", `entrypoint ${entry}`);
  }
});

test("CI env var alone reports background", async () => {
  await hook(pre({ permission_mode: "default" }), { CLAUDE_CODE_ENTRYPOINT: "cli", CI: "true" });
  assert.equal(sentTier(), "background");
});

test("Task-spawned subagent (agent_id on hook input) reports subagent", async () => {
  await hook(pre({ permission_mode: "default", agent_id: "agent-abc", agent_type: "Explore" }), { CLAUDE_CODE_ENTRYPOINT: "cli" });
  assert.equal(sentTier(), "subagent");
});

test("a subagent inside a headless run is still unattended — background wins", async () => {
  await hook(pre({ agent_id: "agent-abc" }), { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
  assert.equal(sentTier(), "background");
});

test("bypassPermissions reports background regardless of entrypoint", async () => {
  await hook(pre({ permission_mode: "bypassPermissions" }), { CLAUDE_CODE_ENTRYPOINT: "cli" });
  assert.equal(sentTier(), "background");
});

test("tier_signals ride along so the server can audit what drove the claim", async () => {
  await hook(pre({ agent_id: "agent-abc" }), { CLAUDE_CODE_ENTRYPOINT: "cli" });
  assert.deepEqual(captured[0].body.tier_signals, { entrypoint: "cli", agentId: true });
});

test("server tier-divergence notice is relayed as a systemMessage on allow", async () => {
  nextResponse = {
    decision: "allow",
    reason: "allowed by policy",
    notice: "[ACP] tier divergence: client reported tier \"interactive\", enforced as \"api\" (scoped API key credential enforces api-tier policy). Recorded for audit; this note does not block the call.",
  };
  const res = await hook(pre({ permission_mode: "default" }), { CLAUDE_CODE_ENTRYPOINT: "cli" });
  const out = JSON.parse(res.stdout);
  assert.match(out.systemMessage, /tier divergence/);
  // Exactly one JSON object on stdout — the notice must never produce a second.
  assert.doesNotThrow(() => JSON.parse(res.stdout));
});

test("the divergence notice is deduped within a session (flag once, not per call)", async () => {
  nextResponse = { decision: "allow", notice: "[ACP] tier divergence: ..." };
  const first = await hook(pre());
  assert.match(JSON.parse(first.stdout).systemMessage, /tier divergence/);
  const second = await hook(pre());
  assert.equal(second.stdout, "", "second call in the same session stays silent");
  // A new session surfaces it again.
  const newSession = await hook(pre({ session_id: "sess-2" }));
  assert.match(JSON.parse(newSession.stdout).systemMessage, /tier divergence/);
});

test("a policy deny still denies — the notice path never loosens enforcement", async () => {
  nextResponse = { decision: "deny", reason: "denied by api tier (scoped API key; session reported interactive) policy for Bash.echo" };
  const res = await hook(pre());
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.systemMessage, /scoped API key; session reported interactive/);
});
