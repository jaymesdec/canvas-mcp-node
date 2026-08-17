import { CanvasApiError } from "../types.js";

export interface McpTextResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  /** Index signature required by the MCP SDK's CallToolResult type. */
  [key: string]: unknown;
}

/** Wrap a JSON-serializable payload as compact JSON text (optional summary line first). */
export function jsonResult(payload: unknown, options: { summary?: string } = {}): McpTextResult {
  const text = options.summary
    ? `${options.summary}\n\n${stringify(payload)}`
    : stringify(payload);
  return {
    content: [{ type: "text", text }],
  };
}

/** Plain-text result without any structured payload. */
export function textResult(text: string): McpTextResult {
  return { content: [{ type: "text", text }] };
}

/** Format an error as a tool error result (never throw out of a registered handler). */
export function errorResult(error: unknown, options: { context?: string } = {}): McpTextResult {
  const rawMessage =
    error instanceof Error ? error.message : String(error);
  const prefix =
    options.context && !rawMessage.startsWith(`${options.context}:`) ? `${options.context}: ` : "";
  let message: string;
  if (error instanceof CanvasApiError) {
    const canvas = error.canvasMessage ? ` — ${error.canvasMessage}` : "";
    message = `${prefix}${error.message}${canvas}`;
  } else if (error instanceof Error) {
    message = `${prefix}${error.message}`;
  } else {
    message = `${prefix}${String(error)}`;
  }
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/** Convenience: run an async handler and convert CanvasApiError/Error into a tool error result. */
export async function safeHandler(
  context: string,
  fn: () => Promise<McpTextResult>,
): Promise<McpTextResult> {
  try {
    return await fn();
  } catch (error) {
    return errorResult(error, { context });
  }
}

function stringify(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

/**
 * Allowlist projection: copy only `keys` from `source`, null-filling absent
 * values so trimmed shapes are stable across Canvas payload variations.
 */
export function pickFields<T extends Record<string, unknown>>(
  source: T,
  keys: readonly string[],
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    projected[key] = source[key] ?? null;
  }
  return projected;
}

/** Derive https://<host>/courses/<id> from the API base URL + course id. */
export function deriveCourseUrl(baseUrl: string, courseId: number): string {
  const base = baseUrl.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return `${base}/courses/${courseId}`;
}

/** Map of common include[] params into Canvas's repeated-key array format. */
export function buildIncludeParams(include: string[] | undefined): Record<string, unknown> {
  if (!include || include.length === 0) return {};
  return { "include[]": include };
}
