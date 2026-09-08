// End-to-end tests for the offline floor, local ledger, and flush in
// bin/govern.mjs (plugin#29, phase 1). Each test spawns the real hook the
// way a harness does — JSON on stdin, decision JSON on stdout — against a
// throwaway HOME. The gateway is either absent (no key), refused
// (connection to a closed port), or a tiny local server for the flush.
//
// Run with: node --test test/offline-floor.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOVERN = join(ROOT, "bin", "govern.mjs");
const LEDGER = (home) => join(home, ".acp", "ledger.jsonl");

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), "acp-offline-test-"));
  mkdirSync(join(home, ".acp"), { recursive: true });
  return home;
}

function hook(home, inputObj, env = {}, args = []) {
  const res = spawnSync(process.execPath, [GOVERN, ...args], {
    input: JSON.stringify(inputObj),
    env: { PATH: process.env.PATH, HOME: home, ACP_FIRST_ATTEMPT_MS: "300", ACP_RETRY_ATTEMPT_MS: "300", ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
  let out = null;
  try { out = res.stdout.trim() ? JSON.parse(res.stdout.trim()) : null; } catch { out = { raw: res.stdout }; }
  return { status: res.status, out, stderr: res.stderr };
}

// Async variant for runs that must talk to the in-process fake gateway: a
// synchronous spawn would block this event loop, the server could never
// answer, and the child would abort on its own timeout.
function hookAsync(home, inputObj, env = {}, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GOVERN, ...args], {
      env: { PATH: process.env.PATH, HOME: home, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(inputObj));
  });
}

const pre = (command, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, session_id: "s1", cwd: "/work/project", ...extra });
const rows = (home) => existsSync(LEDGER(home)) ? readFileSync(LEDGER(home), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

// ── No key (the on-ramp) ─────────────────────────────────────────────

test("no key: benign call allows with the ungoverned banner and lands in the ledger", () => {
  const home = freshHome();
  const r = hook(home, pre("git status"));
  assert.equal(r.status, 0);
  assert.match(r.out?.systemMessage ?? "", /UNGOVERNED/);
  assert.equal(r.out?.hookSpecificOutput, undefined);
  const l = rows(home);
  assert.equal(l.length, 1);
  assert.equal(l[0].mode, "no-key");
  assert.equal(l[0].decision, "allow");
  assert.equal(l[0].classified, "Bash.git.status");
  assert.equal(l[0].harness, "claude-code");
  assert.ok(l[0].id.length === 32);
  rmSync(home, { recursive: true, force: true });
});

test("no key: destructive call asks with the floor label; hardline denies", () => {
  const home = freshHome();
  const ask = hook(home, pre('psql -c "DROP TABLE users"'));
  assert.equal(ask.out.hookSpecificOutput.permissionDecision, "ask");
  assert.match(ask.out.hookSpecificOutput.permissionDecisionReason, /Destructive floor: destructive SQL \(drop\)/);
  const deny = hook(home, pre("rm -rf ~"));
  assert.equal(deny.out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(deny.out.hookSpecificOutput.permissionDecisionReason, /safety floor/);
  const l = rows(home);
  assert.deepEqual(l.map((x) => [x.decision, x.source]), [["ask", "destructive-floor"], ["deny", "hardline"]]);
  rmSync(home, { recursive: true, force: true });
});

test("no key: prose does not trip the floor, and nothing is spawned or sent", () => {
  const home = freshHome();
  const r = hook(home, pre("gh issue create --title 'floor (force push, DROP/TRUNCATE, curl|sh, rm -r)' --body-file f.md"));
  assert.equal(r.out?.hookSpecificOutput, undefined);
  assert.equal(existsSync(join(home, ".acp", "ledger.flush-lock")), false);
  rmSync(home, { recursive: true, force: true });
});

// ── Key present, gateway unreachable ─────────────────────────────────

test("unreachable, interactive: benign allows loudly, destructive asks, hardline denies; all in the ledger", () => {
  const home = freshHome();
  const env = { ACP_BEARER_TOKEN: "gsk_test_x", ACP_GOVERN_BASE: "http://127.0.0.1:9" };
  const ok = hook(home, pre("git status"), env);
  assert.equal(ok.out.hookSpecificOutput.permissionDecision, "allow");
  assert.match(ok.out.systemMessage, /UNGOVERNED: gateway unreachable/);
  const ask = hook(home, pre("git push --force origin feat"), env);
  assert.equal(ask.out.hookSpecificOutput.permissionDecision, "ask");
  assert.match(ask.out.hookSpecificOutput.permissionDecisionReason, /force-pushes/);
  const deny = hook(home, pre("rm -rf ~"), env);
  assert.equal(deny.out.hookSpecificOutput.permissionDecision, "deny");
  const l = rows(home);
  assert.deepEqual(l.map((x) => [x.mode, x.decision]), [["unreachable", "allow"], ["unreachable", "ask"], ["unreachable", "deny"]]);
  rmSync(home, { recursive: true, force: true });
});

test("unreachable, unattended tier: stays fail-closed, and the deny is in the ledger", () => {
  const home = freshHome();
  const env = { ACP_BEARER_TOKEN: "gsk_test_x", ACP_GOVERN_BASE: "http://127.0.0.1:9", CLAUDE_CODE_ENTRYPOINT: "sdk-cli" };
  const r = hook(home, pre("git status"), env);
  assert.equal(r.out.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(rows(home)[0].source, "fail-closed");
  rmSync(home, { recursive: true, force: true });
});

// ── Flush ────────────────────────────────────────────────────────────

function fakeGateway(handler) {
  return new Promise((resolve) => {
    const received = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "null") });
        handler(req, res, received);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, received }));
  });
}

