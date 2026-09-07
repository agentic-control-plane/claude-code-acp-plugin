// Context guard (gatewaystack-connect#1072): whole-file reads over a line
// ceiling are sized BEFORE they happen. Ported from Spotify's shunt plugin
// evals (17 Read cases + 17 Bash cases), then extended where their hook had
// known bypasses (offset 0 / limit 0 pass, `head -100` blocks, `head -n 5`
// passes only by accident) — here the EFFECTIVE read is what's measured.
//
// Run with: node --test test/context-guard.test.mjs
//
// Layer 1 tests the pure engine (readIntent + contextGuard + decide).
// Layer 2 spawns the real hook in LOCAL mode against a fixture HOME, so the
// measurement (line counting) and the wire shape are exercised too.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readIntent, contextGuard, decide } from "../bin/decide.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOVERN = join(ROOT, "bin", "govern.mjs");
const DECIDE = join(ROOT, "bin", "decide.mjs");

const FILES = { "/x/big": { lines: 1200, bytes: 48000 }, "/x/small": { lines: 100, bytes: 4000 }, "/x/edge": { lines: 350, bytes: 14000 }, "/x/over": { lines: 351, bytes: 14040 }, "/x/empty": { lines: 0, bytes: 0 } };
const ENFORCE = { default: "allow", rules: {}, contextGuard: { maxLines: 350, mode: "enforce" } };
const SHADOW = { default: "allow", rules: {}, contextGuard: { maxLines: 350, mode: "shadow" } };
const ctx = { files: FILES };

describe("readIntent — Read tool", () => {
  test("whole-file Read is an intent; offset/limit are carried, not treated as a bypass", () => {
    assert.deepEqual(readIntent("Read", { file_path: "/x/big" }), { via: "Read", paths: ["/x/big"], offset: null, limit: null, targeted: false });
    assert.equal(readIntent("Read", { file_path: "/x/big", offset: 100, limit: 50 }).limit, 50);
    assert.equal(readIntent("Read", { file_path: "/x/big", offset: 0, limit: 0 }).offset, null);
  });
  test("missing / empty path → not a read", () => {
    assert.equal(readIntent("Read", {}), null);
    assert.equal(readIntent("Read", { file_path: "" }), null);
  });
  test("Cursor read_file alias", () => {
    assert.equal(readIntent("read_file", { path: "/x/big" }).via, "Read");
  });
});

describe("readIntent — shell dumpers (Spotify bash-hook-evals, corrected)", () => {
  const cases = [
    ["cat /x/big", { via: "Bash.cat", limit: null }],
    ["cat -n /x/big", { via: "Bash.cat", limit: null }],
    ["head /x/big", { via: "Bash.head", limit: 10 }],
    ["head -100 /x/big", { via: "Bash.head", limit: 100 }],
    ["head -n 5 /x/big", { via: "Bash.head", limit: 5 }],
    ["head -n5 /x/big", { via: "Bash.head", limit: 5 }],
    ["head --lines=400 /x/big", { via: "Bash.head", limit: 400 }],
    ["tail -n +20 /x/big", { via: "Bash.tail", limit: 20 }],
    ["tail /x/big", { via: "Bash.tail", limit: 10 }],
    ["less /x/big", { via: "Bash.less", limit: null }],
    ["more /x/big", { via: "Bash.more", limit: null }],
    ['cat "/x/big"', { via: "Bash.cat", limit: null }],
    ["sudo cat /x/big", { via: "Bash.cat", limit: null }],
    ["git status && cat /x/big", { via: "Bash.cat", limit: null }],
    ["bat -r 10:20 /x/big", { via: "Bash.bat", limit: 11 }],
  ];
  for (const [cmd, want] of cases) {
    test(cmd, () => {
      const got = readIntent("Bash", { command: cmd });
      assert.ok(got, "expected an intent");
      assert.equal(got.via, want.via);
      assert.equal(got.limit, want.limit);
      assert.equal(got.paths[0], "/x/big");
    });
  }
  for (const cmd of ["cat /x/big | grep export", "cat /x/big > /tmp/out.txt", "git status", "grep -n 'export' /x/big", "", "cat", "cat -", "sed -n '1,50p' /x/big", "echo hi | cat"]) {
    test(`not a whole-file read: ${JSON.stringify(cmd)}`, () => {
      assert.equal(readIntent("Bash", { command: cmd }), null);
    });
  }
  test("tail -f and byte ranges are targeted", () => {
    assert.equal(readIntent("Bash", { command: "tail -f /x/big" }).targeted, true);
    assert.equal(readIntent("Bash", { command: "head -c 200 /x/big" }).targeted, true);
  });
  test("missing command field → null; Codex array command works", () => {
    assert.equal(readIntent("Bash", {}), null);
    assert.equal(readIntent("shell", { command: ["cat", "/x/big"] }).via, "Bash.cat");
  });
});

