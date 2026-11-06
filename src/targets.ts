// Target agent definitions. Codex and OpenCode are implemented; the shape is
// designed so Gemini / Cursor can be added as data without touching the core.

/** A custom agent emitted as a TOML (Codex) or Markdown (OpenCode) file. */
export interface CustomAgent {
  name: string;
  description: string;
  developer_instructions: string;
  model_reasoning_effort?: string;
}

/** Route a subagent delegation to a custom agent when context matches a keyword. */
export interface RoleRule {
  agent: string;
  keywords: string[];
}

export interface Target {
  id: string;
  /** Default user-scope skills directory (~ expanded by caller). */
  skillsDir: string;
  /**
   * Default user-scope slash-command directory, or null when the target has no
   * markdown-command mechanism (Codex). OpenCode scans every `.md` file under
   * `<dir>` and turns nested paths into `/ns/command` names.
   */
  commandsDir: string | null;
  /**
   * How a sub-skill is exposed:
   * - `namespace`: the agent namespaces by parent dir (`<ns>:<alias>`, Codex);
   * - `prefix`: there is no namespace, so IDs carry it (`<ns>-<alias>`, OpenCode).
   */
  nameStyle: 'namespace' | 'prefix';
  /**
   * Bundle shape:
   * - `bundle`: `<out>/<ns>/SKILL.md` + flat sub-skill dirs (Codex);
   * - `rootless`: no SKILL.md at the bundle root; the orchestrator and every
   *   sub-skill are sibling dirs, because agents that stop recursing at a
   *   SKILL.md (OpenCode) would otherwise never see the sub-skills.
   */
  layout: 'bundle' | 'rootless';
  /**
   * Claude-specific tool tokens -> target-appropriate wording. Applied to skill
   * bodies. Keys are matched as whole words (and the Task(...) form specially).
   */
  toolRemap: Record<string, string>;
  /**
   * Whether the agent natively expands `@file` include directives in SKILL.md.
   * Neither Codex nor OpenCode does, so external includes are inlined and
   * internal ones rewritten to explicit read instructions.
   */
  expandsAtIncludes: boolean;
  /**
   * Maps Claude `Task(subagent_type="X")` delegation to this agent's subagent
   * name. `null` means the target has no subagent mechanism.
   */
  subagentMap: Record<string, string> | null;
  /** Fallback subagent name for unmapped subagent_type values. */
  defaultSubagent?: string;
  /** Template for an adapted Task(...) site; `{agent}` is replaced. */
  subagentPhrase: string;
  /** Custom agents to emit (empty = none). */
  customAgents: CustomAgent[];
  /** Context-keyword rules that route a delegation to a custom agent. */
  roleRules: RoleRule[];
  /** File format for custom agents, or null when the target has none. */
  agentFormat: 'toml' | 'markdown' | null;
  /** Bundle-relative directory for emitted custom agents. */
  agentsOutDir: string;
  /** HOME-relative directory custom agents install into. */
  agentsInstallDir: string;
  /** Bundle-relative plugin manifest path, or null when none is emitted. */
  pluginManifest: string | null;
}

