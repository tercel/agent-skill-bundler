import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isArtifactName, type BundleMetadata } from './bundle.js';
import type { Target } from './targets.js';

type ArtifactKind = 'skills' | 'commands' | 'agents';

interface Artifact {
  kind: ArtifactKind;
  relative: string;
  source: string;
  sharedDefaultAgent?: boolean;
}

interface OwnedArtifact {
  namespace: string;
  relative: string;
  digest: string;
  sharedDefaultAgent?: boolean;
}

interface Change {
  destination: string;
  current?: string;
  staged?: string;
}

export interface InstallResult {
  dest: string;
  skillsInstalled: number;
  agents: number;
  commands: number;
  preservedEdits?: string[];
}

function entries(dir: string): fs.Dirent[] {
  const stats = fs.statSync(dir, { throwIfNoEntry: false });
  return stats?.isDirectory() ? fs.readdirSync(dir, { withFileTypes: true }) : [];
}

function collectArtifacts(bundle: string, namespace: string, target: Target): Artifact[] {
  const artifacts = new Map<string, Artifact>();
  const out = path.dirname(bundle);
  const add = (kind: ArtifactKind, name: string, source: string, sharedDefaultAgent?: boolean) => {
    const relative = `${kind}/${name}`;
    if (!validInstallPath(relative)) throw new Error(`Invalid Gemini install path: ${relative}`);
    if (artifacts.has(relative)) {
      throw new Error(`Duplicate Gemini install path: ${relative}`);
    }
    artifacts.set(relative, { kind, relative, source, sharedDefaultAgent });
  };

  for (const entry of entries(bundle)) {
    if (!isArtifactName(entry.name)) continue;
    const source = path.join(bundle, entry.name);
    if (fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
      add('skills', entry.name, source);
    }
  }

  const commands = path.join(out, 'commands');
  const suite = `${namespace}.toml`;
  const suiteFile = path.join(commands, suite);
  if (fs.statSync(suiteFile, { throwIfNoEntry: false })?.isFile()) {
    add('commands', suite, suiteFile);
  }
  const walkCommands = (dir: string, prefix: string) => {
    for (const entry of entries(dir)) {
      const file = path.join(dir, entry.name);
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walkCommands(file, name);
      else if (entry.name.endsWith('.toml') && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
        add('commands', name, file);
      }
    }
  };
  walkCommands(path.join(commands, namespace), namespace);

  const agents = path.join(out, target.agentsOutDir);
  const defaultAgentFiles = new Set(target.customAgents.map(({ name }) => `${name}.md`));
  for (const dir of [agents, path.join(agents, namespace)]) {
    for (const entry of entries(dir)) {
      const file = path.join(dir, entry.name);
      if (entry.name.endsWith('.md') && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
        add('agents', entry.name, file, dir === agents && defaultAgentFiles.has(entry.name));
      }
    }
  }
  return [...artifacts.values()];
}

function validInstallPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const [kind, ...parts] = value.split('/');
  if (!parts.length || !parts.every(isArtifactName)) return false;
  if (kind === 'skills') return parts.length === 1;
  if (kind === 'agents') return parts.length === 1 && parts[0].endsWith('.md');
  return kind === 'commands' && parts.at(-1)!.endsWith('.toml');
}

function readOwnership(file: string): OwnedArtifact[] {
  if (!fs.existsSync(file)) return [];
  const records: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(records) || !records.every((entry) =>
    entry && isArtifactName(entry.namespace) && validInstallPath(entry.relative) &&
    typeof entry.digest === 'string' && /^[0-9a-f]{64}$/.test(entry.digest) &&
    (entry.sharedDefaultAgent === undefined || typeof entry.sharedDefaultAgent === 'boolean'),
  )) {
    throw new Error(`Invalid Gemini install ownership: ${file}`);
  }
  return records;
}

function digestArtifact(file: string): string | undefined {
  const first = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!first) return undefined;
  const hash = createHash('sha256');
  const walk = (entry: string, relative: string, stats: fs.Stats) => {
    hash.update(JSON.stringify([relative, stats.mode, stats.isFile() ? stats.size : 0]) + '\n');
    if (stats.isDirectory()) {
      for (const child of fs.readdirSync(entry).sort()) {
        const full = path.join(entry, child);
        walk(full, `${relative}/${child}`, fs.lstatSync(full));
      }
    } else if (stats.isFile()) {
      hash.update(fs.readFileSync(entry));
    } else if (stats.isSymbolicLink()) {
      hash.update(JSON.stringify(fs.readlinkSync(entry)) + '\n');
    }
  };
  walk(file, '', first);
  return hash.digest('hex');
}

function checkParents(root: string, relative: string): void {
  let dir = root;
  for (const part of relative.split('/').slice(0, -1)) {
    dir = path.join(dir, part);
    const stats = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stats) return;
    if (!stats.isDirectory()) throw new Error(`Gemini install path is not a directory: ${dir}`);
  }
}

