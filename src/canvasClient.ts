import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type Method,
} from "axios";
import { CanvasApiError, type CanvasErrorCode } from "./types.js";

export interface CanvasClientOptions {
  baseUrl: string;
  apiToken: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxPages?: number;
  /** Inject a pre-built axios instance (used by tests). */
  axiosInstance?: AxiosInstance;
}

export interface PaginatedResult<T> {
  items: T[];
  /** True when pagination hit `maxPages` and there were probably more pages. */
  truncated: boolean;
  pages: number;
}

export interface RequestOptions {
  params?: Record<string, unknown>;
  data?: unknown;
  headers?: Record<string, string>;
  /** Per-call timeout override (ms). */
  timeoutMs?: number;
  /** Per-call retry override. */
  maxRetries?: number;
  responseType?: "json" | "stream" | "arraybuffer";
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_PAGES = 100;

/** Strip trailing slash and trailing `/api/v1` so callers can supply paths starting with `/api/v1/...`. */
function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (url.endsWith("/api/v1")) {
    url = url.slice(0, -"/api/v1".length);
  }
  return url;
}

function statusToCode(status: number | undefined): CanvasErrorCode {
  if (status === undefined) return "NETWORK";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 400 && status < 500) return "VALIDATION";
  if (status >= 500) return "SERVER_ERROR";
  return "UNKNOWN";
}

function parseRetryAfterMs(headerValue: unknown): number | null {
  if (typeof headerValue !== "string" || headerValue.trim() === "") return null;
  const asInt = Number(headerValue);
  if (Number.isFinite(asInt) && asInt >= 0) return Math.round(asInt * 1000);
  const asDate = Date.parse(headerValue);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

/**
 * Parse RFC 5988 `Link` header and return the URL marked rel="next", or null.
 * Canvas emits a single Link header with comma-separated entries.
 */
export function extractNextLink(linkHeader: string | undefined | null): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (match && match[2] === "next") return match[1];
  }
  return null;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface EnrolledCourse {
  id: number;
  course_code?: string | null;
  name?: string | null;
  workflow_state?: string | null;
  term?: { name?: string | null } | null;
}

const COURSE_CANDIDATE_LIMIT = 10;

function formatCourseCandidate(course: EnrolledCourse): string {
  const term = course.term?.name ?? "no term";
  const state = course.workflow_state ?? "unknown state";
  return `${course.course_code ?? "(no code)"} (id ${course.id}) — ${course.name ?? "(no name)"} [${term}, ${state}]`;
}

function formatCandidateList(candidates: EnrolledCourse[]): string {
  const shown = candidates.slice(0, COURSE_CANDIDATE_LIMIT).map(formatCourseCandidate);
  const overflow = candidates.length - shown.length;
  return shown.join("; ") + (overflow > 0 ? `; +${overflow} more` : "");
}

export class CanvasClient {
  readonly baseUrl: string;
  readonly axios: AxiosInstance;
  private readonly defaultMaxRetries: number;
  private readonly defaultMaxPages: number;

  /** course code (lowercased) → course id */
  private readonly courseCodeCache = new Map<string, number>();
  /** course id → course code (for round-tripping) */
  private readonly courseIdToCode = new Map<number, string>();

