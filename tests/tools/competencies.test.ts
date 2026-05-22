import { describe, expect, it } from "vitest";

import { buildToolHarness } from "../_helpers/mockCanvas.js";
import { registerCompetencyTools } from "../../src/tools/competencies.js";
import type { SchoolConfig } from "../../src/schoolConfig.js";

interface ToolResponse {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

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
    expect(result.structuredContent?.configured).toBe(true);
    expect(result.structuredContent?.framework_name).toBe("Franklin's 9 Transdisciplinary Competencies");
    expect(result.structuredContent?.count).toBe(2);
    const text = result.structuredContent?.display_text as string;
    expect(text).toContain("1. **Collaboration**");
    expect(text).toContain("2. **Agency**");
    expect(text).toContain("Canonical definitions.");
  });

  it("returns a structured 'not configured' response when no config is loaded", async () => {
    const harness = buildToolHarness();
    registerCompetencyTools(harness.server as never, null);
    const result = (await harness.call("list_competencies")) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.configured).toBe(false);
    expect(result.structuredContent?.message).toMatch(/SCHOOL_CONFIG/);
  });

  it("handles a config that has no competencyFramework field gracefully", async () => {
    const harness = buildToolHarness();
    registerCompetencyTools(harness.server as never, { schoolName: "Bare" });
    const result = (await harness.call("list_competencies")) as ToolResponse;
    expect(result.structuredContent?.configured).toBe(false);
  });
});
