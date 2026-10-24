// gatewaystack-connect#1538 item 6: PLUGIN_VERSION in bin/govern.mjs is a
// literal (install.sh greps it; standalone installs have no manifest next to
// the hook), so this test is what stops it drifting from the manifests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("PLUGIN_VERSION literal matches plugin.json and marketplace.json and the install.sh grep shape", () => {
  const pluginVersion = JSON.parse(read("plugin.json")).version;
  const marketVersion = JSON.parse(read(".claude-plugin/marketplace.json")).plugins[0].version;
  // Exactly install.sh's extraction: first match in the whole file.
  const all = read("bin/govern.mjs").match(/PLUGIN_VERSION = "[^"]*"/g) ?? [];
  assert.equal(all.length, 1, "exactly one PLUGIN_VERSION = \"...\" match, even in comments");
  assert.equal(all[0].replace(/.*"(.*)"/, "$1"), pluginVersion);
  assert.equal(marketVersion, pluginVersion);
});

test("the hook reports that version in X-GS-Client", () => {
  const src = read("bin/govern.mjs");
  assert.ok(src.includes('"X-GS-Client": `${ACP_CLIENT}/${PLUGIN_VERSION}`'));
});
