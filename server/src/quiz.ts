import { randomUUID } from 'node:crypto';
import type { ContentBlock, Tool } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { converseForJson, describeSources, toContentBlocks, type TokenUsage } from './bedrock.js';
import { isValidCloze } from './cloze.js';
import { modelFor } from './modelConfig.js';
import { buildPlan, type PlanCell } from './plan.js';
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
          title: {
            type: 'string',
            maxLength: 60,
            description:
              '資料の主題を表す簡潔なタイトル。装飾や「タイトル:」のような前置きを付けない。',
          },
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
                  description: 'multiple_choice / multi_select のときのみ。ちょうど5件。',
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
 * 先頭にある対応の取れた JSON 値だけを切り出す。
 * Sonnet 5 は tool use の入力でオブジェクト全体を文字列化することがあり、
 * questions の値が `[{...}],"title":"..."}` のように後続まで含んでしまう。
 * 末尾の余りを捨てないと JSON.parse が失敗する。
 */
function sliceLeadingJson(text: string): string | null {
  const open = text[0];
  if (open !== '[' && open !== '{') return null;
  const close = open === '[' ? ']' : '}';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return null;
}

/** ```json … ``` で囲んで返すモデルがあるため、フェンスを外す。 */
function stripFence(text: string): string {
  const fenced = /^```[a-z]*\s*\n?([\s\S]*?)\n?```$/i.exec(text);
  return fenced?.[1]?.trim() ?? text;
}

/**
 * JSON の文字列リテラルの中に生の改行やタブが混ざっていると JSON.parse が落ちる。
 * 文字列の内側にいる間だけ制御文字をエスケープして通せるようにする。
 */
function escapeControlChars(text: string): string {
  const ESCAPES: Record<string, string> = {
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
    '\b': '\\b',
    '\f': '\\f',
  };

  let out = '';
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString && !escaped && char.charCodeAt(0) < 0x20) {
      out += ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      continue;
    }
    out += char;

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    }
  }
  return out;
}

/** 制御文字の混入まで面倒を見た JSON.parse。駄目なら undefined。 */
function tryParseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    // 生の改行が原因なら、エスケープし直せば通る。
  }
  try {
    return { value: JSON.parse(escapeControlChars(text)) };
  } catch {
    return undefined;
  }
}

/**
 * 閉じ括弧まで届いていない配列から、完結している要素だけを取り出す。
 * 出力が途中で切れても、拾えた問題だけでクイズを作れるようにする。
 */
function salvageArrayElements(text: string): unknown[] | null {
  if (text[0] !== '[') return null;

  const items: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 1; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const element = tryParseJson(text.slice(start, i + 1));
        if (element) items.push(element.value);
        start = -1;
      }
      // 配列自体の閉じ括弧に到達した。
      if (depth < 0) break;
    }
  }
  return items.length > 0 ? items : null;
}

/** 配列を JSON 文字列で返すモデルがあるため、文字列なら復元してから検証する。 */
function parseIfJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = stripFence(value.trim());

  const candidate = sliceLeadingJson(trimmed);
  if (candidate !== null) {
    const parsed = tryParseJson(candidate);
    if (parsed) return parsed.value;
  }

  // 途中で切れているか壊れている。全滅させるより拾える分を活かす。
  const salvaged = salvageArrayElements(trimmed);
  if (salvaged) {
    console.warn(`[quiz] 壊れた JSON から ${salvaged.length} 件を復元しました。`);
    return salvaged;
  }

  console.error(
    `[quiz] 文字列化された JSON を復元できません。長さ=${trimmed.length}\n` +
      `  先頭=${trimmed.slice(0, 120)}\n  末尾=${trimmed.slice(-120)}`,
  );
  return value;
}

/**
 * tool use の入力で、あるキーの値に後続のキーまで巻き込んで文字列化するモデルがある。
 * 例: { questions: '[{...}],"title":"三角関数"}' のように、questions の値が
 * オブジェクトの残り全部を含んでしまう。この形はキー名を付け直せば元に戻せる。
 * 直さないと questions が配列にならないうえ、巻き込まれた title も失われる。
 */
