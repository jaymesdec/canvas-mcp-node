---
title: Canvas MCP TypeScript Port (Node)
type: feat
status: active
date: 2026-05-22
---

# Canvas MCP TypeScript Port (Node)

## Overview

Build a new Node + TypeScript MCP server that replaces the user's Python Canvas MCP (`canvas-mcp-fork/`) for the 29 Canvas tools used by the user's `teaching-AIssitant/` skills (the user's 31-tool list plus `list_pages` minus the 3 Google tools that move to the Claude Drive MCP). The new server adopts r-huijts/canvas-mcp's structural pattern (`McpServer` from `@modelcontextprotocol/sdk`, axios-based `CanvasClient`, per-domain `register*Tools(server, canvas)` files), keeps `snake_case` tool names to match existing skills, replaces the Python MCP's in-memory anonymization with a **persistent per-course JSON map** on disk, drops the three Google tools (skills will be retargeted to the Claude Drive MCP), and absorbs the Python MCP's existing TypeScript helper modules (`code_api/canvas/{assignments,courses,grading}/`) so `execute_typescript` keeps working with the same import surface. Code execution moves from subprocess (Python MCP shelled out to `npx tsx`) to **`node:worker_threads`** for ~10× faster startup with terminable timeouts.

## Problem Frame

The user is a teacher at Franklin School running an ecosystem of education tools around Canvas LMS. The current `canvas-mcp-fork/` (Python/FastMCP, 88 tools) is the data layer behind ~13 skills in `teaching-AIssitant/`. The user wants a smaller, faster Node MCP that covers the 28 Canvas tools their skills actually call (plus a clean code-execution escape hatch for token-efficient bulk operations); the 3 Google tools that complete the user's 31-tool surface are routed to the existing Claude Drive MCP rather than re-implemented here.

Pain points the Node port addresses:
- **Tool surface bloat** — 57 unused tools in the Python MCP add tool-catalog noise.
- **Cross-language friction** — `execute_typescript` already runs Node (`npx tsx`) from Python. Removing the Python intermediary collapses two stacks into one.
- **Subprocess startup cost** — each `execute_typescript` call pays ~500ms tsx startup before any work happens. Worker threads cut this to ~50ms.
- **Anonymization fragility** — the Python MCP anonymizes student names in-memory; the same student gets a different pseudonym across sessions, which breaks longitudinal artifacts (narratives, portfolios, transition reports).

## Requirements Trace

- **R1.** Expose 29 named tools in `snake_case`, matching the names hard-coded in `teaching-AIssitant/` skills (see § Tool → Endpoint mapping below). The user's skills declare 32 unique Canvas/MCP tools across their `allowed-tools` front-matter (the original 31-tool list plus `list_pages`, surfaced by the `create-activity-doc` skill audit during document review); the 3 Google tools (`fetch_google_doc`, `fetch_google_slides`, `google_authenticate`) are dropped and skills retarget to the Claude Drive MCP, leaving 29 implemented here.
- **R2.** All student-returning tools default to anonymized output; persistent per-course pseudonyms remain stable across MCP restarts and weeks of usage.
- **R3.** Teacher/admin author names are never anonymized (preserves pedagogical context in comment threads).
- **R4.** `execute_typescript` accepts arbitrary TypeScript, can `import` from a curated `code_api/canvas/*` module set including an **`Anonymizer` adapter** (`code_api/anonymizer.ts`) that mirrors the typed-tool anonymization behavior so FERPA-sensitive workflows can use the escape hatch without bypassing anonymization, runs with the user's Canvas token injected, and is terminable on timeout without crashing the MCP server.
- **R5.** The grading suite (6 tools) supports both score-only and rubric-criterion grading, plus bulk grading with a user-supplied per-submission decision function.
- **R6.** `list_account_users` works against the user's existing Canvas account-admin token without additional configuration.
- **R7.** Google integration is delegated — no `fetch_google_doc`, `fetch_google_slides`, or `google_authenticate` in the new MCP. Skills migrate to `mcp__claude_ai_Google_Drive__*`.
- **R8.** Canvas content is never auto-published. Tools that create content default to `published: false` (per parent `CLAUDE.md` cross-project rule).
- **R9.** User-facing output prefers Canvas course **codes** over numeric IDs when both are available (same parent-CLAUDE rule).

## Scope Boundaries

- The Python MCP (`canvas-mcp-fork/`) is **not modified**. The new Node MCP registers under the same `canvas-mcp` key in `claude_desktop_config.json`; cutover is a hard swap (one config line). Parallel run is not supported because both servers would expose identical `snake_case` tool names and create ambiguity.
- We do **not** port the 57 Python-MCP tools not in the user's 31-tool list (discussion grading, peer reviews, accessibility, message templates, etc.).
- We do **not** implement OAuth or any Google Drive logic. Skills will use the existing Claude Drive MCP directly.
- We do **not** build a Claude Desktop Extension (`.mcpb`) in this plan — install will be `npm`/local `node` for now. Adding `.mcpb` later is small if desired.
- We do **not** rewrite the lifted `code_api/canvas/*.ts` modules. They are absorbed as-is; bug fixes flow upstream to `canvas-mcp-fork` if needed.

### Deferred to Separate Tasks

- **Skill migration in `teaching-AIssitant/`**: every skill currently calling `fetch_google_doc` / `fetch_google_slides` / `google_authenticate` needs to be retargeted to the Claude Drive MCP. Tracked in Unit 6.2 (a migration **guide**, not the migration itself). The actual skill edits happen in a separate session against the `teaching-AIssitant/` repo.
- **Canvas Desktop Extension packaging** (`.mcpb`): straightforward follow-up if/when the user wants one-click install.
- **Testing against a sandbox Canvas instance**: live integration tests are out of scope for this plan; unit tests with mocked HTTP layer are in scope.

## Context & Research

### Relevant Code and Patterns

**Reference repo (r-huijts/canvas-mcp, TypeScript):**
- `src/index.ts` — `McpServer` instance, `dotenv.config()`, env-derived `CanvasConfig`, calls `register*Tools(server, canvas)` per domain file, connects via `StdioServerTransport`. **Adopt this exact shape.**
- `src/canvasClient.ts` — single axios-backed class with per-domain methods (`listAssignmentSubmissions`, `gradeSubmission`, etc.) plus generic `get/put/post/delete`. **Extend, don't rewrite.**
- `src/tools/submissions.ts` — pattern for per-tool `server.tool(name, description, zodSchema, handler)`. Already implements equivalents of `grade_submission` and a `get-submission-documents` (≈ `download_submission_attachment` with `downloadFiles` flag).
- `src/anonymizer.ts` — class-static `userNameMap` + sequential counter. **Replace with the persistent-map design** (see § Key Technical Decisions). Keep the teacher-vs-student role check logic — it's correct.

**Python MCP (`canvas-mcp-fork/`), to be lifted or referenced for endpoints:**
- `src/canvas_mcp/code_api/canvas/{assignments,courses,grading}/*.ts` — already TypeScript. **Lifted verbatim** into `src/code_api/`. These are the foundation for `execute_typescript` imports and are also called by the typed grading tools (Phase 3).
- `src/canvas_mcp/tools/code_execution.py:117` (`_write_network_guard`) — the Node `--require` allowlist guard. **Port to TypeScript** in `src/workers/networkGuard.ts`.
- `src/canvas_mcp/tools/transdisciplinary.py:53` (`FRANKLIN_COMPETENCIES` dict) — the 9 competencies. **Lift as a TS constant.**
- `src/canvas_mcp/tools/other_tools.py:670` (`create_student_anonymization_map`) — reference for Canvas-API call sequence (`/courses/{id}/users?enrollment_type[]=student&include[]=email`), but disk format changes from CSV to JSON.
- Endpoint catalog (extracted): see § Tool → Endpoint Mapping below.

### Institutional Learnings

- No `docs/solutions/` directory exists in the target project (greenfield) or in `canvas-mcp-fork/` (none found). Not applicable.
- Parent `CLAUDE.md` (`Documents/CLAUDE.md`) supplies cross-project conventions: never auto-publish Canvas content; prefer course codes over IDs in user-facing output; Canvas API tokens have full account access — confirm before write operations.

### External References

- Canvas LMS API docs: https://canvas.instructure.com/doc/api/
- `@modelcontextprotocol/sdk` (Node, TypeScript) — v1.11.3+, used by r-huijts repo.
- `node:worker_threads` API and `resourceLimits.maxOldGenerationSizeMb` for memory caps.

## Key Technical Decisions

| Decision | Rationale |
|---|---|
| **TypeScript, fresh project** | User chose fresh project; reference repo's structure is sound but absorbing it as a fork would inherit unused tools and a `kebab-case` naming convention that doesn't match the user's skills. |
| **`snake_case` tool names everywhere** | The user's 13 skills hardcode `snake_case` names (`list_submissions`, `grade_with_rubric`, etc.). Renaming the skills is a separate, larger workstream — naming the MCP to match is the smaller change. |
| **`snake_case` for every tool-schema parameter** | The Python MCP uses `snake_case` for all tool parameters (`course_identifier`, `assignment_id`, `include_email`, `editing_roles`, `enrollment_state`, etc. — verified against `canvas_mcp/tools/*.py`). Skills hardcode these parameter names alongside the tool names. Plan-internal examples may show camelCase as a writing convenience, but **every zod schema key registered in `server.tool(...)` must be snake_case** to match the Python signatures exactly. Internal TypeScript local variables and helper function signatures remain camelCase (TS convention). Canvas-API-native fields (`posted_grade`, `rubric_assessment`, etc.) are already snake_case and pass through unchanged. |
| **Persistent per-course JSON anonymization map** | The reference repo's in-memory `Map<userId, "Student N">` resets between sessions and assigns pseudonyms by call order. Artifacts produced by `write-narratives` or `transition-report` reference pseudonyms that need to stay stable for weeks or longer. JSON on disk at `~/.canvas-mcp/anon-maps/{courseId}.json` survives restarts and supports backup/wipe. |
| **JSON only (no CSV)** | User chose JSON. The Python MCP writes CSV; we deviate intentionally — JSON is easier to round-trip programmatically, and the file can be inspected/exported by a separate tool later if needed. |
| **Drop Google tools, skills route to Claude Drive MCP** | The Claude Drive MCP is already authenticated in the user's environment. Re-implementing OAuth + Drive API here would duplicate that surface for no benefit. Tradeoff: skill edits required (covered by migration guide in Unit 6.2). |
| **All three user-listing tools** | Skills already depend on per-course (`list_users`), cross-course (`list_user_enrollments`), and account-wide (`list_account_users`) queries. Dropping any one of them forces N+1 workarounds in skills. User confirmed account-admin token scope is available. |
| **`execute_typescript` via `node:worker_threads`** | ~50ms startup vs ~500ms for subprocess; crashes stay isolated to the worker (terminable). Lose docker/podman sandbox option, which the user doesn't need. `node:vm` was rejected because it's documented as not a security boundary and async code can't be reliably interrupted. |
| **Lift `code_api/canvas/*.ts` from canvas-mcp-fork** | These are already production TypeScript modules used by the Python MCP's `execute_typescript`. Lifting them means: (a) `execute_typescript` works on day one with the same imports; (b) typed grading tools (`grade_with_rubric`, `bulk_grade_submissions`) reuse the same code path; (c) one source of truth for grading logic. |
| **`stdio` transport only** | Matches reference repo and Claude Desktop convention. No HTTP transport in this iteration. |
| **`get_anonymization_status` shape changes** | The Python version reports in-memory session stats. With persistent maps, it instead lists which course maps exist on disk + entry counts. The tool name is preserved; the output shape is documented as different in the migration guide. |
| **Default `published: false`** | Per parent CLAUDE.md cross-project rule. Applies to `create_page` and `create_quiz`. |

## Open Questions

### Resolved During Planning

- **Persistent vs per-call anonymization** → Persistent map + per-call override (`anonymous?: boolean`).
- **Anon-map storage location** → `~/.canvas-mcp/anon-maps/{courseId}.json`.
- **`execute_typescript` execution model** → `node:worker_threads`.
- **Tool naming convention** → `snake_case`.
- **Google integration approach** → Out of scope; skills migrate to Claude Drive MCP.
- **User-listing scope** → All three (per-course, cross-course enrollments, account-wide).
- **Map format on disk** → JSON only.

### Deferred to Implementation

<!-- list_all_rubrics scope: RESOLVED — Python rubrics.py:888 takes course_identifier and hits /courses/{id}/rubrics. Per-course only. Resolved during document review. -->
- **`add_module_item` content-type subset** — Canvas modules accept `Page`, `Assignment`, `Quiz`, `Discussion`, `ExternalUrl`, `File`, `SubHeader`, `ExternalTool`. The Python MCP's signature isn't yet read; we'll match its accepted types when porting (Unit 2.2). For a first cut, support `Page`, `Assignment`, `Quiz`, `SubHeader` (the four needed by `plan-lesson` and `create-quiz` skills) and extend on demand.
- **Course-code → course-id caching strategy** — the Python MCP caches this. The Node port needs an equivalent (otherwise every tool call that accepts a course code pays an extra round-trip). In-process LRU is fine; persistence is not needed. Implementation detail decided during Unit 1.2.
<!-- Worker module-preload mechanism: RESOLVED during document review — temp-file approach (write under src/code_api/, then dynamic import via tsx-loaded worker). data: URL provably doesn't work for TS or relative imports. -->
- **`download_submission_attachment` storage path** — write to `./submissions/{courseCode}/{assignmentId}/{userId}-{filename}` by default; expose `targetDir` param. Confirm during Unit 3.1.

## Output Structure

```
node-mcp-server/
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── README.md
├── CLAUDE.md
├── docs/
│   ├── plans/
│   │   └── 2026-05-22-001-feat-canvas-mcp-typescript-port-plan.md
│   └── MIGRATION.md            # skill migration: Google tools → Drive MCP
├── src/
│   ├── index.ts                # MCP server entry; loads env, registers tool groups
│   ├── canvasClient.ts         # axios-backed Canvas REST client (pagination, retry, course-code cache)
│   ├── anonymizer.ts           # persistent JSON map; load/save; deterministic pseudonyms; teacher protection
│   ├── competencies.ts         # FRANKLIN_COMPETENCIES const + formatter
│   ├── types.ts                # Canvas resource types, anon-map shape, tool envelopes
│   ├── tools/
│   │   ├── courses.ts          # list_courses, get_course_details
│   │   ├── modules.ts          # list_modules, add_module_item
│   │   ├── assignments.ts      # list_assignments, get_assignment_details, get_assignment_rubric_details
│   │   ├── rubrics.ts          # list_all_rubrics, get_rubric_details
│   │   ├── users.ts            # list_users, list_user_enrollments, list_account_users
│   │   ├── pages.ts            # list_pages, get_page_content, create_page, edit_page_content
│   │   ├── quizzes.ts          # create_quiz, create_quiz_question
│   │   ├── submissions.ts      # list_submissions, get_submission_rubric_assessment, download_submission_attachment
│   │   ├── grading.ts          # grade_submission, grade_with_rubric, grade_submission_with_rubric, bulk_grade_submissions
│   │   ├── competencies.ts     # list_competencies
│   │   ├── anonymization.ts    # create_student_anonymization_map, get_anonymization_status
│   │   └── code_exec.ts        # execute_typescript
│   ├── workers/
│   │   ├── ts_exec_worker.ts   # worker thread entry; runs user TS with code_api importable
│   │   └── network_guard.ts    # NODE_OPTIONS --require allowlist guard (ported from Python MCP)
│   └── code_api/               # lifted from canvas-mcp-fork; importable by user code in execute_typescript
│       ├── index.ts            # root re-exports (canvas/ + anonymizer)
│       ├── client.ts           # canvas-mcp-fork puts the shared client at code_api/client.ts (one level above canvas/)
│       ├── anonymizer.ts       # FERPA-safe adapter — wraps the same Anonymizer instance the typed tools use, exposed to user code so execute_typescript can handle student data without bypassing anonymization
│       └── canvas/
│           ├── index.ts        # truncated re-exports — drops discussions/, communications/ lines from the original
│           ├── assignments/
│           │   ├── index.ts
│           │   └── listSubmissions.ts
│           ├── courses/
│           │   ├── index.ts
│           │   ├── listCourses.ts
│           │   └── getCourseDetails.ts
│           └── grading/
│               ├── index.ts
│               ├── bulkGrade.ts
│               └── gradeWithRubric.ts
└── tests/
    ├── canvasClient.test.ts
    ├── anonymizer.test.ts
    ├── tools/
    │   ├── grading.test.ts
    │   ├── submissions.test.ts
    │   ├── anonymization.test.ts
    │   └── code_exec.test.ts
    └── workers/
        └── ts_exec_worker.test.ts
```

## High-Level Technical Design

> *These illustrate the intended approach and are directional guidance for review, not implementation specification. The implementing agent should treat them as context, not code to reproduce.*

### Anonymization data flow

```mermaid
flowchart TB
    A[Tool call: list_submissions courseId=60366] --> B{anonymous?}
    B -- "true (default)" --> C[Load ~/.canvas-mcp/anon-maps/60366.json]
    B -- "false" --> Z[Return raw Canvas response]
    C --> D{Map exists?}
    D -- "no" --> E[Empty in-memory map this call]
    D -- "yes" --> F[Load { userId → pseudonym } map]
    E --> G[For each student in response]
    F --> G
    G --> H{user role}
    H -- "teacher/admin/ta" --> I[Keep real name + email]
    H -- "student" --> J{In map?}
    J -- "yes" --> K[Apply existing pseudonym]
    J -- "no" --> L[Allocate next Student N + persist on first allocation]
    K --> M[Anonymized response]
    L --> M
    I --> M
    M --> N[Return to caller]
    L -->|persist before return| C
```

Key invariants:
1. **Per-course separation** — Student 7 in course A and Student 7 in course B are different students. No global counter.
2. **Allocation persistence** — once a pseudonym is assigned, it's written to disk before the response returns. A crash mid-call may leave new students un-allocated, but never assigns the same pseudonym to two different student IDs.
3. **`create_student_anonymization_map` is idempotent** — calling it on a course with an existing map merges new students into the existing pseudonym sequence; does not renumber.
4. **Role detection** — `user.role` (Canvas enrollment role) is the trust signal. `null/undefined` role defaults to student-treatment for safety.

### `execute_typescript` worker model

```mermaid
flowchart LR
    A[execute_typescript tool] --> B[Spawn Worker]
    B -->|workerData: code, env| C[ts_exec_worker.ts]
    C --> D[Set process.env CANVAS_API_*]
    D --> E[Apply network_guard.ts<br/>if enableNetworkGuard]
    E --> F[Dynamically import user code]
    F --> G[User code may import<br/>../code_api/canvas/...]
    G --> H[Code runs to completion<br/>or throws]
    H --> I[Worker sends {ok, stdout, stderr}]
    A --> J[Promise.race against timeout]
    J -- timeout --> K[worker.terminate]
    J -- result --> L[Format + return]
    I --> L
    K --> M[Return ❌ timed out]
```

Resource controls:
- **`resourceLimits.maxOldGenerationSizeMb`** — passed to `new Worker(..., { resourceLimits })`. Worker is OOM-killed by Node if it exceeds; the main MCP thread is unaffected.
- **Timeout** — `Promise.race(workerPromise, setTimeout)`. On timeout, `worker.terminate()` reclaims thread/memory.
- **Env injection** — a **plain serialized copy** (not a live reference) of only `CANVAS_API_URL`, `CANVAS_API_TOKEN`, `TS_SANDBOX_BLOCK_OUTBOUND`, `TS_SANDBOX_ALLOWLIST_HOSTS` is passed via `workerData.env` and applied as `process.env` inside the worker. Host `NODE_OPTIONS` and the parent's full `process.env` are not inherited. **Trust-boundary note:** the Canvas token is intentionally available to user code via `process.env.CANVAS_API_TOKEN` so `code_api/canvas/client.ts` can read it. The security posture relies on (a) the operator controlling what code reaches `execute_typescript`, (b) the network guard preventing exfiltration to non-allowlisted hosts, and (c) the token-scrubbing of error responses described above.
- **Network allowlist (default ON)** — `network_guard.ts` is a ported version of the Python MCP's `_write_network_guard`. The worker imports it at the very top of the executed user code (prepended into the temp `.ts` file before the user's source) so its monkey-patches of `http`, `https`, `net`, `tls`, and `globalThis.fetch` apply before user code can grab references. **Default behavior:** `TS_SANDBOX_BLOCK_OUTBOUND=true`, `TS_SANDBOX_ALLOWLIST_HOSTS` defaults to the host parsed from `CANVAS_API_URL`. User code can reach Canvas but nothing else without explicit opt-out. Rationale: `execute_typescript` runs LLM-authored code with an account-admin Canvas token in scope; prompt-injection via student submission content is a plausible delivery path for token exfiltration, and the only cost of secure-by-default is one extra env var if a workflow legitimately needs outbound to another host. The guard is **best-effort** (see Limitations below), not a strong sandbox.
- **Guard limitations** documented explicitly in `network_guard.ts` and Unit 5.2 docs: native addons are not covered (they bypass the JS-level monkey-patch), `process.binding('tcp_wrap')` is not covered, and a determined attacker with control of the user-code source can still find ways around any monkey-patch in the same process. The guard raises the cost of accidental exfiltration; it does not stop a knowledgeable attacker.