/** Stage the complete update and restore existing artifacts if any move fails. */
function commitChanges(changes: Change[], installed: OwnedArtifact[], stateFile: string, stage: string): void {
  const nextState = path.join(stage, 'installed.json');
  fs.writeFileSync(nextState, `${JSON.stringify(installed, null, 2)}\n`);
  const applied: Array<{ destination: string; backup?: string; placed: boolean }> = [];
  try {
    for (const [index, { destination, current, staged }] of changes.entries()) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (digestArtifact(destination) !== current) {
        throw new Error(`Gemini install path changed during installation: ${destination}`);
      }
      const backup = current === undefined ? undefined : path.join(stage, `backup-${index}`);
      if (backup) fs.renameSync(destination, backup);
      const change = { destination, backup, placed: false };
      applied.push(change);
      if (staged) {
        fs.renameSync(staged, destination);
        change.placed = true;
      }
    }
    fs.renameSync(nextState, stateFile);
  } catch (error) {
    try {
      for (const { destination, backup, placed } of applied.reverse()) {
        if (placed) fs.rmSync(destination, { recursive: true });
        if (backup) fs.renameSync(backup, destination);
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Gemini install rollback failed. Backups are in ${stage}`);
    }
    throw error;
  }
}

export function installGeminiBundle(
  bundle: string,
  home: string,
  namespace: string,
  target: Target,
  metadata?: BundleMetadata,
): InstallResult {
  if (!isArtifactName(namespace)) throw new Error(`Invalid Gemini bundle namespace: ${namespace}`);
  const artifacts = collectArtifacts(bundle, namespace, target);
  const preservedEdits: string[] = [];
  const stats: InstallResult = {
    dest: path.join(home, target.skillsDir),
    skillsInstalled: artifacts.filter(({ kind, source }) =>
      kind === 'skills' && fs.existsSync(path.join(source, 'SKILL.md')),
    ).length,
    commands: artifacts.filter(({ kind }) => kind === 'commands').length,
    agents: artifacts.filter(({ kind }) => kind === 'agents').length,
    preservedEdits,
  };
  if (metadata?.commands !== undefined && stats.commands !== metadata.commands) {
    throw new Error(
      `Gemini bundle declares ${metadata.commands} command(s), found ${stats.commands}. Keep its commands directory beside the bundle.`,
    );
  }
  const declaredEmpty = metadata?.commands === 0 && metadata.skills.length === 0;
  if (!stats.skillsInstalled && !stats.commands && !declaredEmpty) {
    throw new Error(`Gemini bundle has no skills or commands: ${bundle}`);
  }

  const config = path.dirname(stats.dest);
  const stateDir = path.join(config, '.agent-skill-bundler');
  checkParents(config, '.agent-skill-bundler/installed.json');
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = path.join(stateDir, 'install.lock');
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(`Gemini installation is locked at ${lock}`);
  }

  let removeStage = true;
  try {
    const stateFile = path.join(stateDir, 'installed.json');
    const previous = readOwnership(stateFile);
    const installed = previous.filter((entry) => entry.namespace !== namespace).map((entry) => ({ ...entry }));
    const changes: Change[] = [];
    const incoming = new Set<string>();
    for (const [index, { kind, relative, source, sharedDefaultAgent }] of artifacts.entries()) {
      checkParents(config, relative);
      incoming.add(relative);
      const destination = path.join(config, relative);
      const current = digestArtifact(destination);
      const staged = path.join(lock, `incoming-${index}`);
      fs.cpSync(source, staged, { recursive: true, dereference: true });
      const digest = digestArtifact(staged)!;
      const owners = previous.filter((entry) => entry.relative === relative);
      if (current !== undefined && !owners.length) {
        // An identical personal agent can be reused without claiming ownership.
        if (kind === 'agents' && current === digest) continue;
        throw new Error(`Gemini install collision for existing untracked artifact ${relative}`);
      }
      if (current !== undefined && owners.some((entry) => entry.digest !== current)) {
        throw new Error(`Gemini install collision for modified artifact ${relative}`);
      }
      const others = owners.filter((entry) => entry.namespace !== namespace);
      if (others.length && (kind !== 'agents' || others.some((entry) => entry.digest !== digest))) {
        // A reinstall can upgrade an unmodified shared default in one transaction.
        // Legacy records lack the scope flag. A known default with matching
        // owner digests can migrate unless an owner is explicitly plugin-specific.
        if (!sharedDefaultAgent || current === undefined || owners.length === others.length ||
            owners.some((entry) => entry.sharedDefaultAgent === false)) {
          throw new Error(`Gemini install collision for ${relative}, owned by ${others[0].namespace}`);
        }
        for (const owner of installed) {
          if (owner.relative === relative) {
            owner.digest = digest;
            owner.sharedDefaultAgent = true;
          }
        }
      }
      if (current !== digest) changes.push({ destination, current, staged });
      installed.push({ namespace, relative, digest, sharedDefaultAgent });
    }

    for (const entry of previous) {
      const { relative } = entry;
      if (entry.namespace !== namespace || incoming.has(relative) ||
          installed.some((owner) => owner.relative === relative)) continue;
      checkParents(config, relative);
      const destination = path.join(config, relative);
      const current = digestArtifact(destination);
      // Preserve files edited by the user since they were installed.
      if (current === entry.digest) changes.push({ destination, current });
      else if (current !== undefined) preservedEdits.push(destination);
    }

    commitChanges(changes, installed, stateFile, lock);
  } catch (error) {
    if (error instanceof AggregateError) removeStage = false;
    throw error;
  } finally {
    if (removeStage) fs.rmSync(lock, { recursive: true, force: true });
  }
  return stats;
}
