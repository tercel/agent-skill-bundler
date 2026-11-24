import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';

export interface ClaudeSkillSource {
  /** Source directory name, used by registered aliases and relative skill paths. */
  name: string;
  invocationName: string;
  dir: string;
  root: boolean;
}

export interface ClaudeCommandSource {
  /** Colon-separated path segments, excluding the plugin namespace. */
  name: string;
  source: string;
  dir: string;
  markdown: string;
  inline: boolean;
  metadata: Record<string, unknown>;
}

interface ClaudePlugin {
  manifest: Record<string, unknown>;
  ns: string;
  skills: ClaudeSkillSource[];
  commands: ClaudeCommandSource[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPathSegment(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' &&
    !/[/\\:<>"|?*\p{Cc}\p{Bidi_Control}]/u.test(value);
}

function statIfPresent(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertWithinPlugin(root: string, candidate: string, label: string): string {
  const real = fs.realpathSync(candidate);
  const relative = path.relative(root, real);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} resolves outside the plugin`);
  }
  return real;
}

function componentPath(root: string, value: unknown, label: string, allowDot = false): string {
  if (typeof value !== 'string' || (!value.startsWith('./') && !(allowDot && value === '.')) ||
      value.split(/[/\\]/).includes('..')) {
    throw new Error(`${label} must be a plugin-relative path, got ${JSON.stringify(value)}`);
  }
  const candidate = path.resolve(root, value);
  if (!statIfPresent(candidate)) throw new Error(`${label} path not found: ${value}`);
  assertWithinPlugin(root, candidate, `${label} path ${value}`);
  return candidate;
}

function sortByName<T extends { name: string }>(items: Iterable<T>): T[] {
  return Array.from(items).sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));
}

function invocationName(markdown: string, directoryName: string, ns: string): string {
  const frontmatter = markdown.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m);
  if (!frontmatter || frontmatter.index !== 0) return directoryName;
  try {
    const fields: unknown = YAML.parse(frontmatter[1]);
    if (!isRecord(fields) || typeof fields.name !== 'string' || !fields.name.trim()) return directoryName;
    const prefix = `${ns}:`;
    return fields.name.startsWith(prefix) ? fields.name.slice(prefix.length) || directoryName : fields.name;
  } catch {
    // Claude loads the skill with default metadata when YAML cannot be parsed.
    return directoryName;
  }
}

function readSkills(root: string, ns: string, configured: unknown): ClaudeSkillSource[] {
  const skills = new Map<string, { file: string; entry: ClaudeSkillSource }>();

  function addSkill(dir: string): boolean {
    const candidate = path.join(dir, 'SKILL.md');
    if (!statIfPresent(candidate)?.isFile()) return false;
    const file = assertWithinPlugin(root, candidate, `Claude skill ${candidate}`);
    const name = dir === root ? ns : path.basename(dir);
    const invocation = invocationName(fs.readFileSync(file, 'utf8'), name, ns);
    const existing = skills.get(invocation);
    if (existing && existing.file !== file) {
      throw new Error(`Duplicate Claude skill name "${invocation}": ${existing.file}, ${file}`);
    }
    if (!existing) {
      skills.set(invocation, { file, entry: { name, invocationName: invocation, dir, root: dir === root } });
    }
    return true;
  }

  function scanChildren(dir: string): void {
    assertWithinPlugin(root, dir, `Claude skills directory ${dir}`);
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      if (child.isDirectory()) addSkill(path.join(dir, child.name));
    }
  }

  const defaultDir = path.join(root, 'skills');
  const hasDefaultDirectory = statIfPresent(defaultDir)?.isDirectory() ?? false;
  if (hasDefaultDirectory) scanChildren(defaultDir);
  if (configured === undefined) {
    if (!hasDefaultDirectory) addSkill(root);
  } else {
    for (const value of Array.isArray(configured) ? configured : [configured]) {
      const dir = componentPath(root, value, 'Manifest skills', true);
      if (!fs.statSync(dir).isDirectory()) throw new Error(`Manifest skills path must name a directory: ${value}`);
      if (!addSkill(dir)) scanChildren(dir);
    }
  }

  return sortByName(Array.from(skills.values(), ({ entry }) => entry));
}

function commandMetadata(definition: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([
    ['description', definition.description],
    ['argument-hint', definition.argumentHint],
    ['model', definition.model],
    ['allowed-tools', definition.allowedTools],
  ].filter(([, value]) => value !== undefined));
}

function readCommands(root: string, manifestFile: string, configured: unknown): ClaudeCommandSource[] {
  const commands = new Map<string, ClaudeCommandSource>();

  function add(entry: ClaudeCommandSource): void {
    if (!entry.name.split(':').every(isPathSegment)) {
      throw new Error(`Invalid Claude command name "${entry.name}" in ${entry.source}`);
    }

    const existing = commands.get(entry.name);
    if (existing && existing.source !== entry.source) {
      throw new Error(`Duplicate Claude command name "${entry.name}": ${existing.source}, ${entry.source}`);
    }
    if (!existing) commands.set(entry.name, entry);
  }

  function addFile(name: string, file: string, metadata: Record<string, unknown> = {}): void {
    if (!file.endsWith('.md') || !statIfPresent(file)?.isFile()) {
      throw new Error(`Claude command source must be a Markdown file: ${file}`);
    }
    const source = assertWithinPlugin(root, file, `Claude command source ${file}`);
    add({ name, dir: path.dirname(file), source, markdown: fs.readFileSync(source, 'utf8'), inline: false, metadata });
  }

  function scanDirectory(dir: string, prefix: string[] = []): void {
    assertWithinPlugin(root, dir, `Claude commands directory ${dir}`);
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      if (child.name.startsWith('.') || child.name === 'node_modules') continue;
      const file = path.join(dir, child.name);
      if (child.isDirectory()) {
        scanDirectory(file, [...prefix, child.name]);
      } else if (child.name.endsWith('.md') && statIfPresent(file)?.isFile()) {
        addFile([...prefix, path.basename(file, '.md')].join(':'), file);
      }
    }
  }

  if (configured === undefined) {
    const commandsDir = path.join(root, 'commands');
    if (statIfPresent(commandsDir)?.isDirectory()) scanDirectory(commandsDir);
  } else if (isRecord(configured)) {
    for (const [name, definition] of Object.entries(configured)) {
      const label = `Manifest commands.${name}`;
      if (!isRecord(definition) || Object.hasOwn(definition, 'source') === Object.hasOwn(definition, 'content')) {
        throw new Error(`${label} must set exactly one of source or content`);
      }
      const metadata = commandMetadata(definition);
      if (Object.hasOwn(definition, 'source')) {
        const file = componentPath(root, definition.source, `${label}.source`);
        addFile(name, file, metadata);
      } else {
        if (typeof definition.content !== 'string') throw new Error(`${label}.content must be Markdown text`);
        add({ name, dir: root, source: `${manifestFile}#commands.${name}`, markdown: definition.content, inline: true, metadata });
      }
    }
  } else {
    for (const value of Array.isArray(configured) ? configured : [configured]) {
      const file = componentPath(root, value, 'Manifest commands');
      if (fs.statSync(file).isDirectory()) scanDirectory(file);
      else addFile(path.basename(file, '.md'), file);
    }
  }

