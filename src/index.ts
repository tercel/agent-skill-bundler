#!/usr/bin/env node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { convertPlugin, pluginSkillNames, writeCustomAgents } from './convert.js';
import { getTarget, type Target } from './targets.js';

interface Args {
  _: string[];
  out?: string;
  target: string;
  targetExplicit: boolean;
  strict: boolean;
  home?: string;
}

function parse(argv: string[]): Args {
  const a: Args = { _: [], target: 'codex', targetExplicit: false, strict: true };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--out') a.out = argv[++i];
    else if (t === '--target') {
      a.target = argv[++i];
      a.targetExplicit = true;
    } else if (t === '--no-strict') a.strict = false;
    else if (t === '--home' || t === '--codex-home') a.home = argv[++i];
    else if (t === '-h' || t === '--help') a._.push('help');
    else a._.push(t);
  }
  return a;
}

function usage(): void {
  process.stdout.write(`agent-skill-bundler — port Claude Code skill plugins to other agent platforms

Usage:
  agent-skill-bundler convert <pluginDir...> [--out <dir>] [--target codex|opencode] [--no-strict]
  agent-skill-bundler verify  <bundleDir> [--target codex|opencode] [--home <path>]
  agent-skill-bundler install <bundleDir> [--target codex|opencode] [--home <path>]

Targets:
  codex     ~/.agents/skills; namespaced skill names (<ns>:<alias>); no commands.
  opencode  ~/.config/opencode/skills + ~/.config/opencode/commands; prefixed IDs
            (<ns>-<alias>) because OpenCode has no plugin namespace; Claude
            commands become /<ns>/<command>; custom agents become markdown.

Notes:
  convert  fails (exit 1) if any conversion gate is violated, unless --no-strict.
  verify   installs into a throwaway HOME and asserts the target discovers every
           skill. Codex uses 'codex debug prompt-input' (no model call); OpenCode
           gets a static layout check mirroring its documented scan rules.
  install  installs the bundle into the target's global config dir (Codex
           symlinks, OpenCode copies) and its sibling commands/agents.
`);
}

function cmdConvert(a: Args): number {
  const target = getTarget(a.target);
  // Default output dir is `out/<target>` — deliberately NOT under `dist/`, which
  // holds the compiled tool and is the npm-published artifact. Keeping conversion
  // output separate means the published package never carries converted bundles.
  const out = path.resolve(a.out ?? path.join(process.cwd(), 'out', target.id));
  const plugins = a._.slice(1);
  if (plugins.length === 0) {
    process.stderr.write('convert: need at least one plugin directory\n');
    return 1;
  }
  // Pre-pass: learn every plugin's skill names so cross-PLUGIN refs can be
  // validated (e.g. code-forge referencing its sibling spec-forge skills).
  const known = new Map<string, Set<string>>();
  for (const p of plugins) {
    try {
      const { ns, names } = pluginSkillNames(path.resolve(p), target);
      known.set(ns, names);
    } catch {
      /* ignore: unknown/invalid plugin reported during convert */
    }
  }

  let bad = 0;
  for (const p of plugins) {
    const r = convertPlugin(path.resolve(p), target, out, known);
    const cmdPart = target.commandsDir ? `  commands: ${r.commands}` : '';
    process.stdout.write(
      `\n✓ ${r.ns} -> ${path.relative(process.cwd(), r.bundleDir)}\n` +
        `  skills: ${r.skills.length}${cmdPart}  inlined: ${r.inlined}  ` +
        `cross-refs: ${r.crossRefs}  subagents-adapted: ${r.subagents}\n`,
    );
    if (r.violations.length) {
      bad += r.violations.length;
      process.stdout.write(`  ✗ ${r.violations.length} gate violation(s):\n`);
      for (const v of r.violations) process.stdout.write(`    - ${v}\n`);
    } else {
      process.stdout.write(`  ✓ all gates passed (no dangling includes / refs)\n`);
    }
    for (const w of r.warnings) process.stdout.write(`  ⚠ ${w}\n`);
  }
  // Emit custom agents once (shared across bundles; installed to the target's
  // global agents dir).
  const agents = writeCustomAgents(out, target);
  if (agents.length) {
    process.stdout.write(
      `\n✓ ${agents.length} custom agent(s) -> ${path.relative(process.cwd(), path.join(out, target.agentsOutDir))}/\n` +
        `  ${target.customAgents.map((x) => x.name).join(', ')}\n` +
        `  install with: agent-skill-bundler install <bundle>  (also copies agents to ~/${target.agentsInstallDir})\n`,
    );
  }
  if (bad && a.strict) {
    process.stderr.write(`\nFAILED: ${bad} gate violation(s). Use --no-strict to emit anyway.\n`);
    return 1;
  }
  return 0;
}

