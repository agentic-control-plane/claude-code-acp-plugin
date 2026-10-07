// gatewaystack-connect#692/#627: a deny should redirect the agent, not stop it.
//
// Two failures, both fixed here. First, the reason never reached the model:
// Claude Code reads hookSpecificOutput.permissionDecisionReason into the
// blocking error the model sees (hooks.ts:598-610), while systemMessage goes
// to the human. The cloud path set only systemMessage, so every ACP deny
// arrived as the bare fallback "Hook PreToolUse:<tool> denied this tool" —
// indistinguishable from a harness bug, and impossible to re-plan on.
//
// Second, nothing told the agent what to do next. A denied call is one
// refused operation, not a refused task, and a capability an agent thinks it
// should have is proposable. Floors are the exception: they cannot be allowed
// by policy or approval, so offering the proposal flow there would send the
// agent to file something no human can approve.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

/** Runs the hook and returns what each audience actually receives. */
function runHook(base, { tier = "interactive" } = {}) {
  return new Promise((resolve) => {
    const env = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      ACP_SELF_HOST: "1", ACP_GOVERN_BASE: base,
      ACP_BEARER_TOKEN: "gsk_test_token",
      ACP_CLIENT: "test",
      ACP_FIRST_ATTEMPT_MS: "400",
      ACP_RETRY_ATTEMPT_MS: "400",
      CLAUDE_CODE_ENTRYPOINT: tier === "unattended" ? "sdk-cli" : "cli",
    };
    const child = spawn("node", [GOVERN], { env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => {
      let decision = "allow", toModel = "", toHuman = "";
      if (out.trim()) {
        try {
          const j = JSON.parse(out);
          decision = j?.hookSpecificOutput?.permissionDecision ?? "allow";
          toModel = j?.hookSpecificOutput?.permissionDecisionReason ?? "";
          toHuman = j?.systemMessage ?? "";
        } catch { decision = "unparseable"; }
      }
      resolve({ decision, toModel, toHuman });
    });
    child.stdin.end(JSON.stringify({
      session_id: "t", cwd: "/tmp", hook_event_name: "PreToolUse",
      tool_name: "Bash", tool_use_id: "t1",
      tool_input: { command: "echo hi" },
      permission_mode: "default",
    }));
  });
}

test("a policy deny reaches the MODEL, not just the human", async () => {
  const { server, base } = await stubGateway(200, {
    decision: "deny",
    reason: "denied by api tier policy for Bash.curl",
  });
  try {
    const r = await runHook(base);
    assert.equal(r.decision, "deny");
    // The regression this exists to prevent: a deny whose reason lives only
    // in systemMessage looks like a generic harness block to the agent.
    assert.notEqual(r.toModel, "", "permissionDecisionReason must be set — the model sees nothing else");
    assert.match(r.toModel, /Bash\.curl/, "the actual policy reason must survive into the model-visible field");
    assert.match(r.toHuman, /Bash\.curl/, "the human keeps their message too");
  } finally { server.close(); }
});

test("a proposable deny tells the agent to keep working and how to ask", async () => {
  const { server, base } = await stubGateway(200, {
    decision: "deny",
    reason: "denied by api tier policy for Bash.curl",
  });
  try {
    const r = await runHook(base);
    assert.match(r.toModel, /acp_propose_rule/, "the agent must be told the capability is proposable");
    assert.match(r.toModel, /ONE operation/, "and that the task itself is not over");
  } finally { server.close(); }
});

test("a hardline floor does NOT offer a proposal it can never honour", async () => {
  const { server, base } = await stubGateway(200, {
    decision: "deny",
    reason: "hardline floor: system shutdown/reboot — blocked unconditionally; this pattern cannot be allowed by policy or approval",
  });
  try {
    const r = await runHook(base);
    assert.equal(r.decision, "deny");
    assert.doesNotMatch(r.toModel, /acp_propose_rule/,
      "floors cannot be allowed by policy or approval — pointing at the proposal flow wastes a human's review on something they cannot approve");
    assert.match(r.toModel, /cannot be allowed by policy or approval/);
    assert.match(r.toModel, /do not retry/i, "and it must not invite a workaround");
  } finally { server.close(); }
});

