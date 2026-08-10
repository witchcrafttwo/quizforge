// server/src/plan.ts と同じ配分ロジック（画面で内訳をプレビューするために複製）。
import type { Difficulty, QuestionType, QuizConfig } from './types';

export interface PlanCell {
  type: QuestionType;
  difficulty: Difficulty;
  count: number;
}

export function allocate<K extends string>(total: number, weights: Record<K, number>): Record<K, number> {
  const keys = Object.keys(weights) as K[];
  const sanitized = keys.map((k) => Math.max(0, weights[k] || 0));
  const sum = sanitized.reduce((a, b) => a + b, 0);
  const shares = sum > 0 ? sanitized.map((w) => (w / sum) * total) : keys.map(() => total / keys.length);

  const floors = shares.map((s) => Math.floor(s));
  let remaining = total - floors.reduce((a, b) => a + b, 0);
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

export const TYPE_LABEL: Record<QuestionType, string> = {
  multiple_choice: '5択',
  multi_select: '複数選択',
  short_answer: '記述',
  cloze: '穴埋め',
};

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: '易',
  medium: '標準',
  hard: '難',
};
