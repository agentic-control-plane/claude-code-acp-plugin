// Vendor pattern detection — pure functions, no I/O. Imported by
// bin/govern.mjs to map matched Bash commands to a (provider, envVar,
// optional proxy-host) triple so the hook can request an ACP-issued
// scoped token and inject it transparently.
//
// hostVar / hostValue (v0.6.0+): when present, the rewritten command
// also sets the upstream tool's host env var to the ACP gateway,
// routing the call through ACP's egress proxy. For gh CLI:
// GH_HOST=api.acp.com → gh sends to https://api.acp.com/api/v3/* where
// ACP's GitHub proxy lives. Without this, the command runs against the
// real vendor host with the ACP-issued token (which most vendors will
// reject — only useful as audit-only token issuance).
//
// Adding a new vendor: add to VENDOR_PATTERNS below + ensure
// gatewaystack-connect's userConnect.ts PROVIDERS list includes the same
// canonical lowercase provider key. Keep govern.mjs's inlined copy in
// sync — it's the version that ships in flat installs.

import { resolveAcpBase, readDevBaseOverride } from "./acp-base.mjs";
import { homedir } from "os";
import { join } from "path";

// Same resolution as bin/govern.mjs: the dev override file wins, else an
// allowlisted ACP_API_BASE, else the default (claude-code-acp-plugin#26).
const ACP_HOST = (readDevBaseOverride(join(homedir(), ".acp", "dev_base_override"))
  ?? resolveAcpBase(process.env.ACP_API_BASE, "https://api.agenticcontrolplane.com"))
  .replace(/^https?:\/\//, "")
  .replace(/\/$/, "");

export const VENDOR_PATTERNS = [
  // GitHub — gh CLI (full proxy: GH_HOST + GH_ENTERPRISE_TOKEN).
  // gh maps GH_TOKEN to github.com only; for any non-github.com host
  // (which an ACP-routed call is, by design) gh requires
  // GH_ENTERPRISE_TOKEN. Using GH_TOKEN causes gh to fall back to its
  // config-stored token, which is usually a stale acp_st_*.
  {
    regex: /^gh(\s|$)/,
    provider: "github",
    envVar: "GH_ENTERPRISE_TOKEN",
    hostVar: "GH_HOST",
    hostValue: ACP_HOST,
  },
  // GitHub — direct REST via curl (token-only injection; URL rewrite TBD)
  { regex: /^curl\s+(.*\s)?(https?:\/\/)?api\.github\.com/, provider: "github", envVar: "GH_TOKEN" },
  // GitHub — git push over HTTPS (token-only injection)
  { regex: /^git\s+push\s+https:\/\/github\.com\//, provider: "github", envVar: "GH_TOKEN" },
];

/**
 * Detect whether a tool call matches a known vendor pattern. Only
 * Bash-tool commands are inspected today; future versions can extend
 * to other tools as patterns emerge.
 *
 * @param {string} toolName - Claude Code tool name (e.g. "Bash")
 * @param {{command?: string} | undefined} toolInput - Claude Code tool input
 * @returns {{regex: RegExp, provider: string, envVar: string} | null}
 */
export function detectVendor(toolName, toolInput) {
  if (toolName !== "Bash") return null;
  const cmd = (toolInput?.command ?? "").toString().trim();
  if (!cmd) return null;
  for (const p of VENDOR_PATTERNS) {
    if (p.regex.test(cmd)) return p;
  }
  return null;
}
