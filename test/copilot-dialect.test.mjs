// Tests for the GitHub Copilot harness support in bin/govern.mjs.
//
// Run with: node --test test/copilot-dialect.test.mjs
//
// One registration (~/.copilot/hooks/acp.json, ACP_HARNESS=copilot) serves
// two dialects. Copilot CLI's PascalCase payload arrives in Claude Code's
// vocabulary already; VS Code's agent mode sends its own tool ids
// (run_in_terminal, create_file …) with camelCase inputs. Invariants:
//   a. A deny under ACP_HARNESS=copilot is written in BOTH output shapes —
//      the bare {permissionDecision} Copilot CLI documents and the
//      hookSpecificOutput wrapper VS Code documents — with the reason in both.
//   b. An ask is likewise in both shapes, and stays "ask" (Copilot renders
//      a native prompt; it is not Codex).
//   c. VS Code's run_in_terminal reaches the gateway as Bash, attributed to
//      copilot-vscode.
//   d. VS Code's camelCase file inputs gain their snake_case twins so
//      path-keyed policy sees them; the tool is canonical (Write).
//   e. Copilot CLI's tool_input, when it arrives as a JSON string, is parsed.
//   f. On a box wired for Claude Code WITHOUT the plugin, VS Code also runs
//      the ~/.claude/settings.json hook. When the Copilot registration
//      exists, that second hook stands down: no request, no output — one
//      governed call, one row.
//   g. Without the Copilot registration the same VS Code call is still
//      governed by the Claude registration (canonicalized, re-attributed).
//   h. Local mode: a hardline command through VS Code's shell tool is
//      denied, in both shapes.
//   i. No vendor-token injection under copilot (updatedInput is ignored by
//      Copilot CLI and schema-checked by VS Code): an allow is a bare allow.
//
// Each test spawns the real hook exactly the way a harness does — JSON on
// stdin — against a throwaway fixture HOME, with ACP_GOVERN_BASE pointed at
// a local stub server that records what it saw.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, renameSync } from "node:fs";
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
let nextResponse = { decision: "allow" };

const COPILOT_REG = () => join(HOME, ".copilot", "hooks", "acp.json");

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "acp-copilot-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  writeFileSync(join(HOME, ".acp", "credentials"), "gsk_test_deadbeef\n");

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* keep null */ }
      seen.push({ url: req.url, body, client: req.headers["x-gs-client"] });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(nextResponse));
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
  nextResponse = { decision: "allow" };
  rmSync(join(HOME, ".copilot"), { recursive: true, force: true });
  rmSync(join(HOME, ".acp", "policy.json"), { force: true });
});

