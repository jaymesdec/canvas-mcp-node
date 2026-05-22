# canvas-mcp (Node)

Node + TypeScript MCP server for Canvas LMS. Replaces the Python `canvas-mcp-fork` for the 29 Canvas tools used by the Franklin School `teaching-AIssitant` skills. The full project README ships with Unit 6.1 (tool reference, anonymization durability, Claude Desktop config snippet, security guidance). This file is a minimal stub so the project is shippable end-to-end during Phase 1.

## Install — one-click (.mcpb)

The fastest path is the bundled `.mcpb` installer. Claude Desktop opens it and walks the user through every required env var.

### For end-users (you have a .mcpb file)

1. Double-click `canvas-mcp-<version>.mcpb` (or drag it onto Claude Desktop).
2. In the install dialog, fill in:
   - **Canvas API URL** — your Canvas base URL, e.g. `https://franklin.instructure.com` (no `/api/v1`).
   - **Canvas API token** — generated from Canvas → Account → Settings → New Access Token. Stored locally; only ever sent to the Canvas host above.
   - **Canvas account id** — `self` if you have account-admin (most Franklin teachers do); leave blank if you don't. Lets account-scoped tools work without passing the id on every call.
   - **School config JSON** — for Franklin defaults, set to `${__dirname}/configs/franklin.json` (Claude Desktop substitutes the bundle's install path for `${__dirname}`). For another school, copy `configs/example.json` out of the unpacked bundle, edit it, and point this at your edited copy. Leave blank to run with no competency framework.
   - **Anonymization map directory** — leave blank for the default `~/.canvas-mcp/anon-maps/`, or point at a synced folder (iCloud Drive, Dropbox, NAS) if you want pseudonyms to survive machine loss. **This matters** — losing this directory orphans every `Student N` reference in your past narratives, council reviews, and transition reports.
   - **Allow de-anonymized output** — leave `false`. Flip to `true` only for explicit real-name workflows; flip back immediately after. Restart Claude Desktop after changing.
   - **execute_typescript network controls** — leave the defaults. The Canvas host is auto-allowlisted; add others only if a workflow legitimately needs them.
3. Restart Claude Desktop. The tools appear under the `canvas-mcp` prefix.

### Building your own .mcpb

```bash
npm install
npm run build:mcpb
# → build/mcpb/canvas-mcp-<version>.mcpb
```

The build:

- Compiles TypeScript to `dist/`.
- Stages `dist/` as `server/`, copies `configs/`, runs `npm ci --omit=dev` so only production dependencies ship in `node_modules/`.
- Calls `mcpb pack` to produce a signed-able ZIP at `build/mcpb/canvas-mcp-<version>.mcpb`.

`npm run validate:manifest` validates `manifest.json` against the latest MCPB schema (use this when you edit the manifest).

## Install — developer (source checkout)

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

## Account-scoped tools

For admin workflows that need to look beyond the token-owner's own enrollments:

- `list_account_courses(account_id?, search_term?, state?, ...)` — search the full course catalog
- `list_account_users(account_id?, search_term?, enrollment_type?, ...)` — search every user in the account

Both default `account_id` from the `CANVAS_ACCOUNT_ID` env var. Set that to `self` (most common) or a numeric account id in your Claude Desktop config so you don't have to remember it on every call. A clean "requires account-admin scope" error surfaces if the token is missing the permission.

## School configuration (Franklin and other schools)

The MCP core is **generic** — anything that varies by school lives in a JSON config file that the operator points at via the `SCHOOL_CONFIG` env var. This means the same compiled binary serves Franklin School, another school's deployment, or a no-config "generic" install. There is no Franklin-specific code path; Franklin is just a config preset that happens to ship in-repo.

### What's in the config

Today, the school config drives one tool (`list_competencies`) and reserves space for future Franklin-style extensions (page templates, academic calendar). The shape is validated with zod at startup; a malformed or missing config logs a warning to stderr and the MCP keeps running with generic defaults (the affected tools return a structured "not configured" response that explains how to fix it).

```jsonc
{
  "schoolName": "Franklin School (Jersey City, NJ)",
  "competencyFramework": {
    "name": "Franklin's 9 Transdisciplinary Competencies",
    "description": "Used across narratives, council reviews, transition reports.",
    "competencies": [
      { "key": "collaboration", "name": "Collaboration", "description": "Works productively..." }
      // … one entry per competency
    ]
  },
  "academicCalendar": {
    "weeksPerYear": 35
  }
}
```

### Using the Franklin preset (for Franklin teachers)

The repo ships `configs/franklin.json` with the canonical 9 TD Competencies. To enable it:

1. In your `claude_desktop_config.json` under the `canvas-mcp-node-test` (or whatever you named it) entry, add to the `env` block:
   ```jsonc
   "SCHOOL_CONFIG": "/Users/jdec/Documents/node-mcp-server/configs/franklin.json"
   ```
2. Restart Claude Desktop.
3. Verify by asking Claude `list_competencies` — the response should include all 9 with descriptions.

The server logs `[canvas-mcp] loaded school config: Franklin School (Jersey City, NJ)` to stderr on startup when the config loads successfully.

### Spinning up a generic / other-school deployment

Two ways:

**Option A — write your own config:**
1. Copy `configs/example.json` to a path of your choice (e.g., `~/lincoln-high.json`).
2. Edit the `schoolName`, `competencyFramework.name`, and the `competencies` array. Keep the `key` slugs short and stable (other tools may eventually key off them).
3. Point `SCHOOL_CONFIG` at the file in your Claude Desktop config.
4. Restart Claude Desktop.

**Option B — run with no school config at all:**
Don't set `SCHOOL_CONFIG`. `list_competencies` will return a structured `{ configured: false, message: … }` response telling Claude what env var to set, but every other tool works normally. This is the right setup for schools that aren't using a competency framework.

### Adding a school-specific field later

When a new piece of school-specific data emerges (e.g., a Franklin HTML page template that `create_page` should default to), the workflow is:

1. Extend `SchoolConfigSchema` in `src/schoolConfig.ts` with the new field (optional, zod-validated).
2. Update `configs/franklin.json` and `configs/example.json` with the new shape (Franklin gets real values, the example gets a documented placeholder).
3. Read it from `schoolConfig` in the tool that consumes it; fall back to a generic default when the field is absent.
4. Add tests covering both the configured and unconfigured paths.

This keeps the generic-vs-Franklin split clean as the surface grows. Anything in the config is per-school; anything in `src/` outside of `schoolConfig.ts` consumers is generic and shared.

### What is *not* in the school config (intentionally)

These stay generic — they're either federal law, Canvas-API standard, or sensible defaults for any school:

- FERPA anonymization and the `CANVAS_MCP_ALLOW_DEANONYMIZE` gate
- Course-code preferred over numeric id in user-facing output
- `published: false` default on `create_page` / `create_quiz`
- Course-code → course-id cache and the bypass-on-write rule
- Anything Canvas-API specific (pagination, retry, error shapes)

If you find yourself tempted to put one of these in `schoolConfig.json`, push back — it's almost certainly a generic concern.

## Plan

See `docs/plans/2026-05-22-001-feat-canvas-mcp-typescript-port-plan.md`.
