// The wire `warning` on a PreToolUse allow reaches the human
// (gatewaystack-connect#429).
//
// Run with: node --test test/wire-warning.test.mjs
//
// The gateway has always been able to put a human-facing line on an allow:
// the billing grace nag ("[ACP billing] …") and, since #429, a fail-open
// ("[ACP fail-open] policy could not be read; this call ran fail-open").
// This hook read `notice` (the tier-divergence flag) and never `warning`, so
// billing warned into the void and a fail-open was silent at the terminal.
//
// Same shape as shadow-notice.test.mjs: spawn the real hook against a stub
// gateway, assert on the one stdout JSON object a hook run may write.
// Invariants:
//   1. allow + warning → the warning is the systemMessage, verbatim; nothing
//      that could change the call (no hookSpecificOutput).
//   2. allow + notice + warning → ONE systemMessage carrying both.
//   3. allow with no warning stays silent (no output regression).
//   4. deny + warning → the deny is unchanged; the warning never rides on it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOVERN = join(ROOT, "bin", "govern.mjs");
const LOOPBACK = [127, 0, 0, 1].join(".");

const WARNING =
  "[ACP fail-open] policy could not be read; this call ran fail-open (not policy-checked)";
const NOTICE =
  "[ACP] This session is governed at api tier (scoped key); the client reported interactive.";

let HOME;
let server;
let baseUrl;
let nextResponse = { decision: "allow" };

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "acp-wire-warning-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  // A workspace token routes govern.mjs down the cloud path (never LOCAL).
  writeFileSync(join(HOME, ".acp", "credentials"), "gsk_test_deadbeef\n");
  server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(nextResponse));
  });
  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
  baseUrl = `http://${LOOPBACK}:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(HOME, { recursive: true, force: true });
});

function preHook(sessionId, env = {}) {
  const input = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls -la" },
    session_id: sessionId,
    cwd: "/tmp",
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: { HOME, PATH: process.env.PATH, ACP_GOVERN_BASE: baseUrl, ...env },
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

test("allow + warning → the warning is the systemMessage, verbatim", async () => {
  nextResponse = { decision: "allow", warning: WARNING };
  const out = await preHook("sess-warn-1");
  assert.ok(out, "expected output on stdout");
  assert.equal(out.systemMessage, WARNING);
  assert.equal(out.hookSpecificOutput, undefined);
});

test("allow + notice + warning → one systemMessage carrying both", async () => {
  nextResponse = { decision: "allow", notice: NOTICE, warning: WARNING };
  const out = await preHook("sess-warn-2");
  assert.ok(out, "expected output on stdout");
  assert.equal(out.systemMessage, `${NOTICE} ${WARNING}`);
});

test("allow with no warning stays silent", async () => {
  nextResponse = { decision: "allow" };
  assert.equal(await preHook("sess-warn-3"), null);
});

test("whitespace warning is not printed", async () => {
  nextResponse = { decision: "allow", warning: "   " };
  assert.equal(await preHook("sess-warn-4"), null);
});

test("deny + warning → the deny is unchanged and the warning never rides on it", async () => {
  nextResponse = { decision: "deny", reason: "denied by interactive tier policy for Bash.ls", warning: WARNING };
  const out = await preHook("sess-warn-5");
  assert.ok(out, "expected output on stdout");
  assert.equal(out.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(out.systemMessage, /^\[ACP\] Denied by policy: denied by interactive tier policy for Bash\.ls/);
  assert.ok(!out.systemMessage.includes("[ACP fail-open]"));
});
