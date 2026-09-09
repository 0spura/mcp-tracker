import type { TrackerConfig } from '../../context/config.js';

export const WORK_PHASES = [
  'discovery',
  'design',
  'requirements',
  'architecture',
  'plan',
  'implementation',
  'review',
] as const;

export type WorkPhase = (typeof WORK_PHASES)[number];

export interface WorkRecord {
  phase: WorkPhase;
  summary: string;
  artifacts?: string[];
  verification?: string[];
  blockers?: string[];
  nextStep?: string;
  commit?: string;
  pr?: string;
}

/** Create the portable, append-only progress record stored on an issue. */
export function formatWorkRecord(record: WorkRecord): string {
  const sections: string[] = [
    `## Work update: ${record.phase}`,
    record.summary.trim(),
  ];

  appendList(sections, 'Artifacts', record.artifacts);
  appendList(sections, 'Verification', record.verification);
  appendList(sections, 'Blockers', record.blockers);
  appendValue(sections, 'Next step', record.nextStep);
  appendValue(sections, 'Commit', record.commit);
  appendValue(sections, 'PR', record.pr);

  return sections.join('\n\n');
}

/** Resolve a portable workflow key to the provider-facing stage name. */
export function resolveWorkflowStage(config: TrackerConfig, key: string): string {
  const stage = config.workflow?.stages?.find((candidate) => candidate.key === key);
  if (!stage) {
    throw new Error(`unknown workflow stage "${key}"`);
  }
  return stage.name;
}

function appendList(sections: string[], heading: string, values?: string[]): void {
  if (!values || values.length === 0) return;
  sections.push(`### ${heading}\n${values.map((value) => `- ${value.trim()}`).join('\n')}`);
}

function appendValue(sections: string[], heading: string, value?: string): void {
  if (!value) return;
  sections.push(`### ${heading}\n${value.trim()}`);
}
