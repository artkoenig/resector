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

// Nothing when the process left none, or none that can be read.
export function readReport(dir: string, pid: number): { report?: SubagentReport } {
  try {
    const report: SubagentReport | null = JSON.parse(readFileSync(pathOf(dir, pid), 'utf8'));
    return Number.isFinite(report?.turns) && Number.isFinite(report?.tokens) ? { report: report! } : {};
  } catch {
    return {};
  }
}

// A pid may be reused: what an earlier process left is not this one's.
export const dropReport = (dir: string, pid: number) => rmSync(pathOf(dir, pid), { force: true });
