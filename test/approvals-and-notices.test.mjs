// Tests for the #1346/#1350 approval-refresh loop and the #1349
// agent_notice channel in bin/govern.mjs:
//   - UserPromptSubmit polls GET /plugin/intents/approvals for this
//     session's pending held calls and, for any that just turned
//     "approved", adds a model-facing retry line.
//   - /acp-approve (UserPromptExpansion) lists the session's pending held
//     calls from local state, same pattern as /acp-status.
//   - agent_notice on a PostToolUse response reaches the model via
//     hookSpecificOutput.additionalContext under Claude Code, and falls
//     back to systemMessage under Codex/Copilot (neither honors
//     additionalContext outside SessionStart).
//
// Run with: node --test test/approvals-and-notices.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Loopback stubs are reached via ~/.acp/dev_base_override (#50); the shim
// writes it into the temp HOME when ACP_TEST_DEV_BASE=1 is in the spawn env.
import "./_dev-base.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOVERN = join(ROOT, "bin", "govern.mjs");
const LOOPBACK = [127, 0, 0, 1].join(".");

let HOME;
let server;
let baseUrl;
let seen = [];
let nextToolUse = { decision: "allow" };
let nextToolOutput = { action: "pass" };
let nextApprovals = { approvals: [] };

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "acp-approvals-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  writeFileSync(join(HOME, ".acp", "credentials"), "gsk_test_deadbeef\n");

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url });
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/plugin/intents/approvals")) {
        res.end(JSON.stringify(nextApprovals));
      } else if (req.url.endsWith("/govern/tool-use")) {
        res.end(JSON.stringify(nextToolUse));
      } else if (req.url.endsWith("/govern/tool-output")) {
        res.end(JSON.stringify(nextToolOutput));
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
  seen = [];
  nextToolUse = { decision: "allow" };
  nextToolOutput = { action: "pass" };
  nextApprovals = { approvals: [] };
});

function runHook(input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GOVERN], {
      env: { HOME, PATH: process.env.PATH, ACP_TEST_DEV_BASE: "1", ACP_GOVERN_BASE: baseUrl, ACP_API_BASE: baseUrl, ...env },
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

const preToolUse = (sid, overrides = {}) => ({
  hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf build/" },
  session_id: sid, permission_mode: "default", ...overrides,
});
const promptSubmit = (sid, overrides = {}) => ({
  hook_event_name: "UserPromptSubmit", session_id: sid, ...overrides,
});
const expansion = (sid, overrides = {}) => ({
  hook_event_name: "UserPromptExpansion",
  command_name: "agentic-control-plane:acp-approve",
  command_args: "", session_id: sid, ...overrides,
});

const APPROVAL_ID = "5f00abcd-0000-4000-8000-000000000000";
// decision "deny" = held for a console/email decision (the deny-and-wait
// path); "ask" = a native ask answered in the terminal under Claude Code.
async function holdOneCall(sid, { decision = "deny", overrides = {}, env = {} } = {}) {
  nextToolUse = {
    decision, reason: decision === "deny"
      ? `approval-requested:${APPROVAL_ID} — call acp_wait_approval with approval_id ${APPROVAL_ID}`
      : "approval required",
    kind: "delegate",
    approval_id: APPROVAL_ID, approval_code: "5F00",
    approval_url: `https://cloud.agenticcontrolplane.com/approvals?id=${APPROVAL_ID}`,
    approval_summary: "Bash · rm -rf build/",
  };
  return runHook(preToolUse(sid, overrides), env);
}
const approvedNow = () => ({ approvals: [{ id: APPROVAL_ID, code: "5F00", status: "approved", summary: "x", created_at: new Date().toISOString() }] });
const pendingFile = (sid) => join(HOME, ".acp", "session-stats", `${sid}.pending.json`);

test("UserPromptSubmit polls approvals for pending ids and stays silent when nothing changed", async () => {
  const sid = "sess-poll-nochange";
  await holdOneCall(sid);
  nextApprovals = { approvals: [{ id: APPROVAL_ID, code: "5F00", status: "pending", summary: "x", created_at: new Date().toISOString() }] };
  const out = await runHook(promptSubmit(sid));
  const req = seen.find((s) => s.url.startsWith("/plugin/intents/approvals"));
  assert.ok(req, "expected a GET to /plugin/intents/approvals");
  assert.ok(req.url.includes(APPROVAL_ID), "the pending id should be in the query");
  assert.equal(out, null, "still pending — no new context");
});

test("UserPromptSubmit adds a model-facing retry line when a held call was just approved", async () => {
  const sid = "sess-poll-approved";
  await holdOneCall(sid);
  nextApprovals = { approvals: [{ id: APPROVAL_ID, code: "5F00", status: "approved", summary: "x", created_at: new Date().toISOString() }] };
  const out = await runHook(promptSubmit(sid));
  assert.ok(out, "expected output on stdout");
  assert.equal(out.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /ACP-5F00 was approved — retry the identical call now\./);

  // The same approval must not be re-announced on the next prompt.
  const out2 = await runHook(promptSubmit(sid));
  assert.equal(out2, null, "an already-notified approval must not repeat");
});

test("UserPromptSubmit under Codex/Copilot also writes the retry line to systemMessage", async () => {
  const sid = "sess-poll-codex";
  await holdOneCall(sid);
  nextApprovals = { approvals: [{ id: APPROVAL_ID, code: "5F00", status: "approved", summary: "x", created_at: new Date().toISOString() }] };
  const out = await runHook(promptSubmit(sid), { ACP_HARNESS: "codex" });
  assert.equal(out.hookSpecificOutput, undefined);
  assert.match(out.systemMessage, /ACP-5F00 was approved/);
});

test("a terminal ask answered yes and run never comes back as a retry line", async () => {
  const sid = "sess-terminal-ran";
  const pre = await holdOneCall(sid, { decision: "ask", overrides: { tool_use_id: "toolu_term_1" } });
  assert.equal(pre.hookSpecificOutput.permissionDecision, "ask");
  // The person said yes in the harness prompt; the call ran.
  await runHook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "rm -rf build/" }, tool_response: "ok", session_id: sid, tool_use_id: "toolu_term_1" });
  assert.deepEqual(JSON.parse(readFileSync(pendingFile(sid), "utf8")), [], "the settled row is dropped");
  seen = [];
  nextApprovals = approvedNow();
  const out = await runHook(promptSubmit(sid));
  assert.equal(out, null);
  assert.equal(seen.length, 0, "nothing left to poll");
});

