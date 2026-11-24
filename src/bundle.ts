import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';

export const BUNDLE_METADATA_FILENAME = '.agent-skill-bundler.json';

export interface BundleMetadata {
  target: string;
  namespace: string;
  skills: string[];
  commands?: number;
}

/** A single visible path component, independent of the current OS. */
export function isArtifactName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('.') &&
    !/[/\\:<>"|?*\p{Cc}\p{Bidi_Control}]|[. ]$/u.test(value);
}

export function writeBundleMetadata(bundle: string, metadata: BundleMetadata): void {
  fs.writeFileSync(path.join(bundle, BUNDLE_METADATA_FILENAME), `${JSON.stringify(metadata, null, 2)}\n`);
}

export function readBundleMetadata(bundle: string): BundleMetadata | undefined {
  const file = path.join(bundle, BUNDLE_METADATA_FILENAME);
  if (!fs.existsSync(file)) return undefined;
  const metadata: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    typeof metadata !== 'object' || !metadata ||
    !('target' in metadata) || metadata.target !== 'gemini' ||
    !('namespace' in metadata) || !isArtifactName(metadata.namespace) ||
    !('skills' in metadata) || !Array.isArray(metadata.skills) ||
    !metadata.skills.every(isArtifactName) ||
    ('commands' in metadata &&
      (typeof metadata.commands !== 'number' ||
        !Number.isSafeInteger(metadata.commands) || metadata.commands < 0))
  ) {
    throw new Error(`Invalid bundle metadata: ${file}`);
  }
  const commands = 'commands' in metadata && typeof metadata.commands === 'number'
    ? metadata.commands
    : undefined;
  return { target: metadata.target, namespace: metadata.namespace, skills: metadata.skills, commands };
}

/** Read the fields that make a generated SKILL.md discoverable by Gemini CLI. */
export function readGeminiSkillName(file: string): string | undefined {
  try {
    const match = fs.readFileSync(file, 'utf8').match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (!match) return undefined;
    const metadata = YAML.parse(match[1]);
    if (typeof metadata?.name === 'string' && metadata.name.trim() &&
        typeof metadata.description === 'string' && metadata.description.trim()) {
      return metadata.name;
    }
  } catch {
    // Missing, unreadable and invalid Markdown are not discoverable.
  }
  return undefined;
}
