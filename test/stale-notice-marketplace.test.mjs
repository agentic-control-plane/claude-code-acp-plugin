// acp-install#64: the "current" version in the stale notice must come from
// the marketplace (local clone, or the gateway's manifest-backed value),
// never a constant, and the remedy for a marketplace plugin must be the one
// command that actually switches the active version.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localMarketplaceVersion, newerOf, staleNoticeText, updateCommandFor } from "../lib/staleNotice.mjs";

function homeWith({ manifestVersion, location, known } = {}) {
  const home = mkdtempSync(join(tmpdir(), "acp-stale-"));
  const pluginsDir = join(home, ".claude", "plugins");
  const loc = location ?? join(pluginsDir, "marketplaces", "acp");
  if (manifestVersion !== undefined) {
    mkdirSync(join(loc, ".claude-plugin"), { recursive: true });
    writeFileSync(join(loc, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "acp",
      plugins: [{ name: "something-else", version: "9.9.9" }, { name: "agentic-control-plane", version: manifestVersion }],
    }));
  }
  if (known) {
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, "known_marketplaces.json"), JSON.stringify(known));
  }
  return home;
}

test("localMarketplaceVersion reads the acp clone's manifest at the default location", () => {
  const home = homeWith({ manifestVersion: "0.29.5" });
  assert.equal(localMarketplaceVersion({ home, fs, join }), "0.29.5");
});

test("localMarketplaceVersion follows known_marketplaces.json installLocation", () => {
  const home = mkdtempSync(join(tmpdir(), "acp-stale-"));
  const elsewhere = join(home, "elsewhere");
  homeWith({ manifestVersion: "0.30.1", location: elsewhere });
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(home, ".claude", "plugins", "known_marketplaces.json"),
    JSON.stringify({ acp: { installLocation: elsewhere } }));
  assert.equal(localMarketplaceVersion({ home, fs, join }), "0.30.1");
});

test("localMarketplaceVersion is null with no clone, a bad manifest, or a garbage version", () => {
  assert.equal(localMarketplaceVersion({ home: mkdtempSync(join(tmpdir(), "acp-stale-")), fs, join }), null);
  assert.equal(localMarketplaceVersion({ home: homeWith({ manifestVersion: "latest" }), fs, join }), null);
  const home = homeWith({ manifestVersion: "1.0.0" });
  writeFileSync(join(home, ".claude", "plugins", "marketplaces", "acp", ".claude-plugin", "marketplace.json"), "{not json");
  assert.equal(localMarketplaceVersion({ home, fs, join }), null);
});

test("newerOf prefers the higher readable version and tolerates garbage on either side", () => {
  assert.equal(newerOf("0.29.3", "0.29.5"), "0.29.5");
  assert.equal(newerOf("0.29.5", "0.29.3"), "0.29.5");
  assert.equal(newerOf(null, "0.29.5"), "0.29.5");
  assert.equal(newerOf("0.29.3", null), "0.29.3");
  assert.equal(newerOf("latest", "0.29.5"), "0.29.5");
  assert.equal(newerOf(null, undefined), null);
});

test("David's machine (acp-install#64): active 0.27.0, gateway says 0.29.3, clone holds 0.29.5 → notice names 0.29.5 and plugin update", () => {
  const home = homeWith({ manifestVersion: "0.29.5" });
  const latest = newerOf("0.29.3", localMarketplaceVersion({ home, fs, join }));
  const cmd = updateCommandFor({ pluginRoot: "/Users/x/.claude/plugins/cache/acp/agentic-control-plane/0.27.0" });
  const text = staleNoticeText({ current: "0.27.0", latest, minGood: null, updateCmd: cmd });
  assert.equal(text,
    "[ACP] governance hook v0.27.0 is outdated (v0.29.5 current). Run: claude plugin update agentic-control-plane@acp — then restart Claude Code");
  assert.doesNotMatch(text, /install\.sh/, "the installer cannot upgrade an installed plugin; never send the user there");
});

test("updateCommandFor: plugin root or a hook path under ~/.claude/plugins → plugin update; standalone hook → acp-update", () => {
  assert.match(updateCommandFor({ pluginRoot: "/h/.claude/plugins/cache/acp/agentic-control-plane/0.27.0" }), /^claude plugin update agentic-control-plane@acp/);
  assert.match(updateCommandFor({ pluginRoot: "", hookPath: "/h/.claude/plugins/cache/acp/agentic-control-plane/0.27.0/bin/govern.mjs" }), /^claude plugin update/);
  assert.match(updateCommandFor({ pluginRoot: "", hookPath: "C:\\Users\\h\\.claude\\plugins\\cache\\acp\\x\\bin\\govern.mjs" }), /^claude plugin update/);
  assert.equal(updateCommandFor({ pluginRoot: undefined, hookPath: "/h/.acp/govern.mjs" }), "acp-update");
});

test("current plugin with a current clone produces no notice", () => {
  const home = homeWith({ manifestVersion: "0.29.5" });
  const latest = newerOf(null, localMarketplaceVersion({ home, fs, join }));
  assert.equal(staleNoticeText({ current: "0.29.5", latest, minGood: null }), null);
});