### Tool → Endpoint mapping (Canvas REST)

| Tool | HTTP method + Canvas endpoint | Notes |
|---|---|---|
| `list_courses` | `GET /api/v1/courses` | Per-user; paginated. |
| `get_course_details` | `GET /api/v1/courses/{id}` | Accepts course code via cache lookup. |
| `list_users` | `GET /api/v1/courses/{id}/users?enrollment_type[]=student&include[]=email` | Per-course only. |
| `list_user_enrollments` | `GET /api/v1/users/{user_id}/enrollments` | Cross-course; surfaces every course a student is in. |
| `list_account_users` | `GET /api/v1/accounts/{account_id}/users` | Requires account-admin scope. `accountId` param required. |
| `list_modules` | `GET /api/v1/courses/{id}/modules` | Optional `include[]=items`. |
| `add_module_item` | `POST /api/v1/courses/{id}/modules/{mid}/items` | Body: `{ module_item: { type, content_id, title, position } }`. |
| `list_assignments` | `GET /api/v1/courses/{id}/assignments` | Paginated; optional `include[]=submission`. |
| `get_assignment_details` | `GET /api/v1/courses/{id}/assignments/{aid}` | Single resource. |
| `get_assignment_rubric_details` | `GET /api/v1/courses/{id}/assignments/{aid}?include[]=rubric` | Extracts `rubric` field. |
| `list_all_rubrics` | `GET /api/v1/courses/{id}/rubrics` | Per-course only (`courseIdentifier` param); matches Python MCP at `rubrics.py:888`. |
| `get_rubric_details` | `GET /api/v1/courses/{id}/rubrics/{rid}` | Single resource. |
| `list_submissions` | `GET /api/v1/courses/{id}/assignments/{aid}/submissions?include[]=user,submission_comments,rubric_assessment` | Paginated; anonymization applied. |
| `get_submission_rubric_assessment` | `GET /api/v1/courses/{id}/assignments/{aid}/submissions/{uid}?include[]=rubric_assessment` | Extracts assessment. |
| `download_submission_attachment` | `GET /api/v1/courses/{id}/assignments/{aid}/submissions/{uid}` → fetch attachment URLs | Writes file(s) to disk; returns paths. |
| `grade_submission` | `PUT /api/v1/courses/{id}/assignments/{aid}/submissions/{uid}` | Body: `{ submission: { posted_grade } }`. |
| `grade_with_rubric` | `PUT /api/v1/courses/{id}/assignments/{aid}/submissions/{uid}` | Body: `{ rubric_assessment: { criterion_id: { points, comments } } }`. |
| `grade_submission_with_rubric` | same endpoint | Combines posted_grade + rubric_assessment + comment in one call. |
| `bulk_grade_submissions` | iterates `list_submissions` → `grade_with_rubric` per user via lifted `code_api/canvas/grading/bulkGrade.ts` | Bounded concurrency. |
| `list_pages` | `GET /api/v1/courses/{id}/pages` | Paginated; returns slug, title, published-state, updated_at. Used by `create-activity-doc` skill. |
| `get_page_content` | `GET /api/v1/courses/{id}/pages/{url_slug}` | Returns full HTML body. |
| `create_page` | `POST /api/v1/courses/{id}/pages` | `published: false` by default. |
| `edit_page_content` | `PUT /api/v1/courses/{id}/pages/{url_slug}` | Body: `{ wiki_page: { body, title } }`. |
| `create_quiz` | `POST /api/v1/courses/{id}/quizzes` | `published: false` by default. |
| `create_quiz_question` | `POST /api/v1/courses/{id}/quizzes/{qid}/questions` | Body: `{ question: {...} }`. |
| `list_competencies` | (no Canvas call) | Returns `FRANKLIN_COMPETENCIES` constant. |
| `get_anonymization_status` | (no Canvas call) | Lists JSON map files under `~/.canvas-mcp/anon-maps/` with sizes. |
| `create_student_anonymization_map` | `GET /api/v1/courses/{id}/users?enrollment_type[]=student&include[]=email` → write JSON | Idempotent merge. |
| `execute_typescript` | (no Canvas call) | Worker thread; user code may make any Canvas call via `code_api/`. |

