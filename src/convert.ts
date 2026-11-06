import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import {
  REGISTRY,
  KNOWN_NAMESPACES,
  resolvePlugin,
  aliasFor,
  targetSkillDir,
  targetSkillRef,
  targetRootRef,
  type PluginSpec,
} from './registry.js';
import { CODEX, type Target } from './targets.js';

export interface ConvertResult {
  ns: string;
  bundleDir: string;
  skills: string[];
  commands: number;
  inlined: number;
  bundledReads: number;
  crossRefs: number;
  subagents: number;
  violations: string[];
  warnings: string[];
}

/** Codex-visible skill names a plugin produces (for cross-ref validation). */
export function pluginSkillNames(
  pluginDir: string,
  target: Target = CODEX,
): { ns: string; names: Set<string> } {
  const pj = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  const ns = String((JSON.parse(read(pj)) as Record<string, unknown>)['name']);
  const spec = resolvePlugin(ns);
  const names = new Set<string>([targetRootRef(spec, target)]); // orchestrator root skill
  for (const d of listSkillDirs(path.join(pluginDir, 'skills'), spec)) {
    names.add(targetSkillRef(spec, target, d)); // <ns>:<alias> or <ns>-<alias>
  }
  return { ns, names };
}

// ---------- small fs / frontmatter helpers ----------

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}
function write(p: string, s: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
}
function exists(p: string): boolean {
  return fs.existsSync(p);
}
function listSkillDirs(skillsRoot: string, spec: PluginSpec): string[] {
  if (!exists(skillsRoot)) return [];
  return fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !spec.nonSkillDirs.includes(name))
    .filter((name) => exists(path.join(skillsRoot, name, 'SKILL.md')))
    .sort();
}

interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}
function splitFrontmatter(md: string): Frontmatter {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: md };
  return { data: (YAML.parse(m[1]) as Record<string, unknown>) ?? {}, body: m[2] };
}
function joinFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = YAML.stringify(data).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, '')}`;
}

// ---------- body transforms ----------

/** Replace Claude-specific tool tokens with target-appropriate wording. */
function remapTools(body: string, target: Target): string {
  let out = body;
  for (const [token, replacement] of Object.entries(target.toolRemap)) {
    out = out.replace(new RegExp(`\\b${token}\\b`, 'g'), replacement);
  }
  return out;
}

/**
 * Classify a delegation by its context window into a custom agent, matching a
 * role keyword only when it appears as a delegated-skill token (`:review`,
 * `-review`, `<review `) — never as a bare prose word like "§3.4 Scope".
 */
function classifyAgent(ctx: string, target: Target): string | null {
  for (const rule of target.roleRules) {
    for (const kw of rule.keywords) {
      if (new RegExp(`[:\\-<]${kw}\\b`).test(ctx)) return rule.agent;
    }
  }
  return null;
}

/** Exact skill-name -> custom agent (used when a prompt hint names the skill). */
function roleOfSkill(skill: string, target: Target): string | null {
  for (const rule of target.roleRules) {
    if (rule.keywords.includes(skill)) return rule.agent;
  }
  return null;
}

/**
 * Adapt Claude `Task(subagent_type="X")` delegation to the target's subagent
 * mechanism. For Codex this maps to its built-in/custom agents — isolated
 * threads with summarized results, same semantics as Claude's Task tool. See
 * developers.openai.com/codex/subagents. A delegation routes to a custom agent
 * when its context (current + next 2 lines) names a role skill; else falls back
 * to the built-in `default`.
 */
function adaptSubagents(body: string, target: Target): { body: string; count: number } {
  if (!target.subagentMap) return { body, count: 0 };
  const map = target.subagentMap;
  const fallback = target.defaultSubagent ?? 'default';
  let count = 0;
  const lines = body.split('\n');
  const taskRe = /Task\(subagent_type="([^"]+)"\s*(?:,\s*([^)]*))?\)/g;
  for (let i = 0; i < lines.length; i++) {
    if (!/Task\(subagent_type=/.test(lines[i])) continue;
    // Window spans a few lines each way to catch the delegated-skill reference,
    // which in chain orchestrators sits in a prompt block above or below the
    // launch line. The prompt-hint case below is exact and bypasses the window.
    const ctx = lines.slice(Math.max(0, i - 5), i + 7).join(' ');
    lines[i] = lines[i].replace(taskRe, (_m, kind: string, rest?: string) => {
      count++;
      const pm = rest?.match(/prompt=<([^>]+)>/);
      let agent: string;
      if (pm) {
        // prompt=<cite-audit launch prompt> → the skill name is unambiguous
        const skill = pm[1].replace(/\s+launch.*$/i, '').trim();
        agent = roleOfSkill(skill, target) ?? map[kind] ?? fallback;
      } else {
        agent = classifyAgent(ctx, target) ?? map[kind] ?? fallback;
      }
      // no backticks around the agent name — the source often wraps the whole
      // Task(...) token in backticks, and nested backticks break markdown.
      let s = target.subagentPhrase.replace('{agent}', agent);
      if (pm) s += ` using the ${pm[1]}`;
      return s;
    });
  }
  return { body: lines.join('\n'), count };
}

/** TOML basic-string escape. */
function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Emit the target's custom agents as `.codex/agents/*.toml` (Codex) or
 * `agents/*.md` (OpenCode).
 */
