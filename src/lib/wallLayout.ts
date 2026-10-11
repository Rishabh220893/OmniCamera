/**
 * Video wall layouts (gap A10): the presets, where each cell sits, what a saved layout may contain, and how a tour pages through cameras.
 * Pure and shared: the server checks layouts with it, the Wall view draws them with it.
 */

export const WALL_PRESETS = ['1x1', '2x2', '3x3', '4x4', '1+5', '1+7', '2+8', 'custom'] as const;
export type WallPreset = (typeof WALL_PRESETS)[number];

export const PRESET_LABEL: Record<WallPreset, string> = {
  '1x1': 'Single (1)', '2x2': '2 × 2 (4)', '3x3': '3 × 3 (9)', '4x4': '4 × 4 (16)', '1+5': '1 + 5', '1+7': '1 + 7', '2+8': '2 + 8 (10)', custom: 'Custom grid',
};

export interface CellBox { col: number; row: number; colSpan: number; rowSpan: number }
export interface WallGrid { cols: number; rows: number; cells: CellBox[] }

export const MAX_CUSTOM_COLS = 8;
export const MAX_CUSTOM_ROWS = 6;
export const MAX_TOUR_CAMERAS = 500;

const plain = (cols: number, rows: number): WallGrid => ({ cols, rows, cells: Array.from({ length: cols * rows }, (_, i) => ({ col: (i % cols) + 1, row: Math.floor(i / cols) + 1, colSpan: 1, rowSpan: 1 })) });

/** One big cell at the top left spanning `big` × `big`, and small cells around it filling the rest of a `size` × `size` grid. */
function featured(size: number, big: number, count: number): WallGrid {
  const cells: CellBox[] = [{ col: 1, row: 1, colSpan: big, rowSpan: big }];
  for (let row = 1; row <= size && cells.length < count; row++) {
    for (let col = 1; col <= size && cells.length < count; col++) {
      if (col <= big && row <= big) continue;
      cells.push({ col, row, colSpan: 1, rowSpan: 1 });
    }
  }
  return { cols: size, rows: size, cells };
}

/** The cells of a preset, left to right, top to bottom, the big one first. `custom` needs its size. */
export function gridOf(preset: WallPreset, custom?: { cols: number; rows: number }): WallGrid {
  switch (preset) {
    case '1x1': return plain(1, 1);
    case '2x2': return plain(2, 2);
    case '3x3': return plain(3, 3);
    case '4x4': return plain(4, 4);
    case '1+5': return featured(3, 2, 6); // a 3 × 3 grid: one 2 × 2 cell, five singles
    case '1+7': return featured(4, 3, 8); // 4 × 4: one 3 × 3, seven singles
    case '2+8': { // a 4 × 4 grid: two big (2 × 2) cells on top, two rows of four singles below
      const cells: CellBox[] = [{ col: 1, row: 1, colSpan: 2, rowSpan: 2 }, { col: 3, row: 1, colSpan: 2, rowSpan: 2 }];
      for (let row = 3; row <= 4; row++) for (let col = 1; col <= 4; col++) cells.push({ col, row, colSpan: 1, rowSpan: 1 });
      return { cols: 4, rows: 4, cells };
    }
    case 'custom': {
      const cols = Math.min(MAX_CUSTOM_COLS, Math.max(1, Math.floor(custom?.cols ?? 2)));
      const rows = Math.min(MAX_CUSTOM_ROWS, Math.max(1, Math.floor(custom?.rows ?? 2)));
      return plain(cols, rows);
    }
  }
}

export const cellCount = (preset: WallPreset, custom?: { cols: number; rows: number }) => gridOf(preset, custom).cells.length;

export interface WallLayoutSpec {
  preset: WallPreset;
  /** Only for `custom`. */
  cols?: number;
  rows?: number;
  /** One entry per cell: a camera id, or null for an empty cell. */
  cells: Array<string | null>;
  /** Show the next group of `cells.length` cameras from `cameraIds` every `intervalS` seconds. */
  tour?: { intervalS: number; cameraIds: string[] };
}

