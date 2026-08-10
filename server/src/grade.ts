import type { Tool } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { GRADER_MODEL_ID, converseForJson, type TokenUsage } from './bedrock.js';
import { graderSystemPrompt } from './prompts.js';
import type { GradeRequest, GradeResult } from './types.js';

const submitGradesTool: Tool = {
  toolSpec: {
    name: 'submit_grades',
    description: '記述式解答の採点結果を提出する。',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          grades: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                questionId: { type: 'string' },
                score: { type: 'integer', minimum: 0, maximum: 100 },
                verdict: { type: 'string', enum: ['correct', 'partial', 'incorrect'] },
                feedback: { type: 'string' },
              },
              required: ['questionId', 'score', 'verdict', 'feedback'],
            },
          },
        },
        required: ['grades'],
      },
    },
  },
};

const gradesSchema = z.object({
  grades: z.array(
    z.object({
      questionId: z.string(),
      score: z.coerce.number().min(0).max(100),
      verdict: z.enum(['correct', 'partial', 'incorrect']),
      feedback: z.string().default(''),
    }),
  ),
});

function renderItems(request: GradeRequest): string {
  return request.items
    .map((item, index) => {
      const points = item.keyPoints.map((p) => `    - ${p}`).join('\n');
      return [
        `[${index + 1}] questionId: ${item.questionId}`,
        `問題: ${item.question}`,
        `模範解答: ${item.modelAnswer}`,
        `採点観点:\n${points || '    - （なし）'}`,
        `受験者の解答: ${item.userAnswer.trim() || '（未記入）'}`,
      ].join('\n');
    })
    .join('\n\n');
}

export async function gradeShortAnswers(
  request: GradeRequest,
): Promise<{ results: GradeResult[]; usage: TokenUsage | null }> {
  if (request.items.length === 0) return { results: [], usage: null };

  const { data: raw, usage } = await converseForJson<unknown>({
    modelId: GRADER_MODEL_ID,
    system: graderSystemPrompt(request.language),
    content: [{ text: `以下の ${request.items.length} 件を採点してください。\n\n${renderItems(request)}` }],
    tool: submitGradesTool,
    maxTokens: Math.min(16000, 1000 + request.items.length * 400),
    temperature: 0,
  });

  const parsed = gradesSchema.parse(raw);
  const byId = new Map(parsed.grades.map((g) => [g.questionId, g]));

  // モデルが取りこぼした項目は 0 点扱いにせず、未採点であることが分かる形で返す
  const results = request.items.map((item): GradeResult => {
    const grade = byId.get(item.questionId);
    if (!grade) {
      return {
        questionId: item.questionId,
        score: 0,
        verdict: 'incorrect',
        feedback: '採点結果を取得できませんでした。模範解答と見比べて自己採点してください。',
      };
    }
    return {
      questionId: item.questionId,
      score: Math.round(grade.score),
      verdict: grade.verdict,
      feedback: grade.feedback,
    };
  });

  return { results, usage };
}
