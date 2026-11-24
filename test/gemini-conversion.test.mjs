import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';

const cli = path.join(import.meta.dirname, '..', 'dist', 'index.js');

function fixture(t, manifest = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-gemini-conversion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'demo');
  const out = path.join(root, 'exports');
  const put = (relative, content) => {
    const dest = path.join(plugin, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  put('.claude-plugin/plugin.json', JSON.stringify({ name: 'demo', ...manifest }));
  return {
    put,
    plugin,
    out,
    bundle: path.join(out, 'demo'),
    convert: (...args) => run('convert', plugin, '--target', 'gemini', '--out', out, ...args),
    run,
  };
}

function frontmatter(filename) {
  return YAML.parse(fs.readFileSync(filename, 'utf8').match(/^---\n([\s\S]+?)\n---/)[1]);
}

test('Gemini emits descriptions for bare and CRLF Claude skills', (t) => {
  const f = fixture(t);
  f.put('skills/bare/SKILL.md', 'Show the configuration.\n');
  f.put('skills/windows/SKILL.md', '---\r\nname: windows\r\ndescription: Document Windows.\r\n---\r\nContent.\r\n');
  const result = f.convert();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(frontmatter(path.join(f.bundle, 'demo-bare/SKILL.md')).description, 'Show the configuration.');
  assert.equal(frontmatter(path.join(f.bundle, 'demo-windows/SKILL.md')).description, 'Document Windows.');
});

test('Gemini emits manual-only skills as slash commands and rejects unsupported fork execution', (t) => {
  const f = fixture(t);
  f.put('skills/publish/SKILL.md', '---\ndescription: Publish only by request.\ndisable-model-invocation: true\n---\nPublish $ARGUMENTS.\n');
  f.put('skills/forked/SKILL.md', '---\ndescription: Isolated work.\ncontext: fork\n---\nIsolated work.\n');
  const result = f.convert();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /forked\/SKILL\.md:.*context.*fork/);
  assert.ok(!fs.existsSync(path.join(f.bundle, 'demo-publish/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(f.bundle, 'demo-forked/SKILL.md')));
  assert.match(fs.readFileSync(path.join(f.out, 'commands/demo/publish.toml'), 'utf8'), /Publish \{\{args\}\}/);
});

test('Gemini resolves manifest sources and adapts current Claude Agent calls', (t) => {
  const f = fixture(t, {
    skills: ['./extra/'],
    commands: { about: { content: 'Explain this plugin.', description: 'About this plugin' } },
  });
  f.put('extra/report/SKILL.md', '---\ndescription: Summarize reports.\n---\nLaunch Agent(subagent_type="general-purpose", prompt="Summarize the results") for $ARGUMENTS.\n');
  f.put('commands/ignored.md', 'This command is replaced by the manifest.\n');
  const result = f.convert();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const skill = fs.readFileSync(path.join(f.bundle, 'demo-report/SKILL.md'), 'utf8');
  assert.match(skill, /a Gemini subagent \(generalist\).*Summarize the results/);
  assert.doesNotMatch(skill, /Agent\(subagent_type|\$ARGUMENTS/);
  assert.match(fs.readFileSync(path.join(f.out, 'commands/demo/about.toml'), 'utf8'), /Explain this plugin/);
  assert.ok(!fs.existsSync(path.join(f.out, 'commands/demo/ignored.toml')));
});

test('Gemini bundles shared references inside a skill and inlines command references', (t) => {
  const f = fixture(t);
  f.put('skills/check/SKILL.md', '---\ndescription: Check the report.\n---\nRead ../shared/guide.md.\n');
  f.put('skills/shared/guide.md', 'The guide. Read shared/details.md.\n');
  f.put('skills/shared/details.md', 'The details.\n');
  f.put('commands/check.md', 'Read ../skills/shared/guide.md before the check.\n');
  const result = f.convert();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const skillDir = path.join(f.bundle, 'demo-check');
  const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(skill, /references\/demo-shared\/guide\.md/);
  const bundled = fs.readFileSync(path.join(skillDir, 'references/demo-shared/guide.md'), 'utf8');
  assert.match(bundled, /The guide/);
  assert.match(bundled, /\.\/details\.md/);
  const command = fs.readFileSync(path.join(f.out, 'commands/demo/check.toml'), 'utf8');
  assert.match(command, /The guide/);
  assert.match(command, /The details/);
  assert.doesNotMatch(command, /\.\.\/skills\/shared|\.\.\/demo\/demo-shared/);
});

test('Gemini leaves project shared paths alone when the plugin has no shared resources', (t) => {
  const f = fixture(t);
  f.put('skills/check/SKILL.md', 'Check project files in `shared/types.ts`.\n');
  f.put('commands/check.md', 'Read the project file at `shared/types.ts`.\n');
  const result = f.convert();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(path.join(f.bundle, 'demo-check/SKILL.md'), 'utf8'), /shared\/types\.ts/);
  assert.match(fs.readFileSync(path.join(f.out, 'commands/demo/check.toml'), 'utf8'), /shared\/types\.ts/);
});

test('Gemini does not report a bundled shared directory as a missing skill', (t) => {
  const f = fixture(t);
  f.put('skills/check/SKILL.md', 'List the resources in `../shared/`.\n');
  f.put('skills/shared/guide.md', 'Guide.\n');
  const result = f.convert();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /cross-ref demo-shared/);
  assert.match(fs.readFileSync(path.join(f.bundle, 'demo-check/SKILL.md'), 'utf8'), /references\/demo-shared\/`/);
});

test('Gemini uses the plugin namespace for a root skill and for its manual command', (t) => {
  const f = fixture(t, { name: 'my-tool' });
  f.put('SKILL.md', 'Explain the root workflow.\n');
  f.put('references/details.md', 'Root skill resource.\n');
  const bundle = path.join(f.out, 'my-tool');
  const rootSkill = path.join(bundle, 'my-tool', 'SKILL.md');
  const automatic = f.convert();
  assert.equal(automatic.status, 0, automatic.stdout + automatic.stderr);
  assert.equal(frontmatter(rootSkill).description, 'Explain the root workflow.');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bundle, '.agent-skill-bundler.json'))).skills, ['my-tool']);
  assert.ok(fs.existsSync(path.join(bundle, 'my-tool/references/details.md')));
  assert.doesNotMatch(fs.readdirSync(bundle).join('\n'), /my-tool-demo/);
  assert.equal(f.run('verify', bundle).status, 0);

  f.put('SKILL.md', '---\ndisable-model-invocation: true\n---\nRun the root workflow manually.\n');
  const manual = f.convert();
  assert.equal(manual.status, 0, manual.stdout + manual.stderr);
  assert.ok(!fs.existsSync(rootSkill));
  assert.match(fs.readFileSync(path.join(f.out, 'commands/my-tool.toml'), 'utf8'), /Run the root workflow manually/);
  assert.equal(f.run('verify', bundle).status, 0);
});

test('Gemini warns about every unadapted subagent call in generated nested and suite commands', (t) => {
  const f = fixture(t);
  f.put('commands/db/show.md', 'Call Agent(subagent_type=selectedAgent) and Task(subagent_type=backupAgent).\n');
  f.put('commands/demo.md', 'Call Agent(\n  description="Choose (an agent)",\n  subagent_type=selectedAgent\n).\n');
  const result = f.convert();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /commands\/db\/show\.md: 2 unadapted Claude subagent calls?/);
  assert.match(result.stdout, /commands\/demo\.md: 1 unadapted Claude subagent calls?/);
});

test('Gemini commands can reference the shared resources of a plugin-root skill', (t) => {
  const f = fixture(t, { skills: '.' });
  f.put('SKILL.md', 'Use `skills/shared/tool.txt` in the root workflow.\n');
  f.put('skills/shared/tool.txt', 'Shared data.\n');
  f.put('commands/do.md', 'Read `skills/shared/tool.txt`.\n');
  const result = f.convert();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(f.bundle, 'demo/references/demo-shared/tool.txt'), 'utf8'), 'Shared data.\n');
  assert.match(fs.readFileSync(path.join(f.out, 'commands/demo/do.toml'), 'utf8'), /activate skill demo/);
  assert.equal(f.run('verify', f.bundle).status, 0);
});

test('Gemini keeps a compatible suite workflow but never puts a manual workflow in an auto-discovered skill', (t) => {
  const f = fixture(t);
  f.put('commands/demo.md', '---\ndescription: Suite workflow.\n---\nRun the suite workflow with $ARGUMENTS.\n');
  assert.equal(f.convert().status, 0);
  const orchestrator = path.join(f.bundle, 'demo/SKILL.md');
  assert.match(fs.readFileSync(orchestrator, 'utf8'), /Run the suite workflow with the arguments in the latest user request/);
  f.put('commands/demo.md', '---\ndisable-model-invocation: true\n---\nRun the manual workflow.\n');
  assert.equal(f.convert().status, 0);
  assert.doesNotMatch(fs.readFileSync(orchestrator, 'utf8'), /Run the manual workflow/);
  assert.match(fs.readFileSync(path.join(f.out, 'commands/demo.toml'), 'utf8'), /Run the manual workflow/);
});

test('Gemini preserves explicit shell payloads and keeps Claude path placeholders inert', (t) => {
  const f = fixture(t);
  f.put('commands/show.md', 'Use WebFetch. Input: @{feature_path}.\nShow !`printf "%s" "WebFetch"`.\n');
  const result = f.convert();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const cmd = fs.readFileSync(path.join(f.out, 'commands/demo/show.toml'), 'utf8');
  assert.match(cmd, /Use web_fetch\. Input: @<feature_path>\./);
  assert.ok(cmd.includes('!{printf \\"%s\\" \\"WebFetch\\"}'), cmd);
});

test('Gemini reports unsupported arguments and excludes the affected command even with --no-strict', (t) => {
  const f = fixture(t);
  f.put('commands/fix.md', 'First: $ARGUMENTS[0]. Second: $1.\n');
  const strict = f.convert();
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /cannot substitute Claude positional or named arguments.*\$ARGUMENTS\[0\]/);
  assert.ok(!fs.existsSync(path.join(f.out, 'commands/demo/fix.toml')));
  const partial = f.convert('--no-strict');
  assert.equal(partial.status, 0, partial.stdout + partial.stderr);
  assert.match(partial.stdout, /cannot substitute Claude positional/);
  assert.ok(!fs.existsSync(path.join(f.out, 'commands/demo/fix.toml')));
});

test('Gemini distinguishes renamed skill references from nested slash commands across plugins', (t) => {
  const source = fixture(t);
  const workspace = fixture(t, { name: 'tools' });
  workspace.put('commands/db/status.md', 'Show database status.\n');
  workspace.put('skills/catalog/SKILL.md', '---\nname: lookup\n---\nLook up a catalog entry.\n');
  source.put('skills/main/SKILL.md', 'Use /tools:lookup and tell the user to run /tools:db:status. Read `skills/catalog/SKILL.md`.\n');
  const result = source.run('convert', source.plugin, workspace.plugin, '--target', 'gemini', '--out', source.out);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const main = fs.readFileSync(path.join(source.bundle, 'demo-main/SKILL.md'), 'utf8');
  assert.match(main, /Use tools-catalog and tell the user to run \/tools:db:status/);
  assert.match(main, /Read `tools-catalog`/);
  assert.ok(fs.existsSync(path.join(source.out, 'commands/tools/db/status.toml')));
});
