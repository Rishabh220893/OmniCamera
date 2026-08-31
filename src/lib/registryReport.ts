import { CameraConfig } from '../types';

export interface GapAnalysisReport {
  unlocated: CameraConfig[];
  offlineOrDegraded: CameraConfig[];
  ageing: CameraConfig[];
  stale: CameraConfig[];
  departmentCoverage: { department: string; count: number }[];
  generatedAt: Date;
}

const DEFAULT_AGEING_YEARS = 5;
const DEFAULT_STALE_DAYS = 7;

export function computeGapAnalysis(
  cameras: CameraConfig[],
  opts: { ageingYears?: number; staleDays?: number } = {}
): GapAnalysisReport {
  const ageingYears = opts.ageingYears ?? DEFAULT_AGEING_YEARS;
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const now = Date.now();
  const ageingCutoff = new Date();
  ageingCutoff.setFullYear(ageingCutoff.getFullYear() - ageingYears);
  const staleCutoffMs = staleDays * 24 * 60 * 60 * 1000;

  const unlocated = cameras.filter(c => !c.location);
  const offlineOrDegraded = cameras.filter(c => c.connectivityStatus === 'offline' || c.connectivityStatus === 'degraded');
  const ageing = cameras.filter(c => c.installDate && new Date(c.installDate) < ageingCutoff);
  const stale = cameras.filter(c => {
    if (!c.lastAnalysisTime) return true;
    const t = c.lastAnalysisTime instanceof Date ? c.lastAnalysisTime.getTime() : new Date(c.lastAnalysisTime).getTime();
    return now - t > staleCutoffMs;
  });

  const deptCounts = new Map<string, number>();
  cameras.forEach(c => {
    const dept = c.department?.trim() || 'Unassigned';
    deptCounts.set(dept, (deptCounts.get(dept) || 0) + 1);
  });
  const departmentCoverage = Array.from(deptCounts.entries())
    .map(([department, count]) => ({ department, count }))
    .sort((a, b) => a.count - b.count);

  return { unlocated, offlineOrDegraded, ageing, stale, departmentCoverage, generatedAt: new Date() };
}
