// Managed-rollout enrollment gate in bin/govern.mjs (ACP_REQUIRE_ENROLLMENT).
//
// Run with: node --test test/managed-mode.test.mjs
//
// An admin pushes the hook fleet-wide and sets ACP_REQUIRE_ENROLLMENT=1 in
// the managed hook command. On a machine with no workspace credential the
// hook must then BLOCK the call with the enrollment step, instead of the
// default posture (run ungoverned, warn once, log a lapse). Everything else
// — including LOCAL mode — must not satisfy the gate.

import { test, before, after } from "node:test";
import "./_dev-base.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOVERN = join(ROOT, "bin", "govern.mjs");
const DECIDE = join(ROOT, "bin", "decide.mjs");

let HOME;

before(() => {
  HOME = mkdtempSync(join(tmpdir(), "acp-managed-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
});

after(() => rmSync(HOME, { recursive: true, force: true }));

function hook(inputObj, env = {}) {
  const res = spawnSync(process.execPath, [GOVERN], {
    input: JSON.stringify(inputObj),
    encoding: "utf8",
    env: { HOME, PATH: process.env.PATH, ...env },
    timeout: 15000,
  });
  assert.equal(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
  return res.stdout ? JSON.parse(res.stdout) : null;
}

function pre(command, session_id = "s1") {
  return { tool_name: "Bash", tool_input: { command }, hook_event_name: "PreToolUse", session_id };
}

function lapseLines() {
  const p = join(HOME, ".acp", "lapse.log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
}

test("default posture: no credential → allowed, warned, lapse logged as UNGOVERNED", () => {
  const out = hook(pre("git status", "warn-1"));
  assert.ok(out?.systemMessage?.includes("UNGOVERNED"), "expected the loud warning");
  assert.equal(out?.hookSpecificOutput, undefined, "default posture must not deny");
  assert.ok(lapseLines().some((l) => l.includes("\tUNGOVERNED\t")));
});

test("ACP_REQUIRE_ENROLLMENT=1: no credential → PreToolUse denied with the enrollment step", () => {
  const out = hook(pre("git status", "gate-1"), { ACP_REQUIRE_ENROLLMENT: "1" });
  assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny");
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes("/plugin/authorize"));
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes("~/.acp/credentials"));
  assert.ok(lapseLines().some((l) => l.includes("\tBLOCKED\tno-credentials")));
});

test("ACP_REQUIRE_ENROLLMENT=1: denies every call, not just the first in a session", () => {
  const a = hook(pre("ls", "gate-2"), { ACP_REQUIRE_ENROLLMENT: "1" });
  const b = hook(pre("ls", "gate-2"), { ACP_REQUIRE_ENROLLMENT: "1" });
  assert.equal(a?.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(b?.hookSpecificOutput?.permissionDecision, "deny");
});

test("ACP_REQUIRE_ENROLLMENT=1: LOCAL mode does not satisfy the gate", () => {
  copyFileSync(DECIDE, join(HOME, ".acp", "decide.mjs"));
  writeFileSync(join(HOME, ".acp", "policy.json"), JSON.stringify({ default: "allow", rules: {} }));
  try {
    const out = hook(pre("git status", "gate-3"), { ACP_REQUIRE_ENROLLMENT: "1", ACP_LOCAL: "1" });
    assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny", "a local policy must not stand in for the workspace");
  } finally {
    rmSync(join(HOME, ".acp", "policy.json"), { force: true });
    rmSync(join(HOME, ".acp", "decide.mjs"), { force: true });
  }
});

test("ACP_REQUIRE_ENROLLMENT=1: non-PreToolUse events carry the message but no deny", () => {
  const out = hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, session_id: "gate-4" }, { ACP_REQUIRE_ENROLLMENT: "1" });
  assert.ok(out?.systemMessage?.includes("Not enrolled"));
  assert.equal(out?.hookSpecificOutput, undefined);
});

test("ACP_REQUIRE_ENROLLMENT=0 / unset behaves like the default posture", () => {
  const out = hook(pre("git status", "gate-5"), { ACP_REQUIRE_ENROLLMENT: "0" });
  assert.equal(out?.hookSpecificOutput, undefined);
});