export class LayoutError extends Error { constructor(message: string) { super(message); this.name = 'LayoutError'; } }

const CAMERA_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

/** Checks a layout from outside and returns a clean copy; throws a `LayoutError` with a sentence that can be shown. */
export function validateSpec(raw: unknown): WallLayoutSpec {
  const r = (raw ?? {}) as Record<string, unknown>;
  const preset = r.preset;
  if (!WALL_PRESETS.includes(preset as WallPreset)) throw new LayoutError(`'preset' must be one of ${WALL_PRESETS.join(', ')}.`);
  const p = preset as WallPreset;
  const out: WallLayoutSpec = { preset: p, cells: [] };
  if (p === 'custom') {
    const cols = Number(r.cols), rows = Number(r.rows);
    if (!Number.isInteger(cols) || cols < 1 || cols > MAX_CUSTOM_COLS) throw new LayoutError(`'cols' must be a whole number from 1 to ${MAX_CUSTOM_COLS}.`);
    if (!Number.isInteger(rows) || rows < 1 || rows > MAX_CUSTOM_ROWS) throw new LayoutError(`'rows' must be a whole number from 1 to ${MAX_CUSTOM_ROWS}.`);
    out.cols = cols; out.rows = rows;
  }
  const n = cellCount(p, out.cols && out.rows ? { cols: out.cols, rows: out.rows } : undefined);
  if (!Array.isArray(r.cells) || r.cells.length !== n) throw new LayoutError(`This layout has ${n} cells; 'cells' must list exactly ${n} (a camera id, or null for an empty cell).`);
  const seen = new Set<string>();
  for (const c of r.cells) {
    if (c === null) { out.cells.push(null); continue; }
    if (typeof c !== 'string' || !CAMERA_ID.test(c)) throw new LayoutError('A cell must be a camera id or null.');
    if (seen.has(c)) throw new LayoutError(`Camera '${c}' is in two cells.`);
    seen.add(c); out.cells.push(c);
  }
  if (r.tour !== undefined && r.tour !== null) {
    const t = r.tour as Record<string, unknown>;
    const intervalS = Number(t.intervalS);
    if (!Number.isInteger(intervalS) || intervalS < 5 || intervalS > 3600) throw new LayoutError("A tour's 'intervalS' must be a whole number of seconds from 5 to 3600.");
    if (!Array.isArray(t.cameraIds) || t.cameraIds.length === 0 || t.cameraIds.length > MAX_TOUR_CAMERAS || !t.cameraIds.every((x) => typeof x === 'string' && CAMERA_ID.test(x))) throw new LayoutError(`A tour needs 1 to ${MAX_TOUR_CAMERAS} camera ids.`);
    out.tour = { intervalS, cameraIds: [...new Set(t.cameraIds as string[])] };
  }
  return out;
}

/** Every camera id a layout mentions (cells and tour), without repeats. */
export const camerasOf = (spec: WallLayoutSpec): string[] => [...new Set([...spec.cells.filter((c): c is string => !!c), ...(spec.tour?.cameraIds ?? [])])];

/**
 * What the cells show at a moment. Without a tour: the cells as saved. With one: the tour's cameras in groups of `cells.length`, the group
 * changing every `intervalS`, counted from `startedAtMs` (so every screen on the same wall shows the same group). A short last group is
 * padded from the start of the list, so no cell is empty unless the tour has fewer cameras than cells.
 */
export function visibleCells(spec: WallLayoutSpec, nowMs: number, startedAtMs: number): Array<string | null> {
  const tour = spec.tour;
  if (!tour || tour.cameraIds.length === 0) return spec.cells;
  const size = spec.cells.length, list = tour.cameraIds;
  const groups = Math.ceil(list.length / size);
  const step = Math.max(0, Math.floor((nowMs - startedAtMs) / (tour.intervalS * 1000))) % groups;
  return Array.from({ length: size }, (_, i) => {
    const at = step * size + i;
    return list.length ? list[at < list.length ? at : (at - list.length) % list.length] ?? null : null;
  }).map((c, i) => (i >= list.length ? null : c));
}
