// SessionStart writes exactly ONE JSON document, however many notices
// apply (plugin#43). Claude Code parses the hook's whole stdout as one
// document; two valid objects back to back are "not valid JSON", a red
// hook error on every screen, and both notices are lost. Seen on 2.1.278
// with the ledger-upload notice (0.16.0) and the stale-plugin notice
// (0.21.0) firing in the same run.
//
// Run with: node --test test/sessionstart-single-json.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOVERN = join(ROOT, "bin", "govern.mjs");
const LOOPBACK = [127, 0, 0, 1].join(".");

const UPGRADE = "[ACP] Governance plugin claude-code-plugin v0.21.0 is outdated — v0.25.0 is current.";
const OFFER = "[ACP] Enforcement would have held 3 calls this week. Turn it on: /acp-enforce";

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), "acp-sessionstart-single-json-"));
  mkdirSync(join(home, ".acp"), { recursive: true });
  // A workspace key routes the run down the cloud path and arms the flush.
  writeFileSync(join(home, ".acp", "credentials"), "gsk_test_deadbeef\n");
  return home;
}

function fakeGateway(attestBody, attestHeaders = {}) {
  return new Promise((resolve) => {
    const received = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        received.push({ url: req.url, body: raw });
        res.writeHead(200, { "content-type": "application/json", ...(req.url === "/govern/attest" ? attestHeaders : {}) });
        res.end(JSON.stringify(req.url === "/govern/attest" ? attestBody : { ok: true, accepted: 1 }));
      });
    });
    server.listen(0, LOOPBACK, () => resolve({ server, received, port: server.address().port }));
  });
}

function sessionStart(home, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: { PATH: process.env.PATH, HOME: home, ACP_GOVERN_BASE: `http://${LOOPBACK}:${port}`, CLAUDE_CODE_ENTRYPOINT: "cli" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const killer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (status) => { clearTimeout(killer); resolve({ status, stdout, stderr }); });
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: "s-43", cwd: "/work" }));
  });
}

// The whole stdout must be ONE object: JSON.parse rejects two concatenated
// documents, which is exactly what Claude Code does.
function parseOne(stdout) {
  let out;
  assert.doesNotThrow(() => { out = JSON.parse(stdout); }, `stdout is not a single JSON document: ${stdout}`);
  assert.equal(typeof out, "object");
  assert.ok(out && !Array.isArray(out));
  assert.equal(JSON.stringify(out), stdout.trim(), "stdout carries exactly one object and nothing else");
  return out;
}

test("SessionStart with four notices at once (ledger upload, upgrade, stale hook, daily offer) writes one JSON object carrying all of them", async () => {
  const home = freshHome();
  writeFileSync(join(home, ".acp", "ledger.jsonl"), `${JSON.stringify({ id: "a".repeat(32), ts: "2026-09-21T00:00:00.000Z", tool: "Bash", decision: "allow", mode: "no-key" })}\n`);
  const gw = await fakeGateway({ ok: true, verdict: "attested", notice: UPGRADE, offer: OFFER }, { "X-ACP-Latest-Version": "99.0.0" });
  try {
    const r = await sessionStart(home, gw.port);
    assert.equal(r.status, 0, r.stderr);
    const out = parseOne(r.stdout);
    assert.equal(out.hookSpecificOutput?.hookEventName, "SessionStart");
    const context = out.hookSpecificOutput.additionalContext;
    assert.match(context, /v0\.21\.0 is outdated/, "upgrade notice reaches the model");
    assert.match(context, /governance hook v.* is outdated \(v99\.0\.0 current\)/, "stale-hook line reaches the model");
    assert.match(out.systemMessage, /1 tool call recorded while ACP could not see/, "ledger-upload notice reaches the human");
    assert.match(out.systemMessage, /Turn it on: \/acp-enforce/, "daily offer reaches the human");
    assert.ok(out.systemMessage.includes("\n"), "human notices are joined by newlines");
    assert.ok(gw.received.some((x) => x.url === "/govern/attest"), "attestation still happens");
  } finally {
    gw.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("SessionStart with only the ledger-upload notice writes one systemMessage object and no hookSpecificOutput", async () => {
  const home = freshHome();
  writeFileSync(join(home, ".acp", "ledger.jsonl"), `${JSON.stringify({ id: "b".repeat(32), ts: "2026-09-21T00:00:00.000Z", tool: "Bash", decision: "allow", mode: "no-key" })}\n`);
  const gw = await fakeGateway({ ok: true, verdict: "attested" });
  try {
    const r = await sessionStart(home, gw.port);
    assert.equal(r.status, 0, r.stderr);
    const out = parseOne(r.stdout);
    assert.match(out.systemMessage, /1 tool call recorded while ACP could not see/);
    assert.equal(out.hookSpecificOutput, undefined);
  } finally {
    gw.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("SessionStart with nothing to say writes nothing", async () => {
  const home = freshHome();
  const gw = await fakeGateway({ ok: true, verdict: "attested" });
  try {
    const r = await sessionStart(home, gw.port);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "");
  } finally {
    gw.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
