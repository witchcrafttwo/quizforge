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

const client = new BedrockRuntimeClient({ region: REGION });

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

  const run = (opts: { forceTool: boolean; withTemperature: boolean }) =>
    client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: system }],
        messages: [{ role: 'user', content }],
        inferenceConfig: opts.withTemperature ? { maxTokens, temperature } : { maxTokens },
        toolConfig: {
          tools: [tool],
          toolChoice: opts.forceTool ? { tool: { name: toolName } } : { auto: {} },
        },
      }),
    );

  // Opus 5 のように temperature を拒否するモデル、toolChoice の強制を受け付けない
  // モデルがあるため、拒否された要素を外して再試行する。判明した制約は記憶して
  // 次回以降の無駄な往復を避ける。
  let withTemperature = !NO_TEMPERATURE_MODELS.has(modelId);
  let forceTool = !NO_TOOL_CHOICE_MODELS.has(modelId);

  let response: Awaited<ReturnType<typeof run>> | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt < 3 && !response; attempt += 1) {
    try {
      response = await run({ forceTool, withTemperature });
    } catch (error) {
      lastError = error;
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

  if (!response) throw lastError ?? new Error('Bedrock の呼び出しに失敗しました');

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
    modelId,
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
  const run = (withTemperature: boolean) =>
    client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: system }],
        messages: [{ role: 'user', content }],
        inferenceConfig: withTemperature ? { maxTokens, temperature } : { maxTokens },
      }),
    );

  let withTemperature = !NO_TEMPERATURE_MODELS.has(modelId);
  let response;
  try {
    response = await run(withTemperature);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (withTemperature && /temperature/i.test(message)) {
      NO_TEMPERATURE_MODELS.add(modelId);
      withTemperature = false;
      response = await run(false);
    } else {
      throw error;
    }
  }

  const text = (response.output?.message?.content ?? [])
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();

  if (!text) throw new Error('モデルが解説を返しませんでした。');

  return {
    data: text,
    usage: {
      modelId,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    },
  };
}
