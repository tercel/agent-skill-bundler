import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

const CLI = path.join(import.meta.dirname, '..', 'dist', 'index.js');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-gemini-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function skill(dir, name, description = 'Test skill') {
  write(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# Test\n`,
  );
}

function legacyBundle(out, ns, extras = []) {
  const bundle = path.join(out, ns);
  for (const name of [ns, ...extras]) skill(path.join(bundle, name), name);
  return bundle;
}

function run(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function succeeds(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

test('Gemini skills-only bundle identifies its target in a custom output directory', (t) => {
  const root = workspace(t);
  const plugin = path.join(root, 'source');
  const out = path.join(root, 'portable');
  const home = path.join(root, 'home');
  write(path.join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"portable"}\n');
  skill(path.join(plugin, 'skills', 'show'), 'show');
  succeeds(run('convert', plugin, '--target', 'gemini', '--out', out));

  const bundle = path.join(out, 'portable');
  const relocated = path.join(root, 'renamed-bundle');
  fs.renameSync(bundle, relocated);
  succeeds(run('install', relocated, '--home', home));
  const installed = path.join(home, '.gemini', 'skills', 'portable-show', 'SKILL.md');
  assert.ok(fs.existsSync(installed));
  assert.match(succeeds(run('verify', relocated)), /verify portable \(gemini\)/);

  fs.rmSync(path.join(relocated, 'portable-show', 'SKILL.md'));
  const verify = run('verify', relocated);
  assert.equal(verify.status, 1);
  assert.match(verify.stdout, /not discovered by gemini: portable-show/);
  const reinstall = run('install', relocated, '--home', home);
  assert.equal(reinstall.status, 1);
  assert.match(reinstall.stderr, /Missing or invalid skill: portable-show/);
  assert.ok(fs.existsSync(installed));
});

test('Gemini verify rejects missing, malformed and mismatched skill metadata', (t) => {
  const out = path.join(workspace(t), 'gemini');
  const bundle = legacyBundle(out, 'check', ['check-no-desc', 'check-invalid', 'check-wrong']);
  write(path.join(bundle, 'check', 'SKILL.md'), '\uFEFF---\r\nname: check\r\ndescription: Valid CRLF\r\n---\r\n# Test\r\n');
  write(path.join(bundle, 'check-no-desc', 'SKILL.md'), '---\nname: check-no-desc\n---\n# Absent description\n');
  write(path.join(bundle, 'check-invalid', 'SKILL.md'), '---\nname: check-invalid\ndescription: [unfinished\n---\n# Bad YAML\n');
  skill(path.join(bundle, 'check-wrong'), 'other-name');

  const result = run('verify', bundle);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /expected 4, discovered 1/);
  for (const name of ['check-no-desc', 'check-invalid', 'check-wrong']) {
    assert.ok((result.stdout + result.stderr).includes(name));
  }
});

test('Gemini metadata permits a bundle whose only installable entry is a command', (t) => {
  const root = workspace(t);
  const out = path.join(root, 'output');
  const bundle = path.join(out, 'manual');
  const home = path.join(root, 'home');
  const metadataFile = path.join(bundle, '.agent-skill-bundler.json');
  const metadata = { target: 'gemini', namespace: 'manual', skills: [], commands: 1 };
  const source = path.join(out, 'commands', 'manual', 'show.toml');
  const installed = path.join(home, '.gemini', 'commands', 'manual', 'show.toml');
  write(metadataFile, JSON.stringify(metadata));
  write(source, 'prompt = "Show information"\n');

  succeeds(run('install', bundle, '--home', home));
  assert.ok(fs.existsSync(installed));
  assert.match(succeeds(run('verify', bundle)), /expected 0, discovered 0/);
  assert.equal(run('install', bundle, '--target', 'opencode', '--home', home).status, 1);

  fs.rmSync(source);
  assert.match(run('install', bundle, '--home', home).stderr, /declares 1 command/);
  assert.ok(fs.existsSync(installed));

  write(metadataFile, JSON.stringify({ ...metadata, commands: 0 }));
  succeeds(run('install', bundle, '--home', home));
  assert.ok(!fs.existsSync(installed));
});

test('Gemini install rejects a colliding skill without touching existing files', (t) => {
  const root = workspace(t);
  const out = path.join(root, 'gemini');
  const home = path.join(root, 'home');
  const first = legacyBundle(out, 'demo', ['demo-show']);
  const second = legacyBundle(out, 'demo-show', ['demo-show-other']);
  write(path.join(second, 'demo-show', 'SKILL.md'), '---\nname: demo-show\ndescription: Different owner\n---\n# Test\n');
  const existing = path.join(home, '.gemini', 'skills', 'demo-show', 'SKILL.md');
  succeeds(run('install', first, '--home', home));

  const result = run('install', second, '--home', home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /collision.*demo-show/i);
  assert.match(fs.readFileSync(existing, 'utf8'), /description: Test skill/);
  assert.ok(!fs.existsSync(path.join(home, '.gemini', 'skills', 'demo-show-other')));
});

test('Gemini install preflights unrelated commands and agents before copying skills', (t) => {
  const root = workspace(t);
  const out = path.join(root, 'gemini');
  const home = path.join(root, 'home');
  const bundle = legacyBundle(out, 'demo');
  const config = path.join(home, '.gemini');
  const command = path.join(config, 'commands', 'demo', 'show.toml');
  const agent = path.join(config, 'agents', 'reviewer.md');
  write(path.join(out, 'commands', 'demo', 'show.toml'), 'prompt = "bundled"\n');
  write(path.join(out, 'agents', 'reviewer.md'), '# Bundled reviewer\n');
  write(command, 'prompt = "personal"\n');
  write(agent, '# Personal reviewer\n');

  const first = run('install', bundle, '--home', home);
  assert.equal(first.status, 1);
  assert.match(first.stderr, /collision/i);
  assert.equal(fs.readFileSync(command, 'utf8'), 'prompt = "personal"\n');
  assert.ok(!fs.existsSync(path.join(config, 'skills', 'demo')));

  fs.rmSync(command);
  const second = run('install', bundle, '--home', home);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /collision.*reviewer\.md/i);
  assert.equal(fs.readFileSync(agent, 'utf8'), '# Personal reviewer\n');
  assert.ok(!fs.existsSync(path.join(config, 'skills', 'demo')));
});