export const CODEX: Target = {
  id: 'codex',
  skillsDir: '.agents/skills',
  commandsDir: null,
  nameStyle: 'namespace',
  layout: 'bundle',
  expandsAtIncludes: false,
  toolRemap: {
    AskUserQuestion: 'ask the user directly',
    TodoWrite: 'the update_plan tool',
    WebFetch: 'web fetch',
    WebSearch: 'web search',
  },
  // Codex built-in agents: default (general-purpose), worker (execution),
  // explorer (read-heavy). Spawned in isolated threads, results summarized back
  // — same semantics as Claude's Task tool. See developers.openai.com/codex/subagents
  subagentMap: { 'general-purpose': 'default' },
  defaultSubagent: 'default',
  subagentPhrase: 'a subagent (Codex {agent} agent)',
  // Tunable defaults. A delegation is routed to one of these when the Task site
  // (and its prompt hint / delegated-skill name) matches a role keyword;
  // otherwise it falls back to the built-in `default` agent.
  customAgents: [
    {
      name: 'reviewer',
      description:
        'Reviews specs, code, and theory for correctness, completeness, consistency, and missing coverage. Cites file:line; never fabricates findings.',
      developer_instructions:
        'Review like an owner. Prioritize correctness, security, traceability, and missing tests/coverage. Cite a specific file:line for every finding. Report only what you can verify — do not invent issues. Be concise and actionable.',
      model_reasoning_effort: 'high',
    },
    {
      name: 'spec-author',
      description:
        'Generates specification documents (PRD, SRS, tech design, feature specs, test cases) with rigor and traceability.',
      developer_instructions:
        'Produce implementation-ready specs. Use modal-verb discipline (shall/should/may), exact boundaries and validations, and no "TBD" or "handle appropriately" hand-waving. Preserve requirement IDs and section titles for traceability. Ground every claim in the actual project.',
      model_reasoning_effort: 'high',
    },
    {
      name: 'analyst',
      description:
        'Read-heavy investigation: analyze document or code collections, research, and map themes, gaps, and conflicts. Evidence-based.',
      developer_instructions:
        'Investigate before concluding. Build the landscape first, then cite evidence (file:line or source) for each observation. Surface gaps, conflicts, and staleness. Do not over-claim beyond what the sources support.',
    },
  ],
  roleRules: [
    {
      agent: 'reviewer',
      keywords: ['review', 'audit', 'verify', 'cite-audit', 'consistency', 'counter-argument', 'falsifiability', 'scope'],
    },
    {
      agent: 'spec-author',
      keywords: ['idea', 'prd', 'srs', 'tech-design', 'decompose', 'test-cases', 'test-plan', 'draft', 'concept-import'],
    },
    {
      agent: 'analyst',
      keywords: ['analyze', 'scan', 'compare', 'report', 'cross-lang'],
    },
  ],
  agentFormat: 'toml',
  agentsOutDir: '.codex/agents',
  agentsInstallDir: '.codex/agents',
  pluginManifest: '.codex-plugin/plugin.json',
};

export const OPENCODE: Target = {
  id: 'opencode',
  skillsDir: '.config/opencode/skills',
  commandsDir: '.config/opencode/commands',
  nameStyle: 'prefix',
  layout: 'rootless',
  expandsAtIncludes: false,
  toolRemap: {
    AskUserQuestion: 'ask the user directly',
    TodoWrite: 'todowrite',
    WebFetch: 'webfetch',
    WebSearch: 'websearch',
  },
  // OpenCode V2 built-in subagents. The general agent has broad tool access but
  // cannot spawn further subagents; explore is read-only.
  subagentMap: { 'general-purpose': 'general', explore: 'explore', Explore: 'explore' },
  defaultSubagent: 'general',
  subagentPhrase: 'the `subagent` tool (agent: `{agent}`)',
  customAgents: [
    {
      name: 'reviewer',
      description:
        'Reviews specs, code, and theory for correctness, completeness, consistency, and missing coverage. Cites file:line; never fabricates findings.',
      developer_instructions:
        'Review like an owner. Prioritize correctness, security, traceability, and missing tests/coverage. Cite a specific file:line for every finding. Report only what you can verify — do not invent issues. Be concise and actionable.',
    },
    {
      name: 'spec-author',
      description:
        'Generates specification documents (PRD, SRS, tech design, feature specs, test cases) with rigor and traceability.',
      developer_instructions:
        'Produce implementation-ready specs. Use modal-verb discipline (shall/should/may), exact boundaries and validations, and no "TBD" or "handle appropriately" hand-waving. Preserve requirement IDs and section titles for traceability. Ground every claim in the actual project.',
    },
    {
      name: 'analyst',
      description:
        'Read-heavy investigation: analyze document or code collections, research, and map themes, gaps, and conflicts. Evidence-based.',
      developer_instructions:
        'Investigate before concluding. Build the landscape first, then cite evidence (file:line or source) for each observation. Surface gaps, conflicts, and staleness. Do not over-claim beyond what the sources support.',
    },
  ],
  roleRules: [
    {
      agent: 'reviewer',
      keywords: ['review', 'audit', 'verify', 'cite-audit', 'consistency', 'counter-argument', 'falsifiability', 'scope'],
    },
    {
      agent: 'spec-author',
      keywords: ['idea', 'prd', 'srs', 'tech-design', 'decompose', 'test-cases', 'test-plan', 'draft', 'concept-import'],
    },
    {
      agent: 'analyst',
      keywords: ['analyze', 'scan', 'compare', 'report', 'cross-lang'],
    },
  ],
  agentFormat: 'markdown',
  agentsOutDir: 'agents',
  agentsInstallDir: '.config/opencode/agents',
  pluginManifest: null,
};

export const TARGETS: Record<string, Target> = {
  codex: CODEX,
  opencode: OPENCODE,
};

export function getTarget(id: string): Target {
  const t = TARGETS[id];
  if (!t) {
    throw new Error(
      `Unknown target "${id}". Known: ${Object.keys(TARGETS).join(', ')}.`,
    );
  }
  return t;
}
