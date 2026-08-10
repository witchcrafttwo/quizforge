// 出題設定を端末内（localStorage）に保存する。サーバには送らない画面の好み。
// Cookie を使わないのは、毎リクエストのヘッダーに載って無駄な通信になるため。
import type { QuizConfig } from './types';

const KEY = 'quizforge.quizConfig';

export const DEFAULT_CONFIG: QuizConfig = {
  questionCount: 10,
  typeRatio: { multiple_choice: 4, multi_select: 2, short_answer: 1, cloze: 3 },
  difficultyRatio: { easy: 3, medium: 5, hard: 2 },
  language: 'ja',
  focus: '',
};

const int = (value: unknown, fallback: number, max = 100): number => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= max ? n : fallback;
};

/**
 * 保存値は信用せず、形が崩れていても既定値で埋めて必ず有効な設定を返す。
 * 出題形式が増減したときに壊れないようにするため。
 */
function normalize(raw: unknown): QuizConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_CONFIG;
  const value = raw as Partial<QuizConfig>;
  const type = value.typeRatio ?? DEFAULT_CONFIG.typeRatio;
  const difficulty = value.difficultyRatio ?? DEFAULT_CONFIG.difficultyRatio;

  const typeRatio = {
    multiple_choice: int(type.multiple_choice, DEFAULT_CONFIG.typeRatio.multiple_choice),
    multi_select: int(type.multi_select, DEFAULT_CONFIG.typeRatio.multi_select),
    short_answer: int(type.short_answer, DEFAULT_CONFIG.typeRatio.short_answer),
    cloze: int(type.cloze, DEFAULT_CONFIG.typeRatio.cloze),
  };
  const difficultyRatio = {
    easy: int(difficulty.easy, DEFAULT_CONFIG.difficultyRatio.easy),
    medium: int(difficulty.medium, DEFAULT_CONFIG.difficultyRatio.medium),
    hard: int(difficulty.hard, DEFAULT_CONFIG.difficultyRatio.hard),
  };

  // すべて 0 だと配分できないので既定値へ戻す。
  const typeSum = Object.values(typeRatio).reduce((a, b) => a + b, 0);
  const diffSum = Object.values(difficultyRatio).reduce((a, b) => a + b, 0);

  return {
    questionCount: Math.min(50, Math.max(1, int(value.questionCount, 10, 50))),
    typeRatio: typeSum > 0 ? typeRatio : DEFAULT_CONFIG.typeRatio,
    difficultyRatio: diffSum > 0 ? difficultyRatio : DEFAULT_CONFIG.difficultyRatio,
    language: value.language === 'en' ? 'en' : 'ja',
    // 出題範囲の自由記述は資料ごとに変わるので復元しない。
    focus: '',
  };
}

export function loadConfig(): QuizConfig {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? normalize(JSON.parse(raw)) : DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: QuizConfig): void {
  try {
    const { focus: _focus, ...rest } = config;
    localStorage.setItem(KEY, JSON.stringify(rest));
  } catch {
    // プライベートモードで localStorage が使えない場合は黙って諦める。
  }
}
