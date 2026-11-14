// PII honesty: the hook declares rewrite capabilities per harness, applies the
// gateway's modified_input / modified_tool_response through each harness's own
// field, and never claims removal it did not perform.
//
// Run with: node --test test/pii-rewrite.test.mjs

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
const ADDR = ["jane.doe", "acme-corp.dev"].join("@");

let HOME, server, baseUrl;
let nextResponse = {};
let lastBody = null;

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "acp-pii-rewrite-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  writeFileSync(join(HOME, ".acp", "credentials"), "gsk_test_deadbeef\n");
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try { lastBody = JSON.parse(raw); } catch { lastBody = null; }
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

const HARNESS = {
  claude: {},
  codex: { ACP_CLIENT: "codex", ACP_HARNESS: "codex" },
  qwen: { ACP_CLIENT: "qwen-code" },
  cursor: { ACP_CLIENT: "cursor" },
  copilot: { ACP_CLIENT: "copilot", ACP_HARNESS: "copilot" },
  copilotVscode: { ACP_CLIENT: "copilot", ACP_HARNESS: "copilot", __vscode: true },
};

function run(event, harness, response, toolResponse = { stdout: `mail ${ADDR}`, stderr: "", interrupted: false, isImage: false }) {
  nextResponse = response;
  const { __vscode, ...env } = HARNESS[harness];
  const input = {
    hook_event_name: event,
    tool_name: "Bash",
    tool_input: { command: "cat people.txt", description: "read" },
    session_id: `sess-pii-${harness}-${event}`,
    ...(event === "PostToolUse" ? { tool_response: toolResponse } : {}),
    ...(__vscode ? { tool_name: "run_in_terminal", tool_input: { command: "cat people.txt" } } : {}),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: { HOME, PATH: process.env.PATH, ACP_TEST_DEV_BASE: "1", ACP_GOVERN_BASE: baseUrl, ...env },
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
        resolve({ out: stdout ? JSON.parse(stdout) : null, body: lastBody });
      } catch (e) { reject(e); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

const PII_LINE = "[ACP] Redacted 1 email address from this result.";
const REDACTED_PII = { types: ["email"], count: 1, action: "redacted", applied: true };

// ── capability declaration ──────────────────────────────────────────────

test("PreToolUse capabilities per harness", async () => {
  const expect = {
    claude: ["native_ask", "input_rewrite"],
    codex: [],
    qwen: ["input_rewrite"],
    cursor: [],
    copilot: ["native_ask", "input_rewrite"],
    copilotVscode: ["native_ask"],
  };
  for (const [h, caps] of Object.entries(expect)) {
    const { body } = await run("PreToolUse", h, { decision: "allow" });
    assert.deepEqual(body.capabilities, caps, h);
  }
});

test("PostToolUse capabilities per harness; output_rewrite only with an echoable response", async () => {
  const expect = {
    claude: ["input_rewrite", "output_rewrite"],
    codex: [],
    qwen: ["input_rewrite"],
    cursor: [],
    copilot: ["input_rewrite", "output_rewrite"],
  };
  for (const [h, caps] of Object.entries(expect)) {
    const { body } = await run("PostToolUse", h, { action: "pass" });
    assert.deepEqual(body.capabilities, caps, h);
    assert.deepEqual(body.tool_response, { stdout: `mail ${ADDR}`, stderr: "", interrupted: false, isImage: false });
  }
  const { body } = await run("PostToolUse", "claude", { action: "pass" }, null);
  assert.deepEqual(body.capabilities, ["input_rewrite"]);
});

// ── PreToolUse: applying modified_input ─────────────────────────────────

const MOD_IN = { command: "cat people.txt | sed 's/x/[REDACTED:email]/'", description: "read" };
const PRE_RESP = { decision: "allow", modified_input: MOD_IN, pii: REDACTED_PII, notice: PII_LINE };

test("Claude Code: modified_input becomes updatedInput + allow; gateway line verbatim", async () => {
  const { out } = await run("PreToolUse", "claude", PRE_RESP);
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(out.hookSpecificOutput.updatedInput, MOD_IN);
  assert.equal(out.systemMessage, PII_LINE);
});

test("qwen-code: updatedInput", async () => {
  const { out } = await run("PreToolUse", "qwen", PRE_RESP);
  assert.deepEqual(out.hookSpecificOutput.updatedInput, MOD_IN);
  assert.equal(out.systemMessage, PII_LINE);
});

test("Copilot CLI: modifiedArgs, not updatedInput", async () => {
  const { out } = await run("PreToolUse", "copilot", PRE_RESP);
  assert.deepEqual(out.modifiedArgs, MOD_IN);
  assert.equal(out.hookSpecificOutput.updatedInput, undefined);
  assert.equal(out.permissionDecision, "allow");
  assert.equal(out.systemMessage, PII_LINE);
});

test("Codex / Cursor: undeclared, so nothing is applied and no removal is claimed", async () => {
  for (const h of ["codex", "cursor"]) {
    const { out } = await run("PreToolUse", h, PRE_RESP);
    const s = JSON.stringify(out);
    assert.ok(!s.includes("updatedInput") && !s.includes("modifiedArgs") && !s.includes("updated_input"), h);
    assert.equal(out.systemMessage, "[ACP] PII flagged: email", h);
  }
});

test("malformed modified_input fails open: original passes, no removal claim", async () => {
  const { out } = await run("PreToolUse", "claude", { ...PRE_RESP, modified_input: { command: 42 } });
  assert.equal(out.hookSpecificOutput, undefined);
  assert.equal(out.systemMessage, "[ACP] PII flagged: email");
});

test("pii detected-only prints the gateway line and changes nothing", async () => {
  const line = "[ACP] PII detected (email); policy is audit-only, nothing was changed.";
  const { out } = await run("PreToolUse", "claude", { decision: "allow", pii: { types: ["email"], count: 1, action: "detected", applied: false }, notice: line });
  assert.equal(out.systemMessage, line);
  assert.equal(out.hookSpecificOutput, undefined);
});

// ── PostToolUse: applying modified_tool_response ────────────────────────

const MOD_OUT = { stdout: "mail [REDACTED:email]", stderr: "", interrupted: false, isImage: false };
const POST_RESP = { action: "redact", reason: "redacted PII: email", pii: REDACTED_PII, notice: PII_LINE, modified_tool_response: MOD_OUT, modified_output: "mail [REDACTED:email]" };

test("Claude Code: updatedToolOutput carries the schema-matching object", async () => {
  const { out } = await run("PostToolUse", "claude", POST_RESP);
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: "PostToolUse", updatedToolOutput: MOD_OUT });
  assert.equal(out.systemMessage, PII_LINE);
  assert.ok(!JSON.stringify(out).includes(ADDR));
});