export function writeCustomAgents(outRoot: string, target: Target): string[] {
  if (!target.agentFormat || target.customAgents.length === 0) return [];
  const dir = path.join(outRoot, target.agentsOutDir);
  const ext = target.agentFormat === 'toml' ? 'toml' : 'md';
  const written: string[] = [];
  for (const a of target.customAgents) {
    let content: string;
    if (target.agentFormat === 'toml') {
      content =
        `name = ${tomlStr(a.name)}\n` +
        `description = ${tomlStr(a.description)}\n` +
        `developer_instructions = ${tomlStr(a.developer_instructions)}\n`;
      if (a.model_reasoning_effort) {
        content += `model_reasoning_effort = ${tomlStr(a.model_reasoning_effort)}\n`;
      }
    } else {
      // OpenCode: Markdown frontmatter + body. `mode: subagent` makes it
      // launchable through the subagent tool but not selectable as primary.
      const fm = YAML.stringify({
        description: a.description,
        mode: 'subagent',
      }).trimEnd();
      content = `---\n${fm}\n---\n\n${a.developer_instructions}\n`;
    }
    const file = path.join(dir, `${a.name}.${ext}`);
    write(file, content);
    written.push(file);
  }
  return written;
}

/**
 * Rewrite Claude slash-command cross-references into target-visible skill
 * mentions. A Claude slash command means "invoke this", which maps to:
 * - namespace targets: `$<ns>:<alias>` (Codex's mention syntax);
 * - prefix targets: the bare path-derived ID `<ns>-<alias>` (OpenCode), since
 *   they have no `:` namespace and `@` mentions are user-prompt syntax.
 * Bare prose refs (no slash) are left untouched.
 *   /spec-forge:prd  ->  $spec-forge:prd   |  spec-forge-prd
 *   /spec-forge      ->  $spec-forge:spec-forge | spec-forge
 *   spec-forge:prd   ->  spec-forge:prd    | unchanged prose reference
 */
function rewriteCrossRefs(
  body: string,
  namespaces: string[] = KNOWN_NAMESPACES,
  target?: Target,
): { body: string; count: number } {
  let count = 0;
  let out = body;
  const prefixStyle = target?.nameStyle === 'prefix';
  for (const ns of namespaces) {
    // slash + namespaced invocation: /spec-forge:prd -> $spec-forge:prd
    const sub = new RegExp(`/\\b${ns}:([a-z][a-z0-9-]*)`, 'g');
    out = out.replace(sub, (_m, token: string) => {
      count++;
      return prefixStyle ? `${ns}-${token}` : `$${ns}:${token}`;
    });
    // bare orchestrator invocation: /spec-forge -> $spec-forge:spec-forge
    const orch = new RegExp(`/${ns}(?![\\w:-])`, 'g');
    out = out.replace(orch, () => {
      count++;
      return prefixStyle ? ns : `$${ns}:${ns}`;
    });
    // prefix targets have no `:` namespace, so bare colon refs are invalid too:
    // code-forge:plan -> code-forge-plan
    if (prefixStyle) {
      const bare = new RegExp(`\\b${ns}:([a-z][a-z0-9-]*)`, 'g');
      out = out.replace(bare, (_m, token: string) => {
        count++;
        return `${ns}-${token}`;
      });
    }
  }
  return { body: out, count };
}