/** A directory check that follows symlinks (installs use symlinked bundles). */
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Install a bundle into the target's global config: Codex symlinks it into
 * ~/.agents/skills and copies ~/.codex/agents; OpenCode copies it into
 * ~/.config/opencode/skills plus commands and agents (its scanner is not
 * documented to follow symlinked sources).
 */
function installBundle(
  bundle: string,
  home: string,
  target: Target,
): { dest: string; agents: number; commands: number } {
  const ns = path.basename(bundle);
  const outRoot = path.dirname(bundle);

  const skillsDestRoot = path.join(home, target.skillsDir);
  fs.mkdirSync(skillsDestRoot, { recursive: true });
  const dest = path.join(skillsDestRoot, ns);
  fs.rmSync(dest, { recursive: true, force: true });
  if (target.layout === 'rootless') {
    // OpenCode's scanner is documented to stop at a SKILL.md but says nothing
    // about symlinked sources; copy so discovery never depends on that.
    fs.cpSync(bundle, dest, { recursive: true, dereference: true });
  } else {
    fs.symlinkSync(bundle, dest);
  }

  let agents = 0;
  if (target.agentFormat) {
    const ext = target.agentFormat === 'toml' ? '.toml' : '.md';
    const agentsSrc = path.join(outRoot, target.agentsOutDir);
    if (fs.existsSync(agentsSrc)) {
      const agentsDest = path.join(home, target.agentsInstallDir);
      fs.mkdirSync(agentsDest, { recursive: true });
      for (const f of fs.readdirSync(agentsSrc)) {
        if (!f.endsWith(ext)) continue;
        fs.copyFileSync(path.join(agentsSrc, f), path.join(agentsDest, f));
        agents++;
      }
    }
  }

  // OpenCode commands are emitted as <out>/commands/<ns>.md (suite entry) and
  // <out>/commands/<ns>/<cmd>.md (nested -> /<ns>/<cmd>). Install only this ns.
  let commands = 0;
  if (target.commandsDir) {
    const cmdSrcRoot = path.join(outRoot, 'commands');
    if (fs.existsSync(cmdSrcRoot)) {
      const cmdDestRoot = path.join(home, target.commandsDir);
      fs.mkdirSync(cmdDestRoot, { recursive: true });
      for (const e of fs.readdirSync(cmdSrcRoot, { withFileTypes: true })) {
        if (e.name !== ns && e.name !== `${ns}.md`) continue;
        const src = path.join(cmdSrcRoot, e.name);
        const dst = path.join(cmdDestRoot, e.name);
        fs.rmSync(dst, { recursive: true, force: true });
        fs.cpSync(src, dst, { recursive: true, dereference: true });
        commands++;
      }
    }
  }

  return { dest, agents, commands };
}

/** Skill names the target will expose once the bundle is installed. */
function expectedSkillNames(bundle: string, target: Target): Set<string> {
  const ns = path.basename(bundle);
  const names = new Set<string>();
  if (target.nameStyle === 'prefix') {
    // Rootless: <bundle>/<ns>/SKILL.md is the orchestrator; every sibling dir
    // with SKILL.md is a sub-skill and its dir name is the ID.
    if (fs.existsSync(path.join(bundle, ns, 'SKILL.md'))) names.add(ns);
    for (const e of fs.readdirSync(bundle, { withFileTypes: true })) {
      if (e.name === ns) continue;
      if (isDir(path.join(bundle, e.name)) && fs.existsSync(path.join(bundle, e.name, 'SKILL.md'))) {
        names.add(e.name);
      }
    }
    return names;
  }
  names.add(`${ns}:${ns}`);
  for (const e of fs.readdirSync(bundle, { withFileTypes: true })) {
    if (isDir(path.join(bundle, e.name)) && fs.existsSync(path.join(bundle, e.name, 'SKILL.md'))) {
      names.add(`${ns}:${e.name}`);
    }
  }
  return names;
}

/**
 * Mirror OpenCode's documented skill scan: root-level *.md plus any nested dir
 * with SKILL.md (the leaf dir name is the ID); stop descending at a SKILL.md,
 * skip hidden/node_modules, and stop six levels below the source root.
 */
function discoverOpenCodeSkills(root: string): Set<string> {
  const ids = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (isDir(p)) {
        if (fs.existsSync(path.join(p, 'SKILL.md'))) ids.add(e.name);
        else walk(p, depth + 1);
      } else if (depth === 0 && e.name.endsWith('.md')) {
        ids.add(e.name.replace(/\.md$/, ''));
      }
    }
  };
  walk(root, 0);
  return ids;
}

/** Infer the target from a bundle's shape unless --target was given. */
function targetForBundle(a: Args, bundle: string): Target {
  if (a.targetExplicit) return getTarget(a.target);
  const ns = path.basename(bundle);
  if (fs.existsSync(path.join(bundle, 'SKILL.md'))) return getTarget('codex');
  if (fs.existsSync(path.join(bundle, ns, 'SKILL.md'))) return getTarget('opencode');
  return getTarget(a.target);
}

