# Personality Profiles

The eleven built-in personality profiles. Fully declarative — no runnables, no sandboxed JS, no
Core Rust: the plugin is a `contributes.output_styles[]` list pointing at eleven Markdown
files, plus one Store tab that browses whatever profiles the node has. Each agent chooses
its own profile in the agent editor.

## What an output style is

A style changes **how** an agent answers (role, tone, the default shape of a response)
by editing the system prompt for the turn. It does not change what the agent knows,
which tools it has, or which model runs.

A style is a Markdown file: YAML frontmatter, then the instructions that get appended
to the system prompt.

```markdown
---
name: ELI5
description: keep it simple pls
keep-coding-instructions: true
---

It's been a long day and my brain is fried, talk to me like I'm 5.
```

The format is byte-compatible with a [Claude Code output
style](https://code.claude.com/docs/en/output-styles), so a file copied out of
`~/.claude/output-styles` works here unchanged, and vice-versa.

### Frontmatter

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | file stem | Display name in the picker. |
| `description` | string | — | One-liner under the name in the picker. |
| `keep-coding-instructions` | bool | `false` | `true` appends the style **after** the agent's own base instructions, so both apply. `false` **replaces** them. |
| `force-for-plugin` | bool | `false` | Plugin-shipped styles only: apply automatically while the plugin is enabled. |

Unknown keys are preserved but ignored, so a style authored against a newer schema
degrades to "the fields we understand" instead of failing to load.

`keep-coding-instructions` binds to the **agent's base instructions** (the persona
text edited in the agent editor), and not to a block of built-in software-engineering
prose, because Ryu has none. `false` is right for a style that turns the agent into
something other than what it normally is; `true` is right when you are changing how it
talks while it keeps doing the same work.

Everything downstream of the style is untouched either way: skills, long-term memory,
tool descriptions and the MCP preamble are assembled after it and never depend on it.

The body is prose, never code — nothing in the pipeline evaluates it, which is why a
style needs no capability grants at all. Same argument themes make.

## The eleven

None of them is forced. An agent defaults to its own instructions and tone, so this
plugin is inert until a profile is assigned to an agent.

| Style | `keep-coding-instructions` | What it does |
| --- | --- | --- |
| **ELI5** | `true` | Small words, short sentences, 2 options max on a decision. Paths and commands stay exact. |
| **I have ADHD** | `true` | Action first, numbered steps, state restated every turn, no preamble and no closers. |
| **Explanatory** | `true` | Short `Insight:` asides on the choices behind the code, interleaved with the work rather than lectured at the end. |
| **Learning** | `true` | Leaves one `TODO(human)` per response (a small strategic piece with a real decision in it) for you to write. |
| **Proactive** | `true` | Takes the conventional default and states the assumption instead of pausing for a routine question. Still stops for destructive or genuinely ambiguous work. |
| **Plain text** | `false` | No headers, bullets, bold or backticks — prose for pasting into an email, a commit message, or a chat that does not render markdown. Code blocks are the one exception. |
| **Plain Technical** | `true` | Simplified Technical English (ASD-STE100) — sentences under 20 words, one meaning per word, instructions as numbered commands. Paths, commands, error strings and numbers stay verbatim. |
| **No AI slop** | `true` | The named AI-writing patterns (puffery, colon reveals, faux-insight setups, recap endings, the mic-drop last line) kept out of the answer as it is written. Exact text (code, identifiers, error strings, paths) is exempt from the word list. |
| **No Hype** | `true` | Facts, evidence, uncertainty and tradeoffs in neutral language. No praise, sales language, superlatives, artificial urgency or unsupported claims of success. |
| **Bro** | `false` | Plain human speech: no jargon, no preamble, short blunt sentences, bad news first. File names, commands, error strings and numbers stay exact. |
| **Gen Z** | `false` | The same answer in gen z vernacular — casual, lowercase, low ceremony. |

**No AI slop** shares its rules with the `@ryu/no-ai-slop` plugin (both adapted from
[petergyang/no-ai-slop](https://github.com/petergyang/no-ai-slop)), and the two are
complementary rather than redundant. The style is prevention: it costs one prompt block
and shapes the answer while it is being written. The plugin is review: after the turn it
sends the finished answer to a separate agent with a fresh context, which names the
patterns it actually finds, and the agent rewrites. Prevention catches the habits;
review catches what survived them. Running both is fine.

**I have ADHD** is adapted, with thanks, from
[ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) (MIT). Upstream ships it as
a *skill*, which means the agent decides per turn whether the task looks like one it
applies to. That is exactly wrong for a formatting need that does not come and go — so
it is an output style here, assigned once to an agent and applied to every turn until
you pick something else.

## Writing your own

Drop a `.md` file into your `output-styles/` directory and it shows up in the agent
editor's personality profile picker.
Four sources merge into one registry, later ones winning on an id collision:

| Source | Location | Writable |
| --- | --- | --- |
| Plugin | `contributes.output_styles[]` of an enabled plugin | no |
| User | `<claude-dir>/output-styles/*.md` | yes |
| Project | `<cwd>/.claude/output-styles/*.md` | yes |
| Managed | managed-settings `output-styles/*.md` | no |

`<claude-dir>` is resolved profile-aware, so under `bun dev` it is `~/.ryu-dev`, not
`~/.claude`. Project styles load from every `.claude/output-styles/` between the
working directory and the repo root, nearest wins.

The styles in this package are read-only, because they are part of a signed package.
Editing one in the UI forks it to your user root rather than mutating the package.

Some things that make a style work, learned writing these eleven:

- **Say what to do, not what not to do.** "Lead with the next action" beats "don't
  bury the answer" — a negative constraint leaves the shape unspecified.
- **Give the shape, not just the tone.** "Two or three sentences, at the moment the
  decision is made" survives a long conversation; "be educational" does not.
- **Name the exceptions.** Every style above that pushes hard in one direction also
  says where it stops. Without that, the style eventually does something stupid
  confidently.
- **Keep it under a page.** The body is prepended to every turn, so it is paid for on
  every message, and a long style dilutes itself.

## Authoring in files, not in JSON

`file` is the source form; `source` is the wire form. A style body is a real `.md`
file, and Core hydrates it into an inline `source` string at parse time, so every
consumer downstream sees only `source` and `ryu pack` inlines the file when bundling —
the body stays **inside** the signed surface. Never inline a style into `manifest.json`
by hand; the test below fails if you do.

`source` carries the whole file, frontmatter included, rather than a pre-split body
plus mirrored `name`/`description` manifest keys. One parser serves disk styles and
plugin styles alike, and the frontmatter stays the single source of truth for a style's
metadata.

The layout is flat (`output-styles/<slug>.md`, one segment deep, no subdirectories),
because the mirror script's vendoring glob and Core's path validator both depend on it.

## Store tab

`contributes.store_tabs[]` declares the **Personality Profiles** tab in the Store's
catalog group, sourced from `GET /api/output-styles`. It is browse-only because a
profile belongs to an agent; choose the profile from the agent editor instead. The
path is Core-relative: this plugin has no sidecar, so nothing is proxied through
`/api/ext/`, and the desktop renderer only fetches paths that pass its
`isCoreApiPath` check.

The tab lists every style on the node, not just the eleven here — a user or project style
appears alongside them and is selectable the same way.

## Tests

```bash
node --test plugins-store/plugins/output-styles/plugin.test.mjs
```

Pins the manifest ↔ disk bijection in both directions (a declared file that is missing,
and a style file no manifest row declares), the frontmatter each declared file must
parse into, and the no-inline-`source` rule.
