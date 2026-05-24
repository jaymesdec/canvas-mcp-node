---
title: Franklin page template chrome convention
date: 2026-05-24
category: conventions
module: school-config
problem_type: convention
component: tooling
severity: medium
related_components:
  - documentation
tags:
  - school-config
  - page-templates
  - franklin
  - canvas-pages
  - template-chrome
  - placeholder-hygiene
  - default-fallback
applies_when:
  - "Adding a new template to configs/franklin.json"
  - "Modifying an existing template's structural layout"
  - "Forking the school config for a different institution"
  - "Reviewing a PR that touches pageTemplates in any school config"
  - "Auditing what create_page produces for an unfamiliar page type"
---

# Franklin page template chrome convention

## Context

The Franklin school config at `configs/franklin.json` defines named page templates that wrap Canvas wiki pages with institutional HTML. Three templates were fully built and shared the same Franklin "chrome": a `kl_wrapper_3` outer div containing a banner (course name + page title), a logo image, and a 4-item course nav list. The `lesson`, `assessment`, and `module_outcomes` templates all derived from this header pattern and then added their own body structure (accordion panels, required blocks, ordered-list outcomes).

A fourth template named `default` existed in the config but had shipped as a TODO placeholder — a bare `<div class="franklin-page">` with a single `<h1>` and a `<main>` slot, no banner, no logo, no nav. This matters because `default` is the auto-applied fallback in `src/schoolConfig.ts:163`:

```ts
const name = templateName ?? "default";
```

Every Franklin page created by `create_page` without an explicit `template` argument was getting the placeholder chrome instead of the institutional Franklin look. Exit tickets, short reflection pages, announcements, and ad-hoc resource pages were all silently degraded — visually correct-looking in isolation, but inconsistent with every other Franklin page once a student saw them side-by-side. Because the `schoolConfig` loader only validates shape (zod) and not content semantics, the half-written template passed validation, shipped in the `.mcpb` installer, and ran in teachers' Claude Desktops without anyone noticing.

The v0.3.14 release replaced the placeholder with the real Franklin chrome, making `default` structurally consistent with the other three templates.

## Guidance

Every Franklin page template in `configs/franklin.json` MUST wrap its content in the shared chrome. Adding a new template means deriving from this header pattern, not inventing a parallel one. The structural skeleton is:

```html
<div id="kl_wrapper_3" class="kl_flat_sections kl_wrapper">
  <!-- 1. Banner: course name (left) + page title (right) -->
  <div id="kl_banner">
    <h2>
      <span id="kl_banner_left">{{course_name}}</span>
      <span id="kl_banner_right">{{title}}</span>
    </h2>
  </div>

  <!-- 2. Logo: Franklin School mark -->
  <div id="kl_banner_image">
    <img class="kl_image_full_width" src="<franklin logo url>" alt="Franklin School logo" />
  </div>

  <!-- 3. Navigation: 4-item course nav using {{course_url}} -->
  <div id="kl_navigation">
    <ul class="kl_nav_list_1">
      <li><a href="{{course_url}}/pages/start-here">Start Here</a></li>
      <li><a href="{{course_url}}/assignments/syllabus">Syllabus</a></li>
      <li><a href="{{course_url}}/modules">Modules</a></li>
      <li><a href="{{course_url}}/pages/more-resources">More Resources</a></li>
    </ul>
  </div>

  <!-- 4. Body: template-specific content goes here -->
  <div id="kl_page_body">{{body}}</div>
</div>
```

The four substitution tokens are fixed: `{{course_name}}`, `{{title}}`, `{{course_url}}`, and either `{{body}}` (freeform, as in `default`) or one or more `{{slot:NAME}}` tokens (named slots, as in `lesson` / `assessment` / `module_outcomes`). Sections 1-3 are identical across every template. Section 4 is where templates differ — `lesson` has 5 accordion slots, `assessment` has 6 required blocks, `module_outcomes` has an ordered list, `default` has a single `{{body}}`.

If you need to add a fifth template, copy sections 1-3 verbatim and only design section 4.

Corollary on placeholder hygiene: if a template's real content isn't ready, do NOT ship it as a TODO stub. Either omit the entry entirely (so any lookup throws when callers request it) or hold the PR until the real chrome is in place. A missing template fails loudly; a stub template fails silently every time it's auto-applied — and the auto-applied path is the most common one.

## Why This Matters

The Franklin chrome is the school's visual identity inside Canvas. A page that drops the banner, logo, or nav doesn't look like "a less-decorated Franklin page" — it looks like it belongs to a different course. Students who navigate from a lesson page (with chrome) to an exit ticket (without chrome) experience an unintentional context break, and the missing nav strips their primary way back to Start Here / Syllabus / Modules.

