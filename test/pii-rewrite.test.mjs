// PII honesty: the hook declares rewrite capabilities per harness and per tool,
// applies the gateway's modified_input / modified_tool_response through each
// harness's own field, never grants a permission decision, and never claims
// removal it did not perform.
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
  // VS Code Copilot arriving through ~/.claude/settings.json
  vscode: { ACP_CLIENT: "copilot-vscode" },
};

const MCP = "mcp__crm__send_note";
const BASH_RESP = { stdout: `mail ${ADDR}`, stderr: "", interrupted: false, isImage: false };
const MCP_RESP = [{ type: "text", text: `Contact ${ADDR}` }];

function run(event, harness, response, { tool = "Bash", toolInput = { command: "cat people.txt", description: "read" }, toolResponse = BASH_RESP } = {}) {
  nextResponse = response;
  const input = {
    hook_event_name: event,
    tool_name: tool,
    tool_input: toolInput,
    session_id: `sess-pii-${harness}-${event}`,
    ...(event === "PostToolUse" && toolResponse !== undefined ? { tool_response: toolResponse } : {}),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: { HOME, PATH: process.env.PATH, ACP_TEST_DEV_BASE: "1", ACP_GOVERN_BASE: baseUrl, ...HARNESS[harness] },
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
const NEUTRAL = "[ACP] PII flagged: email";
const MCP_IN = { to: "crm", note: `call ${ADDR}` };
const MCP_MOD_IN = { to: "crm", note: "call [REDACTED:email]" };
const pre = (extra) => ({ decision: "allow", pii: REDACTED_PII, notice: PII_LINE, ...extra });

// -- capability declaration ------------------------------------------------

test("PreToolUse: input_rewrite only for outside-party tools, per harness", async () => {
  const mcp = { claude: ["native_ask", "input_rewrite"], codex: [], qwen: ["input_rewrite"], cursor: [], copilot: ["native_ask"], vscode: ["native_ask"] };
  for (const [h, caps] of Object.entries(mcp)) {
    const { body } = await run("PreToolUse", h, { decision: "allow" }, { tool: MCP, toolInput: MCP_IN });
    assert.deepEqual(body.capabilities, caps, h);
  }
  for (const tool of ["WebFetch", "WebSearch"]) {
    const { body } = await run("PreToolUse", "claude", { decision: "allow" }, { tool, toolInput: { url: "https://x.dev" } });
    assert.ok(body.capabilities.includes("input_rewrite"), tool);
  }
  for (const tool of ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep"]) {
    for (const h of ["claude", "qwen"]) {
      const { body } = await run("PreToolUse", h, { decision: "allow" }, { tool, toolInput: { command: "x" } });
      assert.ok(!body.capabilities.includes("input_rewrite"), `${tool} ${h}`);
    }
  }
});

test("PostToolUse: output_rewrite only for proven shapes, only on Claude Code; never input_rewrite", async () => {
  const read = { type: "text", file: { filePath: "/a", content: ADDR, numLines: 1, startLine: 1, totalLines: 1 } };
  const yes = [["Bash", BASH_RESP], ["Read", read], [MCP, MCP_RESP], [MCP, `plain ${ADDR}`]];
  for (const [tool, toolResponse] of yes) {
    const { body } = await run("PostToolUse", "claude", { action: "pass" }, { tool, toolResponse });
    assert.deepEqual(body.capabilities, ["output_rewrite"], tool);
    assert.deepEqual(body.tool_response, toolResponse);
  }
  const no = [["Read", { type: "image", file: { base64: "AAAA" } }], ["Read", { type: "pdf", file: { base64: "AAAA" } }],
    ["Grep", { mode: "content", content: "x" }], ["Glob", { filenames: [] }], ["WebFetch", { result: "x" }], ["Agent", { content: [] }]];
  for (const [tool, toolResponse] of no) {
    const { body } = await run("PostToolUse", "claude", { action: "pass" }, { tool, toolResponse });
    assert.deepEqual(body.capabilities, [], tool);
  }
  for (const h of ["qwen", "codex", "cursor", "copilot", "vscode"]) {
    const { body } = await run("PostToolUse", h, { action: "pass" });
    assert.deepEqual(body.capabilities, [], h);
  }
});

test("oversize response: tool_response dropped and output_rewrite not declared", async () => {
  const big = { ...BASH_RESP, stdout: "x".repeat(300 * 1024) };
  const { body } = await run("PostToolUse", "claude", { action: "pass" }, { toolResponse: big });
  assert.equal(body.tool_response, undefined);
  assert.deepEqual(body.capabilities, []);
});

// -- PreToolUse: applying modified_input -------------------------------------

test("modified_input becomes updatedInput with NO permissionDecision (permission flow untouched)", async () => {
  for (const h of ["claude", "qwen"]) {
    const { out } = await run("PreToolUse", h, pre({ modified_input: MCP_MOD_IN }), { tool: MCP, toolInput: MCP_IN });
    assert.deepEqual(out.hookSpecificOutput.updatedInput, MCP_MOD_IN, h);
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined, h);
    assert.equal(out.permissionDecision, undefined, h);
    assert.equal(out.systemMessage, PII_LINE, h);
  }
});

test("input rewrite is merged and dropped when the key set differs", async () => {
  for (const bad of [{ to: "crm" }, { ...MCP_MOD_IN, extra: 1 }, { to: "crm", note: 5 }]) {
    const { out } = await run("PreToolUse", "claude", pre({ modified_input: bad }), { tool: MCP, toolInput: MCP_IN });
    assert.equal(out.hookSpecificOutput, undefined, JSON.stringify(bad));
    assert.equal(out.systemMessage, NEUTRAL);
  }
});

test("Bash input is never rewritten even if the gateway sends modified_input", async () => {
  const { out } = await run("PreToolUse", "claude", pre({ modified_input: { command: "echo x", description: "read" } }));
  assert.equal(out.hookSpecificOutput, undefined);
  assert.equal(out.systemMessage, NEUTRAL);
});

test("Codex / Cursor / Copilot / VS Code: nothing applied, no removal claimed", async () => {
  for (const h of ["codex", "cursor", "copilot", "vscode"]) {
    const { out } = await run("PreToolUse", h, pre({ modified_input: MCP_MOD_IN }), { tool: MCP, toolInput: MCP_IN });
    const s = JSON.stringify(out);
    assert.ok(!/updatedInput|modifiedArgs|updated_input|permissionDecision/.test(s), h);
    assert.equal(out.systemMessage, NEUTRAL, h);
  }
});

test("a throwing PII line never becomes an outage deny", async () => {
  const { out } = await run("PreToolUse", "claude", { decision: "allow", pii: { types: [{ toString() { throw new Error("x"); } }], action: "redacted" }, notice: { bad: 1 } });
  assert.ok(!out || !JSON.stringify(out).includes("deny"));
});

test("pii detected-only prints the gateway line and changes nothing", async () => {
  const line = "[ACP] PII detected (email); policy is audit-only, nothing was changed.";
  const { out } = await run("PreToolUse", "claude", { decision: "allow", pii: { types: ["email"], count: 1, action: "detected", applied: false }, notice: line });
  assert.equal(out.systemMessage, line);
  assert.equal(out.hookSpecificOutput, undefined);
});

// -- PostToolUse: applying modified_tool_response ----------------------------

const MOD_OUT = { stdout: "mail [REDACTED:email]", stderr: "", interrupted: false, isImage: false };
const POST_RESP = { action: "redact", reason: "redacted PII: email", pii: REDACTED_PII, notice: PII_LINE, modified_tool_response: MOD_OUT, modified_output: "mail [REDACTED:email]" };

test("Claude Code: updatedToolOutput carries the schema-matching object", async () => {
  const { out } = await run("PostToolUse", "claude", POST_RESP);
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: "PostToolUse", updatedToolOutput: MOD_OUT });
  assert.equal(out.systemMessage, PII_LINE);
  assert.ok(!JSON.stringify(out).includes(ADDR));
});