test("a terminal ask never produces a retry line even if the row is still pending (answered no, or no PostToolUse)", async () => {
  const sid = "sess-terminal-no";
  await holdOneCall(sid, { decision: "ask", overrides: { tool_use_id: "toolu_term_2" } });
  nextApprovals = approvedNow();
  const out = await runHook(promptSubmit(sid));
  assert.equal(out, null);
  const row = JSON.parse(readFileSync(pendingFile(sid), "utf8"))[0];
  assert.equal(row.status, "approved", "the status is still merged so the row leaves the pending list");
});

test("a console hold approved later produces exactly one retry line", async () => {
  const sid = "sess-console-once";
  const pre = await holdOneCall(sid, { overrides: { tool_use_id: "toolu_console_1" } });
  assert.equal(pre.hookSpecificOutput.permissionDecision, "deny");
  const row = JSON.parse(readFileSync(pendingFile(sid), "utf8"))[0];
  assert.equal(row.decidedIn, "console");
  assert.equal(row.toolUseId, "toolu_console_1");
  assert.equal(row.agentId, undefined, "main thread rows carry no owner");
  nextApprovals = approvedNow();
  const out = await runHook(promptSubmit(sid));
  const lines = out.hookSpecificOutput.additionalContext.split("\n");
  assert.deepEqual(lines, ["ACP-5F00 was approved — retry the identical call now."]);
  assert.equal(out.systemMessage, undefined);
  assert.equal(await runHook(promptSubmit(sid)), null, "never twice");
});

test("a subagent's approved hold gives the parent model nothing, the person an informational line", async () => {
  const sid = "sess-subagent-owned";
  await holdOneCall(sid, { overrides: { tool_use_id: "toolu_sub_1", agent_id: "agent-sub-1" } });
  assert.equal(JSON.parse(readFileSync(pendingFile(sid), "utf8"))[0].agentId, "agent-sub-1");
  nextApprovals = approvedNow();
  const out = await runHook(promptSubmit(sid));
  assert.equal(out.hookSpecificOutput, undefined, "no additionalContext for the parent");
  assert.equal(out.systemMessage, "ACP-5F00, held in a subagent, was approved.");
  assert.equal(await runHook(promptSubmit(sid)), null, "never twice");
});

