/**
 * Shared types for the Canvas MCP server.
 *
 * Canvas resource shapes are intentionally minimal — only fields the typed
 * tools and the lifted code_api modules actually consume are declared. Pass-
 * through fields are typed as `unknown` rather than re-modeled.
 */

export interface CanvasConfig {
  apiUrl: string;
  apiToken: string;
  timeoutMs?: number;
}

export type CanvasErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "VALIDATION"
  | "SERVER_ERROR"
  | "NETWORK"
  | "UNKNOWN";

export class CanvasApiError extends Error {
  readonly code: CanvasErrorCode;
  readonly status?: number;
  readonly canvasMessage?: string;
  readonly endpoint?: string;

  constructor(args: {
    code: CanvasErrorCode;
    message: string;
    status?: number;
    canvasMessage?: string;
    endpoint?: string;
  }) {
    super(args.message);
    this.name = "CanvasApiError";
    this.code = args.code;
    this.status = args.status;
    this.canvasMessage = args.canvasMessage;
    this.endpoint = args.endpoint;
  }
}

/** Canvas enrollment roles we care about for FERPA gating. */
export type CanvasRole =
  | "student"
  | "teacher"
  | "ta"
  | "admin"
  | "observer"
  | "designer"
  | null
  | undefined;

export interface CanvasUserLite {
  id: number | string;
  name?: string;
  short_name?: string;
  sortable_name?: string;
  email?: string;
  login_id?: string;
  role?: CanvasRole;
  enrollments?: Array<{ type?: string; role?: string }>;
  [key: string]: unknown;
}

export interface CanvasCourseLite {
  id: number;
  name: string;
  course_code?: string;
  term?: { name?: string } | null;
  [key: string]: unknown;
}

export interface AnonMapEntry {
  pseudonym: string;
  anonymizedEmail: string;
  status: "active" | "historical";
}

export interface AnonMapFile {
  version: 1;
  courseId: number;
  generatedAt: string;
  students: Record<string, AnonMapEntry>;
}
