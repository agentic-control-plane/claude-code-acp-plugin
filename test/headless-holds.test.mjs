// Headless auto-resume after approval. A gateway hold
// (approval-requested:<id> / approval-pending:<id>) is ALWAYS a deny, same
// as before. Under the claude-acp launcher's -p runner (ACP_HEADLESS=1,
// Claude Code only) the hold is also appended to ~/.acp/holds/<session>.json
// so the launcher can wait for the decision and resume the session. The
// hook never returns "defer": Claude Code ignores defer when a turn has
// several tool calls, and the held call would then run.
//
// Run with: node --test test/headless-holds.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, statSync, readdirSync, chmodSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "./_dev-base.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOVERN = join(ROOT, "bin", "govern.mjs");
const LOOPBACK = [127, 0, 0, 1].join(".");
const APPROVAL_ID = "7a11c0de-0000-4000-8000-000000000000";
const OTHER_ID = "7a11c0de-0000-4000-8000-000000000001";

let HOME;
let server;
let baseUrl;
let nextToolUse;
// Per-call verdicts, keyed by tool_use_id, for the parallel-hooks test.
let byCallId = {};

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "acp-holds-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  writeFileSync(join(HOME, ".acp", "credentials"), "gsk_test_deadbeef\n");
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      let callId = null;
      try { callId = JSON.parse(body).call_id; } catch {}
      if (req.url.endsWith("/govern/tool-use")) res.end(JSON.stringify(byCallId[callId] ?? nextToolUse));
      else res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
  baseUrl = `http://${LOOPBACK}:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(HOME, { recursive: true, force: true });
});

const held = (prefix = "approval-requested", id = APPROVAL_ID) => ({
  decision: "deny",
  reason: `${prefix}:${id} — approvers notified; action blocked until approved. Once approved, retry the identical action within the grant window.`,
  kind: "delegate",
  approval_id: id,
  approval_code: id.endsWith("1") ? "7A12" : "7A11",
  approval_summary: 'Bash · git push "origin" main',
  approval_status: "pending",
});

beforeEach(() => { nextToolUse = held(); byCallId = {}; });

const HEADLESS = { ACP_HEADLESS: "1", CLAUDE_CODE_ENTRYPOINT: "sdk-cli" };

function runHook(input, env = {}, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: { HOME, PATH: process.env.PATH, ACP_TEST_DEV_BASE: "1", ACP_GOVERN_BASE: baseUrl, ACP_API_BASE: baseUrl, ...env },
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
        assert.ok(!/"defer"/.test(stdout), `hook output must never carry "defer": ${stdout}`);
        resolve(raw ? stdout : stdout.trim() ? JSON.parse(stdout) : null);
      } catch (e) { reject(e); }
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

const pre = (sid, extra = {}) => ({
  hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin main" },
  session_id: sid, tool_use_id: `toolu_${sid}`, permission_mode: "default", ...extra,
});
// One file per approval: ~/.acp/holds/<sid>/<approvalId>.json. holdPath()
// is the session directory; existence of it means "something was recorded".
const holdPath = (sid, home = HOME) => join(home, ".acp", "holds", sid);
const holdFile = (sid, id = APPROVAL_ID, home = HOME) => join(holdPath(sid, home), `${id}.json`);
const holdIds = (sid) => readdirSync(holdPath(sid)).map((f) => f.replace(/\.json$/, "")).sort();
function freshHome() {
  const h = mkdtempSync(join(tmpdir(), "acp-holds-alt-"));
  mkdirSync(join(h, ".acp"), { recursive: true });
  writeFileSync(join(h, ".acp", "credentials"), "gsk_test_deadbeef\n");
  writeFileSync(join(h, ".acp", "dev_base_override"), `${baseUrl}\n`);
  extraHomes.push(h);
  return h;
}
const extraHomes = [];
after(() => { for (const h of extraHomes) { try { chmodSync(join(h, ".acp"), 0o700); } catch {} rmSync(h, { recursive: true, force: true }); } });
const decisionOf = (out) => out?.hookSpecificOutput?.permissionDecision;
const reasonOf = (out) => out?.hookSpecificOutput?.permissionDecisionReason ?? "";

test("govern.mjs never emits a defer decision", () => {
  const src = readFileSync(GOVERN, "utf8");
  assert.ok(!/permissionDecision:\s*["']defer["']/.test(src));
  assert.ok(!/["']defer["']/.test(src), "no \"defer\" string literal in govern.mjs");
});

test("headless Claude Code run: the hold is denied as before AND recorded 0600", async () => {
  const sid = "sess-headless";
  const out = await runHook(pre(sid), HEADLESS);
  assert.equal(decisionOf(out), "deny");
  assert.match(reasonOf(out), /^\[ACP\] Denied by policy: approval-requested:7a11c0de/);
  assert.deepEqual(holdIds(sid), [APPROVAL_ID]);
  const raw = readFileSync(holdFile(sid), "utf8");
  const h = JSON.parse(raw);
  assert.equal(h.approvalId, APPROVAL_ID);
  assert.equal(h.code, "7A11");
  assert.equal(h.toolUseId, `toolu_${sid}`);
  assert.equal(h.tool, "Bash");
  assert.ok(!("what" in h), "nothing derived from tool input is recorded");
  assert.ok(!raw.includes("git push"), "no tool input in the hold file");
  assert.ok(!Number.isNaN(Date.parse(h.ts)));
  assert.equal(statSync(holdFile(sid)).mode & 0o777, 0o600);
  assert.equal(statSync(holdPath(sid)).mode & 0o777, 0o700);
  assert.equal(statSync(join(HOME, ".acp", "holds")).mode & 0o777, 0o700);
});

test("same approval held twice: one file, first write kept; a new approval adds a file", async () => {
  const sid = "sess-idempotent";
  await runHook(pre(sid), HEADLESS);
  const first = readFileSync(holdFile(sid), "utf8");
  nextToolUse = held("approval-pending");
  const again = await runHook(pre(sid, { tool_use_id: "toolu_retry" }), HEADLESS);
  assert.equal(decisionOf(again), "deny");
  assert.equal(readFileSync(holdFile(sid), "utf8"), first, "wx: the existing hold is not overwritten");
  nextToolUse = held("approval-requested", OTHER_ID);
  await runHook(pre(sid, { tool_use_id: "toolu_second" }), HEADLESS);
  assert.deepEqual(holdIds(sid), [APPROVAL_ID, OTHER_ID].sort());
  assert.equal(JSON.parse(readFileSync(holdFile(sid, OTHER_ID), "utf8")).toolUseId, "toolu_second");
});

test("two hooks in one turn, at once: both holds survive", async () => {
  const sid = "sess-parallel";
  byCallId = { toolu_a: held("approval-requested", APPROVAL_ID), toolu_b: held("approval-requested", OTHER_ID) };
  const [oa, ob] = await Promise.all([
    runHook(pre(sid, { tool_use_id: "toolu_a" }), HEADLESS),
    runHook(pre(sid, { tool_use_id: "toolu_b" }), HEADLESS),
  ]);
  assert.equal(decisionOf(oa), "deny");
  assert.equal(decisionOf(ob), "deny");
  assert.deepEqual(holdIds(sid), [APPROVAL_ID, OTHER_ID].sort());
});

test("write failures never cost the deny: dir/FIFO at the hold path, FIFO/symlink session dir, read-only ~/.acp", async () => {
  const expectDeny = async (sid, env = {}) => {
    const out = await runHook(pre(sid), { ...HEADLESS, ...env });
    assert.equal(decisionOf(out), "deny", sid);
    assert.match(reasonOf(out), /^\[ACP\] Denied by policy: approval-requested:/, sid);
  };
  // a directory where the hold file goes
  mkdirSync(holdFile("sess-fail-dir"), { recursive: true });
  await expectDeny("sess-fail-dir");
  // a FIFO where the hold file goes (would block a plain open)
  mkdirSync(holdPath("sess-fail-fifo"), { recursive: true });
  execFileSync("mkfifo", [holdFile("sess-fail-fifo")]);
  await expectDeny("sess-fail-fifo");
  // a FIFO where the session directory goes
  mkdirSync(join(HOME, ".acp", "holds"), { recursive: true });
  execFileSync("mkfifo", [holdPath("sess-fail-fifodir")]);
  await expectDeny("sess-fail-fifodir");
  // a symlinked holds dir in another HOME: refused, nothing written through it
  const h1 = freshHome();
  const elsewhere = mkdtempSync(join(tmpdir(), "acp-holds-target-"));
  extraHomes.push(elsewhere);
  symlinkSync(elsewhere, join(h1, ".acp", "holds"));
  await expectDeny("sess-fail-symlink", { HOME: h1 });
  assert.deepEqual(readdirSync(elsewhere), []);
  // read-only ~/.acp
  const h2 = freshHome();
  chmodSync(join(h2, ".acp"), 0o500);
  await expectDeny("sess-fail-ro", { HOME: h2 });
  assert.ok(!existsSync(join(h2, ".acp", "holds")));
});

test("a FIFO at the session's pending-approvals file does not block the hook", async () => {
  const h = freshHome();
  const sid = "sess-pending-fifo";
  mkdirSync(join(h, ".acp", "session-stats"), { recursive: true });
  execFileSync("mkfifo", [join(h, ".acp", "session-stats", `${sid}.pending.json`)]);
  const out = await runHook(pre(sid), { HOME: h });
  assert.equal(decisionOf(out), "deny");
});

test("interactive / no ACP_HEADLESS: identical deny, no holds file", async () => {
  for (const [sid, env] of [["sess-int", { CLAUDE_CODE_ENTRYPOINT: "cli" }], ["sess-noenv", {}], ["sess-true", { ACP_HEADLESS: "true" }]]) {
    const out = await runHook(pre(sid), env);
    assert.equal(decisionOf(out), "deny");
    assert.match(reasonOf(out), /^\[ACP\] Denied by policy: approval-requested:/);
    assert.ok(!existsSync(holdPath(sid)), sid);
  }
});

test("hook stdout is byte-identical with and without ACP_HEADLESS", async () => {
  const a = await runHook(pre("sess-cmp"), {}, { raw: true });
  const b = await runHook(pre("sess-cmp"), HEADLESS, { raw: true });
  assert.equal(b, a);
});

test("not Claude Code (Codex / Cursor): no holds file even with ACP_HEADLESS=1", async () => {
  for (const env of [{ ACP_HARNESS: "codex", ACP_CLIENT: "codex" }, { ACP_CLIENT: "cursor" }]) {
    const sid = `sess-${env.ACP_CLIENT}`;
    await runHook(pre(sid), { ...HEADLESS, ...env });
    assert.ok(!existsSync(holdPath(sid)));
  }
});

test("non-approval denies are unchanged and never recorded", async () => {
  for (const v of [
    { decision: "deny", reason: "hardline floor: rm -rf /", kind: "terminal" },
    { decision: "deny", reason: "approval-fatigue-cap: 5 approval requests in the last 600s — denied without notifying approvers" },
    { decision: "deny", reason: "approval-create-failed: firestore unavailable" },
  ]) {
    nextToolUse = v;
    const sid = `sess-plain-${v.reason.slice(0, 8).replace(/\W/g, "")}`;
    const out = await runHook(pre(sid), HEADLESS);
    assert.equal(decisionOf(out), "deny", v.reason);
    assert.ok(reasonOf(out).startsWith(`[ACP] Denied by policy: ${v.reason}`));
    assert.ok(!existsSync(holdPath(sid)));
  }
});

test("resumed call after approval: the gateway's allow passes through, nothing recorded", async () => {
  nextToolUse = { decision: "allow", reason: `pre-approved:${APPROVAL_ID}` };
  const sid = "sess-resumed-ok";
  const out = await runHook(pre(sid), HEADLESS);
  assert.notEqual(decisionOf(out), "deny");
  assert.ok(!existsSync(holdPath(sid)));
});
