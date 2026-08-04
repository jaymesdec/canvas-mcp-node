import { describe, expect, it } from "vitest";

import { parseJsonResult } from "../_helpers/mockCanvas.js";
import { jsonResult } from "../../src/tools/toolHelpers.js";

describe("jsonResult", () => {
  it("emits summary + compact JSON as the only representation", () => {
    const result = jsonResult({ a: 1, nested: { b: 2 } }, { summary: "S" });
    expect(result.content).toEqual([{ type: "text", text: 'S\n\n{"a":1,"nested":{"b":2}}' }]);
    expect(Object.keys(result)).toEqual(["content"]);
  });

  it("emits compact JSON alone when no summary is given", () => {
    const result = jsonResult({ a: 1 });
    expect(result.content?.[0]?.text).toBe('{"a":1}');
    expect(Object.keys(result)).toEqual(["content"]);
  });

  it("stringifies non-object payloads without wrapper objects", () => {
    expect(jsonResult([1, 2]).content?.[0]?.text).toBe("[1,2]");
    expect(jsonResult("plain").content?.[0]?.text).toBe('"plain"');
  });
});

describe("parseJsonResult", () => {
  it("parses the payload after the summary line", () => {
    const parsed = parseJsonResult(jsonResult({ count: 2 }, { summary: "2 course(s) found." }));
    expect(parsed).toEqual({ count: 2 });
  });

  it("parses a summary-less payload", () => {
    expect(parseJsonResult(jsonResult([1, 2]))).toEqual([1, 2]);
  });

  it("parses the payload even when the summary contains embedded blank lines", () => {
    const summary = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const parsed = parseJsonResult(jsonResult({ count: 3, ok: true }, { summary }));
    expect(parsed).toEqual({ count: 3, ok: true });
  });

  it("throws on error results instead of parsing them", () => {
    expect(() =>
      parseJsonResult({ content: [{ type: "text", text: "boom" }], isError: true }),
    ).toThrow(/error result/);
  });
});
