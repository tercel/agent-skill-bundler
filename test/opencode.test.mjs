import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertPlugin } from '../dist/convert.js';
import { OPENCODE } from '../dist/targets.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'fixture-forge');
const SPEC = { ns: 'fixture-forge', nonSkillDirs: ['shared'], aliases: {} };

function convert() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skill-bundler-opencode-'));
  const r = convertPlugin(FIXTURE, OPENCODE, out, undefined, SPEC);
  const bundle = path.join(out, 'fixture-forge');
  const foo = fs.readFileSync(path.join(bundle, 'fixture-forge-foo', 'SKILL.md'), 'utf8');
  return { r, foo, out, bundle };
}

test('opencode conversion passes all gates', () => {
  const { r } = convert();
  assert.deepEqual(r.violations, [], 'no gate violations');
});

test('bundle root has no SKILL.md (would hide every sub-skill)', () => {
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

test('cross-refs become bare path-derived IDs, never colon names', () => {
  const { foo } = convert();
  assert.ok(foo.includes('spec-forge-prd'), 'cross-plugin ref uses prefixed ID');
  assert.ok(foo.includes('fixture-forge-foo'), 'self ref uses prefixed ID');
  assert.ok(foo.includes('spec-forge-tech-design'), 'bare colon ref uses prefixed ID');
  assert.ok(!/\b(?:spec|fixture)-forge:[a-z]/.test(foo), 'no colon namespace remains');
});

test('subagent delegation uses OpenCode wording', () => {
  const { foo, r } = convert();
  assert.ok(!/Task\(subagent_type/.test(foo), 'no raw Task site remains');
  assert.ok(foo.includes('the `subagent` tool'), 'OpenCode subagent phrasing');
  assert.equal(r.subagents, 1);
});

test('Claude commands become nested OpenCode commands', () => {
  const { r, out } = convert();
  const cmd = path.join(out, 'commands', 'fixture-forge', 'foo.md');
  assert.ok(fs.existsSync(cmd), 'command emitted at commands/<ns>/<cmd>.md');
  const text = fs.readFileSync(cmd, 'utf8');
  assert.equal(r.commands, 1, 'one command converted');
  assert.match(text, /^description: /m, 'description kept');
  assert.ok(!/allowed-tools|argument-hint/.test(text), 'Claude-only frontmatter dropped');
  assert.ok(text.includes('$ARGUMENTS'), '$ARGUMENTS preserved');
  assert.ok(text.includes('fixture-forge-foo'), 'slash ref rewritten to prefixed ID');
  assert.ok(text.includes('Shared Discipline'), 'include inlined into the command');
  assert.ok(!/@\.\.\/skills\/shared/.test(text), 'no dangling include remains');
});
