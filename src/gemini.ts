interface GeminiDiagnostics {
  warnings: string[];
  violations: string[];
}

const PORTABLE_METADATA = ['license', 'compatibility', 'metadata'] as const;

/** Retain the portable metadata and identify Claude-only behavior that needs migration. */
export function normalizeGeminiSkill(
  data: Record<string, unknown>,
  body: string,
  name: string,
): GeminiDiagnostics & { data: Record<string, unknown>; manualOnly: boolean } {
  const warnings: string[] = [];
  const violations: string[] = [];
  const manualOnly = claudeBoolean(data['disable-model-invocation']) === true;
  const userHidden = claudeBoolean(data['user-invocable']) === false;
  const fallback = body.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  const description = typeof data.description === 'string' && data.description.trim()
    ? data.description
    : fallback ?? name;
  const trigger = typeof data.when_to_use === 'string' ? data.when_to_use.trim() : '';
  const metadata: Record<string, unknown> = {
    name,
    description: trigger ? description + '\n\n' + trigger : description,
  };

  for (const field of PORTABLE_METADATA) {
    if (Object.hasOwn(data, field)) metadata[field] = data[field];
  }
  if (data.context === 'fork') {
    violations.push('Claude context: fork requires isolated execution. Define and invoke an explicit Gemini subagent instead.');
  }
  if (manualOnly && userHidden) {
    violations.push('Claude disables both user and model invocation. Remove the entry or explicitly choose how Gemini may invoke it.');
  }
  for (const field of ['hooks', 'disallowed-tools', 'paths']) {
    if (hasSetting(data[field])) {
      violations.push('Claude ' + field + ' cannot be enforced per skill in Gemini. Migrate the setting before conversion.');
    }
  }
  if (hasSetting(data['allowed-tools'])) {
    warnings.push('Claude allowed-tools pre-approvals do not carry over. Gemini tool approval policies apply.');
  }
  for (const field of ['argument-hint', 'model', 'effort']) {
    if (hasSetting(data[field]) && (field !== 'model' || data[field] !== 'inherit')) {
      warnings.push('Gemini does not use the Claude ' + field + ' setting.');
    }
  }
  return { data: metadata, manualOnly, warnings, violations };
}

function claudeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(text)) return true;
  if (['false', 'no', 'off', '0'].includes(text)) return false;
  return undefined;
}

