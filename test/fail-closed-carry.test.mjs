// An unattended-tier fail-CLOSED deny is carried to the gateway
// (gatewaystack-connect#690, fix 3).
//
// Run with: node --test test/fail-closed-carry.test.mjs
//
// Confirmed 2026-08-13: /govern/tool-use answered a slow request with an
// ALLOW after this hook had already aborted and, at an unattended tier,
// denied. The server's ledger said allowed; the agent was blocked; neither
// side could see the contradiction. The interactive fail-OPEN branch has
// queued its lapse for the session's next PostToolUse since 0.14.0; the
// fail-CLOSED branch recorded nothing. Invariants:
//   1. background-tier outage → deny (unchanged), a lapse.log line with
//      posture "closed", and a pending marker whose detail is marked
//      "fail-closed (<tier> tier): …".
//   2. the session's next PostToolUse carries it as pre_lapse and clears
//      the marker on 2xx.
//   3. the marker never affects the PostToolUse action.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOVERN = join(ROOT, "bin", "govern.mjs");
const LOOPBACK = [127, 0, 0, 1].join(".");
// Closed port: connection refused, both attempts fail fast → outage posture.
const DEAD = `http://${LOOPBACK}:1`;

let HOME;
let server;
let baseUrl;
let seen = [];

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "acp-fail-closed-carry-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  writeFileSync(join(HOME, ".acp", "credentials"), "gsk_test_deadbeef\n");
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ action: "pass" }));
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
  seen = [];
  rmSync(join(HOME, ".acp", "lapse-pending"), { recursive: true, force: true });
  rmSync(join(HOME, ".acp", "lapse.log"), { force: true });
});

// CI=true is how the runner's own environment flips the tier to background;
// set it explicitly here so the outage posture under test is fail-closed.
function runHook(input, governBase) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: {
        HOME,
        PATH: process.env.PATH,
        ACP_GOVERN_BASE: governBase,
        CI: "true",
        ACP_FIRST_ATTEMPT_MS: "400",
        ACP_RETRY_ATTEMPT_MS: "400",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const killer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr, json: stdout.trim() ? JSON.parse(stdout) : null });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

const pre = (session_id) => ({
  hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls -la" }, session_id,
});
const post = (session_id) => ({
  hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls -la" },
  tool_response: "total 0", session_id, tool_use_id: "call-1",
});

function marker(session_id) {
  const p = join(HOME, ".acp", "lapse-pending", `${session_id}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

test("unattended outage: still denies, logs the lapse with posture closed, queues a marked marker", async () => {
  const r = await runHook(pre("sess-closed-1"), DEAD);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(r.json.systemMessage, /^\[ACP\] Gateway unreachable/);
  const m = marker("sess-closed-1");
  assert.ok(m && m.length === 1, "expected one pending entry");
  assert.equal(m[0].tool, "Bash");
  assert.match(m[0].detail, /^fail-closed \((background|subagent|api) tier\): /);
  const log = readFileSync(join(HOME, ".acp", "lapse.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].posture, "closed");
  assert.equal(log[0].tool, "Bash");
});

test("the session's next PostToolUse carries it as pre_lapse and clears the marker on 2xx", async () => {
  await runHook(pre("sess-closed-2"), DEAD);
  assert.ok(marker("sess-closed-2"));
  const r = await runHook(post("sess-closed-2"), baseUrl);
  assert.equal(r.code, 0, r.stderr);
  const report = seen.find((s) => s.url.endsWith("/govern/tool-output"));
  assert.ok(report, "expected a tool-output report");
  assert.ok(Array.isArray(report.body.pre_lapse) && report.body.pre_lapse.length === 1);
  assert.match(report.body.pre_lapse[0].detail, /^fail-closed \(/);
  assert.equal(marker("sess-closed-2"), null);
  // Advisory only: the carried record never changes what PostToolUse emits.
  assert.equal(r.json, null);
});
