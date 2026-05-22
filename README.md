# canvas-mcp (Node)

Node + TypeScript MCP server for Canvas LMS. Replaces the Python `canvas-mcp-fork` for the 29 Canvas tools used by the Franklin School `teaching-AIssitant` skills. The full project README ships with Unit 6.1 (tool reference, anonymization durability, Claude Desktop config snippet, security guidance). This file is a minimal stub so the project is shippable end-to-end during Phase 1.

## Install (developer)

```bash
npm install
cp .env.example .env
# fill in CANVAS_API_URL and CANVAS_API_TOKEN
npm run build
npm start
```

`npm run dev` runs the server under `tsx watch` for iteration.

## Plan

See `docs/plans/2026-05-22-001-feat-canvas-mcp-typescript-port-plan.md`.