## Implementation Units

- [ ] **Unit 1.1: Project scaffold**

**Goal:** Standing TypeScript project that builds, lints, and runs an empty MCP server over stdio.

**Requirements:** R1 (project exists to expose tools)

**Dependencies:** None

**Files:**
- Create: `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`, `src/index.ts`, `src/types.ts`
- Create: `README.md` (minimal — full version in Unit 6.1)

**Approach:**
- `package.json`: `"type": "module"`, deps `@modelcontextprotocol/sdk@^1.11.3`, `axios@^1.6`, `zod@^3.24`, `dotenv@^16.4`; devDeps `typescript@^5.7`, `tsx@^4`, `@types/node@^20`, `vitest@^2` for tests.
- Scripts: `build` (tsc), `dev` (tsx watch), `start` (node dist/index.js), `test` (vitest run).
- `tsconfig.json`: ESM, `moduleResolution: "bundler"`, `target: "ES2022"`, `outDir: "dist"`, strict mode on.
- `src/index.ts` skeleton: dotenv, instantiate `McpServer`, validate `CANVAS_API_TOKEN` and `CANVAS_API_URL`, connect to `StdioServerTransport`. Tool registration calls are stubs at this point.
- `.env.example`: `CANVAS_API_TOKEN=`, `CANVAS_API_URL=`, `ANON_MAP_DIR=` (optional override; defaults to `~/.canvas-mcp/anon-maps/` — set this to a synced folder if you want anonymization maps to survive machine loss), plus the optional `TS_SANDBOX_*` keys from the Python MCP (note: `TS_SANDBOX_BLOCK_OUTBOUND` defaults to `true` per Unit 5.2).

**Patterns to follow:** r-huijts/canvas-mcp `src/index.ts` shape exactly. **Register under the existing `canvas-mcp` key in `claude_desktop_config.json`** (replacing the Python MCP entry at cutover) so the skill front-matter's `mcp__canvas-mcp__*` tool prefix continues to resolve. The MCP server's internal `name` (passed to `McpServer({ name, version })`) is cosmetic — what matters is the JSON config key. Cutover is hard: swap the `command` line in `claude_desktop_config.json` from the Python entrypoint to `node dist/index.js`. Parallel run is not supported.

**Test scenarios:**
- Happy path: `npm run build` succeeds with zero errors on the empty server.
- Error path: missing `CANVAS_API_TOKEN` causes the process to exit with code 1 and a clear stderr message.

**Verification:** Server starts on stdio without errors when env vars are set; exits cleanly when not.

---

- [ ] **Unit 1.2: CanvasClient**

**Goal:** A single axios-backed client class that all typed tools share, with pagination, retry, course-code resolution, and per-domain helper methods.

**Requirements:** R6 (account-admin endpoints), R9 (course code in output)

**Dependencies:** Unit 1.1

**Files:**
- Create: `src/canvasClient.ts`
- Test: `tests/canvasClient.test.ts`

