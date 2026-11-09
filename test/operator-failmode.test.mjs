// Operator fail mode (restored 2026-11-08): `echo closed > ~/.acp/failmode`
// or ACP_FAIL_MODE=closed makes the INTERACTIVE tier block when the gateway
// can't be reached or the key is rejected, the same as the bundled fallback
// hook and as the docs promise. Without it the interactive tier still fails
// open (never-brick default). Nothing in the switch can open an unattended
// tier.
//
// Run with: node --test test/operator-failmode.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "./_dev-base.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOVERN = join(ROOT, "bin", "govern.mjs");
const LOOPBACK = [127, 0, 0, 1].join(".");

let deadServer, deadBase, keyServer, keyBase;
const homes = [];

before(async () => {
  deadServer = createServer((req) => req.destroy());
  await new Promise((r) => deadServer.listen(0, LOOPBACK, r));
  deadBase = `http://${LOOPBACK}:${deadServer.address().port}`;
  keyServer = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "invalid key" }));
    });
  });
  await new Promise((r) => keyServer.listen(0, LOOPBACK, r));
  keyBase = `http://${LOOPBACK}:${keyServer.address().port}`;
});

after(() => {
  deadServer?.close();
  keyServer?.close();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function freshHome(failmodeFile) {
  const home = mkdtempSync(join(tmpdir(), "acp-failmode-test-"));
  homes.push(home);
  mkdirSync(join(home, ".acp"), { recursive: true });
  writeFileSync(join(home, ".acp", "credentials"), "gsk_test_deadbeef\n");
  if (failmodeFile !== undefined) writeFileSync(join(home, ".acp", "failmode"), failmodeFile);
  return home;
}

function runHook(home, base, env = {}) {
  const input = {
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hi" },
    session_id: `sess-${Math.random().toString(36).slice(2)}`, permission_mode: "default",
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: {
        HOME: home, PATH: process.env.PATH, ACP_TEST_DEV_BASE: "1",
        ACP_GOVERN_BASE: base, ACP_API_BASE: base,
        CLAUDE_CODE_ENTRYPOINT: "cli", ACP_FIRST_ATTEMPT_MS: "300", ACP_RETRY_ATTEMPT_MS: "300",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const killer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(killer);
      try {
        assert.equal(status, 0, `hook exited ${status}: ${stderr}`);
        resolve(stdout.trim() ? JSON.parse(stdout) : null);
      } catch (e) { reject(e); }
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

const decision = (out) => out?.hookSpecificOutput?.permissionDecision;

test("default: an interactive call still fails open when the gateway is unreachable", async () => {
  const out = await runHook(freshHome(), deadBase);
  assert.equal(decision(out), "allow");
  assert.match(out.systemMessage, /UNGOVERNED/);
});

test("~/.acp/failmode = closed: the interactive call is blocked, and the reason names the setting", async () => {
  const out = await runHook(freshHome("closed\n"), deadBase);
  assert.equal(decision(out), "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /fail closed \(~\/\.acp\/failmode or ACP_FAIL_MODE\)/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /availability failure, NOT a policy judgment/);
});

test("ACP_FAIL_MODE=closed works without the file, and env wins over the file", async () => {
  const viaEnv = await runHook(freshHome(), deadBase, { ACP_FAIL_MODE: "CLOSED" });
  assert.equal(decision(viaEnv), "deny");
  const envOpenFileClosed = await runHook(freshHome("closed"), deadBase, { ACP_FAIL_MODE: "open" });
  assert.equal(decision(envOpenFileClosed), "allow", "env is read first, as in the fallback hook");
});

test("the switch can't open an unattended tier: background stays blocked with failmode = open", async () => {
  const out = await runHook(freshHome("open"), deadBase, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
  assert.equal(decision(out), "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /background tier stays blocked/);
});

test("a rejected key also blocks an interactive call when set to fail closed", async () => {
  const open = await runHook(freshHome(), keyBase);
  assert.equal(decision(open), "allow");
  assert.match(open.systemMessage, /KEY REJECTED/);
  const closed = await runHook(freshHome("closed"), keyBase);
  assert.equal(decision(closed), "deny");
  assert.match(closed.hookSpecificOutput.permissionDecisionReason, /Key rejected \(HTTP 401\)/);
});
