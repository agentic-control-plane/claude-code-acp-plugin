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
// Since #50 the hook ignores ACP_GOVERN_BASE unless the origin is an ACP host;
// the loopback stub is reached via ~/.acp/dev_base_override, which this shim
// writes into the temp HOME when ACP_TEST_DEV_BASE=1 is in the spawn env.
import "./_dev-base.mjs";

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

function fakeGateway(attestBody, attestHeaders = {}, attestStatus = 200) {
  return new Promise((resolve) => {
    const received = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        received.push({ url: req.url, body: raw });
        res.writeHead(req.url === "/govern/attest" ? attestStatus : 200, { "content-type": "application/json", ...(req.url === "/govern/attest" ? attestHeaders : {}) });
        res.end(JSON.stringify(req.url === "/govern/attest" ? attestBody : { ok: true, accepted: 1 }));
      });
    });
    server.listen(0, LOOPBACK, () => resolve({ server, received, port: server.address().port }));
  });
}

function sessionStart(home, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: { PATH: process.env.PATH, HOME: home, ACP_TEST_DEV_BASE: "1", ACP_GOVERN_BASE: `http://${LOOPBACK}:${port}`, CLAUDE_CODE_ENTRYPOINT: "cli" },
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
    // gsc#1699 ws2 item 4: the stale-hook line names a command the HUMAN
    // runs, so it is on the human channel, not the model's.
    assert.doesNotMatch(context, /newer ACP hook|acp-update/, "stale-hook line is not the model's to act on");
    assert.match(out.systemMessage, /A newer ACP hook is available \(v99\.0\.0; this is v\d+\.\d+\.\d+\)\. Update: /, "stale-hook line reaches the human");
    assert.match(out.systemMessage, /1 tool call recorded while ACP could not see/, "ledger-upload notice reaches the human");
    assert.match(out.systemMessage, /Turn it on: \/acp-enforce/, "daily offer reaches the human");
    assert.match(out.systemMessage, /^.*\n\[ACP\] recording · always blocked: rm -rf ~, disk wipes · \/acp-status for your mode and rules\n/m, "state line reaches the human, after the ledger line");
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

// gsc#1699 ws2 item 3: one state line per session, in the copy-contract
// short form, saying only what is true for this tenant. Today's gateway
// sends no mode or floor stage on /govern/attest, so the hook says what
// every tenant has in every mode and points at /acp-status for the rest.
const STATE_UNKNOWN = "[ACP] recording · always blocked: rm -rf ~, disk wipes · /acp-status for your mode and rules";

test("SessionStart with nothing else to say writes the one state line, and a re-fired SessionStart for the same session writes nothing", async () => {
  const home = freshHome();
  const gw = await fakeGateway({ ok: true, verdict: "attested" });
  try {
    const r = await sessionStart(home, gw.port);
    assert.equal(r.status, 0, r.stderr);
    const out = parseOne(r.stdout);
    assert.deepEqual(out, { systemMessage: STATE_UNKNOWN });
    assert.ok(!/governance|step-up|asks first/i.test(out.systemMessage), "never claims what it cannot know");
    // Resume / compaction re-fire SessionStart with the same session id.
    const again = await sessionStart(home, gw.port);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout.trim(), "");
  } finally {
    gw.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("SessionStart renders the audit form from gateway mode, adding the asks-first clause only when the gateway says the floor is live", async () => {
  const home = freshHome();
  const gw = await fakeGateway({ ok: true, verdict: "attested", mode: "audit" });
  try {
    const out = parseOne((await sessionStart(home, gw.port)).stdout);
    assert.equal(out.systemMessage, "[ACP] audit — recording · always blocked: rm -rf ~, disk wipes · /acp-enforce to apply your rules");
  } finally {
    gw.server.close();
    rmSync(home, { recursive: true, force: true });
  }
  const home2 = freshHome();
  const gw2 = await fakeGateway({ ok: true, verdict: "attested", mode: "audit", floor_asks_first: true });
  try {
    const out = parseOne((await sessionStart(home2, gw2.port)).stdout);
    assert.equal(out.systemMessage, "[ACP] audit — recording · always blocked: rm -rf ~, disk wipes · asks first: force-push, DROP, curl|sh · /acp-enforce to apply your rules");
  } finally {
    gw2.server.close();
    rmSync(home2, { recursive: true, force: true });
  }
});

test("SessionStart renders the enforce form with the rule count when the gateway sends it, and a gateway-rendered state_line wins outright", async () => {
  const home = freshHome();
  const gw = await fakeGateway({ ok: true, verdict: "attested", mode: "enforce", rules: 3 });
  try {
    const out = parseOne((await sessionStart(home, gw.port)).stdout);
    assert.equal(out.systemMessage, "[ACP] enforce — 3 rules apply · plus the safety floor · /acp-status");
  } finally {
    gw.server.close();
    rmSync(home, { recursive: true, force: true });
  }
  const home2 = freshHome();
  const gw2 = await fakeGateway({ ok: true, verdict: "attested", mode: "enforce" });
  try {
    const out = parseOne((await sessionStart(home2, gw2.port)).stdout);
    assert.equal(out.systemMessage, "[ACP] enforce — your rules apply · plus the safety floor · /acp-status");
  } finally {
    gw2.server.close();
    rmSync(home2, { recursive: true, force: true });
  }
  const home3 = freshHome();
  const gw3 = await fakeGateway({ ok: true, verdict: "attested", mode: "audit", state_line: "[ACP] audit — recording · 2 rules waiting\u0007\n· /acp-enforce\n" });
  try {
    const out = parseOne((await sessionStart(home3, gw3.port)).stdout);
    assert.equal(out.systemMessage, "[ACP] audit — recording · 2 rules waiting  · /acp-enforce", "gateway line is used verbatim, control characters and line breaks flattened");
  } finally {
    gw3.server.close();
    rmSync(home3, { recursive: true, force: true });
  }
});

// A rejected attest describes no workspace: no state line, and the session's
// marker stays unclaimed so a later successful start can still say it.
test("SessionStart on a rejected attest (401, 429, ok:false) writes no state line, and the marker is not consumed", async () => {
  for (const [status, body] of [[401, { ok: false, error: "unauthenticated" }], [429, { ok: false, error: "rate-limited" }], [200, { ok: false, error: "workspace deleted" }]]) {
    const home = freshHome();
    const gw = await fakeGateway(body, {}, status);
    try {
      const r = await sessionStart(home, gw.port);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), "", `HTTP ${status}: ${r.stdout}`);
      // The next, accepted start for the same session still gets its line.
      const ok = await fakeGateway({ ok: true, verdict: "attested" });
      try {
        const out = parseOne((await sessionStart(home, ok.port)).stdout);
        assert.equal(out.systemMessage, STATE_UNKNOWN);
      } finally { ok.server.close(); }
    } finally {
      gw.server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

// One update command for the human: the gateway's own upgrade line wins over
// the version-header line — except the below-minimum severity, which stays.
test("SessionStart shows one update line when the gateway's upgrade_notice fires, but keeps the below-minimum line", async () => {
  const UPG = "Your ACP plugin is out of date — type /acp-upgrade to update.";
  const home = freshHome();
  const gw = await fakeGateway({ ok: true, verdict: "attested", upgrade_notice: UPG }, { "X-ACP-Latest-Version": "99.0.0" });
  try {
    const out = parseOne((await sessionStart(home, gw.port)).stdout);
    assert.match(out.systemMessage, /type \/acp-upgrade/);
    assert.doesNotMatch(out.systemMessage, /newer ACP hook/);
    assert.equal(out.hookSpecificOutput, undefined);
  } finally {
    gw.server.close();
    rmSync(home, { recursive: true, force: true });
  }
  const home2 = freshHome();
  const gw2 = await fakeGateway({ ok: true, verdict: "attested", upgrade_notice: UPG }, { "X-ACP-Latest-Version": "99.0.0", "X-ACP-Min-Good-Version": "99.0.0" });
  try {
    const out = parseOne((await sessionStart(home2, gw2.port)).stdout);
    assert.match(out.systemMessage, /type \/acp-upgrade/);
    assert.match(out.systemMessage, /below the minimum v99\.0\.0 — some protections may not apply\. Update now: /);
  } finally {
    gw2.server.close();
    rmSync(home2, { recursive: true, force: true });
  }
});