test("--flush uploads the ledger in order, truncates on ack, and is idempotent by row id", async () => {
  const home = freshHome();
  writeFileSync(LEDGER(home), [
    JSON.stringify({ id: "a".repeat(32), ts: "2026-09-08T00:00:00.000Z", tool: "Bash", decision: "allow", mode: "no-key" }),
    JSON.stringify({ id: "b".repeat(32), ts: "2026-09-08T00:00:01.000Z", tool: "Bash", decision: "ask", mode: "no-key" }),
    "",
  ].join("\n"));
  const gw = await fakeGateway((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, accepted: 2, duplicates: 0 })); });
  try {
    const r = await hookAsync(home, {}, { ACP_BEARER_TOKEN: "gsk_test_x", ACP_GOVERN_BASE: `http://127.0.0.1:${gw.port}` }, ["--flush"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(gw.received.length, 1, `no flush reached the gateway; stderr: ${r.stderr}`);
    assert.equal(gw.received[0].url, "/govern/ledger/flush");
    assert.equal(gw.received[0].auth, "Bearer gsk_test_x");
    assert.equal(gw.received[0].body.rows.length, 2);
    assert.equal(gw.received[0].body.rows[0].id, "a".repeat(32));
    assert.equal(gw.received[0].body.harness, "claude-code");
    assert.equal(readFileSync(LEDGER(home), "utf8"), "");
    assert.equal(existsSync(join(home, ".acp", "ledger.flush-backoff")), false);
  } finally {
    gw.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("--flush on a failing gateway keeps the ledger and writes a backoff; without a key it sends nothing", async () => {
  const home = freshHome();
  writeFileSync(LEDGER(home), `${JSON.stringify({ id: "c".repeat(32), ts: "2026-09-08T00:00:00.000Z", tool: "Bash", decision: "allow", mode: "no-key" })}\n`);
  const gw = await fakeGateway((req, res) => { res.writeHead(503); res.end(); });
  try {
    await hookAsync(home, {}, { ACP_BEARER_TOKEN: "gsk_test_x", ACP_GOVERN_BASE: `http://127.0.0.1:${gw.port}` }, ["--flush"]);
    assert.equal(rows(home).length, 1);
    assert.ok(Number(readFileSync(join(home, ".acp", "ledger.flush-backoff"), "utf8")) > Date.now());
    // Backoff honored: a second flush does not hit the server.
    await hookAsync(home, {}, { ACP_BEARER_TOKEN: "gsk_test_x", ACP_GOVERN_BASE: `http://127.0.0.1:${gw.port}` }, ["--flush"]);
    assert.equal(gw.received.length, 1);
    // No key: nothing leaves the machine.
    await hookAsync(home, {}, { ACP_GOVERN_BASE: `http://127.0.0.1:${gw.port}` }, ["--flush"]);
    assert.equal(gw.received.length, 1);
    assert.equal(rows(home).length, 1);
  } finally {
    gw.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("SessionStart with a key and a non-empty ledger announces the upload and arms the flush", async () => {
  const home = freshHome();
  writeFileSync(LEDGER(home), `${JSON.stringify({ id: "d".repeat(32), ts: "2026-09-08T00:00:00.000Z", tool: "Bash", decision: "allow", mode: "no-key" })}\n`);
  const gw = await fakeGateway((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, accepted: 1 })); });
  try {
    const r = hook(home, { hook_event_name: "SessionStart", session_id: "s2", cwd: "/work" }, { ACP_BEARER_TOKEN: "gsk_test_x", ACP_GOVERN_BASE: `http://127.0.0.1:${gw.port}` });
    assert.equal(r.status, 0);
    assert.match(r.stdout ?? JSON.stringify(r.out), /1 tool call recorded while ACP could not see/);
    assert.ok(existsSync(join(home, ".acp", "ledger.flush-lock")));
    // The detached flush lands shortly after.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !gw.received.some((x) => x.url === "/govern/ledger/flush")) await new Promise((r2) => setTimeout(r2, 100));
    assert.ok(gw.received.some((x) => x.url === "/govern/ledger/flush"), "flush reached the gateway");
  } finally {
    gw.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
