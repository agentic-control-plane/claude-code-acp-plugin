// Session-receipt helpers (gatewaystack-connect#606). The contract:
// counters are best-effort and silent, the receipt says only what
// happened, links THIS session, and never fires for tool-free sessions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, utimesSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bumpStats, readStats, clearStats, buildReceiptMessage, statsPath } from "../lib/receipt.mjs";

const CONSOLE = "https://cloud.agenticcontrolplane.com";
const dir = () => mkdtempSync(join(tmpdir(), "acp-receipt-"));

test("bump/read roundtrip accumulates across calls", () => {
  const d = dir();
  bumpStats(d, "s1", { calls: 1 });
  bumpStats(d, "s1", { calls: 1, notices: 1 });
  bumpStats(d, "s1", { calls: 1, flagged: 1 });
  assert.deepEqual(readStats(d, "s1"), { calls: 3, flagged: 1, notices: 1 });
});

test("sessions do not bleed into each other", () => {
  const d = dir();
  bumpStats(d, "s1", { calls: 5 });
  bumpStats(d, "s2", { calls: 1 });
  assert.equal(readStats(d, "s1").calls, 5);
  assert.equal(readStats(d, "s2").calls, 1);
});

test("hostile session ids cannot escape the stats dir", () => {
  const d = dir();
  const evil = "../../etc/passwd";
  assert.ok(statsPath(d, evil).startsWith(d));
  bumpStats(d, evil, { calls: 1 });
  assert.equal(readStats(d, evil).calls, 1);
});

test("unknown/absent session id is a silent no-op", () => {
  const d = dir();
  bumpStats(d, "unknown", { calls: 1 });
  bumpStats(d, "", { calls: 1 });
  bumpStats(d, undefined, { calls: 1 });
  assert.equal(readdirSync(d).length, 0);
});

test("corrupt stats file reads as zeros, not a crash", () => {
  const d = dir();
  writeFileSync(statsPath(d, "s1"), "not json{{{");
  assert.deepEqual(readStats(d, "s1"), { calls: 0, flagged: 0, notices: 0 });
});

test("receipt message: only what happened, deep link to this session", () => {
  const msg = buildReceiptMessage({ calls: 214, flagged: 0, notices: 3 }, "sess-9", CONSOLE);
  assert.equal(
    msg,
    "[ACP] Session receipt: 214 tool calls governed · 3 shadow notices — review this session: https://cloud.agenticcontrolplane.com/sessions/sess-9 · /acp-status shows what enforcement would have held",
  );
  const flaggedMsg = buildReceiptMessage({ calls: 2, flagged: 1, notices: 0 }, "s", CONSOLE);
  assert.ok(flaggedMsg.includes("2 tool calls governed · 1 flagged"));
  assert.ok(!flaggedMsg.includes("shadow"));
});

test("singular spellings", () => {
  const msg = buildReceiptMessage({ calls: 1, flagged: 0, notices: 1 }, "s", CONSOLE);
  assert.ok(msg.includes("1 tool call governed"));
  assert.ok(msg.includes("1 shadow notice —"));
});

test("no governed calls → no receipt (tool-free sessions stay silent)", () => {
  assert.equal(buildReceiptMessage({ calls: 0, flagged: 0, notices: 0 }, "s", CONSOLE), null);
  assert.equal(buildReceiptMessage(null, "s", CONSOLE), null);
});

test("session id is URL-encoded in the link", () => {
  const msg = buildReceiptMessage({ calls: 1, flagged: 0, notices: 0 }, "a b/c", CONSOLE);
  assert.ok(msg.endsWith("/sessions/a%20b%2Fc"));
});

test("clearStats removes the session file and prunes week-old leftovers", () => {
  const d = dir();
  bumpStats(d, "current", { calls: 1 });
  bumpStats(d, "crashed", { calls: 1 });
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  utimesSync(statsPath(d, "crashed"), old, old);
  clearStats(d, "current");
  assert.ok(!existsSync(statsPath(d, "current")));
  assert.ok(!existsSync(statsPath(d, "crashed")));
});
