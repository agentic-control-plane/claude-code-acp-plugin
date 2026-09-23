// Tests for the #1351 SessionStart notices (upgrade_notice / catch_up) and
// the #1352 part 3 UNGOVERNED-outage dedup in bin/govern.mjs:
//   - upgrade_notice (human-worded, ends "/acp-upgrade") is shown to the
//     HUMAN at most once per 24h per machine, via systemMessage, and
//     suppresses the older model-facing data.notice upgrade text.
//   - catch_up is one human line, shown as systemMessage at SessionStart.
//   - an interactive session that hits an unreachable gateway prints the
//     UNGOVERNED banner once at the START of the outage, stays silent on
//     later calls during the same outage, and prints a "governed again"
//     recovery line exactly once when the gateway answers again.
//
// Run with: node --test test/notices-and-outage.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
let nextAttest = { ok: true };
let nextToolUse = { decision: "allow" };

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "acp-notices-outage-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  writeFileSync(join(HOME, ".acp", "credentials"), "gsk_test_deadbeef\n");

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url.endsWith("/govern/attest")) {
        res.end(JSON.stringify(nextAttest));
      } else if (req.url.endsWith("/govern/tool-use")) {
        res.end(JSON.stringify(nextToolUse));
      } else {
        res.end(JSON.stringify({ ok: true }));
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

beforeEach(() => {
  nextAttest = { ok: true };
  nextToolUse = { decision: "allow" };
});

function runHook(input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: { HOME, PATH: process.env.PATH, ACP_GOVERN_BASE: baseUrl, ACP_API_BASE: baseUrl, ...env },
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
        resolve(stdout.trim() ? JSON.parse(stdout) : null);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

const sessionStart = (sid, overrides = {}) => ({
  hook_event_name: "SessionStart", session_id: sid, cwd: "/tmp", ...overrides,
});
const preToolUse = (sid, overrides = {}) => ({
  hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hi" },
  session_id: sid, permission_mode: "default", ...overrides,
});

test("upgrade_notice is shown to the human once per 24h, and suppresses the old model-facing notice", async () => {
  const sid = "sess-upgrade-1";
  nextAttest = {
    ok: true,
    notice: "[ACP] old model-facing upgrade text",
    upgrade_notice: "Your ACP plugin is out of date — type /acp-upgrade to update.",
  };
  const out1 = await runHook(sessionStart(sid));
  assert.match(out1.systemMessage, /type \/acp-upgrade/);
  // The old data.notice must NOT also reach the model when upgrade_notice
  // is present (CONTRACT §4).
  assert.equal(out1.hookSpecificOutput, undefined, "old notice must not be forwarded as additionalContext");

  // A second SessionStart within the 24h window must not repeat it.
  const out2 = await runHook(sessionStart("sess-upgrade-2"));
  assert.equal(out2, null, "upgrade_notice must not repeat inside the 24h window");
});

test("catch_up is shown as a human systemMessage at SessionStart", async () => {
  nextAttest = { ok: true, catch_up: "While you were away: 3 calls were approved." };
  const out = await runHook(sessionStart("sess-catchup-1"));
  assert.match(out.systemMessage, /3 calls were approved/);
});

test("old data.notice still reaches the model via additionalContext when no upgrade_notice is present", async () => {
  nextAttest = { ok: true, notice: "[ACP] old model-facing upgrade text" };
  const out = await runHook(sessionStart("sess-old-notice-only"));
  assert.equal(out.hookSpecificOutput?.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /old model-facing upgrade text/);
});

test("interactive session: UNGOVERNED fires once at the start of an outage, silent while it continues, then a single recovery line on the first call after the gateway answers again", async () => {
  const sid = "sess-outage-1";
  const deadServer = createServer((req) => req.destroy());
  await new Promise((resolve) => deadServer.listen(0, LOOPBACK, resolve));
  const deadBase = `http://${LOOPBACK}:${deadServer.address().port}`;
  const env = { CLAUDE_CODE_ENTRYPOINT: "cli", ACP_FIRST_ATTEMPT_MS: "300", ACP_RETRY_ATTEMPT_MS: "300" };

  const out1 = await runHook(preToolUse(sid), { ...env, ACP_GOVERN_BASE: deadBase, ACP_API_BASE: deadBase });
  assert.equal(out1.hookSpecificOutput?.permissionDecision, "allow");
  assert.match(out1.systemMessage, /UNGOVERNED: gateway unreachable/);

  const out2 = await runHook(preToolUse(sid), { ...env, ACP_GOVERN_BASE: deadBase, ACP_API_BASE: deadBase });
  assert.equal(out2.hookSpecificOutput?.permissionDecision, "allow");
  assert.equal(out2.systemMessage, undefined, "no repeat banner while the outage continues");

  deadServer.close();

  const out3 = await runHook(preToolUse(sid), env);
  assert.match(out3.systemMessage, /Governed again; 2 calls ran unchecked/);

  const out4 = await runHook(preToolUse(sid), env);
  assert.equal(out4, null, "recovery line must not repeat on the next healthy call");
});
