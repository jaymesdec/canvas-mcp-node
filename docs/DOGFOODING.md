# v0.4.0 Dogfooding Checklist — run before packaging the `.mcpb`

Work through these against **real Canvas courses** in Claude Desktop (or Claude Code) with the dev build connected. Everything that creates content creates **drafts**, so it's safe to run on live courses — but use a low-stakes course for the grading tests, and clean up test artifacts as you go. If any FERPA check or wrong-course check fails: **do not package**; 0.3.17 stays the distributed version.

Setup: `npm run build`, point your `claude_desktop_config.json` at `dist/index.js` (or install a locally built `.mcpb`), restart Claude Desktop, and confirm stderr shows `[canvas-mcp] v0.4.0`.

***

## A. Token efficiency (the original complaint)

* [ ] **A1.** "List all the assignments in [a real course with 20+ assignments]." → Response should be fast and compact: no HTML descriptions, and each row shows due date, points, published state, and whether a rubric exists. Eyeball the raw tool result — no `description` fields, no `structuredContent`.

* [ ] **A2.** Follow up: "Show me the full instructions for [one assignment]." → Model should reach for `get_assignment_details` (the full-fidelity path) without you telling it to.

* [ ] **A3.** "List the submissions for \[a real assignment in a \~20-student class], including comments." → No avatar URLs, no preview URLs, no media metadata in the output. The conversation should have plenty of context left afterward — this call used to be the context-killer.

## B. Course resolution safety (the wrong-course-write fix)

* [ ] **B1.** Deliberately typo a course code: "List the modules in \[DTC-9X or similar nonexistent code]." → Expect an error listing candidate courses (code, id, name, term); the model should self-correct by picking the right one — never silently proceed.

* [ ] **B2.** If you have the **same course code across two years/terms**: refer to it by bare code. → Expect a disambiguation error naming both terms; the model should ask or use the numeric id. This was the flagship misroute scenario.

* [ ] **B3.** Refer to a **concluded course from last term** by its code. → It should resolve (or appear in candidates) — not a bogus "no course found."

## C. Assignment loop

* [ ] **C1.** "Create an assignment called 'MCP Test Assignment', 10 points, due next Friday, online text entry." → Check Canvas: it exists and is **unpublished**.

* [ ] **C2.** "Change it to 15 points and add a short description." → Verify the partial update in Canvas; still unpublished.

* [ ] **C3.** On an assignment that already **has student submissions**, try changing its submission types. → Expect a `warnings[]` note that Canvas ignored it (silent-ignore surfaced).

* [ ] **C4.** Delete the test assignment **in the Canvas UI** — `delete_assignment` is deliberately excluded (grade-bearing object).

* [ ] **C5.** "Create an assessment called 'MCP Test ASMT' using the assessment template with these requirements: \[a few bullets]." → Check Canvas: the description shows Franklin chrome + the assessment sections. Then: "Create a quick assignment called 'MCP Plain Test' with a one-line description." → description shows the default chrome wrap.

## D. Quiz loop (Classic Quizzes)

* [ ] **D1.** "Create a practice quiz about \[topic] with 3 multiple-choice questions." → Unpublished in Canvas.

* [ ] **D2.** "Show me that quiz." → `get_quiz` should return settings **and** all questions.

* [ ] **D3.** "Fix the typo in question 2" / "Delete question 3." → Verify both in Canvas. Note: on a published quiz with submissions, edits version the quiz — the tool description warns about this.

* [ ] **D4.** If any Franklin course uses **New Quizzes**: "List the quizzes in [that course]." → New Quizzes won't appear (documented limitation); confirm they show in `list_assignments` as external-tool items so nothing looks "lost."

## E. Module loop

* [ ] **E1.** "Create a module called 'MCP Test Module (Week 99)' and add the test assignment to it." → Draft module, item present.

* [ ] **E2.** "Rename the module" → "Retitle/move the item" (`update_module_item`) → "Remove the item" → "Delete the module." → After `delete_module`, confirm the assignment itself **still exists** (structure-only deletion).

## F. Pages regression

* [ ] **F1.** "Create a lesson page for [course] about [topic]." → Franklin template chrome applied, unpublished, `edit_page_content` still works. (Regression check — pages weren't supposed to change.)

## G. Discussions FERPA (highest-scrutiny check)

* [ ] **G1.** On a **real discussion with student replies**: "Show me the discussion '[title]' with the responses." → Every student name is `Student N` — including **inside message bodies** where students mention each other by name. Your own posts keep your real name. The response carries the scrub warning.

* [ ] **G2.** Cross-check: "List the students in this course." → The pseudonym for a given student should be **consistent** between the roster and the discussion (shared map).

* [ ] **G3.** "Create a discussion called 'MCP Test Discussion'." → Unpublished draft. Edit it, then delete it (`delete_discussion`).

* [ ] **G4.** Try `update_discussion` against an **announcement's** topic id. → Expect a refusal pointing to `update_announcement`.

## H. Announcements guard (the never-auto-publish edge case)

* [ ] **H1.** "Create an announcement for tomorrow at 8am telling families about [x]." → Summary echoes the exact go-live time; Canvas shows it **scheduled**, not visible to students; no immediate post.

* [ ] **H2.** "Post an announcement in 10 minutes." → Rejected, error names the 30-minute floor.

* [ ] **H3.** Give a time **without a timezone** ("2026-09-01T08:00:00"). → Rejected with the offset explanation.

* [ ] **H4.** Move the scheduled time (`update_announcement`), then delete it (`delete_announcement`) before it fires. → Gone from Canvas.

* [ ] **H5.** "List the announcements in this course." → Includes both past posts and your scheduled one (no hidden 14-day window).

## I. Grading (use a low-stakes assignment)

* [ ] **I1.** Bulk grade with **`dry_run: true`** first on a real assignment. → Inspect the would-be payloads; nothing written.

* [ ] **I2.** Grade **one** student for real (`grade_submission` with a comment). → Verify in SpeedGrader: grade + comment landed on the **latest attempt**.

* [ ] **I3.** Rubric-grade one submission (`grade_with_rubric`). → Per-criterion points and comments appear correctly in SpeedGrader.

* [ ] **I4.** Run a small real bulk grade (3–5 students) **by course code, not id**. → Watch stderr/network: exactly one course-list fetch, not one per student.

## J. De-anonymization gate

* [ ] **J1.** Without `CANVAS_MCP_ALLOW_DEANONYMIZE` set, ask: "Show me the real student names for these submissions." → Names **stay pseudonymized** and the response carries the override warning.

* [ ] **J2.** (Optional) Set `CANVAS_MCP_ALLOW_DEANONYMIZE=true` in the server env, restart, repeat. → Real names appear only now. Unset it afterward.

## K. Scale & latency feel

* [ ] **K1.** Biggest course, biggest assignment: `list_submissions`. → Completes, no truncation warnings, session stays healthy.

* [ ] **K2.** Create a page **using the course code** (not id) in your biggest-enrollment term. → Any noticeable lag? Code-identifier writes now walk the full course list; if it feels slow, note it (candidate for per-invocation memoization).

***

**Pass = every box checked with no FERPA leak, no wrong-course write, no immediately-visible announcement.** Then: `npm run build:mcpb`, install the artifact fresh, spot-check A1 + G1 + H1 once more through the packaged build, and distribute via GitHub Releases.