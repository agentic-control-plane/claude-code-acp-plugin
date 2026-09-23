// Shared ACP plugin conformance corpus (davidcrowe/gatewaystack-connect#1344).
//
// One capability table runs against every ACP harness plugin through a thin
// adapter that drives the plugin's REAL entry point (bin/govern.mjs) against
// a fake gateway, and asserts on what the person would see or on what the
// plugin actually sent. Unit tests stayed green while four plugins dropped
// every gateway notice (#1334); this is the seam test that would have
// caught it here too.
//
// Run with: node --test test/conformance.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOVERN = join(ROOT, "bin", "govern.mjs");
const CORPUS_PATH = join(ROOT, "test", "fixtures", "plugin-corpus.json");
const PLUGIN = "claude-code-acp-plugin";
const PINNED_FINGERPRINT = "aa186d3fb3e7d18c";

// Cases this surface is known to fail today. A case listed here is expected
// to FAIL: the test for it asserts that failure, so a real fix turns CI red
// until the entry is removed (and a regression elsewhere is never silently
// forgotten either). Empty here: on origin/main this plugin's own hook
// (bin/govern.mjs) forwards notices and post-tool fields correctly — the
// known #1334 notice-drop and #1344 post-tool gaps are OTHER plugins
// (codex, opencode, hermes, fx), not this one.
const EXPECTED_DIVERGENCES = [];

function divergence(id) {
  return EXPECTED_DIVERGENCES.find((d) => d.case === id);
}

// ---- corpus load + fingerprint pin -----------------------------------

const rawCorpus = readFileSync(CORPUS_PATH);
const fingerprint = createHash("sha256").update(rawCorpus).digest("hex").slice(0, 16);

test("vendored corpus matches the pinned fingerprint", () => {
  assert.equal(
    fingerprint,
    PINNED_FINGERPRINT,
    "test/fixtures/plugin-corpus.json has drifted from the canonical corpus; " +
      "re-vendor from davidcrowe/gatewaystack-connect conformance/plugin-corpus.json",
  );
});

const corpus = JSON.parse(rawCorpus.toString("utf8"));
const MARKER = corpus.marker;
assert.equal(MARKER, "ACPCONF7F3A", "corpus marker changed; update this adapter");

const myRows = corpus.harnesses.filter((h) => h.plugin === PLUGIN);

test("corpus declares rows for this plugin", () => {
  assert.ok(myRows.length >= 2, `expected notice + post-tool rows for ${PLUGIN}`);
});

for (const row of myRows) {
  if (row.status === "not-possible") {
    test(`[${row.capability}] not-possible: reason recorded`, () => {
      assert.ok(row.reason && row.reason.length > 0, "not-possible row must carry a reason");
    });
  }
}

// ---- fake gateway ------------------------------------------------------
// http server on 12*****.1 port 0. /govern/tool-output replies with
// case.gatewayReply; everything else replies {"decision":"allow"}. Every
// request is recorded (method, path, parsed JSON body) for assertion.

// Built from octets rather than a literal dotted-quad string (some
// environments mask a literal loopback-looking string on the way through a
// tool call, which would otherwise corrupt this into an unresolvable host).
const LOOPBACK = ["127", "0", "0", "1"].join(".");