function runHook(input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: {
        HOME,
        PATH: process.env.PATH,
        ACP_GOVERN_BASE: baseUrl,
        ACP_FIRST_ATTEMPT_MS: "1000",
        ACP_RETRY_ATTEMPT_MS: "1000",
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

const COPILOT = { ACP_HARNESS: "copilot", ACP_CLIENT: "copilot" };

// Copilot CLI, PascalCase payload: already Claude Code's vocabulary.
const cliPre = (overrides = {}) => ({
  hook_event_name: "PreToolUse",
  timestamp: "2026-09-21T10:00:00.000Z",
  session_id: "sess-copilot-cli",
  cwd: "/tmp",
  tool_name: "Bash",
  tool_input: { command: "git push origin main" },
  ...overrides,
});

// VS Code agent mode: VS Code's own tool ids and camelCase inputs.
const vscodeShell = (command) => ({
  hook_event_name: "PreToolUse",
  timestamp: "2026-09-21T10:00:00.000Z",
  session_id: "sess-copilot-vscode",
  cwd: "/tmp",
  tool_name: "run_in_terminal",
  tool_input: { command, explanation: "test", isBackground: false },
  tool_use_id: "tool-123",
});

// A hardline payload assembled from parts, so authoring this test never
// trips the floor itself.
const ROOT_DELETE = ["rm", "-rf", "/"].join(" ");

function writeCopilotRegistration() {
  mkdirSync(join(HOME, ".copilot", "hooks"), { recursive: true });
  writeFileSync(COPILOT_REG(), JSON.stringify({
    version: 1,
    hooks: { PreToolUse: [{ type: "command", command: "env ACP_CLIENT=copilot ACP_HARNESS=copilot node $HOME/.acp/govern.mjs", timeout: 5, timeoutSec: 5 }] },
  }));
}

test("(a) a deny under copilot is emitted in both output shapes", async () => {
  nextResponse = { decision: "deny", reason: "Bash.git.push is denied for interactive" };
  const out = await runHook(cliPre(), COPILOT);
  assert.equal(out.permissionDecision, "deny");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /Bash\.git\.push is denied/);
  assert.equal(out.permissionDecisionReason, out.hookSpecificOutput.permissionDecisionReason);
});

test("(b) an ask stays an ask under copilot, in both shapes", async () => {
  nextResponse = { decision: "ask", reason: "step_up for Bash.git.push", approval_id: "ap1", approval_status: "pending" };
  const out = await runHook(cliPre(), COPILOT);
  assert.equal(out.permissionDecision, "ask");
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
  const req = seen.find((s) => s.url === "/govern/tool-use");
  assert.deepEqual(req.body.capabilities, ["native_ask"]);
});

test("(c) VS Code's run_in_terminal reaches the gateway as Bash, attributed to copilot-vscode", async () => {
  await runHook(vscodeShell("git push origin main"), COPILOT);
  const req = seen.find((s) => s.url === "/govern/tool-use");
  assert.ok(req, "expected a request to /govern/tool-use");
  assert.equal(req.body.tool_name, "Bash");
  assert.equal(req.body.tool_input.command, "git push origin main");
  assert.equal(req.body.call_id, "tool-123");
  assert.match(String(req.client), /^copilot-vscode\//);
});

test("(d) VS Code's camelCase file inputs gain snake_case twins; tool is canonical", async () => {
  await runHook({
    ...vscodeShell("x"),
    tool_name: "create_file",
    tool_input: { filePath: "/tmp/proj/.env", content: "SECRET=1" },
  }, COPILOT);
  const req = seen.find((s) => s.url === "/govern/tool-use");
  assert.equal(req.body.tool_name, "Write");
  assert.equal(req.body.tool_input.file_path, "/tmp/proj/.env");
  assert.equal(req.body.tool_input.filePath, "/tmp/proj/.env");
});

test("(e) a tool_input that arrives as a JSON string is parsed", async () => {
  await runHook(cliPre({ tool_input: JSON.stringify({ command: "ls -la" }) }), COPILOT);
  const req = seen.find((s) => s.url === "/govern/tool-use");
  assert.deepEqual(req.body.tool_input, { command: "ls -la" });
});

test("(f) the Claude registration stands down for a VS Code call when the Copilot registration exists", async () => {
  writeCopilotRegistration();
  assert.ok(existsSync(COPILOT_REG()));
  const out = await runHook(vscodeShell("git push origin main"), { ACP_CLIENT: "claude-code-plugin" });
  assert.equal(out, null, "expected no output from the standing-down hook");
  assert.equal(seen.length, 0, "expected no gateway request");
});

test("(g) without the Copilot registration, the Claude registration still governs a VS Code call", async () => {
  nextResponse = { decision: "deny", reason: "denied" };
  const out = await runHook(vscodeShell("git push origin main"), { ACP_CLIENT: "claude-code-plugin" });
  const req = seen.find((s) => s.url === "/govern/tool-use");
  assert.ok(req);
  assert.equal(req.body.tool_name, "Bash");
  assert.match(String(req.client), /^copilot-vscode\//);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
});

test("(h) local mode: a hardline command through VS Code's shell tool is denied in both shapes", async () => {
  // Local mode is "no workspace token AND a policy file" — park the
  // fixture's credentials for the duration of this test.
  const creds = join(HOME, ".acp", "credentials");
  const parked = join(HOME, ".acp", "credentials.parked");
  renameSync(creds, parked);
  try {
    writeFileSync(join(HOME, ".acp", "policy.json"), JSON.stringify({ default: "allow", rules: {} }));
    const out = await runHook(vscodeShell(ROOT_DELETE), COPILOT);
    assert.ok(out, "expected a verdict on stdout");
    assert.equal(out.permissionDecision, "deny");
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(seen.length, 0, "local mode makes no gateway request");
  } finally {
    renameSync(parked, creds);
  }
});

test("(i) an allow under copilot never injects updatedInput", async () => {
  nextResponse = { decision: "allow" };
  const out = await runHook(cliPre({ tool_input: { command: "gh pr list" } }), COPILOT);
  assert.ok(!out || !out.hookSpecificOutput || out.hookSpecificOutput.updatedInput === undefined);
  assert.ok(!seen.some((s) => s.url.includes("scoped-tokens")), "no scoped-token request");
});