describe("contextGuard — sizing (Spotify hook-evals, corrected)", () => {
  const g = (input, policy = ENFORCE.contextGuard, tool = "Read") => contextGuard(readIntent(tool, input), FILES, policy);
  test("small / exactly-at-threshold / empty → pass", () => {
    assert.equal(g({ file_path: "/x/small" }), null);
    assert.equal(g({ file_path: "/x/edge" }), null);
    assert.equal(g({ file_path: "/x/empty" }), null);
  });
  test("just over / large → trip, with the token estimate", () => {
    assert.equal(g({ file_path: "/x/over" }).effectiveLines, 351);
    assert.equal(g({ file_path: "/x/big" }).estTokens, 12000);
  });
  test("targeted reads pass: offset+limit, limit alone, offset near the end", () => {
    assert.equal(g({ file_path: "/x/big", offset: 100, limit: 50 }), null);
    assert.equal(g({ file_path: "/x/big", limit: 50 }), null);
    assert.equal(g({ file_path: "/x/big", offset: 1000 }), null);
  });
  test("offset 0 / limit 0 / offset 1 are NOT a bypass (shunt's known gap)", () => {
    assert.ok(g({ file_path: "/x/big", offset: 0 }));
    assert.ok(g({ file_path: "/x/big", limit: 0 }));
    assert.ok(g({ file_path: "/x/big", offset: 1 }));
  });
  test("nonexistent file (unmeasured) → pass, the tool reports its own error", () => {
    assert.equal(g({ file_path: "/nope" }), null);
  });
  test("head -100 on a big file passes (shunt blocked it); head -n 400 trips", () => {
    assert.equal(g({ command: "head -100 /x/big" }, ENFORCE.contextGuard, "Bash"), null);
    assert.equal(g({ command: "head -n 400 /x/big" }, ENFORCE.contextGuard, "Bash").effectiveLines, 400);
  });
  test("threshold is configurable; junk threshold → guard off", () => {
    assert.ok(g({ file_path: "/x/small" }, { maxLines: 50, mode: "enforce" }));
    assert.equal(g({ file_path: "/x/over" }, { maxLines: 500, mode: "enforce" }), null);
    assert.equal(g({ file_path: "/x/big" }, { maxLines: "abc", mode: "enforce" }), null);
    assert.equal(g({ file_path: "/x/big" }, { maxLines: 350, mode: "off" }), null);
    assert.equal(g({ file_path: "/x/big" }, { maxLines: 350 }), null);
  });
});