function repairSwallowedObject(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;

  for (const [key, raw] of Object.entries(source)) {
    if (typeof raw !== 'string') continue;
    const trimmed = stripFence(raw.trim());
    // 巻き込まれた場合だけ、値の末尾がオブジェクトの閉じ括弧になる。
    if (!trimmed.endsWith('}')) continue;
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) continue;

    const restored = tryParseJson(`{${JSON.stringify(key)}:${trimmed}`);
    if (!restored) continue;
    const recovered = restored.value;
    if (recovered === null || typeof recovered !== 'object' || Array.isArray(recovered)) continue;

    // 巻き込まれたキーが実際に増えたときだけ差し替える。
    const extra = Object.keys(recovered).filter((k) => !(k in source));
    if (extra.length === 0) continue;

    console.warn(`[quiz] ${key} に巻き込まれていたキーを復元しました: ${extra.join(', ')}`);
    return { ...source, ...recovered };
  }
  return value;
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
  blanks: looseArray(z.object({ answers: looseArray(z.string().trim().min(1), 1) })).optional(),
  explanation: z.string().trim().default(''),
  sourceQuote: z.string().trim().optional(),
});

// title はここでは検証せず、後段で整形と代替を当てる。
// 見出しが気に入らないだけで生成全体を失敗させたくない。
const rawQuizSchema = z.preprocess(
  repairSwallowedObject,
  z.object({
    title: z.unknown(),
    questions: looseArray(z.unknown()),
  }),
);

type RawQuestion = z.infer<typeof rawQuestionSchema>;

/* ---------- タイトル ---------- */

/** quizTitleSchema（改名時の上限）と揃える。 */
const TITLE_MAX = 120;

const TITLE_WRAPPERS: [string, string][] = [
  ['「', '」'],
  ['『', '』'],
  ['【', '】'],
  ['"', '"'],
  ['“', '”'],
  ["'", "'"],
];

/**
 * モデルの見出しには前置きや飾りが混ざることがある。表示に使える形へ整える。
 * 整えても中身が無ければ空文字を返し、呼び出し側で代替を当てる。
 */
function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') return '';

  // 改行が入っていたら1行目だけを見出しにする。
  let title = stripFence(value.trim()).split(/\r?\n/)[0]?.trim() ?? '';
  // 強調記号を落とす。
  title = title.replace(/\*\*/g, '').replace(/^#+\s*/, '').trim();
  // 「タイトル: 〇〇」のような前置きを外す。
  title = title.replace(/^(?:タイトル|題名|見出し|title)\s*[:：]\s*/i, '').trim();

  // 全体を囲っているだけの括弧や引用符を外す。
  // 「あ」と「い」の違い のように内側で閉じている場合は触らない。
  for (const [open, close] of TITLE_WRAPPERS) {
    if (!title.startsWith(open) || !title.endsWith(close)) continue;
    if (title.length <= open.length + close.length) continue;
    const inner = title.slice(open.length, -close.length);
    if (inner.includes(close)) continue;
    title = inner.trim();
    break;
  }

  // 末尾の句点や区切り記号は見出しに不要。
  title = title.replace(/[。．.、,:：;；\s]+$/, '').trim();

  if (title.length <= TITLE_MAX) return title;
  return `${title.slice(0, TITLE_MAX - 1).trim()}…`;
}

/** 見出しとして意味を持たない語だけのものは、付いていないものとして扱う。 */
const USELESS_TITLES = new Set([
  'クイズ',
  'テスト',
  '問題',
  '練習問題',
  '確認テスト',
  '小テスト',
  '無題',
  'quiz',
  'test',
  'questions',
  'untitled',
  'material 1',
]);

function isUsableTitle(title: string): boolean {
  if (title.length === 0) return false;
  return !USELESS_TITLES.has(title.toLowerCase());
}

/**
 * モデルが使える見出しを返さなかったときの代替。
 * 汎用の文言より、資料のファイル名や本文の書き出しのほうが手掛かりになる。
 */
function fallbackTitle(request: GenerateRequest): string {
  const fileName = request.files[0]?.name;
  if (fileName) {
    // 拡張子を外す。名前が拡張子だけの場合は落とさない。
    const base = fileName.replace(/\.[^.\s]+$/, '').trim() || fileName.trim();
    if (base) return cleanTitle(base) || base.slice(0, TITLE_MAX);
  }

  const firstLine = request.text
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine) return cleanTitle(firstLine) || firstLine.slice(0, TITLE_MAX);

  return '無題のクイズ';
}