test('Gemini reinstall removes only stale owned artifacts and shares identical agents', (t) => {
  const root = workspace(t);
  const out = path.join(root, 'gemini');
  const home = path.join(root, 'home');
  const bundle = legacyBundle(out, 'demo', ['demo-old', 'demo-edited']);
  const second = legacyBundle(out, 'second');
  const config = path.join(home, '.gemini');
  const obsolete = path.join(out, 'commands', 'demo', 'old.toml');
  const suite = path.join(out, 'commands', 'demo.toml');
  const reviewer = path.join(out, 'agents', 'reviewer.md');
  write(obsolete, 'prompt = "old"\n');
  write(suite, 'prompt = "suite"\n');
  write(reviewer, '# Bundled reviewer\n');
  succeeds(run('install', bundle, '--home', home));
  succeeds(run('install', second, '--home', home));
  write(path.join(config, 'commands', 'demo', 'unrelated.toml'), 'prompt = "personal"\n');
  skill(path.join(config, 'skills', 'demo-unrelated'), 'demo-unrelated');
  const added = path.join(config, 'skills', 'demo-edited', 'personal.md');
  write(added, 'Personal resource\n');

  fs.rmSync(path.join(bundle, 'demo-old'), { recursive: true });
  fs.rmSync(path.join(bundle, 'demo-edited'), { recursive: true });
  fs.rmSync(obsolete);
  fs.rmSync(suite);
  fs.rmSync(reviewer);
  assert.match(succeeds(run('install', bundle, '--home', home)), /Kept locally modified Gemini artifact .*demo-edited/);

  assert.ok(!fs.existsSync(path.join(config, 'skills', 'demo-old')));
  assert.ok(!fs.existsSync(path.join(config, 'commands', 'demo', 'old.toml')));
  assert.ok(!fs.existsSync(path.join(config, 'commands', 'demo.toml')));
  assert.ok(fs.existsSync(path.join(config, 'commands', 'demo', 'unrelated.toml')));
  assert.ok(fs.existsSync(path.join(config, 'skills', 'demo-unrelated', 'SKILL.md')));
  assert.equal(fs.readFileSync(added, 'utf8'), 'Personal resource\n');
  assert.ok(fs.existsSync(path.join(config, 'agents', 'reviewer.md')));

  succeeds(run('install', second, '--home', home));
  assert.ok(!fs.existsSync(path.join(config, 'agents', 'reviewer.md')));
});

