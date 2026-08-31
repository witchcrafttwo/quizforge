import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type DocumentFormat,
  type ImageFormat,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import type { UploadedFile } from './types.js';

export const REGION = process.env.AWS_REGION ?? 'us-east-1';
// 作問はドキュメント/画像をそのまま読める Claude を前提にしている。
// テキスト専用モデル（GLM 等）に差し替える場合は事前のテキスト抽出が別途必要。
export const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-opus-5';
export const GRADER_MODEL_ID = process.env.BEDROCK_GRADER_MODEL_ID ?? MODEL_ID;
// AI解説用。資料は読まずテキストだけを扱うので、テキスト専用モデルでも動く。
export const EXPLAINER_MODEL_ID = process.env.BEDROCK_EXPLAINER_MODEL_ID ?? MODEL_ID;
/**
 * 本命のモデルが 503 を返し続けたときの逃げ先。未設定なら切り替えない。
 * 同じモデルの別接頭辞（us. ↔ global.）を指定すると、単価も精度も変えずに
 * 混雑しているルーティングだけを避けられる。
 */
export const FALLBACK_MODEL_ID = process.env.BEDROCK_FALLBACK_MODEL_ID?.trim() || null;

// 再試行はこのモジュールで面倒を見るので、SDK 内部の粘りは浅くしておく。
// 両方が既定の3回ずつ粘ると、503 が続いたときに待ち時間が積み上がって
// 採点や解説の応答がプロキシのタイムアウトに近づく。
const client = new BedrockRuntimeClient({ region: REGION, maxAttempts: 2 });

/** SDK が自動で読む Bedrock API キーの環境変数名。この綴りは SDK 側の規約。 */
export const BEARER_TOKEN_ENV = 'AWS_BEARER_TOKEN_BEDROCK';

function mask(value: string): string {
  return value.length <= 8 ? '****' : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * 認証情報が解決できたかを確認する。Bedrock API キーを優先し、無ければ
 * IAM 認証情報のプロバイダチェーンを試す。値は伏せた形で返し、駄目なら null。
 */
export async function checkCredentials(): Promise<string | null> {
  const token = process.env[BEARER_TOKEN_ENV]?.trim();
  if (token) return `Bedrock API キー ${mask(token)}`;

  try {
    const resolved = await client.config.credentials();
    return resolved.accessKeyId ? `IAM 認証情報 ${mask(resolved.accessKeyId)}` : null;
  } catch {
    return null;
  }
}

const DOCUMENT_FORMATS: Record<string, DocumentFormat> = {
  pdf: 'pdf',
  csv: 'csv',
  doc: 'doc',
  docx: 'docx',
  xls: 'xls',
  xlsx: 'xlsx',
  html: 'html',
  htm: 'html',
  txt: 'txt',
  md: 'md',
};

const IMAGE_FORMATS: Record<string, ImageFormat> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
};

export const SUPPORTED_EXTENSIONS = [
  ...Object.keys(DOCUMENT_FORMATS),
  ...Object.keys(IMAGE_FORMATS),
];

