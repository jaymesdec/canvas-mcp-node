/**
 * Operator-controlled feature flags read from process.env.
 *
 * These are read at call time, not at startup, so toggling them in tests or
 * during the lifetime of the server (e.g., a teacher temporarily flipping the
 * flag for a real-names workflow, then restarting Claude Desktop) takes effect
 * immediately.
 */

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function readBoolEnv(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  return TRUE_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Returns true only when the operator has explicitly opted in to de-anonymized
 * tool output via CANVAS_MCP_ALLOW_DEANONYMIZE. When false (the default):
 *   - any `anonymous: false` tool argument is silently overridden to true
 *   - create_student_anonymization_map suppresses real_name / real_email fields
 *
 * The Anonymizer's on-disk map still persists real ↔ pseudonym bindings for
 * future lookups — this flag controls *output*, not storage.
 */
export function isDeanonymizationAllowed(): boolean {
  return readBoolEnv("CANVAS_MCP_ALLOW_DEANONYMIZE");
}

/**
 * Resolve the effective anonymization flag, honoring the operator env gate.
 * When the caller asks for anonymous: false but CANVAS_MCP_ALLOW_DEANONYMIZE is
 * not set, force back to true; callers surface DEANON_DENIED_NOTE in warnings[].
 */
export function resolveAnonymous(requested: boolean | undefined): {
  anonymous: boolean;
  overridden: boolean;
} {
  const wantedAnonymous = requested ?? true;
  if (wantedAnonymous === false && !isDeanonymizationAllowed()) {
    return { anonymous: true, overridden: true };
  }
  return { anonymous: wantedAnonymous, overridden: false };
}

export const DEANON_DENIED_NOTE =
  "anonymous=false was requested but the operator has not opted in to de-anonymized output " +
  "(set CANVAS_MCP_ALLOW_DEANONYMIZE=true in the MCP server env and restart). " +
  "Returning anonymized output instead.";

export const DEANON_DENIED_NOTE_MAP =
  "Real names/emails suppressed because the operator has not opted in to de-anonymized output " +
  "(set CANVAS_MCP_ALLOW_DEANONYMIZE=true in the MCP server env and restart). " +
  "Pseudonyms have still been allocated and persisted to disk.";