The `default` template is the auto-applied fallback when `create_page` is called without an explicit `template` argument. That means **there is no untemplated path** for a Franklin page — every page goes through some template, and the one most likely to be applied (because skills frequently omit the argument) is `default`. If `default` doesn't wear the chrome, the most common page on the site doesn't either. The chrome convention only works if every template participates.

The secondary lesson is about the school-config validation surface: zod validates structure but cannot tell whether template HTML is real content or stub. A half-written template passes the schema, gets bundled into the `.mcpb`, and runs in users' Claude Desktops. Until the loader grows a "is this template actually finished" check (e.g., reject any HTML containing `<!-- TODO`), the policy is: anything that isn't finished gets removed from `configs/franklin.json` entirely, not left in as a TODO.

## When to Apply

- **Adding a new template to `configs/franklin.json`** — derive sections 1-3 from the shared chrome, design only section 4.
- **Modifying an existing template's structure** — never touch sections 1-3 unless you're changing the chrome convention itself, in which case update all four templates in the same PR.
- **Forking the config for a different school** (`configs/<school>.json`) — establish that school's equivalent chrome (banner + identity mark + nav, or whatever the institutional pattern is) and apply it consistently across every template the school config defines. `configs/example.json` is the starting point.
- **Reviewing PRs that touch `pageTemplates`** in any school config — verify the chrome is intact and no template has shipped as a TODO/stub.
- **Auditing what `create_page` produces for an unfamiliar page type** — confirm the page rendered with the expected chrome; if it didn't, the template is wrong (or no template was applied).

## Examples

**Before** — the TODO placeholder that shipped as `default` and silently degraded every untemplated Franklin page:

```json
"default": {
  "description": "Header-only generic wrap for any Canvas wiki page that doesn't fit lesson/assessment.",
  "html": "<!-- TODO(franklin): replace with the real Franklin generic-page header HTML. -->\n<div class=\"franklin-page\">\n  <header class=\"franklin-page-header\">\n    <h1>{{title}}</h1>\n  </header>\n  <main class=\"franklin-page-body\">{{body}}</main>\n</div>"
}
```

No `kl_wrapper_3`, no banner, no logo, no nav — a template in name only.

**After** — the v0.3.14 `default` template, structurally identical chrome to `lesson` / `assessment` / `module_outcomes`, with a single `{{body}}` slot for freeform content:

```html
<div id="kl_wrapper_3" class="kl_flat_sections kl_wrapper">
  <!-- Banner -->
  <div id="kl_banner">
    <h2>
      <span id="kl_banner_left">{{course_name}}</span>
      <span id="kl_banner_right">{{title}}</span>
    </h2>
  </div>
  <!-- Logo -->
  <div id="kl_banner_image">
    <img class="kl_image_full_width" src="<franklin logo url>" alt="Franklin School logo" />
  </div>
  <!-- Navigation -->
  <div id="kl_navigation">
    <ul class="kl_nav_list_1">
      <li><a href="{{course_url}}/pages/start-here">Start Here</a></li>
      <li><a href="{{course_url}}/assignments/syllabus">Syllabus</a></li>
      <li><a href="{{course_url}}/modules">Modules</a></li>
      <li><a href="{{course_url}}/pages/more-resources">More Resources</a></li>
    </ul>
  </div>
  <!-- Body: freeform content for exit tickets, reflections, announcements -->
  <div id="kl_page_body">{{body}}</div>
</div>
```

The description was also updated from the vague "Header-only generic wrap..." to an enumeration of use cases (exit tickets, short reflection pages, announcements, ad-hoc resources) plus an explicit note that this template is auto-applied when `create_page` is called without an explicit `template` argument.

## Related

- `configs/franklin.json` — the four named templates (`lesson`, `assessment`, `module_outcomes`, `default`) that follow this convention
- `src/schoolConfig.ts:163` — where `templateName ?? "default"` makes `default` the auto-applied fallback
- `src/tools/pages.ts` — where `create_page` resolves the template name and applies the chrome
- `tests/tools/pages.test.ts` — uses isolated fixture configs (`templatedConfig`), which is the right pattern: it keeps the production `configs/franklin.json` swappable without breaking the test suite
- `configs/example.json` — the generic template that other schools fork; should be updated in lockstep with any chrome convention change
- `docs/SCHOOL_CONFIG.md` line 207 — the "`default` (placeholder for now)" note is now stale; the chrome convention should be referenced here
- `CLAUDE.md` line 25 — labels `pageTemplates` as "reserved"; this is stale, templates are now load-bearing
- Released as v0.3.14: https://github.com/jaymesdec/canvas-mcp-node/releases/tag/v0.3.14
