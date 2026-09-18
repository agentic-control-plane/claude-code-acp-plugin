// Cost from the hook, no proxy required (gatewaystack-connect#932).
//
// Run with: node --test test/transcript-model-usage.test.mjs
//
// Every Claude Code hook payload carries transcript_path, and the session
// JSONL behind it records each model turn's usage. PostToolUse reads the
// turns that arrived since the last report and sends them as `model_usage`
// on the /govern/tool-output call it already makes. The gateway side
// (sanitizeModelUsage / recordTranscriptUsage) has been live since
// 2026-09-02 and had never received the field from a shipped client.
//
// Spawn the real hook against a stub gateway and assert on the body it
// sends. Invariants:
//   1. Well-formed assistant turns are sent: id, model, four integer token
//      counts, ts — the shape transcriptUsage.ts validates.
//   2. Lines with no usage, non-assistant lines, malformed JSON, and turns
//      with no id/model are skipped; same-id repeats collapse to the last.
//   3. No transcript_path → no model_usage key at all (never an empty
//      array); a missing / unreadable / empty transcript likewise.
//   4. The per-transcript offset advances: a second PostToolUse sends only
//      the turns appended since the first; nothing new → key absent.
//   5. A partial trailing line waits for the next call.
//   6. At most 50 turns per call.
//   7. Fail-open: a directory or non-UTF-8 bytes where the transcript
//      should be never changes the PostToolUse outcome, and PreToolUse is
//      untouched.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
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
let seen = [];

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "acp-transcript-usage-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  writeFileSync(join(HOME, ".acp", "credentials"), "gsk_test_deadbeef\n");
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* keep null */ }
      seen.push({ url: req.url, body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/govern/tool-use" ? { decision: "allow" } : { action: "pass" }));
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
  rmSync(join(HOME, ".acp", "transcript-offsets.json"), { force: true });
});

