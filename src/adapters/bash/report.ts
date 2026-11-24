// The report a Subagent leaves for its parent Session: a file next to its log, named after its process. Kept apart from
// the log, where stdout and stderr mix.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SubagentReport } from '../../core/log/events';

// Tells a Subagent the directory its report goes to.
export const REPORTS_ENV = 'RESECTOR_SUBAGENT_REPORTS';

const pathOf = (dir: string, pid: number) => join(dir, `${pid}.report.json`);

// Replaced as a whole: killed while writing, the report before stays.
export function writeReport(dir: string, pid: number, report: SubagentReport) {
  const path = pathOf(dir, pid);
  writeFileSync(`${path}.tmp`, JSON.stringify(report));
  renameSync(`${path}.tmp`, path);
}

const OUTCOMES: unknown[] = ['answer', 'error', 'aborted', 'max-turns'] satisfies SubagentReport['outcome'][];
const optional = (value: unknown, holds: (value: unknown) => boolean) => value === undefined || holds(value);
const isText = (value: unknown) => typeof value === 'string';

function isReport(read: Record<keyof SubagentReport, unknown> | null): boolean {
  return read !== null && Number.isFinite(read.turns) && Number.isFinite(read.tokens)
    && optional(read.session, isText) && optional(read.text, isText) && optional(read.outcome, o => OUTCOMES.includes(o));
}

// Nothing when the process left none, or a broken one.
export function readReport(dir: string, pid: number): { report?: SubagentReport } {
  try {
    const read = JSON.parse(readFileSync(pathOf(dir, pid), 'utf8'));
    return isReport(read) ? { report: read } : {};
  } catch {
    return {};
  }
}

// A pid may be reused: what an earlier process left is not this one's.
export const dropReport = (dir: string, pid: number) => rmSync(pathOf(dir, pid), { force: true });
