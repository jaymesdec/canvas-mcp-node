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

describe("CanvasClient.resolveCourseId", () => {
  it("returns numeric id as-is without hitting the network", async () => {
    const { client, requests } = buildClient([]);
    await expect(client.resolveCourseId(60366)).resolves.toBe(60366);
    await expect(client.resolveCourseId("60366")).resolves.toBe(60366);
    expect(requests).toHaveLength(0);
  });

  it("falls back to search_term for a course code and caches the result", async () => {
    const { client, requests } = buildClient([
      {
        status: 200,
        data: [
          { id: 60366, course_code: "BADM_554_120251_246794", name: "Whatever" },
          { id: 99999, course_code: "OTHER", name: "Other" },
        ],
      },
    ]);

    const firstId = await client.resolveCourseId("BADM_554_120251_246794");
    expect(firstId).toBe(60366);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.params).toMatchObject({ search_term: "BADM_554_120251_246794" });

    // Second call hits the cache — no new request enqueued.
    const secondId = await client.resolveCourseId("BADM_554_120251_246794");
    expect(secondId).toBe(60366);
    expect(requests).toHaveLength(1);

    // getCachedCourseCode round-trips
    expect(client.getCachedCourseCode(60366)).toBe("BADM_554_120251_246794");
  });

  it("bypasses cache when bypassCache=true so a rename re-resolves", async () => {
    const { client, requests } = buildClient([
      { status: 200, data: [{ id: 1, course_code: "x" }] },
      { status: 200, data: [{ id: 1, course_code: "x" }] },
    ]);
    await client.resolveCourseId("x"); // populates cache
    await client.resolveCourseId("x", { bypassCache: true });
    expect(requests).toHaveLength(2);
  });

  it("throws NOT_FOUND when search_term returns no matches", async () => {
    const { client } = buildClient([{ status: 200, data: [] }]);
    await expect(client.resolveCourseId("nope")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
