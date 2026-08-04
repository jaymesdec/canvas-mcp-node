import { describe, expect, it } from "vitest";

import { buildToolHarness, parseJsonResult, type ToolResponse } from "../_helpers/mockCanvas.js";
import { registerCompetencyTools } from "../../src/tools/competencies.js";
import type { SchoolConfig } from "../../src/schoolConfig.js";

const franklinLike: SchoolConfig = {
  schoolName: "Franklin School (Jersey City, NJ)",
  competencyFramework: {
    name: "Franklin's 9 Transdisciplinary Competencies",
    description: "Canonical definitions.",
    competencies: [
      { key: "collaboration", name: "Collaboration", description: "Works productively..." },
      { key: "agency", name: "Agency", description: "Takes initiative..." },
    ],
  },
};

describe("registerCompetencyTools", () => {
  it("registers list_competencies whether or not a config is loaded", () => {
    const harnessWith = buildToolHarness();
    registerCompetencyTools(harnessWith.server as never, franklinLike);
    expect(harnessWith.tools.has("list_competencies")).toBe(true);

    const harnessWithout = buildToolHarness();
    registerCompetencyTools(harnessWithout.server as never, null);
    expect(harnessWithout.tools.has("list_competencies")).toBe(true);
  });

  it("returns the framework + display_text when a config is loaded", async () => {
    const harness = buildToolHarness();
    registerCompetencyTools(harness.server as never, franklinLike);
    const result = (await harness.call("list_competencies")) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(parseJsonResult(result).configured).toBe(true);
    expect(parseJsonResult(result).framework_name).toBe("Franklin's 9 Transdisciplinary Competencies");
    expect(parseJsonResult(result).count).toBe(2);
    const text = parseJsonResult(result).display_text as string;
    expect(text).toContain("1. **Collaboration**");
    expect(text).toContain("2. **Agency**");
    expect(text).toContain("Canonical definitions.");
  });

  it("returns a structured 'not configured' response when no config is loaded", async () => {
    const harness = buildToolHarness();
    registerCompetencyTools(harness.server as never, null);
    const result = (await harness.call("list_competencies")) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(parseJsonResult(result).configured).toBe(false);
    expect(parseJsonResult(result).message).toMatch(/SCHOOL_CONFIG/);
  });

  it("handles a config that has no competencyFramework field gracefully", async () => {
    const harness = buildToolHarness();
    registerCompetencyTools(harness.server as never, { schoolName: "Bare" });
    const result = (await harness.call("list_competencies")) as ToolResponse;
    expect(parseJsonResult(result).configured).toBe(false);
  });
});