/**
 * Rewrite intra-plugin path references like `../skills/review/SKILL.md` or
 * `skills/prd-generation/SKILL.md` into the target's skill name, since that
 * file layout no longer exists in the flattened bundle.
 */
function rewriteSkillPaths(
  body: string,
  spec: PluginSpec,
  currentSkills: Set<string>,
  target: Target,
): { body: string; count: number } {
  let count = 0;
  const out = body.replace(
    /(?:\.\.\/)*skills\/([a-z][a-z0-9-]*)\/SKILL\.md/g,
    (m, dir: string) => {
      // Only rewrite refs to THIS plugin's own skills — a bare path to another
      // plugin's skill is ambiguous and left for the leftover-path warning.
      if (!currentSkills.has(dir)) return m;
      count++;
      return `\`${targetSkillRef(spec, target, dir)}\``;
    },
  );
  return { body: out, count };
}

/**
 * Rewrite prose lazy-load references to shared files (theory-forge style:
 * `../shared/x.md`, `shared/x.md`, `skills/shared/x.md`) into a sibling
 * `<ns>-shared/` dir that travels in the bundle. Skips `@`-includes (handled by
 * inlining) and already-namespaced `<ns>-shared/` paths.
 */
function relocateSharedPaths(
  body: string,
  fileDir: string,
  bundleDir: string,
  ns: string,
  sharedDirs: string[],
): { body: string; count: number } {
  let count = 0;
  const alt = sharedDirs.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // rest must end in a word/slash char so trailing sentence punctuation
  // (e.g. "see shared/contract-spec.md.") is not swallowed into the path.
  const re = new RegExp(
    `(?<![\\w@/-])((?:\\.\\./)+|skills/)?(${alt})/([\\w/-]+(?:\\.[\\w/-]+)*)`,
    'g',
  );
  const out = body.replace(re, (_m, _pfx: string, dir: string, rest: string) => {
    count++;
    let base = path.relative(fileDir, path.join(bundleDir, `${ns}-${dir}`));
    if (base === '') base = '.';
    return `${base}/${rest}`;
  });
  return { body: out, count };
}

/**
 * Resolve `@path` include directives that sit on their own line.
 * - external (outside skillDir, e.g. ../shared/x.md): inline the file content.
 * - internal (inside skillDir, e.g. references/x.md): keep the bundled file,
 *   rewrite to an explicit read instruction (Codex reads bundled files).
 * - non-existent (placeholders like @source-doc.md): left untouched.
 */
function resolveIncludes(
  body: string,
  skillDir: string,
  target: Target,
  inlineInternal = false,
): { body: string; inlined: number; bundledReads: number } {
  let inlined = 0;
  let bundledReads = 0;
  const lines = body.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    // An include directive starts the line: `@<path>.md` optionally followed by
    // a parenthetical/section hint, e.g. `@../shared/conventions.md (see "X")`.
    const m = line.match(/^\s*@([./\w-]+\.md)\b(.*)$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const rel = m[1];
    const trailing = m[2].trim();
    const abs = path.resolve(skillDir, rel);
    if (!exists(abs)) {
      out.push(line); // placeholder example, not a real include
      continue;
    }
    const insideSkill = !path.relative(skillDir, abs).startsWith('..');
    if (insideSkill && !inlineInternal && !target.expandsAtIncludes) {
      const hint = trailing ? ` ${trailing}` : '';
      out.push(`> Read the bundled file \`${rel}\`${hint} for full details.`);
      bundledReads++;
      continue;
    }
    // external include -> inline (the file won't travel with the flat skill)
    if (trailing) out.push(`> Note: ${trailing}`);
    const content = read(abs).trim();
    const label = path.basename(rel);
    // marker uses the bare filename (not a path) so later path-rewrite passes
    // don't treat it as a live reference.
    out.push(`<!-- inlined: ${label} -->`);
    out.push(content);
    out.push(`<!-- /inlined: ${label} -->`);
    inlined++;
  }
  return { body: out.join('\n'), inlined, bundledReads };
}

