// Tests for the UserPromptExpansion terminal-intents handler in
// bin/govern.mjs (`handleUserPromptExpansion`, dispatched on
// hook_event_name === "UserPromptExpansion").
//
// Run with: node --test test/terminal-intents.test.mjs
//
// Each test spawns the real hook exactly the way a harness does — JSON on
// stdin — against a throwaway fixture HOME holding a workspace token, with
// ACP_API_BASE pointed at a local stub server that records what it saw and
// serves both POST /plugin/intents and GET /plugin/intents/status.
// Invariants under test:
//   a. /acp-enforce with no args → POST {kind:"enforce", target:"", ...}
//      with a bearer header; blocked with describe/confirm/expiry text.
//   b. /acp-allow <tool> [extra] → target is only the first token.
//   c. /acp-status → GET .../status; reason starts with the mode line and
//      lists a proposal's /acp-apply hint.
//   d. A non-ACP command never triggers a request or output.
//   e. A subagent (agent_id set) never triggers a request or output.
//   f. No credentials in HOME → blocked with an /acp-connect hint, no
//      request made.
//   g. 404 not-rolled-out → blocked mentioning the workspace isn't on it.
//   h. Unreachable stub → blocked mentioning ACP was unreachable.
// The hook always exits 0, in every case above.

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

let HOME;
let server;
let baseUrl;
let seen = [];
let nextResponse = {
  ok: true,
  describe: "File /acp-enforce: turn on the starter rules for this workspace.",
  confirm: "https://cloud.agenticcontrolplane.com/confirm/abc123",
  expiresInSeconds: 600,
};
let nextStatus = 200;
let nextStatusResponse = {
  ok: true,
  workspace: "acme",
  mode: "audit",
  rules: [],
  proposals: [],
  pendingApprovals: [],
};

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "acp-terminal-intents-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  writeFileSync(join(HOME, ".acp", "credentials"), "gsk_test_deadbeef\n");

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* keep null */ }
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/plugin/intents/status")) {
        res.statusCode = nextStatus;
        res.end(JSON.stringify(nextStatusResponse));
      } else {
        res.statusCode = nextStatus;
        res.end(JSON.stringify(nextResponse));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
  nextStatus = 200;
  nextResponse = {
    ok: true,
    describe: "File /acp-enforce: turn on the starter rules for this workspace.",
    confirm: "https://cloud.agenticcontrolplane.com/confirm/abc123",
    expiresInSeconds: 600,
  };
  nextStatusResponse = {
    ok: true,
    workspace: "acme",
    mode: "audit",
    rules: [],
    proposals: [],
    pendingApprovals: [],
  };
});

// NOTE: async spawn, not spawnSync — the stub server lives in THIS process.
function runHook(input, env = {}, useHome = HOME) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: {
        HOME: useHome,
        PATH: process.env.PATH,
        ACP_API_BASE: baseUrl,
        CLAUDE_CODE_ENTRYPOINT: "cli",
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
        resolve(stdout.trim() ? JSON.parse(stdout) : null);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

const expansion = (overrides = {}) => ({
  hook_event_name: "UserPromptExpansion",
  command_name: "agentic-control-plane:acp-enforce",
  command_args: "",
  session_id: "sess-intents-1",
  ...overrides,
});

test("(a) /acp-enforce with no args files enforce with an empty target and blocks with describe/confirm/expiry", async () => {
  const out = await runHook(expansion());
  const req = seen.find((s) => s.url === "/plugin/intents");
  assert.ok(req, "expected a POST to /plugin/intents");
  assert.equal(req.method, "POST");
  assert.deepEqual(req.body, {
    kind: "enforce",
    target: "",
    session_id: "sess-intents-1",
    client: req.body.client,
  });
  assert.equal(req.headers.authorization, "Bearer gsk_test_deadbeef");
  assert.ok(out, "expected output on stdout");
  assert.equal(out.decision, "block");
  assert.ok(out.reason.includes(nextResponse.describe), "reason should include the describe text");
  assert.ok(out.reason.includes(nextResponse.confirm), "reason should include the confirm URL");
  assert.match(out.reason, /Expires in 10 min/);
});

test("(b) /acp-allow target is only the first whitespace-separated token", async () => {
  const out = await runHook(expansion({
    command_name: "agentic-control-plane:acp-allow",
    command_args: "Bash.git-push --force",
  }));
  const req = seen.find((s) => s.url === "/plugin/intents");
  assert.ok(req, "expected a POST to /plugin/intents");
  assert.equal(req.body.kind, "allow");
  assert.equal(req.body.target, "Bash.git-push");
  assert.equal(out.decision, "block");
});

test("(c) /acp-status reads GET /plugin/intents/status and lists the mode + a proposal's /acp-apply hint", async () => {
  nextStatusResponse = {
    ok: true,
    workspace: "acme",
    mode: "audit",
    rules: [],
    proposals: [{ id: "p1", tool: "Bash.rm", permission: "step_up", source: "acp_propose_rule" }],
    pendingApprovals: [],
  };
  const out = await runHook(expansion({ command_name: "agentic-control-plane:acp-status", command_args: "" }));
  const req = seen.find((s) => s.url.startsWith("/plugin/intents/status"));
  assert.ok(req, "expected a GET to /plugin/intents/status");
  assert.equal(req.method, "GET");
  assert.equal(req.headers.authorization, "Bearer gsk_test_deadbeef");
  assert.ok(out, "expected output on stdout");
  assert.equal(out.decision, "block");
  assert.match(out.reason, /^\[ACP\] acme is in audit mode\./);
  assert.ok(out.reason.includes("/acp-apply p1"), "reason should include the apply hint for proposal p1");
});

test("(d) a non-ACP command never triggers a request or any output", async () => {
  const out = await runHook(expansion({ command_name: "probe:enforce" }));
  assert.equal(out, null);
  assert.equal(seen.length, 0);
});

test("(e) a subagent (agent_id set) never triggers a request or any output", async () => {
  const out = await runHook(expansion({ agent_id: "sub-1" }));
  assert.equal(out, null);
  assert.equal(seen.length, 0);
});

test("(f) no credentials in HOME → blocked with an /acp-connect hint and no request", async () => {
  const bareHome = mkdtempSync(join(tmpdir(), "acp-terminal-intents-nocred-"));
  try {
    const out = await runHook(expansion(), {}, bareHome);
    assert.ok(out, "expected output on stdout");
    assert.equal(out.decision, "block");
    assert.ok(out.reason.includes("/acp-connect"), "reason should point at /acp-connect");
    assert.equal(seen.length, 0, "no request should have been made without credentials");
  } finally {
    rmSync(bareHome, { recursive: true, force: true });
  }
});

test("(g) 404 not-rolled-out → blocked mentioning the workspace isn't on it", async () => {
  nextStatus = 404;
  nextResponse = { ok: false, error: "not-rolled-out" };
  const out = await runHook(expansion());
  assert.ok(out, "expected output on stdout");
  assert.equal(out.decision, "block");
  assert.match(out.reason, /on for this workspace/);
});

test("(h) unreachable stub → blocked mentioning ACP was unreachable", async () => {
  const closedServer = createServer(() => {});
  await new Promise((resolve) => closedServer.listen(0, "127.0.0.1", resolve));
  const deadPort = closedServer.address().port;
  await new Promise((resolve) => closedServer.close(resolve));

  const out = await runHook(expansion(), { ACP_API_BASE: `http://127.0.0.1:${deadPort}` });
  assert.ok(out, "expected output on stdout");
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Couldn't reach ACP/);
});
