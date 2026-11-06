# agent-skill-bundler

Port Claude Code skill plugins to other agent platforms. **Codex** and
**OpenCode** are implemented targets; the pipeline is target-agnostic (see
*Adding another target*). Works on **any** standard Claude plugin, and is
*tuned* for this workspace's `*-forge` plugins — registered ones get precise
alias maps and **cross-plugin** reference rewriting (e.g. `code-forge` →
`spec-forge`) that a generic converter can't do.

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

## Self-enforced gates (no half-product)

`convert` exits non-zero if any bundle violates a gate:

- **A** — no unresolved external `@../` include remains.
- **B** — no leftover Claude-style **slash** ref (`/<ns>:<skill>`) remains (the
  bare `<ns>:<skill>` colon form is the correct Codex name and is allowed).
- **B2** — prefix targets (OpenCode): no leftover bare `<ns>:<skill>` colon ref
  either; the only valid form is `<ns>-<skill>`.
- **C** — every skill's directory name equals its frontmatter `name`.
- **D** — every relocated `<ns>-shared/...` reference resolves on disk.
- **E** — rootless targets (OpenCode): no `SKILL.md` at the bundle root (it
  would hide every sub-skill) and the orchestrator exists at `<ns>/SKILL.md`.

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

# verify a bundle actually loads in the target
agent-skill-bundler verify ./out/codex/spec-forge            # codex debug prompt-input
agent-skill-bundler verify ./out/opencode/code-forge         # static OpenCode scan check

# install a bundle (Codex symlinks; OpenCode copies so its scanner cannot miss it)
agent-skill-bundler install ./out/codex/spec-forge               # -> ~/.agents/skills/spec-forge
agent-skill-bundler install ./out/opencode/code-forge            # -> ~/.config/opencode/skills/code-forge
agent-skill-bundler install ./out/codex/spec-forge --home /tmp/test
```

`install` / `verify` infer the target from the bundle shape unless `--target`
is given: a root `SKILL.md` means Codex, `<ns>/SKILL.md` means OpenCode.
`install` replaces an existing `<ns>` entry in the target's skills dir (and the
matching command/agent entries), so re-running it after a reconvert is safe.

In Codex: restart, then `/skills` or name a skill, e.g. `spec-forge:prd`.

In OpenCode: config reloads automatically; use `/code-forge/plan`, or load a
skill by ID (`code-forge-plan`) or mention `@code-forge-plan`.

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
   entries. (Output layout is valid.)
3. **Interactive** — `codex` → `/skills`, then invoke `spec-forge:prd` on a real
   task and watch it run. (End-to-end; this one calls the model.)

`npm test` runs golden tests (`test/fixtures/fixture-forge`) for regression
safety on the converter itself.

## Adding another target (Gemini, OpenCode, ...)

The core pipeline is target-agnostic; a target is data in `src/targets.ts`
(`skillsDir`, `commandsDir`, `nameStyle`, `layout`, `toolRemap`,
`expandsAtIncludes`, agent format). `nameStyle` + `layout` are the two axes that
matter: `namespace`/`bundle` (Codex) vs `prefix`/`rootless` (OpenCode). Gemini,
for example, natively expands `@` includes and supports namespaced `.toml`
commands, so its target would set `expandsAtIncludes: true` and use a different
layout emitter.

## Scope

Works on **any** standard Claude plugin (`.claude-plugin/plugin.json` +
`skills/<name>/SKILL.md`): unregistered plugins convert via a generic
auto-derived spec (empty aliases, SKILL.md-presence skill detection,
own-namespace cross-ref rewriting). **Registering** a plugin in
`src/registry.ts` is optional and adds precision — short alias maps (e.g.
`prd-generation` → `prd`) and recognition of its namespace inside *other*
plugins' cross-references. The six `*-forge` suites are registered.

## License

MIT © tercel
