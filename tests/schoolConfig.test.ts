import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadSchoolConfig } from "../src/schoolConfig.js";

let tmpRoot: string;
let warnings: string[];

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "school-config-"));
  warnings = [];
});
afterEach(async () => {
  delete process.env.SCHOOL_CONFIG;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("loadSchoolConfig", () => {
  it("returns null when no SCHOOL_CONFIG is set", async () => {
    delete process.env.SCHOOL_CONFIG;
    await expect(loadSchoolConfig()).resolves.toBeNull();
  });

  it("loads + validates a well-formed config", async () => {
    const configPath = path.join(tmpRoot, "school.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        schoolName: "Test School",
        competencyFramework: {
          name: "Test Framework",
          competencies: [{ key: "k1", name: "Name 1", description: "Desc 1" }],
        },
      }),
    );

    const result = await loadSchoolConfig({ configPath });
    expect(result).not.toBeNull();
    expect(result?.schoolName).toBe("Test School");
    expect(result?.competencyFramework?.competencies).toHaveLength(1);
  });

  it("warns + returns null when the file is missing", async () => {
    const missing = path.join(tmpRoot, "nope.json");
    const result = await loadSchoolConfig({
      configPath: missing,
      warn: (message) => warnings.push(message),
    });
    expect(result).toBeNull();
    expect(warnings[0]).toMatch(/could not be read/);
    expect(warnings[0]).toMatch(/Continuing without a school preset/);
  });

  it("warns + returns null on invalid JSON", async () => {
    const broken = path.join(tmpRoot, "broken.json");
    await fs.writeFile(broken, "{ not valid");
    const result = await loadSchoolConfig({
      configPath: broken,
      warn: (message) => warnings.push(message),
    });
    expect(result).toBeNull();
    expect(warnings[0]).toMatch(/not valid JSON/);
  });

  it("warns + returns null when the schema doesn't match", async () => {
    const invalid = path.join(tmpRoot, "invalid.json");
    await fs.writeFile(
      invalid,
      JSON.stringify({
        // competencyFramework is present but competencies is empty — should fail .min(1)
        competencyFramework: { name: "x", competencies: [] },
      }),
    );
    const result = await loadSchoolConfig({
      configPath: invalid,
      warn: (message) => warnings.push(message),
    });
    expect(result).toBeNull();
    expect(warnings[0]).toMatch(/failed validation/);
  });

  it("reads the path from SCHOOL_CONFIG env var when no explicit path is given", async () => {
    const configPath = path.join(tmpRoot, "via-env.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        schoolName: "Via Env",
        competencyFramework: {
          name: "Env Framework",
          competencies: [{ key: "a", name: "A", description: "A desc" }],
        },
      }),
    );
    process.env.SCHOOL_CONFIG = configPath;
    const result = await loadSchoolConfig();
    expect(result?.schoolName).toBe("Via Env");
  });

  it("validates the shipped configs/franklin.json", async () => {
    const franklinPath = path.resolve("configs/franklin.json");
    const result = await loadSchoolConfig({
      configPath: franklinPath,
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
    expect(result).not.toBeNull();
    expect(result?.competencyFramework?.competencies).toHaveLength(9);
    expect(result?.competencyFramework?.competencies.map((entry) => entry.name)).toEqual([
      "Collaboration",
      "Storytelling / Communication",
      "Reflexivity",
      "Empathy / Perspective Taking",
      "Knowledge-Based Reasoning",
      "Futures Thinking",
      "Systems Thinking",
      "Adaptability",
      "Agency",
    ]);
  });

  it("validates the shipped configs/example.json", async () => {
    const examplePath = path.resolve("configs/example.json");
    const result = await loadSchoolConfig({
      configPath: examplePath,
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
    expect(result).not.toBeNull();
  });
});
