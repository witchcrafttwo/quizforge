// 穴埋め問題文の {{1}} {{2}} … を描画用に分解する。採点はサーバ側が行う。

export type ClozeSegment = { kind: 'text'; text: string } | { kind: 'blank'; index: number };

const BLANK_PATTERN = /\{\{(\d+)\}\}/g;

/**
 * "AはBの{{1}}であり、{{2}}と呼ぶ。" を
 * [text, blank(0), text, blank(1), text] に分解する。
 * blank の index は 0 始まり（解答配列の添字に合わせる）。
 */
export function parseCloze(question: string): ClozeSegment[] {
  const segments: ClozeSegment[] = [];
  let cursor = 0;

  for (const match of question.matchAll(BLANK_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ kind: 'text', text: question.slice(cursor, start) });
    segments.push({ kind: 'blank', index: Number(match[1]) - 1 });
    cursor = start + match[0].length;
  }
  if (cursor < question.length) segments.push({ kind: 'text', text: question.slice(cursor) });

  return segments;
}

/** 空欄の個数。blanks が無い場合の保険として問題文から数える。 */
export function countBlanks(question: string): number {
  return [...question.matchAll(BLANK_PATTERN)].length;
}
