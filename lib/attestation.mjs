// Canonical copy of the session-attestation payload logic (#403 paired
// arrival). bin/govern.mjs carries the same logic inline (it is
// deliberately self-contained, like vendor-patterns); this module exists
// so tests can pin the contract — the field names here are the wire
// contract with the gateway's /govern/attest endpoint.

import { createHash } from "crypto";
import { readFileSync } from "fs";

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** CRLF → LF, byte-transparent otherwise. The hook hashes its own file;
 *  Git for Windows (core.autocrlf=true, the installer default) checks
 *  that file out with CRLF, so without this the same release hashed
 *  differently per machine and default Windows installs attested as
 *  hash_mismatch. A file with no CR is returned unchanged, so LF hashes
 *  are identical to the pre-normalization ones. Lone CRs are kept — only
 *  the CRLF pair is a line-ending artifact. */
export function normalizeEol(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), "utf8");
  if (!b.includes(13)) return b;
  return Buffer.from(b.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
}

/** Hash of a file's contents with line endings normalized — the value
 *  govern.mjs reports as hook_hash. */
export function sha256FileHex(path) {
  return sha256Hex(normalizeEol(readFileSync(path)));
}

/** The attestation body. hook_hash is REQUIRED — an attestation that
 *  can't prove what's running is not an attestation. grants_present
 *  encodes the #375 pairing invariant: capability (harness grants) must
 *  be visible alongside authority (this hook, alive and hashed). */
export function buildAttestationPayload({
  sessionId,
  cwd,
  pluginVersion,
  hookHash,
  grantsHash,
  harness,
}) {
  if (!hookHash) return null;
  return {
    session_id: sessionId,
    cwd,
    hook_event_name: "SessionStart",
    plugin_version: pluginVersion,
    hook_hash: hookHash,
    grants_present: grantsHash != null,
    ...(grantsHash ? { grants_hash: grantsHash } : {}),
    harness,
  };
}

/** Upgrade-notice contract (gatewaystack-connect#849): the /govern/attest
 *  response may carry `notice` when the reporting plugin version is behind
 *  the registry's latest. Returns the ONE stdout JSON object SessionStart
 *  may write, or null. additionalContext reaches the model; a stale hook
 *  that can't render this is exactly the population the server-side
 *  console badge and founder-alert enrichment exist for. */
export function attestNoticeOutput(responseBody) {
  if (!responseBody || typeof responseBody.notice !== "string") return null;
  const notice = responseBody.notice.trim();
  if (!notice) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: notice,
    },
  };
}
