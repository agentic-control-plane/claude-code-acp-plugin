// Gateway / console base-URL trust check (claude-code-acp-plugin#26).
//
// The hook sends `Authorization: Bearer <workspace key>` plus the full tool
// stream to whatever gateway base it resolves, and prints the console base
// into user-facing text (enrolment hint, session receipt). A cloned repo's
// .claude/settings.json `env` block can set ACP_API_BASE / ACP_GOVERN_BASE /
// ACP_CONSOLE_BASE, so an unchecked override is a config-poisoning exfil and
// phishing path.
//
// Env overrides may only SELECT AMONG the hosts in ACP_HOSTS: https, no
// userinfo, no explicit port. Only the origin is kept; any path, query or
// fragment is dropped. The list is enumerated, not a wildcard, so a dangling
// *.agenticcontrolplane.com subdomain cannot be claimed. Anything else falls
// back to the default with ONE stderr warning. Never fail closed: a bad
// override degrades to the default, it never blocks a tool call.
//
// ACP does not support self-hosting, so there is no self-host escape hatch
// and nothing in the environment can widen the allowlist. The one override is
// for development and tests: a URL in ~/.acp/dev_base_override (a file under
// the user's home, which a cloned repo cannot write). It may be https on any
// host, or http on a loopback host, and it replaces the gateway base for both
// ACP_API and ACP_GOVERN; the gateway env vars are then ignored. An invalid
// file falls back to the default with a warning.
//
// bin/govern.mjs ships as a flat file with no sibling lib/, so it carries an
// INLINED copy of the block between the markers (with `export ` removed).
// test/acp-base.test.mjs checks the two are identical and runs both.
import { readFileSync } from "fs";

// acp-base:begin
export const ACP_HOSTS = ["api.agenticcontrolplane.com", "govern.agenticcontrolplane.com", "cloud.agenticcontrolplane.com"];

function acpBaseCheck(raw, dev) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return { why: "not a valid URL" }; }
  if (u.username || u.password) return { why: "credentials in URL" };
  const host = u.hostname.toLowerCase();
  if (dev) {
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return { ok: u.origin };
    return { why: "dev override must be https, or http on a loopback host" };
  }
  if (u.protocol !== "https:") return { why: "must be https" };
  if (!ACP_HOSTS.includes(host)) return { why: `host is not one of ${ACP_HOSTS.join(", ")}` };
  if (u.port) return { why: "explicit port not allowed" };
  return { ok: u.origin };
}

// Env override: an allowlisted origin, or `fallback` (with one warn call).
export function resolveAcpBase(raw, fallback, warn = () => {}) {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const r = acpBaseCheck(raw, false);
  if (r.ok === undefined) { warn(raw.trim(), r.why); return fallback; }
  return r.ok;
}

// Dev/test override file: the first non-blank, non-comment line is the URL.
// Returns the validated origin, or undefined (missing, empty or invalid file).
export function readDevBaseOverride(path, warn = () => {}) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return undefined; }
  const line = text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  if (!line) return undefined;
  const r = acpBaseCheck(line, true);
  if (r.ok === undefined) { warn(line, `${path}: ${r.why}`); return undefined; }
  return r.ok;
}
// acp-base:end