test("a subagent's approved hold under Codex is the informational line only", async () => {
  const sid = "sess-subagent-codex";
  await holdOneCall(sid, { overrides: { agent_id: "agent-sub-2" }, env: { ACP_HARNESS: "codex" } });
  nextApprovals = approvedNow();
  const out = await runHook(promptSubmit(sid), { ACP_HARNESS: "codex" });
  assert.equal(out.hookSpecificOutput, undefined);
  assert.equal(out.systemMessage, "ACP-5F00, held in a subagent, was approved.");
});

test("a legacy row without the new fields behaves as a main-thread console hold", async () => {
  const sid = "sess-legacy-row";
  mkdirSync(join(HOME, ".acp", "session-stats"), { recursive: true });
  writeFileSync(pendingFile(sid), JSON.stringify([{
    id: APPROVAL_ID, code: "5F00", url: null, summary: "Bash · rm -rf build/",
    status: "pending", notified: false, at: new Date().toISOString(),
  }]));
  // An unrelated PostToolUse must not drop a row it cannot match.
  await runHook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_response: "x", session_id: sid, tool_use_id: "toolu_other" });
  nextApprovals = approvedNow();
  const out = await runHook(promptSubmit(sid));
  assert.match(out.hookSpecificOutput.additionalContext, /^ACP-5F00 was approved — retry the identical call now\.$/);
});

test("UserPromptSubmit with no pending calls makes no network request", async () => {
  const out = await runHook(promptSubmit("sess-poll-empty"));
  assert.equal(out, null);
  assert.equal(seen.length, 0);
});

test("UserPromptSubmit from a subagent never polls or prints", async () => {
  const sid = "sess-poll-subagent";
  await holdOneCall(sid);
  const out = await runHook(promptSubmit(sid, { agent_id: "sub-1" }));
  assert.equal(out, null);
  assert.equal(seen.length, 1, "only the preceding holdOneCall's tool-use request should be seen");
});

test("/acp-approve lists this session's pending held calls with code, summary and link", async () => {
  const sid = "sess-approve-list";
  await holdOneCall(sid);
  const out = await runHook(expansion(sid));
  assert.equal(out.decision, "block");
  assert.match(out.reason, /ACP-5F00/);
  assert.match(out.reason, /Bash · rm -rf build\//);
  assert.match(out.reason, new RegExp(`approvals\\?id=${APPROVAL_ID}`));
});

test("/acp-approve <code> filters to the one matching call", async () => {
  const sid = "sess-approve-filter";
  await holdOneCall(sid);
  const out = await runHook(expansion(sid, { command_args: "ACP-5F00" }));
  assert.equal(out.decision, "block");
  assert.match(out.reason, /ACP-5F00/);

  const miss = await runHook(expansion(sid, { command_args: "ACP-0000" }));
  assert.match(miss.reason, /No pending held call matches/);
});

test("/acp-approve with nothing held says so", async () => {
  const out = await runHook(expansion("sess-approve-empty"));
  assert.match(out.reason, /Nothing held for approval/);
});

test("agent_notice on PostToolUse reaches the model via additionalContext under Claude Code", async () => {
  nextToolOutput = { action: "pass", agent_notice: "Context is large — consider /acp-apply compact-earlier.", notice_lever: "context_threshold" };
  const out = await runHook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_response: "x", session_id: "sess-agent-notice-cc" });
  assert.equal(out.hookSpecificOutput?.hookEventName, "PostToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /consider \/acp-apply compact-earlier/);
});

test("agent_notice falls back to systemMessage under Codex (no additionalContext outside SessionStart)", async () => {
  nextToolOutput = { action: "pass", agent_notice: "Context is large — consider /acp-apply compact-earlier.", notice_lever: "context_threshold" };
  const out = await runHook(
    { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_response: "x", session_id: "sess-agent-notice-codex" },
    { ACP_HARNESS: "codex" },
  );
  assert.equal(out.hookSpecificOutput, undefined);
  assert.match(out.systemMessage, /consider \/acp-apply compact-earlier/);
});

test("agent_notice control characters are stripped before reaching the model", async () => {
  nextToolOutput = { action: "pass", agent_notice: "line one\u001b[31m\u0007 line two" };
  const out = await runHook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_response: "x", session_id: "sess-agent-notice-clean" });
  assert.ok(!out.hookSpecificOutput.additionalContext.includes("\u001b"));
  assert.ok(!out.hookSpecificOutput.additionalContext.includes("\u0007"));
});

test("no agent_notice → no hookSpecificOutput on PostToolUse", async () => {
  nextToolOutput = { action: "pass" };
  const out = await runHook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_response: "x", session_id: "sess-agent-notice-none" });
  assert.equal(out, null);
});