  return sortByName(commands.values());
}

/** Discover Claude plugin components following the manifest's additive skill and replacing command rules. */
export function readClaudePlugin(pluginDir: string): ClaudePlugin {
  const root = fs.realpathSync(pluginDir);
  const manifestFile = path.join(root, '.claude-plugin', 'plugin.json');
  const hasManifest = statIfPresent(manifestFile)?.isFile() ?? false;
  let manifest: Record<string, unknown> = { name: path.basename(root) };
  if (hasManifest) {
    const file = assertWithinPlugin(root, manifestFile, 'Claude plugin manifest');
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isRecord(parsed)) throw new Error(`Claude plugin manifest must be an object: ${manifestFile}`);
    manifest = parsed;
  }

  const ns = manifest.name;
  if (!isPathSegment(ns) || /[@\s]/u.test(ns)) {
    throw new Error(`Invalid Claude plugin name ${JSON.stringify(ns)}: ${manifestFile}`);
  }
  const skills = readSkills(root, ns, manifest.skills);
  const commands = readCommands(root, manifestFile, manifest.commands);
  if (!hasManifest && skills.length === 0 && commands.length === 0) {
    throw new Error(`Not a Claude plugin (no manifest, skills, or commands): ${pluginDir}`);
  }
  return { manifest, ns, skills, commands };
}
