// A 401 carrying `code: "workspace_deleted"` means the owner deleted the
// workspace on purpose. Live data 2026-10-24: a deleted user's machine
// repeated KEY REJECTED on 1,745+ calls over three weeks. The notice now
// names the cause and the uninstall command, once per session; the tier
// posture (interactive allows, unattended denies) does not change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import "./_dev-base.mjs";

const GOVERN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "govern.mjs");
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

function runHook(base, { home, tier = "interactive", session = "s1" }) {
  return new Promise((resolve) => {
    const env = {
      HOME: home, PATH: process.env.PATH,
      ACP_TEST_DEV_BASE: "1", ACP_GOVERN_BASE: base,
      ACP_BEARER_TOKEN: "gsk_test_token", ACP_CLIENT: "test",
      ACP_FIRST_ATTEMPT_MS: "400", ACP_RETRY_ATTEMPT_MS: "400",
      CLAUDE_CODE_ENTRYPOINT: tier === "unattended" ? "sdk-cli" : "cli",
    };
    const child = spawn("node", [GOVERN], { env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => {
      const j = out.trim() ? JSON.parse(out) : {};
      resolve({ decision: j?.hookSpecificOutput?.permissionDecision ?? "allow", message: j?.systemMessage ?? "" });
    });
    child.stdin.end(JSON.stringify({
      session_id: session, cwd: "/tmp", hook_event_name: "PreToolUse",
      tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "echo hi" }, permission_mode: "default",
    }));
  });
}

const DELETED = { ok: false, reason: "unauthenticated", code: "workspace_deleted" };

test("workspace_deleted: interactive session gets ONE notice naming the deletion and the uninstall command", async () => {
  const home = mkdtempSync(join(tmpdir(), "acp-del-"));
  const { server, base } = await stubGateway(401, DELETED);
  try {
    const first = await runHook(base, { home });
    assert.equal(first.decision, "allow");
    assert.match(first.message, /workspace this machine was connected to has been deleted/);
    assert.match(first.message, /acp-uninstall/);
    assert.match(first.message, /uninstall\.sh \| bash/);
    const second = await runHook(base, { home });
    assert.equal(second.decision, "allow");
    assert.equal(second.message, "");
    const otherSession = await runHook(base, { home, session: "s2" });
    assert.match(otherSession.message, /has been deleted/);
  } finally { server.close(); }
});

test("workspace_deleted: unattended tier stays blocked on every call", async () => {
  const home = mkdtempSync(join(tmpdir(), "acp-del-"));
  const { server, base } = await stubGateway(401, DELETED);
  try {
    for (let i = 0; i < 2; i++) {
      const r = await runHook(base, { home, tier: "unattended" });
      assert.equal(r.decision, "deny");
      assert.match(r.message, /has been deleted/);
    }
  } finally { server.close(); }
});

test("a plain 401 still repeats KEY REJECTED every call (revoked key, not a deletion)", async () => {
  const home = mkdtempSync(join(tmpdir(), "acp-del-"));
  const { server, base } = await stubGateway(401, { ok: false, reason: "unauthenticated" });
  try {
    for (let i = 0; i < 2; i++) {
      const r = await runHook(base, { home });
      assert.match(r.message, /KEY REJECTED \(HTTP 401\)/);
      assert.match(r.message, /settings\/api-keys/);
    }
  } finally { server.close(); }
});