function resolveTitle(raw: unknown, request: GenerateRequest): string {
  const cleaned = cleanTitle(raw);
  if (isUsableTitle(cleaned)) return cleaned;

  const fallback = fallbackTitle(request);
  console.warn(
    `[quiz] 使えるタイトルが得られなかったため代替を使います（モデルの値: ${JSON.stringify(raw)?.slice(0, 80) ?? 'なし'} → ${fallback}）`,
  );
  return fallback;
}

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

/** 捨てた理由を集めて、なぜ問題数が減ったのか分かるようにする。 */
interface DropLog {
  reasons: string[];
}

/**
 * 復元にも失敗した出力を記録する。同じ壊れ方が続くならプロンプトかモデルの問題なので、
 * 形と先頭だけは残して追えるようにする。資料の中身は載せない。
 */
function logUnreadableOutput(raw: unknown, reason?: string): void {
  const shape =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.entries(raw as Record<string, unknown>)
          .map(([key, value]) => `${key}:${Array.isArray(value) ? 'array' : typeof value}`)
          .join(', ')
      : typeof raw;

  console.error(
    `[quiz] モデルの出力を解釈できません（${reason ?? '理由不明'}）\n` +
      `  形=${shape}\n  先頭=${JSON.stringify(raw)?.slice(0, 300) ?? 'なし'}`,
  );
}

