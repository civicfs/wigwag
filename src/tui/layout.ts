/** Pure layout helpers: display-width wrapping that matches Ink's, and list windowing. */
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

export const displayWidth = (s: string): number => stringWidth(s);

/**
 * The physical rows `text` occupies at `width` columns. Uses the same wrap-ansi call and options as Ink's own text
 * wrapping (and string-width for CJK, combining and zero-width characters), so counts match what is drawn.
 * Empty text renders no rows. An unbounded width (list panes rendered without a size) only splits on newlines.
 */
export function wrapRows(text: string, width: number): string[] {
  if (text === '') return [];
  if (!Number.isFinite(width)) return text.split('\n');
  return wrapAnsi(text, Math.max(1, Math.floor(width)), { trim: false, hard: true }).split('\n');
}

export const wrapCount = (text: string, width: number): number => wrapRows(text, width).length;

/**
 * The largest run of items that fits in `avail` rows and contains `selected`, ending at the selection when the list
 * has to scroll. Always includes the selected item, even when it alone is taller than `avail`.
 */
export function windowOf(heights: number[], selected: number, avail: number): { start: number; end: number } {
  const n = heights.length;
  if (n === 0) return { start: 0, end: 0 };
  const s = Math.min(Math.max(selected, 0), n - 1);
  let used = heights[s];
  let start = s;
  let end = s + 1;
  while (start > 0 && used + heights[start - 1] <= avail) {
    start--;
    used += heights[start];
  }
  while (end < n && used + heights[end] <= avail) {
    used += heights[end];
    end++;
  }
  return { start, end };
}

export const clampIndex = (i: number, len: number): number => Math.min(Math.max(i, 0), Math.max(0, len - 1));

/** One logical line per entry; nested values are indented. Strings containing newlines are shown as real lines. */
export function detailLines(v: unknown, indent = 0): string[] {
  const pad = ' '.repeat(indent);
  const scalar = (x: unknown): string[] => (typeof x === 'string' ? x.split('\n') : [String(x)]);
  const isScalar = (x: unknown) => x === null || x === undefined || typeof x !== 'object';
  if (isScalar(v)) return scalar(v).map((l) => pad + l);
  const out: string[] = [];
  if (Array.isArray(v)) {
    if (v.length === 0) return [`${pad}(none)`];
    for (const item of v) {
      if (isScalar(item) && !(typeof item === 'string' && item.includes('\n'))) out.push(`${pad}- ${String(item)}`);
      else {
        out.push(`${pad}-`);
        out.push(...detailLines(item, indent + 2));
      }
    }
    return out;
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (isScalar(val) && !(typeof val === 'string' && val.includes('\n'))) out.push(`${pad}${k}: ${String(val)}`);
    else if (Array.isArray(val) && val.length === 0) out.push(`${pad}${k}: (none)`);
    else {
      out.push(`${pad}${k}:`);
      out.push(...detailLines(val, indent + 2));
    }
  }
  return out;
}

/** Every logical detail line wrapped to physical display rows at `innerWidth`; the unit the detail pane scrolls by. */
export function detailRows(detail: unknown, innerWidth: number): string[] {
  return detailLines(detail).flatMap((l) => (l === '' ? [''] : wrapRows(l, innerWidth)));
}

/** First line of an error and whether the rest (more lines, or a first line wider than the pane) needs Enter. */
export function errorSummary(err: string, innerWidth: number): { first: string; more: boolean } {
  const lines = err.trimEnd().split('\n');
  const first = lines[0];
  return { first, more: lines.length > 1 || displayWidth(`  ${first}`) > innerWidth };
}

/** "just now", "5m ago", "3h ago", "2d ago"; "unknown" when the timestamp does not parse. */
export function relativeAge(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
