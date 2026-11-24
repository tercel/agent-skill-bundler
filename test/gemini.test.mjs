import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { convertPlugin, writeCustomAgents } from '../dist/convert.js';
import { GEMINI } from '../dist/targets.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'fixture-forge');
const CLI = path.join(import.meta.dirname, '..', 'dist', 'index.js');
const SPEC = { ns: 'fixture-forge', nonSkillDirs: ['shared'], aliases: {} };

function convert() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skill-bundler-gemini-'));
  const r = convertPlugin(FIXTURE, GEMINI, out, undefined, SPEC);
  writeCustomAgents(out, GEMINI);
  const bundle = path.join(out, 'fixture-forge');
  const foo = fs.readFileSync(path.join(bundle, 'fixture-forge-foo', 'SKILL.md'), 'utf8');
  return { r, foo, out, bundle };
}

test('gemini conversion passes all gates', () => {
  const { r } = convert();
  assert.deepEqual(r.violations, [], 'no gate violations');
});

test('bundle root has no SKILL.md (rootless container)', () => {
  const { bundle } = convert();
  assert.ok(!fs.existsSync(path.join(bundle, 'SKILL.md')), 'no root SKILL.md');
});

test('orchestrator and sub-skills are sibling dirs with prefixed IDs', () => {
  const { r, out } = convert();
  assert.ok(
    fs.existsSync(path.join(out, 'fixture-forge', 'fixture-forge', 'SKILL.md')),
    'orchestrator at <ns>/SKILL.md',
  );
  assert.ok(
    fs.existsSync(path.join(out, 'fixture-forge', 'fixture-forge-foo', 'SKILL.md')),
    'sub-skill at <ns>-<alias>/SKILL.md',
  );
  assert.deepEqual(r.skills, ['fixture-forge-foo']);
});

test('cross-refs become bare prefixed IDs, never colon names', () => {
  const { foo } = convert();
  assert.ok(foo.includes('spec-forge-prd'), 'cross-plugin ref uses prefixed ID');
  assert.ok(foo.includes('fixture-forge-foo'), 'self ref uses prefixed ID');
  assert.ok(foo.includes('spec-forge-tech-design'), 'bare colon ref uses prefixed ID');
  assert.ok(!/\b(?:spec|fixture)-forge:[a-z]/.test(foo), 'no colon namespace remains');
});

test('subagent delegation uses Gemini CLI wording', () => {
  const { foo, r } = convert();
  assert.ok(!/Task\(subagent_type/.test(foo), 'no raw Task site remains');
  assert.ok(foo.includes('a Gemini subagent ('), 'Gemini subagent phrasing');
  assert.equal(r.subagents, 1);
});

test('Claude commands become nested Gemini TOML commands with {{args}}', () => {
  const { r, out } = convert();
  const cmd = path.join(out, 'commands', 'fixture-forge', 'foo.toml');
  assert.ok(fs.existsSync(cmd), 'command emitted at commands/<ns>/<cmd>.toml');
  const text = fs.readFileSync(cmd, 'utf8');
  assert.equal(r.commands, 1, 'one command converted');
  assert.match(text, /^description = "Run foo on the supplied arguments"$/m, 'description is static');
  assert.match(text, /against \{\{args\}\}/, 'prompt interpolates the command arguments');
  assert.match(text, /^prompt = """\n/m, 'prompt formatted as TOML multiline string');
  assert.ok(!/\$ARGUMENTS/.test(text), 'no leftover $ARGUMENTS');
  assert.ok(!/allowed-tools|argument-hint/.test(text), 'Claude-only frontmatter dropped');
  assert.ok(text.includes('fixture-forge-foo'), 'slash ref rewritten to prefixed ID');
  assert.ok(text.includes('Shared Discipline'), 'include inlined into the command');
  assert.ok(!/@\.\.\/skills\/shared/.test(text), 'no dangling include remains');
});

test('Gemini custom agents emit markdown with name + description frontmatter', () => {
  const { out } = convert();
  const reviewer = path.join(out, 'agents', 'reviewer.md');
  assert.ok(fs.existsSync(reviewer), 'reviewer agent emitted');
  const text = fs.readFileSync(reviewer, 'utf8');
  assert.match(text, /^name: reviewer$/m, 'name frontmatter present');
  assert.match(text, /^description: /m, 'description frontmatter present');
  assert.ok(!/^mode:/m.test(text), 'no OpenCode-only mode field');
});

test('CLI install lays out flat 1-level skills and verify passes', () => {
  const { bundle } = convert();
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skill-bundler-gemini-home-'));
  try {
    execFileSync(process.execPath, [CLI, 'install', bundle, '--home', fakeHome], {
      encoding: 'utf8',
    });
    // Skills must be 1 directory deep under ~/.gemini/skills/
    assert.ok(
      fs.existsSync(path.join(fakeHome, '.gemini', 'skills', 'fixture-forge', 'SKILL.md')),
      'orchestrator installed flat at ~/.gemini/skills/<ns>/SKILL.md',
    );
    assert.ok(
      fs.existsSync(path.join(fakeHome, '.gemini', 'skills', 'fixture-forge-foo', 'SKILL.md')),
      'sub-skill installed flat at ~/.gemini/skills/<ns>-<alias>/SKILL.md',
    );
    assert.ok(
      !fs.existsSync(path.join(fakeHome, '.gemini', 'skills', 'fixture-forge', 'fixture-forge-foo')),
      'sub-skill is NOT nested 2 levels deep',
    );
    assert.ok(
      fs.existsSync(path.join(fakeHome, '.gemini', 'commands', 'fixture-forge', 'foo.toml')),
      'TOML command installed to ~/.gemini/commands/<ns>/<cmd>.toml',
    );
    assert.ok(
      fs.existsSync(path.join(fakeHome, '.gemini', 'agents', 'reviewer.md')),
      'custom agent installed to ~/.gemini/agents/reviewer.md',
    );

    const verifyOut = execFileSync(process.execPath, [CLI, 'verify', bundle], {
      encoding: 'utf8',
    });
    assert.match(verifyOut, /verify fixture-forge \(gemini\): expected 2, discovered 2/);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('CLI --version prints package version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  const out = execFileSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.equal(out.trim(), pkg.version);
});

test('Gemini summarizes repeated frontmatter warnings across multiple commands', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skill-bundler-gemini-warn-'));
  try {
    const plugin = path.join(tmp, 'multi-cmd');
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'multi-cmd' }));
    for (const name of ['a', 'b', 'c']) {
      fs.writeFileSync(
        path.join(plugin, 'commands', `${name}.md`),
        `---\ndescription: Run ${name}\nallowed-tools: [Read]\nargument-hint: "[arg]"\n---\n\nRun ${name} with $ARGUMENTS\n`,
      );
    }
    const r = convertPlugin(plugin, GEMINI, path.join(tmp, 'out'));
    assert.deepEqual(r.violations, []);
    const allowedWarnings = r.warnings.filter((w) => w.includes('allowed-tools'));
    const hintWarnings = r.warnings.filter((w) => w.includes('argument-hint'));
    assert.equal(allowedWarnings.length, 1);
    assert.match(allowedWarnings[0], /^3 file\(s\): /);
    assert.equal(hintWarnings.length, 1);
    assert.match(hintWarnings[0], /^3 file\(s\): /);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
