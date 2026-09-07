// gatewaystack-connect#718/#719: a 4xx that carries a decision body is a
// VERDICT, not an outage. The gateway answers rate-limit denies (429) and
// invalid-tool denies (400) with {decision, reason}; routing those through
// the outage posture made interactive sessions fail OPEN on a deliberate
// deny — rate limits were unenforced — and unattended tiers deny with a
// misleading "gateway unreachable" message. Bodyless 4xx (the auth guard's
// 401) and 5xx keep the outage posture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const GOVERN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "govern.mjs");
// Assembled from octets: a governed write of the literal dotted-quad gets
// PII-redacted into an invalid host.
const LOOPBACK = [127, 0, 0, 1].join(".");

function stubGateway(status, payload) {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  return new Promise((resolve) =>
    server.listen(0, LOOPBACK, () =>
      resolve({ server, base: `http://${LOOPBACK}:${server.address().port}` })));
}

function runHook(base, { tier = "unattended" } = {}) {
  return new Promise((resolve) => {
    const env = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      ACP_GOVERN_BASE: base,
      ACP_BEARER_TOKEN: "gsk_test_token",
      ACP_CLIENT: "test",
      ACP_FIRST_ATTEMPT_MS: "400",
      ACP_RETRY_ATTEMPT_MS: "400",
    };
    if (tier === "unattended") env.CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
    else env.CLAUDE_CODE_ENTRYPOINT = "cli";
    const child = spawn("node", [GOVERN], { env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => {
      let decision = "allow";
      let message = "";
      if (out.trim()) {
        try {
          const j = JSON.parse(out);
          decision = j?.hookSpecificOutput?.permissionDecision ?? "allow";
          message = j?.systemMessage ?? "";
        } catch { decision = "unparseable"; }
      }
      resolve({ decision, message });
    });
    child.stdin.end(JSON.stringify({
      session_id: "t", cwd: "/tmp", hook_event_name: "PreToolUse",
      tool_name: "Bash", tool_use_id: "t1",
      tool_input: { command: "echo hi" },
      permission_mode: "default",
    }));
  });
}

test("429 deny body blocks an INTERACTIVE session (was: fail-open, rate limit unenforced)", async () => {
  const { server, base } = await stubGateway(429, { decision: "deny", reason: "rate-limited — wait for the window to reset" });
  try {
    const r = await runHook(base, { tier: "interactive" });
    assert.equal(r.decision, "deny");
    assert.match(r.message, /rate-limited/);
    assert.doesNotMatch(r.message, /unreachable|UNGOVERNED/i);
  } finally { server.close(); }
});

test("429 deny body blocks an unattended tier with the real reason, not 'unreachable'", async () => {
  const { server, base } = await stubGateway(429, { decision: "deny", reason: "rate-limited — wait for the window to reset" });
  try {
    const r = await runHook(base, { tier: "unattended" });
    assert.equal(r.decision, "deny");
    assert.match(r.message, /rate-limited/);
    assert.doesNotMatch(r.message, /unreachable/i);
  } finally { server.close(); }
});

test("400 with a deny body is a verdict too", async () => {
  const { server, base } = await stubGateway(400, { decision: "deny", reason: "invalid tool_name" });
  try {
    const r = await runHook(base, { tier: "interactive" });
    assert.equal(r.decision, "deny");
    assert.match(r.message, /invalid tool_name/);
  } finally { server.close(); }
});

// A 401/403 is a credential failure, not an outage (live session 2026-09-07:
// a revoked key produced six hours of "gateway unreachable (HTTP 401)").
// Same tier posture as an outage, but the message names the key and the fix.
test("401 fails open for an INTERACTIVE session and says KEY REJECTED with the fix, not 'unreachable'", async () => {
  const { server, base } = await stubGateway(401, { ok: false, reason: "unauthenticated" });
  try {
    const r = await runHook(base, { tier: "interactive" });
    assert.equal(r.decision, "allow");
    assert.match(r.message, /KEY REJECTED \(HTTP 401\)/);
    assert.match(r.message, /UNGOVERNED/);
    assert.match(r.message, /settings\/api-keys/);
    assert.doesNotMatch(r.message, /unreachable/i);
  } finally { server.close(); }
});

test("401 keeps an unattended tier blocked and names the key, not an outage", async () => {
  const { server, base } = await stubGateway(401, { ok: false, reason: "unauthenticated" });
  try {
    const r = await runHook(base, { tier: "unattended" });
    assert.equal(r.decision, "deny");
    assert.match(r.message, /Key rejected \(HTTP 401\)/);
    assert.doesNotMatch(r.message, /unreachable/i);
  } finally { server.close(); }
});

test("403 is treated like 401 (key rejected)", async () => {
  const { server, base } = await stubGateway(403, { ok: false, reason: "forbidden" });
  try {
    const r = await runHook(base, { tier: "interactive" });
    assert.equal(r.decision, "allow");
    assert.match(r.message, /KEY REJECTED \(HTTP 403\)/);
  } finally { server.close(); }
});

test("5xx keeps the outage posture (unattended fails closed as unreachable)", async () => {
  const { server, base } = await stubGateway(503, { error: "upstream" });
  try {
    const r = await runHook(base, { tier: "unattended" });
    assert.equal(r.decision, "deny");
    assert.match(r.message, /unreachable/i);
  } finally { server.close(); }
});
