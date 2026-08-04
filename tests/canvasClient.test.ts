import { describe, expect, it, vi } from "vitest";
import axios, {
  type AxiosAdapter,
  type AxiosRequestConfig,
  type AxiosResponse,
  AxiosHeaders,
} from "axios";

import { CanvasClient, extractNextLink } from "../src/canvasClient.js";
import { CanvasApiError } from "../src/types.js";

interface FakeResponse {
  status: number;
  data: unknown;
  headers?: Record<string, string>;
}

type RequestRecord = {
  method: string;
  url: string;
  fullUrl: string;
  params?: Record<string, unknown>;
  data?: unknown;
};

interface FakeAxiosResult {
  client: CanvasClient;
  requests: RequestRecord[];
}

/**
 * Build a CanvasClient with an injected axios instance that uses a custom
 * adapter. Each call to enqueue() registers the next response in order — the
 * adapter pops the head of the queue per request.
 */
function buildClient(responses: FakeResponse[], options?: { baseUrl?: string }): FakeAxiosResult {
  const baseUrl = options?.baseUrl ?? "https://canvas.example.com";
  const queue = [...responses];
  const requests: RequestRecord[] = [];

  const adapter: AxiosAdapter = (config: AxiosRequestConfig) => {
    const baseURL = (config.baseURL ?? "").replace(/\/+$/, "");
    const url = config.url ?? "";
    const isAbsolute = /^https?:\/\//.test(url);
    const fullUrl = isAbsolute ? url : `${baseURL}${url}`;

    requests.push({
      method: (config.method ?? "GET").toUpperCase(),
      url,
      fullUrl,
      params: config.params,
      data: config.data,
    });

    const next = queue.shift();
    if (!next) {
      return Promise.reject(new Error(`fake adapter: no response queued for ${config.method} ${url}`));
    }
    const headers = new AxiosHeaders();
    for (const [key, value] of Object.entries(next.headers ?? {})) {
      headers.set(key, value);
    }
    const response: AxiosResponse = {
      data: next.data,
      status: next.status,
      statusText: String(next.status),
      headers,
      config: config as AxiosRequestConfig & { headers: AxiosHeaders },
      request: {},
    };
    return Promise.resolve(response);
  };

  const instance = axios.create({
    baseURL: baseUrl,
    adapter,
    validateStatus: () => true,
    headers: { Authorization: "Bearer test-token" },
  });

  const client = new CanvasClient({
    baseUrl,
    apiToken: "test-token",
    axiosInstance: instance,
    maxRetries: 3,
    maxPages: 5,
  });

  return { client, requests };
}

describe("extractNextLink", () => {
  it("returns the URL marked rel=next", () => {
    const header =
      '<https://canvas.example.com/api/v1/courses?page=2&per_page=100>; rel="next", ' +
      '<https://canvas.example.com/api/v1/courses?page=5&per_page=100>; rel="last"';
    expect(extractNextLink(header)).toBe(
      "https://canvas.example.com/api/v1/courses?page=2&per_page=100",
    );
  });

  it("returns null when no next entry exists", () => {
    expect(extractNextLink('<https://x/courses?page=5>; rel="last"')).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractNextLink(undefined)).toBeNull();
    expect(extractNextLink(null)).toBeNull();
    expect(extractNextLink("")).toBeNull();
  });
});

describe("CanvasClient baseUrl normalization", () => {
  it("strips trailing /api/v1 and trailing slash", () => {
    const a = new CanvasClient({ baseUrl: "https://x.example.com/api/v1/", apiToken: "t" });
    const b = new CanvasClient({ baseUrl: "https://x.example.com/", apiToken: "t" });
    const c = new CanvasClient({ baseUrl: "https://x.example.com", apiToken: "t" });
    expect(a.baseUrl).toBe("https://x.example.com");
    expect(b.baseUrl).toBe("https://x.example.com");
    expect(c.baseUrl).toBe("https://x.example.com");
  });
});

