import { describe, expect, it } from "vitest";

import { SandboxNetworkBlockedError } from "../../src/workers/network_guard.js";

/**
 * The network_guard module runs its monkey-patches as a side effect at import
 * time, which mutates the test process's globals. The real coverage for
 * patching behavior lives in tests/tools/code_exec.test.ts, where we spawn an
 * isolated worker and verify the guard blocks a real fetch. Here we only sanity-
 * check the error class shape so it stays useful in stack traces.
 */
describe("SandboxNetworkBlockedError", () => {
  it("includes the offending host and a hint env var name", () => {
    const error = new SandboxNetworkBlockedError("example.com");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SandboxNetworkBlockedError");
    expect(error.host).toBe("example.com");
    expect(error.message).toContain("example.com");
    expect(error.message).toContain("TS_SANDBOX_ALLOWLIST_HOSTS");
    expect(error.hint).toBe("TS_SANDBOX_ALLOWLIST_HOSTS");
  });
});
