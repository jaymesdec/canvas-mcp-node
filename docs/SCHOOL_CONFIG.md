# School configuration

This guide is for **anyone setting up canvas-mcp for a school other than Franklin** — or for Franklin folks who want to understand how the school-specific bits are wired.

For the teacher-facing intro, see [`../README.md`](../README.md). For the full tool reference, see [`REFERENCE.md`](REFERENCE.md).

---

## The big idea

The MCP core is **generic by design.** It knows how to talk to Canvas — pagination, authentication, error handling, FERPA anonymization, the never-publish rule, etc. — and it knows *nothing* about your school.

Everything school-specific lives in **one JSON file**: your competency framework, your page templates (the HTML wrapper that goes around every lesson page, assessment page, module outcomes page), your academic calendar conventions. You point the MCP at this file via the `SCHOOL_CONFIG` env var (or the install dialog's "School config" field).

The Franklin preset is just a config file at `configs/franklin.json`. Other schools fork it.

**There is no Franklin-specific code path.** Franklin is just a config preset that happens to ship in-repo.

---

## How to use the Franklin preset

You're a Franklin teacher and you just want everything to work.

1. Install the `.mcpb` from the [latest release](https://github.com/jaymesdec/canvas-mcp-node/releases/latest).
2. In the install dialog, leave the **School config** field as the pre-filled default. (It points at `${__dirname}/configs/franklin.json` inside the unpacked bundle.)
3. Restart Claude Desktop.

The server logs `[canvas-mcp] loaded school config: Franklin School (Jersey City, NJ)` to stderr on successful startup. Ask Claude `list_competencies` to confirm — you should see all 9 TD Competencies.

---

## How to write your own school config

You're at a different school. Here's the path.

### Step 1 — Copy `configs/example.json`

After installing the `.mcpb`, find the unpacked bundle at `~/Library/Application\ Support/Claude/Claude Extensions/local.mcpb.<your-id>.canvas-mcp/configs/example.json` (on macOS).

Copy it somewhere stable like `~/Documents/my-school-config.json`.

(Or grab `configs/example.json` from the [GitHub repo](https://github.com/jaymesdec/canvas-mcp-node/blob/main/configs/example.json) directly.)

### Step 2 — Edit it

The config has three sections (all optional — you can have a config with just one):

#### `schoolName` — for display purposes

```jsonc
"schoolName": "Lincoln High School (Springfield, MA)"
```

Surfaces in tool output summaries and the startup log line.

#### `competencyFramework` — your school's competencies

This drives `list_competencies` and competency-alignment suggestions in the planning skills.

```jsonc
"competencyFramework": {
  "name": "Lincoln High School Core Habits",
  "description": "What we want every Lincoln student to develop across their four years.",
  "competencies": [
    {
      "key": "critical_thinking",
      "name": "Critical Thinking",
      "description": "Analyzes evidence, identifies assumptions, evaluates claims."
    },
    {
      "key": "communication",
      "name": "Communication",
      "description": "Conveys ideas clearly in writing, speech, and other modalities."
    }
    // … one entry per competency
  ]
}
```

Each competency has:
- **`key`** — a short stable identifier. Keep it `snake_case` or `kebab-case`. Skills may someday reference these by key, so once you pick one, don't rename it.
- **`name`** — the display name. This is what Claude sees and uses in conversation.
- **`description`** — a sentence or two on what the competency means. Influences how Claude maps lessons/assessments to it.

Use however many competencies your school has — 3, 6, 9, 12, doesn't matter.

#### `academicCalendar` — your term conventions

```jsonc
"academicCalendar": {
  "weeksPerYear": 36,
  "termNames": ["Fall", "Spring"]
}
```

- `weeksPerYear` — informs default module sizing in the `plan-course` and `plan-module` skills.
- `termNames` — currently informational only; future skills may use it for term-aware planning.

Both fields are optional. Skip if your school doesn't have a clean week numbering, or if your terms don't fit a neat list.

#### `pageTemplates` — your institutional HTML for Canvas pages

This is the biggest section. Every page Claude creates wraps in one of these templates so the page looks like your school's standard layout.

See [Page templates](#page-templates) below for the full deep-dive.

### Step 3 — Point the install dialog at your file

When you install the `.mcpb` (or re-run the installer), in the **School config** field, pick the path to your edited JSON file. Replace the default Franklin path.

Restart Claude Desktop. Check the startup log — it should say `[canvas-mcp] loaded school config: <your school name>`.

### Step 4 — Test

Ask Claude:

> *"List the competencies for this school."*

If you see your competencies, the config loaded. If you see "no competency framework configured," the JSON didn't validate. Check Claude Desktop's MCP log for a validation error.

---

## Page templates

Schools often have a consistent institutional look for Canvas pages — Franklin wraps content in a school header/footer with a banner, school logo, and per-course nav strip; another school might use a different layout. **`create_page` automatically wraps the body in a configured template**, so every page Claude creates ships with your school's standard look without the teacher having to remember.

Templates are keyed by name in the school config under `pageTemplates`. Each template has:

- **`html`** — the template HTML with substitution tokens
- **`slots`** *(optional)* — named content holes used by multi-content templates like `lesson`
- **`sections`** *(optional)* — optional/conditional accordion sections with default include/omit state

### Example: minimal config

A generic single-content template plus a multi-slot lesson template:

```jsonc
{
  "pageTemplates": {
    "default": {
      "description": "Header-only generic wrap. Applied when no template is specified.",
      "html": "<div class=\"school-page\"><h1>{{title}}</h1>{{body}}</div>"
    },
    "lesson": {
      "description": "Lesson page with intro blocks and accordions.",
      "html": "<header>{{course_name}} — {{title}}</header><section>{{slot:about}}</section>...<!-- SECTION:discussion -->...{{slot:discussion}}...<!-- /SECTION:discussion -->",
      "slots": {
        "about":      { "description": "What students will learn about" },
        "discussion": { "description": "Discussion forum link (only when used)" }
      },
      "sections": {
        "discussion": { "default": "omit", "description": "Discussion accordion. Off by default — pass include_sections to add." }
      }
    }
  }
}
```

### Substitution tokens

The server fills these in before posting to Canvas:

| Token | Filled with |
|---|---|
| `{{title}}` | The page's title (HTML-escaped) |
| `{{body}}` | The `body` arg to `create_page` (legacy single-slot) |
| `{{slot:NAME}}` | The value at `slots[NAME]` in the call |
| `{{course_name}}` | Canvas `course.name`. Fetched only when the template references this token. (HTML-escaped.) |
| `{{course_id}}` | Numeric course id |
| `{{course_url}}` | `https://<your-canvas-host>/courses/<course_id>` |

### How `create_page` picks a template

```
create_page(body: "<p>Hello</p>")                           // → "default" template
create_page(body: "<p>x</p>", template: "lesson")           // → "lesson" template
create_page(template: "lesson", slots: {about: "...", ...}) // → multi-slot
create_page(body: "<p>x</p>", template: "none")             // → no wrap
```

### Optional sections (the `include_sections` / `omit_sections` mechanism)

Wrap conditional accordion blocks in `<!-- SECTION:name -->...<!-- /SECTION:name -->` markers. The config declares each section's default state:

- `default: "include"` → section is present unless `omit_sections: ["name"]` is passed
- `default: "omit"` → section is absent unless `include_sections: ["name"]` is passed

Section markers are stripped from the final HTML; their content is either kept (included) or removed (omitted). Section names that appear in `include_sections` / `omit_sections` but aren't declared in the config are silently ignored.

### Token-cost note

Template substitution runs **inside the MCP server**, not in Claude's context. The template HTML never enters the conversation — Claude passes slots + flags, the server wraps everything, posts to Canvas. **This keeps token cost flat regardless of how large the template is.** Symmetrically, `create_page` strips the body from its response (returning URL, slug, metadata, `template_applied`, `included_sections`, `omitted_sections`) so a freshly-wrapped page doesn't burn tokens on the way back.

### Discovering what's available

`list_page_templates` returns the configured templates with their slot names + descriptions and section names + defaults + descriptions. (Never the full HTML.) Skills call it to know what slots to fill and which sections might need to be toggled.

### Adding more templates

Any string key works (`"weekly_recap"`, `"unit_overview"`, etc.). The names `"default"`, `"lesson"`, `"assessment"`, and `"module_outcomes"` are conventions that the planning skills know to look for, but they're not required.

---

## Franklin reference templates

The bundled Franklin preset has four templates: `default` (placeholder for now), `lesson`, `assessment`, and `module_outcomes`. The schemas below are useful if you're forking the Franklin preset for another school.

### `lesson` template

**Slots** (all populated by the planning skill):

| Slot | Purpose |
|---|---|
| `about` | What students will learn about (1–2 sentence topic summary) |
| `to` | What skills students will gain (typically a bulleted list of can-do statements) |
| `concepts` | Key concepts and terms with brief definitions |
| `resources` | Links to readings, videos, websites, other materials |
| `tasks` | Tasks for students to complete during the lesson |
| `discussion` | Discussion forum link / prompt (only used when the section is included) |
| `assessment` | Link to a related assessment task |

**Sections** (override per-call with `include_sections` / `omit_sections`):

| Section | Default | When to toggle |
|---|---|---|
| `discussion` | omit | Include when the teacher mentions a discussion, debate, or forum prompt |
| `assessment` | include | Omit for purely formative lessons with no graded task to link |

**Per-course tokens** the lesson template uses: `{{course_name}}`, `{{course_url}}`, `{{title}}`. The course nav strip (Start Here, Syllabus, Modules, More Resources) is templated via `{{course_url}}` so the same template works across every course without re-uploading.

Example call from `plan-lesson`:

```
create_page(
  course_identifier: "DSGN_9_120251",
  title: "The Water Cycle",
  template: "lesson",
  slots: {
    about: "<p>The water cycle and watershed geography.</p>",
    to: "<ul><li>Diagram a local watershed</li><li>Explain evapotranspiration</li></ul>",
    concepts: "<p><strong>Watershed:</strong> ...</p>",
    resources: "<ul><li>USGS watershed tool</li></ul>",
    tasks: "<ol><li>Map your home watershed</li></ol>",
    assessment: "<p>See the watershed quiz, due Friday.</p>"
  }
)
```

To add a discussion accordion: pass `include_sections: ["discussion"]` and fill `slots.discussion`. The response includes `included_sections` and `omitted_sections` arrays so Claude can confirm what landed in the page.

**Updating an existing lesson page** — use `edit_page_content` with the same template machinery:

```
edit_page_content(
  course_identifier: "DSGN_9_120251",
  page_url: "the-water-cycle",
  template: "lesson",
  include_sections: ["discussion"],
  slots: {
    about: "...", to: "...", concepts: "...", resources: "...",
    tasks: "...", discussion: "<p>New discussion prompt</p>", assessment: "..."
  }
)
```

The body is rebuilt from the template in place — no duplicate page is created. You must provide ALL slots you want in the result, not just the ones that changed.

### `assessment` template

**Slots** (all required):

| Slot | Purpose |
|---|---|
| `description` | Top-level description of what the assessment is — intro paragraph plus a list of what students will do |
| `pre_work` | What students should have completed BEFORE taking the assessment |
| `structure_and_grading` | Three things in one slot: structure description (number of questions, points, etc.), grade weighting (what percent of trimester), and a grade boundaries table mapping A+ → F to point ranges |
| `submission` | How students submit (in-class paper, Canvas upload, etc.) |
| `time` | Time allotment — standard + extended-time accommodations |
| `ai_use` | Acceptable and unacceptable uses of AI for this specific assessment |

**Sections:** none — every block is required, no toggling.

**Per-course tokens:** `{{course_name}}`, `{{course_url}}`, `{{title}}` — same as the lesson template.

Note: the grade boundaries table HTML lives inside the `structure_and_grading` slot content, not the template itself. The planning skill generates an 11-row table (A+, A, A-, B+, B, B-, C+, C, C-, D, F) with point ranges based on the assessment's total points.

### `module_outcomes` template

**Slots:**

| Slot | Purpose |
|---|---|
| `outcomes` | An ordered-list of `<li>` items listing what students will be able to do by the end of the module. 4–8 outcomes typical. Each starts with an action verb (Design, Build, Evaluate, etc.) and maps to a competency where applicable. |

The `<ol id="kl_objective_list">` wrapper is part of the template — the slot only fills in the `<li>` items.

---

## Extending the schema (adding new school-driven data)

When a new piece of school-specific data emerges (e.g., a "default grading scale" or "department code" that the skills need to know about), the workflow is:

1. **Extend `SchoolConfigSchema`** in `src/schoolConfig.ts` with the new field (optional, zod-validated).
2. **Update `configs/franklin.json` and `configs/example.json`** with the new shape (Franklin gets real values, the example gets a documented placeholder).
3. **Read it from `schoolConfig`** in the tool or skill that consumes it; fall back to a generic default when the field is absent.
4. **Add tests** covering both the configured and unconfigured paths.

This keeps the generic-vs-Franklin split clean as the surface grows. Anything in the config is per-school; anything in `src/` outside of `schoolConfig.ts` consumers is generic and shared.

---

## What is *not* in the school config (intentionally)

These stay generic — they're either federal law, Canvas-API standard, or sensible defaults for any school:

- FERPA anonymization and the `CANVAS_MCP_ALLOW_DEANONYMIZE` gate
- Course-code preferred over numeric id in user-facing output
- `published: false` default on `create_page` / `create_quiz` / `create_module`
- Course-code → course-id cache and the bypass-on-write rule
- Anything Canvas-API specific (pagination, retry, error shapes)

If you find yourself tempted to put one of these in `schoolConfig.json`, push back — it's almost certainly a generic concern.