let server;
let baseUrl;
let HOME;
let requests;
let nextToolOutputReply = { action: "pass" };

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "acp-conformance-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  // Dummy workspace token so govern.mjs takes the cloud path, never LOCAL.
  writeFileSync(join(HOME, ".acp", "credentials"), "gsk_conformance_dummy_deadbeef\n");

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let parsed;
      try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = body; }
      requests.push({ method: req.method, path: req.url, body: parsed });
      res.setHeader("content-type", "application/json");
      if (req.url === "/govern/tool-output") {
        res.end(JSON.stringify(nextToolOutputReply));
      } else {
        res.end(JSON.stringify({ decision: "allow" }));
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

// Spawns the REAL PostToolUse hook the way Claude Code drives it: JSON on
// stdin, a {systemMessage} object (if any) on stdout. HOME is isolated per
// `before`; env.ACP_SHADOW (or its absence) is exactly what the case asks
// for — any inherited ACP_SHADOW from the developer's own shell is cleared.
function runPostToolUse(input, env = {}) {
  requests = [];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: {
        HOME,
        PATH: process.env.PATH,
        ACP_GOVERN_BASE: baseUrl,
        ACP_SHADOW: undefined,
        ...env,
      },
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
        resolve({ stdout, stderr, requests: requests.slice() });
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

// The native Claude Code PostToolUse payload for a shell command.
function nativePostToolInput({ command, output, sessionId }) {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: output,
    session_id: sessionId,
    tool_use_id: "conformance-call-1",
    cwd: ROOT,
  };
}

// ---- notice capability ---------------------------------------------------
// personSees channel for this harness: stdout systemMessage JSON (the only
// person-visible channel bin/govern.mjs writes to for a notice).

for (const c of corpus.cases.filter((c) => c.capability === "notice")) {
  const row = myRows.find((r) => r.capability === "notice");
  const skipReason = row?.status === "not-possible" ? `not-possible: ${row.reason}` : undefined;
  const div = divergence(c.id);

  test(`[notice:${c.id}] stdout systemMessage`, { skip: skipReason }, async () => {
    nextToolOutputReply = c.gatewayReply;
    const { stdout } = await runPostToolUse(
      nativePostToolInput({ command: `echo ${MARKER}`, output: `${MARKER}\n`, sessionId: "acpconf-session-0001" }),
      c.env,
    );
    const seen = stdout.includes(c.expect.contains) && (() => {
      try { return typeof JSON.parse(stdout).systemMessage === "string" && JSON.parse(stdout).systemMessage.includes(c.expect.contains); }
      catch { return false; }
    })();

    if (div) {
      assert.notEqual(seen, c.expect.personSees, `expected divergence (${div.issue}) still holds for ${c.id}; remove the EXPECTED_DIVERGENCES entry`);
      return;
    }
    assert.equal(seen, c.expect.personSees, `stdout systemMessage: ${JSON.stringify(stdout)}`);
  });
}

// ---- post-tool capability -------------------------------------------------

for (const c of corpus.cases.filter((c) => c.capability === "post-tool")) {
  const row = myRows.find((r) => r.capability === "post-tool");
  const skipReason = row?.status === "not-possible" ? `not-possible: ${row.reason}` : undefined;
  const div = divergence(c.id);

  test(`[post-tool:${c.id}] POST /govern/tool-output body`, { skip: skipReason }, async () => {
    nextToolOutputReply = c.gatewayReply;
    const call = c.call;
    // Canonical mapping declared here: this harness's native tool name for
    // a shell command is "Bash" (its own built-in tool), not "shell".
    const NATIVE_TOOL_NAME = "Bash";
    const { requests: reqs } = await runPostToolUse(
      nativePostToolInput({ command: call.command, output: call.output, sessionId: call.sessionId }),
      c.env,
    );

    const check = () => {
      const posted = reqs.find((r) => r.method === "POST" && r.path === "/govern/tool-output");
      assert.ok(posted, "expected a POST /govern/tool-output request");
      const b = posted.body;
      assert.equal(b.hook_event_name, "PostToolUse");
      assert.equal(b.tool_name, NATIVE_TOOL_NAME, "tool_name should equal the native tool name fed in");
      assert.ok(JSON.stringify(b.tool_input).includes(MARKER), "tool_input should contain the marker");
      assert.ok(JSON.stringify(b.tool_output).includes(MARKER), "tool_output should contain the marker");
      assert.ok(typeof b.session_id === "string" && b.session_id.length > 0, "session_id should be a non-empty string");
    };

    if (div) {
      assert.throws(check, `expected divergence (${div.issue}) still holds for ${c.id}; remove the EXPECTED_DIVERGENCES entry`);
      return;
    }
    check();
  });
}

// ---- the divergence list itself is exactly what's recorded ---------------

test("EXPECTED_DIVERGENCES matches what this adapter actually records", () => {
  // On origin/main, claude-code-acp-plugin has no recorded divergences: it
  // forwards tool_name/tool_input/tool_output/session_id and prints the
  // gateway's notice verbatim. If this ever needs an entry, add it above
  // AND update this count in the same change.
  assert.equal(EXPECTED_DIVERGENCES.length, 0);
});
