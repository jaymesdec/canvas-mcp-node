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

## Anonymization (FERPA gate)

Every tool that could return real student names defaults to pseudonymized output (`Student 1`, `Student 2`, …). Teachers/TAs/admins are returned verbatim — the gate only fires for students and unknown-role users.

**The default is enforced server-side.** If a caller passes `anonymous: false`, the server **ignores it** and returns anonymized output anyway, with a warning string in the response. The only way to actually receive real names is to set the operator-controlled env var `CANVAS_MCP_ALLOW_DEANONYMIZE=true` in your launch config and restart Claude Desktop.

This applies to:

- `list_users`
- `list_account_users`
- `list_assignments` (when `include[]` contains `submission` or `submission_history`)
- `create_student_anonymization_map` (suppresses `real_name` / `real_email` in the response; pseudonyms are still allocated and persisted to disk)

Pseudonyms persist per-course on disk at `~/.canvas-mcp/anon-maps/{courseId}.json` (override the directory via `ANON_MAP_DIR`). The same student receives the same `Student N` across MCP restarts and weeks of conversations, which is what makes longitudinal artifacts (narratives, council reviews, transition reports) coherent.

## Plan

See `docs/plans/2026-05-22-001-feat-canvas-mcp-typescript-port-plan.md`.
