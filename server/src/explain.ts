import { converseForText, type TokenUsage } from './bedrock.js';
import { modelFor } from './modelConfig.js';
import type { AnswerValue, Question } from './types.js';

const KEYS = ['A', 'B', 'C', 'D', 'E'];

function systemPrompt(language: 'ja' | 'en'): string {
  if (language === 'en') {
    return `You explain quiz answers to a learner who has just answered.

- Ground every claim in the supplied question, correct answer, and reference explanation. Never invent facts beyond them.
- Start from the learner's own answer: if it is wrong, name the specific misunderstanding it implies. If it is right, confirm briefly and add the point most worth remembering.
- Then explain why the correct answer is correct.
- Plain prose, no headings, no bullet lists. 3-6 sentences.
- Write in English.`;
  }

  return `あなたは解答直後の学習者に解説をする講師です。

- 与えられた問題文・正解・参考解説の範囲だけを根拠にする。それを超える事実を作らない。
- まず学習者自身の解答から始める。誤っている場合は、その解答が示している具体的な誤解を指摘する。正しい場合は簡潔に確認し、覚えておく価値のある点を1つ補う。
- 次に、なぜ正解が正しいのかを説明する。
- 見出しや箇条書きは使わず、平文で3〜6文。
- 日本語で書く。`;
}

function renderUserAnswer(question: Question, response: AnswerValue): string {
  if (question.type === 'multiple_choice') {
    const index = typeof response === 'number' ? response : -1;
    const choice = question.choices?.[index];
    return choice ? `${KEYS[index] ?? index}. ${choice}` : '（未回答）';
  }
  if (question.type === 'multi_select') {
    const picked = (Array.isArray(response) ? response : [])
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v));
    if (picked.length === 0) return '（未回答）';
    return picked
      .sort((a, b) => a - b)
      .map((i) => `${KEYS[i] ?? i}. ${question.choices?.[i] ?? ''}`)
      .join(' / ');
  }

  if (question.type === 'cloze') {
    const given = Array.isArray(response) ? response.map(String) : [];
    const filled = (question.blanks ?? []).map(
      (_, i) => `(${i + 1}) ${given[i]?.trim() || '（空欄）'}`,
    );
    return filled.join('、') || '（未回答）';
  }
  return typeof response === 'string' && response.trim() ? response : '（未記入）';
}

function renderCorrect(question: Question): string {
  if (question.type === 'multiple_choice') {
    const index = question.answerIndex ?? -1;
    const choice = question.choices?.[index];
    return choice ? `${KEYS[index] ?? index}. ${choice}` : '（不明）';
  }
  if (question.type === 'multi_select') {
    return (question.answerIndexes ?? [])
      .map((i) => `${KEYS[i] ?? i}. ${question.choices?.[i] ?? ''}`)
      .join(' / ');
  }
  if (question.type === 'cloze') {
    return (question.blanks ?? [])
      .map((blank, i) => `(${i + 1}) ${blank.answers[0] ?? ''}`)
      .join('、');
  }
  return question.answerText ?? '';
}

/**
 * 学習者の解答に合わせた解説を生成する。
 * 作問時に付いている explanation を根拠として渡し、そこから逸脱させない。
 */
export async function explainAnswer(
  question: Question,
  response: AnswerValue,
  language: 'ja' | 'en',
): Promise<{ text: string; usage: TokenUsage }> {
  const parts = [
    `問題（形式: ${question.type}）:`,
    question.question,
    '',
    ...((question.type === 'multiple_choice' || question.type === 'multi_select') &&
    question.choices
      ? ['選択肢:', ...question.choices.map((c, i) => `${KEYS[i]}. ${c}`), '']
      : []),
    `正解: ${renderCorrect(question)}`,
    `学習者の解答: ${renderUserAnswer(question, response)}`,
    '',
    `参考解説（作問時に生成されたもの）: ${question.explanation}`,
    ...(question.sourceQuote ? [`資料からの引用: 「${question.sourceQuote}」`] : []),
  ];

  const { data, usage } = await converseForText({
    modelId: modelFor('explainer'),
    system: systemPrompt(language),
    content: [{ text: parts.join('\n') }],
    maxTokens: 1200,
  });

  return { text: data, usage };
}
