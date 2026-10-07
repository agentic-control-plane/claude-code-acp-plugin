// Test helper: the hook reaches a non-ACP or http loopback gateway ONLY via
// ~/.acp/dev_base_override (a file under HOME), never via env. Tests that
// point the hook at a loopback stub pass ACP_TEST_DEV_BASE=1 together with
// ACP_GOVERN_BASE / ACP_API_BASE in the spawn env; at spawn time this shim
// writes that URL into <HOME>/.acp/dev_base_override and strips the three
// variables. A spawn whose HOME is the real home directory gets a private
// temp HOME instead, so no test ever touches ~/.acp. Test-only: product code
// never reads ACP_TEST_DEV_BASE.
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

let scratchHome;

// Write the override file into `home` and return the env entries to spread.
export function devBase(home, url) {
  mkdirSync(join(home, ".acp"), { recursive: true });
  writeFileSync(join(home, ".acp", "dev_base_override"), `${url}\n`);
  return { HOME: home };
}

function prep(args) {
  const i = args.findIndex((a) => a && typeof a === "object" && !Array.isArray(a) && a.env);
  if (i < 0 || args[i].env.ACP_TEST_DEV_BASE !== "1") return args;
  const { ACP_TEST_DEV_BASE, ACP_GOVERN_BASE, ACP_API_BASE, ...env } = args[i].env;
  const url = ACP_GOVERN_BASE || ACP_API_BASE;
  if (!url) throw new Error("ACP_TEST_DEV_BASE=1 needs ACP_GOVERN_BASE or ACP_API_BASE");
  if (!env.HOME || env.HOME === homedir()) {
    scratchHome ??= mkdtempSync(join(tmpdir(), "acp-dev-base-home-"));
    env.HOME = scratchHome;
  }
  Object.assign(env, devBase(env.HOME, url));
  const out = args.slice();
  out[i] = { ...args[i], env };
  return out;
}

if (!cp.__acpDevBaseShim) {
  for (const name of ["spawn", "spawnSync"]) {
    const orig = cp[name];
    cp[name] = (...args) => orig(...prep(args));
  }
  cp.__acpDevBaseShim = true;
  syncBuiltinESMExports();
}
