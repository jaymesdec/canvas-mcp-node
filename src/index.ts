#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const SERVER_NAME = "canvas-mcp";
const SERVER_VERSION = "0.1.0";

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
  // Validate required env up front. Logs go to stderr — stdout is the JSON-RPC channel.
  requireEnv("CANVAS_API_URL");
  requireEnv("CANVAS_API_TOKEN");

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Tool registrations land here as later units complete (1.2 → CanvasClient,
  // 2.x → typed tools, 4.x → anonymization, 5.x → execute_typescript).

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
