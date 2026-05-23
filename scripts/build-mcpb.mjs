#!/usr/bin/env node
/**
 * Build a one-click .mcpb installer for the Canvas MCP.
 *
 * Steps:
 *   1. Clean dist/ and build/mcpb/
 *   2. Compile TypeScript (npm run build)
 *   3. Stage server (dist/) + configs/ + node_modules (production-only) +
 *      package.json + manifest.json + README into build/mcpb/staging/
 *   4. Run `mcpb pack` to produce build/mcpb/canvas-mcp-<version>.mcpb
 *
 * Run with: npm run build:mcpb
 */
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const stagingRoot = path.join(repoRoot, "build", "mcpb");
const stagingDir = path.join(stagingRoot, "staging");

function log(message) {
  process.stdout.write(`[build-mcpb] ${message}\n`);
}

function run(cmd, cwd = repoRoot) {
  log(`$ ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(from);
      await fs.symlink(target, to);
    } else {
      await fs.copyFile(from, to);
    }
  }
}

async function copyFile(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

async function readManifestVersion() {
  const raw = await fs.readFile(path.join(repoRoot, "manifest.json"), "utf8");
  return JSON.parse(raw).version;
}

async function main() {
  const version = await readManifestVersion();
  log(`packaging canvas-mcp v${version}`);

  // 1. Clean
  log("cleaning staging dir");
  await fs.rm(stagingRoot, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });

  // 2. Build
  log("compiling TypeScript (npm run build)");
  run("npm run build");

  // 3a. Stage server (compiled dist/)
  log("staging server/ (compiled dist/)");
  await copyDir(path.join(repoRoot, "dist"), path.join(stagingDir, "server"));

  // 3b. Stage configs
  log("staging configs/");
  await copyDir(path.join(repoRoot, "configs"), path.join(stagingDir, "configs"));

  // 3c. Stage manifest, package.json, README, icon
  log("staging manifest + package.json + README + icon");
  await copyFile(path.join(repoRoot, "manifest.json"), path.join(stagingDir, "manifest.json"));
  await copyFile(path.join(repoRoot, "package.json"), path.join(stagingDir, "package.json"));
  await copyFile(path.join(repoRoot, "package-lock.json"), path.join(stagingDir, "package-lock.json"));
  await copyFile(path.join(repoRoot, "README.md"), path.join(stagingDir, "README.md"));
  await copyFile(path.join(repoRoot, "icon.png"), path.join(stagingDir, "icon.png"));

  // 3d. Install production-only deps in the staging dir
  log("installing production node_modules (npm ci --omit=dev)");
  run("npm ci --omit=dev", stagingDir);

  // 3e. Drop package-lock.json from the bundle once node_modules is built
  await fs.unlink(path.join(stagingDir, "package-lock.json")).catch(() => undefined);

  // 4. Pack
  log("running mcpb pack");
  const output = path.join(stagingRoot, `canvas-mcp-${version}.mcpb`);
  run(`npx --yes @anthropic-ai/mcpb@latest pack "${stagingDir}" "${output}"`);

  const stat = await fs.stat(output);
  const sizeMb = (stat.size / 1024 / 1024).toFixed(2);
  log(`done: ${output} (${sizeMb} MB)`);
  log("");
  log("Install in Claude Desktop:");
  log(`  open "${output}"   # macOS — opens Claude Desktop install dialog`);
  log("");
}

main().catch((error) => {
  process.stderr.write(`[build-mcpb] ERROR: ${error?.stack ?? error?.message ?? error}\n`);
  process.exit(1);
});