  constructor(options: CanvasClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.defaultMaxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.defaultMaxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.axios =
      options.axiosInstance ??
      axios.create({
        baseURL: this.baseUrl,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${options.apiToken}`,
          Accept: "application/json",
        },
        validateStatus: () => true, // we inspect status ourselves
      });
  }

  /** Central request method with typed errors and 429 retry. */
  async request<T>(
    method: Method,
    path: string,
    options: RequestOptions = {},
  ): Promise<AxiosResponse<T>> {
    const maxRetries = options.maxRetries ?? this.defaultMaxRetries;
    const config: AxiosRequestConfig = {
      method,
      url: path,
      params: options.params,
      data: options.data,
      headers: options.headers,
      responseType: options.responseType ?? "json",
    };
    if (options.timeoutMs !== undefined) config.timeout = options.timeoutMs;

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.axios.request<T>(config);
        const status = response.status;

        if (status >= 200 && status < 300) return response;

        if (status === 429 && attempt < maxRetries) {
          const retryAfterMs =
            parseRetryAfterMs(response.headers?.["retry-after"]) ??
            Math.min(8000, 2 ** attempt * 500);
          await sleep(retryAfterMs);
          continue;
        }

        if (status >= 500 && attempt < maxRetries) {
          await sleep(Math.min(8000, 2 ** attempt * 500));
          continue;
        }

        throw new CanvasApiError({
          code: statusToCode(status),
          status,
          message: `Canvas ${method} ${path} failed: ${status}`,
          canvasMessage: extractCanvasMessage(response.data),
          endpoint: path,
        });
      } catch (error) {
        if (error instanceof CanvasApiError) throw error;
        lastError = error;
        // Network errors get retried unless we're out of attempts
        if (attempt < maxRetries) {
          await sleep(Math.min(8000, 2 ** attempt * 500));
          continue;
        }
        const message =
          error instanceof Error ? error.message : String(error);
        throw new CanvasApiError({
          code: "NETWORK",
          message: `Canvas ${method} ${path} failed: ${message}`,
          endpoint: path,
        });
      }
    }

    // Defensive — loop should have returned or thrown.
    throw new CanvasApiError({
      code: "UNKNOWN",
      message: `Canvas ${method} ${path} exhausted retries`,
      endpoint: path,
    });
  }

  /** GET shortcut returning the parsed JSON body. */
  async get<T>(path: string, options?: RequestOptions): Promise<T> {
    const response = await this.request<T>("GET", path, options);
    return response.data;
  }

  async post<T>(path: string, data?: unknown, options?: RequestOptions): Promise<T> {
    const response = await this.request<T>("POST", path, { ...options, data });
    return response.data;
  }

  async put<T>(path: string, data?: unknown, options?: RequestOptions): Promise<T> {
    const response = await this.request<T>("PUT", path, { ...options, data });
    return response.data;
  }

  async del<T>(path: string, options?: RequestOptions): Promise<T> {
    const response = await this.request<T>("DELETE", path, options);
    return response.data;
  }

  /**
   * Walk Canvas Link-header pagination until exhausted or `maxPages` is hit.
   * Returns the concatenated items plus a `truncated` flag.
   */
  async getPaginated<T>(
    path: string,
    options: RequestOptions & { maxPages?: number; perPage?: number } = {},
  ): Promise<PaginatedResult<T>> {
    const maxPages = options.maxPages ?? this.defaultMaxPages;
    const perPage = options.perPage ?? 100;

    const firstParams = {
      ...(options.params ?? {}),
      per_page: (options.params as Record<string, unknown> | undefined)?.per_page ?? perPage,
    };

    const items: T[] = [];
    let response = await this.request<T[]>("GET", path, {
      ...options,
      params: firstParams,
    });
    let pages = 1;
    if (Array.isArray(response.data)) items.push(...response.data);

    while (pages < maxPages) {
      const linkHeader = response.headers?.link as string | undefined;
      const nextUrl = extractNextLink(linkHeader);
      if (!nextUrl) {
        return { items, truncated: false, pages };
      }

      // Strip the configured baseURL prefix so axios doesn't double-prepend it.
      const followPath = nextUrl.startsWith(this.baseUrl)
        ? nextUrl.slice(this.baseUrl.length)
        : nextUrl;

      response = await this.request<T[]>("GET", followPath, {
        headers: options.headers,
        timeoutMs: options.timeoutMs,
        maxRetries: options.maxRetries,
        responseType: options.responseType,
      });
      pages += 1;
      if (Array.isArray(response.data)) items.push(...response.data);
    }

    // We hit maxPages — check whether another page existed to set the flag honestly.
    const finalLink = response.headers?.link as string | undefined;
    const truncated = extractNextLink(finalLink) !== null;
    return { items, truncated, pages };
  }

  /**
   * Resolve a course identifier (code or numeric id) to a numeric id.
   * Non-numeric identifiers resolve ONLY on a unique exact (case-insensitive)
   * course_code or name match within the caller's own enrollments — zero or
   * multiple exact matches throw with a candidate list instead of guessing.
   * Caches successful lookups (never evicted; the user has a finite career-long course set).
   *
   * @param identifier  course id (string or number) or course code (e.g. "BADM_554_120251_246794")
   * @param options.bypassCache  set true for write paths so a rename can't misroute the write
   */
  async resolveCourseId(
    identifier: string | number,
    options: { bypassCache?: boolean } = {},
  ): Promise<number> {
    if (typeof identifier === "number" && Number.isFinite(identifier)) {
      // Numeric id passed directly — trust it.
      return identifier;
    }
    const raw = String(identifier).trim();
    if (raw === "") {
      throw new CanvasApiError({
        code: "VALIDATION",
        message: "resolveCourseId: identifier was empty",
      });
    }

    // Bare numeric string → numeric id
    if (/^\d+$/.test(raw)) return Number(raw);

    const cacheKey = raw.toLowerCase();
    if (!options.bypassCache) {
      const cached = this.courseCodeCache.get(cacheKey);
      if (cached !== undefined) return cached;
    }

    // search_term is undocumented on the enrollment-scoped courses endpoint, so
    // matching is client-side over the full paginated enrollment list. Concluded
    // states are pinned in so a cross-term duplicate code surfaces as ambiguous
    // instead of silently resolving to whichever term's course came back.
    const { items: enrolledCourses } = await this.getPaginated<EnrolledCourse>(
      "/api/v1/courses",
      {
        params: {
          "state[]": ["unpublished", "available", "completed"],
          "include[]": ["term"],
        },
      },
    );

    const exactCodeMatches = enrolledCourses.filter(
      (course) => course.course_code?.toLowerCase() === cacheKey,
    );
    const exactNameMatches = enrolledCourses.filter(
      (course) => course.name?.toLowerCase() === cacheKey,
    );

    const match =
      exactCodeMatches.length === 1
        ? exactCodeMatches[0]
        : exactCodeMatches.length === 0 && exactNameMatches.length === 1
          ? exactNameMatches[0]
          : undefined;

    if (!match) {
      const ambiguousMatches =
        exactCodeMatches.length > 1
          ? exactCodeMatches
          : exactNameMatches.length > 1
            ? exactNameMatches
            : null;
      if (ambiguousMatches) {
        throw new CanvasApiError({
          code: "VALIDATION",
          message:
            `resolveCourseId: "${raw}" exactly matches ${ambiguousMatches.length} courses — pass the numeric id to disambiguate. ` +
            `Candidates: ${formatCandidateList(ambiguousMatches)}.`,
        });
      }
      const substringMatches = enrolledCourses.filter(
        (course) =>
          course.course_code?.toLowerCase().includes(cacheKey) ||
          course.name?.toLowerCase().includes(cacheKey),
      );
      const candidates = substringMatches.length > 0 ? substringMatches : enrolledCourses;
      const candidateText =
        candidates.length > 0 ? ` Candidates: ${formatCandidateList(candidates)}.` : "";
      throw new CanvasApiError({
        code: "NOT_FOUND",
        message:
          `resolveCourseId: no enrolled course has an exact course_code or name match for "${raw}".${candidateText} ` +
          `Course codes resolve only within your own enrollments — for account-level courses, pass the numeric id from list_account_courses.`,
      });
    }

    this.courseCodeCache.set(cacheKey, match.id);
    if (match.course_code) {
      this.courseIdToCode.set(match.id, match.course_code);
    }
    return match.id;
  }

  /**
   * Seed the course-code caches from a course list already fetched elsewhere
   * (list_courses / get_course_details / list_account_courses) so numeric-id
   * callers keep code-labeled output at zero extra API cost. Codes appearing
   * more than once in the passed array are ambiguous and skipped for
   * code→id resolution; id→code always seeds.
   */
  seedCourseCodes(courses: Array<{ id: number; course_code?: string | null }>): void {
    const codeOccurrences = new Map<string, number>();
    for (const course of courses) {
      const key = course.course_code?.toLowerCase();
      if (!key) continue;
      codeOccurrences.set(key, (codeOccurrences.get(key) ?? 0) + 1);
    }
    for (const course of courses) {
      if (typeof course.id !== "number" || !course.course_code) continue;
      this.courseIdToCode.set(course.id, course.course_code);
      const key = course.course_code.toLowerCase();
      if (codeOccurrences.get(key) === 1) {
        this.courseCodeCache.set(key, course.id);
      }
    }
  }

  /** Look up the cached course code for a numeric id, or undefined if not cached. */
  getCachedCourseCode(courseId: number): string | undefined {
    return this.courseIdToCode.get(courseId);
  }
}

function extractCanvasMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const asObject = data as Record<string, unknown>;
  if (typeof asObject.message === "string") return asObject.message;
  const errors = asObject.errors;
  if (Array.isArray(errors)) {
    const messages = errors
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : entry && typeof entry === "object" && "message" in entry
            ? String((entry as { message: unknown }).message)
            : null,
      )
      .filter((entry): entry is string => entry !== null);
    if (messages.length > 0) return messages.join("; ");
  }
  if (errors && typeof errors === "object") {
    return JSON.stringify(errors);
  }
  return undefined;
}