test('Gemini reinstalls a shared default agent and updates every owner from legacy records', (t) => {
  const root = workspace(t);
  const out = path.join(root, 'gemini');
  const home = path.join(root, 'home');
  const first = legacyBundle(out, 'first');
  const second = legacyBundle(out, 'second');
  const config = path.join(home, '.gemini');
  const source = path.join(out, 'agents', 'reviewer.md');
  const installed = path.join(config, 'agents', 'reviewer.md');
  const ownership = path.join(config, '.agent-skill-bundler', 'installed.json');
  write(source, '# Original reviewer\n');
  succeeds(run('install', first, '--home', home));
  succeeds(run('install', second, '--home', home));

  // Older versions recorded the owner and digest without the artifact's scope.
  const legacy = JSON.parse(fs.readFileSync(ownership, 'utf8')).map(({ namespace, relative, digest }) => ({
    namespace, relative, digest,
  }));
  write(ownership, JSON.stringify(legacy));
  write(source, '# Updated reviewer\n');
  succeeds(run('install', first, '--home', home));
  assert.equal(fs.readFileSync(installed, 'utf8'), '# Updated reviewer\n');

  const owners = JSON.parse(fs.readFileSync(ownership, 'utf8')).filter(({ relative }) => relative === 'agents/reviewer.md');
  assert.deepEqual(owners.map(({ namespace }) => namespace).sort(), ['first', 'second']);
  assert.equal(new Set(owners.map(({ digest }) => digest)).size, 1);
  assert.notEqual(owners[0].digest, legacy.find(({ relative }) => relative === 'agents/reviewer.md').digest);
  succeeds(run('install', second, '--home', home));

  fs.rmSync(source);
  succeeds(run('install', first, '--home', home));
  assert.ok(fs.existsSync(installed));
  succeeds(run('install', second, '--home', home));
  assert.ok(!fs.existsSync(installed));
});

test('Gemini rejects a shared default agent upgrade when the installed file was edited', (t) => {
  const root = workspace(t);
  const out = path.join(root, 'gemini');
  const home = path.join(root, 'home');
  const first = legacyBundle(out, 'first');
  const second = legacyBundle(out, 'second');
  const source = path.join(out, 'agents', 'reviewer.md');
  const installed = path.join(home, '.gemini', 'agents', 'reviewer.md');
  const ownership = path.join(home, '.gemini', '.agent-skill-bundler', 'installed.json');
  write(source, '# Original reviewer\n');
  succeeds(run('install', first, '--home', home));
  succeeds(run('install', second, '--home', home));
  const records = fs.readFileSync(ownership, 'utf8');

  write(installed, '# Locally edited reviewer\n');
  write(source, '# Updated reviewer\n');
  const result = run('install', first, '--home', home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /collision.*modified artifact agents\/reviewer\.md/);
  assert.equal(fs.readFileSync(installed, 'utf8'), '# Locally edited reviewer\n');
  assert.equal(fs.readFileSync(ownership, 'utf8'), records);
});

test('Gemini does not upgrade over a separately owned plugin-specific agent', (t) => {
  const root = workspace(t);
  const firstOut = path.join(root, 'first', 'gemini');
  const secondOut = path.join(root, 'second', 'gemini');
  const home = path.join(root, 'home');
  const first = legacyBundle(firstOut, 'first');
  const second = legacyBundle(secondOut, 'second');
  const defaultAgent = path.join(firstOut, 'agents', 'reviewer.md');
  const pluginAgent = path.join(secondOut, 'agents', 'second', 'reviewer.md');
  const installed = path.join(home, '.gemini', 'agents', 'reviewer.md');
  write(defaultAgent, '# Original reviewer\n');
  write(pluginAgent, '# Original reviewer\n');
  succeeds(run('install', first, '--home', home));
  succeeds(run('install', second, '--home', home));

  write(defaultAgent, '# Updated reviewer\n');
  const result = run('install', first, '--home', home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /collision.*owned by second/);
  assert.equal(fs.readFileSync(installed, 'utf8'), '# Original reviewer\n');
});