**Approach:**
- Constructor: `(baseUrl: string, apiToken: string)`. Pre-builds an axios instance with `Authorization: Bearer ${apiToken}` and a 30s default timeout.
- `request<T>(method, path, opts)` — central method. Handles 429 with `Retry-After` (exponential backoff capped at 3 attempts). Surfaces 4xx as typed `CanvasApiError`.
- `getPaginated<T>(path, params)` — follows Canvas `Link: <...>; rel="next"` header until exhausted. Bounded to a `maxPages` (default 100) to avoid runaway pagination.
- Course-code cache: in-process `Map<string, number>` (course code → course id) + reverse map. `resolveCourseId(identifier: string | number)` checks cache, falls back to `GET /api/v1/courses?search_term=...` then `GET /api/v1/courses/{id}` to validate. **No LRU eviction** — a high-school teacher won't exceed a few hundred courses across their entire career; entries are tiny (string→number); cleared on MCP restart. **For grading write tools, bypass the cache** (re-resolve every call) so a course rename can't cause a write to the stale id.
- Per-domain methods get added incrementally in later units; this unit ships only `request`, `getPaginated`, `resolveCourseId`, and the four bare HTTP shortcuts (`get`, `post`, `put`, `del`).

**Patterns to follow:** Reference repo's `src/canvasClient.ts` for class shape and method naming. Pagination follows the Canvas `Link` header standard (RFC 5988); don't reinvent.

**Test scenarios:**
- Happy path: `getPaginated` walks two pages of mock data and returns the concatenated list.
- Edge case: empty first-page response returns `[]` without erroring.
- Edge case: `maxPages` limit triggers; returns what was fetched plus a warning.
- Error path: 429 with `Retry-After: 1` triggers exactly one retry, then succeeds.
- Error path: 401 surfaces as `CanvasApiError` with `code: 'UNAUTHORIZED'` (no retry).
- Happy path: `resolveCourseId` cache-hit returns numeric id without an HTTP call.
- Integration: `resolveCourseId('badm_554_120251_246794')` falls back to `search_term` and caches the result.

**Verification:** Client returns parsed JSON for valid requests, propagates errors with useful context, and never silently drops pagination data.

---

- [ ] **Unit 1.3: Lift code_api modules**

**Goal:** The TypeScript helper modules from `canvas-mcp-fork/src/canvas_mcp/code_api/canvas/` exist under `src/code_api/canvas/` and compile cleanly under this project's `tsconfig.json`.

**Requirements:** R4 (execute_typescript import surface), R5 (grading code reuse)

**Dependencies:** Unit 1.1, Unit 1.2

