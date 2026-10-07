// gatewaystack-connect#690: a slow-but-successful gateway answer must not
// become a deny. Confirmed incident: /govern/tool-use took 4.635s and
// returned 200 (an allow); the single 4s attempt aborted and the unattended
// tier failed closed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import "./_dev-base.mjs";

const GOVERN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "govern.mjs");

/** Gateway stub: `delays[n]` is how long the nth request stalls before replying. */
function stubGateway(delays, payload = { decision: "allow" }) {
  let n = 0;
  const server = createServer((req, res) => {
    const delay = delays[Math.min(n, delays.length - 1)];
    n += 1;
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    }, delay);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, base: `http://127.0.0.1:${server.address().port}`, count: () => n })));
}

function runHook(base, { tier = "unattended", budgets = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    // Tier detection reads real signals (#692): CLAUDE_CODE_ENTRYPOINT and
    // CI, not permission_mode "auto" (which is a human at the terminal and
    // resolves interactive). Build the env explicitly — spreading
    // process.env would leak the runner's own CI=true into the hook and
    // flip every "interactive" case to background on GitHub Actions.
    const env = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      ACP_TEST_DEV_BASE: "1", ACP_GOVERN_BASE: base,
      ACP_BEARER_TOKEN: "gsk_test_token",
      ACP_CLIENT: "test",
      ACP_FIRST_ATTEMPT_MS: String(budgets.first ?? 400),
      ACP_RETRY_ATTEMPT_MS: String(budgets.retry ?? 400),
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
      resolve({ decision, message, ms: Date.now() - started });
    });
    child.stdin.end(JSON.stringify({
      session_id: "t", cwd: "/tmp", hook_event_name: "PreToolUse",
      tool_name: "Bash", tool_use_id: "t1",
      tool_input: { command: "echo hi" },
      permission_mode: "default",
    }));
  });
}

test("slow first answer, fast second: retried and ALLOWED (the #690 regression)", async () => {
  // First attempt overruns its budget; the retry lands on a warm instance.
  const { server, base, count } = await stubGateway([900, 10]);
  const r = await runHook(base, { tier: "unattended", budgets: { first: 400, retry: 600 } });
  assert.equal(r.decision, "allow", `expected allow, got ${r.decision}: ${r.message}`);
  assert.equal(count(), 2, "should have made exactly two attempts");
  server.close();
});

test("both attempts overrun at an unattended tier: still fails closed", async () => {
  const { server, base, count } = await stubGateway([900, 900]);
  const r = await runHook(base, { tier: "unattended", budgets: { first: 300, retry: 300 } });
  assert.equal(r.decision, "deny");
  assert.match(r.message, /stays blocked/);
  assert.equal(count(), 2);
  server.close();
});

test("both attempts overrun at the interactive tier: still fails open, loudly", async () => {
  const { server, base } = await stubGateway([900, 900]);
  const r = await runHook(base, { tier: "interactive", budgets: { first: 300, retry: 300 } });
  assert.equal(r.decision, "allow");
  assert.match(r.message, /UNGOVERNED/);
  server.close();
});

test("a policy deny is never re-rolled by the retry", async () => {
  const { server, base, count } = await stubGateway([10], { decision: "deny", reason: "blast radius" });
  const r = await runHook(base);
  assert.equal(r.decision, "deny");
  assert.match(r.message, /Denied by policy: blast radius/);
  assert.equal(count(), 1, "a decisive answer must not be retried");
  server.close();
});

test("two attempts stay inside the harness hook budget", async () => {
  // Defaults 2200 + 1600 = 3.8s of network budget; with node startup this
  // must still land under the 5s timeout hooks.json grants the hook.
  const { server, base } = await stubGateway([9000, 9000]);
  const r = await runHook(base, { tier: "interactive", budgets: {} });
  assert.ok(r.ms < 5000, `hook took ${r.ms}ms — must stay under the 5s harness timeout`);
  server.close();
});