/** Merge a frontmatter `instructions:` value into the body (Codex ignores it). */
function mergeInstructions(data: Record<string, unknown>, body: string): string {
  const instr = data['instructions'];
  delete data['instructions'];
  if (typeof instr !== 'string' || !instr.trim()) return body;
  const block = `> **Skill instructions:** ${instr.trim().replace(/\s+/g, ' ')}\n`;
  // insert right after the first H1 heading if present, else at the top
  const lines = body.split('\n');
  const h1 = lines.findIndex((l) => /^#\s+/.test(l));
  if (h1 === -1) return `${block}\n${body}`;
  lines.splice(h1 + 1, 0, '', block);
  return lines.join('\n');
}

// ---------- skill + orchestrator generation ----------

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

interface Stats {
  inlined: number;
  bundledReads: number;
  crossRefs: number;
  subagents: number;
}

/** Apply the full transform pipeline to one markdown file in place. */
function transformFile(
  destFile: string,
  srcDir: string,
  isRootSkillName: string | null,
  spec: PluginSpec,
  target: Target,
  currentSkills: Set<string>,
  bundleDir: string,
  namespaces: string[],
  stats: Stats,
): void {
  const { data, body: rawBody } = splitFrontmatter(read(destFile));
  const isRootSkill = isRootSkillName !== null;
  const sharedDirs = spec.sharedDirs ?? ['shared'];

  let body = isRootSkill ? mergeInstructions(data, rawBody) : rawBody;
  const inc = resolveIncludes(body, srcDir, target);
  body = inc.body;
  body = remapTools(body, target);
  const sa = adaptSubagents(body, target);
  body = sa.body;
  const cr = rewriteCrossRefs(body, namespaces, target);
  body = cr.body;
  const sp = rewriteSkillPaths(body, spec, currentSkills, target);
  body = sp.body;
  body = relocateSharedPaths(body, path.dirname(destFile), bundleDir, spec.ns, sharedDirs).body;
  stats.subagents += sa.count;

  // The frontmatter description is model-visible (Codex shows it in the skills
  // list) and can carry Claude slash refs / tool names too — transform it too.
  if (typeof data['description'] === 'string') {
    let d = remapTools(data['description'], target);
    d = adaptSubagents(d, target).body;
    d = rewriteCrossRefs(d, namespaces, target).body;
    d = rewriteSkillPaths(d, spec, currentSkills, target).body;
    d = relocateSharedPaths(d, path.dirname(destFile), bundleDir, spec.ns, sharedDirs).body;
    data['description'] = d;
  }

  if (isRootSkill) data['name'] = isRootSkillName;

  const hasFrontmatter = /^---\n/.test(read(destFile));
  write(destFile, hasFrontmatter || isRootSkill ? joinFrontmatter(data, body) : body);

  stats.inlined += inc.inlined;
  stats.bundledReads += inc.bundledReads;
  stats.crossRefs += cr.count + sp.count;
}

function convertSkill(
  spec: PluginSpec,
  target: Target,
  srcSkillDir: string,
  destSkillDir: string,
  currentSkills: Set<string>,
  bundleDir: string,
  namespaces: string[],
  stats: Stats,
): void {
  // copy the whole skill dir (brings references/, assets/ along)
  fs.cpSync(srcSkillDir, destSkillDir, { recursive: true });

  // transform EVERY markdown file, not just SKILL.md — bundled references/*.md
  // carry cross-refs, includes and tool tokens too.
  for (const destFile of listMarkdown(destSkillDir)) {
    const srcDir = path.dirname(path.join(srcSkillDir, path.relative(destSkillDir, destFile)));
    const isRoot =
      path.dirname(destFile) === destSkillDir && path.basename(destFile) === 'SKILL.md';
    transformFile(
      destFile,
      srcDir,
      isRoot ? path.basename(destSkillDir) : null,
      spec,
      target,
      currentSkills,
      bundleDir,
      namespaces,
      stats,
    );
  }
}

function generateOrchestrator(
  spec: PluginSpec,
  target: Target,
  pluginDir: string,
  bundleDir: string,
  skillDirs: string[],
  pluginJson: Record<string, unknown>,
  namespaces: string[],
  stats: Stats,
): void {
  const cmdFile = path.join(pluginDir, 'commands', `${spec.ns}.md`);
  // Rootless bundles keep the orchestrator one level down; shared-path
  // relocation must be relative to the file, not the container dir.
  const orchestratorDir =
    target.layout === 'rootless' ? path.join(bundleDir, spec.ns) : bundleDir;
  const rows = skillDirs
    .map((d) => `| \`${targetSkillRef(spec, target, d)}\` | ${aliasFor(spec, d)} |`)
    .join('\n');

  let body: string;
  if (exists(cmdFile)) {
    const { body: cmdBody } = splitFrontmatter(read(cmdFile));
    body = remapTools(cmdBody, target);
    const sa = adaptSubagents(body, target);
    body = sa.body;
    stats.subagents += sa.count;
    body = rewriteCrossRefs(body, namespaces, target).body;
    body = rewriteSkillPaths(body, spec, new Set(skillDirs), target).body;
    body = relocateSharedPaths(body, orchestratorDir, bundleDir, spec.ns, spec.sharedDirs ?? ['shared']).body;
  } else {
    body = `# ${spec.ns}\n\nOrchestrator for the ${spec.ns} skill suite.\n`;
  }

  const header =
    target.nameStyle === 'prefix'
      ? `# ${spec.ns}\n\n` +
        `Orchestrator entry point for the **${spec.ns}** suite. These skills have no ` +
        `plugin namespace; load a capability with the \`skill\` tool by its ID ` +
        `(or mention \`@<id>\`):\n\n` +
        `| Skill ID | Capability |\n|---|---|\n${rows}\n\n` +
        `When asked to run the full ${spec.ns} chain, follow the workflow below.\n\n---\n\n`
      : `# ${spec.ns}\n\n` +
        `Orchestrator entry point for the **${spec.ns}** suite. Codex namespaces these ` +
        `by bundle directory; invoke a capability by naming its skill (or via /skills):\n\n` +
        `| Codex skill | Capability |\n|---|---|\n${rows}\n\n` +
        `When asked to run the full ${spec.ns} chain, follow the workflow below.\n\n---\n\n`;

  const rawDesc = (pluginJson['description'] as string) ?? `${spec.ns} skill orchestrator`;
  const data: Record<string, unknown> = {
    name: spec.ns,
    description: rewriteCrossRefs(remapTools(rawDesc, target), namespaces, target).body,
  };
  // Rootless targets keep the bundle dir as a plain container: a SKILL.md at its
  // root would make the agent treat the whole bundle as one skill and stop
  // recursing, hiding every sub-skill.
  const dest =
    target.layout === 'rootless'
      ? path.join(bundleDir, spec.ns, 'SKILL.md')
      : path.join(bundleDir, 'SKILL.md');
  write(dest, joinFrontmatter(data, header + body));
}

// ---------- verification gates ----------

function verify(bundleDir: string, target: Target): string[] {
  const violations: string[] = [];
  const ns = path.basename(bundleDir);

  // Gate E: layout invariants. A rootless agent stops recursing at a SKILL.md,
  // so a bundle-root SKILL.md would hide every sub-skill.
  if (target.layout === 'rootless') {
    if (exists(path.join(bundleDir, 'SKILL.md'))) {
      violations.push(`${bundleDir}: SKILL.md at bundle root would hide every sub-skill`);
    }
    if (!exists(path.join(bundleDir, ns, 'SKILL.md'))) {
      violations.push(`${bundleDir}: missing orchestrator skill at ${ns}/SKILL.md`);
    }
  }

  const mdFiles: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) mdFiles.push(p);
    }
  };
  walk(bundleDir);

  for (const f of mdFiles) {
    const md = read(f);
    const { data, body } = splitFrontmatter(md);
    const isRootSkill = f === path.join(bundleDir, 'SKILL.md');
    const isSkillMd = path.basename(f) === 'SKILL.md';

    // Gate A: no unresolved external includes (any .md)
    if (/^\s*@\.\.\//m.test(body)) {
      violations.push(`${f}: unresolved external @../ include remains`);
    }
    // Gate B: no leftover Claude SLASH-command refs anywhere in the file
    // (frontmatter description included — Codex shows it). The bare
    // `<ns>:<skill>` colon form is the correct Codex name and is allowed.
    for (const ns of KNOWN_NAMESPACES) {
      if (new RegExp(`/\\b${ns}:[a-z*]`).test(md)) {
        violations.push(`${f}: leftover Claude-style slash ref "/${ns}:..."`);
        break;
      }
    }
    // Gate B2 (prefix targets): the bare `<ns>:<skill>` colon form is valid in
    // Codex but is not a skill ID in a namespace-less target.
    if (target.nameStyle === 'prefix') {
      for (const ns of KNOWN_NAMESPACES) {
        if (new RegExp(`\\b${ns}:[a-z][a-z0-9-]*`).test(md)) {
          violations.push(`${f}: leftover colon ref "${ns}:..." (prefix target)`);
          break;
        }
      }
    }
    // Gate C: skill dir name == frontmatter name (per-skill SKILL.md only)
    if (isSkillMd && !isRootSkill) {
      const dirName = path.basename(path.dirname(f));
      if (data['name'] !== dirName) {
        violations.push(
          `${f}: frontmatter name "${String(data['name'])}" != dir "${dirName}"`,
        );
      }
    }
    // Gate D: every relocated `<ns>-shared/...` reference resolves on disk
    const reShared = new RegExp(
      `(?<![\\w@])((?:\\.\\./)+|\\./)?${ns}-shared/([\\w/-]+(?:\\.[\\w/-]+)*)`,
      'g',
    );
    for (const m of body.matchAll(reShared)) {
      const tgt = path.resolve(path.dirname(f), m[0]);
      if (!exists(tgt)) violations.push(`${f}: relocated shared ref "${m[0]}" does not resolve`);
    }
  }
  return violations;
}