**Files:**
- Create: `src/code_api/index.ts`, `src/code_api/client.ts` (parent-level — the shared client lives here in canvas-mcp-fork, one level above `canvas/`)
- Create: `src/code_api/canvas/index.ts` (truncated: drop the original's `export * from ./discussions/index.js` and `./communications/index.js` lines since those subtrees are not lifted)
- Create: `src/code_api/canvas/assignments/{index,listSubmissions}.ts`
- Create: `src/code_api/canvas/courses/{index,listCourses,getCourseDetails}.ts`
- Create: `src/code_api/canvas/grading/{index,bulkGrade,gradeWithRubric}.ts`

**Approach:**
- Copy `.ts` files verbatim from `canvas-mcp-fork/src/canvas_mcp/code_api/{client.ts,index.ts}` and the three `canvas/{assignments,courses,grading}/` subtrees. Do NOT lift the root `canvas/index.ts` verbatim — it re-exports discussions/communications which we're not lifting; copy it with those two `export *` lines removed.
- Verify the `import { fetchAllPaginated } from "../../client.js"` style imports in `listSubmissions.ts` etc. resolve correctly with `client.ts` at `code_api/client.ts` (two-up from `canvas/assignments/listSubmissions.ts` ✓).
- Update `client.ts` if it imports anything Python-MCP-specific — verify it only depends on `CANVAS_API_URL` / `CANVAS_API_TOKEN` env vars.
- Compile pass: `tsc --noEmit` must succeed before this unit is done.

**Patterns to follow:** The lifted files **are** the pattern. Do not refactor in this unit.

**Test scenarios:** Test expectation: none — pure lift; behavior is tested by the units that consume these modules (3.1, 3.2, 5.2).

**Verification:** `npm run build` succeeds. A trivial `tsx -e "import('./src/code_api/canvas/index.js').then(m => console.log(Object.keys(m)))"` lists the expected exports.

---

- [ ] **Unit 2.1: Course tools (list_courses, get_course_details)**

**Goal:** Two read-only tools registered and returning Canvas course data.

**Requirements:** R1, R9

**Dependencies:** Unit 1.2

**Files:**
- Create: `src/tools/courses.ts`
- Modify: `src/index.ts` (call `registerCourseTools(server, canvas)`)
- Test: `tests/tools/courses.test.ts`

**Approach:**
- `list_courses`: no required params; optional `enrollment_state` (default `active`), `include` (array). Returns formatted list with `id`, `course_code`, `name`, `term.name`.
- `get_course_details`: requires `courseIdentifier` (string|number — accepts code or id). Uses `canvas.resolveCourseId`.
- Output formatting: prefer `course_code` in the display string per R9.

**Patterns to follow:** Reference repo `src/tools/courses.ts` for the `server.tool(...)` shape and zod schema style.

**Test scenarios:**
- Happy path: `list_courses` returns the mocked course list with course codes displayed.
- Happy path: `get_course_details` accepts a course code, resolves to id, returns details.
- Edge case: `get_course_details` with an unknown identifier returns a structured error, not a thrown exception.

**Verification:** Both tools appear in `tools/list` and return valid `content[].text` payloads when called via the MCP harness.

---

- [ ] **Unit 2.2: Module tools (list_modules, add_module_item)**

**Goal:** Read modules and add a single item of a supported type.

**Requirements:** R1, R8

**Dependencies:** Unit 1.2

**Files:**
- Create: `src/tools/modules.ts`
- Modify: `src/index.ts`
- Test: `tests/tools/modules.test.ts`

**Approach:**
- `list_modules`: `courseIdentifier` required, optional `includeItems`.
- `add_module_item`: required `courseIdentifier`, `moduleId`, `type` (enum: `Page` | `Assignment` | `Quiz` | `SubHeader` for first cut), `title`, `contentId?` (required for non-`SubHeader`). Sends `module_item: { type, content_id, title, position }`. `published` is not set by this endpoint (modules manage publish state separately).

**Patterns to follow:** Canvas modules API uses a wrapper key: `{ module_item: {...} }` in the POST body. Mirror reference repo's wrapper handling in pages.

**Test scenarios:**
- Happy path: `list_modules` with `includeItems: true` returns modules each with their items inline.
- Happy path: `add_module_item` for type `Page` posts the correct payload shape.
- Error path: `add_module_item` with type `Page` and no `contentId` is rejected at the zod layer before any HTTP call.
- Edge case: unsupported type (e.g., `ExternalTool`) returns a clear "not implemented in this version" error.

**Verification:** Items created in Canvas via this tool show up under the module immediately on a `list_modules` refresh.

---

- [ ] **Unit 2.3: Assignment tools (list_assignments, get_assignment_details, get_assignment_rubric_details)**

**Goal:** Three read tools for assignment metadata, including a focused rubric variant.

**Requirements:** R1

**Dependencies:** Unit 1.2

**Files:**
- Create: `src/tools/assignments.ts`
- Modify: `src/index.ts`
- Test: `tests/tools/assignments.test.ts`

**Approach:**
- `list_assignments`: `courseIdentifier`, optional `studentId`, `includeSubmissionHistory`, `anonymous` (default true — relevant when submissions are included).
- `get_assignment_details`: full single-assignment fetch.
- `get_assignment_rubric_details`: `GET /courses/{id}/assignments/{aid}?include[]=rubric`, returns just the rubric field with a fallback message if the assignment has no rubric attached.

**Patterns to follow:** Reference repo `src/tools/assignments.ts`.

**Test scenarios:**
- Happy path: `list_assignments` paginates correctly and returns all assignments.
- Happy path: `get_assignment_details` returns `due_at`, `points_possible`, `submission_types`.
- Happy path: `get_assignment_rubric_details` returns rubric criteria with `id`, `description`, `points`, `ratings[]`.
- Edge case: `get_assignment_rubric_details` on a rubric-less assignment returns a structured `{ rubric: null, message: "..." }` rather than erroring.

**Verification:** Outputs match Canvas web UI for the same assignments.

---

- [ ] **Unit 2.4: Rubric tools (list_all_rubrics, get_rubric_details)**

**Goal:** Two rubric tools, with scope behavior matching the Python MCP.

**Requirements:** R1

**Dependencies:** Unit 1.2

**Files:**
- Create: `src/tools/rubrics.ts`
- Modify: `src/index.ts`
- Test: `tests/tools/rubrics.test.ts`

**Approach:**
- First step in this unit: open `canvas-mcp-fork/src/canvas_mcp/tools/rubrics.py` around line 899 (where `list_all_rubrics` hits `/courses/{id}/rubrics`) and confirm scope. If it's per-course only, take `courseIdentifier`. If it accepts an account id, support both modes via discriminated union (`{ scope: 'course'; courseIdentifier } | { scope: 'account'; accountId }`). Decision made and documented in this unit's PR description, not pre-litigated here.
- `get_rubric_details`: requires `courseIdentifier` + `rubricId`. Returns criteria + ratings.

**Patterns to follow:** Match the Python MCP's parameter signature exactly so skills don't break.

**Test scenarios:**
- Happy path: `list_all_rubrics` for a course returns the rubric list with `id`, `title`, `points_possible`.
- Happy path: `get_rubric_details` returns full criteria including rating descriptors.
- Edge case: `list_all_rubrics` on a course with no rubrics returns `[]` with a friendly message.

**Verification:** Skills `scan-tdc-rubrics` and `grade-submissions` can find rubrics by name through these tools.

---

- [ ] **Unit 2.5: User tools (list_users, list_user_enrollments, list_account_users)**

**Goal:** Three user-listing tools with anonymization integrated (wiring happens in Unit 4.2; this unit returns un-anonymized output and accepts the `anonymous` param as a no-op placeholder).

**Requirements:** R1, R6

**Dependencies:** Unit 1.2, **Unit 4.1 (Anonymizer must exist before any student-data tool registers — FERPA gate)**

**Files:**
- Create: `src/tools/users.ts`
- Modify: `src/index.ts`
- Test: `tests/tools/users.test.ts`

**Approach:**
- `list_users`: `course_identifier`, optional `include_email` (default false), optional `anonymous` (default true; wired in 4.2 which lands in the same phase as this unit).
- `list_user_enrollments`: `userId`, optional `state[]` filter (default `['active']`). Hits `GET /users/{uid}/enrollments`. Surfaces course code, role, status.
- `list_account_users`: `accountId`, optional `search_term`, optional `enrollment_type[]`. Paginated. Fails fast if the token returns 401/403 with a clear message ("requires account-admin scope").

**Patterns to follow:** Reference repo `src/tools/students.ts` for `list-students` pattern; expand with `list_account_users` + `list_user_enrollments`.

**Test scenarios:**
- Happy path: `list_users` returns students in a course with anonymized names (after 4.2 wires anonymization).
- Happy path: `list_user_enrollments` returns all enrollments for a user across the institution.
- Happy path: `list_account_users` with `search_term="Smith"` returns matching users from the account.
- Error path: `list_account_users` without admin scope returns a clear scope-explanation error.

**Verification:** All three tools are callable from skills with the same parameter names the Python MCP uses.

---

- [ ] **Unit 2.6: Page tools (list_pages, get_page_content, create_page, edit_page_content)**

**Goal:** List, read, create (unpublished), and edit Canvas wiki pages.

**Requirements:** R1, R8

**Dependencies:** Unit 1.2

**Files:**
- Create: `src/tools/pages.ts`
- Modify: `src/index.ts`
- Test: `tests/tools/pages.test.ts`

**Approach:**
- `list_pages`: `courseIdentifier`. Paginated `GET /api/v1/courses/{id}/pages`; returns array of `{ url, title, published, updated_at }`. No anonymization (pages aren't student-data).
- `get_page_content`: `courseIdentifier`, `pageUrl` (slug). Returns full HTML body + metadata.
- `create_page`: `courseIdentifier`, `title`, `body` (HTML), optional `editingRoles`. Always sends `published: false`. Returns the created page including its URL slug.
- `edit_page_content`: `courseIdentifier`, `pageUrl`, optional `title`, optional `body`, optional `editingRoles`. Sends `wiki_page: {...}` wrapper.

**Patterns to follow:** Reference repo's `src/tools/pages.ts` is the most thorough existing module; mirror its wrapper handling.

**Test scenarios:**
- Happy path: round-trip — `create_page` → `get_page_content` returns the same body.
- Happy path: `edit_page_content` updates title without touching body when body is omitted.
- Edge case: `create_page` defaults `published: false` even if caller omits the field.
- Error path: `edit_page_content` on a non-existent slug returns a 404 surfaced as a clean error message.

**Verification:** Created pages appear in Canvas as drafts; never auto-published.

---

- [ ] **Unit 2.7: Quiz tools (create_quiz, create_quiz_question)**

**Goal:** Create a quiz (unpublished) and add a question to it.

**Requirements:** R1, R8

**Dependencies:** Unit 1.2

**Files:**
- Create: `src/tools/quizzes.ts`
- Modify: `src/index.ts`
- Test: `tests/tools/quizzes.test.ts`

**Approach:**
- `create_quiz`: `courseIdentifier`, `title`, optional `description`, `quiz_type` (default `assignment`), `due_at`, `points_possible`. `published: false` forced.
- `create_quiz_question`: `courseIdentifier`, `quizId`, `question` (zod-validated object with `question_text`, `question_type`, `points_possible`, plus type-specific fields like `answers[]` for multiple-choice).

**Patterns to follow:** Reference repo's `src/tools/quizzes.ts` covers both. Lift the zod question schema if it's already correct.

**Test scenarios:**
- Happy path: `create_quiz` returns a quiz with `published: false`.
- Happy path: `create_quiz_question` for multiple-choice posts the right `answers[]` shape.
- Error path: invalid `question_type` rejected by zod before HTTP.

**Verification:** Quizzes created via the tool are visible in Canvas as drafts.

---

- [ ] **Unit 3.1: Submission read tools (list_submissions, get_submission_rubric_assessment, download_submission_attachment)**

**Goal:** Three submission read tools, anonymization-aware.

**Requirements:** R1, R2

**Dependencies:** Unit 1.2

**Files:**
- Create: `src/tools/submissions.ts`
- Modify: `src/index.ts`
- Test: `tests/tools/submissions.test.ts`

**Approach:**
- `list_submissions`: `courseIdentifier`, `assignmentId`, optional `anonymous` (default true), `includeRubricAssessment` (default true). Includes `user`, `submission_comments`, `rubric_assessment` via `include[]` params. Internally calls the lifted `code_api/canvas/assignments/listSubmissions.ts`.
- `get_submission_rubric_assessment`: `courseIdentifier`, `assignmentId`, `userId`. Returns just the `rubric_assessment` block with criterion descriptions joined from the assignment's rubric for readability.
- `download_submission_attachment`: `courseIdentifier`, `assignmentId`, `userId`, optional `attachmentId` (defaults to all attachments), optional `targetDir` (default `./submissions/{courseCode}/{assignmentId}/`). Streams files via the attachment's `url` (Canvas requires bearer auth for these too).

**Patterns to follow:** Reference repo's `get-submission-documents` already handles attachment download with bearer auth — lift that logic.

**Test scenarios:**
- Happy path: `list_submissions` for an anonymous-enabled call returns students as "Student N" but preserves teacher comment authors.
- Happy path: `get_submission_rubric_assessment` joins criterion `id`s to their `description`s.
- Happy path: `download_submission_attachment` writes the file with correct content; returns absolute path(s).
- Edge case: submission with no attachments returns `{ files: [], message: "No attachments" }`.
- Error path: `targetDir` not writable surfaces a clean error.

**Verification:** Files downloaded by this tool match what the Canvas web UI provides for the same submission.

---

- [ ] **Unit 3.2: Grading write tools (grade_submission, grade_with_rubric, grade_submission_with_rubric, bulk_grade_submissions)**

**Goal:** Four grading tools that share a single underlying `gradeWithRubric` call but expose distinct schemas matching the user's skills.

**Requirements:** R1, R5

**Dependencies:** Unit 1.3 (lifted `code_api/canvas/grading/`)

**Files:**
- Create: `src/tools/grading.ts`
- Modify: `src/index.ts`
- Test: `tests/tools/grading.test.ts`

**Approach:**
- All four tools call the same Canvas endpoint (`PUT /courses/{id}/assignments/{aid}/submissions/{uid}`). The tool names differ to match the user's skill signatures, not because the API does.
- `grade_submission`: `posted_grade` and/or `score` only. No rubric.
- `grade_with_rubric`: `rubric_assessment: { [criterion_id]: { points, comments } }`. No score override.
- `grade_submission_with_rubric`: combines both — `posted_grade` + `rubric_assessment` + optional `comment`. The "kitchen sink" version.
- `bulk_grade_submissions`: signature matches Python MCP exactly (`canvas_mcp/tools/rubrics.py:1426`): `(course_identifier, assignment_id, grades: { [user_id]: { rubric_assessment?, grade?, comment? } }, dry_run = false, max_concurrent = 5, rate_limit_delay = 1.0)`. The typed tool calls `gradeWithRubric.ts` in a small bounded-concurrency loop with the supplied `max_concurrent` + `rate_limit_delay`; it does NOT invoke `bulkGrade.ts` (whose function-callback form is reserved for `execute_typescript` callers that want programmatic decisions). The two paths share `gradeWithRubric.ts` as the per-submission write helper.
- **No `confirmWrite` parameter.** An LLM-passable boolean is not a real safety control (the LLM that decides to grade also fills the flag in). Safety lives in the workflow layer: the existing `dry_run: true` pattern in the `grade-submissions` skill is the actual gate. Matches Python MCP grading signatures exactly so skills don't need parameter changes. (Considered and rejected during document review.)

**Patterns to follow:** Lifted `code_api/canvas/grading/gradeWithRubric.ts` and `bulkGrade.ts` are the implementation core; these tool files are thin shells around them.

**Test scenarios:**
- Happy path: `grade_submission` with `posted_grade: "85"` sends the correct PUT payload.
- Happy path: `grade_with_rubric` writes per-criterion points and comments.
- Happy path: `grade_submission_with_rubric` combines posted_grade + rubric_assessment in one call.
- Happy path: `bulk_grade_submissions` with a `grades` dict of 3 user_ids writes 3 separate grades, returns `{ graded: 3, failed: 0, skipped: 0 }`.
- Edge case: `bulk_grade_submissions` partial failure (one user fails on network) returns `{ graded: 2, failed: 1, failedResults: [...] }`, does not throw.
- Edge case: `bulk_grade_submissions` with a user_id that has no current submission for the assignment (stale snapshot) returns that user in `skipped: [{ user_id, reason }]`, does not throw or grade.
- Edge case: Canvas 429 mid-bulk: in-flight requests respect the existing 429 retry logic; unprocessed entries stay unprocessed and the partial result reports both `graded` and `unprocessed` lists explicitly.
- Happy path: `bulk_grade_submissions` with `dry_run: true` returns the would-be grade payloads per submission without writing anything.
- Integration: a `grade_with_rubric` write is verifiable by a subsequent `get_submission_rubric_assessment` read.

**Verification:** Grades written by this tool appear in the Canvas SpeedGrader for the relevant assignment.

---

- [ ] **Unit 4.1: Anonymizer core**

**Goal:** `src/anonymizer.ts` implements persistent per-course pseudonym maps with idempotent allocation and role-aware filtering.

**Requirements:** R2, R3

**Dependencies:** Unit 1.1

**Files:**
- Create: `src/anonymizer.ts`
- Test: `tests/anonymizer.test.ts`

**Approach:**
- File layout: `{ANON_MAP_DIR}/{courseId}.json` where `ANON_MAP_DIR` defaults to `~/.canvas-mcp/anon-maps/` but is **configurable via the `ANON_MAP_DIR` env var** so the teacher can point it at a synced folder (iCloud Drive, Dropbox, a managed Google Drive mount, an internal NAS) for durability across machine loss. File contents: `{ version: 1, courseId: number, generatedAt: string, students: { [userId: string]: { pseudonym: string, anonymizedEmail: string, status: "active" | "historical" } } }`.
- Class `Anonymizer` with methods:
  - **`init()`** — called once at construction; runs `fs.mkdir(rootDir, { recursive: true, mode: 0o700 })` to guarantee the directory exists with owner-only permissions on first run.
  - `loadMap(courseId): Promise<AnonMap | null>` — returns null if file missing.
  - `getOrAllocate(courseId, user): Promise<{ pseudonym, anonymizedEmail }>` — looks up by `user.id`; allocates next `Student N` if absent; persists to disk before returning.
  - `anonymizeUser(courseId, user)` — wraps `getOrAllocate`; respects `user.role` (skips for `teacher`/`admin`/`ta`).
  - `anonymizeSubmission(courseId, submission)` — anonymizes `submission.user` and submission-comment authors with `role === 'student'`; preserves all other comment authors verbatim.
  - `mergeIntoMap(courseId, students)` — bulk add (used by `create_student_anonymization_map`); marks any prior entry not in the new roster as `status: "historical"`, marks current roster as `status: "active"`. Pseudonyms are NEVER renumbered or reused.
- **Concurrency: per-course async mutex.** `getOrAllocate` operations serialize behind a `Map<courseId, Promise<void>>` queue so concurrent reads-of-new-students (e.g., `Promise.all` over `list_submissions`) cannot both allocate the same `Student N` to different real students. Single-process only; multi-process locking is out of scope.
- Disk writes: write to a `.tmp` file **in the same directory** as the final path (guarantees POSIX same-filesystem atomic rename, no EXDEV across volumes), `fs.writeFile(..., { mode: 0o600 })`, then `fs.rename` to the final name. Owner-only permissions prevent other local users from reading the pseudonym→email mapping (FERPA-sensitive on shared machines).
- All `userId`s stringified as JSON keys (Canvas IDs can exceed `Number.MAX_SAFE_INTEGER` in some accounts; better safe).

**Patterns to follow:** Reference repo's `src/anonymizer.ts` for the role-detection logic; replace its in-memory storage with file-backed.

**Test scenarios:**
- Happy path: first call to `getOrAllocate` for a new user allocates "Student 1" and writes file.
- Happy path: second call for the same user (same process) returns "Student 1" from memory.
- Happy path: restarting (loading from fresh `Anonymizer` instance) reads "Student 1" from disk for the same user.
- Happy path: `anonymizeSubmission` keeps teacher comment authors verbatim.
- **Fresh-install path:** with no `~/.canvas-mcp/` directory present, first call creates the directory tree with mode `0o700` and persists successfully.
- **File-permission assertion:** after first write, `fs.stat(filePath).mode & 0o777 === 0o600` and the directory mode is `0o700`.
- Edge case: user with `role === null` is treated as student (safe default).
- Edge case: course with no map file yet → calls allocate normally; file is created on first allocation.
- **Concurrency:** 50 parallel `getOrAllocate` calls for 50 new student userIds on the same course produce exactly 50 distinct pseudonyms with no duplicates and no losses (this is the per-courseId mutex test).
- **Roster shrink:** `mergeIntoMap` with a new roster missing a previously-active student marks that entry as `status: "historical"` without renumbering or reusing the pseudonym.
- Error path: write failure (e.g., `~/.canvas-mcp/` not writable) surfaces a clear error and does not silently de-anonymize.

**Verification:** A pseudonym assigned today is the same pseudonym a week later in a new process.

---

- [ ] **Unit 4.2: Wire anonymization into existing tools**

**Goal:** All student-data tools accept `anonymous?: boolean` (default true) and route through the `Anonymizer` when true.

**Requirements:** R2, R3

**Dependencies:** Unit 4.1, Units 2.3, 2.5, 3.1

**Files:**
- Modify: `src/tools/users.ts`, `src/tools/assignments.ts`, `src/tools/submissions.ts`, `src/tools/grading.ts`
- Modify: `src/index.ts` (instantiate shared `Anonymizer` and pass to registrations alongside `canvas`)
- Test: `tests/tools/anonymization.test.ts`

**Approach:**
- `Anonymizer` is constructed once in `index.ts` and passed into each `register*Tools(server, canvas, anonymizer)`.
- Every tool that returns student data wraps its response through `anonymizer.anonymizeUser(...)` or `anonymizer.anonymizeSubmission(...)` when `anonymous === true`.
- `grade_*` tools accept `anonymous` only for echoing back submitter info in the response; the write payload is never anonymized (Canvas needs real IDs).
- The `userId` parameter to grading tools is **always** a real Canvas user id, never a pseudonym. If a skill ever needs to grade by pseudonym, it must first call `create_student_anonymization_map` and reverse the lookup itself.

**Patterns to follow:** Reference repo wraps `anonymizeUsers(...)` on response payloads; same pattern.

**Test scenarios:**
- Happy path: `list_users` with `anonymous: true` returns "Student N" names; with `anonymous: false` returns real names.
- Happy path: `list_submissions` anonymizes submitter but preserves teacher comment authors.
- Integration: `list_submissions(anonymous: true)` → grade the same submission by `userId` (which is unchanged — it's the real id) → `get_submission_rubric_assessment(anonymous: true)` reflects the grade for the same "Student N".

**Verification:** No tool ever returns a real student name when `anonymous: true` is in effect. (Verifiable by snapshot test.)

---

- [ ] **Unit 4.3: Anonymization tools (create_student_anonymization_map, get_anonymization_status)**

**Goal:** Two tools that manage the disk-resident anonymization state.

**Requirements:** R2

**Dependencies:** Unit 4.1

**Files:**
- Create: `src/tools/anonymization.ts`
- Modify: `src/index.ts`
- Test: `tests/tools/anonymization.test.ts`

**Approach:**
- `create_student_anonymization_map`: `courseIdentifier`. Fetches all students via `GET /courses/{id}/users?enrollment_type[]=student&include[]=email`; calls `anonymizer.mergeIntoMap(courseId, students)`; returns a summary table (`{ courseId, students: [{ pseudonym, realName, realEmail, userId }] }`). Idempotent — re-running on a course with an existing map only allocates pseudonyms for newly-added students. Returns the **full mapping in the response** since the only point of this tool is for the teacher to see the mapping.
- `get_anonymization_status`: no params. Walks `~/.canvas-mcp/anon-maps/`, reports `{ courseId, entries, generatedAt }` per file. Output makes clear that maps are persistent and per-course.

**Patterns to follow:** Reference Python implementation in `canvas-mcp-fork/src/canvas_mcp/tools/other_tools.py:670`, but JSON output instead of CSV.

**Test scenarios:**
- Happy path: first invocation on a fresh course creates the JSON file and returns the mapping for N students.
- Happy path: second invocation on the same course (with no roster changes) returns the same mapping and reports `{ newlyAllocated: 0 }`.
- Happy path: second invocation after a new student enrolled allocates only the new student and reports `{ newlyAllocated: 1 }`.
- Happy path: `get_anonymization_status` lists all map files with their student counts.
- Edge case: `get_anonymization_status` on a system with no maps returns an empty list (not an error).

**Verification:** Teacher can run `create_student_anonymization_map` and use the returned JSON to manually identify any "Student N" in later narratives.

---

- [ ] **Unit 5.1: list_competencies (hardcoded constant)**

**Goal:** Surface Franklin's 9 TD competencies as an MCP tool.

**Requirements:** R1

**Dependencies:** Unit 1.1

**Files:**
- Create: `src/competencies.ts`, `src/tools/competencies.ts`
- Modify: `src/index.ts`
- Test: `tests/tools/competencies.test.ts`

**Approach:**
- `src/competencies.ts` exports `FRANKLIN_COMPETENCIES` as a `Readonly<Record<string, string>>` literal — port verbatim from `canvas-mcp-fork/src/canvas_mcp/tools/transdisciplinary.py:53`.
- `list_competencies` tool: no params; returns the formatted list (numbered, with descriptions).

**Patterns to follow:** Python `_format_competencies_list` in `transdisciplinary.py:66` for output format.

**Test scenarios:**
- Happy path: tool returns all 9 competencies in the documented order.
- Snapshot: the output string matches a checked-in snapshot (since this is human-readable formatting that may be visible in skill prompts).

**Verification:** Output is identical (modulo whitespace) to the Python MCP's `list_competencies` output. Verifiable by side-by-side comparison.

---

- [ ] **Unit 5.2: execute_typescript via worker_threads**

**Goal:** A working `execute_typescript` tool with terminable timeout, memory cap, env injection, default-on network allowlist, and a FERPA-safe `Anonymizer` adapter that user code can import to avoid bypassing the typed tools' anonymization.

**Requirements:** R4

**Dependencies:** Unit 1.3 (code_api modules importable from user code), Unit 4.1 (Anonymizer core — adapter is a thin wrapper around the same instance)

**Files:**
- Create: `src/workers/ts_exec_worker.ts`, `src/workers/network_guard.ts`
- Create: `src/tools/code_exec.ts`
- Create: `src/code_api/anonymizer.ts` (the user-code-facing adapter; re-exports `anonymizeUser`, `anonymizeSubmission`, `anonymizeUsers`, `anonymizeSubmissions` bound to the running MCP's `Anonymizer` instance via a small singleton-getter pattern that resolves through `workerData`)
- Modify: `src/index.ts`
- Test: `tests/workers/ts_exec_worker.test.ts`, `tests/tools/code_exec.test.ts`, `tests/code_api/anonymizer.test.ts`

**Approach:**
- `code_exec.ts` exposes `execute_typescript(code, timeout?)` (default timeout 120s, capped at e.g. 600s).
- Tool spawns `new Worker(workerScriptPath, { workerData: { code, env, enableNetworkGuard, allowlistHosts }, resourceLimits: { maxOldGenerationSizeMb: 512 } })`.
- `ts_exec_worker.ts`:
  1. Reads `workerData`.
  2. Applies env: `Object.assign(process.env, workerData.env)`.
  3. **Network guard ON by default.** Before writing the temp `.ts` file, prepend `import './network_guard.js';` (or the resolved relative path) as the very first line of the file. This guarantees the guard's monkey-patches run before any user import resolves its own references to `http`/`https`/`net`/`tls`/`fetch`. The guard reads `process.env.TS_SANDBOX_ALLOWLIST_HOSTS` and `process.env.TS_SANDBOX_BLOCK_OUTBOUND` at the moment of its first execution. (Disabling requires `TS_SANDBOX_BLOCK_OUTBOUND=false`; default is ON with Canvas host pre-allowed.)
  4. Captures stdout/stderr by wrapping `console.log`/`console.error` to buffer + forward.
  5. Executes user code by writing a temp `.ts` file under `src/code_api/` (so relative imports like `./canvas/grading/bulkGrade.js` resolve), then dynamically `await import(tempPath)`. **The `data:text/typescript` URL approach is not viable** — Node's ESM data: loader only accepts `text/javascript`, `application/json`, `application/wasm`, and data: URLs have no base for relative-specifier resolution (`ERR_INVALID_URL`). Temp-file approach is the only path that supports the stated `import from ./code_api/...` requirement. The worker runs under `tsx` so on-the-fly TS compilation is available.
  6. On completion, posts `{ ok: true, stdout, stderr, returnValue }`. On error, posts `{ ok: false, error: err.message, stack }`. **Before posting, scrub the literal `CANVAS_API_TOKEN` value from `error.message`, `stack`, `stdout`, and `stderr`** (simple substring replace with `***REDACTED***`) so a token-leaking stack trace doesn't surface the credential into Claude's tool-result context.
- Tool side:
  - `Promise.race([workerCompletion, timeout])`. On timeout: `worker.terminate()` and return formatted `❌ Execution timed out after Xs`.
  - Format output the same way the Python MCP does (`✅` / `❌` header + sandbox info + output sections) so the skill prompts that key off this format keep working.
- `network_guard.ts`: TS port of `canvas-mcp-fork/src/canvas_mcp/tools/code_execution.py:117` `_write_network_guard`. Reads `ALLOWLIST` from `process.env.TS_SANDBOX_ALLOWLIST_HOSTS` (already exported into the worker by the tool). Monkey-patches `net.connect`, `tls.connect`, `http.request`, `https.request`, and `globalThis.fetch`.
- A companion tool `list_code_api_modules` (port from Python `code_execution.py:604`) is **out of scope** for the user's 31 tools but worth a small addition if it makes `execute_typescript` more usable for Claude. Decision: include it as part of this unit since the cost is minimal and discovery improves significantly.

**Test scenarios:**
- Happy path: simple `console.log("hi")` returns stdout containing "hi" within 1s.
- Happy path: code importing `./code_api/canvas/courses/listCourses.js` executes without import errors.
- Happy path: env var `CANVAS_API_TOKEN` is readable inside user code.
- Happy path (FERPA adapter): code importing `{ anonymizeSubmissions } from './code_api/anonymizer.js'` and wrapping a `listSubmissions` result returns pseudonymized student names matching what the typed `list_submissions` tool would have returned for the same course (verifiable by snapshot comparison).
- Edge case: `while(true){}` is terminated at timeout, MCP server remains responsive to subsequent tool calls.
- Edge case: user code that allocates a large array of in-heap objects (e.g., `Array.from({length: 5_000_000}, () => ({a:1,b:2,c:3}))`) hits the `maxOldGenerationSizeMb` limit; worker is killed; MCP keeps serving. Note: `Buffer`/`ArrayBuffer` allocations use external memory and are NOT bounded by `maxOldGenerationSizeMb` — for those, only the timeout protects the MCP.
- Edge case: user code that calls `process.exit(0)` does not crash the MCP server (worker exits cleanly).
- Error path: syntax error in user code returns `❌` with the SyntaxError message.
- Error path: with `enableNetworkGuard=true` and allowlist excluding `example.com`, `fetch('https://example.com')` throws `SANDBOX_NETWORK_BLOCKED`.
- Integration: a non-trivial bulk-grade snippet (lifted from one of the user's existing skills) runs end-to-end.

**Verification:** A buggy script in `execute_typescript` does **not** require restarting Claude Desktop. The MCP server keeps serving other Canvas tools immediately after the buggy execution is killed.

---

- [ ] **Unit 6.1: Project README + CLAUDE.md**

**Goal:** Project-level docs sufficient for a new contributor (or the user, six months later) to install, configure, and operate the MCP.

**Requirements:** (operational)

**Dependencies:** Units 1.1–5.2 complete

**Files:**
- Create/replace: `README.md`, `CLAUDE.md`

**Approach:**
- `README.md`: install, env vars (with security guidance on token rotation per parent CLAUDE.md), Claude Desktop config snippet, full tool reference (29 tools, parameter signatures, anonymization behavior callout), brief contributing notes, **a dedicated "Anonymization map durability" section** that explains (a) the default storage location, (b) the `ANON_MAP_DIR` override, (c) the recommendation to point it at a synced folder, (d) why this matters for FERPA artifacts that reference pseudonyms over weeks or months, and (e) the warning that file loss orphans historical pseudonyms permanently.
- `CLAUDE.md`: per parent-directory convention. Covers project-specific guidance only — what code patterns to follow in this repo, where the lifted `code_api/` came from and the policy on modifying it (don't, unless upstream is also patched), the anonymization defaults, the no-auto-publish rule, the user-listing scope notes.

**Test scenarios:** Test expectation: none — docs.

**Verification:** A reader can install + configure the MCP starting only from `README.md`.

---

- [ ] **Unit 6.2: Skill migration guide**

**Goal:** A `docs/MIGRATION.md` that lists every skill change needed for `teaching-AIssitant/` to start using this MCP.

**Requirements:** R7

**Dependencies:** Units 1.1–5.2 complete

**Files:**
- Create: `docs/MIGRATION.md`

**Approach:**
- Per-skill audit table: skill name × tool calls × required change. Since tool names AND parameter names are now both `snake_case` matching the Python MCP, the main changes are: (a) the three Google tools migrate to `mcp__claude_ai_Google_Drive__*` equivalents; (b) `create_student_anonymization_map` should now be called once-per-course at the start of any longitudinal workflow; (c) `get_anonymization_status` output shape changed (lists files on disk rather than session counters); (d) the "Do NOT use `execute_typescript` — it bypasses FERPA anonymization" lines in `grade-submissions`, `write-narratives`, `plan-lesson`, `scan-tdc-rubrics`, `assess-tdc-scores`, `generate-tdc-portfolio`, `setup-class`, `create-quiz`, and `transition-report` should be rewritten as: "When using `execute_typescript` with student data, import `{ anonymizeSubmissions, anonymizeUsers } from './code_api/anonymizer.js'` and route responses through the adapter — this matches the typed tools' anonymization."
- Concrete before/after snippets for each skill change.
- Explicit list of skills that need **no** changes (most of them — naming alignment paid for itself).

**Test scenarios:** Test expectation: none — docs.

**Verification:** Following the guide is sufficient to migrate every affected skill without reading the MCP source.

## System-Wide Impact

- **Interaction graph:** New MCP runs over stdio. Skills are the consumers; they currently call `canvas-mcp-fork` via the `mcp__canvas-mcp__*` prefix. **Cutover is a hard swap** of the `command` entry under the `canvas-mcp` key in `claude_desktop_config.json` — Python entrypoint becomes `node dist/index.js`. After the swap, the same tool-prefix resolves to the new MCP; existing skill front-matter keeps working. Phase 7 skill edits (Google routing, anonymization workflow) happen as a separate pass.
- **Error propagation:** All Canvas API errors surface as `CanvasApiError` from `CanvasClient`, then become MCP `Tool.error` responses with the Canvas message preserved. Network guard violations surface as `SANDBOX_NETWORK_BLOCKED` from inside `execute_typescript`. Anonymization failures (write errors) abort the tool call rather than silently de-anonymizing — never fail open.
- **State lifecycle risks:** Anonymization map files are the only persistent state. A partial write during allocation could leave a pseudonym assigned in memory but not on disk; the atomic-rename approach in Unit 4.1 prevents this. Course-code cache is in-process only — no persistence — so no risk of stale data across restarts.
- **API surface parity:** Tool input/output shapes intentionally match the Python MCP for the 31 ported tools (with documented exceptions: `get_anonymization_status` output, anon-map format on disk, potentially `bulk_grade_submissions` signature). Skills calling those tools should not need code changes beyond what the migration guide lists.
- **Integration coverage:** Cross-layer behaviors that unit tests alone won't prove — anonymization persistence across process restarts (Unit 4.1 integration test), grading writes visible via subsequent reads (Unit 3.2 integration test), worker termination not corrupting MCP server state (Unit 5.2 integration test).
- **Unchanged invariants:** The user's `teaching-AIssitant/` skill files; the Python `canvas-mcp-fork` (still operational, can run in parallel); the Claude Drive MCP (referenced by skills, not modified); the user's Canvas LMS data (no destructive operations are added by this MCP beyond what the Python MCP already had).

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Account-admin Canvas token + grading writes = real damage from bugs | (a) `bulk_grade_submissions` includes a `dry_run` option (lifted from `bulkGrade.ts`) and the `grade-submissions` skill workflow already calls dry-run first; (b) grading write tools bypass the course-code cache (re-resolve every call) so a course rename can't silently misroute the write; (c) integration test against a sandbox before any production use. |
| FERPA non-compliance via anonymization leak | (a) Anonymization defaults to `true` everywhere; (b) snapshot tests on tool outputs to catch any path that returns un-anonymized data unexpectedly; (c) `get_anonymization_status` makes the state visible to the operator. |
| Worker thread doesn't actually terminate stuck code | `Worker.terminate()` is documented to forcibly kill the thread; resourceLimits memory cap is OS-enforced. Test scenario in Unit 5.2 specifically covers `while(true){}` and OOM. |
| Course-code → course-id cache returns stale id when a course is renamed | In-process LRU only; on cache miss, a fresh resolve happens; the worst case is one extra round-trip after a rename. Acceptable. |
| Pagination loses data on Canvas rate limit | 429 handling with `Retry-After` (Unit 1.2). `maxPages` cap is informational, not silent — surfaces a warning when hit. |
| Lifted `code_api/` modules drift from canvas-mcp-fork | Document in `CLAUDE.md` (Unit 6.1) that upstream changes should be pulled manually; mark the directory in code with a header comment pointing to its origin. |
| `list_account_users` fails silently for non-admin tokens | Surface 401/403 as a typed error with a clear "requires account-admin scope" message (Unit 2.5). |
| Worker thread import resolution differs from main-thread (ESM quirks) | Unit 5.2 tests specifically cover importing from `code_api/`. If `data:` URL approach doesn't work for relative imports, fall back to temp-file approach (which is what the Python MCP already does). |
| Persistent anon-map file format change later | Include a `version` field in the JSON schema from day one; a future migration can detect old versions. |
| **Anon-map file loss → orphaned historical pseudonyms** | `ANON_MAP_DIR` env var lets the teacher point storage at a synced folder (iCloud Drive, Dropbox, NAS). README's "Anonymization map durability" section calls out the risk explicitly and recommends sync. Accept that a teacher who ignores both the env var and the README will lose pseudonym stability if their machine fails. |

## Alternative Approaches Considered

- **Patch the Python MCP for persistent anonymization, skip the rewrite.** Considered during document review. The four stated pain points are real, but only anonymization (#4) is a correctness issue; a 1-day patch to `canvas-mcp-fork`'s in-memory map (load/save JSON instead) would solve it, and un-registering 57 unused tools in `server.py` would address tool-catalog bloat for another ~1 hour. **Rejected** because: (a) stack simplification (Node-only) has standalone value for ongoing maintenance, (b) `execute_typescript` going from Python-spawns-Node to native Node removes a real source of operational complexity, (c) parameter and tool-name alignment between this MCP and the user's skills is permanent value, (d) the rewrite is bounded (~5 phases of well-scoped work) and the lifted `code_api/` modules transfer cleanly. The lower-cost path is acknowledged and explicitly declined.
- **Fork r-huijts/canvas-mcp directly.** Rejected: would inherit `kebab-case` naming and unused tools, and the user wanted a fresh project. Reference-only use is cleaner.
- **Subprocess (`tsx`) for `execute_typescript`.** Rejected: 10× slower startup, no benefit over workers for this use case (single-tenant, trusted code, no docker need).
- **`node:vm` for `execute_typescript`.** Rejected: not a security boundary per Node docs; async timeouts unreliable; bugs would crash the MCP server.
- **Keep per-call (non-persistent) anonymization.** Rejected: breaks artifact stability across sessions (narratives, portfolios, transition reports).
- **CSV format for anon maps.** Rejected by user. JSON is easier to round-trip; a CSV-export tool can be added later if needed.
- **Re-implement Google OAuth + Drive client.** Rejected: duplicates the Claude Drive MCP's existing authenticated surface for no benefit.

## Success Metrics

- **Functional:** All 13 of the user's `teaching-AIssitant/` skills can complete an end-to-end run against the new MCP (after the migration guide is applied). Verifiable by running each skill once against a test course.
- **Performance:** `execute_typescript` startup latency drops from ~500ms (Python MCP subprocess) to ≤100ms (worker). Verifiable by a microbenchmark in Unit 5.2 tests.
- **Privacy:** Zero un-anonymized student names in any tool output when `anonymous` is at its default. Verifiable by snapshot tests covering every student-data tool.
- **Stability:** A buggy `execute_typescript` call (infinite loop, OOM, `process.exit`) does not require restarting Claude Desktop. Verifiable by Unit 5.2 integration tests.

## Phased Delivery

The implementation units above are grouped so that **no phase ships student-data tools before anonymization is wired** (FERPA hard gate):

- **Phase 1 — Foundation + anonymizer core:** Units 1.1, 1.2, 1.3, **4.1**. (No tools shipped yet; `Anonymizer` class exists and is instantiable.)
- **Phase 2 — Typed tools with anonymization wired:** Units 2.1, 2.2, 2.6, 2.7 (non-student data), then 2.3, 2.4, 2.5 (student data), then **4.2** (wire anonymization across the student-data tools), then **4.3** (anon-management tools). By the time any tool that returns student data is callable from Claude, the anonymizer is already wrapping responses.
- **Phase 3 — Grading suite:** Units 3.1, 3.2. Anonymization-aware from day one (the wiring done in 4.2 already covers `list_submissions` and friends).
- **Phase 4 — Code execution + competencies:** Units 5.1, 5.2. (Escape hatch ships with the `Anonymizer` adapter from Unit 5.2's added scope.)
- **Phase 5 — Documentation + migration guide:** Units 6.1, 6.2.
- **Phase 6 — (Out of scope here):** Skill edits in `teaching-AIssitant/` per the migration guide. Done in a separate session.

**No "ship Phase N independently" framing.** Phase 1 produces nothing user-visible. Phase 2 is the first usable milestone, and by construction it lands anonymization at the same time as student-data tools. Phases 3 and 4 add more tools; Phase 5 is docs. Cutover (swapping the `claude_desktop_config.json` entry) only happens after Phase 2 is complete.

> Note: the original 7-phase task tracker (Tasks #1–#7) was created earlier in planning. The mapping is: Task #1 → Phase 1; Task #5 (anonymization) is merged into Phase 1 + Phase 2; Tasks #2 (typed tools) → Phase 2; Task #3 (grading) → Phase 3; Task #4 was redundant with #2 (merged); Task #6 → Phase 4; Task #7 → Phase 5. The task tracker entries will be updated when implementation begins.

## Documentation / Operational Notes

- The user's existing `.env` for `canvas-mcp-fork` already contains a valid `CANVAS_API_TOKEN` and `CANVAS_API_URL`. The user will provide these to the new project directly — this plan and its implementer should never read the existing `.env` file.
- `claude_desktop_config.json` will need an entry pointing to the new MCP. Sample snippet goes in `README.md` (Unit 6.1).
- Logging: `console.error` only (per MCP convention — stdout is the JSON-RPC channel). Errors surface as MCP tool errors, not stderr-only.
- No telemetry, no analytics, no remote logging in this iteration.

## Sources & References

- **Reference Node MCP (structural model):** https://github.com/r-huijts/canvas-mcp (TypeScript, MCP SDK 1.11.3+, axios, zod, dotenv).
- **Python MCP source (endpoint catalog + lift sources):** `/Users/jdec/Documents/canvas-mcp-fork/` — relevant files include `src/canvas_mcp/tools/{assignments,gradebook,rubrics,modules,accounts,courses,other_tools,transdisciplinary,code_execution}.py` and the entire `src/canvas_mcp/code_api/canvas/` tree.
- **Canvas LMS REST API:** https://canvas.instructure.com/doc/api/
- **MCP TypeScript SDK:** https://github.com/modelcontextprotocol/typescript-sdk
- **Parent project conventions:** `/Users/jdec/Documents/CLAUDE.md` (Franklin School context, FERPA, no-auto-publish rule, course-code preference).
- **User's skills consuming this MCP:** `/Users/jdec/Documents/teaching-AIssitant/` — 13 skills, see § Phase 7 in this plan.
