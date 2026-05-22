/**
 * Outbound network guard for execute_typescript user code.
 *
 * Ported from canvas-mcp-fork's _write_network_guard (code_execution.py:117).
 * Monkey-patches net.connect, tls.connect, http.request, https.request, and
 * globalThis.fetch so that any outbound connection to a host outside the
 * allowlist throws SANDBOX_NETWORK_BLOCKED.
 *
 * Defaults: blocking is ON; allowlist is taken from TS_SANDBOX_ALLOWLIST_HOSTS
 * (comma-separated). The spawning tool pre-seeds the Canvas host into that env
 * var so legitimate Canvas calls keep working.
 *
 * Limitations (documented intentionally):
 *   - Native addons that talk to libuv socket layers directly are NOT covered.
 *   - process.binding('tcp_wrap') is NOT covered.
 *   - A determined attacker controlling the user-code source can find ways
 *     around any in-process monkey-patch. The guard raises the cost of
 *     accidental exfiltration via prompt injection; it is not a strong sandbox.
 *
 * This file must be imported FIRST (before any user code), so any module that
 * caches references to http/https/net/tls/fetch sees the patched versions.
 */
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";

const BLOCK_OUTBOUND =
  (process.env.TS_SANDBOX_BLOCK_OUTBOUND ?? "true").toLowerCase() !== "false";

const ALLOWLIST: Set<string> = new Set(
  (process.env.TS_SANDBOX_ALLOWLIST_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0),
);

export class SandboxNetworkBlockedError extends Error {
  readonly host: string;
  readonly hint: string;
  constructor(host: string) {
    super(
      `SANDBOX_NETWORK_BLOCKED: outbound connection to "${host}" is not in the allowlist (TS_SANDBOX_ALLOWLIST_HOSTS). ` +
        `Set TS_SANDBOX_BLOCK_OUTBOUND=false or add the host to the allowlist if this is legitimate.`,
    );
    this.name = "SandboxNetworkBlockedError";
    this.host = host;
    this.hint = "TS_SANDBOX_ALLOWLIST_HOSTS";
  }
}

function isHostAllowed(host: string | undefined | null): boolean {
  if (!BLOCK_OUTBOUND) return true;
  if (!host) return false;
  return ALLOWLIST.has(String(host).toLowerCase());
}

function assertAllowed(host: string | undefined | null): void {
  if (!isHostAllowed(host)) {
    throw new SandboxNetworkBlockedError(host ?? "<unknown>");
  }
}

function extractHostFromConnectArgs(args: readonly unknown[]): string | undefined {
  // net.connect / tls.connect overloads:
  //   (options, listener?)
  //   (port, host?, listener?)
  //   (path, listener?)   ← unix socket; we'll treat as "unknown" → blocked
  const first = args[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const options = first as { host?: string; hostname?: string; path?: string };
    if (options.path) return undefined; // IPC path — no host → blocked by default
    return options.host ?? options.hostname;
  }
  // (port, host?) form
  const second = args[1];
  if (typeof second === "string") return second;
  return undefined;
}

function extractHostFromHttpArgs(args: readonly unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === "string") {
    try {
      return new URL(first).hostname;
    } catch {
      return undefined;
    }
  }
  if (first instanceof URL) return first.hostname;
  if (first && typeof first === "object") {
    const options = first as { hostname?: string; host?: string };
    // Canvas-style options.host can be "example.com:443" — strip the port.
    const raw = options.hostname ?? options.host;
    return raw ? raw.split(":")[0] : undefined;
  }
  return undefined;
}

function extractHostFromFetchArgs(input: unknown): string | undefined {
  if (typeof input === "string") {
    try {
      return new URL(input).hostname;
    } catch {
      return undefined;
    }
  }
  if (input instanceof URL) return input.hostname;
  if (input && typeof input === "object" && "url" in input) {
    const url = (input as { url: unknown }).url;
    if (typeof url === "string") {
      try {
        return new URL(url).hostname;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

// ---- patches ----

const originalNetConnect = net.connect.bind(net);
const originalNetCreateConnection = net.createConnection.bind(net);
const originalTlsConnect = tls.connect.bind(tls);
const originalHttpRequest = http.request.bind(http);
const originalHttpGet = http.get.bind(http);
const originalHttpsRequest = https.request.bind(https);
const originalHttpsGet = https.get.bind(https);
const originalFetch = globalThis.fetch;

(net as { connect: unknown }).connect = (...args: unknown[]) => {
  assertAllowed(extractHostFromConnectArgs(args));
  return (originalNetConnect as (...a: unknown[]) => unknown)(...args);
};
(net as { createConnection: unknown }).createConnection = (...args: unknown[]) => {
  assertAllowed(extractHostFromConnectArgs(args));
  return (originalNetCreateConnection as (...a: unknown[]) => unknown)(...args);
};

(tls as { connect: unknown }).connect = (...args: unknown[]) => {
  assertAllowed(extractHostFromConnectArgs(args));
  return (originalTlsConnect as (...a: unknown[]) => unknown)(...args);
};

(http as { request: unknown }).request = (...args: unknown[]) => {
  assertAllowed(extractHostFromHttpArgs(args));
  return (originalHttpRequest as (...a: unknown[]) => unknown)(...args);
};
(http as { get: unknown }).get = (...args: unknown[]) => {
  assertAllowed(extractHostFromHttpArgs(args));
  return (originalHttpGet as (...a: unknown[]) => unknown)(...args);
};

(https as { request: unknown }).request = (...args: unknown[]) => {
  assertAllowed(extractHostFromHttpArgs(args));
  return (originalHttpsRequest as (...a: unknown[]) => unknown)(...args);
};
(https as { get: unknown }).get = (...args: unknown[]) => {
  assertAllowed(extractHostFromHttpArgs(args));
  return (originalHttpsGet as (...a: unknown[]) => unknown)(...args);
};

if (typeof originalFetch === "function") {
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    assertAllowed(extractHostFromFetchArgs(input));
    return (originalFetch as (a: unknown, b?: unknown) => Promise<Response>)(input, init);
  }) as typeof fetch;
}

export const NETWORK_GUARD_CONFIG = {
  blockOutbound: BLOCK_OUTBOUND,
  allowlist: Array.from(ALLOWLIST),
};
