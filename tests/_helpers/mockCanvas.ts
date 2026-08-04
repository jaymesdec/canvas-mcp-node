import axios, {
  type AxiosAdapter,
  type AxiosRequestConfig,
  type AxiosResponse,
  AxiosHeaders,
} from "axios";

import { CanvasClient } from "../../src/canvasClient.js";

export interface FakeResponse {
  status: number;
  data: unknown;
  headers?: Record<string, string>;
}

export interface RequestRecord {
  method: string;
  url: string;
  fullUrl: string;
  params?: Record<string, unknown>;
  data?: unknown;
}

export interface MockCanvasResult {
  client: CanvasClient;
  requests: RequestRecord[];
  /** Enqueue an additional response after construction. */
  enqueue: (response: FakeResponse) => void;
}

/**
 * Build a CanvasClient backed by a queue-driven axios adapter.
 * Each network call pops the next response from the queue and records the request.
 */
export function buildMockCanvas(initial: FakeResponse[] = [], options?: { baseUrl?: string }): MockCanvasResult {
  const baseUrl = options?.baseUrl ?? "https://canvas.example.com";
  const queue: FakeResponse[] = [...initial];
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
      return Promise.reject(new Error(`mockCanvas: no response queued for ${config.method?.toUpperCase()} ${url}`));
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
    // Identity transform so the test adapter sees the original object (not a JSON string).
    transformRequest: [(data: unknown) => data],
  });

  const client = new CanvasClient({
    baseUrl,
    apiToken: "test-token",
    axiosInstance: instance,
    maxRetries: 0,
    maxPages: 10,
  });

  return {
    client,
    requests,
    enqueue: (response: FakeResponse) => queue.push(response),
  };
}

/**
 * Build a minimal McpServer-like recorder that captures tool registrations
 * and lets tests invoke them directly with parsed args.
 */
export interface RecordedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  handler: (args: unknown, extra?: unknown) => Promise<unknown>;
}

export interface ToolResponse {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface ToolHarness {
  server: {
    registerTool: (name: string, config: { description?: string; inputSchema?: unknown }, handler: (args: unknown, extra?: unknown) => Promise<unknown>) => void;
  };
  tools: Map<string, RecordedTool>;
  call: (name: string, args?: unknown) => Promise<ToolResponse>;
}

export function buildToolHarness(): ToolHarness {
  const tools = new Map<string, RecordedTool>();
  const server = {
    registerTool: (
      name: string,
      config: { description?: string; inputSchema?: unknown },
      handler: (args: unknown, extra?: unknown) => Promise<unknown>,
    ) => {
      tools.set(name, { name, description: config.description, inputSchema: config.inputSchema, handler });
    },
  };
  return {
    server,
    tools,
    call: async (name: string, args: unknown = {}) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`buildToolHarness: tool "${name}" not registered`);
      return (await tool.handler(args, {})) as never;
    },
  };
}

/**
 * Parse the compact JSON payload out of a jsonResult-shaped tool response.
 * Expects a non-error result; tests asserting errors should match on
 * `result.isError` / `result.content[0].text` directly.
 */
export function parseJsonResult<T = Record<string, unknown>>(result: ToolResponse): T {
  if (result.isError) {
    throw new Error(`parseJsonResult: got an error result: ${result.content?.[0]?.text ?? "<no text>"}`);
  }
  const text = result.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("parseJsonResult: result has no text content");
  }
  // The payload is compact single-line JSON appended after the summary, so
  // everything past the LAST blank-line separator is the JSON — a summary
  // containing embedded blank lines can't break parsing.
  const separatorIndex = text.lastIndexOf("\n\n");
  const jsonText = separatorIndex >= 0 ? text.slice(separatorIndex + 2) : text;
  return JSON.parse(jsonText) as T;
}
