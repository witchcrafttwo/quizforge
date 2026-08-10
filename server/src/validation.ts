import { z } from 'zod';

export const uploadedFileSchema = z.object({
  name: z.string().min(1).max(255),
  base64: z.string().min(1),
  mimeType: z.string().default('application/octet-stream'),
});

export const quizConfigSchema = z.object({
  questionCount: z.coerce.number().int().min(1).max(50),
  typeRatio: z.object({
    multiple_choice: z.coerce.number().min(0).max(100),
    multi_select: z.coerce.number().min(0).max(100).default(0),
    short_answer: z.coerce.number().min(0).max(100),
    cloze: z.coerce.number().min(0).max(100).default(0),
  }),
  difficultyRatio: z.object({
    easy: z.coerce.number().min(0).max(100),
    medium: z.coerce.number().min(0).max(100),
    hard: z.coerce.number().min(0).max(100),
  }),
  focus: z.string().max(2000).optional(),
  language: z.enum(['ja', 'en']).default('ja'),
});

// ファイル数・サイズ・出題数の上限はプラン側（plans.ts）で判定する。
export const generateRequestSchema = z
  .object({
    config: quizConfigSchema,
    files: z.array(uploadedFileSchema).default([]),
    text: z.string().max(200_000).optional(),
  })
  .refine((v) => v.files.length > 0 || Boolean(v.text?.trim()), {
    message: '資料ファイルか教材テキストのどちらかが必要です。',
  })
  .refine(
    (v) => {
      const t = v.config.typeRatio;
      return t.multiple_choice + t.multi_select + t.short_answer + t.cloze > 0;
    },
    { message: '出題形式の比率がすべて 0 になっています。' },
  )
  .refine(
    (v) => {
      const d = v.config.difficultyRatio;
      return d.easy + d.medium + d.hard > 0;
    },
    { message: '難易度の比率がすべて 0 になっています。' },
  );

/* ---------- 認証 ---------- */

export const credentialsSchema = z.object({
  username: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[\w.\-@]+$/, { message: 'ユーザー名に使えるのは英数字と . - _ @ です' }),
  password: z.string().min(8).max(200),
});

export const signupSchema = credentialsSchema.extend({
  signupCode: z.string().min(1).max(200),
});

/* ---------- 解答 ---------- */

/**
 * multiple_choice は数値、multi_select はインデックスの配列、
 * short_answer は文字列、cloze は文字列配列。
 * 数値配列を先に試すことで、穴埋め用の文字列配列と取り違えない。
 */
export const submitAnswerSchema = z.object({
  questionId: z.string().uuid(),
  response: z.union([
    z.number().int().min(0).max(4),
    z.array(z.number().int().min(0).max(4)).max(5),
    z.string().max(10_000),
    z.array(z.string().max(500)).max(4),
  ]),
});

export const uuidSchema = z.string().uuid();

export const quizTitleSchema = z.string().trim().min(1).max(120);

/** null は解除（自動判定に戻す）。 */
export const questionMarkSchema = z.object({
  mark: z.enum(['review', 'mastered']).nullable(),
});

export const folderNameSchema = z.string().trim().min(1).max(60);
export const groupNameSchema = z.string().trim().min(1).max(60);

/** groupId が null なら全体配布。 */
export const shareSchema = z.object({
  kind: z.enum(['quiz', 'folder']),
  targetId: z.string().uuid(),
  groupId: z.string().uuid().nullable().default(null),
});

export const gradeRequestSchema = z.object({
  language: z.enum(['ja', 'en']).default('ja'),
  items: z
    .array(
      z.object({
        questionId: z.string().min(1),
        question: z.string().min(1),
        modelAnswer: z.string().default(''),
        keyPoints: z.array(z.string()).default([]),
        userAnswer: z.string().max(10_000).default(''),
      }),
    )
    .max(50),
});

/** USD / 100万トークン。0 なら単価未設定として扱う。 */
export const modelPriceSchema = z.object({
  inputPer1m: z.coerce.number().min(0).max(10_000),
  outputPer1m: z.coerce.number().min(0).max(10_000),
});

export const planLimitsSchema = z.object({
  name: z.string().trim().min(1).max(40),
  priceJpy: z.coerce.number().int().min(0).max(1_000_000),
  maxFiles: z.coerce.number().int().min(0).max(200),
  maxFileMb: z.coerce.number().min(0.1).max(4.5),
  maxTotalMb: z.coerce.number().min(0).max(500),
  maxQuestions: z.coerce.number().int().min(0).max(50),
  dailyGenerations: z.coerce.number().int().min(0).max(10_000),
  monthlyGenerations: z.coerce.number().int().min(0).max(100_000),
});
