import type { ClozeBlank, GradeResult, Verdict } from './types.js';

/** 問題文中の空欄マーカー。{{1}} から始まる連番。 */
export const BLANK_PATTERN = /\{\{(\d+)\}\}/g;

/**
 * 表記ゆれを吸収する。全角/半角、大文字/小文字、空白、括弧・句読点の差は無視する。
 * 意味が変わる差（送り仮名や漢字とかなの違い）は吸収しないので、
 * 許容表記はモデルに複数列挙させる方針。
 */
export function normalizeAnswer(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, '')
    .replace(/[「」『』“”"'（）()［］[\]、。,.・･:：;；!！?？]/gu, '');
}

/** 問題文に現れる空欄番号を出現順に返す。 */
export function blankNumbersIn(question: string): number[] {
  const found: number[] = [];
  for (const match of question.matchAll(BLANK_PATTERN)) {
    const n = Number(match[1]);
    if (Number.isInteger(n)) found.push(n);
  }
  return found;
}

/**
 * 問題文の空欄が {{1}}..{{n}} の連番で、blanks と個数が一致しているか検証する。
 * モデル出力を信用しないための門番。
 */
export function isValidCloze(question: string, blanks: ClozeBlank[]): boolean {
  if (blanks.length === 0) return false;
  if (blanks.some((b) => b.answers.length === 0 || b.answers.some((a) => !a.trim()))) return false;

  const numbers = blankNumbersIn(question);
  if (numbers.length !== blanks.length) return false;
  return numbers.every((n, i) => n === i + 1);
}

/** 空欄ごとの正誤から総合点を出す。空欄が多い問題でも 0〜100 に正規化する。 */
export function gradeCloze(
  questionId: string,
  blanks: ClozeBlank[],
  response: string[],
): GradeResult {
  const blankResults = blanks.map((blank, i) => {
    const given = normalizeAnswer(response[i] ?? '');
    if (!given) return false;
    return blank.answers.some((candidate) => normalizeAnswer(candidate) === given);
  });

  const correctCount = blankResults.filter(Boolean).length;
  const score = Math.round((correctCount / blanks.length) * 100);

  let verdict: Verdict = 'incorrect';
  if (correctCount === blanks.length) verdict = 'correct';
  else if (correctCount > 0) verdict = 'partial';

  const wrong = blankResults
    .map((ok, i) => (ok ? null : `(${i + 1}) ${blanks[i]?.answers[0] ?? ''}`))
    .filter((v): v is string => v !== null);

  const feedback =
    wrong.length === 0
      ? `全 ${blanks.length} 箇所すべて正解です。`
      : `${correctCount} / ${blanks.length} 箇所正解。誤りの空欄と正解: ${wrong.join('、')}`;

  return { questionId, score, verdict, feedback, blankResults };
}
