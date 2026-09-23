// Tests for the #1348 receipt split in bin/govern.mjs: a per-turn line on
// Stop (silent unless the turn did something, or a held call is still
// pending) versus the real cumulative-totals receipt on SessionEnd. Before
// this change, handleStop cleared the cumulative counters on every Stop —
// which in Claude Code fires every assistant turn, not once per session —
// so a multi-turn session's receipt only ever reported the last turn.
//
// Run with: node --test test/turn-and-session-receipt.test.mjs
//
// Each test spawns the real hook against a throwaway fixture HOME, with a
// local stub standing in for /govern/tool-use, /govern/tool-output and
// /govern/attest. State (turn stats, cumulative stats, pending approvals)
// lives in files under HOME/.acp/session-stats, so it persists across the
// separate child processes each hook event spawns, exactly as it would
// across real harness events in one session.

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
const LOOPBACK = [127, 0, 0, 1].join(".");

let HOME;
let server;
let baseUrl;
let nextToolUse = { decision: "allow" };
let nextToolOutput = { action: "pass" };

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "acp-turn-receipt-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  writeFileSync(join(HOME, ".acp", "credentials"), "gsk_test_deadbeef\n");

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url.endsWith("/govern/tool-use")) {
        res.end(JSON.stringify(nextToolUse));
      } else if (req.url.endsWith("/govern/tool-output")) {
        res.end(JSON.stringify(nextToolOutput));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
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
  nextToolUse = { decision: "allow" };
  nextToolOutput = { action: "pass" };
});

function runHook(input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: { HOME, PATH: process.env.PATH, ACP_GOVERN_BASE: baseUrl, ACP_API_BASE: baseUrl, ...env },
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

const preToolUse = (sid, overrides = {}) => ({
  hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" },
  session_id: sid, permission_mode: "default", ...overrides,
});
const postToolUse = (sid, overrides = {}) => ({
  hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" },
  tool_response: "ok", session_id: sid, ...overrides,
});
const stop = (sid, overrides = {}) => ({ hook_event_name: "Stop", session_id: sid, ...overrides });
const sessionEnd = (sid, overrides = {}) => ({ hook_event_name: "SessionEnd", session_id: sid, ...overrides });

test("Stop is silent when the turn had no held call, flag, shadow or cost notice", async () => {
  const sid = "sess-turn-silent";
  nextToolOutput = { action: "pass" };
  await runHook(postToolUse(sid));
  const out = await runHook(stop(sid));
  assert.equal(out, null);
});

test("Stop reports a flagged call this turn, then goes silent again next turn", async () => {
  const sid = "sess-turn-flag";
  nextToolOutput = { action: "redact", reason: "redacted PII" };
  await runHook(postToolUse(sid));
  const out1 = await runHook(stop(sid));
  assert.match(out1.systemMessage, /This turn: 1 flagged/);

  nextToolOutput = { action: "pass" };
  await runHook(postToolUse(sid));
  const out2 = await runHook(stop(sid));
  assert.equal(out2, null, "turn counters must reset after Stop");
});

test("a held call lists still-pending approvals on Stop, across turns, until resolved", async () => {
  const sid = "sess-turn-held";
  nextToolUse = {
    decision: "deny", reason: "ask a human", kind: "delegate",
    approval_id: "1234abcd-0000-4000-8000-000000000000",
    approval_code: "1234",
    approval_url: "https://cloud.agenticcontrolplane.com/approvals?id=1234abcd",
    approval_summary: "Bash · rm -rf build/",
  };
  await runHook(preToolUse(sid));
  const out1 = await runHook(stop(sid));
  assert.match(out1.systemMessage, /This turn: 1 held/);
  assert.match(out1.systemMessage, /Still pending approval/);
  assert.match(out1.systemMessage, /ACP-1234/);
  assert.match(out1.systemMessage, /Bash · rm -rf build\/|https:\/\/cloud\.agenticcontrolplane\.com\/approvals\?id=1234abcd/);

  // Next turn: the "this turn" bucket is empty again, but the call is
  // still pending, so the reminder must persist.
  const out2 = await runHook(stop(sid));
  assert.ok(!out2.systemMessage.includes("This turn:"), "no new activity this turn");
  assert.match(out2.systemMessage, /ACP-1234/);
});

test("SessionEnd reports cumulative totals across every turn, not just the last one, then clears", async () => {
  const sid = "sess-end-totals";
  nextToolOutput = { action: "pass" };
  await runHook(postToolUse(sid));
  await runHook(stop(sid));
  await runHook(postToolUse(sid));
  await runHook(stop(sid));
  await runHook(postToolUse(sid));
  const end1 = await runHook(sessionEnd(sid));
  assert.match(end1.systemMessage, /3 tool calls governed/, "totals must survive the intermediate Stops");

  // A fresh call after SessionEnd starts a new receipt from zero.
  await runHook(postToolUse(sid));
  const end2 = await runHook(sessionEnd(sid));
  assert.match(end2.systemMessage, /1 tool call governed/, "SessionEnd must clear the cumulative counters");
});

test("SessionEnd is silent when the session made no governed calls", async () => {
  const out = await runHook(sessionEnd("sess-end-empty"));
  assert.equal(out, null);
});
