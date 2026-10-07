// Tests for the PostToolUse shadow-notice branch in bin/govern.mjs
// (gatewaystack-connect#607).
//
// Run with: node --test test/shadow-notice.test.mjs
//
// Each test spawns the real hook exactly the way a harness does — JSON on
// stdin, systemMessage JSON on stdout — against a throwaway fixture HOME
// holding a workspace token, with ACP_GOVERN_BASE pointed at a local stub
// server standing in for /govern/tool-output. Invariants under test:
//   1. action "pass" + a `notice` string → the notice is emitted verbatim
//      as systemMessage (audit mode finally has a voice).
//   2. ACP_SHADOW=off suppresses the print client-side even when the
//      server sends a notice (belt to the server's suspenders).
//   3. redact/block behavior is unchanged, and a stray notice alongside
//      them never double-prints.
//   4. action "pass" with no notice stays silent (no output regression).

import { test, before, after } from "node:test";
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

const NOTICE =
  "[ACP shadow] That was Bash.rm — deleted files don't come back. " +
  "Enforcement would have paused for your OK before this ran; it ran because audit mode never blocks.";

let HOME;
let server;
let baseUrl;
// The response the stub returns for the next request(s).
let nextResponse = { action: "pass" };

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "acp-shadow-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  // A workspace token routes govern.mjs down the cloud path (never LOCAL).
  writeFileSync(join(HOME, ".acp", "credentials"), "gsk_test_deadbeef\n");

  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(nextResponse));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(HOME, { recursive: true, force: true });
});

// NOTE: async spawn, not spawnSync — the stub server lives in THIS
// process, and spawnSync would block the event loop, so the hook's fetch
// could never be answered (it would time out and silently pass).
function postHook(env = {}) {
  const input = {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "rm -rf build/" },
    tool_response: "removed build/",
    session_id: "sess-shadow-1",
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: { HOME, PATH: process.env.PATH, ACP_TEST_DEV_BASE: "1", ACP_GOVERN_BASE: baseUrl, ...env },
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
        resolve(stdout ? JSON.parse(stdout) : null);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

test("pass + notice → the server's notice is emitted verbatim as systemMessage", async () => {
  nextResponse = { action: "pass", notice: NOTICE };
  const out = await postHook();
  assert.ok(out, "expected output on stdout");
  assert.equal(out.systemMessage, NOTICE);
  // Advisory only: no hookSpecificOutput, nothing that could change the call.
  assert.equal(out.hookSpecificOutput, undefined);
});

test("ACP_SHADOW=off suppresses the notice client-side", async () => {
  nextResponse = { action: "pass", notice: NOTICE };
  for (const value of ["off", "OFF", "0", "false"]) {
    assert.equal(await postHook({ ACP_SHADOW: value }), null, `ACP_SHADOW=${value} should silence`);
  }
});

test("ACP_SHADOW set to a non-off value still prints", async () => {
  nextResponse = { action: "pass", notice: NOTICE };
  const out = await postHook({ ACP_SHADOW: "on" });
  assert.equal(out?.systemMessage, NOTICE);
});

test("redact keeps its existing message and never double-prints a stray notice", async () => {
  nextResponse = { action: "redact", reason: "redacted PII: email", notice: NOTICE };
  const out = await postHook();
  assert.match(out.systemMessage, /^\[ACP\] Flagged: redacted PII: email/);
  assert.ok(!out.systemMessage.includes("[ACP shadow]"));
});

test("block message is unchanged", async () => {
  nextResponse = { action: "block", reason: "prompt-injection detected" };
  const out = await postHook();
  assert.match(out.systemMessage, /^\[ACP\] Blocked: prompt-injection detected/);
});

test("pass with no notice stays silent", async () => {
  nextResponse = { action: "pass" };
  assert.equal(await postHook(), null);
});

test("empty/whitespace notice is not printed", async () => {
  nextResponse = { action: "pass", notice: "   " };
  assert.equal(await postHook(), null);
});