describe("decide — enforce denies with a steer, shadow allows and reports", () => {
  test("enforce → deny, reason names the size and the sanctioned path", () => {
    const d = decide("Read", { file_path: "/x/big" }, ENFORCE, ctx);
    assert.equal(d.decision, "deny");
    assert.equal(d.source, "context-guard");
    assert.match(d.reason, /1200 lines \(ceiling 350; ~12000 tokens into context\)\. Read just the section you need \(offset\/limit/);
  });
  test("enforce + action ask → ask; operator guidance replaces the default steer", () => {
    const d = decide("Read", { file_path: "/x/big" }, { ...ENFORCE, contextGuard: { maxLines: 350, mode: "enforce", action: "ask", guidance: "Use the Explore subagent." } }, ctx);
    assert.equal(d.decision, "ask");
    assert.match(d.reason, /\. Use the Explore subagent\.$/);
  });
  test("Codex steer names sed -n", () => {
    const d = decide("shell", { command: "cat /x/big" }, ENFORCE, { ...ctx, harness: "codex" });
    assert.match(d.reason, /sed -n/);
  });
  test("shadow → allow, contextGuard carried for the audit line", () => {
    const d = decide("Read", { file_path: "/x/big" }, SHADOW, ctx);
    assert.equal(d.decision, "allow");
    assert.equal(d.contextGuard.mode, "shadow");
    assert.equal(d.contextGuard.estTokens, 12000);
  });
  test("floor still outranks the guard; a policy deny on Bash.cat still applies under the guard", () => {
    assert.equal(decide("Bash", { command: "cat /x/big && rm -rf ~" }, SHADOW, ctx).source, "hardline");
    assert.equal(decide("Bash", { command: "cat /x/small" }, { ...ENFORCE, rules: { "Bash.cat": "deny" } }, ctx).decision, "deny");
  });
  test("no context (older dispatcher) → guard silently off", () => {
    assert.equal(decide("Read", { file_path: "/x/big" }, ENFORCE).decision, "allow");
  });
});

// ── Layer 2: the real hook, local mode, real files ─────────────────────
let HOME;
let FIX;
before(() => {
  HOME = mkdtempSync(join(tmpdir(), "acp-cg-test-"));
  mkdirSync(join(HOME, ".acp"), { recursive: true });
  copyFileSync(DECIDE, join(HOME, ".acp", "decide.mjs"));
  FIX = join(HOME, "fixtures");
  mkdirSync(FIX);
  writeFileSync(join(FIX, "large.txt"), Array.from({ length: 1200 }, (_, i) => `line ${i + 1}: export const v${i} = ${i};`).join("\n") + "\n");
  writeFileSync(join(FIX, "small.txt"), Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  writeFileSync(join(FIX, "noeol.txt"), Array.from({ length: 351 }, (_, i) => `l${i}`).join("\n")); // no trailing newline: 351 lines
});
after(() => rmSync(HOME, { recursive: true, force: true }));

function hook(inputObj, policy, env = {}) {
  writeFileSync(join(HOME, ".acp", "policy.json"), JSON.stringify(policy));
  const res = spawnSync(process.execPath, [GOVERN], { input: JSON.stringify(inputObj), encoding: "utf8", env: { HOME, PATH: process.env.PATH, ...env }, timeout: 15000 });
  assert.equal(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
  return res.stdout ? JSON.parse(res.stdout) : null;
}
function lastAudit() {
  const p = join(HOME, ".acp", "audit.jsonl");
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}
const pre = (tool_name, tool_input) => ({ tool_name, tool_input, hook_event_name: "PreToolUse", cwd: FIX });

describe("hook (local mode) — measures real files", () => {
  test("enforce: Read of a 1200-line file is denied with the steer; audit carries the ledger", () => {
    const out = hook(pre("Read", { file_path: join(FIX, "large.txt") }), ENFORCE);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /whole-file read of 1200 lines/);
    const a = lastAudit();
    assert.equal(a.source, "context-guard");
    assert.equal(a.contextGuard.lines, 1200);
    assert.ok(a.contextGuard.estTokens > 5000);
  });
  test("enforce: small file, targeted read, cat piped → allowed (silent)", () => {
    assert.equal(hook(pre("Read", { file_path: join(FIX, "small.txt") }), ENFORCE), null);
    assert.equal(hook(pre("Read", { file_path: join(FIX, "large.txt"), offset: 200, limit: 100 }), ENFORCE), null);
    assert.equal(hook(pre("Bash", { command: "cat large.txt | grep export" }), ENFORCE), null);
  });
  test("relative path resolves against cwd; a file without a trailing newline counts its last line", () => {
    const out = hook(pre("Bash", { command: "cat noeol.txt" }), ENFORCE);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /351 lines/);
  });
  test("shadow: allowed, audit line records what would have been blocked", () => {
    assert.equal(hook(pre("Bash", { command: "cat large.txt" }), SHADOW), null);
    const a = lastAudit();
    assert.equal(a.decision, "allow");
    assert.equal(a.contextGuard.mode, "shadow");
    assert.equal(a.contextGuard.via, "Bash.cat");
  });
  test("codex harness: deny text names sed -n", () => {
    const out = hook(pre("shell", { command: "cat large.txt" }), ENFORCE, { ACP_HARNESS: "codex" });
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /sed -n/);
  });
  test("missing file → allowed (the tool surfaces its own error)", () => {
    assert.equal(hook(pre("Read", { file_path: join(FIX, "does-not-exist.txt") }), ENFORCE), null);
  });
  test("no contextGuard in policy → unchanged behavior", () => {
    assert.equal(hook(pre("Read", { file_path: join(FIX, "large.txt") }), { default: "allow", rules: {} }), null);
  });
});
