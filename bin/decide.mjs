// decide.mjs — LOCAL decision engine for Agentic Control Plane.
//
// Runs entirely on your machine. No account, no network, no phone-home: it
// classifies a tool call, applies a safety floor, and consults your local
// policy file (~/.acp/policy.json). This is the same *shape* of decision the
// hosted gateway makes — the hosted product adds the tuned risk classifier,
// cross-instance limits, team policy sync, cost X-ray, and the console.
//
// This module is intentionally pure and self-contained (no imports, no I/O) so
// it is trivial to review, run offline, and later publish as the open decision
// primitive. The dispatcher (govern.mjs) supplies the policy object and writes
// the audit line; this file only decides.
//
// It is mirrored verbatim into install.sh (~/.acp/decide.mjs at install time);
// test/mirror.test.mjs fails CI if the two ever diverge.

/** Split a command into argv-ish tokens, honoring quotes and stopping at the
 *  first shell control operator (| ; &). Env-assignments and wrappers are kept
 *  as tokens; callers strip them. */
function shellTokens(cmd) {
  const out = [];
  let buf = "";
  let quote = null;
  for (const ch of String(cmd)) {
    if (quote) { if (ch === quote) quote = null; else buf += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === " " || ch === "\t" || ch === "\n") { if (buf) { out.push(buf); buf = ""; } continue; }
    if (ch === "|" || ch === ";" || ch === "&") { if (buf) { out.push(buf); buf = ""; } break; }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

// Wrappers that prefix another command. `valueFlags` are the flags whose value
// is a SEPARATE token (`sudo -u root`, `nice -n 10`); `operands` is how many
// positional operands the wrapper itself consumes before the real command
// (`timeout [flags] DURATION cmd…`). Skipping flags but not these operands is
// exactly the hole of #19: `timeout 5 rm -rf ~` classified as Bash.5.
const WRAPPERS = new Map([
  ["sudo", { valueFlags: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U"]), operands: 0 }],
  ["doas", { valueFlags: new Set(["-u", "-C"]), operands: 0 }],
  ["env", { valueFlags: new Set(["-u", "-C", "-P", "-S"]), operands: 0 }],
  ["nice", { valueFlags: new Set(["-n", "--adjustment"]), operands: 0 }],
  ["nohup", { valueFlags: new Set(), operands: 0 }],
  ["setsid", { valueFlags: new Set(), operands: 0 }],
  ["stdbuf", { valueFlags: new Set(["-i", "-o", "-e"]), operands: 0 }],
  ["timeout", { valueFlags: new Set(["-s", "--signal", "-k", "--kill-after"]), operands: 1 }],
  ["time", { valueFlags: new Set(), operands: 0 }],
  ["xargs", { valueFlags: new Set(["-I", "-n", "-P", "-L", "-d", "-a", "-E", "-s"]), operands: 0 }],
  ["command", { valueFlags: new Set(), operands: 0 }],
  ["builtin", { valueFlags: new Set(), operands: 0 }],
]);

// Shell keywords are never the governed binary: `if rm -rf /; then …` and
// `{ rm -rf /; }` must classify as rm, not stall on the keyword.
const SHELL_KEYWORDS = new Set(["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "{", "}", "(", ")", "!"]);

/** Split a command line into its piped/chained segments (on unquoted | & ; ( )
 *  and newlines), so every command in a compound line is inspected, not just
 *  the first (e.g. `echo hi && rm -rf ~`, `( rm -rf ~ )`, `$(rm -rf ~)`). */
function splitSegments(cmd) {
  const segs = [];
  let buf = "";
  let quote = null;
  for (const ch of String(cmd)) {
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === "|" || ch === "&" || ch === ";" || ch === "\n" || ch === "(" || ch === ")") { if (buf.trim()) segs.push(buf.trim()); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) segs.push(buf.trim());
  return segs;
}

/** Strip leading env-assignments, shell keywords, and benign wrappers —
 *  including each wrapper's own option-arguments and positional operands
 *  (`sudo -u root …`, `timeout 5 …`, `nice -n 10 …`) — and return
 *  { bin, args } where bin is the canonical binary (basename, no path). */
function parseCommand(cmd) {
  const toks = shellTokens(cmd);
  let i = 0;
  let hops = 0;
  while (i < toks.length && hops++ < 32) {
    const t = toks[i];
    if (t.includes("=") && !t.startsWith("-")) { i++; continue; }        // FOO=bar
    if (SHELL_KEYWORDS.has(t)) { i++; continue; }                        // if / { / do …
    const w = WRAPPERS.get(t);
    if (w) {
      i++;
      while (i < toks.length && toks[i].startsWith("-")) {
        const flag = toks[i];
        i++;
        if (w.valueFlags.has(flag)) i++;                                 // sudo -u USER
      }
      for (let n = 0; n < w.operands && i < toks.length; n++) i++;       // timeout DURATION
      continue;
    }
    return { bin: t.split("/").pop(), args: toks.slice(i + 1) };
  }
  return { bin: "", args: [] };
}

/** Canonical binary of a shell command (basename), skipping env + wrappers. */
function canonicalBinary(cmd) {
  return parseCommand(cmd).bin;
}

/** First http(s) host in a command (for curl/wget), else undefined. */
function firstHost(cmd) {
  const m = String(cmd).match(/https?:\/\/([^/\s"']+)/i);
  if (!m) return undefined;
  return m[1].replace(/^www\./, "").toLowerCase();
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

// Shell subcommands worth policy granularity: `git push` should be governable
// without also governing `git status`. Keep this small and obvious.
const SUBCOMMAND_BINS = new Set(["git", "gh", "docker", "kubectl", "npm", "pnpm", "yarn", "pip", "pip3", "gcloud", "aws", "systemctl"]);

// Global flags whose VALUE is a separate token, so the value is never
// mistaken for the subcommand: `git -C /repo push` is a push (was the
// malformed key "Bash.git.." — #19), `kubectl -n prod delete` is a delete.
const FLAGS_WITH_VALUE = new Set(["-C", "-c", "-H", "-n", "-R", "--git-dir", "--work-tree", "--namespace", "--context", "--cluster", "--kubeconfig", "--prefix", "--profile", "--project", "--config", "--repo"]);

/** First non-flag argument (the subcommand), lowercased, or undefined —
 *  skipping over flags AND their separate-token values. */
function firstSubcommand(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      if (FLAGS_WITH_VALUE.has(a)) i++;                                  // git -C /repo
      continue;
    }
    return a.toLowerCase();
  }
  return undefined;
}

// ── Compound-command classification ───────────────────────────────────
// A compound command classifies by its MOST PRIVILEGED segment, and decide()
// policy-checks EVERY segment (strictest verdict wins) — classifying by the
// first segment let `true && gcloud …` run under Bash.true (#18). Rank
// mirrors the gateway's fix for this class (gsc#516 / gsc#750): benign
// navigational bins lose to unknown bins, which lose to privileged bins.

/** Benign / navigational binaries — never the interesting part of a
 *  compound command. */
const BENIGN_BINS = new Set([
  "cd", "echo", "printf", "true", "false", "pwd", "ls", "cat", "head", "tail",
  "less", "more", "grep", "rg", "wc", "sort", "uniq", "cut", "tr", "date",
  "sleep", "which", "type", "test", "[", "[[", "dirname", "basename",
  "readlink", "ps", "diff", "jq", "yq", "tee", "read", "exit", "return",
  "wait", "export", "set", "unset", "shift", "local", "declare",
]);

/** Binary classes that outrank an unknown binary when picking a compound
 *  command's classification: deploy/infra, source control, deletion, network
 *  egress, db clients, interpreters. */
const PRIVILEGED_BINS = new Set([
  "gcloud", "aws", "azure", "firebase", "terraform", "docker", "kubectl",
  "git", "gh", "npm", "pnpm", "yarn", "pip", "pip3", "rm", "mv", "chmod",
  "chown", "curl", "wget", "ssh", "scp", "rsync", "kill", "sed", "find",
  "psql", "mysql", "mariadb", "sqlite3", "systemctl", "launchctl",
  "powershell", "pwsh", "python", "python3", "node", "ruby", "perl", "cargo",
  "go", "make", "stripe", "vercel", "flyctl", "fly", "heroku", "tar", "open",
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "eval",
]);

/** Privilege rank for most-privileged-segment selection: benign 0,
 *  unknown 1, privileged 2. Ties resolve to the EARLIEST unit. */
function privilegeRank(bin) {
  if (BENIGN_BINS.has(bin)) return 0;
  if (PRIVILEGED_BINS.has(bin)) return 2;
  return 1;
}

/** Every governed unit of a Bash command: one per segment, plus the payload
 *  of any `bash -c "…"` / `eval …` hand-off (recursed, capped), so neither a
 *  benign prefix nor an interpreter hop hides a unit from policy. */
function commandUnits(cmd, depth = 0) {
  const units = [];
  if (depth > 3) return units;
  for (const seg of splitSegments(cmd)) {
    const { bin, args } = parseCommand(seg);
    if (!bin) continue;
    units.push({ bin, args, seg });
    const inner = innerShellCommand(bin, args);
    if (inner) units.push(...commandUnits(inner, depth + 1));
  }
  return units;
}

/** Dotted policy key for one command unit. */
function unitKey(u) {
  if (u.bin === "curl" || u.bin === "wget") {
    const host = firstHost(u.seg);
    return host ? `Bash.curl.${host}` : "Bash.curl";
  }
  if (SUBCOMMAND_BINS.has(u.bin)) {
    const sub = firstSubcommand(u.args);
    return sub ? `Bash.${u.bin}.${sub}` : `Bash.${u.bin}`;
  }
  return `Bash.${u.bin}`;
}

/** The units of a Bash-shaped tool call, or null for other tools. */
function bashUnits(toolName, toolInput) {
  const name = String(toolName || "");
  if (name !== "Bash" && name !== "run_terminal_cmd" && name !== "shell") return null;
  const input = typeof toolInput === "string" ? safeParse(toolInput) : (toolInput || {});
  return commandUnits(String(input.command || input.cmd || ""));
}

/**
 * Classify a tool call into a dotted policy key, e.g. "Bash.rm",
 * "Bash.git.push", "Bash.curl.api.github.com", "Write", "WebFetch.example.com".
 * A non-empty command with no classifiable unit is the explicit
 * "Bash.unknown" (never a malformed or wrong-segment key): still governable
 * by a Bash.unknown rule, still falls back to "Bash" in the policy walk, and
 * honestly labeled as unparsed in the audit line rather than silently benign.
 */
const HEREDOC_DELIM_RE = /<<(?!<)-?\s*(?:"([A-Za-z_][\w-]*)"|'([A-Za-z_][\w-]*)'|\\?([A-Za-z_][\w-]*))/g;
/** Drop heredoc terminator lines (`EOF`) from stripped text: stripDataHeredocs
 *  keeps them so its output still pairs, but for classification they are
 *  not commands. `raw` is the original text the delimiters come from. */
function stripHeredocTerminators(stripped, raw) {
  if (!raw.includes("<<")) return stripped;
  const delims = new Set();
  let m;
  HEREDOC_DELIM_RE.lastIndex = 0;
  while ((m = HEREDOC_DELIM_RE.exec(raw)) !== null) delims.add(m[1] || m[2] || m[3]);
  if (!delims.size) return stripped;
  return stripped.split("\n").filter((l) => !delims.has(l.trim())).join("\n");
}

export function classifyTool(toolName, toolInput) {
  const name = String(toolName || "");
  const input = typeof toolInput === "string" ? safeParse(toolInput) : (toolInput || {});

  if (name === "Bash" || name === "run_terminal_cmd" || name === "shell") {
    const cmd = String(input.command || input.cmd || "");
    // A heredoc body written to a file is data, not a command line: a
    // `cat > deploy.ps1 <<'EOF' … Remove-Item … EOF` is Bash.cat, the same
    // class the gateway gives it (gatewaystack-connect#1277 HIGH-2). The
    // terminator line is dropped too — a lone `EOF` is not a command.
    const units = commandUnits(stripHeredocTerminators(stripDataHeredocs(cmd), cmd));
    if (!units.length) return cmd.trim() ? "Bash.unknown" : "Bash";
    let best = units[0];
    for (const u of units) if (privilegeRank(u.bin) > privilegeRank(best.bin)) best = u;
    return unitKey(best);
  }
  if (name === "Write" || name === "Edit" || name === "MultiEdit" || name === "create_file" || name === "edit_file") {
    return "Write";
  }
  if (name === "Read" || name === "read_file" || name === "Glob" || name === "Grep" || name === "LS") {
    return "Read";
  }
  if (name === "WebFetch" || name === "WebSearch" || name === "web_search") {
    const host = firstHost(input.url || "");
    return host ? `WebFetch.${host}` : "WebFetch";
  }
  return name;
}

// ── Safety floor ──────────────────────────────────────────────────────
// Obvious, catastrophic, hard-to-undo actions denied regardless of policy.
// Deliberately conservative and OBVIOUS (not secret heuristics — the tuned
// detector lives in the hosted product). The bar: "no legitimate agent task
// ever needs this." Token-based where flag order/spelling varies, so the
// common phrasings can't slip past (rm -rf ~/ , rm -r -f / , git push -f , …).

/** Does this arg list carry short flag `letter` (e.g. -rf, -f) or `--long`? */
function hasShortOrLongFlag(args, letter, longName) {
  for (const a of args) {
    if (a === `--${longName}`) return true;
    if (/^-[a-z]+$/i.test(a) && a.slice(1).toLowerCase().includes(letter)) return true;
  }
  return false;
}

const RM_DANGER_TARGETS = new Set(["/", "/.", "~", "~/", "$HOME", "$HOME/", "${HOME}", ".", "./", "*", "/*", "./*", "~/*"]);

/** rm with BOTH recursive and force, aimed at a root/home/cwd/glob target. */
function rmForceFloor(bin, args) {
  if (bin !== "rm") return null;
  const recursive = hasShortOrLongFlag(args, "r", "recursive");
  const force = hasShortOrLongFlag(args, "f", "force");
  if (!recursive || !force) return null;
  const targets = args.filter((a) => !a.startsWith("-"));
  for (const t of targets) {
    const norm = t.replace(/\/+$/, ""); // trailing slash → same target (~/ ≡ ~)
    if (RM_DANGER_TARGETS.has(t) || RM_DANGER_TARGETS.has(norm) || norm === "") {
      return "recursive force-delete of a root/home path";
    }
  }
  return null;
}

/** git push that force-updates main/master (any flag order, -f or --force, or
 *  a +refspec). */
function gitForcePushFloor(bin, args) {
  if (bin !== "git") return null;
  if (firstSubcommand(args) !== "push") return null;
  const targetsMain = args.some((a) => /(^|[:+/])(main|master)$/.test(a));
  if (!targetsMain) return null;
  const forceFlag = hasShortOrLongFlag(args, "f", "force") || args.includes("--force-with-lease");
  const plusRefspec = args.some((a) => /^\+/.test(a) && /(main|master)/.test(a));
  if (forceFlag || plusRefspec) return "force-push to main/master";
  return null;
}

// Shells whose `-c <string>` argument is itself a command line: recurse the
// floor into it so `bash -c "rm -rf ~"` can't launder past token inspection.
const SHELL_BINS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"]);

/** If this command hands a string to another interpreter (`bash -c '…'`,
 *  `eval …`), return that inner command line; else undefined. */
function innerShellCommand(bin, args) {
  if (SHELL_BINS.has(bin)) {
    for (let i = 0; i < args.length; i++) {
      if (/^-[a-z]*c[a-z]*$/i.test(args[i])) return args[i + 1];
    }
    return undefined;
  }
  if (bin === "eval") return args.join(" ");
  return undefined;
}

/** Token floors, per segment, recursing one level into shell -c / eval. */
function tokenFloorScan(cmd, depth = 0) {
  if (depth > 3) return null;
  for (const seg of splitSegments(cmd)) {
    const { bin, args } = parseCommand(seg);
    const hit = rmForceFloor(bin, args) || gitForcePushFloor(bin, args);
    if (hit) return hit;
    const inner = innerShellCommand(bin, args);
    if (inner) {
      const h = tokenFloorScan(inner, depth + 1);
      if (h) return h;
    }
  }
  return null;
}

const REGEX_RULES = [
  [/\bmkfs\.[a-z0-9]+\b|\bmkfs\s/i, "filesystem format (mkfs)"],
  [/\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|disk|hd)/i, "raw disk overwrite (dd of=/dev/…)"],
  [/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "fork bomb"],
  [/\bchmod\s+-R\s+0*777\s+\/(\s|$)/i, "recursive chmod 777 on /"],
  [/>\s*\/dev\/(sd|nvme|disk|hd)[a-z0-9]*/i, "redirect over a raw disk device"],
];

/**
 * The safety floor: obvious, catastrophic commands denied regardless of policy.
 * Returns a deny reason, or null.
 */
export function hardlineFloor(toolName, toolInput) {
  const name = String(toolName || "");
  if (name !== "Bash" && name !== "run_terminal_cmd" && name !== "shell") return null;
  const input = typeof toolInput === "string" ? safeParse(toolInput) : (toolInput || {});
  const cmd = String(input.command || input.cmd || "");

  // Token floors run per-segment so a catastrophe hidden after `&&`/`;`/`|`
  // (e.g. `echo ok && rm -rf ~`) is still caught, and recurse into
  // `bash -c "…"` / `eval …` so hand-off to another shell can't launder it.
  const tokenFloor = tokenFloorScan(cmd);
  if (tokenFloor) return tokenFloor;

  const c = cmd.replace(/\s+/g, " ").trim();
  for (const [re, why] of REGEX_RULES) if (re.test(c)) return why;
  return null;
}

// ── Context guard ─────────────────────────────────────────────────────
// Whole-file reads are the cheapest thing an agent does and the most
// expensive thing it puts in a frontier model's context. The guard sizes a
// read BEFORE it happens: Read (offset/limit-aware) and the shell dumpers
// (cat/head/tail/less/more/bat). Piped or redirected dumps pass — those are
// targeted. readIntent() is pure parsing; the dispatcher counts the lines
// (I/O) and hands them back as `context.files`.

const DUMP_BINS = new Set(["cat", "head", "tail", "less", "more", "bat", "batcat"]);

/** Split on unquoted | & ; newline, keeping the operator that FOLLOWS each
 *  segment so a pipe after a dump can be told from a chain before it. */
function splitSegmentsWithOps(cmd) {
  const out = [];
  let buf = "";
  let quote = null;
  for (const ch of String(cmd)) {
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === "|" || ch === "&" || ch === ";" || ch === "\n") {
      if (buf.trim()) out.push({ seg: buf.trim(), op: ch });
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push({ seg: buf.trim(), op: "" });
  return out;
}

function unquote(t) { return String(t).replace(/^(['"])(.*)\1$/, "$2"); }
function toCount(v) { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null; }

/** head/tail line limits: -N, -nN, -n N, --lines=N, --lines N. Byte ranges
 *  (-c) and follow (-f) are targeted by construction. */
function dumpArgs(bin, args) {
  let limit = null;
  let targeted = false;
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { for (const rest of args.slice(i + 1)) paths.push(unquote(rest)); break; }
    if (!a.startsWith("-") || a === "-") { paths.push(unquote(a)); continue; }
    if (bin === "head" || bin === "tail") {
      let m;
      if ((m = a.match(/^-(\d+)$/))) { limit = toCount(m[1]); continue; }
      if ((m = a.match(/^-n\+?(\d+)$/))) { limit = toCount(m[1]); continue; }
      if ((m = a.match(/^--lines=\+?(\d+)$/))) { limit = toCount(m[1]); continue; }
      if (a === "-n" || a === "--lines") { limit = toCount(String(args[i + 1] || "").replace(/^\+/, "")); i++; continue; }
      if (a === "-c" || a === "--bytes") { targeted = true; i++; continue; }
      if (/^-c\d+$/.test(a) || /^--bytes=/.test(a)) { targeted = true; continue; }
      if (a === "-f" || a === "-F" || a === "--follow") { targeted = true; continue; }
    }
    if (bin === "bat" || bin === "batcat") {
      let m;
      if ((m = a.match(/^(?:-r|--line-range)=?(\d+):(\d+)$/))) { limit = Math.max(0, toCount(m[2]) - toCount(m[1]) + 1); continue; }
      if (a === "-r" || a === "--line-range") { const r = String(args[i + 1] || "").match(/^(\d+):(\d+)$/); if (r) limit = Math.max(0, toCount(r[2]) - toCount(r[1]) + 1); i++; continue; }
    }
  }
  // head/tail with no explicit count print 10 lines.
  if ((bin === "head" || bin === "tail") && limit === null && !targeted) limit = 10;
  return { limit, targeted, paths };
}

/**
 * What would this call pull into context? Returns null when the call is not
 * a whole-file read, else { via, paths, offset, limit, targeted }:
 *   via      "Read" | "Bash.cat" | "Bash.head" | …
 *   paths    files the dispatcher should size
 *   offset   1-based start line (Read) — lines before it are not read
 *   limit    max lines read, or null for "to the end"
 *   targeted true when the shape is already narrow (byte-ranged, followed);
 *            the guard never blocks these
 */
export function readIntent(toolName, toolInput) {
  const name = String(toolName || "");
  const input = typeof toolInput === "string" ? safeParse(toolInput) : (toolInput || {});

  if (name === "Read" || name === "read_file") {
    const path = input.file_path || input.path || input.target_file || "";
    if (!path) return null;
    const offset = toCount(input.offset);
    const limit = toCount(input.limit);
    return { via: "Read", paths: [String(path)], offset: offset && offset > 0 ? offset : null, limit: limit && limit > 0 ? limit : null, targeted: false };
  }

  if (name === "Bash" || name === "run_terminal_cmd" || name === "shell") {
    const raw = input.command || input.cmd || "";
    const cmd = Array.isArray(raw) ? raw.map(String).join(" ") : String(raw);
    if (!cmd.trim()) return null;
    for (const { seg, op } of splitSegmentsWithOps(cmd)) {
      const { bin, args } = parseCommand(seg);
      if (!DUMP_BINS.has(bin)) continue;
      if (op === "|") continue;                       // dump feeds a filter — targeted
      if (/(^|[^\\])>/.test(seg)) continue;            // redirected to a file — never enters context
      const { limit, targeted, paths } = dumpArgs(bin, args);
      const files = paths.filter((p) => p && p !== "-");
      if (!files.length) continue;                    // reads stdin
      return { via: `Bash.${bin}`, paths: files, offset: null, limit, targeted };
    }
    return null;
  }
  return null;
}

const GUARD_MODES = new Set(["off", "shadow", "enforce"]);

/**
 * Size a read against the guard. `files` maps path → { lines, bytes } as the
 * dispatcher measured them (unmeasured paths are skipped — the tool surfaces
 * its own not-found error). Returns null when nothing applies, else
 * { mode, action, lines, effectiveLines, estTokens, maxLines, paths, via, guidance }.
 */
export function contextGuard(intent, files, guard) {
  if (!intent || !guard || typeof guard !== "object") return null;
  const mode = GUARD_MODES.has(guard.mode) ? guard.mode : "off";
  if (mode === "off") return null;
  const maxLines = toCount(guard.maxLines);
  if (!maxLines) return null;
  if (intent.targeted) return null;
  const known = intent.paths.map((p) => [p, files && files[p]]).filter(([, f]) => f && Number.isFinite(f.lines));
  if (!known.length) return null;
  let lines = 0, effectiveLines = 0, bytes = 0;
  for (const [, f] of known) {
    lines += f.lines;
    let eff = f.lines;
    if (intent.offset) eff = Math.max(0, eff - (intent.offset - 1));
    if (intent.limit !== null && intent.limit !== undefined) eff = Math.min(eff, intent.limit);
    effectiveLines += eff;
    bytes += Number.isFinite(f.bytes) ? f.bytes : 0;
  }
  if (effectiveLines <= maxLines) return null;
  const avgBytesPerLine = lines > 0 && bytes > 0 ? bytes / lines : 40;
  const estTokens = Math.round((effectiveLines * avgBytesPerLine) / 4);
  const action = guard.action === "ask" ? "ask" : "deny";
  return { mode, action, lines, effectiveLines, estTokens, maxLines, paths: known.map(([p]) => p), via: intent.via,
           guidance: typeof guard.guidance === "string" && guard.guidance.trim() ? guard.guidance.trim() : "" };
}

/** Default steer, per harness. A block always names the sanctioned path. */
export function contextGuardSteer(harness) {
  if (harness === "codex") {
    return "Read just the section you need (sed -n 'START,ENDp' FILE, or grep -n PATTERN FILE), or send the whole-file read to a subagent so it stays out of this context.";
  }
  return "Read just the section you need (offset/limit, or grep for the symbol), or hand the whole-file read to a subagent so it stays out of this context.";
}

/**
 * Walk a dotted key from most-specific to least, e.g.
 * "Bash.curl.api.github.com" → [..., "Bash.curl", "Bash"].
 */
export function candidates(key) {
  const parts = String(key).split(".");
  const out = [];
  for (let i = parts.length; i >= 1; i--) out.push(parts.slice(0, i).join("."));
  return out;
}

const VALID = new Set(["allow", "ask", "deny"]);
// ── Destructive floor (ask-level; gatewaystack-connect#1097, plugin#29) ──
// One rung below the hardline floor: things a human always wants to be asked
// about, in every mode — a force push, destructive SQL handed to a database
// client, a remote download piped into a shell, a recursive delete outside
// the working directory. Never a deny; a policy deny still wins. Scans what
// will EXECUTE, not what appears: a heredoc body written to a file and quoted
// prose cannot fire it, and the SQL a client is handed is read in every
// spelling (flag, positional, here-string, heredoc, piped literal). Same
// rules and fixtures as the gateway's floor, so an offline call and a
// governed call agree.

const INTERPRETER_BINS = new Set(["sh", "bash", "zsh", "dash", "ksh", "psql", "pgcli", "mysql", "mariadb", "mycli",
  "sqlite3", "sqlite", "duckdb", "clickhouse-client", "sqlcmd", "python", "python3", "node", "perl", "ruby", "php", "osascript"]);
const HEREDOC_RE = /<<(?!<)-?\s*(?:"([A-Za-z_][\w-]*)"|'([A-Za-z_][\w-]*)'|\\?([A-Za-z_][\w-]*))/;

/** Drop the bodies of heredocs whose consumer does not execute them
 *  (`cat > f <<'EOF'`, `tee`, `gh … --body-file -`). Bodies fed to a shell,
 *  SQL client, or interpreter stay. An unquoted delimiter still expands
 *  `$( … )` in the body, so those substitutions are kept in its place. */
export function stripDataHeredocs(cmd) {
  const s = String(cmd);
  if (!s.includes("<<")) return s;
  const lines = s.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(HEREDOC_RE);
    if (!m) { out.push(line); continue; }
    const delim = m[1] ?? m[2] ?? m[3];
    const quoted = m[1] !== undefined || m[2] !== undefined || m[0].includes("\\");
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) if (lines[j].trim() === delim) { end = j; break; }
    const body = lines.slice(i + 1, end);
    out.push(line);
    const { bin, args } = parseCommand(line.slice(0, m.index));
    const shellDashC = SHELL_BINS.has(bin) && args.some((a) => /^-[a-z]*c[a-z]*$/i.test(a));
    if (INTERPRETER_BINS.has(bin) && !shellDashC) out.push(...body);
    else if (!quoted) { const subs = body.join("\n").match(/\$\([^)]*\)|`[^`]*`/g); if (subs) out.push(subs.join(" ")); }
    if (end < lines.length) out.push(lines[end]);
    i = end;
  }
  return out.join("\n");
}

const SQL_CLIENTS = {
  psql: { opts: ["-c", "--command"] }, pgcli: { opts: ["-c", "--command"] },
  mysql: { opts: ["-e", "--execute"] }, mariadb: { opts: ["-e", "--execute"] }, mycli: { opts: ["-e", "--execute"] },
  sqlite3: { opts: ["-cmd"], pos: 1 }, sqlite: { opts: ["-cmd"], pos: 1 },
  duckdb: { opts: ["-c", "-s", "--command"], pos: 1 },
  "clickhouse-client": { opts: ["-q", "--query"] }, sqlcmd: { opts: ["-Q", "-q"] },
};

/** "drop" | "truncate" | "delete" (DELETE with no WHERE) | null. */
export function sqlStatementKind(sql) {
  const s = String(sql).replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  if (/\bDROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX|VIEW|SEQUENCE|USER|ROLE)\b/i.test(s)) return "drop";
  if (/\bTRUNCATE\b/i.test(s)) return "truncate";
  for (const st of s.split(";")) if (/\bDELETE\s+FROM\b/i.test(st) && !/\bWHERE\b/i.test(st)) return "delete";
  return null;
}

/** Every SQL statement a command hands to a database client. Text that is
 *  not handed to a client (`echo "DROP …"`, a grep pattern) is not SQL. */
export function sqlPayloads(cmd) {
  const out = [];
  const text = stripDataHeredocs(cmd);
  const segs = splitSegmentsWithOps(text);
  for (let i = 0; i < segs.length; i++) {
    const { bin, args } = parseCommand(segs[i].seg);
    const spec = SQL_CLIENTS[bin];
    if (!spec) continue;
    const positionals = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      let matched = false;
      for (const opt of spec.opts) {
        if (a === opt) { if (args[k + 1] !== undefined) out.push(args[++k]); matched = true; break; }
        if (a.startsWith(`${opt}=`)) { out.push(a.slice(opt.length + 1)); matched = true; break; }
        if (opt.length === 2 && !a.startsWith("--") && a.startsWith(opt) && a.length > 2) { out.push(a.slice(2)); matched = true; break; }
      }
      if (matched) continue;
      if (a.startsWith("<<<")) { const rest = a.slice(3) || args[++k] || ""; if (rest) out.push(rest); continue; }
      if (a.startsWith("<<")) continue; // heredoc marker; body handled below
      if (!a.startsWith("-")) positionals.push(a);
    }
    if (spec.pos !== undefined) out.push(...positionals.slice(spec.pos));
    // A literal producer piped in: `echo "TRUNCATE t" | psql db`.
    if (i > 0 && segs[i - 1].op === "|") {
      const p = parseCommand(segs[i - 1].seg);
      if (p.bin === "echo" || p.bin === "printf") {
        const lit = p.args.filter((x) => !x.startsWith("-")).join(" ");
        if (lit) out.push(lit);
      }
    }
  }
  // Heredoc bodies fed to a client (kept verbatim by stripDataHeredocs).
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEREDOC_RE);
    if (!m) continue;
    if (!SQL_CLIENTS[parseCommand(lines[i].slice(0, m.index)).bin]) continue;
    const delim = m[1] ?? m[2] ?? m[3];
    const body = [];
    for (let j = i + 1; j < lines.length && lines[j].trim() !== delim; j++) body.push(lines[j]);
    if (body.length) out.push(body.join("\n"));
  }
  return out.map((x) => x.trim()).filter(Boolean);
}

const FORCE_PUSH_RE = /\bgit\b[^|;&\n]*\bpush\b[^|;&\n]*(?:\s--force(?!-with-lease|-if-includes)\b|\s-[a-eg-zA-Z]*f[a-zA-Z]*(?=\s|$)|\s\+[^\s:]+:)/;
const PIPE_TO_SHELL_RE = /\b(?:curl|wget)\b[^|;&\n]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:\S*\/)?(?:ba|z|da|k)?sh\b/;
const SHELL_OF_DOWNLOAD_RE = /\b(?:ba|z|da|k)?sh\s+(?:-[a-zA-Z]+\s+)*(?:-c\s+["']?\$\(\s*(?:curl|wget)\b|<\s*<?\s*\(\s*(?:curl|wget)\b)/;
const TMP_PATH_RE = /^(?:\/tmp|\/private\/tmp|\/var\/folders|\/var\/tmp|\$\{?TMPDIR\}?)(?:\/|$)/;

/** `rm -r` whose target is absolute, home-relative, parent-relative, or a
 *  variable — anything the working directory does not contain. */
function recursiveDeleteOutsideCwd(text, cwd) {
  const base = cwd ? String(cwd).replace(/\/+$/, "") : null;
  for (const seg of splitSegments(text)) {
    const { bin, args } = parseCommand(seg);
    if (bin !== "rm" || !hasShortOrLongFlag(args, "r", "recursive")) continue;
    for (const raw of args) {
      if (raw === "--" || raw.startsWith("-")) continue;
      const p = raw.replace(/^\$\{?HOME\}?(?=\/|$)/, "~");
      if (TMP_PATH_RE.test(p)) continue;
      if (p.startsWith("$")) return "recursive delete of a variable-named path";
      if (p.startsWith("/") || p.startsWith("~")) {
        if (base && (p === base || p.startsWith(`${base}/`))) continue;
        return `recursive delete outside the working directory: ${p}`;
      }
      if (/^\.\.(?:\/|$)/.test(p)) return `recursive delete outside the working directory: ${p}`;
    }
  }
  return null;
}

/**
 * The ask-level floor. Returns a reason a human must be asked, or null.
 * @param context { cwd?: string } — the caller's working directory when known
 */
export function destructiveFloor(toolName, toolInput, context) {
  const name = String(toolName || "");
  if (name !== "Bash" && name !== "run_terminal_cmd" && name !== "shell") return null;
  const input = typeof toolInput === "string" ? safeParse(toolInput) : (toolInput || {});
  const cmd = String(input.command || input.cmd || "");
  if (!cmd) return null;
  for (const p of sqlPayloads(cmd)) {
    const k = sqlStatementKind(p);
    if (k) return `destructive SQL (${k}): ${p.replace(/\s+/g, " ").slice(0, 120)}`;
  }
  // The command, plus every string it hands to another shell (`bash -c …`,
  // `eval …`), each scanned on its own.
  const texts = [cmd];
  for (const seg of splitSegments(cmd)) {
    const { bin, args } = parseCommand(seg);
    const inner = innerShellCommand(bin, args);
    if (inner) texts.push(inner);
  }
  for (const t of texts) {
    const stripped = stripDataHeredocs(t);
    const masked = maskQuotedProse(stripped);
    if (FORCE_PUSH_RE.test(masked)) return "force-pushes over shared git history";
    if (PIPE_TO_SHELL_RE.test(masked) || SHELL_OF_DOWNLOAD_RE.test(t)) return "pipes a remote download into a shell";
    const rm = recursiveDeleteOutsideCwd(stripped, context && context.cwd);
    if (rm) return rm;
  }
  return null;
}

/** Blank quoted spans that contain whitespace — prose, not commands — in
 *  one left-to-right scan that pairs quotes the way the shell does. The
 *  global-regex version paired a CLOSING quote with the next opening one:
 *  in `A="x"; rm -rf "/"` it masked `; rm -rf ` as prose and the command
 *  between two short quoted arguments vanished from the floor's view
 *  (gatewaystack-connect#1229). */
export function maskQuotedProse(s) {
  let out = "";
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch !== "'" && ch !== '"') { out += ch; i++; continue; }
    let j = i + 1;
    while (j < s.length && !(s[j] === ch && s[j - 1] !== "\\")) j++;
    const inner = s.slice(i + 1, j);
    if (j >= s.length) { out += ch + inner; break; }
    out += /\s/.test(inner) ? ch + ch : ch + inner + ch;
    i = j + 1;
  }
  return out;
}

// ── Uninstall floor (ask-level; gatewaystack-connect#1229) ─────────────
// Easy for the human, not for the agent. A human typing `acp-uninstall` in
// a terminal never passes through this hook. An AGENT removing ACP asks —
// and the OFFLINE floor is the one that matters most here: an outage, or
// deleting the key first, must not be the uninstall path. Three shapes:
//   (a) the sanctioned uninstaller: `acp-uninstall` / `acp-uninstall.cmd`
//       in command position, or a shell/pwsh running the cached copy;
//   (b) fetching the hosted uninstaller (curl/wget/irm/iwr/Invoke-*);
//   (c) a recursive delete aimed at `.acp`, or at a VARIABLE in a payload
//       that also names `.acp` — the 2026-09-17 removal bound the path two
//       statements earlier (`$acp = Join-Path $env:USERPROFILE '.acp'`)
//       and deleted `$acp`; no per-segment verb+path rule can see that.
// Same fixtures as the gateway's floor, so an offline call and a governed
// call agree.

// Mirrors the gateway's riskClassifier.ts (#1277): same regexes, same
// per-statement variable rule, so an offline call and a governed call agree.
const UNINSTALL_WRAPPER = String.raw`(?:(?:sudo|doas|env|nice|nohup|setsid|stdbuf|timeout|time|command|builtin)\s+(?:-\S+\s+)*)*`;
// `command acp-uninstall`, `npx acp-uninstall`, and a QUOTED full path
// (`"$HOME/.acp/bin/acp-uninstall"`) are still the uninstaller in command position.
const UNINSTALL_CMD_RE = new RegExp(
  String.raw`(?:^|[;&|]\s*|\$\(\s*)${UNINSTALL_WRAPPER}(?:(?:npx|pnpx|bunx)\s+(?:-\S+\s+)*)?['"]?(?:\S*[/\\])?acp-uninstall(?:\.cmd)?(?=['"\s;&|)]|$)`,
  "m",
);
// The cached uninstaller run by a launcher (`bash …`, `bash < …`, `source …`,
// `. …`, PowerShell's `& "…\uninstall.ps1"`) …
const UNINSTALL_SCRIPT_RE = new RegExp(
  String.raw`(?:^|[;&|]\s*|\$\(\s*)${UNINSTALL_WRAPPER}(?:(?:(?:ba|z|da|k)?sh|pwsh|powershell)(?:\.exe)?\b|source\b|\.(?=\s)|&(?=\s))[^\n;|&]*?[/\\]\.acp[/\\]uninstall\.(?:sh|ps1)\b`,
  "im",
);
// … or executed directly (`~/.acp/uninstall.sh`).
const UNINSTALL_SCRIPT_DIRECT_RE = /(?:^|[;&|]\s*|\$\(\s*)['"]?\S*[/\\]\.acp[/\\]uninstall\.(?:sh|ps1)\b/im;
const UNINSTALL_FETCH_RE = /\b(?:curl|wget|irm|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*?agenticcontrolplane\.com\/uninstall\.(?:sh|ps1)\b/i;
// `find ~/.acp -delete` / `find ~ -name .acp -exec rm -rf {} +`.
const FIND_DELETE_RE = /\bfind\b[^\n;|&]*?[\s'"/\\]\.acp(?![\w.-])[^\n;|&]*?\s(?:-delete\b|-exec\s+(?:\S*[/\\])?(?:rm|rmdir|unlink)\b)/i;
// Inline scripts are quoted spans with whitespace (blanked by the prose
// mask): scan the RAW literal for a tree-delete call naming .acp.
const SCRIPT_LITERAL_RE = /\b(?:python\d?(?:\.\d+)?|node|ruby|perl)\b[^\n]*?\s-[a-zA-Z]*[ce]\s+(['"])([\s\S]*?)\1/gi;
const SCRIPT_DELETE_CALL_RE = /\b(?:rmtree|rmSync|rmdirSync|rm_rf|rm_r|remove_tree|rimraf|removeSync|remove_dir_all)\b/;
const SCRIPT_ACP_RE = /[/\\'"]\.acp(?![\w.-])/;
// Turning the plugin off is the other exit.
const PLUGIN_DISABLE_RE = new RegExp(
  String.raw`(?:^|[;&|]\s*|\$\(\s*)${UNINSTALL_WRAPPER}(?:\S*[/\\])?claude(?:\.cmd|\.exe)?\s+plugins?\s+(?:disable|uninstall|remove|rm)\b[^\n;|&]*?(?:\s|['"])(?:agentic-control-plane|acp)(?![\w-])`,
  "im",
);
// Any recursive-delete statement, POSIX / PowerShell / cmd.exe (`rd /s`).
const RECURSIVE_DELETE_RE = /\b(?:remove-item|ri|rm|del|erase|rd|rmdir)\b([^\n;|&]*)/gi;
const RECURSE_FLAG_RE = /\s(?:-(?!force\b)(?:recurse|[a-z]{0,3}r[a-z]{0,3})|\/s)(?=\s|$)/i;
const VAR_OPERAND_RE = /(?:^|\s|\(|["'])(?:\$(?:\{|env:|[A-Za-z_])|%[A-Za-z_]\w*%)/;
// `.acp` as a path component: NOT continued by a name character, so
// `.acp;` / `.acp&` / `.acp,` are the dir; `.acpx`, `.acp-cache` are not.
const ACP_DIR_MENTION_RE = /(?:^|[\s\\/'"(=])\.acp(?![\w.-])/m;
const SEGMENT_SPLIT_RE = /(\n|;|&&|\|\||\||&)/;
const ASSIGN_RE = /(?:^|[\s(;{])(?:(?:export|declare|local|readonly|typeset|set)\s+(?:-\w+\s+)*)?\$?(?:env:)?([A-Za-z_]\w*)\s*=(?!=)/gi;
const LOOP_BIND_RE = /\b(?:for|foreach)\s*\(?\s*\$?([A-Za-z_]\w*)\s+in\b/gi;
const VAR_REF_RE = /\$\{?(?:env:)?([A-Za-z_]\w*)|%([A-Za-z_]\w*)%/g;
const PS_SHAPE_RE = /\$env:[A-Za-z_]\w*|\[[A-Za-z][\w.]*\]::|\s-ErrorAction\b|\b(?:Join-Path|Remove-Item|Write-Host|Test-Path|Get-ChildItem|Get-Content|Set-Content|Out-File|New-Item|Copy-Item|Move-Item|Invoke-WebRequest|Invoke-RestMethod|Invoke-Expression|Start-Process)\b/i;
// PowerShell's `-Command`/`-c` string is a launder the same way `sh -c` is.
const PWSH_COMMAND_RE = /\b(?:powershell|pwsh)(?:\.exe)?\b[^'"\n;|&]*?\s-(?:c|command)\s+(['"])([\s\S]*?)\1/gi;

/** Drop `# …` comments (a `#` at line start or after whitespace). Apply
 *  AFTER the quote mask so a `#` inside a short quoted operand survives. */
export function stripShellComments(s) {
  return s.includes("#") ? s.replace(/(^|\s)#[^\n]*/g, "$1") : s;
}

function referencesVar(text, names) {
  if (!names.size) return false;
  VAR_REF_RE.lastIndex = 0;
  let m;
  while ((m = VAR_REF_RE.exec(text)) !== null) {
    if (names.has((m[1] || m[2] || "").toLowerCase())) return true;
  }
  return false;
}

/** The variable rule, per statement: a recursive delete of `$var` fires only
 *  when its OWN segment names `.acp`, or `$var` was bound to a `.acp` path in
 *  an earlier segment, or the operand arrives by pipeline from a segment
 *  that names `.acp`. */
function recursiveDeleteOfAcp(masked) {
  const parts = masked.split(SEGMENT_SPLIT_RE);
  const acpVars = new Set();
  let prevMentions = false;
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i];
    const sep = i > 0 ? parts[i - 1] : "";
    const mentions = ACP_DIR_MENTION_RE.test(seg) || referencesVar(seg, acpVars);
    if (mentions) {
      let b;
      ASSIGN_RE.lastIndex = 0;
      while ((b = ASSIGN_RE.exec(seg)) !== null) acpVars.add(b[1].toLowerCase());
      LOOP_BIND_RE.lastIndex = 0;
      while ((b = LOOP_BIND_RE.exec(seg)) !== null) acpVars.add(b[1].toLowerCase());
    }
    const piped = sep === "|" && prevMentions;
    prevMentions = mentions;
    RECURSIVE_DELETE_RE.lastIndex = 0;
    let m;
    while ((m = RECURSIVE_DELETE_RE.exec(seg)) !== null) {
      const args = m[1] || "";
      if (!RECURSE_FLAG_RE.test(args)) continue;
      if (ACP_DIR_MENTION_RE.test(args) || piped) return true;
      if (VAR_OPERAND_RE.test(args) && (mentions || referencesVar(args, acpVars))) return true;
    }
  }
  return false;
}

/** Ask-level floor for an agent-initiated ACP removal: the label, or null. */
export function uninstallFloor(toolName, toolInput) {
  const name = String(toolName || "");
  if (name !== "Bash" && name !== "run_terminal_cmd" && name !== "shell") return null;
  const input = typeof toolInput === "string" ? safeParse(toolInput) : (toolInput || {});
  const cmd = String(input.command || input.cmd || "");
  if (!cmd) return null;
  const texts = [cmd];
  for (const seg of splitSegments(cmd)) {
    const { bin, args } = parseCommand(seg);
    const inner = innerShellCommand(bin, args);
    if (inner) texts.push(inner);
  }
  let m;
  PWSH_COMMAND_RE.lastIndex = 0;
  while ((m = PWSH_COMMAND_RE.exec(cmd)) !== null) texts.push(m[2]);
  // Heredoc bodies and comments do not make a line PowerShell (#1277).
  const pwsh = PS_SHAPE_RE.test(stripShellComments(maskQuotedProse(stripDataHeredocs(cmd))));
  for (const t of texts) {
    const masked = stripShellComments(maskQuotedProse(stripDataHeredocs(t)));
    if (UNINSTALL_CMD_RE.test(masked) || UNINSTALL_SCRIPT_RE.test(masked) || UNINSTALL_SCRIPT_DIRECT_RE.test(masked)) {
      return "runs the ACP uninstaller";
    }
    if (UNINSTALL_FETCH_RE.test(masked)) return "fetches the ACP uninstaller";
    if (PLUGIN_DISABLE_RE.test(masked)) return "disables the ACP plugin";
    if (FIND_DELETE_RE.test(masked) || recursiveDeleteOfAcp(masked)) {
      return `removes the ACP directory (${pwsh ? "PowerShell" : "shell"})`;
    }
    SCRIPT_LITERAL_RE.lastIndex = 0;
    let s;
    while ((s = SCRIPT_LITERAL_RE.exec(t)) !== null) {
      if (SCRIPT_DELETE_CALL_RE.test(s[2]) && SCRIPT_ACP_RE.test(s[2])) return "removes the ACP directory (script)";
    }
  }
  return null;
}

const SEVERITY = { allow: 0, ask: 1, deny: 2 };

/**
 * Decide a tool call locally.
 * @param policy { default: "allow"|"ask"|"deny", rules: { [key]: "allow"|"ask"|"deny" },
 *                 contextGuard?: { maxLines, mode: "off"|"shadow"|"enforce", action?: "deny"|"ask", guidance? } }
 * @param context { files?: { [path]: { lines, bytes } }, harness?: string } — measured by the dispatcher
 * @returns { decision, reason, source, classified, contextGuard? }
 */
export function decide(toolName, toolInput, policy, context) {
  const floor = hardlineFloor(toolName, toolInput);
  if (floor) return { decision: "deny", reason: floor, source: "hardline", classified: classifyTool(toolName, toolInput) };

  const key = classifyTool(toolName, toolInput);
  const rules = (policy && policy.rules) || {};

  // Context guard: a sized read over the line ceiling. Enforce → deny/ask
  // with the steer; shadow → decide as usual, but carry what would have
  // happened (and the tokens it would have kept out of context) so the
  // audit line records it.
  const guard = contextGuard(readIntent(toolName, toolInput), context && context.files, policy && policy.contextGuard);
  if (guard && guard.mode === "enforce") {
    const steer = guard.guidance || contextGuardSteer(context && context.harness);
    return { decision: guard.action, source: "context-guard", classified: key, contextGuard: guard,
             reason: `whole-file read of ${guard.effectiveLines} lines (ceiling ${guard.maxLines}; ~${guard.estTokens} tokens into context). ${steer}` };
  }
  const shadow = guard && guard.mode === "shadow" ? guard : undefined;

  // EVERY unit of a compound command is policy-checked, and the strictest
  // matched rule wins (deny > ask > allow) — so `true && gcloud …` cannot
  // slip a gcloud rule behind a benign first segment (#18).
  const units = bashUnits(toolName, toolInput);
  const keys = units && units.length ? [...new Set(units.map(unitKey))] : [key];
  let hit = null;
  for (const k of keys) {
    for (const cand of candidates(k)) {
      const r = rules[cand];
      if (VALID.has(r)) {
        if (!hit || SEVERITY[r] > SEVERITY[hit.r]) hit = { r, cand };
        break;
      }
    }
  }
  const result = hit
    ? { decision: hit.r, reason: `local policy: ${hit.cand} → ${hit.r}`, source: "policy", classified: key, contextGuard: shadow }
    : (() => {
        const def = VALID.has(policy && policy.default) ? policy.default : "allow";
        return { decision: def, reason: `local policy: default → ${def}`, source: "default", classified: key, contextGuard: shadow };
      })();

  // Uninstall floor (gatewaystack-connect#1229): an agent removing ACP
  // asks, in every mode — a policy allow cannot loosen it. Checked before
  // the destructive floor so the human reads what is actually happening
  // ("removes ACP") rather than the generic shape ("pipes a download").
  if (result.decision === "allow") {
    const exit = uninstallFloor(toolName, toolInput);
    if (exit) {
      return { decision: "ask", reason: `uninstall floor: ${exit}`, source: "uninstall-floor", classified: key, contextGuard: shadow, floor: exit };
    }
  }
  // Destructive floor (#1097): tightens an allow to ask in every mode. A
  // policy deny or ask already stands; a policy allow cannot loosen it.
  if (result.decision === "allow") {
    const destructive = destructiveFloor(toolName, toolInput, context);
    if (destructive) {
      return { decision: "ask", reason: `destructive floor: ${destructive}`, source: "destructive-floor", classified: key, contextGuard: shadow, floor: destructive };
    }
  }
  return result;
}
