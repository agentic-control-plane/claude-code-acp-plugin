#!/usr/bin/env node

// Every merge to main is a release: install.sh serves bin/govern.mjs from main
// to every new install. The gateway's hook attestation pins the FIRST hash it
// sees for each PLUGIN_VERSION, so if govern.mjs changes and the version does
// not, every install of the new file is reported as a modified hook
// (0.29.0 shipped four different files that way, 10-07 → 10-23).
// bin/decide.mjs is loaded beside the hook and carries the enforcement floors,
// so a change there is a release too.
//
// Usage: node scripts/check-version-bump.mjs <base-ref>   (CI passes origin/main)
// Compares the base against the working tree, so it also works before a commit.

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { compareSemver, parseSemver } from "../lib/staleNotice.mjs";

const RELEASED = ["bin/govern.mjs", "bin/decide.mjs"];

const base = process.argv[2];
if (!base) {
  console.error("usage: check-version-bump.mjs <base-ref>");
  process.exit(2);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const versionOf = (src) => src.match(/PLUGIN_VERSION = "([^"]*)"/)?.[1] ?? null;

// Two-dot against the working tree: in a CI pull_request checkout HEAD is the
// merge of the PR into base, so this is exactly the PR's change.
const changed = git("diff", "--name-only", base, "--", ...RELEASED).trim().split("\n").filter(Boolean);
if (!changed.length) {
  console.log(`  ✔ ${RELEASED.join(", ")} unchanged — no version bump needed`);
  process.exit(0);
}

const before = versionOf(git("show", `${base}:bin/govern.mjs`));
const after = versionOf(readFileSync("bin/govern.mjs", "utf8"));
if (!parseSemver(after ?? "") || !parseSemver(before ?? "") || compareSemver(after, before) <= 0) {
  console.error(`  ✘ ${changed.join(", ")} changed but PLUGIN_VERSION went ${before} → ${after}.`);
  console.error("    Raise it above the base (and plugin.json + .claude-plugin/marketplace.json): the gateway pins one");
  console.error("    hash per version, so a changed hook under a version it has seen flags every install as tampered.");
  process.exit(1);
}
console.log(`  ✔ ${changed.join(", ")} changed and PLUGIN_VERSION moved ${before} → ${after}`);