// ---------- public entry ----------

/** Scan a bundle for target-style refs that resolve to no known skill. */
function findUnresolvedRefs(
  bundleDir: string,
  known: Map<string, Set<string>>,
  target: Target,
): string[] {
  const unresolved = new Set<string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        const text = read(p);
        for (const [ns, names] of known) {
          // Prefix targets have no `:`; match `<ns>-<id>` but not the
          // `<ns>-shared/` path that travels with the bundle.
          const re =
            target.nameStyle === 'prefix'
              ? new RegExp(`\\b(${ns}-[a-z][a-z0-9-]*)(?![a-z0-9-]|/)`, 'g')
              : new RegExp(`\\b(${ns}:[a-z][a-z0-9-]*)`, 'g');
          let m: RegExpExecArray | null;
          while ((m = re.exec(text))) {
            if (!names.has(m[1])) unresolved.add(m[1]);
          }
        }
      }
    }
  };
  walk(bundleDir);
  return [...unresolved].sort();
}

/**
 * Convert Claude slash commands (`commands/*.md`) into target command files.
 * OpenCode scans every `.md` file under `<commandsDir>` and names them by
 * relative path, so `<out>/commands/<ns>/plan.md` installs to
 * `~/.config/opencode/commands/<ns>/plan.md` and runs as `/ns/plan`. Claude's
 * `$ARGUMENTS` and `$1` placeholders are unchanged. The suite entry
 * `commands/<ns>.md` becomes `/ns`.
 */