// Explicit env (never spread process.env): the runner's own CI=true would
// flip the tier to background.
function runHook(input, extraEnv) {
  return new Promise((resolve, reject) => {
    // ACP_KEY: a session started by claude-acp. Keeps the once-per-session
    // plain-launch notice (unpriced-session-notice.test.mjs) out of these
    // assertions, which are about the PostToolUse body alone.
    const child = spawn(process.execPath, [GOVERN], {
      env: { HOME, PATH: process.env.PATH, ACP_GOVERN_BASE: baseUrl, CLAUDE_CODE_ENTRYPOINT: "cli", ACP_KEY: "gsk_test_deadbeef", ...(extraEnv || {}) },
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

const post = (session_id, transcript_path) => ({
  hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls -la" },
  tool_response: "total 0", session_id, tool_use_id: "call-1", cwd: "/tmp",
  ...(transcript_path === undefined ? {} : { transcript_path }),
});

let n = 0;
function transcriptPath() { return join(HOME, `transcript-${++n}.jsonl`); }

// One assistant turn as Claude Code writes it (shape checked against a real
// ~/.claude/projects/*/*.jsonl line, 2026-09-16).
function assistantLine(id, usage, extra = {}) {
  return JSON.stringify({
    parentUuid: "p", isSidechain: false, type: "assistant", uuid: `uuid-${id}`,
    timestamp: "2026-09-16T21:00:00.000Z", requestId: `req_${id}`,
    message: { model: "claude-fable-5", id, type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage },
    ...extra,
  }) + "\n";
}
const usage = (i, cr, cc, o) => ({ input_tokens: i, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: o, service_tier: "standard" });

function lastToolOutput() {
  const hits = seen.filter((s) => s.url === "/govern/tool-output");
  assert.ok(hits.length, "expected a /govern/tool-output call");
  return hits.at(-1).body;
}

test("well-formed assistant turns are sent as model_usage in the gateway's shape", async () => {
  const path = transcriptPath();
  writeFileSync(path,
    JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }) + "\n" +
    assistantLine("msg_A", usage(3991, 6, 15662, 120)) +
    assistantLine("msg_B", usage(10, 20, 30, 40)));
  const r = await runHook(post("sess-usage-1", path));
  assert.equal(r.code, 0);
  const body = lastToolOutput();
  assert.deepEqual(body.model_usage, [
    { id: "msg_A", model: "claude-fable-5", input_tokens: 3991, cache_read_input_tokens: 6, cache_creation_input_tokens: 15662, output_tokens: 120, ts: "2026-09-16T21:00:00.000Z" },
    { id: "msg_B", model: "claude-fable-5", input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 40, ts: "2026-09-16T21:00:00.000Z" },
  ]);
  // The rest of the body is what it always was.
  assert.equal(body.hook_event_name, "PostToolUse");
  assert.equal(body.session_id, "sess-usage-1");
  assert.equal(body.tool_output, "total 0");
});

test("missing counts default to 0; the entry is still sent when any count is non-zero", async () => {
  const path = transcriptPath();
  writeFileSync(path, assistantLine("msg_C", { output_tokens: 7 }));
  await runHook(post("sess-usage-2", path));
  assert.deepEqual(lastToolOutput().model_usage, [
    { id: "msg_C", model: "claude-fable-5", input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 7, ts: "2026-09-16T21:00:00.000Z" },
  ]);
});

test("malformed lines, non-assistant lines and turns without id/model are skipped; same-id repeats keep the last", async () => {
  const path = transcriptPath();
  writeFileSync(path,
    "not json at all {{{\n" +
    JSON.stringify({ type: "user", message: { role: "user", content: "x", usage: { input_tokens: 999 } } }) + "\n" +
    JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { output_tokens: 5 } } }) + "\n" + // no id anywhere, no model
    JSON.stringify({ type: "assistant", uuid: "u1", message: { role: "assistant", usage: { output_tokens: 5 } } }) + "\n" + // no model
    JSON.stringify({ type: "assistant", message: { id: "msg_nousage", model: "claude-fable-5", role: "assistant" } }) + "\n" +
    assistantLine("msg_D", usage(1, 0, 0, 1)) +
    assistantLine("msg_D", usage(1, 0, 0, 250)) + // streamed chunk repeat: fullest wins
    "\n");
  await runHook(post("sess-usage-3", path));
  assert.deepEqual(lastToolOutput().model_usage, [
    { id: "msg_D", model: "claude-fable-5", input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 250, ts: "2026-09-16T21:00:00.000Z" },
  ]);
});

test("id falls back to requestId, then uuid, when message.id is absent", async () => {
  const path = transcriptPath();
  writeFileSync(path,
    JSON.stringify({ type: "assistant", requestId: "req_only", uuid: "uuid-1", message: { model: "claude-fable-5", role: "assistant", stop_reason: "end_turn", usage: { output_tokens: 3 } } }) + "\n" +
    JSON.stringify({ type: "assistant", uuid: "uuid-2", message: { model: "claude-fable-5", role: "assistant", stop_reason: "end_turn", usage: { output_tokens: 4 } } }) + "\n");
  await runHook(post("sess-usage-4", path));
  assert.deepEqual(lastToolOutput().model_usage.map((t) => t.id), ["req_only", "uuid-2"]);
});

test("no transcript_path → no model_usage key (never an empty array)", async () => {
  await runHook(post("sess-usage-5"));
  const body = lastToolOutput();
  assert.ok(!("model_usage" in body), `unexpected model_usage: ${JSON.stringify(body.model_usage)}`);
});

test("transcript missing, empty, or only user lines → key absent", async () => {
  await runHook(post("sess-usage-6", join(HOME, "does-not-exist.jsonl")));
  assert.ok(!("model_usage" in lastToolOutput()));
  seen = [];
  const empty = transcriptPath();
  writeFileSync(empty, "");
  await runHook(post("sess-usage-6", empty));
  assert.ok(!("model_usage" in lastToolOutput()));
  seen = [];
  const users = transcriptPath();
  writeFileSync(users, JSON.stringify({ type: "user", message: { role: "user", content: "x" } }) + "\n");
  await runHook(post("sess-usage-6", users));
  assert.ok(!("model_usage" in lastToolOutput()));
});

