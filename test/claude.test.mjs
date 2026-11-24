import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readClaudePlugin } from '../dist/claude.js';

function fixture(t, manifest) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-claude-')));
  const dir = path.join(parent, 'example');
  fs.mkdirSync(dir);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  function write(file, markdown) {
    const destination = path.join(dir, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, markdown);
  }

  if (manifest) write('.claude-plugin/plugin.json', JSON.stringify({ name: 'demo', ...manifest }));
  return { dir, write };
}

test('discovers default skills plus manifest skills from a collection and a direct directory', (t) => {
  const { dir, write } = fixture(t, { skills: ['./extra/', './single', './skills/'] });
  write('skills/default/SKILL.md', '---\r\nname: demo:renamed\r\n---\r\nDefault skill.\r\n');
  write('extra/custom/SKILL.md', 'Custom skill.');
  write('single/SKILL.md', 'Single skill.');

  const { ns, skills } = readClaudePlugin(dir);
  assert.equal(ns, 'demo');
  assert.deepEqual(skills.map(({ name, dir: source, root, invocationName }) =>
    [name, path.relative(dir, source), root, invocationName]), [
    ['custom', path.join('extra', 'custom'), false, 'custom'],
    ['default', path.join('skills', 'default'), false, 'renamed'],
    ['single', 'single', false, 'single'],
  ]);
});

test('loads a plugin-root skill with or without a manifest', (t) => {
  const standalone = fixture(t);
  standalone.write('SKILL.md', '---\nname: standalone\n---\nStandalone skill.\n');
  const plain = readClaudePlugin(standalone.dir);
  assert.equal(plain.ns, 'example');
  assert.deepEqual(plain.skills, [
    { name: 'example', invocationName: 'standalone', dir: standalone.dir, root: true },
  ]);

  const explicit = fixture(t, { skills: '.' });
  explicit.write('SKILL.md', 'Root skill.');
  explicit.write('skills/other/SKILL.md', 'Other skill.');
  const plugin = readClaudePlugin(explicit.dir);
  assert.deepEqual(plugin.skills.map(({ name, invocationName, root }) => [name, invocationName, root]), [
    ['demo', 'demo', true],
    ['other', 'other', false],
  ]);
});

test('discovers commands in subdirectories and honours nested invocation names', (t) => {
  const { dir, write } = fixture(t, {});
  write('commands/show.md', 'Show this.');
  write('commands/db/migrate.md', 'Migrate this database.');
  const { commands } = readClaudePlugin(dir);
  assert.deepEqual(commands.map(({ name, markdown }) => [name, markdown]), [
    ['db:migrate', 'Migrate this database.'], ['show', 'Show this.'],
  ]);
  assert.equal(commands[0].dir, path.join(dir, 'commands', 'db'));
});

test('manifest command directories and files replace the default command directory', (t) => {
  const { dir, write } = fixture(t, { commands: ['./other/', './extra/show.md'] });
  write('other/data/export.md', 'Export this.');
  write('extra/show.md', 'Show this.');
  write('commands/ignored.md', 'Ignored.');
  const { commands } = readClaudePlugin(dir);
  assert.deepEqual(commands.map(({ name }) => name), ['data:export', 'show']);
});

test('manifest command maps read inline and sourced Markdown along with overrides', (t) => {
  const { dir, write } = fixture(t, { commands: {
    about: { content: 'Describe this plugin.', description: 'Manifest description', argumentHint: '[subject]' },
    'data:export': { source: './tools/export.md', model: 'haiku', allowedTools: ['Read'] },
  } });
  write('tools/export.md', '---\ndescription: File metadata\n---\nExport.');
  const { commands } = readClaudePlugin(dir);
  assert.deepEqual(commands.map(({ name, dir: basedir, markdown, inline, metadata }) => ({ name, basedir, markdown, inline, metadata })), [
    { name: 'about', basedir: dir, markdown: 'Describe this plugin.', inline: true, metadata: { description: 'Manifest description', 'argument-hint': '[subject]' } },
    { name: 'data:export', basedir: path.join(dir, 'tools'), markdown: '---\ndescription: File metadata\n---\nExport.', inline: false, metadata: { model: 'haiku', 'allowed-tools': ['Read'] } },
  ]);
});

test('rejects traversal and symlinks outside the plugin for manifest entries', (t) => {
  const { dir, write } = fixture(t, { commands: '../outside.md' });
  const outside = path.join(path.dirname(dir), 'outside.md');
  fs.writeFileSync(outside, 'Outside.');
  assert.throws(() => readClaudePlugin(dir), /commands.*\.\.\/outside\.md/);

  write('.claude-plugin/plugin.json', JSON.stringify({ name: 'demo', commands: './external.md' }));
  fs.symlinkSync(outside, path.join(dir, 'external.md'));
  assert.throws(() => readClaudePlugin(dir), /commands.*external\.md.*outside the plugin/);
});

test('rejects distinct components with the same invocation name', (t) => {
  const { dir, write } = fixture(t, { skills: ['./extra/'] });
  write('extra/custom/SKILL.md', '---\nname: duplicate\n---\nCustom skill.');
  write('skills/default/SKILL.md', '---\nname: duplicate\n---\nDefault skill.');
  assert.throws(() => readClaudePlugin(dir), /Duplicate Claude skill name "duplicate"/);
});

test('requires exactly one source or content field per manifest command', (t) => {
  const { dir } = fixture(t, { commands: { invalid: { content: 'Inline.', source: './copy.md' } } });
  assert.throws(() => readClaudePlugin(dir), /commands\.invalid.*exactly one.*source.*content/);
});
