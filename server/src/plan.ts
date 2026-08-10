import type { Difficulty, QuizConfig, QuestionType } from './types.js';

export interface PlanCell {
  type: QuestionType;
  difficulty: Difficulty;
  count: number;
}

/**
 * 重み（比率）に従って total を整数配分する。最大剰余法なので合計は必ず total に一致する。
 * 全ての重みが 0 の場合は均等割りにフォールバックする。
 */
export function allocate<K extends string>(total: number, weights: Record<K, number>): Record<K, number> {
  const keys = Object.keys(weights) as K[];
  const sanitized = keys.map((k) => Math.max(0, weights[k] || 0));
  const sum = sanitized.reduce((a, b) => a + b, 0);
  const shares = sum > 0 ? sanitized.map((w) => (w / sum) * total) : keys.map(() => total / keys.length);

  const floors = shares.map((s) => Math.floor(s));
  let remaining = total - floors.reduce((a, b) => a + b, 0);

  // 小数部が大きい順に 1 ずつ配る
  const order = shares
    .map((s, i) => ({ i, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const result = [...floors];
  for (const { i } of order) {
    if (remaining <= 0) break;
    result[i] = (result[i] ?? 0) + 1;
    remaining -= 1;
  }

  const out = {} as Record<K, number>;
  keys.forEach((k, i) => {
    out[k] = result[i] ?? 0;
  });
  return out;
}

export const QUESTION_TYPES = [
  'multiple_choice',
  'multi_select',
  'short_answer',
  'cloze',
] as const;

/** 形式 × 難易度の内訳を確定させる。モデルに割合計算をさせないための前処理。 */
export function buildPlan(config: QuizConfig): PlanCell[] {
  const byType = allocate(config.questionCount, {
    multiple_choice: config.typeRatio.multiple_choice,
    multi_select: config.typeRatio.multi_select,
    short_answer: config.typeRatio.short_answer,
    cloze: config.typeRatio.cloze,
  });

  const cells: PlanCell[] = [];
  for (const type of QUESTION_TYPES) {
    const subtotal = byType[type];
    if (subtotal <= 0) continue;
    const byDifficulty = allocate(subtotal, config.difficultyRatio);
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const count = byDifficulty[difficulty];
      if (count > 0) cells.push({ type, difficulty, count });
    }
  }
  return cells;
}

const TYPE_LABEL_JA: Record<QuestionType, string> = {
  multiple_choice: '5択選択問題（正解1つ）',
  multi_select: '複数選択問題（正解2〜4つ）',
  short_answer: '記述問題',
  cloze: '穴埋め問題',
};
const DIFF_LABEL_JA: Record<Difficulty, string> = {
  easy: '易',
  medium: '標準',
  hard: '難',
};

export function describePlan(cells: PlanCell[], language: 'ja' | 'en'): string {
  if (language === 'ja') {
    return cells
      .map((c) => `- ${TYPE_LABEL_JA[c.type]} / 難易度「${DIFF_LABEL_JA[c.difficulty]}」: ${c.count}問`)
      .join('\n');
  }
  return cells
    .map((c) => `- ${c.type} / difficulty "${c.difficulty}": ${c.count} question(s)`)
    .join('\n');
}