test("deep shape mismatch is dropped and removal is not claimed", async () => {
  const bads = [{ stdout: "x" }, "mail", { ...MOD_OUT, interrupted: "no" }, { ...MOD_OUT, isImage: null }, { ...MOD_OUT, extra: {} }];
  for (const bad of bads) {
    const { out } = await run("PostToolUse", "claude", { ...POST_RESP, modified_tool_response: bad });
    assert.equal(out.hookSpecificOutput, undefined, JSON.stringify(bad));
    assert.equal(out.systemMessage, NEUTRAL);
  }
  const deepBad = [[{ type: "text", text: 7 }], [{ type: "text" }], [{ type: "text", text: "a" }, { type: "text", text: "b" }], []];
  for (const bad of deepBad) {
    const { out } = await run("PostToolUse", "claude", { ...POST_RESP, modified_tool_response: bad }, { tool: MCP, toolResponse: MCP_RESP });
    assert.equal(out.hookSpecificOutput, undefined, JSON.stringify(bad));
  }
  const read = { type: "text", file: { filePath: "/a", content: ADDR, numLines: 1 } };
  const bad = { type: "text", file: { filePath: "/a", content: 1, numLines: 1 } };
  const { out } = await run("PostToolUse", "claude", { ...POST_RESP, modified_tool_response: bad }, { tool: "Read", toolResponse: read });
  assert.equal(out.hookSpecificOutput, undefined);
});

test("MCP text content and plain string responses are applied in shape", async () => {
  const mod = [{ type: "text", text: "Contact [REDACTED:email]" }];
  const a = await run("PostToolUse", "claude", { ...POST_RESP, modified_tool_response: mod }, { tool: MCP, toolResponse: MCP_RESP });
  assert.deepEqual(a.out.hookSpecificOutput.updatedToolOutput, mod);
  const b = await run("PostToolUse", "claude", { ...POST_RESP, modified_tool_response: undefined }, { tool: MCP, toolResponse: `x ${ADDR}` });
  assert.equal(b.out.hookSpecificOutput.updatedToolOutput, "mail [REDACTED:email]");
});

test("Copilot (unverified), Codex, qwen, Cursor, VS Code: no output rewrite", async () => {
  for (const h of ["copilot", "codex", "qwen", "cursor", "vscode"]) {
    const { out } = await run("PostToolUse", h, POST_RESP);
    const s = JSON.stringify(out);
    assert.ok(!/updatedToolOutput|modifiedResult|updated_mcp_tool_output/.test(s), h);
    assert.equal(out.systemMessage, NEUTRAL, h);
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
