import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lowerGeminiBody, normalizeGeminiSkill, serializeGeminiCommand } from '../dist/gemini.js';

test('normalizes required Gemini metadata and preserves portable catalog fields', () => {
  const result = normalizeGeminiSkill(
    { name: 'source', 'allowed-tools': 'Read', license: 'MIT', metadata: { author: 'example' } },
    '\r\n# Look up a term\r\n\r\nFind a definition.',
    'demo-lookup',
  );
  assert.deepEqual(result.data, {
    name: 'demo-lookup',
    description: '# Look up a term',
    license: 'MIT',
    metadata: { author: 'example' },
  });
  assert.deepEqual(result.violations, []);
  assert.match(result.warnings.join('\n'), /allowed-tools/);
  assert.ok(normalizeGeminiSkill({}, '', 'demo-empty').data.description);
  assert.equal(
    normalizeGeminiSkill({ description: 'Find a term.', when_to_use: 'Glossary questions.' }, '', 'demo-lookup').data.description,
    'Find a term.\n\nGlossary questions.',
  );
});

test('preserves manual invocation and rejects unenforceable skill restrictions', () => {
  const result = normalizeGeminiSkill({
    description: 'Summarize changes.',
    'disable-model-invocation': true,
    context: 'fork',
    'disallowed-tools': 'Bash',
  }, 'Summarize changes.', 'demo-summarize');
  assert.equal(result.manualOnly, true);
  assert.match(result.violations.join('\n'), /context: fork/);
  assert.match(result.violations.join('\n'), /disallowed-tools/);
  assert.equal(result.data.context, undefined);
  assert.equal(result.data['disable-model-invocation'], undefined);
  for (const value of ['YES', 'On', 1]) {
    assert.equal(normalizeGeminiSkill({ 'disable-model-invocation': value }, '', 'demo').manualOnly, true);
  }
  assert.match(
    lowerGeminiBody('Summarize changes.', { 'user-invocable': 'OFF' }, 'command').violations.join('\n'),
    /user-invocable: false/,
  );
});

test('lowers full arguments for a command and uses conversational input in a skill', () => {
  const source = 'Summarize `$ARGUMENTS` and report the result.';
  const command = lowerGeminiBody(source, {}, 'command');
  assert.deepEqual(command.violations, []);
  assert.match(command.body, /\{\{args\}\}/);
  const skill = lowerGeminiBody(source, {}, 'skill', 'demo-summarize');
  assert.deepEqual(skill.violations, []);
  assert.match(skill.body, /latest user request/);
  assert.doesNotMatch(skill.body, /\$ARGUMENTS|\{\{args\}\}/);
});

test('identifies indexed, named, and environment substitutions without pretending to expand them', () => {
  const source = 'Summarize $ARGUMENTS[0] and $1 for $issue in ${CLAUDE_SESSION_ID}.';
  for (const mode of ['command', 'skill']) {
    const result = lowerGeminiBody(source, { arguments: 'issue owner' }, mode);
    assert.match(result.violations.join('\n'), /\$ARGUMENTS\[0\].*\$1/s);
    assert.match(result.violations.join('\n'), /\$issue/);
    assert.match(result.violations.join('\n'), /CLAUDE_SESSION_ID/);
    assert.doesNotMatch(result.body, /\{\{args\}\}\[0\]/);
  }
});

test('preserves fenced SQL placeholders and ambiguous dollar amounts', () => {
  const source = 'Orders over $1000 require review.\n\n\x60\x60\x60sql\nSELECT $1;\n\x60\x60\x60';
  const result = lowerGeminiBody(source, {}, 'skill');
  assert.deepEqual(result.violations, []);
  assert.match(result.warnings.join('\n'), /\$1000/);
  assert.equal(result.body, source);
});

test('preserves explicit prices while recognizing zero-based Claude shorthand', () => {
  const prices = 'The cost is $0. Plans start at $1.50. The budget is $2 USD.';
  for (const mode of ['skill', 'command']) {
    const result = lowerGeminiBody(prices, {}, mode);
    assert.deepEqual(result.violations, []);
    assert.equal(result.body, prices);
    const use = lowerGeminiBody(prices + '\nSummarize the first input: $0.', {}, mode);
    assert.match(use.violations.join('\n'), /\(\$0\)/);
  }
  const args = { arguments: Array.from({ length: 11 }, (_, i) => 'arg' + i) };
  const bounds = lowerGeminiBody('Use $10, then $11.', args, 'command');
  assert.match(bounds.violations.join('\n'), /\(\$10\)/);
  assert.match(bounds.warnings.join('\n'), /\$11/);
});

test('describes the active bundled skill directory explicitly', () => {
  const source = 'Read `${CLAUDE_SKILL_DIR}/references/guide.md`.';
  const result = lowerGeminiBody(source, {}, 'skill', 'demo-reference');
  assert.deepEqual(result.violations, []);
  assert.match(result.body, /activate_skill/);
  assert.match(result.body, /SKILL_DIRECTORY\/references\/guide\.md/);
  assert.doesNotMatch(result.body, /CLAUDE_SKILL_DIR/);
  assert.match(lowerGeminiBody(source, {}, 'command').violations.join('\n'), /CLAUDE_SKILL_DIR/);
});

test('only explicit static Claude shell injection lowers to an active Gemini processor', () => {
  const source = 'List changes:\n\n!\x60git status --short\x60\n\n\x60\x60\x60!\ngit status --short\ngit diff --stat\n\x60\x60\x60';
  const result = lowerGeminiBody(source, {}, 'command');
  assert.deepEqual(result.violations, []);
  assert.match(result.body, /!\{git status --short\}/);
  assert.match(result.body, /!\{git status --short\ngit diff --stat\}/);
  assert.match(lowerGeminiBody(source, {}, 'skill').violations.join('\n'), /shell injection/);
  assert.match(lowerGeminiBody('!\x60printf "%s" $ARGUMENTS\x60', {}, 'command').violations.join('\n'), /shell injection/);
  assert.match(lowerGeminiBody('!\x60git status\x60', { shell: 'powershell' }, 'command').violations.join('\n'), /powershell/);
  assert.equal(lowerGeminiBody('KEY=!\x60example\x60', {}, 'command').body, 'KEY=!\x60example\x60');
});

test('rejects existing Gemini template processors in source command text', () => {
  const result = lowerGeminiBody('Examples: !{echo hello} @{some-file} {{args}}', {}, 'command');
  assert.match(result.violations.join('\n'), /already contains Gemini template syntax/);
});

test('serializes TOML quotes, backslashes, multiline values, and control characters losslessly', () => {
  const source = 'Path: C:\\demo\nDelimiter: """';
  const output = serializeGeminiCommand(source, 'line one\nline two\t\u007f');
  assert.equal(
    output,
    'description = "line one\\nline two\\t\\u007F"\nprompt = """\nPath: C:\\\\demo\nDelimiter: \\"\\"\\""""\n',
  );
});
