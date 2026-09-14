// Pins the stale-hook notice contract. Evidence: hook.enforcement_diverged
// on a 0.4.0 hook while main was 0.16.0 — two denies ran anyway. This
// notice is advisory (stderr + the event's existing notice channel), fires
// at most once per 24h, and must never throw into the verdict path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSemver,
  compareSemver,
  readVersionHeaders,
  staleNoticeText,
  shouldNoticeNow,
} from "../lib/staleNotice.mjs";

const realFs = { readFileSync, writeFileSync, mkdirSync };
const DAY = 24 * 60 * 60 * 1000;

test("compareSemver orders numerically and tolerates prefixes", () => {
  assert.equal(compareSemver("0.4.0", "0.16.0"), -1);
  assert.equal(compareSemver("0.16.0", "0.4.0"), 1);
  assert.equal(compareSemver("0.16.0", "0.16.0"), 0);
  assert.equal(compareSemver("1.0.0", "0.99.99"), 1);
  assert.equal(compareSemver("v0.17.0", "0.17.0"), 0);
  assert.equal(compareSemver("0.17.0-rc1", "0.17.0"), 0);
  assert.equal(compareSemver(" 0.9.0 ", "0.10.0"), -1);
});

test("compareSemver is 0 on missing or garbage input", () => {
  assert.equal(compareSemver(undefined, "0.16.0"), 0);
  assert.equal(compareSemver("0.16.0", null), 0);
  assert.equal(compareSemver("", ""), 0);
  assert.equal(compareSemver("latest", "0.16.0"), 0);
  assert.equal(compareSemver("0.16", "0.16.0"), 0);
  assert.equal(compareSemver(16, "0.16.0"), 0);
  assert.equal(compareSemver({}, []), 0);
  assert.equal(parseSemver("garbage"), null);
  assert.deepEqual(parseSemver("v1.2.3"), [1, 2, 3]);
});

test("readVersionHeaders reads both headers case-insensitively", () => {
  const res = { headers: new Headers({ "X-ACP-Latest-Version": "0.17.0", "X-ACP-Min-Good-Version": " 0.12.0 " }) };
  assert.deepEqual(readVersionHeaders(res), { latest: "0.17.0", minGood: "0.12.0" });
});

test("readVersionHeaders is nulls when headers are absent, empty, or unreadable", () => {
  assert.deepEqual(readVersionHeaders({ headers: new Headers() }), { latest: null, minGood: null });
  assert.deepEqual(readVersionHeaders({ headers: new Headers({ "x-acp-latest-version": "  " }) }), { latest: null, minGood: null });
  assert.deepEqual(readVersionHeaders({}), { latest: null, minGood: null });
  assert.deepEqual(readVersionHeaders(null), { latest: null, minGood: null });
  assert.deepEqual(readVersionHeaders({ headers: { get() { throw new Error("boom"); } } }), { latest: null, minGood: null });
});

test("staleNoticeText: outdated", () => {
  assert.equal(
    staleNoticeText({ current: "0.4.0", latest: "0.16.0", minGood: "0.1.0", updateCmd: "acp-update" }),
    "[ACP] governance hook v0.4.0 is outdated (v0.16.0 current). Run: acp-update",
  );
});

test("staleNoticeText: below minimum supported wins over outdated", () => {
  assert.equal(
    staleNoticeText({ current: "0.4.0", latest: "0.16.0", minGood: "0.12.0", updateCmd: "acp-update" }),
    "[ACP] governance hook v0.4.0 is below the minimum supported v0.12.0 — denies may not be enforced. Run: acp-update",
  );
  assert.equal(
    staleNoticeText({ current: "0.4.0", latest: null, minGood: "0.12.0" }),
    "[ACP] governance hook v0.4.0 is below the minimum supported v0.12.0 — denies may not be enforced. Run: acp-update",
  );
});

test("staleNoticeText: current, ahead, or nothing usable → null", () => {
  assert.equal(staleNoticeText({ current: "0.16.0", latest: "0.16.0", minGood: "0.12.0" }), null);
  assert.equal(staleNoticeText({ current: "0.17.0", latest: "0.16.0", minGood: "0.12.0" }), null);
  assert.equal(staleNoticeText({ current: "0.16.0", latest: null, minGood: null }), null);
  assert.equal(staleNoticeText({ current: "0.16.0", latest: "garbage", minGood: "also-garbage" }), null);
  assert.equal(staleNoticeText({ current: undefined, latest: "0.16.0", minGood: "0.12.0" }), null);
});

test("shouldNoticeNow: no marker → true and marker written with now", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-stale-"));
  try {
    const markerPath = join(dir, "nested", ".stale-notice");
    const now = 1_700_000_000_000;
    assert.equal(shouldNoticeNow({ markerPath, now, fs: realFs }), true);
    assert.equal(readFileSync(markerPath, "utf8"), String(now));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldNoticeNow: fresh marker → false and marker untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-stale-"));
  try {
    const markerPath = join(dir, ".stale-notice");
    const then = 1_700_000_000_000;
    writeFileSync(markerPath, String(then));
    assert.equal(shouldNoticeNow({ markerPath, now: then + DAY - 1, fs: realFs }), false);
    assert.equal(readFileSync(markerPath, "utf8"), String(then));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldNoticeNow: stale marker → true and marker rewritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-stale-"));
  try {
    const markerPath = join(dir, ".stale-notice");
    const then = 1_700_000_000_000;
    writeFileSync(markerPath, String(then));
    const now = then + DAY;
    assert.equal(shouldNoticeNow({ markerPath, now, fs: realFs }), true);
    assert.equal(readFileSync(markerPath, "utf8"), String(now));
    // Second call in the same window is silent.
    assert.equal(shouldNoticeNow({ markerPath, now: now + 1000, fs: realFs }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldNoticeNow: garbage marker is treated as absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-stale-"));
  try {
    const markerPath = join(dir, ".stale-notice");
    writeFileSync(markerPath, "not-a-number");
    assert.equal(shouldNoticeNow({ markerPath, now: 5, fs: realFs }), true);
    assert.equal(readFileSync(markerPath, "utf8"), "5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldNoticeNow: fs write throws → false, never throws", () => {
  const throwingFs = {
    readFileSync() { throw new Error("ENOENT"); },
    mkdirSync() { throw new Error("EACCES"); },
    writeFileSync() { throw new Error("EACCES"); },
  };
  assert.equal(shouldNoticeNow({ markerPath: "/nope/.stale-notice", now: 1, fs: throwingFs }), false);
  assert.equal(shouldNoticeNow({ markerPath: "/nope/.stale-notice", now: 1, fs: null }), false);
  assert.equal(shouldNoticeNow({ markerPath: undefined, now: 1, fs: realFs }), false);
});
