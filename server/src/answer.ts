import type { TokenUsage } from './bedrock.js';
import { gradeCloze } from './cloze.js';
import { gradeShortAnswers } from './grade.js';
import type { AnswerValue, GradeResult, Question } from './types.js';

export interface GradedAnswer {
  result: GradeResult;
  /** Bedrock を使わなかった場合は null（選択・穴埋め）。 */
  usage: TokenUsage | null;
}

const KEYS = ['A', 'B', 'C', 'D', 'E'];

/**
 * 複数選択の採点。正解を選べば加点、誤りを選べば減点する。
 * 全部選べば満点になってしまうのを防ぐため (正答数 - 誤答数) / 正解数 を 0〜1 に丸める。
 */
function gradeMultiSelect(question: Question, response: AnswerValue): GradeResult {
  const correct = new Set(question.answerIndexes ?? []);
  const picked = new Set(
    (Array.isArray(response) ? response : [])
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v >= 0 && v <= 4),
  );

  if (correct.size === 0) {
    return {
      questionId: question.id,
      score: 0,
      verdict: 'incorrect',
      feedback: 'この問題の正解が壊れているため採点できません。',
    };
  }

  const hits = [...picked].filter((i) => correct.has(i));
  const falsePositives = [...picked].filter((i) => !correct.has(i));
  const missed = [...correct].filter((i) => !picked.has(i));

  const ratio = Math.max(0, (hits.length - falsePositives.length) / correct.size);
  const score = Math.round(Math.min(1, ratio) * 100);

  const verdict: GradeResult['verdict'] =
    missed.length === 0 && falsePositives.length === 0
      ? 'correct'
      : score > 0
        ? 'partial'
        : 'incorrect';

  const label = (list: number[]) =>
    list
      .sort((a, b) => a - b)
      .map((i) => KEYS[i] ?? String(i))
      .join('、');

  const notes: string[] = [`正解 ${correct.size} 個のうち ${hits.length} 個を選択。`];
  if (missed.length > 0) notes.push(`選び漏れ: ${label(missed)}`);
  if (falsePositives.length > 0) notes.push(`誤って選択: ${label(falsePositives)}`);
  if (missed.length === 0 && falsePositives.length === 0) notes.push('すべて正解です。');

  return {
    questionId: question.id,
    score,
    verdict,
    feedback: notes.join(' '),
  };
}

/**
 * 1問分を採点する。選択問題と穴埋めはサーバ内で判定でき、記述だけ Bedrock を呼ぶ。
 * 正解はクライアントを信用せず、必ずここで突き合わせる。
 */
export async function gradeAnswer(
  question: Question,
  response: AnswerValue,
  language: 'ja' | 'en',
): Promise<GradedAnswer> {
  if (question.type === 'multiple_choice') {
    const picked = typeof response === 'number' ? response : -1;
    const isCorrect = picked === question.answerIndex;
    return {
      usage: null,
      result: {
        questionId: question.id,
        score: isCorrect ? 100 : 0,
        verdict: isCorrect ? 'correct' : 'incorrect',
        feedback: isCorrect ? '正解です。' : '不正解です。解説を確認してください。',
      },
    };
  }

  if (question.type === 'multi_select') {
    return { usage: null, result: gradeMultiSelect(question, response) };
  }

  if (question.type === 'cloze') {
    const given = Array.isArray(response) ? response : [];
    return {
      usage: null,
      result: gradeCloze(question.id, question.blanks ?? [], given.map(String)),
    };
  }

  const userAnswer = typeof response === 'string' ? response : '';
  if (!userAnswer.trim()) {
    return {
      usage: null,
      result: {
        questionId: question.id,
        score: 0,
        verdict: 'incorrect',
        feedback: '未記入のため0点です。',
      },
    };
  }

  const { results, usage } = await gradeShortAnswers({
    language,
    items: [
      {
        questionId: question.id,
        question: question.question,
        modelAnswer: question.answerText ?? '',
        keyPoints: question.keyPoints ?? [],
        userAnswer,
      },
    ],
  });

  return {
    usage,
    result:
      results[0] ?? {
        questionId: question.id,
        score: 0,
        verdict: 'incorrect',
        feedback: '採点結果を取得できませんでした。模範解答と見比べて自己採点してください。',
      },
  };
}