function convertCommands(
  spec: PluginSpec,
  target: Target,
  pluginDir: string,
  outRoot: string,
  currentSkills: Set<string>,
  namespaces: string[],
  stats: Stats,
): { count: number; warnings: string[] } {
  const warnings: string[] = [];
  const srcDir = path.join(pluginDir, 'commands');
  if (!target.commandsDir || !exists(srcDir)) return { count: 0, warnings };

  const sharedDirs = spec.sharedDirs ?? ['shared'];
  const bundleDir = path.join(outRoot, spec.ns);
  const names = fs
    .readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();

  let count = 0;
  const dropped = new Map<string, number>();
  for (const name of names) {
    const src = path.join(srcDir, name);
    const { data, body: rawBody } = splitFrontmatter(read(src));
    const cmdName = name.replace(/\.md$/, '');
    const dest =
      cmdName === spec.ns
        ? path.join(outRoot, 'commands', name)
        : path.join(outRoot, 'commands', spec.ns, name);
    const destDir = path.dirname(dest);

    // Command templates do not expand @path and travel as standalone files, so
    // every real include is inlined (internal ones included).
    let body = resolveIncludes(rawBody, srcDir, target, true).body;
    body = remapTools(body, target);
    const sa = adaptSubagents(body, target);
    body = sa.body;
    stats.subagents += sa.count;
    body = rewriteCrossRefs(body, namespaces, target).body;
    body = rewriteSkillPaths(body, spec, currentSkills, target).body;
    body = relocateSharedPaths(body, destDir, bundleDir, spec.ns, sharedDirs).body;

    // Keep only frontmatter OpenCode understands; Claude-only fields are dropped.
    const out: Record<string, unknown> = {};
    if (typeof data['description'] === 'string') {
      let d = remapTools(data['description'], target);
      d = rewriteCrossRefs(d, namespaces, target).body;
      d = rewriteSkillPaths(d, spec, currentSkills, target).body;
      out['description'] = d;
    }
    for (const key of ['agent', 'subagent', 'subtask']) {
      if (key in data) out[key] = data[key];
    }
    if (typeof data['model'] === 'string') {
      if (data['model'].includes('/')) out['model'] = data['model'];
      else warnings.push(`${src}: dropped command model "${data['model']}" (needs provider/model)`);
    }
    for (const key of ['allowed-tools', 'argument-hint', 'name']) {
      if (key in data) dropped.set(key, (dropped.get(key) ?? 0) + 1);
    }

    // Same leftover-slash guarantee as the skill body gate.
    for (const ns of KNOWN_NAMESPACES) {
      if (new RegExp(`/\\b${ns}:[a-z*]`).test(`${JSON.stringify(out)}\n${body}`)) {
        warnings.push(`${src}: leftover Claude-style slash ref "/${ns}:..."`);
        break;
      }
    }

    write(
      dest,
      Object.keys(out).length ? joinFrontmatter(out, body) : body,
    );
    count++;
  }
  for (const [key, n] of dropped) {
    warnings.push(`${n} command file(s): dropped Claude-only frontmatter "${key}"`);
  }
  return { count, warnings };
}