test("offset advances: the second call sends only what was appended; nothing new → key absent", async () => {
  const path = transcriptPath();
  writeFileSync(path, assistantLine("msg_E", usage(1, 0, 0, 1)));
  await runHook(post("sess-usage-7", path));
  assert.deepEqual(lastToolOutput().model_usage.map((t) => t.id), ["msg_E"]);
  const offsets = JSON.parse(readFileSync(join(HOME, ".acp", "transcript-offsets.json"), "utf8"));
  assert.equal(offsets[path], Buffer.byteLength(assistantLine("msg_E", usage(1, 0, 0, 1))));

  seen = [];
  await runHook(post("sess-usage-7", path));
  assert.ok(!("model_usage" in lastToolOutput()), "nothing appended → nothing reported");

  seen = [];
  appendFileSync(path, assistantLine("msg_F", usage(2, 0, 0, 2)));
  await runHook(post("sess-usage-7", path));
  assert.deepEqual(lastToolOutput().model_usage.map((t) => t.id), ["msg_F"]);
});

test("a partial trailing line waits for the next call", async () => {
  const path = transcriptPath();
  const full = assistantLine("msg_G", usage(1, 0, 0, 1));
  const partial = assistantLine("msg_H", usage(1, 0, 0, 1)).slice(0, -20); // no newline, torn JSON
  writeFileSync(path, full + partial);
  await runHook(post("sess-usage-8", path));
  assert.deepEqual(lastToolOutput().model_usage.map((t) => t.id), ["msg_G"]);

  seen = [];
  appendFileSync(path, assistantLine("msg_H", usage(1, 0, 0, 1)).slice(-20));
  await runHook(post("sess-usage-8", path));
  assert.deepEqual(lastToolOutput().model_usage.map((t) => t.id), ["msg_H"]);
});

test("at most 50 turns per call, the newest kept", async () => {
  const path = transcriptPath();
  let s = "";
  for (let i = 0; i < 60; i++) s += assistantLine(`msg_${String(i).padStart(2, "0")}`, usage(1, 0, 0, 1));
  writeFileSync(path, s);
  await runHook(post("sess-usage-9", path));
  const ids = lastToolOutput().model_usage.map((t) => t.id);
  assert.equal(ids.length, 50);
  assert.equal(ids[0], "msg_10");
  assert.equal(ids.at(-1), "msg_59");
});

test("a corrupt offsets file is ignored, not fatal", async () => {
  writeFileSync(join(HOME, ".acp", "transcript-offsets.json"), "{not-json");
  const path = transcriptPath();
  writeFileSync(path, assistantLine("msg_I", usage(1, 0, 0, 1)));
  const r = await runHook(post("sess-usage-10", path));
  assert.equal(r.code, 0);
  assert.deepEqual(lastToolOutput().model_usage.map((t) => t.id), ["msg_I"]);
});

test("fail-open: a directory or non-UTF-8 bytes at transcript_path never changes the PostToolUse outcome", async () => {
  const dir = join(HOME, "a-directory");
  mkdirSync(dir, { recursive: true });
  let r = await runHook(post("sess-usage-11", dir));
  assert.equal(r.code, 0);
  assert.equal(r.json, null, "a pass verdict prints nothing, as before");
  assert.ok(!("model_usage" in lastToolOutput()));

  seen = [];
  const bin = transcriptPath();
  writeFileSync(bin, Buffer.from([0xff, 0xfe, 0x00, 0x22, 0x75, 0x73, 0x61, 0x67, 0x65, 0x22, 0x0a]));
  r = await runHook(post("sess-usage-11", bin));
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
  assert.ok(!("model_usage" in lastToolOutput()));
});

