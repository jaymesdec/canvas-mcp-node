# Canvas for Claude

A drop-in extension that lets Claude actually *do things* in your Canvas LMS — grade submissions, draft lesson pages, build entire modules, find that one rubric you can't remember the name of — instead of just talking about doing them.

Built by a teacher. Designed for teachers. **No coding required.**

> 📥 **[Download the installer](https://github.com/jaymesdec/canvas-mcp-node/releases/latest)** • [The companion skills](https://github.com/jaymesdec/canvas-mcp-skills) • [Get help](https://github.com/jaymesdec/canvas-mcp-node/issues/new)

---

## What you can actually do with this

Once it's installed, you can ask Claude things like:

> *"Draft a lesson page on the water cycle for DSGN 9. Students will diagram a local watershed and explain evapotranspiration."*
>
> *"Grade every submission for the Watershed Quiz. Full credit for naming all three stages, minus 3 for each missing."*
>
> *"Plan Module 5 of FSV 117 — AI ethics, 4 weeks, weeks 8–11."*
>
> *"Find the student 'Ricci' across all my courses — which classes is she in?"*
>
> *"Show me every assignment in DSGN 9 that uses a rubric. Which competencies do the rubrics cover?"*
>
> *"Download every PDF submission for the watershed test so I can flip through them locally."*

Claude does the Canvas API calls. **You review and approve everything before it goes live.**

---

## What stays safe (we mean it)

This tool talks to Canvas with your full admin credentials. Three things we lock down hard:

### Real student names don't reach Claude

Every list of students comes back as `Student 1`, `Student 2`, `Student 3` — every time. Teachers, TAs, and admins always come through by name. The pseudonyms are **stable across weeks and across conversations**, so longitudinal artifacts (narratives, council reviews, portfolios) reference the same `Student 7` in March that they did in October.

If you genuinely need real names for something (looking up a Canvas user_id by name, for instance), there's a server-side env flag you have to flip yourself. Claude *can't* flip it from a tool call, even if asked.

### Nothing publishes itself

- Canvas pages → created as **drafts**, every time
- Canvas modules → created **unpublished**, every time
- Grades → written but anchored to your assignment's posting policy. If posting is manual, grades stay hidden until you click Post Grades

The MCP physically can't bypass these — they're enforced at the server level, not just suggested in skill prompts. **You** publish things. Always.

### Your Canvas token stays on your laptop

It's only ever sent to your school's Canvas host. It's never sent to Anthropic, never sent anywhere except your school's `instructure.com` (or wherever your Canvas lives). Treat it like any other admin password and rotate periodically (Canvas → Account → Settings → expire old token, generate a new one, re-run the install dialog).

---

## Install in 3 minutes (no terminal needed)

1. **Download** the latest installer: [canvas-mcp-X.Y.Z.mcpb](https://github.com/jaymesdec/canvas-mcp-node/releases/latest) (the `.mcpb` file in the latest release's assets).
2. **Double-click** the downloaded file. Claude Desktop opens an install dialog.
3. **Fill in the prompts:**
   - **Canvas URL** — your school's Canvas, like `https://franklinjc.instructure.com`.
   - **Canvas access token** — get one from Canvas → Account → Settings → "+ New Access Token". Copy it, paste it into the dialog. It's stored locally.
   - **Allow real student names** — leave as `false` unless you need it.
   - **School config** — Franklin teachers: leave the default. Other schools: see [School Configuration](#for-other-schools) below.
4. **Restart Claude Desktop.** Done.

Need to update? Download the new `.mcpb` from the latest release and double-click. Existing settings carry over.

---

## Your first try

Open Claude Desktop and ask:

> *"List my Canvas courses."*

You should see your courses. That confirms everything's working. Now go bigger:

> *"Plan a lesson on the water cycle for DSGN 9 — about watershed geography. Students will diagram a local watershed."*

Claude (with the `plan-lesson` skill installed — see below) will walk you through it: confirm the course, propose lesson content matching your school's lesson template, surface which competencies it aligns with, and create the draft page in Canvas.

---

## The skills (this is where it gets fun)

The MCP gives Claude the *ability* to do things in Canvas. The [**canvas-mcp-skills**](https://github.com/jaymesdec/canvas-mcp-skills) repo gives Claude the *judgment* to do them well, following pedagogical patterns, school conventions, and reasonable defaults.

Skills included so far:

- **plan-lesson** — draft a single lesson page following the school's lesson template
- **plan-assessment** — draft a test / quiz / project / essay / presentation page with grade boundaries and AI-use policy
- **plan-module** — draft a whole module: outcomes, lessons in sequence, summative assessment
- **plan-course** — draft a whole course's module sequence + foundational pages
- **grade-submissions** — grade an entire assignment with teacher review

Install instructions are in the [skills repo README](https://github.com/jaymesdec/canvas-mcp-skills#install). It's a `git clone` + `ln -s` or a `cp`; a couple minutes.

---

## For other schools

Built at Franklin School (Jersey City, NJ), but every school-specific piece — the competency framework, the lesson and assessment page templates, the module naming convention — lives in a single JSON config file. Other schools fork it.

**To use this at your school:**

1. Copy `configs/example.json` from the unpacked `.mcpb` (or from this repo).
2. Edit it for your competencies (your school's "21st Century Skills" or "Habits of Mind" or whatever) and your page template HTML.
3. In the install dialog, point the **School config** field at your edited file.
4. Restart Claude Desktop.

Full guide: [`docs/SCHOOL_CONFIG.md`](docs/SCHOOL_CONFIG.md).

---

## Going deeper

- **[Every tool Claude can call](docs/REFERENCE.md)** — full tool catalog with parameters, behavior notes, security model, troubleshooting, architecture
- **[School configuration guide](docs/SCHOOL_CONFIG.md)** — how the school JSON works, what fields are available, how to add page templates, how to extend it later
- **[Migration guide](docs/MIGRATION.md)** — for teachers moving from the Python `canvas-mcp-fork` to this version
- **[Contributor notes](CLAUDE.md)** — invariants, code structure, the never-publish rule, the FERPA gate, how to add a new tool

---

## Need help?

- **Something not working?** Open an issue: [github.com/jaymesdec/canvas-mcp-node/issues](https://github.com/jaymesdec/canvas-mcp-node/issues/new)
- **Want to know what's possible?** Just ask Claude — *"what can the Canvas MCP do?"* — it'll list the tools and walk through use cases.
- **Want to contribute or fork?** The whole thing is MIT-licensed. PRs welcome.

---

Made by **Jaymes Dec @ Franklin School, Jersey City, NJ.**
