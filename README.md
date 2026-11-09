# Agentic Control Plane: Claude Code Plugin

Checks every Claude Code tool call against your rules before it runs, and logs it. That covers `Bash`, `Read`, `Write`, `Edit`, `WebFetch` and all MCP tools. With `--local` the rules and the log stay on your machine. The default install connects a workspace, and they live there. Your tools and your workflow don't change.

The check runs as a Claude Code hook on your machine. If hooks are switched off (`disableAllHooks`), nothing is checked.

Docs: [install guide + troubleshooting](https://agenticcontrolplane.com/integrations/claude-code) · [which Claude Code tools to deny out of the box](https://agenticcontrolplane.com/blog/which-claude-code-tools-to-deny-out-of-the-box) · [the Tool Surface Index](https://agenticcontrolplane.com/tool-surfaces) (every tool one Claude Code session declares, grouped by blast radius)

## One-command install

```bash
# Free, on-device, no account. Governs Claude Code locally:
curl -sf https://agenticcontrolplane.com/install.sh | bash -s -- --local
```

This installs the plugin plus the on-device engine and activates the hook. Every Claude Code tool call is checked against `~/.acp/policy.json` and logged to `~/.acp/audit.jsonl`. No account, nothing leaves your machine. Restart Claude Code and the hook is active.

Want team policy across everyone's agents, verified identity, and the cost X-ray? Run it **without** `--local` and the installer opens your browser to provision a shared workspace instead:

```bash
curl -sf https://agenticcontrolplane.com/install.sh | bash
```

Already have the plugin? Run `/acp-connect` inside Claude Code to connect.

## How it works

The plugin registers a **PreToolUse hook** that fires before every tool call:

1. The hook sends the tool name and input to the decision engine: on-device (`~/.acp/decide.mjs`) in `--local` mode, or ACP's governance API when connected to a workspace.
2. The engine evaluates the safety floor, scope enforcement, ABAC policies, rate limits, budget caps and content scanning. A connected workspace runs all of them. On-device you get the safety floor plus your `policy.json`.
3. It returns `allow`, `ask` or `deny`.
4. Every call is logged, to `~/.acp/audit.jsonl` on-device or to your workspace's audit trail when connected.

### If ACP is unreachable

Interactive sessions proceed with a loud `UNGOVERNED` warning, and the floors below still apply. Subagent, background and API sessions stay blocked until the gateway answers.

To block interactive calls during an outage too, run `echo closed > ~/.acp/failmode` or set `ACP_FAIL_MODE=closed` (works from plugin 0.30.1). It only tightens: it never opens a blocked tier. Anyone with shell access can delete that file, so it is a setting, not a lock.

When ACP denies or blocks a call, the message starts with one of these prefixes so you can tell the cause at a glance:

- `[ACP] Denied by policy: <reason>`: a rule blocked the call.
- `[ACP] Blocked by the safety floor: ...`: the on-device floor stopped it (the destructive and uninstall floors use similar `[ACP]` prefixes).
- `[ACP] Gateway unreachable (...)`: ACP didn't answer. This is an availability failure, not a judgment about the call.
- `[ACP] Key rejected (HTTP 401/403)`: the key in `~/.acp/credentials` is revoked or invalid.

### Offline floor and local ledger (v0.16.0+)

Whenever the gateway cannot see a call (no key on this machine yet, key present but gateway unreachable, or `--local` mode) the hook still does two things:

1. **Applies the floors.** There is also an uninstall floor that guards ACP's own files. The hardline floor denies catastrophic commands: wiping root or home, formatting disks, fork bombs. The destructive floor asks a human before a force push, destructive SQL handed to a database client, a remote download piped into a shell, or a recursive delete outside the working directory. Everything else follows the outage rules above (interactive proceeds with a warning, unattended stays blocked); in `--local` mode your `policy.json` decides. The floors read what will *execute*, not what appears: a heredoc written to a file or a quoted string never trips them.
2. **Records the call** to `~/.acp/ledger.jsonl`: tool, classification, decision, reason, timestamp, session. Bounded at 5 MB. Nothing leaves the machine without a key.

When a key is connected (or the gateway comes back), the ledger uploads once, in the background, and the calls appear in your workspace audit with their original timestamps. Connect after two weeks of local use and the console shows two weeks of history. Buffered rows are a record, not a decision: they are never re-evaluated against workspace policy.

An owner or admin can switch the destructive floor off on the Policies page. The hardline floor cannot be configured.

### Approval requests (v0.17.0+)

A safety-floor hold (force-push, destructive SQL, `curl | sh`, a recursive delete outside the project) shows as a prompt in your session if you are the workspace owner or an admin. Say yes and the call runs once. Say no and it doesn't run. A hold from one of your own rules is blocked: approve it on the console or from the email, then retry. Unattended tiers get the block and the link. See the [coverage matrix](https://agenticcontrolplane.com/coverage) for how holds reach you on other harnesses.

### Model-call cost from the transcript (v0.18.0+)

Plain `claude` sends model calls straight to Anthropic, so the hook never sees them on the wire. But every hook payload names the session transcript, and the transcript records each model turn's usage (model, input, cache-read, cache-write and output tokens). On each PostToolUse the hook reads the turns that arrived since its last report (a per-transcript byte offset in `~/.acp/transcript-offsets.json`, at most 2 MB read and 50 turns per call) and sends them as `model_usage` on the tool-output call it already makes. The gateway prices them at list rates and labels the rows as hook-reported, API-rate equivalents: what those tokens would cost through the API, never a charge. No launcher, no proxy, no change to how you start Claude Code. A missing, unreadable or malformed transcript reports nothing and never touches the call.

### Plain-launch notice (v0.19.0+)

The hook sees every tool call whether you start `claude` or `claude-acp`, and prices model calls from the transcript either way. Under plain `claude` it cannot policy-check the model calls themselves. Only `claude-acp` (`~/.acp/bin/claude-acp`, written by the installer) routes them through the ACP proxy, where tool-result redaction and model routing run and where cost is metered rather than estimated. Under plain `claude`, the first allowed call of each session says so, once:

```
[ACP] Tool calls in this session are checked and logged, and model-call cost is estimated from the session transcript (API-rate equivalent, not a metered charge). Model calls are not policy-checked: plain `claude` sends them straight to the provider, so tool-result redaction and model routing are off. For those, launch with `claude-acp` (~/.acp/bin/claude-acp). Shown once per session.
```

A harness whose hook payload carries no transcript (so nothing is priced) gets a plainer form of the notice. The notice rides an allow, never a deny or an ask. A session started by the launcher (which exports `ACP_KEY`) or with `ANTHROPIC_BASE_URL` already at the ACP proxy never sees it, and local mode never shows it. Once per session is enforced with a marker under `~/.acp/session-notices/` (pruned after 7 days, capped at 200).

### Commands

Type `/acp-status`, `/acp-enforce`, `/acp-audit`, `/acp-allow <tool>`, `/acp-ask <tool>`, `/acp-deny <tool>`, `/acp-judge <tool>`, `/acp-apply <proposal>` or `/acp-apply context-guard` in the terminal to check or change how your workspace is governed without leaving the session. `/acp-status` also lists suggestions from your own usage and every approval waiting on someone, each with its link. `/acp-why` explains the last call ACP held in this session, locally, with no network call. `/acp-notify always|delayed|off` chooses your own approval emails: every held call, only ones still unanswered after about 5 minutes, or none. Held calls still wait for you either way, and this changes only your emails, not the workspace.

The hook files exactly what you typed and prints a link back. Nothing changes until you open it and tap Confirm, so a stray or injected command can't move policy on its own. A confirmed change applies to the whole workspace, the same as making it in the console. If you're not an admin, your request is filed for one to review.

### Context guard (v0.15.0+, off by default)

Whole-file reads are the cheapest thing an agent does and the most expensive thing it puts into a frontier model's context. The hook sizes a read **before** it happens (`Read`, offset and limit aware, and `cat` / `head` / `tail` / `less` / `more` / `bat`) and sends the line and byte count to the gateway (or the local engine) as `tool_context`. Targeted reads always pass: offset/limit, `head -n 20`, pipes (`cat f | grep x`), redirects, byte ranges, `tail -f`.

The policy block lives on the governance doc (console, Policies, Context guard) or in `~/.acp/policy.json` for local mode:

```json
"contextGuard": { "maxLines": 350, "mode": "shadow", "action": "deny" }
```

- `shadow`: allow, but every audit row for a read over the ceiling carries `contextGuard.estTokens`, what it would have put into context. Watch this ledger first.
- `enforce`: deny (or `ask`) with a reason that names the sanctioned path: read the section you need, grep for the symbol, or hand the read to a subagent so it stays out of this context.
- No `tool_context` (older hook, unreadable file): not guarded, never a lapse. The tool surfaces its own error for a missing file.

The ledger counts tokens the frontier model never saw. It does not count what the agent did instead, so read it next to run cost before enforcing.

### Scoped GitHub tokens (v0.5.0+, opt-in)

When your workspace has **scoped tokens** enabled (`policies.scopedTokensEnabled: true` in your tenant config), the plugin recognizes calls to known vendors, currently `gh`, `curl api.github.com`, and `git push https://github.com/…`, and:

1. Requests a short-lived ACP-issued scoped token bound to your stored OAuth credential for that vendor.
2. Injects the token into the call as `GH_TOKEN=…` so the existing CLI keeps working with no setup change.
3. Keeps your local PAT out of the agent's hands. ACP brokers the credential and audits every issuance and use.

If you haven't connected the vendor yet, the plugin emits a deny with a connect URL inline so you can complete OAuth in your browser without leaving Claude Code.

If your workspace doesn't have scoped tokens enabled, the plugin behaves exactly as v0.4.0 did and your existing local credentials work unchanged.

Other vendors (Slack, Salesforce, Notion, etc.) ship in later releases. Watch this repo's [releases](https://github.com/agentic-control-plane/claude-code-acp-plugin/releases) or ask in [issues](https://github.com/agentic-control-plane/claude-code-acp-plugin/issues).

## Console

After setup, your dashboard is at:

- **Logs**: `https://cloud.agenticcontrolplane.com/logs`
- **Policies**: `https://cloud.agenticcontrolplane.com/policies`
- **Limits**: `https://cloud.agenticcontrolplane.com/limits`

## Managed rollouts (enterprise)

Pushing this hook to every seat from an admin console or MDM? The hook config
carries no secret: each person enrolls once (their own key lands in
`~/.acp/credentials`), so every call is attributed to a person. Set
`ACP_REQUIRE_ENROLLMENT=1` in the managed hook command or managed `env` and an
unenrolled machine **blocks** each call with the enrollment step instead of
running it ungoverned with a warning. That is the only thing the flag changes.
Per-harness recipes: https://agenticcontrolplane.com/docs/enterprise

## Pause / disable

```bash
# Pause (keep credentials). The floors still apply and calls are
# recorded to ~/.acp/ledger.jsonl, and nothing reaches your workspace
# until you resume (the buffered ledger uploads then).
mv ~/.acp/credentials ~/.acp/credentials.paused

# Resume
mv ~/.acp/credentials.paused ~/.acp/credentials

# Fully remove
rm -rf ~/.acp
claude plugin disable agentic-control-plane
```

## Support

- Site: https://agenticcontrolplane.com
- Issues: https://github.com/agentic-control-plane/claude-code-acp-plugin/issues
- Email: support@agenticcontrolplane.com
