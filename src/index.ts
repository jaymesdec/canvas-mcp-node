#!/usr/bin/env node
import "dotenv/config";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CanvasClient } from "./canvasClient.js";
import { Anonymizer } from "./anonymizer.js";
import { loadSchoolConfig, type SchoolConfig } from "./schoolConfig.js";
import { registerCompetencyTools } from "./tools/competencies.js";
import { registerSchoolInfoTools } from "./tools/school.js";
import { registerCourseTools } from "./tools/courses.js";
import { registerModuleTools } from "./tools/modules.js";
import { registerPageTools } from "./tools/pages.js";
import { registerQuizTools } from "./tools/quizzes.js";
import { registerAssignmentTools } from "./tools/assignments.js";
import { registerRubricTools } from "./tools/rubrics.js";
import { registerUserTools } from "./tools/users.js";
import { registerSubmissionTools } from "./tools/submissions.js";
import { registerGradingTools } from "./tools/grading.js";
import { registerCodeExecutionTools } from "./tools/code_exec.js";
import { registerAnonymizationTools } from "./tools/anonymization.js";

const SERVER_NAME = "canvas-mcp";
const SERVER_VERSION = "0.3.16";

/**
 * Where the .mcpb-bundled franklin.json lives relative to the compiled
 * server entry point. Layout inside an installed .mcpb is:
 *   <install>/server/index.js   ← __filename
 *   <install>/configs/franklin.json
 * So we walk one level up from server/ to reach configs/.
 */
function bundledSchoolConfigPath(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "configs", "franklin.json");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve which school config to load. Tries, in order:
 *   1. SCHOOL_CONFIG env var (when set, non-empty, and points at a readable file)
 *   2. The bundled configs/franklin.json shipped inside the .mcpb
 *   3. null — no school config, MCP runs in generic mode
 *
 * If the env var is set to a path that doesn't resolve (e.g., literal
 * "${__dirname}/configs/franklin.json" when Claude Desktop's substitution
 * doesn't reach inside a user_config default), we log a warning and fall
 * back to the bundled config so Franklin teachers still get their preset.
 */
async function resolveSchoolConfig(): Promise<SchoolConfig | null> {
  const explicit = process.env.SCHOOL_CONFIG?.trim();
  if (explicit && explicit.length > 0) {
    if (await pathExists(explicit)) {
      return loadSchoolConfig({ configPath: explicit });
    }
    process.stderr.write(
      `[${SERVER_NAME}] SCHOOL_CONFIG="${explicit}" did not resolve to a readable file; falling back to the bundled Franklin preset.\n`,
    );
  }
  const bundled = bundledSchoolConfigPath();
  if (await pathExists(bundled)) {
    return loadSchoolConfig({ configPath: bundled });
  }
  return null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    process.stderr.write(
      `[${SERVER_NAME}] Missing required environment variable: ${name}\n`,
    );
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const canvasApiUrl = requireEnv("CANVAS_API_URL");
  const canvasApiToken = requireEnv("CANVAS_API_TOKEN");

  const canvas = new CanvasClient({
    baseUrl: canvasApiUrl,
    apiToken: canvasApiToken,
  });

  const anonymizer = new Anonymizer();
  await anonymizer.init();

  const schoolConfig = await resolveSchoolConfig();
  if (schoolConfig) {
    process.stderr.write(
      `[${SERVER_NAME}] loaded school config${schoolConfig.schoolName ? `: ${schoolConfig.schoolName}` : ""}\n`,
    );
  } else {
    process.stderr.write(
      `[${SERVER_NAME}] no school config loaded — running in generic mode (list_competencies, page templates will report 'not configured').\n`,
    );
  }

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Phase 2 tools — anonymizer is wired into every student-data tool before
  // those tools become callable (FERPA gate per plan).
  registerCourseTools(server, canvas);
  registerModuleTools(server, canvas);
  registerPageTools(server, canvas, schoolConfig);
  registerQuizTools(server, canvas);
  registerAssignmentTools(server, canvas, anonymizer);
  registerRubricTools(server, canvas);
  registerUserTools(server, canvas, anonymizer);
  registerSubmissionTools(server, canvas, anonymizer);
  registerGradingTools(server, canvas);
  registerAnonymizationTools(server, canvas, anonymizer);
  registerCompetencyTools(server, schoolConfig);
  registerSchoolInfoTools(server, schoolConfig);
  registerCodeExecutionTools(server, anonymizer);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[${SERVER_NAME}] v${SERVER_VERSION} listening on stdio\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[${SERVER_NAME}] fatal: ${message}\n`);
  process.exit(1);
});
