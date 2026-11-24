# agent-skill-bundler

Port Claude Code skill plugins to other agent platforms. **Codex**,
**OpenCode**, and **Gemini CLI** are implemented targets; the pipeline is
target-agnostic (see *Adding another target*). Works on **any** standard Claude
plugin, and is *tuned* for this workspace's `*-forge` plugins — registered ones
get precise alias maps and **cross-plugin** reference rewriting (e.g.
`code-forge` → `spec-forge`) that a generic converter can't do.

Registered plugins (optional, for precision): `spec-forge`, `code-forge`,
`apcore-skills`, `theory-forge`, `research-forge`, `hype-forge` (see
`src/registry.ts`). Unregistered plugins convert via a generic auto-derived spec.

## Why not an existing tool?

These plugins share a structure that off-the-shelf converters mishandle:

- Heavy `@../shared/*.md` **cross-skill includes** — `cc2codex` drops the
  `skills/shared/` dir (dangling refs); `npx skills` / symlink tools don't
  transform at all.
- A plugin **namespace** (`spec-forge:`) with **bare, collision-prone** skill
  names (`idea`, `review`, `audit`) — Codex has no plugin namespace.
- Prose **cross-references** in Claude slash form (`/spec-forge:prd`), including
  references *between* plugins.

## Conversion model (Codex)

Each Claude plugin becomes a bundle dir whose flat sub-skills Codex discovers via
its recursive `**/SKILL.md` scan. **Codex auto-namespaces by the bundle dir**, so
a skill named `prd` under `spec-forge/` is exposed as `spec-forge:prd` — matching
the Claude form exactly. (Verified with `codex debug prompt-input`; an explicit
`spec-forge-` prefix would double up to `spec-forge:spec-forge-prd`.)

```
spec-forge/                  # orchestrator -> spec-forge:spec-forge
  idea/SKILL.md              # -> spec-forge:idea
  prd/SKILL.md               # -> spec-forge:prd   (alias: prd-generation -> prd)
  ...
  spec-forge-shared/         # relocated shared refs (only if referenced)
  .codex-plugin/plugin.json
```

Transform passes applied to **every** `.md` (SKILL.md + bundled `references/`):

