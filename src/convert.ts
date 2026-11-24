import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import { isArtifactName, writeBundleMetadata } from './bundle.js';
import { readClaudePlugin, type ClaudeCommandSource, type ClaudeSkillSource } from './claude.js';
import { lowerGeminiBody, mapClaudePromptText, normalizeGeminiSkill, serializeGeminiCommand } from './gemini.js';
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
): { ns: string; names: Set<string>; routes?: Map<string, string> } {
  if (target.id === 'gemini') {
    const plugin = readClaudePlugin(pluginDir);
    const spec = resolvePlugin(plugin.ns);
    const names = new Set<string>();
    if (!plugin.skills.some((source) => source.root)) names.add(geminiSkillId(spec.ns));
    const routes = new Map(plugin.commands.map((command) => [
      `${plugin.ns}:${command.name}`, geminiCommandRef(plugin.ns, command.name),
    ]));
    for (const source of plugin.skills) {
      if (spec.nonSkillDirs.includes(source.name)) continue;
      const { id, meta, commandName } = planGeminiSkill(source, spec, target);
      if (meta.violations.length) continue;
      recordGeminiSkillRoutes(routes, spec, source, meta.manualOnly ? geminiCommandRef(spec.ns, commandName) : id);
      if (!meta.manualOnly) names.add(id);
    }
    return { ns: plugin.ns, names, routes };
  }
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
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function geminiSkillId(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (slug === value && slug.length <= 64) return slug;
  const suffix = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `${(slug || 'skill').slice(0, 55).replace(/-$/, '')}-${suffix}`;
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
  hasFrontmatter: boolean;
}
function splitFrontmatter(md: string): Frontmatter {
  const text = md.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = text.match(/^---[ \t]*\n([\s\S]*?)^---[ \t]*(?:\n|$)/m);
  if (!m || m.index !== 0) return { data: {}, body: text, hasFrontmatter: false };
  const data: unknown = YAML.parse(m[1]);
  if (data != null && (typeof data !== 'object' || Array.isArray(data))) {
    throw new Error('YAML frontmatter must be a mapping');
  }
  return {
    data: (data as Record<string, unknown> | null) ?? {},
    body: text.slice(m[0].length),
    hasFrontmatter: true,
  };
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
  const taskRe = target.id === 'gemini'
    ? /\b(?:Task|Agent)\(\s*subagent_type\s*=\s*["']([^"']+)["']\s*(?:,\s*((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)"'])*))?\)/g
    : /Task\(subagent_type="([^"]+)"\s*(?:,\s*([^)]*))?\)/g;
  for (let i = 0; i < lines.length; i++) {
    if (!/\b(?:Task|Agent)\(\s*subagent_type/.test(lines[i])) continue;
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
      if (target.id === 'gemini' && !pm) {
        const prompt = rest?.match(/\bprompt\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[\w.-]+)/);
        const description = rest?.match(/\bdescription\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
        if (description) s += ` for ${description[1]}`;
        if (prompt) s += ` with prompt ${prompt[1]}`;
      }
      return s;
    });
  }
  return { body: lines.join('\n'), count };
}

/** TOML basic-string escape. */
function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

/**
 * Emit the target's custom agents as `.codex/agents/*.toml` (Codex) or
 * `agents/*.md` (OpenCode / Gemini CLI).
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
    } else if (target.agentFrontmatter === 'gemini') {
      // Gemini CLI: Markdown frontmatter with required `name` + `description`,
      // and the body as the subagent's system prompt.
      const fm = YAML.stringify({
        name: a.name,
        description: a.description,
      }).trimEnd();
      content = `---\n${fm}\n---\n\n${a.developer_instructions}\n`;
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
  routes?: ReadonlyMap<string, string>,
): { body: string; count: number } {
  let count = 0;
  let out = body;
  const prefixStyle = target?.nameStyle === 'prefix';
  for (const ns of namespaces) {
    const namespace = escapeRegex(ns);
    if (target?.id === 'gemini') {
      const segment = '[\\p{L}\\p{N}_-]+(?:\\.[\\p{L}\\p{N}_-]+)*';
      const refs = new RegExp(`(?<![\\w./:@%-])/?${namespace}:(${segment}(?::${segment})*)`, 'gu');
      out = out.replace(refs, (_ref, name: string) => {
        count++;
        return routes?.get(`${ns}:${name}`) ?? geminiSkillId(`${ns}-${aliasFor(resolvePlugin(ns), name)}`);
      });
    } else {
      const sub = new RegExp(`/\\b${namespace}:([a-z][a-z0-9-]*)`, 'g');
      out = out.replace(sub, (_ref, name: string) => {
        count++;
        return prefixStyle ? `${ns}-${name}` : `$${ns}:${name}`;
      });
    }
    // bare orchestrator invocation: /spec-forge -> $spec-forge:spec-forge
    const orch = new RegExp(`(?<![\\w./:@%-])/${namespace}(?![\\w:./-])`, 'g');
    out = out.replace(orch, () => {
      count++;
      return target?.id === 'gemini' ? routes?.get(ns) ?? geminiSkillId(ns) : prefixStyle ? ns : `$${ns}:${ns}`;
    });
    // prefix targets have no `:` namespace, so bare colon refs are invalid too:
    // code-forge:plan -> code-forge-plan
    if (prefixStyle && target?.id !== 'gemini') {
      const bare = new RegExp(`\\b${namespace}:([a-z][a-z0-9-]*)`, 'g');
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
  routes?: ReadonlyMap<string, string>,
): { body: string; count: number } {
  let count = 0;
  const out = body.replace(
    /(?:\.\.\/)*skills\/([a-z][a-z0-9-]*)\/SKILL\.md/g,
    (m, dir: string) => {
      let ref = routes?.get(`${spec.ns}:${dir}`);
      if (!ref && !currentSkills.has(dir) && routes) {
        const matches = [...routes].filter(([name]) => name.endsWith(`:${dir}`));
        if (matches.length === 1) ref = matches[0][1];
      }
      if (!ref && !currentSkills.has(dir)) return m;
      count++;
      return routes ? ref ?? targetSkillRef(spec, target, dir) : `\`${targetSkillRef(spec, target, dir)}\``;
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

interface GeminiConversion {
  pluginDir: string;
  sharedDirs: string[];
  orchestrator: string;
  suiteBody?: string;
  routes: Map<string, string>;
  warnings: string[];
  metaWarnings: Map<string, Set<string>>;
  violations: string[];
}

function recordGeminiMetaWarnings(gemini: GeminiConversion, source: string, warnings: string[]): void {
  for (const warning of warnings) {
    let files = gemini.metaWarnings.get(warning);
    if (!files) {
      files = new Set<string>();
      gemini.metaWarnings.set(warning, files);
    }
    files.add(source);
  }
}

function summarizeGeminiMetaWarnings(gemini: GeminiConversion): string[] {
  const out: string[] = [];
  for (const [warning, files] of gemini.metaWarnings) {
    if (files.size === 1) out.push(`${[...files][0]}: ${warning}`);
    else out.push(`${files.size} file(s): ${warning}`);
  }
  return out;
}

function inside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function rewriteGeminiShared(
  body: string,
  gemini: GeminiConversion,
  source: string,
  rewrite: (dir: string, relative: string, file: string) => string,
): string {
  if (!gemini.sharedDirs.length) return body;
  const names = gemini.sharedDirs.map(escapeRegex).join('|');
  const pattern = new RegExp(
    `(?<![\\w/.-])@?(?:(?:\\.\\./)+)?(?:skills/)?(${names})/([\\w/-]*(?:\\.[\\w/-]+)*)`,
    'g',
  );
  return body.replace(pattern, (reference, dir: string, relative: string) => {
    const root = path.join(gemini.pluginDir, 'skills', dir);
    const file = path.join(root, relative);
    if (!exists(file)) {
      gemini.violations.push(`${source}: shared resource "${reference}" does not exist`);
      return reference;
    }
    if (!inside(fs.realpathSync(gemini.pluginDir), fs.realpathSync(file))) {
      gemini.violations.push(`${source}: shared resource "${reference}" escapes the Claude plugin`);
      return reference;
    }
    return rewrite(dir, relative, file);
  });
}

function copyGeminiResources(source: string, dest: string, pluginDir: string): void {
  const root = fs.realpathSync(pluginDir);
  fs.cpSync(source, dest, {
    recursive: true,
    dereference: true,
    filter: (file) => {
      if (!inside(root, fs.realpathSync(file))) {
        throw new Error(`${file}: bundled resource escapes the Claude plugin`);
      }
      return true;
    },
  });
}

interface GeminiSkillAssets {
  copied: Map<string, string>;
  rewrite(body: string, destFile: string, source: string): string;
}

function geminiSkillAssets(
  gemini: GeminiConversion,
  ns: string,
  skillDir: string,
): GeminiSkillAssets {
  const copied = new Map<string, string>();
  return {
    copied,
    rewrite: (body, destFile, source) => rewriteGeminiShared(body, gemini, source, (dir, relative) => {
      const dest = path.join(skillDir, 'references', `${ns}-${dir}`);
      if (!copied.has(dir)) {
        if (exists(dest)) throw new Error(`${source}: shared resources collide with ${dest}`);
        copyGeminiResources(path.join(gemini.pluginDir, 'skills', dir), dest, gemini.pluginDir);
        copied.set(dir, dest);
      }
      const rewritten = path.relative(path.dirname(destFile), path.join(dest, relative)).split(path.sep).join('/');
      const localPath = rewritten.startsWith('.') ? rewritten : rewritten ? `./${rewritten}` : '.';
      return !relative || relative.endsWith('/') ? `${localPath}/` : localPath;
    }),
  };
}

function embedGeminiCommandResources(
  body: string,
  gemini: GeminiConversion,
  ns: string,
  source: string,
  assets: GeminiSkillAssets,
  orchestratorFile: string,
): { body: string; inlined: number } {
  const references = new Map<string, { title: string; content: string }>();
  const embed = (text: string): string => rewriteGeminiShared(text, gemini, source, (dir, relative, file) => {
    if (path.extname(file).toLowerCase() !== '.md' || !fs.statSync(file).isFile()) {
      const resource = assets.rewrite(`skills/${dir}/${relative}`, orchestratorFile, source);
      return `${resource} (activate skill ${ns} to access this resource)`;
    }
    const reference = references.get(file) ?? { title: `Bundled reference ${references.size + 1}`, content: '' };
    if (!references.has(file)) {
      references.set(file, reference);
      reference.content = mapClaudePromptText(read(file).trim(), embed);
    }
    return reference.title;
  });
  const prompt = mapClaudePromptText(body, embed);
  const appendix = [...references.values()].map(({ title, content }) => `### ${title}\n\n${content}`);
  return { body: [prompt, ...appendix].join('\n\n'), inlined: references.size };
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
  gemini?: GeminiConversion,
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
    if (gemini && !inside(fs.realpathSync(gemini.pluginDir), fs.realpathSync(abs))) {
      gemini.violations.push(`${skillDir}: include "${rel}" escapes the Claude plugin`);
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
  gemini?: GeminiConversion,
  assets?: GeminiSkillAssets,
): void {
  const { data, body: rawBody, hasFrontmatter } = splitFrontmatter(read(destFile));
  const isRootSkill = isRootSkillName !== null;
  const sharedDirs = spec.sharedDirs ?? ['shared'];
  const source = path.join(srcDir, path.basename(destFile));

  let body = isRootSkill ? mergeInstructions(data, rawBody) : rawBody;
  const inc = resolveIncludes(body, srcDir, target, false, gemini);
  body = inc.body;
  if (gemini && isRootSkill) {
    const lower = lowerGeminiBody(body, data, 'skill', isRootSkillName);
    body = lower.body;
    gemini.warnings.push(...lower.warnings.map((warning) => `${source}: ${warning}`));
    gemini.violations.push(...lower.violations.map((violation) => `${source}: ${violation}`));
  }
  body = remapTools(body, target);
  const sa = adaptSubagents(body, target);
  body = sa.body;
  const cr = rewriteCrossRefs(body, namespaces, target, gemini?.routes);
  body = cr.body;
  const sp = rewriteSkillPaths(body, spec, currentSkills, target, gemini?.routes);
  body = sp.body;
  body = assets
    ? assets.rewrite(body, destFile, source)
    : relocateSharedPaths(body, path.dirname(destFile), bundleDir, spec.ns, sharedDirs).body;
  stats.subagents += sa.count;

  // The frontmatter description is model-visible (Codex shows it in the skills
  // list) and can carry Claude slash refs / tool names too — transform it too.
  const output = gemini && isRootSkill ? normalizeGeminiSkill(data, rawBody, isRootSkillName).data : data;
  if (typeof output.description === 'string') {
    let d = remapTools(output.description, target);
    d = adaptSubagents(d, target).body;
    d = rewriteCrossRefs(d, namespaces, target, gemini?.routes).body;
    d = rewriteSkillPaths(d, spec, currentSkills, target, gemini?.routes).body;
    d = assets
      ? assets.rewrite(d, destFile, source)
      : relocateSharedPaths(d, path.dirname(destFile), bundleDir, spec.ns, sharedDirs).body;
    output.description = d;
  }

  if (isRootSkill) output.name = isRootSkillName;

  write(destFile, hasFrontmatter || isRootSkill ? joinFrontmatter(output, body) : body);

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
  gemini?: GeminiConversion,
  rootSource = false,
  rootAssets?: GeminiSkillAssets,
): void {
  const assets = rootAssets ?? (gemini && geminiSkillAssets(gemini, spec.ns, destSkillDir));
  if (gemini && rootSource) {
    // A plugin-root skill may sit alongside component directories and the
    // output tree. Copy only the skill and its portable resource directories.
    for (const name of ['SKILL.md', 'assets', 'references', 'scripts']) {
      const src = path.join(srcSkillDir, name);
      if (exists(src)) copyGeminiResources(src, path.join(destSkillDir, name), gemini.pluginDir);
    }
  } else if (gemini) {
    copyGeminiResources(srcSkillDir, destSkillDir, gemini.pluginDir);
  } else {
    fs.cpSync(srcSkillDir, destSkillDir, { recursive: true });
  }

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
      gemini,
      assets,
    );
  }
  // The root skill can share its bundled resources with commands. Process
  // those documents after both the skill and the commands have added files.
  if (gemini && assets && !rootAssets) {
    transformGeminiSharedFiles(assets, gemini, spec, target, currentSkills, bundleDir, namespaces, stats);
  }
}

function transformGeminiSharedFiles(
  assets: GeminiSkillAssets,
  gemini: GeminiConversion,
  spec: PluginSpec,
  target: Target,
  currentSkills: Set<string>,
  bundleDir: string,
  namespaces: string[],
  stats: Stats,
): void {
  for (const [name, dest] of assets.copied) {
    const src = path.join(gemini.pluginDir, 'skills', name);
    for (const file of listMarkdown(dest)) {
      const srcDir = path.dirname(path.join(src, path.relative(dest, file)));
      transformFile(file, srcDir, null, spec, target, currentSkills, bundleDir, namespaces, stats, gemini, assets);
    }
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
  gemini?: GeminiConversion,
): void {
  const cmdFile = path.join(pluginDir, 'commands', `${spec.ns}.md`);
  // Rootless bundles keep the orchestrator one level down; shared-path
  // relocation must be relative to the file, not the container dir.
  const orchestratorDir =
    target.layout === 'rootless' ? path.join(bundleDir, gemini?.orchestrator ?? spec.ns) : bundleDir;
  const rows = skillDirs
    .map((d) => `| \`${gemini?.routes.get(`${spec.ns}:${d}`) ?? targetSkillRef(spec, target, d)}\` | ${aliasFor(spec, d)} |`)
    .join('\n');

  let body: string;
  if (!gemini && exists(cmdFile)) {
    const { body: cmdBody } = splitFrontmatter(read(cmdFile));
    body = remapTools(cmdBody, target);
    const sa = adaptSubagents(body, target);
    body = sa.body;
    stats.subagents += sa.count;
    body = rewriteCrossRefs(body, namespaces, target).body;
    body = rewriteSkillPaths(body, spec, new Set(skillDirs), target).body;
    body = relocateSharedPaths(body, orchestratorDir, bundleDir, spec.ns, spec.sharedDirs ?? ['shared']).body;
  } else if (!gemini) {
    body = `# ${spec.ns}\n\nOrchestrator for the ${spec.ns} skill suite.\n`;
  } else {
    body = gemini.suiteBody ?? '';
  }

  const header =
    target.id === 'gemini'
      ? `# ${spec.ns}\n\n` +
        `Orchestrator entry point for the **${spec.ns}** suite. Gemini CLI discovers ` +
        `flat skills under \`~/.gemini/skills/\`; activate a capability with ` +
        `\`activate_skill\` by its skill name:\n\n` +
        `| Skill name | Capability |\n|---|---|\n${rows}\n\n` +
        (body ? `When asked to run the full ${spec.ns} chain, follow the workflow below.\n\n---\n\n`
          : `Use the available capabilities that match the user's request.\n`)
      : target.nameStyle === 'prefix'
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

  const rawDesc = typeof pluginJson.description === 'string' && pluginJson.description.trim()
    ? pluginJson.description
    : `${spec.ns} skill orchestrator`;
  const data: Record<string, unknown> = {
    name: gemini?.orchestrator ?? spec.ns,
    description: rewriteCrossRefs(remapTools(rawDesc, target), namespaces, target, gemini?.routes).body,
  };
  // Rootless targets keep the bundle dir as a plain container: a SKILL.md at its
  // root would make the agent treat the whole bundle as one skill and stop
  // recursing, hiding every sub-skill.
  write(path.join(orchestratorDir, 'SKILL.md'), joinFrontmatter(data, header + body));
}

// ---------- verification gates ----------

function verify(bundleDir: string, target: Target, orchestrator: string | null = path.basename(bundleDir)): string[] {
  const violations: string[] = [];
  const ns = path.basename(bundleDir);

  // Gate E: layout invariants. A rootless agent stops recursing at a SKILL.md,
  // so a bundle-root SKILL.md would hide every sub-skill.
  if (target.layout === 'rootless') {
    if (exists(path.join(bundleDir, 'SKILL.md'))) {
      violations.push(`${bundleDir}: SKILL.md at bundle root would hide every sub-skill`);
    }
    if (orchestrator && !exists(path.join(bundleDir, orchestrator, 'SKILL.md'))) {
      violations.push(`${bundleDir}: missing orchestrator skill at ${orchestrator}/SKILL.md`);
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
    for (const ns of target.id === 'gemini' ? [] : KNOWN_NAMESPACES) {
      if (new RegExp(`/\\b${ns}:[a-z*]`).test(md)) {
        violations.push(`${f}: leftover Claude-style slash ref "/${ns}:..."`);
        break;
      }
    }
    // Gate B2 (prefix targets): the bare `<ns>:<skill>` colon form is valid in
    // Codex but is not a skill ID in a namespace-less target.
    if (target.nameStyle === 'prefix' && target.id !== 'gemini') {
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
    if (target.id === 'gemini') continue; // Gemini resources were checked in the source tree.
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
              ? new RegExp(`(?<![\\w/-])(${escapeRegex(ns)}-[a-z][a-z0-9-]*)(?![a-z0-9-]|/)`, 'g')
              : new RegExp(`\\b(${escapeRegex(ns)}:[a-z][a-z0-9-]*)`, 'g');
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
 * - OpenCode (`markdown`): scans `.md` files under `<commandsDir>` and names
 *   them by relative path (`commands/<ns>/plan.md` -> `/ns/plan`,
 *   `commands/<ns>.md` -> `/ns`). `$ARGUMENTS` and `$1` are preserved.
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
  if (!target.commandsDir || !target.commandFormat || !exists(srcDir)) return { count: 0, warnings };

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

function geminiCommandRef(ns: string, name: string): string {
  return name === ns ? `/${ns}` : `/${ns}:${name}`;
}

function planGeminiSkill(source: ClaudeSkillSource, spec: PluginSpec, target: Target) {
  const id = geminiSkillId(source.root ? spec.ns : targetSkillDir(spec, target, source.name));
  const file = path.join(source.dir, 'SKILL.md');
  const markdown = read(file);
  const { data, body } = splitFrontmatter(markdown);
  const meta = normalizeGeminiSkill(data, body, id);
  const alias = aliasFor(spec, source.name);
  const commandName = source.root ? spec.ns : alias === source.name ? geminiSkillId(source.invocationName) : alias;
  return { id, file, markdown, meta, commandName };
}

function recordGeminiSkillRoutes(
  routes: Map<string, string>,
  spec: PluginSpec,
  source: ClaudeSkillSource,
  ref: string,
): void {
  if (source.root) routes.set(spec.ns, ref);
  for (const name of [source.name, source.invocationName, aliasFor(spec, source.name)]) {
    routes.set(`${spec.ns}:${name}`, ref);
  }
}

function countUnadaptedSubagents(body: string, gemini: boolean): number {
  const pattern = gemini
    ? /\b(?:Task|Agent)\s*\((?=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)"'])*?\bsubagent_type\s*=)/g
    : /\bTask\(subagent_type\b/g;
  return (body.match(pattern) ?? []).length;
}

function convertGeminiCommands(
  commands: ClaudeCommandSource[],
  gemini: GeminiConversion,
  spec: PluginSpec,
  target: Target,
  outRoot: string,
  currentSkills: Set<string>,
  namespaces: string[],
  stats: Stats,
  rootAssets?: GeminiSkillAssets,
): number {
  const bundleDir = path.join(outRoot, spec.ns);
  const orchestratorDir = path.join(bundleDir, gemini.orchestrator);
  const assets = rootAssets ?? geminiSkillAssets(gemini, spec.ns, orchestratorDir);
  let count = 0;
  for (const command of commands) {
    const fields = command.inline ? { data: {}, body: command.markdown } : splitFrontmatter(command.markdown);
    const data = { ...fields.data, ...command.metadata };
    const meta = normalizeGeminiSkill(data, fields.body, command.name);
    const previousViolations = gemini.violations.length;
    recordGeminiMetaWarnings(gemini, command.source, meta.warnings);
    gemini.violations.push(...meta.violations.map((violation) => `${command.source}: ${violation}`));
    if (meta.violations.length) continue;

    let includesInlined = 0;
    const instructions = mapClaudePromptText(mergeInstructions(data, fields.body), (text) => {
      const includes = resolveIncludes(text, command.dir, target, true, gemini);
      includesInlined += includes.inlined;
      return includes.body;
    });
    const embedded = embedGeminiCommandResources(
      instructions, gemini, gemini.orchestrator, command.source, assets, path.join(orchestratorDir, 'SKILL.md'),
    );
    const fixRefs = (body: string): string => rewriteSkillPaths(
      rewriteCrossRefs(body, namespaces, target, gemini.routes).body, spec, currentSkills, target, gemini.routes,
    ).body;
    const adapt = (body: string): string => {
      const adapted = adaptSubagents(remapTools(body, target), target);
      stats.subagents += adapted.count;
      return fixRefs(adapted.body);
    };
    const lower = lowerGeminiBody(embedded.body, data, 'command', undefined, adapt);
    gemini.warnings.push(...lower.warnings.map((warning) => `${command.source}: ${warning}`));
    gemini.violations.push(...lower.violations.map((violation) => `${command.source}: ${violation}`));
    if (gemini.violations.length !== previousViolations) continue;

    let description: string | undefined;
    if (typeof data.description === 'string' && data.description.trim()) {
      description = fixRefs(remapTools(data.description, target)).replace(/\$ARGUMENTS\b/g, 'the supplied arguments');
    }
    const parts = command.name === spec.ns ? [spec.ns] : [spec.ns, ...command.name.split(':')];
    const dest = path.join(outRoot, 'commands', ...parts) + '.toml';
    write(dest, serializeGeminiCommand(lower.body, description));
    const unadapted = countUnadaptedSubagents(lower.body, true);
    if (unadapted) {
      gemini.warnings.push(`${command.source}: ${unadapted} unadapted Claude subagent call(s) in the Gemini command. Review the call syntax manually.`);
    }
    if (command.name === spec.ns && !meta.manualOnly && !rootAssets) {
      const suite = lowerGeminiBody(instructions, data, 'skill', gemini.orchestrator);
      if (!suite.violations.length) {
        gemini.suiteBody = assets.rewrite(adapt(suite.body), path.join(orchestratorDir, 'SKILL.md'), command.source);
      } else {
        gemini.warnings.push(`${command.source}: the suite workflow is available via /${spec.ns} only. ${suite.violations.join(' ')}`);
      }
    }
    stats.inlined += includesInlined + embedded.inlined;
    count++;
  }
  transformGeminiSharedFiles(assets, gemini, spec, target, currentSkills, bundleDir, namespaces, stats);
  return count;
}

export function convertPlugin(
  pluginDir: string,
  target: Target,
  outRoot: string,
  known?: Map<string, Set<string>>,
  specOverride?: PluginSpec,
  knownRoutes?: ReadonlyMap<string, string>,
): ConvertResult {
  const pluginJsonPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  const sourcePlugin = target.id === 'gemini' ? readClaudePlugin(pluginDir) : undefined;
  if (!sourcePlugin && !exists(pluginJsonPath)) {
    throw new Error(`Not a Claude plugin (no .claude-plugin/plugin.json): ${pluginDir}`);
  }
  const pluginJson = sourcePlugin?.manifest ?? JSON.parse(read(pluginJsonPath)) as Record<string, unknown>;
  const ns = sourcePlugin?.ns ?? String(pluginJson.name);
  if (sourcePlugin && !isArtifactName(ns)) {
    throw new Error(`Claude plugin name "${ns}" cannot be used as a Gemini bundle namespace`);
  }
  // Registered (forge) specs win; unregistered plugins fall back to a generic
  // default so any standard Claude plugin converts.
  const spec = specOverride ?? resolvePlugin(ns);
  const sharedDirs = spec.sharedDirs ?? ['shared'];
  // Namespaces whose cross-refs we rewrite: registry + every plugin in this run
  // + this plugin's own ns (so an unregistered plugin's self-refs also rewrite).
  const namespaces = [...new Set([...KNOWN_NAMESPACES, ...(known?.keys() ?? []), ns])];

  const skillsRoot = path.join(pluginDir, 'skills');
  const sources: ClaudeSkillSource[] = sourcePlugin
    ? sourcePlugin.skills.filter((source) => !spec.nonSkillDirs.includes(source.name))
    : listSkillDirs(skillsRoot, spec).map((name) => ({
      name, invocationName: name, dir: path.join(skillsRoot, name), root: false,
    }));
  const hasRootSource = sources.some((source) => source.root);
  const gemini: GeminiConversion | undefined = sourcePlugin && {
    pluginDir,
    sharedDirs: fs.statSync(skillsRoot, { throwIfNoEntry: false })?.isDirectory()
      ? sharedDirs.filter((dir) => fs.statSync(path.join(skillsRoot, dir), { throwIfNoEntry: false })?.isDirectory())
      : [],
    orchestrator: geminiSkillId(ns),
    routes: new Map(knownRoutes),
    warnings: [],
    metaWarnings: new Map(),
    violations: [],
  };
  const geminiCommands = new Map(sourcePlugin?.commands.map((command) => [command.name, command]));
  if (gemini) {
    for (const name of geminiCommands.keys()) gemini.routes.set(`${ns}:${name}`, geminiCommandRef(ns, name));
  }
  const normalizedSkills = new Map<string, string>();
  const planned = sources.flatMap((source) => {
    if (!gemini) return [{ source, id: targetSkillDir(spec, target, source.name) }];
    const { id, file, markdown, meta, commandName } = planGeminiSkill(source, spec, target);
    recordGeminiMetaWarnings(gemini, file, meta.warnings);
    gemini.violations.push(...meta.violations.map((violation) => `${file}: ${violation}`));
    if (meta.violations.length) return [];
    if (normalizedSkills.has(id) || (!source.root && id === gemini.orchestrator)) {
      gemini.violations.push(`${file}: Gemini skill name "${id}" collides with ${normalizedSkills.get(id) ?? 'the bundle entry skill'}`);
      return [];
    }
    normalizedSkills.set(id, file);
    if (meta.manualOnly) {
      if (geminiCommands.has(commandName)) {
        gemini.warnings.push(`${file}: the manual-only skill supplies ${geminiCommandRef(ns, commandName)} in place of the same-named Markdown command`);
      }
      geminiCommands.set(commandName, { name: commandName, dir: source.dir, source: file, markdown, inline: false, metadata: {} });
    }
    const ref = meta.manualOnly ? geminiCommandRef(ns, commandName) : id;
    recordGeminiSkillRoutes(gemini.routes, spec, source, ref);
    return meta.manualOnly ? [] : [{ source, id }];
  });
  const bundleDir = path.join(outRoot, ns);
  if (gemini && (inside(bundleDir, fs.realpathSync(pluginDir)) || path.resolve(outRoot) === fs.realpathSync(pluginDir))) {
    throw new Error(`Gemini output would replace files in the Claude plugin: ${outRoot}`);
  }
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(bundleDir, { recursive: true });
  if (target.commandsDir) {
    // Clear this plugin's previous command output so deleted commands don't linger.
    const cmdExt = target.commandFormat === 'toml' ? '.toml' : '.md';
    fs.rmSync(path.join(outRoot, 'commands', ns), { recursive: true, force: true });
    fs.rmSync(path.join(outRoot, 'commands', `${ns}${cmdExt}`), { force: true });
  }

  const stats: Stats = { inlined: 0, bundledReads: 0, crossRefs: 0, subagents: 0 };
  const produced: string[] = [];
  const availableSkills: string[] = [];
  let rootAssets: GeminiSkillAssets | undefined;

  const currentSkills = new Set(sources.map((source) => source.name));
  for (const { source, id } of planned) {
    const dest = path.join(bundleDir, id);
    const before = gemini?.violations.length;
    const assets = gemini && source.root ? geminiSkillAssets(gemini, spec.ns, dest) : undefined;
    convertSkill(
      spec,
      target,
      source.dir,
      dest,
      currentSkills,
      bundleDir,
      namespaces,
      stats,
      gemini,
      source.root,
      assets,
    );
    if (gemini?.violations.length !== before) {
      // Exclude incompatible entries even when --no-strict is used.
      fs.rmSync(dest, { recursive: true, force: true });
      continue;
    }
    produced.push(id);
    availableSkills.push(source.name);
    if (assets) rootAssets = assets;
  }

  // Relocate each shared reference dir (theory-forge style lazy-loaded paths)
  // into a sibling `<ns>-<dir>/` and transform its markdown too.
  for (const dir of gemini ? [] : sharedDirs) {
    const sharedSrc = path.join(skillsRoot, dir);
    if (!exists(sharedSrc)) continue;
    const sharedDest = path.join(bundleDir, `${ns}-${dir}`);
    fs.cpSync(sharedSrc, sharedDest, { recursive: true });
    for (const f of listMarkdown(sharedDest)) {
      const srcDir = path.dirname(path.join(sharedSrc, path.relative(sharedDest, f)));
      transformFile(f, srcDir, null, spec, target, currentSkills, bundleDir, namespaces, stats);
    }
  }

  const cmdResult = gemini
    ? {
      count: convertGeminiCommands(
        [...geminiCommands.values()], gemini, spec, target, outRoot, currentSkills, namespaces, stats, rootAssets,
      ),
      warnings: [...gemini.warnings, ...summarizeGeminiMetaWarnings(gemini)],
    }
    : convertCommands(spec, target, pluginDir, outRoot, currentSkills, namespaces, stats);
  // A real plugin-root skill already occupies the namespace. Keep a
  // command-only root manual unless another command needs a resource skill.
  const syntheticOrchestrator = !gemini || !hasRootSource ||
    (!rootAssets && exists(path.join(bundleDir, gemini.orchestrator, 'references')));
  if (syntheticOrchestrator) {
    generateOrchestrator(spec, target, pluginDir, bundleDir, availableSkills, pluginJson, namespaces, stats, gemini);
  }

  if (gemini) {
    writeBundleMetadata(bundleDir, {
      target: target.id,
      namespace: ns,
      skills: syntheticOrchestrator ? [gemini.orchestrator, ...produced] : produced,
      commands: cmdResult.count,
    });
  }

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
  if (!gemini && exists(sharedDest)) {
    let referenced = false;
    const scan = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (p === sharedDest) continue;
        if (e.isDirectory()) scan(p);
        else if ((e.name.endsWith('.md') || e.name.endsWith('.toml')) && read(p).includes(`${ns}-shared/`)) {
          referenced = true;
        }
      }
    };
    scan(bundleDir);
    // Commands live beside the bundle; they can be the only consumer of shared.
    const commandsOut = path.join(outRoot, 'commands');
    if (target.commandsDir && exists(commandsOut)) scan(commandsOut);
    if (!referenced) fs.rmSync(sharedDest, { recursive: true, force: true });
  }

  const expectedOrchestrator = gemini && !syntheticOrchestrator && !rootAssets ? null : gemini?.orchestrator;
  const violations = [...new Set([...verify(bundleDir, target, expectedOrchestrator), ...gemini?.violations ?? []])];
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
        taskSites += countUnadaptedSubagents(read(p), Boolean(gemini));
      }
    }
  };
  countTasks(bundleDir);
  if (taskSites > 0) {
    warnings.push(
      `${taskSites} unadapted Claude subagent call(s). Review the call syntax manually.`,
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