describe("CanvasClient.getPaginated", () => {
  it("walks two pages and concatenates results", async () => {
    const { client, requests } = buildClient([
      {
        status: 200,
        data: [{ id: 1 }, { id: 2 }],
        headers: {
          link: '<https://canvas.example.com/api/v1/courses?page=2&per_page=100>; rel="next"',
        },
      },
      { status: 200, data: [{ id: 3 }] },
    ]);

    const result = await client.getPaginated<{ id: number }>("/api/v1/courses");
    expect(result.items.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(result.truncated).toBe(false);
    expect(result.pages).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("/api/v1/courses");
    // Second request follows the absolute next-URL trimmed of baseURL
    expect(requests[1]?.url).toBe("/api/v1/courses?page=2&per_page=100");
  });

  it("returns [] for an empty first page without erroring", async () => {
    const { client } = buildClient([{ status: 200, data: [] }]);
    const result = await client.getPaginated("/api/v1/courses");
    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.pages).toBe(1);
  });

  it("flags truncated=true when maxPages is reached and a next link still exists", async () => {
    // maxPages was set to 5 in buildClient; queue 5 paginated responses each
    // with a next link, plus a guard response that should not be requested.
    const pageWithNext = (page: number) => ({
      status: 200,
      data: [{ id: page }],
      headers: {
        link: `<https://canvas.example.com/api/v1/courses?page=${page + 1}>; rel="next"`,
      },
    });
    const { client, requests } = buildClient([
      pageWithNext(1),
      pageWithNext(2),
      pageWithNext(3),
      pageWithNext(4),
      pageWithNext(5),
      { status: 200, data: [{ id: 999 }] }, // sentinel — must NOT be fetched
    ]);

    const result = await client.getPaginated<{ id: number }>("/api/v1/courses");
    expect(result.pages).toBe(5);
    expect(result.items.map((item) => item.id)).toEqual([1, 2, 3, 4, 5]);
    expect(result.truncated).toBe(true);
    expect(requests).toHaveLength(5);
  });
});

