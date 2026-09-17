// Pins the /govern/attest wire contract (#403). If a field name here
// drifts from the gateway's expectations, attestation silently degrades
// to "unattested" for every session — these tests are the tripwire.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, normalizeEol, sha256FileHex, buildAttestationPayload } from "../lib/attestation.mjs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOVERN = join(ROOT, "bin", "govern.mjs");
// Built from parts, not written as a literal: the literal gets
// PII-redacted into an invalid host on the way to disk (same reason as in
// 429-is-a-verdict.test.mjs).
const LOOPBACK = [127, 0, 0, 1].join(".");

test("sha256Hex is deterministic and 64 hex chars", () => {
  const a = sha256Hex("hello");
  assert.equal(a, sha256Hex("hello"));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, sha256Hex("hello "));
});

// A CRLF checkout of the hook (Git for Windows, core.autocrlf=true) must
// hash exactly like the LF release. 2026-09-17: two Windows installs of
// 0.21.0 on the same day reported different hashes for the same
// unmodified file; the second was flagged hash_mismatch and the founder
// was paged for an edit that never happened.
test("normalizeEol: CRLF and LF copies of the same text hash identically", () => {
  const lf = Buffer.from("a\nb\n\n— utf-8 — ✓\n", "utf8");
  const crlf = Buffer.from(lf.toString("latin1").replace(/\n/g, "\r\n"), "latin1");
  assert.notEqual(sha256Hex(lf), sha256Hex(crlf), "fixture must actually differ before normalizing");
  assert.equal(sha256Hex(normalizeEol(crlf)), sha256Hex(lf));
});

test("normalizeEol: an LF file is returned byte-identical (hashes are unchanged for every existing install)", () => {
  const lf = readFileSync(GOVERN);
  assert.ok(!lf.includes(13), "bin/govern.mjs must be committed with LF endings (see .gitattributes)");
  assert.equal(sha256Hex(normalizeEol(lf)), sha256Hex(lf));
  // A lone CR is content, not a line-ending artifact — keep it.
  const loneCr = Buffer.from("x\ry\n");
  assert.equal(sha256Hex(normalizeEol(loneCr)), sha256Hex(loneCr));
});

test("the running hook reports the LF hash even when its file on disk is CRLF", async () => {
  // Stub gateway that records the attest body.
  const bodies = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.url.endsWith("/govern/attest")) { try { bodies.push(JSON.parse(raw)); } catch { bodies.push(null); } }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, verdict: "attested" }));
    });
  });
  await new Promise((r) => server.listen(0, LOOPBACK, r));
  const base = `http://${LOOPBACK}:${server.address().port}`;
  const home = mkdtempSync(join(tmpdir(), "acp-crlf-test-"));
  mkdirSync(join(home, ".acp"), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "acp-crlf-hook-"));
  try {
    const lf = readFileSync(GOVERN);
    const crlf = Buffer.from(lf.toString("latin1").replace(/\n/g, "\r\n"), "latin1");
    const crlfPath = join(dir, "govern.mjs");
    writeFileSync(crlfPath, crlf);
    assert.notEqual(sha256Hex(crlf), sha256Hex(lf));
    // Async spawn: the stub gateway lives in this process, so a spawnSync
    // would block the event loop and the hook's request would never be
    // accepted (it aborts on its own 4s budget and the test sees nothing).
    const res = await new Promise((resolve) => {
      const child = spawn(process.execPath, [crlfPath], {
        env: { HOME: home, PATH: process.env.PATH, ACP_GOVERN_BASE: base, ACP_API_BASE: base, ACP_BEARER_TOKEN: "gsk_test_token" },
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(JSON.stringify({ session_id: "crlf-test", cwd: dir, hook_event_name: "SessionStart" }));
    });
    assert.equal(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
    const attest = bodies.find((b) => b && b.hook_event_name === "SessionStart");
    assert.ok(attest, `no attest body captured; bodies=${JSON.stringify(bodies)} stderr=${res.stderr}`);
    assert.equal(attest.hook_hash, sha256Hex(lf), "CRLF checkout must report the LF release hash");
    assert.equal(attest.hook_hash, sha256FileHex(crlfPath), "lib copy and inline copy must agree");
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("payload carries the pairing invariant fields", () => {
  const p = buildAttestationPayload({
    sessionId: "s1",
    cwd: "/work",
    pluginVersion: "0.9.0",
    hookHash: "a".repeat(64),
    grantsHash: "b".repeat(64),
    harness: "claude-code",
  });
  assert.equal(p.session_id, "s1");
  assert.equal(p.hook_event_name, "SessionStart");
  assert.equal(p.plugin_version, "0.9.0");
  assert.equal(p.hook_hash, "a".repeat(64));
  assert.equal(p.grants_present, true);
  assert.equal(p.grants_hash, "b".repeat(64));
  assert.equal(p.harness, "claude-code");
});

test("no grants file → grants_present false, no grants_hash key", () => {
  const p = buildAttestationPayload({
    sessionId: "s1",
    cwd: "/work",
    pluginVersion: "0.9.0",
    hookHash: "a".repeat(64),
    grantsHash: null,
    harness: "claude-code",
  });
  assert.equal(p.grants_present, false);
  assert.equal("grants_hash" in p, false);
});

test("an attestation without a hook hash is no attestation at all", () => {
  assert.equal(
    buildAttestationPayload({ sessionId: "s1", pluginVersion: "0.9.0", hookHash: null }),
    null,
  );
});

import { attestNoticeOutput } from "../lib/attestation.mjs";

test("upgrade notice from the attest response becomes SessionStart additionalContext", () => {
  const out = attestNoticeOutput({ ok: true, verdict: "attested", notice: "  [ACP] v0.13.0 available  " });
  assert.deepEqual(out, {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "[ACP] v0.13.0 available" },
  });
});

test("no notice, empty notice, or malformed response → no stdout object", () => {
  assert.equal(attestNoticeOutput({ ok: true, verdict: "attested" }), null);
  assert.equal(attestNoticeOutput({ notice: "   " }), null);
  assert.equal(attestNoticeOutput({ notice: 42 }), null);
  assert.equal(attestNoticeOutput(null), null);
  assert.equal(attestNoticeOutput(undefined), null);
});