test("PreToolUse is untouched: transcript_path on the payload adds nothing to /govern/tool-use", async () => {
  const path = transcriptPath();
  writeFileSync(path, assistantLine("msg_J", usage(1, 0, 0, 1)));
  const r = await runHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, session_id: "sess-usage-12", transcript_path: path });
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
  const pre = seen.find((s) => s.url === "/govern/tool-use");
  assert.ok(pre);
  assert.ok(!("model_usage" in pre.body));
});

// ---------------------------------------------------------------------
// A turn is reported only once its FINAL record lands.
//
// Claude Code appends one record per content block as a turn streams.
// cache_read/cache_creation are identical on every record, but
// output_tokens is a placeholder until the last one, which is also the
// only record carrying a terminal stop_reason. PostToolUse fires between
// those records, so without this a turn's partial record is sent first,
// and the gateway's first-wins dedupe bills the placeholder forever.
// ---------------------------------------------------------------------

/** A mid-stream record: real cache counts, placeholder output, no stop_reason. */
function partialLine(id, cacheRead, outSoFar) {
  return JSON.stringify({
    parentUuid: "p", isSidechain: false, type: "assistant", uuid: `uuid-${id}-partial-${outSoFar}`,
    timestamp: "2026-09-16T21:00:00.000Z", requestId: `req_${id}`,
    message: {
      model: "claude-fable-5", id, type: "message", role: "assistant",
      content: [{ type: "tool_use" }], stop_reason: null,
      usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: outSoFar },
    },
  }) + "\n";
}

test("a turn still streaming is withheld, then billed at its real total once complete", async () => {
  const path = transcriptPath();
  // Window 1: only partial records for msg_S — exactly what the hook sees
  // when it fires between a turn's tool calls.
  writeFileSync(path, partialLine("msg_S", 126148, 3) + partialLine("msg_S", 126148, 3));
  await runHook(post("sess-partial", path));
  assert.ok(!("model_usage" in lastToolOutput()),
    "a turn with no terminal stop_reason must not be reported");

  // Window 2: the final record arrives carrying the true output total.
  appendFileSync(path, assistantLine("msg_S", usage(2, 126148, 0, 10904)));
  await runHook(post("sess-partial", path));
  const sent = lastToolOutput().model_usage;
  assert.deepEqual(sent, [
    { id: "msg_S", model: "claude-fable-5", input_tokens: 2, cache_read_input_tokens: 126148,
      cache_creation_input_tokens: 0, output_tokens: 10904, ts: "2026-09-16T21:00:00.000Z" },
  ], "the completed turn must bill 10904 output tokens, not the 3-token placeholder");
});

test("an incomplete turn does not block the completed turns before it", async () => {
  const path = transcriptPath();
  writeFileSync(path, assistantLine("msg_done", usage(1, 10, 0, 500)) + partialLine("msg_live", 99, 2));
  await runHook(post("sess-mixed", path));
  assert.deepEqual(lastToolOutput().model_usage.map((t) => t.id), ["msg_done"]);
});

test("model calls routed through the ACP proxy are never reported from the transcript", async () => {
  const path = transcriptPath();
  writeFileSync(path, assistantLine("msg_P", usage(1, 2, 3, 400)));
  // What claude-acp sets. The proxy already priced this call exactly; pricing
  // it again from the transcript bills the same call twice.
  await runHook(post("sess-proxied", path), { ANTHROPIC_BASE_URL: "https://api.agenticcontrolplane.com/anthropic" });
  assert.ok(!("model_usage" in lastToolOutput()),
    "a proxied session must not also report transcript usage");
});

test("a plain session still reports, so the proxy check is not just disabling the feature", async () => {
  const path = transcriptPath();
  writeFileSync(path, assistantLine("msg_Q", usage(1, 2, 3, 400)));
  await runHook(post("sess-plain-2", path), { ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
  assert.deepEqual(lastToolOutput().model_usage.map((t) => t.id), ["msg_Q"]);
});