test("a governance-surface deny is also unproposable", async () => {
  const { server, base } = await stubGateway(200, {
    decision: "deny",
    reason: "governance surface: edits ~/.acp/policy.json — governance machinery is human-only",
  });
  try {
    const r = await runHook(base);
    assert.doesNotMatch(r.toModel, /acp_propose_rule/);
  } finally { server.close(); }
});

test("an outage deny says it is availability, not a judgment about the call", async () => {
  // 5xx keeps the outage posture; unattended tier fails closed (#385).
  const { server, base } = await stubGateway(503, {});
  try {
    const r = await runHook(base, { tier: "unattended" });
    assert.equal(r.decision, "deny");
    assert.match(r.toModel, /NOT a policy judgment/,
      "retry is right for an outage and wrong for a policy deny — the agent can only choose if it is told which this is");
    assert.doesNotMatch(r.toModel, /acp_propose_rule/, "there is no rule to propose for an outage");
  } finally { server.close(); }
});

// The server types every verdict by what the agent should DO (#692). The
// hook must act on that field rather than on the prose, so reason wording
// can change without silently changing the instruction the agent follows.
test("kind:retry tells the agent to wait and retry, NOT to give up or reroute", async () => {
  const { server, base } = await stubGateway(200, {
    decision: "deny",
    kind: "retry",
    reason: "rate-limited: subagent (61/60 per minute)",
  });
  try {
    const r = await runHook(base);
    assert.equal(r.decision, "deny");
    assert.match(r.toModel, /task is NOT over/i);
    assert.match(r.toModel, /retry this exact call/i);
    assert.match(r.toModel, /Do not rewrite it to dodge the limit/i);
    // A throttle is not a capability question — proposing a rule is the
    // wrong move and would put noise in front of a human.
    assert.doesNotMatch(r.toModel, /acp_propose_rule/);
  } finally { server.close(); }
});

test("kind:terminal overrides the proposable default even on unfamiliar wording", async () => {
  const { server, base } = await stubGateway(200, {
    decision: "deny",
    kind: "terminal",
    // Deliberately NOT the "hardline floor:" prefix the fallback regex knows.
    reason: "immutable platform rule: credential exfiltration",
  });
  try {
    const r = await runHook(base);
    assert.doesNotMatch(r.toModel, /acp_propose_rule/,
      "the typed kind must win over the prose fallback");
    assert.match(r.toModel, /do not retry/i);
  } finally { server.close(); }
});

test("kind:reformulate keeps the propose path", async () => {
  const { server, base } = await stubGateway(200, {
    decision: "deny",
    kind: "reformulate",
    reason: "denied by api tier policy for Bash.curl",
  });
  try {
    const r = await runHook(base);
    assert.match(r.toModel, /acp_propose_rule/);
  } finally { server.close(); }
});

test("an older gateway with no kind still gets the right steer", async () => {
  // Back-compat: the field is additive, so a gateway that predates it must
  // behave exactly as before rather than falling into a default that
  // invites an agent to propose its way around a floor.
  const { server, base } = await stubGateway(200, {
    decision: "deny",
    reason: "hardline floor: fork bomb — blocked unconditionally",
  });
  try {
    const r = await runHook(base);
    assert.doesNotMatch(r.toModel, /acp_propose_rule/);
    assert.match(r.toModel, /do not retry/i);
  } finally { server.close(); }
});

test("segment evidence from the server reaches the model intact", async () => {
  const { server, base } = await stubGateway(200, {
    decision: "deny",
    kind: "reformulate",
    reason:
      "denied by api tier policy for Bash.rm. This call had 3 operations and only operation 2 " +
      "(`rm -rf /tmp/x` → Bash.rm) matched. Not matched: 1. `echo hi`, 3. `cat README`.",
  });
  try {
    const r = await runHook(base);
    // The blast radius is the part that lets an agent re-plan instead of
    // treating the whole call as suspect.
    assert.match(r.toModel, /operation 2/);
    assert.match(r.toModel, /cat README/);
  } finally { server.close(); }
});

test("an approval request explains the out-of-band route", async () => {
  const { server, base } = await stubGateway(200, {
    decision: "ask",
    reason: "step_up by api tier policy for Bash.gcloud",
  });
  try {
    const r = await runHook(base);
    assert.equal(r.decision, "ask");
    assert.match(r.toModel, /Bash\.gcloud/);
    assert.match(r.toModel, /ONE operation/);
  } finally { server.close(); }
});