1. **Inline external includes** — `@../shared/x.md` content is inlined (the file
   won't travel with a flat skill). Trailing section hints are preserved.
2. **Namespace identity** — directory **and** frontmatter `name` are the bare
   alias (no prefix); Codex supplies the `<ns>:` namespace from the bundle dir.
3. **Cross-reference rewrite** — `/spec-forge:prd` → `spec-forge:prd` (strip the
   slash; the colon form is the Codex skill name), across **all known
   namespaces** (cross-plugin refs included).
4. **Skill-path rewrite** — `../skills/review/SKILL.md` → `spec-forge:review`.
5. **Shared-path relocation** — prose lazy-load refs (`../shared/x.md`,
   theory-forge style) → a sibling `<ns>-shared/` dir with depth-aware relative
   paths (orchestrator / sub-skill / nested ref each differ).
6. **Subagent adaptation** — `Task(subagent_type="general-purpose")` → Codex's
   built-in `default` agent (see [Codex Subagents](https://developers.openai.com/codex/subagents));
   `general-purpose`→`default`, `prompt=<X>` hints preserved. Codex spawns
   subagents in isolated threads with summarized results — same semantics as
   Claude's Task tool, so this is near-lossless.
7. **Instructions merge** — frontmatter `instructions:` is folded into the body
   (Codex reads only `name` + `description` from frontmatter).
8. **Tool remap** — `AskUserQuestion` → "ask the user directly", etc.

## Conversion model (OpenCode)

OpenCode differs from Codex in three ways that shape the layout:

- skill IDs are **path-derived** (`<dir>/SKILL.md` → `<dir>`); frontmatter
  `name` is only a display label;
- there is **no plugin namespace**, so bare aliases collide across plugins;
- a directory containing `SKILL.md` is one skill — OpenCode **does not recurse
  inside it**. The Codex bundle layout would therefore expose only the
  orchestrator.

So an OpenCode bundle is *rootless* and prefix-named:

```
code-forge/                    # container: NO SKILL.md here
  code-forge/SKILL.md          # ID: code-forge (orchestrator)
  code-forge-plan/SKILL.md     # ID: code-forge-plan
  code-forge-build/SKILL.md    # ID: code-forge-build
  code-forge-shared/...
```

Transform differences:

- `/spec-forge:prd` → `spec-forge-prd` (the path-derived ID; `:` names do not
  exist in OpenCode).
- `Task(subagent_type="general-purpose")` → the `subagent` tool with the
  built-in `general` agent; `reviewer` / `spec-author` / `analyst` are emitted as
  OpenCode subagents and used when the delegation context names their role.
- Claude `commands/*.md` are converted too: `commands/<ns>/plan.md` → `/ns/plan`,
  and `commands/<ns>.md` → `/ns`. `$ARGUMENTS` / `$1` are preserved;
  Claude-only `allowed-tools` / `argument-hint` are dropped, and `model` is kept
  only when it is already `provider/model`. Command `@path` includes are inlined
  (OpenCode does not expand them).
- Custom agents are emitted as markdown (`agents/*.md`, `mode: subagent`).

Install locations:

```
~/.config/opencode/skills/<ns>        # copy of the bundle (re-install after reconvert)
~/.config/opencode/commands/<ns>      # copy of <out>/commands/<ns>
~/.config/opencode/commands/<ns>.md   # suite entry -> /<ns>
~/.config/opencode/agents/*.md        # copied subagents
```

OpenCode also scans the Codex compatibility dirs (`~/.agents/skills`,
`~/.claude/skills`). A Codex bundle installed there only registers its root
skill (the root `SKILL.md` blocks recursion); the prefixed OpenCode bundle in
`~/.config/opencode/skills` wins for the root ID and adds every sub-skill.

## Conversion model (Gemini CLI)

Gemini CLI discovers skills **1 directory deep only** under `~/.gemini/skills/`
(nested subdirectories like `<ns>/<skill>/SKILL.md` are ignored) and has no
plugin namespace for skills. So a Gemini bundle uses the same rootless,
prefixed structure on disk as OpenCode, and `install` copies each skill dir
**flat** into `~/.gemini/skills/`:

```
~/.gemini/skills/code-forge/SKILL.md          # orchestrator
~/.gemini/skills/code-forge-plan/SKILL.md     # sub-skill
~/.gemini/skills/code-forge-plan/references/code-forge-shared/...
~/.gemini/commands/code-forge/plan.toml       # -> /code-forge:plan
~/.gemini/commands/code-forge.toml            # -> /code-forge
~/.gemini/agents/*.md                         # custom subagents (name + description)
```

Transform differences:

- Skill references such as `/spec-forge:prd` become prefixed skill names
  such as `spec-forge-prd`. References to commands keep their Gemini slash names.
- A skill without `description` uses the first nonempty line of its body.
  The output uses portable skill metadata with a `name` matching its directory.
- A plugin-root `SKILL.md` uses the plugin namespace as its Gemini skill ID.
  If it requires manual invocation, the command uses `/<ns>`.
- `disable-model-invocation: true` becomes a user-invoked TOML command. A
  compatible suite command can also supply the orchestrator skill's workflow.
- Claude tools map to Gemini CLI built-ins: `AskUserQuestion` → `ask_user`,
  `TodoWrite` → `write_todos`, `WebFetch` → `web_fetch`, `WebSearch` →
  `google_web_search`.
- `Agent(subagent_type="general-purpose")` and older `Task(...)` → `generalist` (and `explore` →
  `codebase_investigator`), with role routing to `reviewer` / `spec-author` /
  `analyst` emitted as `~/.gemini/agents/*.md` (`name` + `description`
  frontmatter).
- Claude command Markdown and manifest commands become TOML commands.
  `commands/<ns>/plan.toml` registers `/ns:plan`, and `commands/<ns>.toml`
  registers `/ns`. Gemini supports nested command groups.
- Skill instructions use the arguments from the latest user request. Custom
  commands interpolate the full `$ARGUMENTS` as `{{args}}`. Static Claude
  shell injections in commands use Gemini's `!{...}` processor, which requests
  confirmation at invocation. Command Markdown includes and shared documents
  are inlined. Skill resources are placed inside the skill directory so Gemini
  can read them after activation.

Gemini does not have direct equivalents for Claude's `context: fork`,
per-skill hooks and restrictions, positional and named interpolation, or
most Claude runtime variables. Conversion reports the source and the
unsupported behavior. `--no-strict` keeps compatible output and excludes
entries that require manual migration.

## Self-enforced gates (no half-product)

`convert` exits non-zero if any bundle violates a gate:

- **A** — no unresolved external `@../` include remains.
- **B** — no leftover Claude-style **slash** ref (`/<ns>:<skill>`) remains in Codex or OpenCode (the
  bare `<ns>:<skill>` colon form is the correct Codex name and is allowed).
- **B2** — prefix targets (OpenCode): no leftover bare `<ns>:<skill>` colon ref
  either; the only valid form is `<ns>-<skill>`.
- **C** — every skill's directory name equals its frontmatter `name`.
- **D** — shared resource references resolve. Gemini validates the source
  before embedding the reference or copying the resource into a skill.
- **E** — rootless targets (OpenCode and Gemini): the bundle root has no
  `SKILL.md`. The entry skill, when present, is a child directory.

Non-fatal **warnings** surface source-side issues the conversion can't fix:
dangling cross-refs (`spec-forge:feature`), ambiguous cross-plugin bare paths,
and any unadapted `Task(...)` form (safety net — should be zero).

## Custom agents (optional, tunable)

Beyond the built-in `default`, the Codex target defines a few tuned agents
(`reviewer`, `spec-author`, `analyst`) emitted as `<out>/.codex/agents/*.toml`.
`adaptSubagents` routes a delegation to one of them when its context names a
role skill — via the exact `prompt=<X launch prompt>` hint, or a `:skill` /
`-skill` token in the surrounding lines — otherwise it falls back to `default`.
`install` copies these to `~/.codex/agents/`. The agent set and the keyword
`roleRules` live in `src/targets.ts` and are meant to be edited.

Routing is a best-effort heuristic: a delegation that only inlines a role
description (no skill token) falls back to `default`, which is still correct —
the prompt itself drives the behaviour; the custom agent only adds tuning.

## Usage

```bash
npm install && npm run build

# convert one or more plugins (gates enforced)
agent-skill-bundler convert ../spec-forge ../code-forge ../apcore-skills --out ./out/codex
agent-skill-bundler convert ../spec-forge ../code-forge --target opencode
agent-skill-bundler convert ../spec-forge ../code-forge --target gemini

# verify a bundle actually loads in the target
agent-skill-bundler verify ./out/codex/spec-forge            # codex debug prompt-input
agent-skill-bundler verify ./out/opencode/code-forge         # static OpenCode scan check
agent-skill-bundler verify ./out/gemini/code-forge           # Gemini layout and YAML checks

# install a bundle (Codex symlinks; OpenCode copies nested; Gemini copies flat)
agent-skill-bundler install ./out/codex/spec-forge               # -> ~/.agents/skills/spec-forge
agent-skill-bundler install ./out/opencode/code-forge            # -> ~/.config/opencode/skills/code-forge
agent-skill-bundler install ./out/gemini/code-forge              # -> ~/.gemini/skills/code-forge*
agent-skill-bundler install ./out/codex/spec-forge --home /tmp/test
```

New Gemini bundles record their target and namespace in
`.agent-skill-bundler.json`. Keep sibling `commands/` and `agents/` directories
when moving the output. Older bundles use layout-based inference and can pass
`--target` explicitly.

Gemini installation records the files it owns. Reinstalling updates those
files and removes obsolete ones whose contents are unchanged. It reports
name conflicts before replacing files. Upgrading a bundled default agent also
updates its co-owners when the installed agent is unchanged. If an older
install predates ownership tracking, move the conflicting files out of the way
before reinstalling.
Codex and OpenCode replace the corresponding bundle entry on reinstall.

In Codex: restart, then `/skills` or name a skill, e.g. `spec-forge:prd`.

In OpenCode: config reloads automatically; use `/code-forge/plan`, or load a
skill by ID (`code-forge-plan`) or mention `@code-forge-plan`.

In Gemini CLI: run `/skills reload` and `/commands reload` (or restart); use
`/code-forge:plan` or let Gemini activate `code-forge-plan` via `activate_skill`.

## Verifying (three tiers)

1. **Gates** — `convert` fails on dangling includes / leftover slash refs /
   name mismatch / unresolved shared paths. (Output is well-formed.)
2. **Runtime discovery** — `agent-skill-bundler verify <bundle>` installs into a
   throwaway HOME and checks the target's discovery. For Codex it runs
   `codex debug prompt-input` (renders the model-visible prompt with **no model
   call, no cost**) and asserts every expected `<ns>:<skill>` was discovered.
   OpenCode has no equivalent prompt dump, so its verify mirrors the documented
   scan rules statically (root-level `*.md` + nested `SKILL.md`, stop at a
   `SKILL.md`, skip hidden/`node_modules`, six levels deep) and reports command
   entries. Gemini verifies the flat layout, required YAML fields and declared
   skill IDs offline, and checks the command count against the bundle metadata.
3. **Interactive** — `codex` → `/skills`, then invoke `spec-forge:prd` on a real
   task and watch it run. (End-to-end; this one calls the model.)

`npm test` runs golden tests (`test/fixtures/fixture-forge`) for regression
safety on the converter itself.

## Adding another target (Cursor, Windsurf, ...)

The core pipeline is target-agnostic; a target is data in `src/targets.ts`
(`skillsDir`, `commandsDir`, `commandFormat`, `nameStyle`, `layout`,
`skillsInstallFlat`, `toolRemap`, `expandsAtIncludes`, agent format).
`nameStyle` + `layout` are the two axes that matter: `namespace`/`bundle`
(Codex) vs `prefix`/`rootless` (OpenCode, Gemini).

## Scope

Unregistered plugins using the standard `.claude-plugin/plugin.json` and
`skills/<name>/SKILL.md` layout convert via a generic spec. Gemini also discovers
plugin-root skills and honors additional skill paths and command overrides
declared in the Claude manifest. **Registering** a plugin in
`src/registry.ts` is optional and adds precision — short alias maps (e.g.
`prd-generation` → `prd`) and recognition of its namespace inside *other*
plugins' cross-references. The six `*-forge` suites are registered.

## License

MIT © tercel
