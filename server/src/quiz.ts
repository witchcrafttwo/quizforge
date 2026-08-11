import { randomUUID } from 'node:crypto';
import type { ContentBlock, Tool } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { converseForJson, describeSources, toContentBlocks, type TokenUsage } from './bedrock.js';
import { isValidCloze } from './cloze.js';
import { buildPlan } from './plan.js';
import { quizSystemPrompt, quizUserPrompt, replacementUserPrompt } from './prompts.js';
import type { GenerateRequest, Question, Quiz } from './types.js';

const submitQuizTool: Tool = {
  toolSpec: {
    name: 'submit_quiz',
    description: '生成したクイズを提出する。',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '資料の主題を表す簡潔なタイトル' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['multiple_choice', 'multi_select', 'short_answer', 'cloze'],
                },
                difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
                question: { type: 'string' },
                choices: {
                  type: 'array',
                  items: { type: 'string' },
                  minItems: 5,
                  maxItems: 5,
                  description: 'multiple_choice のときのみ。ちょうど5件。',
                },
                answerIndex: {
                  type: 'integer',
                  minimum: 0,
                  maximum: 4,
                  description: 'multiple_choice の正解の 0 始まりインデックス。',
                },
                answerIndexes: {
                  type: 'array',
                  items: { type: 'integer', minimum: 0, maximum: 4 },
                  minItems: 2,
                  maxItems: 4,
                  description: 'multi_select の正解インデックス。2〜4件、重複なし。',
                },
                answerText: { type: 'string', description: 'short_answer の模範解答。' },
                keyPoints: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'short_answer の採点観点。2〜4件。',
                },
                blanks: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 4,
                  description:
                    'cloze のときのみ。question 中の {{1}}{{2}}… と同じ順序・同じ個数。',
                  items: {
                    type: 'object',
                    properties: {
                      answers: {
                        type: 'array',
                        items: { type: 'string' },
                        minItems: 1,
                        description: '許容する表記。先頭が代表表記。',
                      },
                    },
                    required: ['answers'],
                  },
                },
                explanation: { type: 'string' },
                sourceQuote: { type: 'string' },
              },
              required: ['type', 'difficulty', 'question', 'explanation'],
            },
          },
        },
        required: ['title', 'questions'],
      },
    },
  },
};

/**
 * 一部のモデルは tool use の入力で配列を JSON 文字列にして返す
 * （Sonnet 5 に資料を添付した場合に確認）。文字列なら復元してから検証する。
 */
function parseIfJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

const looseArray = <T extends z.ZodTypeAny>(item: T, minItems = 0) =>
  z.preprocess(parseIfJsonString, z.array(item).min(minItems));

const rawQuestionSchema = z.object({
  type: z.enum(['multiple_choice', 'multi_select', 'short_answer', 'cloze']),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  question: z.string().trim().min(1),
  choices: looseArray(z.string().trim().min(1)).optional(),
  answerIndex: z.coerce.number().int().optional(),
  answerIndexes: looseArray(z.coerce.number().int()).optional(),
  answerText: z.string().trim().optional(),
  keyPoints: looseArray(z.string().trim().min(1)).optional(),
  blanks: looseArray(
    z.object({ answers: looseArray(z.string().trim().min(1), 1) }),
  ).optional(),
  explanation: z.string().trim().default(''),
  sourceQuote: z.string().trim().optional(),
});

const rawQuizSchema = z.object({
  title: z.string().trim().min(1).catch('生成されたクイズ'),
  questions: looseArray(z.unknown()),
});

type RawQuestion = z.infer<typeof rawQuestionSchema>;

/**
 * 正解位置の偏りをモデル任せにしないため、選択肢をサーバ側でシャッフルする。
 * 元のインデックス列も返すので、複数正解の付け替えにも使える。
 */
function shuffleChoices(choices: string[]): { choices: string[]; order: number[] } {
  const order = choices.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = order[i] as number;
    const b = order[j] as number;
    order[i] = b;
    order[j] = a;
  }
  return { choices: order.map((i) => choices[i] as string), order };
}

/** 選択肢が5件・重複なしであることを確認する。 */
function validChoices(choices: string[]): boolean {
  if (choices.length !== 5) return false;
  return new Set(choices.map((c) => c.trim().toLowerCase())).size === 5;
}

