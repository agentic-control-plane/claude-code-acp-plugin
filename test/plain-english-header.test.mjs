// Pins the plain-English header at the top of bin/govern.mjs to the code
// beneath it. Evidence (2026-09-17): a new user's agent spent two minutes
// reading govern.mjs at four offsets and grepping it for `fetch(` and
// `process.exit` to answer "what leaves my machine, can this block me, what
// runs at session start" — then uninstalled by hand. The header answers
// those in the first screen, and every claim in it names the function that
// implements it so a reader can check. This test makes sure every function
// the header cites still exists, so the header cannot rot silently when
// code is renamed or removed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "govern.mjs");
const src = readFileSync(HOOK, "utf8");
const lines = src.split("\n");

const HEADER_TITLE = "What this file does to your machine";
const start = lines.findIndex((l) => l.includes(HEADER_TITLE));
const end = lines.findIndex((l, i) => i > start && /^\/\/ ─{20,}\s*$/.test(l));

test("the plain-English header sits directly under the shebang, above the developer header", () => {
  assert.ok(start >= 0, `header title "${HEADER_TITLE}" not found`);
  assert.ok(start <= 3, `header must start within the first lines (found at line ${start + 1})`);
  assert.ok(end > start, "header has no closing rule line");
  const developer = lines.findIndex((l) => l.includes("ACP Governance Hook — Pre- and Post-ToolUse interceptor"));
  assert.ok(developer > end, "the existing developer header must remain, below the plain-English one");
});

test("every function the header cites is declared in govern.mjs", () => {
  const header = lines.slice(start, end + 1).join("\n");
  // Function names in the header are camelCase identifiers with at least one
  // capital after the first letter (handlePreToolUse, readContext, …). Words,
  // paths, hosts and event names (PreToolUse) do not match that shape.
  const cited = new Set(header.match(/\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g) ?? []);
  assert.ok(cited.size >= 15, `expected the header to cite at least 15 functions, found ${cited.size}`);
  const body = lines.slice(end + 1).join("\n");
  const missing = [...cited].filter((name) => !new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(body));
  assert.deepEqual(missing, [], `header cites functions that are not declared: ${missing.join(", ")}`);
});

test("the header names the hosts the code actually talks to", () => {
  const header = lines.slice(start, end + 1).join("\n");
  for (const host of ["govern.agenticcontrolplane.com", "api.agenticcontrolplane.com"]) {
    assert.ok(header.includes(host), `header does not mention ${host}`);
    assert.ok(src.slice(lines.slice(0, end + 1).join("\n").length).includes(host), `code no longer references ${host}`);
  }
});