/** Bedrock の document name は英数字・空白・ハイフン・括弧のみ。日本語ファイル名はそのまま使えない。 */
function safeName(index: number): string {
  return `material ${index + 1}`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export class UnsupportedFileError extends Error {}

/** アップロードされたファイルを Converse API のコンテンツブロックへ変換する。 */
export function toContentBlocks(files: UploadedFile[]): ContentBlock[] {
  return files.map((file, index) => {
    const ext = extensionOf(file.name);
    const bytes = Buffer.from(file.base64, 'base64');

    const imageFormat = IMAGE_FORMATS[ext];
    if (imageFormat) {
      return { image: { format: imageFormat, source: { bytes } } } satisfies ContentBlock;
    }

    const docFormat = DOCUMENT_FORMATS[ext];
    if (docFormat) {
      return {
        document: { format: docFormat, name: safeName(index), source: { bytes } },
      } satisfies ContentBlock;
    }

    throw new UnsupportedFileError(
      `未対応の拡張子です: ${file.name}（対応: ${SUPPORTED_EXTENSIONS.join(', ')}）`,
    );
  });
}

/** ファイル名と Bedrock 側の名前の対応表。プロンプト内で参照させる。 */
export function describeSources(files: UploadedFile[]): string {
  return files.map((f, i) => `- ${safeName(i)} = 「${f.name}」`).join('\n');
}

/** 一度拒否されたパラメータをモデル単位で覚えておくための記録。 */
const NO_TEMPERATURE_MODELS = new Set<string>();
const NO_TOOL_CHOICE_MODELS = new Set<string>();

/* ---------- 一時的な失敗への備え ---------- */

/** 同じモデルに何回まで粘るか。 */
const TRANSIENT_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 待ち時間は指数で伸ばし、±20% のゆらぎを足して再試行が同時に集まらないようにする。 */
function backoffMs(retryIndex: number): number {
  const base = 1000 * 2 ** retryIndex; // 1s, 2s, 4s...
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * 待って掛け直せば直る種類の失敗か。
 * クロスリージョン推論プロファイルは混雑すると ServiceUnavailableException を
 * 返す。モデルアクセス不可（403）や入力不正（400）はここに含めない。
 */
function isTransient(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  if (
    name === 'ServiceUnavailableException' ||
    name === 'ThrottlingException' ||
    name === 'ModelNotReadyException' ||
    name === 'InternalServerException'
  ) {
    return true;
  }
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return status === 429 || status === 500 || status === 503;
}

/**
 * モデルごとの癖（temperature や toolChoice を受け付けない）を吸収する。
 * 拒否された要素を外して掛け直し、判明した制約は覚えて次回以降の往復を省く。
 */
async function negotiateParams<R>(
  modelId: string,
  send: (opts: { forceTool: boolean; withTemperature: boolean }) => Promise<R>,
): Promise<R> {
  let withTemperature = !NO_TEMPERATURE_MODELS.has(modelId);
  let forceTool = !NO_TOOL_CHOICE_MODELS.has(modelId);

  // 外せる要素は temperature と toolChoice の2つなので、最大3周で必ず決まる。
  for (let round = 0; round < 3; round += 1) {
    try {
      return await send({ forceTool, withTemperature });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (withTemperature && /temperature/i.test(message)) {
        NO_TEMPERATURE_MODELS.add(modelId);
        withTemperature = false;
        continue;
      }
      if (forceTool && /toolChoice|tool_choice/i.test(message)) {
        NO_TOOL_CHOICE_MODELS.add(modelId);
        forceTool = false;
        continue;
      }
      throw error;
    }
  }
  throw new Error('Bedrock がリクエストを受け付けませんでした。');
}

/**
 * 一時的な失敗を挟みながら Converse を呼ぶ。同じモデルで数回粘り、それでも
 * 駄目なら BEDROCK_FALLBACK_MODEL_ID へ切り替える。
 * 実際に応答したモデル ID を返すので、課金の記録は実態と合う。
 */
async function withResilience<R>(
  primary: string,
  send: (modelId: string) => Promise<R>,
): Promise<{ response: R; modelId: string }> {
  const candidates = [primary];
  if (FALLBACK_MODEL_ID && FALLBACK_MODEL_ID !== primary) candidates.push(FALLBACK_MODEL_ID);

  let lastError: unknown;

  for (const [index, candidate] of candidates.entries()) {
    for (let attempt = 1; attempt <= TRANSIENT_ATTEMPTS; attempt += 1) {
      try {
        const response = await send(candidate);
        if (candidate !== primary) {
          console.warn(`[bedrock] ${candidate} で応答を得ました（${primary} の代替）。`);
        }
        return { response, modelId: candidate };
      } catch (error) {
        if (!isTransient(error)) throw error;
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[bedrock] ${candidate} が一時的に応答しません（${attempt}/${TRANSIENT_ATTEMPTS}）: ${message}`,
        );
        if (attempt < TRANSIENT_ATTEMPTS) await sleep(backoffMs(attempt - 1));
      }
    }
    const next = candidates[index + 1];
    if (next) console.warn(`[bedrock] ${candidate} を諦めて ${next} に切り替えます。`);
  }

  // 混雑は利用者の入力のせいではないので、原因が伝わる文言で 503 を返す。
  throw Object.assign(
    new Error(
      `Bedrock が混み合っていて応答しません（${candidates.join(' / ')}）。少し待ってから再試行してください。`,
    ),
    { status: 503, cause: lastError },
  );
}

interface ConverseToolArgs {
  modelId?: string;
  system: string;
  content: ContentBlock[];
  tool: Tool;
  maxTokens?: number;
  temperature?: number;
}

/** 課金の可視化に使う。Converse のレスポンスから拾う。 */
export interface TokenUsage {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ConverseResult<T> {
  data: T;
  usage: TokenUsage;
}

/**
 * ツール利用を強制して構造化 JSON を受け取る。
 * toolChoice を受け付けないモデル向けに auto へフォールバックする。
 * 混雑による 503 は数回粘ったうえで代替モデルへ逃げる。
 */
export async function converseForJson<T = unknown>({
  modelId = MODEL_ID,
  system,
  content,
  tool,
  maxTokens = 8192,
  temperature = 0.4,
}: ConverseToolArgs): Promise<ConverseResult<T>> {
  const toolName = tool.toolSpec?.name;
  if (!toolName) throw new Error('toolSpec.name is required');

  const { response, modelId: usedModelId } = await withResilience(modelId, (candidate) =>
    // モデルの癖の吸収は候補ごとに行う。覚えた制約が別モデルに混ざらないようにする。
    negotiateParams(candidate, (opts) =>
      client.send(
        new ConverseCommand({
          modelId: candidate,
          system: [{ text: system }],
          messages: [{ role: 'user', content }],
          inferenceConfig: opts.withTemperature ? { maxTokens, temperature } : { maxTokens },
          toolConfig: {
            tools: [tool],
            toolChoice: opts.forceTool ? { tool: { name: toolName } } : { auto: {} },
          },
        }),
      ),
    ),
  );

  // 出力上限で切れた場合、JSON が途中で終わって復元できない。
  // 「構造化出力を返さなかった」という曖昧な失敗になる前に原因を明示する。
  if (response.stopReason === 'max_tokens') {
    throw Object.assign(
      new Error(
        `モデルの出力が上限（${maxTokens} トークン）で切れました。出題数を減らして再試行してください。`,
      ),
      { status: 502 },
    );
  }

  const usage: TokenUsage = {
    modelId: usedModelId,
    inputTokens: response.usage?.inputTokens ?? 0,
    outputTokens: response.usage?.outputTokens ?? 0,
  };

  const blocks = response.output?.message?.content ?? [];
  const toolUse = blocks.find((b) => b.toolUse?.name === toolName)?.toolUse;
  if (!toolUse?.input) {
    const fallbackText = blocks.map((b) => b.text ?? '').join('\n').trim();
    throw new Error(
      `モデルが構造化出力を返しませんでした（stopReason: ${response.stopReason}）。${fallbackText.slice(0, 300)}`,
    );
  }
  return { data: toolUse.input as T, usage };
}

interface ConverseTextArgs {
  modelId?: string;
  system: string;
  content: ContentBlock[];
  maxTokens?: number;
  temperature?: number;
}

/** 構造化出力が不要な用途（解説の生成など）向けに平文で受け取る。 */
export async function converseForText({
  modelId = MODEL_ID,
  system,
  content,
  maxTokens = 1500,
  temperature = 0.3,
}: ConverseTextArgs): Promise<ConverseResult<string>> {
  const { response, modelId: usedModelId } = await withResilience(modelId, (candidate) =>
    negotiateParams(candidate, (opts) =>
      client.send(
        new ConverseCommand({
          modelId: candidate,
          system: [{ text: system }],
          messages: [{ role: 'user', content }],
          inferenceConfig: opts.withTemperature ? { maxTokens, temperature } : { maxTokens },
        }),
      ),
    ),
  );

  const text = (response.output?.message?.content ?? [])
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();

  if (!text) throw new Error('モデルが解説を返しませんでした。');

  return {
    data: text,
    usage: {
      modelId: usedModelId,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    },
  };
}