describe("CanvasClient.request retry behavior", () => {
  it("retries once on 429 with Retry-After then succeeds", async () => {
    vi.useFakeTimers();
    try {
      const { client, requests } = buildClient([
        { status: 429, headers: { "retry-after": "1" }, data: { errors: ["rate limited"] } },
        { status: 200, data: { id: 42 } },
      ]);
      const promise = client.get<{ id: number }>("/api/v1/x");
      // advance through the Retry-After delay
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      expect(result).toEqual({ id: 42 });
      expect(requests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces 401 as CanvasApiError(UNAUTHORIZED) with no retry", async () => {
    const { client, requests } = buildClient([
      { status: 401, data: { errors: [{ message: "Invalid access token" }] } },
    ]);
    const caught = await client.get("/api/v1/courses").catch((error) => error);
    expect(caught).toBeInstanceOf(CanvasApiError);
    expect(caught).toMatchObject({ code: "UNAUTHORIZED", status: 401 });
    // Exactly one request — 4xx must not retry.
    expect(requests).toHaveLength(1);
  });

  it("retries on 5xx errors", async () => {
    vi.useFakeTimers();
    try {
      const { client, requests } = buildClient([
        { status: 503, data: "upstream" },
        { status: 200, data: { ok: true } },
      ]);
      const promise = client.get<{ ok: boolean }>("/api/v1/x");
      await vi.advanceTimersByTimeAsync(2000);
      await expect(promise).resolves.toEqual({ ok: true });
      expect(requests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

interface EnrolledCourseFixture {
  id: number;
  course_code?: string | null;
  name?: string | null;
  workflow_state?: string;
  term?: { name: string };
}

function enrolledCourse(
  id: number,
  courseCode: string | null,
  name: string,
  overrides: Partial<EnrolledCourseFixture> = {},
): EnrolledCourseFixture {
  return {
    id,
    course_code: courseCode,
    name,
    workflow_state: "available",
    term: { name: "Fall 2025" },
    ...overrides,
  };
}

const ENROLLMENT_LIST_PARAMS = {
  "state[]": ["unpublished", "available", "completed"],
  "include[]": ["term"],
};

describe("CanvasClient.resolveCourseId", () => {
  it("returns numeric id as-is without hitting the network", async () => {
    const { client, requests } = buildClient([]);
    await expect(client.resolveCourseId(60366)).resolves.toBe(60366);
    await expect(client.resolveCourseId("60366")).resolves.toBe(60366);
    expect(requests).toHaveLength(0);
  });

  it("resolves a unique exact course_code match against the full enrollment list and caches it", async () => {
    const { client, requests } = buildClient([
      {
        status: 200,
        data: [
          enrolledCourse(60366, "BADM_554_120251_246794", "Whatever"),
          enrolledCourse(99999, "OTHER", "Other"),
        ],
      },
    ]);

    const firstId = await client.resolveCourseId("badm_554_120251_246794");
    expect(firstId).toBe(60366);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/api/v1/courses");
    expect(requests[0]?.params).toMatchObject(ENROLLMENT_LIST_PARAMS);

    // Second call hits the cache — no new request enqueued.
    const secondId = await client.resolveCourseId("badm_554_120251_246794");
    expect(secondId).toBe(60366);
    expect(requests).toHaveLength(1);

    expect(client.getCachedCourseCode(60366)).toBe("BADM_554_120251_246794");
  });

  it("resolves a unique exact name match when no course_code matches", async () => {
    const { client } = buildClient([
      {
        status: 200,
        data: [
          enrolledCourse(60366, "DSGN_9_120251", "Design 9"),
          enrolledCourse(60367, "CMP_10_120251", "Computing 10"),
        ],
      },
    ]);
    await expect(client.resolveCourseId("design 9")).resolves.toBe(60366);
  });

  it("bypasses cache when bypassCache=true so a rename re-resolves", async () => {
    const { client, requests } = buildClient([
      { status: 200, data: [enrolledCourse(1, "x", "X Course")] },
      { status: 200, data: [enrolledCourse(1, "x", "X Course")] },
    ]);
    await client.resolveCourseId("x"); // populates cache
    await client.resolveCourseId("x", { bypassCache: true });
    expect(requests).toHaveLength(2);
  });

  it("finds a course on page 2 of the enrollment list", async () => {
    const { client, requests } = buildClient([
      {
        status: 200,
        data: [enrolledCourse(1, "OTHER_1", "Other 1")],
        headers: {
          link: '<https://canvas.example.com/api/v1/courses?page=2&per_page=100>; rel="next"',
        },
      },
      { status: 200, data: [enrolledCourse(60366, "DSGN_9_120251", "Design 9")] },
    ]);
    await expect(client.resolveCourseId("DSGN_9_120251")).resolves.toBe(60366);
    expect(requests).toHaveLength(2);
  });

  it("throws NOT_FOUND with substring-filtered candidates and the enrollment-scope note on zero exact matches", async () => {
    const { client } = buildClient([
      {
        status: 200,
        data: [
          enrolledCourse(60366, "DSGN_9_120251", "Design 9"),
          enrolledCourse(60367, "CMP_10_120251", "Computing 10"),
        ],
      },
    ]);
    const caught = await client.resolveCourseId("DSGN_9").catch((error) => error);
    expect(caught).toBeInstanceOf(CanvasApiError);
    expect(caught).toMatchObject({ code: "NOT_FOUND" });
    const message = (caught as CanvasApiError).message;
    expect(message).toContain('no enrolled course has an exact course_code or name match for "DSGN_9"');
    expect(message).toContain("DSGN_9_120251 (id 60366) — Design 9 [Fall 2025, available]");
    // Substring-irrelevant course is filtered out of the candidate list.
    expect(message).not.toContain("CMP_10_120251");
    expect(message).toContain(
      "Course codes resolve only within your own enrollments — for account-level courses, pass the numeric id from list_account_courses.",
    );
  });

  it("falls back to listing the first 10 enrolled courses when the substring filter yields nothing", async () => {
    const { client } = buildClient([
      {
        status: 200,
        data: [
          enrolledCourse(60366, "DSGN_9_120251", "Design 9"),
          enrolledCourse(60367, "CMP_10_120251", "Computing 10"),
        ],
      },
    ]);
    const caught = await client.resolveCourseId("zzz-no-match").catch((error) => error);
    expect(caught).toMatchObject({ code: "NOT_FOUND" });
    const message = (caught as CanvasApiError).message;
    expect(message).toContain("DSGN_9_120251 (id 60366)");
    expect(message).toContain("CMP_10_120251 (id 60367)");
  });

  it("throws VALIDATION listing both terms when a code matches two courses across terms — no write-side guess", async () => {
    const { client } = buildClient([
      {
        status: 200,
        data: [
          enrolledCourse(60366, "DSGN_9", "Design 9", { term: { name: "Fall 2025" }, workflow_state: "completed" }),
          enrolledCourse(70477, "DSGN_9", "Design 9", { term: { name: "Fall 2026" }, workflow_state: "available" }),
        ],
      },
    ]);
    const caught = await client.resolveCourseId("DSGN_9").catch((error) => error);
    expect(caught).toBeInstanceOf(CanvasApiError);
    expect(caught).toMatchObject({ code: "VALIDATION" });
    const message = (caught as CanvasApiError).message;
    expect(message).toContain('"DSGN_9" exactly matches 2 courses — pass the numeric id to disambiguate');
    expect(message).toContain("DSGN_9 (id 60366) — Design 9 [Fall 2025, completed]");
    expect(message).toContain("DSGN_9 (id 70477) — Design 9 [Fall 2026, available]");
  });

  it("caps the candidate list at 10 with a +N more suffix", async () => {
    const manyCourses = Array.from({ length: 15 }, (_, index) =>
      enrolledCourse(1000 + index, `HIST_${index}_120251`, `History ${index}`),
    );
    const { client } = buildClient([{ status: 200, data: manyCourses }]);
    const caught = await client.resolveCourseId("HIST").catch((error) => error);
    expect(caught).toMatchObject({ code: "NOT_FOUND" });
    const message = (caught as CanvasApiError).message;
    expect(message).toContain("+5 more");
    expect((message.match(/\(id \d+\)/g) ?? []).length).toBe(10);
  });

  it("throws NOT_FOUND when the enrollment list is empty", async () => {
    const { client } = buildClient([{ status: 200, data: [] }]);
    await expect(client.resolveCourseId("nope")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("CanvasClient.seedCourseCodes", () => {
  it("seeds only the id→code display map — getCachedCourseCode works, forward resolution still walks enrollments", async () => {
    const { client, requests } = buildClient([
      {
        status: 200,
        data: [
          enrolledCourse(60366, "DSGN_9_120251", "Design 9"),
          enrolledCourse(60367, "CMP_10_120251", "Computing 10"),
        ],
      },
    ]);
    client.seedCourseCodes([
      { id: 60366, course_code: "DSGN_9_120251" },
      { id: 60367, course_code: "CMP_10_120251" },
      { id: 60368 }, // no code — skipped without error
    ]);
    expect(client.getCachedCourseCode(60366)).toBe("DSGN_9_120251");
    expect(client.getCachedCourseCode(60367)).toBe("CMP_10_120251");
    expect(client.getCachedCourseCode(60368)).toBeUndefined();
    // Never populates the forward cache — resolution does its own exact-match walk.
    await expect(client.resolveCourseId("DSGN_9_120251")).resolves.toBe(60366);
    expect(requests).toHaveLength(1);
  });

  it("a seed of an ambiguous code cannot poison forward resolution — the walk errors honestly", async () => {
    const { client, requests } = buildClient([
      {
        status: 200,
        data: [
          enrolledCourse(60366, "DSGN_9", "Design 9", { term: { name: "Fall 2025" } }),
          enrolledCourse(70477, "DSGN_9", "Design 9", { term: { name: "Fall 2026" } }),
        ],
      },
    ]);
    // e.g. an account-scoped search returned only ONE of the two DSGN_9 courses
    client.seedCourseCodes([{ id: 60366, course_code: "DSGN_9" }]);
    expect(client.getCachedCourseCode(60366)).toBe("DSGN_9");
    await expect(client.resolveCourseId("DSGN_9")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(requests).toHaveLength(1);
  });

  it("resolveCourseId's own successful exact-match walk still populates the forward cache", async () => {
    const { client, requests } = buildClient([
      { status: 200, data: [enrolledCourse(60366, "DSGN_9_120251", "Design 9")] },
    ]);
    await expect(client.resolveCourseId("DSGN_9_120251")).resolves.toBe(60366);
    await expect(client.resolveCourseId("DSGN_9_120251")).resolves.toBe(60366);
    expect(requests).toHaveLength(1);
  });
});

describe("CanvasClient.resolveCourseId truncation note", () => {
  const pageWithNext = (page: number) => ({
    status: 200,
    data: [enrolledCourse(1000 + page, `OTHER_${page}`, `Other ${page}`)],
    headers: {
      link: `<https://canvas.example.com/api/v1/courses?page=${page + 1}>; rel="next"`,
    },
  });

  it("appends the truncation note to the zero-match error when the enrollment walk hit maxPages", async () => {
    // buildClient sets maxPages: 5 — every page advertises a next link.
    const { client } = buildClient([1, 2, 3, 4, 5].map(pageWithNext));
    const caught = await client.resolveCourseId("zzz-no-match").catch((error) => error);
    expect(caught).toMatchObject({ code: "NOT_FOUND" });
    expect((caught as CanvasApiError).message).toContain(
      "the course list was truncated — the course may exist on an unfetched page",
    );
  });

  it("appends the truncation note to the ambiguous error when the enrollment walk hit maxPages", async () => {
    const duplicatePage = (page: number, id: number) => ({
      status: 200,
      data: [enrolledCourse(id, "DSGN_9", "Design 9")],
      headers: {
        link: `<https://canvas.example.com/api/v1/courses?page=${page + 1}>; rel="next"`,
      },
    });
    const { client } = buildClient([
      duplicatePage(1, 60366),
      duplicatePage(2, 70477),
      pageWithNext(3),
      pageWithNext(4),
      pageWithNext(5),
    ]);
    const caught = await client.resolveCourseId("DSGN_9").catch((error) => error);
    expect(caught).toMatchObject({ code: "VALIDATION" });
    expect((caught as CanvasApiError).message).toContain(
      "the course list was truncated — the course may exist on an unfetched page",
    );
  });

  it("omits the truncation note when the walk completed", async () => {
    const { client } = buildClient([
      { status: 200, data: [enrolledCourse(60366, "DSGN_9_120251", "Design 9")] },
    ]);
    const caught = await client.resolveCourseId("zzz-no-match").catch((error) => error);
    expect((caught as CanvasApiError).message).not.toContain("truncated");
  });
});