function normalizeQuestion(raw: RawQuestion, drops?: DropLog): Question | null {
  const drop = (reason: string): null => {
    drops?.reasons.push(`${raw.type}/${raw.difficulty}: ${reason}`);
    return null;
  };

  if (raw.type === 'multiple_choice') {
    const choices = raw.choices ?? [];
    const answerIndex = raw.answerIndex ?? -1;
    if (!validChoices(choices)) return drop(`選択肢が5件・重複なしでない（${choices.length}件）`);
    if (answerIndex < 0 || answerIndex > 4) {
      return drop(`正解インデックスが範囲外（${answerIndex}）`);
    }

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
    if (!validChoices(choices)) return drop(`選択肢が5件・重複なしでない（${choices.length}件）`);

    // 2〜4件・重複なし・範囲内でなければ採点が成立しないので捨てる。
    const unique = [...new Set(raw.answerIndexes ?? [])].filter((i) => i >= 0 && i <= 4);
    if (unique.length < 2 || unique.length > 4) {
      return drop(`正解が2〜4件でない（${unique.length}件）`);
    }

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
    if (!isValidCloze(raw.question, blanks)) {
      return drop(`空欄マーカーと解答の対応が取れない（解答${blanks.length}件）`);
    }
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

  if (!raw.answerText) return drop('模範解答が無い');
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
  const plan: PlanCell[] = [{ type: target.type, difficulty: target.difficulty, count: 1 }];

  const content = buildContent(request);
  content.push({ text: replacementUserPrompt(config, plan, describeSources(files), avoid) });

  const { data: raw, usage } = await converseForJson<unknown>({
    modelId: modelFor('generate'),
    system: quizSystemPrompt(config.language),
    content,
    tool: submitQuizTool,
    maxTokens: 8192,
    temperature: 0.8,
  });

  const parsed = rawQuizSchema.safeParse(raw);
  const question = !parsed.success
    ? undefined
    : parsed.data.questions
        .map((item) => rawQuestionSchema.safeParse(item))
        .flatMap((result) => (result.success ? [result.data] : []))
        .map((item) => normalizeQuestion(item))
        .find((q): q is Question => q !== null && q.type === target.type);

  if (!parsed.success) logUnreadableOutput(raw, parsed.error.issues[0]?.message);

  if (!question) {
    throw Object.assign(
      new Error('差し替え用の問題を作成できませんでした。もう一度試してください。'),
      { status: 502 },
    );
  }
  return { question, usage };
}

/**
 * 不足分だけを追加生成する。既存の問題文を渡して重複を避ける。
 * 形式と難易度の内訳は、元の計画から不足している分を割り当てる。
 */
async function topUpQuestions(
  request: GenerateRequest,
  existing: Question[],
  shortfall: number,
  plan: PlanCell[],
): Promise<{ items: unknown[]; usage: TokenUsage }> {
  const { config, files } = request;

  // 計画と実績の差を取り、足りていないセルに割り当てる。
  const have = new Map<string, number>();
  for (const q of existing) {
    const key = `${q.type}:${q.difficulty}`;
    have.set(key, (have.get(key) ?? 0) + 1);
  }

  const missing: PlanCell[] = [];
  for (const cell of plan) {
    const key = `${cell.type}:${cell.difficulty}`;
    const lack = cell.count - (have.get(key) ?? 0);
    if (lack > 0) missing.push({ ...cell, count: lack });
  }
  const first = plan[0];
  if (missing.length === 0 && first) missing.push({ ...first, count: shortfall });

  const content = buildContent(request);
  content.push({
    text: replacementUserPrompt(
      config,
      missing,
      describeSources(files),
      existing.map((q) => q.question),
    ),
  });

  const { data, usage } = await converseForJson<unknown>({
    modelId: modelFor('generate'),
    system: quizSystemPrompt(config.language),
    content,
    tool: submitQuizTool,
    maxTokens: Math.min(32000, 4000 + shortfall * 1600),
    temperature: 0.8,
  });

  // 補充が読めなくても本体の結果は返したいので、ここでは投げない。
  // 消費したトークンは呼び出し側で課金に足せるよう usage を返す。
  const parsed = rawQuizSchema.safeParse(data);
  if (!parsed.success) {
    logUnreadableOutput(data, parsed.error.issues[0]?.message);
    return { items: [], usage };
  }
  return { items: parsed.data.questions, usage };
}

export async function generateQuiz(
  request: GenerateRequest,
): Promise<{ quiz: Quiz; usage: TokenUsage }> {
  const { config, files } = request;
  const plan = buildPlan(config);

  const content = buildContent(request);
  content.push({ text: quizUserPrompt(config, plan, describeSources(files)) });

  // 配列を JSON 文字列として返すモデルはエスケープ分だけ出力が膨らむため余裕を持たせる。
  const maxTokens = Math.min(64000, Math.max(8192, 4000 + config.questionCount * 1600));

  const { data: raw, usage } = await converseForJson<unknown>({
    modelId: modelFor('generate'),
    system: quizSystemPrompt(config.language),
    content,
    tool: submitQuizTool,
    maxTokens,
    temperature: 0.6,
  });

  const drops: DropLog = { reasons: [] };

  const parsed = rawQuizSchema.safeParse(raw);
  if (!parsed.success) {
    logUnreadableOutput(raw, parsed.error.issues[0]?.message);
    // Zod の英語の詳細をそのまま利用者に見せないよう、原因の分かる文言に置き換える。
    throw Object.assign(
      new Error('モデルの出力を解釈できませんでした。もう一度試してください。'),
      { status: 502 },
    );
  }

  const collect = (items: unknown[]): Question[] =>
    items
      .map((item) => {
        const result = rawQuestionSchema.safeParse(item);
        if (!result.success) {
          drops.reasons.push(`スキーマ違反: ${result.error.issues[0]?.message ?? '不明'}`);
          return null;
        }
        return normalizeQuestion(result.data, drops);
      })
      .flatMap((q) => (q ? [q] : []));

  const questions = collect(parsed.data.questions);

  if (questions.length === 0) {
    throw new Error(
      '有効な問題を生成できませんでした。資料の内容量を増やすか、出題数を減らして再試行してください。',
    );
  }

  // 検証で落ちた分を1回だけ補う。何度も呼ぶとコストと時間が読めなくなるので1回に限る。
  let inputTokens = usage.inputTokens;
  let outputTokens = usage.outputTokens;
  const shortfall = config.questionCount - questions.length;

  if (shortfall > 0) {
    console.warn(
      `[quiz] ${config.questionCount}問の指定に対し ${questions.length}問。` +
        `${shortfall}問を補充します。落ちた理由:\n  ${drops.reasons.join('\n  ')}`,
    );

    const topUp = await topUpQuestions(request, questions, shortfall, plan).catch(
      (error: unknown) => {
        console.error('[quiz] 補充に失敗（不足のまま返します）', error);
        return null;
      },
    );

    if (topUp) {
      questions.push(...collect(topUp.items));
      inputTokens += topUp.usage.inputTokens;
      outputTokens += topUp.usage.outputTokens;
    }
  }

  return {
    quiz: {
      id: randomUUID(),
      title: resolveTitle(parsed.data.title, request),
      createdAt: new Date().toISOString(),
      config,
      sourceNames: files.map((f) => f.name),
      questions: questions.slice(0, config.questionCount),
    },
    usage: { modelId: usage.modelId, inputTokens, outputTokens },
  };
}
