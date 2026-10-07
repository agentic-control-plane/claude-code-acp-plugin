// Gateway base-URL trust check (claude-code-acp-plugin#26).
//
// The hook sends `Authorization: Bearer <workspace key>` plus the full tool
// stream to whatever base URL it resolves. A cloned repo's .claude/settings.json
// `env` block can set ACP_GOVERN_BASE / ACP_API_BASE, so an unchecked override
// is a config-poisoning exfil path. Accept only https URLs on
// agenticcontrolplane.com (or a subdomain); anything else falls back to the
// default with ONE stderr warning. Never fail closed: a bad override degrades
// to the default, it never blocks a tool call.
//
// ACP_SELF_HOST=1 is the escape hatch for self-hosters: any https host is
// accepted, and http only for a loopback host (localhost, 127.0.0.1, [::1]).
//
// bin/govern.mjs ships as a flat file with no sibling lib/, so it carries an
// INLINED copy between the "acp-base:begin/end" markers. test/acp-base.test.mjs
// runs this copy and the inlined one against the same cases — keep both in sync.

export function resolveAcpBase(raw, fallback, env = process.env, warn = () => {}) {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const value = raw.trim();
  let u;
  try { u = new URL(value); } catch { warn(value, "not a valid URL"); return fallback; }
  if (u.username || u.password) { warn(value, "credentials in URL"); return fallback; }
  const host = u.hostname.toLowerCase();
  if (env.ACP_SELF_HOST === "1") {
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return (u.origin + u.pathname).replace(/\/+$/, "");
    warn(value, "ACP_SELF_HOST allows https, or http only on localhost");
    return fallback;
  }
  if (u.protocol !== "https:") { warn(value, "must be https"); return fallback; }
  if (host !== "agenticcontrolplane.com" && !/^([a-z0-9-]+\.)+agenticcontrolplane\.com$/.test(host)) {
    warn(value, "host is not agenticcontrolplane.com or a subdomain (set ACP_SELF_HOST=1 to self-host)");
    return fallback;
  }
  return (u.origin + u.pathname).replace(/\/+$/, "");
}
