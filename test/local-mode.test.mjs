// End-to-end tests for LOCAL mode in bin/govern.mjs (`install.sh --local`).
//
// Run with: node --test test/local-mode.test.mjs
//
// Each test spawns the real hook exactly the way a harness does — JSON on
// stdin, decision JSON on stdout — against a throwaway fixture HOME. The
// regression these guard: the canonical govern.mjs used to exit silently
// whenever no workspace token existed, which turned every fresh --local
// install into a no-op (no floor, no policy, no audit) while the installer
// printed "local mode active".

import { test, before, after } from "node:test";
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
  HOME = mkdtempSync(join(tmpdir(), "acp-local-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  copyFileSync(DECIDE, join(HOME, ".acp", "decide.mjs"));
  writeFileSync(join(HOME, ".acp", "policy.json"), JSON.stringify({
    default: "allow",
    rules: { "Bash.curl": "ask", "Bash.rm": "ask" },
  }));
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

function pre(command) {
  return { tool_name: "Bash", tool_input: { command }, hook_event_name: "PreToolUse" };
}

function auditLines() {
  const p = join(HOME, ".acp", "audit.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("floor: rm -rf ~ is denied with no token, no network", () => {
  const out = hook(pre("rm -rf ~/"));
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.systemMessage, /\[ACP·local\] Blocked/);
});

test("floor: catastrophe laundered through bash -c after && is still denied", () => {
  const out = hook(pre('echo cleanup && bash -c "rm -rf ~"'));
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
});

test("floor: force-push to main is denied", () => {
  const out = hook(pre("git push --force origin main"));
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /force-push/);
});

test("policy: curl maps to ask under the seeded policy", () => {
  const out = hook(pre("curl -s https://api.stripe.com/v1/charges"));
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
});

test("policy: unmatched command is a silent allow but still audited", () => {
  const beforeCount = auditLines().length;
  const out = hook(pre("npm test"));
  assert.equal(out, null, "allow must produce no stdout (silent)");
  const lines = auditLines();
  assert.equal(lines.length, beforeCount + 1);
  const last = lines[lines.length - 1];
  assert.equal(last.decision, "allow");
  assert.equal(last.classified, "Bash.npm.test");
});

test("codex harness: ask becomes deny with the policy fix in the message", () => {
  const out = hook(pre("curl -s https://api.stripe.com/v1/charges"), { ACP_HARNESS: "codex", ACP_CLIENT: "codex" });
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.systemMessage, /policy\.json/);
});

test("PostToolUse: logged to audit, no decision emitted", () => {
  const beforeCount = auditLines().length;
  const out = hook({ tool_name: "Bash", tool_input: { command: "npm test" }, hook_event_name: "PostToolUse" });
  assert.equal(out, null);
  const last = auditLines()[auditLines().length - 1];
  assert.equal(last.event, "post");
  assert.equal(auditLines().length, beforeCount + 1);
});

test("audit: every decision above left a line with decision + source", () => {
  const lines = auditLines();
  assert.ok(lines.length >= 5);
  for (const l of lines) {
    assert.ok(l.ts && l.tool, JSON.stringify(l));
    if (l.event === "pre") assert.ok(["allow", "ask", "deny"].includes(l.decision));
  }
  assert.ok(lines.some((l) => l.decision === "deny" && l.source === "hardline"));
});

test("engine missing from HOME: bundled decide.mjs fallback keeps the floor", () => {
  const bare = mkdtempSync(join(tmpdir(), "acp-local-noengine-"));
  mkdirSync(join(bare, ".acp"), { recursive: true });
  writeFileSync(join(bare, ".acp", "policy.json"), JSON.stringify({ default: "allow", rules: {} }));
  try {
    // No decide.mjs in this HOME — but the copy bundled next to govern.mjs
    // is the designed fallback, so this must still DECIDE (floor works).
    const res = spawnSync(process.execPath, [GOVERN], {
      input: JSON.stringify(pre("rm -rf ~/")),
      encoding: "utf8",
      env: { HOME: bare, PATH: process.env.PATH },
      timeout: 15000,
    });
    const out = JSON.parse(res.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny", "bundled decide.mjs fallback must keep the floor");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("no token, no policy.json, no ACP_LOCAL: proceeds but warns UNGOVERNED once per session", () => {
  // Behavior changed with the front-door fix (PR #9): an uncredentialed
  // hook must never exit silently — that silence is what let installs sit
  // ungoverned for weeks. First call prints the banner; subsequent calls
  // in the same session stay quiet (the marker dedupes).
  // Since plugin#29 the two floors apply here too, so the fixture is a
  // benign command — a catastrophic one is now denied (offline-floor.test).
  const bare = mkdtempSync(join(tmpdir(), "acp-local-off-"));
  try {
    const first = spawnSync(process.execPath, [GOVERN], {
      input: JSON.stringify(pre("git status")),
      encoding: "utf8",
      env: { HOME: bare, PATH: process.env.PATH },
      timeout: 15000,
    });
    assert.equal(first.status, 0);
    const out = JSON.parse(first.stdout);
    assert.match(out.systemMessage, /UNGOVERNED: no API key found/);
    assert.equal(out.hookSpecificOutput, undefined, "must not deny — never brick, just warn");

    const second = spawnSync(process.execPath, [GOVERN], {
      input: JSON.stringify(pre("git status")),
      encoding: "utf8",
      env: { HOME: bare, PATH: process.env.PATH },
      timeout: 15000,
    });
    assert.equal(second.status, 0);
    assert.equal(second.stdout, "", "same session: banner is deduped");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("ACP_LOCAL=1 with no policy file: floor still active, default allow for the rest", () => {
  const bare = mkdtempSync(join(tmpdir(), "acp-local-envonly-"));
  mkdirSync(join(bare, ".acp"), { recursive: true });
  copyFileSync(DECIDE, join(bare, ".acp", "decide.mjs"));
  try {
    const denied = spawnSync(process.execPath, [GOVERN], {
      input: JSON.stringify(pre("git push -f origin main")),
      encoding: "utf8",
      env: { HOME: bare, PATH: process.env.PATH, ACP_LOCAL: "1" },
      timeout: 15000,
    });
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
    const allowed = spawnSync(process.execPath, [GOVERN], {
      input: JSON.stringify(pre("ls -la")),
      encoding: "utf8",
      env: { HOME: bare, PATH: process.env.PATH, ACP_LOCAL: "1" },
      timeout: 15000,
    });
    assert.equal(allowed.stdout, "");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