export function convertPlugin(
  pluginDir: string,
  target: Target,
  outRoot: string,
  known?: Map<string, Set<string>>,
  specOverride?: PluginSpec,
): ConvertResult {
  const pluginJsonPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  if (!exists(pluginJsonPath)) {
    throw new Error(`Not a Claude plugin (no .claude-plugin/plugin.json): ${pluginDir}`);
  }
  const pluginJson = JSON.parse(read(pluginJsonPath)) as Record<string, unknown>;
  const ns = String(pluginJson['name']);
  // Registered (forge) specs win; unregistered plugins fall back to a generic
  // default so any standard Claude plugin converts.
  const spec = specOverride ?? resolvePlugin(ns);
  const sharedDirs = spec.sharedDirs ?? ['shared'];
  // Namespaces whose cross-refs we rewrite: registry + every plugin in this run
  // + this plugin's own ns (so an unregistered plugin's self-refs also rewrite).
  const namespaces = [...new Set([...KNOWN_NAMESPACES, ...(known?.keys() ?? []), ns])];

  const skillsRoot = path.join(pluginDir, 'skills');
  const skillDirs = listSkillDirs(skillsRoot, spec);
  const bundleDir = path.join(outRoot, ns);
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(bundleDir, { recursive: true });
  if (target.commandsDir) {
    // Clear this plugin's previous command output so deleted commands don't linger.
    fs.rmSync(path.join(outRoot, 'commands', ns), { recursive: true, force: true });
    fs.rmSync(path.join(outRoot, 'commands', `${ns}.md`), { force: true });
  }

  const stats: Stats = { inlined: 0, bundledReads: 0, crossRefs: 0, subagents: 0 };
  const produced: string[] = [];

  const currentSkills = new Set(skillDirs);
  for (const d of skillDirs) {
    const destName = targetSkillDir(spec, target, d);
    convertSkill(
      spec,
      target,
      path.join(skillsRoot, d),
      path.join(bundleDir, destName),
      currentSkills,
      bundleDir,
      namespaces,
      stats,
    );
    produced.push(destName);
  }

  // Relocate each shared reference dir (theory-forge style lazy-loaded paths)
  // into a sibling `<ns>-<dir>/` and transform its markdown too.
  for (const dir of sharedDirs) {
    const sharedSrc = path.join(skillsRoot, dir);
    if (!exists(sharedSrc)) continue;
    const sharedDest = path.join(bundleDir, `${ns}-${dir}`);
    fs.cpSync(sharedSrc, sharedDest, { recursive: true });
    for (const f of listMarkdown(sharedDest)) {
      const srcDir = path.dirname(path.join(sharedSrc, path.relative(sharedDest, f)));
      transformFile(f, srcDir, null, spec, target, currentSkills, bundleDir, namespaces, stats);
    }
  }

  generateOrchestrator(spec, target, pluginDir, bundleDir, skillDirs, pluginJson, namespaces, stats);

  const cmdResult = convertCommands(
    spec,
    target,
    pluginDir,
    outRoot,
    currentSkills,
    namespaces,
    stats,
  );

  // Plugin manifest (Codex only; OpenCode discovers skills/commands by path).
  if (target.pluginManifest) {
    write(
      path.join(bundleDir, target.pluginManifest),
      JSON.stringify(
        {
          name: ns,
          version: pluginJson['version'] ?? '0.0.0',
          description: pluginJson['description'] ?? '',
          skills: './',
        },
        null,
        2,
      ),
    );
  }

  // Drop the relocated shared dir if nothing ended up referencing it (plugins
  // whose shared content was fully inlined via @-includes).
  const sharedDest = path.join(bundleDir, `${ns}-shared`);
  if (exists(sharedDest)) {
    let referenced = false;
    const scan = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (p === sharedDest) continue;
        if (e.isDirectory()) scan(p);
        else if (e.name.endsWith('.md') && read(p).includes(`${ns}-shared/`)) referenced = true;
      }
    };
    scan(bundleDir);
    // Commands live beside the bundle; they can be the only consumer of shared.
    const commandsOut = path.join(outRoot, 'commands');
    if (target.commandsDir && exists(commandsOut)) scan(commandsOut);
    if (!referenced) fs.rmSync(sharedDest, { recursive: true, force: true });
  }

  const violations = verify(bundleDir, target);
  const warnings = known
    ? findUnresolvedRefs(bundleDir, known, target).map(
        (r) => `cross-ref ${r} resolves to no known skill (source-side dangling ref)`,
      )
    : [];
  warnings.push(...cmdResult.warnings);

  // Safety net: every Task(subagent_type=...) should have been adapted to a
  // target subagent. Any survivor means an unmatched form needing manual review.
  let taskSites = 0;
  const countTasks = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) countTasks(p);
      else if (e.name.endsWith('.md')) {
        taskSites += (read(p).match(/Task\(subagent_type/g) ?? []).length;
      }
    }
  };
  countTasks(bundleDir);
  if (taskSites > 0) {
    warnings.push(
      `${taskSites} unadapted Task(subagent_type=...) site(s) — unmatched form, review manually.`,
    );
  }

  // Leftover cross-plugin bare skill paths (ambiguous in source, not rewritten).
  const leftoverPaths = new Set<string>();
  const scanPaths = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scanPaths(p);
      else if (e.name.endsWith('.md')) {
        for (const m of read(p).matchAll(/(?:\.\.\/)*skills\/[a-z][a-z0-9-]*\/SKILL\.md/g)) {
          leftoverPaths.add(m[0]);
        }
      }
    }
  };
  scanPaths(bundleDir);
  for (const lp of [...leftoverPaths].sort()) {
    warnings.push(`unresolved skill path "${lp}" (cross-plugin/ambiguous source ref)`);
  }

  return {
    ns,
    bundleDir,
    skills: produced,
    commands: cmdResult.count,
    inlined: stats.inlined,
    bundledReads: stats.bundledReads,
    crossRefs: stats.crossRefs,
    subagents: stats.subagents,
    violations,
    warnings,
  };
}
