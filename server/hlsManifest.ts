export interface TrimResult {
  text: string;
  totalSegments: number;
  keptSegments: number;
  trimmed: boolean;
  hadEndList: boolean;
  hadPlaylistType: boolean;
}

// The camera grid publishes one playlist per camera that lists every segment since the stream started
// (~2,700 six-second segments after 4.5 hours, 300-800 KB per manifest and growing). A player given that
// starts from the first segment and every refresh re-downloads the whole thing, which across ~30 cameras
// is what stalled the grid. This keeps only the newest `keep` segments, which is what a live playlist
// normally looks like, and renumbers the sequence tags so the player still sees a consistent timeline.
export function trimLiveManifest(text: string, keep: number): TrimResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const firstInf = lines.findIndex((l) => l.startsWith('#EXTINF'));
  const hadEndList = lines.some((l) => l.trim() === '#EXT-X-ENDLIST');
  const hadPlaylistType = lines.some((l) => l.startsWith('#EXT-X-PLAYLIST-TYPE'));
  const untouched = (total: number): TrimResult => ({ text, totalSegments: total, keptSegments: total, trimmed: false, hadEndList, hadPlaylistType });
  if (firstInf < 0) return untouched(0);

  const header = lines.slice(0, firstInf);
  type Entry = { lines: string[]; discontinuity: boolean; carry: string[] };
  const entries: Entry[] = [];
  let current: string[] = [];
  let tail: string[] = [];
  for (const line of lines.slice(firstInf)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      if (t === '#EXT-X-ENDLIST') { tail.push(line); continue; }
      current.push(line);
    } else {
      current.push(line);
      entries.push({
        lines: current,
        discontinuity: current.some((l) => l.trim() === '#EXT-X-DISCONTINUITY'),
        // Tags that apply to every following segment until replaced.
        carry: current.filter((l) => l.startsWith('#EXT-X-KEY') || l.startsWith('#EXT-X-MAP')),
      });
      current = [];
    }
  }
  // Anything left (tags after the last segment URI that are not ENDLIST) stays at the end.
  tail = [...current, ...tail];

  const total = entries.length;
  if (keep < 1 || total <= keep) return untouched(total);

  const dropped = entries.slice(0, total - keep);
  const kept = entries.slice(total - keep);

  // Re-attach the latest KEY/MAP from dropped segments if the kept window does not set its own.
  const carriedKey = [...dropped].reverse().find((e) => e.carry.some((l) => l.startsWith('#EXT-X-KEY')))?.carry.filter((l) => l.startsWith('#EXT-X-KEY'));
  const carriedMap = [...dropped].reverse().find((e) => e.carry.some((l) => l.startsWith('#EXT-X-MAP')))?.carry.filter((l) => l.startsWith('#EXT-X-MAP'));
  const keptHas = (prefix: string) => kept.some((e) => e.lines.some((l) => l.startsWith(prefix)));
  const prefaceLines: string[] = [];
  if (carriedKey && !keptHas('#EXT-X-KEY')) prefaceLines.push(...carriedKey);
  if (carriedMap && !keptHas('#EXT-X-MAP')) prefaceLines.push(...carriedMap);

  const seqLine = header.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
  const baseSeq = seqLine ? Number(seqLine.split(':')[1]) || 0 : 0;
  const discLine = header.find((l) => l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:'));
  const baseDisc = discLine ? Number(discLine.split(':')[1]) || 0 : 0;
  const droppedDisc = dropped.filter((e) => e.discontinuity).length;

  const newHeader: string[] = [];
  let wroteSeq = false;
  let wroteDisc = false;
  for (const l of header) {
    if (l.startsWith('#EXT-X-PLAYLIST-TYPE')) continue; // VOD/EVENT make players start from the beginning
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { newHeader.push(`#EXT-X-MEDIA-SEQUENCE:${baseSeq + dropped.length}`); wroteSeq = true; continue; }
    if (l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) { newHeader.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${baseDisc + droppedDisc}`); wroteDisc = true; continue; }
    newHeader.push(l);
  }
  if (!wroteSeq) {
    const at = newHeader.findIndex((l) => l.startsWith('#EXT-X-TARGETDURATION'));
    newHeader.splice(at >= 0 ? at + 1 : newHeader.length, 0, `#EXT-X-MEDIA-SEQUENCE:${baseSeq + dropped.length}`);
  }
  if (!wroteDisc && droppedDisc > 0) {
    const at = newHeader.findIndex((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
    newHeader.splice(at + 1, 0, `#EXT-X-DISCONTINUITY-SEQUENCE:${baseDisc + droppedDisc}`);
  }

  const body = kept.flatMap((e, i) => (i === 0 ? [...prefaceLines, ...e.lines] : e.lines));
  const out = [...newHeader, ...body, ...tail].join('\n') + '\n';
  return { text: out, totalSegments: total, keptSegments: kept.length, trimmed: true, hadEndList, hadPlaylistType };
}
