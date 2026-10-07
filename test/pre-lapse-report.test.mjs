// Pending-lapse round trip in bin/govern.mjs (gatewaystack-connect#902).
//
// Run with: node --test test/pre-lapse-report.test.mjs
//
// An interactive-tier PreToolUse that cannot reach the gateway fails open
// (never-brick) and used to leave its only record in ~/.acp/lapse.log. It
// now also queues the lapse per session under ~/.acp/lapse-pending/, and
// the session's next PostToolUse carries it as `pre_lapse` so the gateway
// can write the row for the call it never saw. Invariants:
//   1. fail-open PreToolUse writes lapse-pending/<session>.json with
//      [{ at, tool, detail }] and still allows the call.
//   2. PostToolUse for that session sends pre_lapse and, on a 2xx, deletes
//      the marker; the following PostToolUse sends no pre_lapse.
//   3. A non-2xx from /govern/tool-output keeps the marker (retry later).
//   4. Repeated lapses append; the marker never exceeds 20 entries.
//   5. A lapse in one session never leaks into another session's report.
// The hook is spawned exactly the way a harness does — JSON on stdin —
// against a throwaway HOME, with ACP_GOVERN_BASE pointed at a local stub
// (or at a closed port for the outage).

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

let HOME;
let server;
let baseUrl;
// Requests the stub saw (parsed bodies), and what it answers next.
let seen = [];
let nextStatus = 200;

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "acp-prelapse-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  writeFileSync(join(HOME, ".acp", "credentials"), "gsk_test_deadbeef\n");
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* keep null */ }
      seen.push({ url: req.url, body });
      res.statusCode = nextStatus;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ action: "pass" }));
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
  nextStatus = 200;
  rmSync(join(HOME, ".acp", "lapse-pending"), { recursive: true, force: true });
});

// Closed port: connection refused, both attempts fail fast → outage posture.
const DEAD = "http://127.0.0.1:1";

// Explicit env (never spread process.env): the runner's own CI=true would
// flip the tier to background and the outage posture to fail-closed.
function runHook(input, governBase) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: {
        HOME,
        PATH: process.env.PATH,
        ACP_SELF_HOST: "1", ACP_GOVERN_BASE: governBase,
        CLAUDE_CODE_ENTRYPOINT: "cli",
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

const pre = (session_id, command = "ls -la") => ({
  hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, session_id,
});
const post = (session_id) => ({
  hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls -la" },
  tool_response: "total 0", session_id, tool_use_id: "call-1",
});

function marker(session_id) {
  const p = join(HOME, ".acp", "lapse-pending", `${session_id}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

test("fail-open PreToolUse allows the call and queues a pending lapse", async () => {
  const r = await runHook(pre("sess-a"), DEAD);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json?.hookSpecificOutput?.permissionDecision, "allow");
  assert.match(r.json?.systemMessage ?? "", /UNGOVERNED/);
  const m = marker("sess-a");
  assert.ok(Array.isArray(m) && m.length === 1, `expected one pending entry, got ${JSON.stringify(m)}`);
  assert.equal(m[0].tool, "Bash");
  assert.ok(typeof m[0].detail === "string" && m[0].detail.length > 0, "detail is a non-empty string");
  assert.ok(!Number.isNaN(Date.parse(m[0].at)), "at is an ISO timestamp");
  // lapse.log still gets its line — the marker is in addition, not instead.
  assert.match(readFileSync(join(HOME, ".acp", "lapse.log"), "utf8"), /"tool":"Bash"/);
});

test("next PostToolUse carries pre_lapse, clears the marker on 2xx, and the one after is clean", async () => {
  await runHook(pre("sess-b"), DEAD);
  assert.equal(marker("sess-b")?.length, 1);

  const r1 = await runHook(post("sess-b"), baseUrl);
  assert.equal(r1.code, 0, r1.stderr);
  const out1 = seen.find((s) => s.url === "/govern/tool-output");
  assert.ok(out1, "PostToolUse reached the stub");
  assert.ok(Array.isArray(out1.body.pre_lapse), "pre_lapse array present");
  assert.equal(out1.body.pre_lapse.length, 1);
  assert.equal(out1.body.pre_lapse[0].tool, "Bash");
  assert.equal(out1.body.session_id, "sess-b");
  assert.equal(marker("sess-b"), null, "marker deleted after 2xx");

  seen = [];
  const r2 = await runHook(post("sess-b"), baseUrl);
  assert.equal(r2.code, 0, r2.stderr);
  const out2 = seen.find((s) => s.url === "/govern/tool-output");
  assert.ok(out2, "second PostToolUse reached the stub");
  assert.equal(out2.body.pre_lapse, undefined, "no pre_lapse once reported");
});

test("a non-2xx from /govern/tool-output keeps the marker for the next call", async () => {
  await runHook(pre("sess-c"), DEAD);
  nextStatus = 503;
  const r = await runHook(post("sess-c"), baseUrl);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(seen.find((s) => s.url === "/govern/tool-output")?.body.pre_lapse?.length, 1);
  assert.equal(marker("sess-c")?.length, 1, "marker survives a failed report");
  // Gateway still down at PostToolUse too: also survives.
  const r2 = await runHook(post("sess-c"), DEAD);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(marker("sess-c")?.length, 1);
});

test("repeated lapses append and the marker is capped at 20 entries", async () => {
  for (let i = 0; i < 3; i++) await runHook(pre("sess-d", `echo ${i}`), DEAD);
  assert.equal(marker("sess-d")?.length, 3);
  // Pre-seed 25 entries to prove the cap without 25 spawns.
  const dir = join(HOME, ".acp", "lapse-pending");
  writeFileSync(join(dir, "sess-e.json"), JSON.stringify(
    Array.from({ length: 25 }, (_, i) => ({ at: new Date().toISOString(), tool: "Bash", detail: `seed ${i}` })),
  ));
  await runHook(pre("sess-e"), DEAD);
  const m = marker("sess-e");
  assert.equal(m.length, 20);
  assert.notEqual(m[m.length - 1].detail.slice(0, 4), "seed", "the newest lapse is the last entry");
  const r = await runHook(post("sess-e"), baseUrl);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(seen.find((s) => s.url === "/govern/tool-output")?.body.pre_lapse?.length, 20);
});

test("a lapse in one session never rides on another session's PostToolUse", async () => {
  await runHook(pre("sess-f"), DEAD);
  const r = await runHook(post("sess-g"), baseUrl);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(seen.find((s) => s.url === "/govern/tool-output")?.body.pre_lapse, undefined);
  assert.equal(marker("sess-f")?.length, 1, "sess-f marker untouched");
});

test("a corrupt marker is ignored, never blocks the call, and is replaced on the next lapse", async () => {
  const dir = join(HOME, ".acp", "lapse-pending");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sess-h.json"), "{not json");
  const r = await runHook(post("sess-h"), baseUrl);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(seen.find((s) => s.url === "/govern/tool-output")?.body.pre_lapse, undefined);
  await runHook(pre("sess-h"), DEAD);
  assert.equal(marker("sess-h")?.length, 1);
});
