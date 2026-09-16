// Canonical copy of the session-receipt logic (gatewaystack-connect#606).
// bin/govern.mjs carries the same logic inline (it is deliberately
// self-contained, like vendor-patterns and attestation); this module
// exists so tests can pin the contract.
//
// The retention finding behind this (2026-08-13): churned users' sessions
// were 100% silent allows — the product worked and appeared to do nothing.
// The receipt is one honest line at session end: how many calls ACP
// governed, anything it said along the way, and a deep link to THIS
// session's timeline in the console. Counters live in tiny per-session
// JSON files under ~/.acp/session-stats/; every helper here is
// best-effort and silent — a stats failure must never affect a session.

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, statSync } from "fs";
import { join } from "path";

/** Session ids come from the harness — sanitize before using as a filename. */
export function statsPath(dir, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return join(dir, `${safe}.json`);
}

export function readStats(dir, sessionId) {
  try {
    const raw = JSON.parse(readFileSync(statsPath(dir, sessionId), "utf8"));
    return {
      calls: Number(raw.calls) || 0,
      flagged: Number(raw.flagged) || 0,
      notices: Number(raw.notices) || 0,
    };
  } catch {
    return { calls: 0, flagged: 0, notices: 0 };
  }
}

/** Read-merge-write; silent on any failure. delta: {calls?, flagged?, notices?} */
export function bumpStats(dir, sessionId, delta) {
  if (!sessionId || sessionId === "unknown") return;
  try {
    mkdirSync(dir, { recursive: true });
    const cur = readStats(dir, sessionId);
    const next = {
      calls: cur.calls + (delta.calls ?? 0),
      flagged: cur.flagged + (delta.flagged ?? 0),
      notices: cur.notices + (delta.notices ?? 0),
    };
    writeFileSync(statsPath(dir, sessionId), JSON.stringify(next));
  } catch { /* never let bookkeeping touch the call path */ }
}

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Remove this session's file and any leftovers from crashed sessions. */
export function clearStats(dir, sessionId) {
  try { unlinkSync(statsPath(dir, sessionId)); } catch { /* absent is fine */ }
  try {
    const cutoff = Date.now() - STALE_MS;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch { /* skip */ }
    }
  } catch { /* prune is opportunistic */ }
}

/**
 * One line, only what happened, deep link to this session. Returns null
 * when there is nothing to say (zero governed calls) — no receipt spam
 * for sessions that never used a tool.
 */
export function buildReceiptMessage(stats, sessionId, consoleBase) {
  if (!stats || stats.calls <= 0) return null;
  const parts = [`${stats.calls} tool call${stats.calls === 1 ? "" : "s"} governed`];
  if (stats.flagged > 0) parts.push(`${stats.flagged} flagged`);
  if (stats.notices > 0) parts.push(`${stats.notices} shadow notice${stats.notices === 1 ? "" : "s"}`);
  const url = `${consoleBase}/sessions/${encodeURIComponent(String(sessionId))}`;
  // A shadow notice only fires in audit mode, so notices > 0 means
  // enforcement would have held something this session. Name the read-only
  // command that shows the list; /acp-status works in every workspace.
  const next = stats.notices > 0 ? ` · /acp-status shows what enforcement would have held` : "";
  return `[ACP] Session receipt: ${parts.join(" · ")} — review this session: ${url}${next}`;
}