function isBundle(bundle: string, target: Target): boolean {
  const ns = path.basename(bundle);
  return target.layout === 'rootless'
    ? fs.existsSync(path.join(bundle, ns, 'SKILL.md'))
    : fs.existsSync(path.join(bundle, 'SKILL.md'));
}

function cmdInstall(a: Args): number {
  const bundle = path.resolve(a._[1] ?? '');
  const target = targetForBundle(a, bundle);
  if (!isBundle(bundle, target)) {
    process.stderr.write(
      `install: ${bundle} is not a ${target.id} bundle ` +
        `(expected ${target.layout === 'rootless' ? '<ns>/SKILL.md' : 'SKILL.md'})\n`,
    );
    return 1;
  }
  const home = a.home ?? os.homedir();
  const { dest, agents, commands } = installBundle(bundle, home, target);
  const ns = path.basename(bundle);
  process.stdout.write(`Installed ${dest} -> ${bundle}\n`);
  if (commands) process.stdout.write(`Installed ${commands} command entr${commands === 1 ? 'y' : 'ies'} -> ${path.join(home, target.commandsDir ?? '')}\n`);
  if (agents) process.stdout.write(`Installed ${agents} custom agent(s) -> ${path.join(home, target.agentsInstallDir)}\n`);
  if (target.id === 'codex') {
    process.stdout.write(`Restart Codex, then use /skills or name a skill like ${ns}:idea.\n`);
  } else {
    process.stdout.write(
      `OpenCode reloads automatically; invoke /${ns}/<command> or load skill ${ns}-<skill> via the skill tool.\n`,
    );
  }
  return 0;
}

/**
 * Runtime verify. Codex: install into a throwaway HOME, render its model-visible
 * prompt (no model call), assert every skill was discovered. OpenCode has no
 * equivalent prompt dump, so mirror its documented scan rules statically.
 */
function cmdVerify(a: Args): number {
  const bundle = path.resolve(a._[1] ?? '');
  const target = targetForBundle(a, bundle);
  if (!isBundle(bundle, target)) {
    process.stderr.write(
      `verify: ${bundle} is not a ${target.id} bundle ` +
        `(expected ${target.layout === 'rootless' ? '<ns>/SKILL.md' : 'SKILL.md'})\n`,
    );
    return 1;
  }
  if (target.id === 'codex') {
    try {
      execFileSync('codex', ['--version'], { stdio: 'ignore' });
    } catch {
      process.stdout.write('verify: codex CLI not found — skipping runtime check.\n');
      return 0;
    }
  }
  const expected = expectedSkillNames(bundle, target);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skill-bundler-verify-'));
  try {
    const { commands } = installBundle(bundle, tmp, target);
    const root = path.join(tmp, target.skillsDir);

    let found: Set<string>;
    if (target.id === 'codex') {
      const out = execFileSync('codex', ['debug', 'prompt-input', 'x'], {
        env: { ...process.env, HOME: tmp },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const ns = path.basename(bundle);
      found = new Set<string>();
      for (const m of out.matchAll(new RegExp(`\\b(${ns}:[a-z][a-z0-9-]*)`, 'g'))) found.add(m[1]);
    } else {
      found = discoverOpenCodeSkills(root);
    }

    const ns = path.basename(bundle);
    const missing = [...expected].filter((n) => !found.has(n)).sort();
    process.stdout.write(
      `verify ${ns} (${target.id}): expected ${expected.size}, ` +
        `discovered ${[...found].filter((n) => expected.has(n)).length}\n`,
    );
    if (missing.length) {
      for (const m of missing) process.stdout.write(`  ✗ not discovered by ${target.id}: ${m}\n`);
      process.stderr.write(`FAILED: ${missing.length} skill(s) not discovered.\n`);
      return 1;
    }
    if (target.id === 'opencode') {
      process.stdout.write(
        `  ✓ layout matches OpenCode's scan rules` +
          `${commands ? ` (${commands} command entr${commands === 1 ? 'y' : 'ies'})` : ''}\n`,
      );
    } else {
      process.stdout.write(`  ✓ all skills discovered & loaded by Codex (no model call)\n`);
    }
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main(): number {
  const a = parse(process.argv.slice(2));
  const cmd = a._[0];
  if (!cmd || cmd === 'help') {
    usage();
    return cmd ? 0 : 1;
  }
  switch (cmd) {
    case 'convert':
      return cmdConvert(a);
    case 'install':
      return cmdInstall(a);
    case 'verify':
      return cmdVerify(a);
    default:
      process.stderr.write(`Unknown command: ${cmd}\n`);
      usage();
      return 1;
  }
}

process.exit(main());