function normalizeQuestion(raw: RawQuestion): Question | null {
  if (raw.type === 'multiple_choice') {
    const choices = raw.choices ?? [];
    const answerIndex = raw.answerIndex ?? -1;
    if (!validChoices(choices)) return null;
    if (answerIndex < 0 || answerIndex > 4) return null;

    const { choices: shuffled, order } = shuffleChoices(choices);
    return {
      id: randomUUID(),
      type: 'multiple_choice',
      difficulty: raw.difficulty,
      question: raw.question,
      choices: shuffled,
      answerIndex: order.indexOf(answerIndex),
      explanation: raw.explanation,
      sourceQuote: raw.sourceQuote,
    };
  }

  if (raw.type === 'multi_select') {
    const choices = raw.choices ?? [];
    if (!validChoices(choices)) return null;

    // 2〜4件・重複なし・範囲内でなければ採点が成立しないので捨てる。
    const unique = [...new Set(raw.answerIndexes ?? [])].filter((i) => i >= 0 && i <= 4);
    if (unique.length < 2 || unique.length > 4) return null;

    const { choices: shuffled, order } = shuffleChoices(choices);
    return {
      id: randomUUID(),
      type: 'multi_select',
      difficulty: raw.difficulty,
      question: raw.question,
      choices: shuffled,
      answerIndexes: unique.map((i) => order.indexOf(i)).sort((a, b) => a - b),
      explanation: raw.explanation,
      sourceQuote: raw.sourceQuote,
    };
  }

  if (raw.type === 'cloze') {
    const blanks = raw.blanks ?? [];
    // 空欄マーカーと blanks が食い違う問題は採点できないので捨てる。
    if (!isValidCloze(raw.question, blanks)) return null;
    return {
      id: randomUUID(),
      type: 'cloze',
      difficulty: raw.difficulty,
      question: raw.question,
      blanks,
      explanation: raw.explanation,
      sourceQuote: raw.sourceQuote,
    };
  }

  if (!raw.answerText) return null;
  return {
    id: randomUUID(),
    type: 'short_answer',
    difficulty: raw.difficulty,
    question: raw.question,
    answerText: raw.answerText,
    keyPoints: raw.keyPoints?.length ? raw.keyPoints : [raw.answerText],
    explanation: raw.explanation,
    sourceQuote: raw.sourceQuote,
  };
}

/** 資料とテキストから Converse のコンテンツブロックを組む。 */
function buildContent(request: GenerateRequest): ContentBlock[] {
  const { files, text, config } = request;
  const content: ContentBlock[] = [];
  if (files.length > 0) content.push(...toContentBlocks(files));
  if (text?.trim()) {
    content.push({
      text:
        config.language === 'ja'
          ? `--- 追加の教材テキスト ---\n${text.trim()}\n--- ここまで ---`
          : `--- Additional material text ---\n${text.trim()}\n--- end ---`,
    });
  }
  return content;
}

/**
 * 不適切な問題の差し替え用に、同じ形式・難易度の問題を1問だけ作る。
 * avoid には既存の問題文を渡して重複を避けさせる。
 */
export async function generateReplacement(
  request: GenerateRequest,
  target: { type: Question['type']; difficulty: Question['difficulty'] },
  avoid: string[],
): Promise<{ question: Question; usage: TokenUsage }> {
  const { config, files } = request;
  const plan = [{ type: target.type, difficulty: target.difficulty, count: 1 }];

  const content = buildContent(request);
  content.push({
    text: replacementUserPrompt(config, plan, describeSources(files), avoid),
  });

  const { data: raw, usage } = await converseForJson<unknown>({
    system: quizSystemPrompt(config.language),
    content,
    tool: submitQuizTool,
    maxTokens: 4096,
    temperature: 0.8,
  });

  const parsed = rawQuizSchema.parse(raw);
  const question = parsed.questions
    .map((item) => rawQuestionSchema.safeParse(item))
    .flatMap((result) => (result.success ? [result.data] : []))
    .map(normalizeQuestion)
    .find((q): q is Question => q !== null && q.type === target.type);

  if (!question) {
    throw Object.assign(
      new Error('差し替え用の問題を作成できませんでした。もう一度試してください。'),
      { status: 502 },
    );
  }
  return { question, usage };
}

export async function generateQuiz(
  request: GenerateRequest,
): Promise<{ quiz: Quiz; usage: TokenUsage }> {
  const { config, files } = request;
  const plan = buildPlan(config);

  const content = buildContent(request);
  content.push({ text: quizUserPrompt(config, plan, describeSources(files)) });

  // 配列を JSON 文字列として返すモデル（Sonnet 5 など）はエスケープ分だけ
  // 出力が膨らむため、余裕を持たせる。足りないと途中で切れて復元できない。
  const maxTokens = Math.min(64000, Math.max(8192, 4000 + config.questionCount * 1600));

  const { data: raw, usage } = await converseForJson<unknown>({
    system: quizSystemPrompt(config.language),
    content,
    tool: submitQuizTool,
    maxTokens,
    temperature: 0.6,
  });

  const parsed = rawQuizSchema.parse(raw);
  const questions = parsed.questions
    .map((item) => rawQuestionSchema.safeParse(item))
    .flatMap((result) => (result.success ? [result.data] : []))
    .map(normalizeQuestion)
    .flatMap((q) => (q ? [q] : []));

  if (questions.length === 0) {
    throw new Error('有効な問題を生成できませんでした。資料の内容量を増やすか、出題数を減らして再試行してください。');
  }

  return {
    quiz: {
      id: randomUUID(),
      title: parsed.title,
      createdAt: new Date().toISOString(),
      config,
      sourceNames: files.map((f) => f.name),
      questions,
    },
    usage,
  };
}