test("Claude Code: schema-mismatched rewrite is dropped and removal is not claimed", async () => {
  for (const bad of [{ stdout: "x" }, { text: "mail [REDACTED:email]" }, "mail [REDACTED:email]", { ...MOD_OUT, interrupted: "no" }]) {
    const { out } = await run("PostToolUse", "claude", { ...POST_RESP, modified_tool_response: bad });
    assert.equal(out.hookSpecificOutput, undefined, JSON.stringify(bad));
    assert.equal(out.systemMessage, "[ACP] PII flagged: email");
  }
});

test("Claude Code: string tool_response takes modified_output", async () => {
  const { out } = await run("PostToolUse", "claude", { ...POST_RESP, modified_tool_response: undefined }, `x ${ADDR}`);
  assert.equal(out.hookSpecificOutput.updatedToolOutput, "mail [REDACTED:email]");
});

test("Claude Code: MCP-style content array keeps its shape", async () => {
  const orig = [{ type: "text", text: `Contact ${ADDR}` }];
  const mod = [{ type: "text", text: "Contact [REDACTED:email]" }];
  const { out } = await run("PostToolUse", "claude", { ...POST_RESP, modified_tool_response: mod }, orig);
  assert.deepEqual(out.hookSpecificOutput.updatedToolOutput, mod);
});

test("Copilot CLI: modifiedResult text; Codex and qwen-code have no output rewrite", async () => {
  const c = await run("PostToolUse", "copilot", POST_RESP);
  assert.deepEqual(c.out.modifiedResult, { resultType: "success", textResultForLlm: "mail [REDACTED:email]" });
  assert.equal(c.out.systemMessage, PII_LINE);
  for (const h of ["codex", "qwen", "cursor"]) {
    const { out } = await run("PostToolUse", h, POST_RESP);
    const s = JSON.stringify(out);
    assert.ok(!s.includes("updatedToolOutput") && !s.includes("modifiedResult") && !s.includes("updated_mcp_tool_output"), h);
    assert.equal(out.systemMessage, "[ACP] PII flagged: email", h);
  }
});

test("old gateway (no pii field): neutral flagged line, never a removal claim", async () => {
  const { out } = await run("PostToolUse", "claude", { action: "redact", reason: "redacted PII: email, phone" });
  assert.equal(out.systemMessage, "[ACP] PII flagged: email, phone");
  assert.ok(!/redact/i.test(out.systemMessage));
  assert.equal(out.hookSpecificOutput, undefined);
});

test("blocked stays a block", async () => {
  const { out } = await run("PostToolUse", "claude", { action: "block", reason: "prompt-injection detected" });
  assert.match(out.systemMessage, /^\[ACP\] Blocked: prompt-injection detected/);
});