function hasSetting(value: unknown): boolean {
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

const INDEXED_ARGUMENT = /\$ARGUMENTS\[\d+\]/g;
const ARGUMENT_SHORTHAND = /\$\d+\b/g;
const PRICE_PREFIX = /\b(?:costs?|prices?|priced|budgets?|fees?|pay|paid|charge[sd]?)(?:\s+(?:is|are|was|were|of|at))?\s*[:=]?\s*$/i;
const PRICE_SUFFIX = /^(?:\.\d{2}\b|,\d{3}\b|\s+(?:USD|CAD|AUD|NZD|HKD|SGD)\b)/i;
const ORDINARY_CODE_FENCE = /^[ \t]*(\x60{3,}|~{3,})(?![!\x60~])[^\r\n]*\r?\n[\s\S]*?\r?\n[ \t]*\1[ \t]*(?=\r?$)/gm;
const ALL_ARGUMENTS = /\$ARGUMENTS\b(?!\[\d+\])/g;
const CLAUDE_VARIABLE = /\$\{CLAUDE_[A-Z0-9_]+\}/g;
const CLAUDE_SKILL_DIRECTORY = '${CLAUDE_SKILL_DIR}';
const GEMINI_PROCESSOR = /[!@]\{|\{\{args\}\}/;
const CLAUDE_SHELL_BLOCK = /^([ \t]*)\x60{3}![ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\x60{3}[ \t]*(?=\r?$)|(?<!\S)!\x60([^\x60\r\n]+)\x60/gm;

/** Transform prompt prose without changing any explicit Claude shell payloads. */
export function mapClaudePromptText(body: string, transform: (text: string) => string): string {
  let start = 0;
  const parts: string[] = [];
  for (const match of body.matchAll(CLAUDE_SHELL_BLOCK)) {
    parts.push(transform(body.slice(start, match.index)), match[0]);
    start = match.index + match[0].length;
  }
  return parts.join('') + transform(body.slice(start));
}

function argumentNames(data: Record<string, unknown>): Set<string> {
  const args = data.arguments;
  return new Set(
    (typeof args === 'string' ? args.trim().split(/\s+/) : Array.isArray(args) ? args : [])
      .filter((name): name is string => typeof name === 'string' && Boolean(name)),
  );
}

function uniqueMatches(body: string, pattern: RegExp): string[] {
  return [...new Set(body.match(pattern) ?? [])];
}

function hasBalancedBraces(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === '{') depth++;
    if (char === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

/** Translate only static Claude shell blocks whose payload can be preserved byte for byte. */
function lowerShellInjection(
  body: string,
  mode: 'skill' | 'command',
  data: Record<string, unknown>,
  named: Set<string>,
  violations: string[],
  render: (command: string) => string,
): string {
  const problems = new Set<string>();
  function lower(source: string, command: string): string {
    if (mode === 'skill') {
      problems.add('Gemini skill activation cannot run Claude shell injection. Move it to a Gemini custom command.');
      return source;
    }
    if (data.shell === 'powershell') {
      problems.add('Claude shell injection requires powershell. Wrap it in an explicit PowerShell command for Gemini.');
      return source;
    }
    if (
      uniqueMatches(command, INDEXED_ARGUMENT).length ||
      uniqueMatches(command, ARGUMENT_SHORTHAND).length ||
      uniqueMatches(command, ALL_ARGUMENTS).length ||
      uniqueMatches(command, CLAUDE_VARIABLE).length ||
      uniqueMatches(command, /\$[A-Za-z_]\w*/g).some((token) => named.has(token.slice(1)))
    ) {
      problems.add('Claude shell injection with runtime substitutions needs a Gemini command that explicitly handles quoting and arguments.');
      return source;
    }
    if (GEMINI_PROCESSOR.test(command)) {
      problems.add('Claude shell injection contains Gemini template syntax. Move the payload to a script to keep it literal.');
      return source;
    }
    if (!command.trim() || !hasBalancedBraces(command)) {
      problems.add('Claude shell injection cannot be expressed as a Gemini shell block. Wrap the payload in a script.');
      return source;
    }
    return render(command);
  }

  const out = body.replace(
    CLAUDE_SHELL_BLOCK,
    (source: string, indent: string | undefined, fence: string | undefined, inline: string | undefined) => {
      const converted = lower(source, fence ?? inline ?? '');
      return converted === source ? source : (indent ?? '') + converted;
    },
  );
  if (/^[ \t]*\x60{3}!/m.test(out)) {
    problems.add('Claude shell injection fence could not be converted. Check the opening and closing delimiters.');
  }
  violations.push(...problems);
  return out;
}

/** Lower Claude interpolation where Gemini offers an equivalent and diagnose the rest. */
export function lowerGeminiBody(
  body: string,
  data: Record<string, unknown>,
  mode: 'skill' | 'command',
  skillName?: string,
  transform: (body: string) => string = (body) => body,
): GeminiDiagnostics & { body: string } {
  const warnings: string[] = [];
  const violations: string[] = [];
  const named = argumentNames(data);
  const indexed = uniqueMatches(body, INDEXED_ARGUMENT);
  // Fenced examples can contain SQL placeholders and shell parameters. Multi-digit
  // dollar amounts are also common in prose, so leave ambiguous forms visible.
  const prose = body.replace(ORDINARY_CODE_FENCE, '\n');
  const shorthand = new Set<string>();
  for (const { 0: token, index } of prose.matchAll(ARGUMENT_SHORTHAND)) {
    const prefix = prose.slice(Math.max(0, index - 40), index);
    const suffix = prose.slice(index + token.length, index + token.length + 16);
    if (!PRICE_PREFIX.test(prefix) && !PRICE_SUFFIX.test(suffix)) shorthand.add(token);
  }
  for (const token of shorthand) {
    if (token.length === 2 || Number(token.slice(1)) < named.size) {
      indexed.push(token);
    } else {
      warnings.push('Preserved ambiguous ' + token + ' as literal text. Gemini does not expand Claude positional arguments.');
    }
  }
  const namedUses = uniqueMatches(body, /\$[A-Za-z_]\w*/g).filter((token) => named.has(token.slice(1)));
  if (indexed.length || namedUses.length) {
    violations.push(
      'Gemini cannot substitute Claude positional or named arguments (' + [...indexed, ...namedUses].join(', ') +
      '). Use the full $ARGUMENTS input or migrate the argument parsing separately.',
    );
  }
  if (mode === 'command') {
    // Claude prompts use @{variable_name} as prose for a path filled in by the
    // model. Keep it visible while preventing Gemini's file processor running.
    const literalPaths = mapClaudePromptText(body, (text) => text.replace(/@\{([A-Za-z_]\w*)\}/g, '@<$1>'));
    if (literalPaths !== body) warnings.push('Reformatted literal Claude @ path placeholders for Gemini.');
    body = literalPaths;
    if (GEMINI_PROCESSOR.test(body)) {
      violations.push('The Claude prompt already contains Gemini template syntax. Review or remove the literal syntax before converting it into an active command.');
    }
  }
  if (mode === 'command' && claudeBoolean(data['user-invocable']) === false) {
    violations.push('Claude user-invocable: false forbids a slash command. Convert this entry into an automatically activated skill instead.');
  }

  let marker = '\uE000';
  while (body.includes(marker)) marker += '\uE000';
  const commands: string[] = [];
  let out = lowerShellInjection(body, mode, data, named, violations, (command) => {
    commands.push(command);
    return `${marker}${commands.length}\uE001`;
  });
  const substitutions = uniqueMatches(body, CLAUDE_VARIABLE);
  const canResolveSkillDir = mode === 'skill' && Boolean(skillName);
  if (canResolveSkillDir && substitutions.includes(CLAUDE_SKILL_DIRECTORY)) {
    out = out.replaceAll(CLAUDE_SKILL_DIRECTORY, 'SKILL_DIRECTORY');
    out = 'For paths starting with SKILL_DIRECTORY, substitute the absolute directory reported by activate_skill for ' +
      skillName + '.\n\n' + out;
    warnings.push('Gemini resolves the skill directory from the activate_skill result. It does not interpolate a shell variable.');
  }
  const unresolved = substitutions.filter((token) => token !== CLAUDE_SKILL_DIRECTORY || !canResolveSkillDir);
  if (unresolved.length) {
    violations.push(
      'Gemini cannot substitute Claude runtime variables (' + unresolved.join(', ') +
      '). Replace them with Gemini-aware path or session handling.',
    );
  }
  if (uniqueMatches(out, ALL_ARGUMENTS).length) {
    if (mode === 'command') {
      out = out.replace(ALL_ARGUMENTS, '{{args}}');
    } else {
      out = out.replace(ALL_ARGUMENTS, 'the arguments in the latest user request');
      warnings.push('The converted skill takes arguments from conversation context. Use a custom command for literal interpolation.');
    }
  }
  out = transform(out);
  for (const [index, command] of commands.entries()) {
    out = out.replace(`${marker}${index + 1}\uE001`, () => '!{' + command + '}');
  }
  return { body: out, warnings, violations };
}

function escapeToml(text: string, multiline = false): string {
  return text.replace(/["\\\x00-\x1F\x7F]/g, (char) => {
    if (multiline && char === '\n') return char;
    if (char === '\x7F') return '\\u007F';
    return JSON.stringify(char).slice(1, -1);
  });
}

/** TOML basic strings preserve the exact prompt, including trailing quotes and line breaks. */
export function serializeGeminiCommand(prompt: string, description?: string): string {
  const details = description ? 'description = "' + escapeToml(description) + '"\n' : '';
  return details + 'prompt = """\n' + escapeToml(prompt, true) + '"""\n';
}
