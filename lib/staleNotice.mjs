// Canonical copy of the stale-hook notice logic. bin/govern.mjs carries the
// same logic inline (it is deliberately self-contained, like
// vendor-patterns and receipt); this module exists so tests can pin the
// contract.
//
// Why: a production tenant ran hook 0.4.0 while main was 0.16.0, and two
// hardline/tamper denies RAN ANYWAY on that stale hook
// (hook.enforcement_diverged). The gateway sends X-ACP-Latest-Version and
// X-ACP-Min-Good-Version on every hook response (and latestVersion /
// minGoodVersion in the attest body); the hook compares them with its own
// version and says so — once per 24h, advisory only. It never downloads,
// never executes, never blocks, and touches nothing but a marker under
// ~/.acp.

import { dirname } from "path";

const DAY_MS = 24 * 60 * 60 * 1000;

/** "1.2.3" / "v1.2.3" / "1.2.3-rc1" → [1,2,3]; anything else → null. */
export function parseSemver(v) {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 / 0 / 1. Missing or garbage on either side → 0 (never stale on a
 *  value we can't read). */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** {latest, minGood} from the response headers, nulls when absent or
 *  unreadable. Works on any object with a case-insensitive headers.get. */
export function readVersionHeaders(res) {
  const get = (name) => {
    try {
      const v = res?.headers?.get?.(name);
      return typeof v === "string" && v.trim() ? v.trim() : null;
    } catch {
      return null;
    }
  };
  return {
    latest: get("x-acp-latest-version"),
    minGood: get("x-acp-min-good-version"),
  };
}

/** The one line the human sees, or null when the hook is current (or the
 *  server sent nothing usable). Below-minimum wins over merely-outdated. */
export function staleNoticeText({ current, latest, minGood, updateCmd = "acp-update" }) {
  if (minGood && compareSemver(current, minGood) < 0) {
    return `[ACP] governance hook v${current} is below the minimum supported v${minGood} — denies may not be enforced. Run: ${updateCmd}`;
  }
  if (latest && compareSemver(current, latest) < 0) {
    return `[ACP] governance hook v${current} is outdated (v${latest} current). Run: ${updateCmd}`;
  }
  return null;
}

/** True at most once per ttlMs. The marker (epoch ms of the last notice)
 *  is written BEFORE returning true so a crash mid-notice cannot cause a
 *  repeat. Every failure → false: an unwritable ~/.acp must never turn an
 *  advisory line into per-call noise. Sync by design — no awaits before
 *  the verdict. */
export function shouldNoticeNow({ markerPath, now = Date.now(), ttlMs = DAY_MS, fs }) {
  try {
    let last = 0;
    try {
      last = Number(fs.readFileSync(markerPath, "utf8").trim()) || 0;
    } catch {
      /* no marker yet */
    }
    if (last && now - last < ttlMs) return false;
    fs.mkdirSync(dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, String(now));
    return true;
  } catch {
    return false;
  }
}
