// 使用モデルは管理画面から切り替えられる。DB の値を優先し、無ければ環境変数。
// 呼び出しごとに DB を読むと遅いので、メモリに載せて更新時だけ入れ替える。
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { GRADER_MODEL_ID, EXPLAINER_MODEL_ID, MODEL_ID, REGION } from './bedrock.js';
import { query } from './db.js';

export type ModelRole = 'generate' | 'grader' | 'explainer';

const ENV_DEFAULT: Record<ModelRole, string> = {
  generate: MODEL_ID,
  grader: GRADER_MODEL_ID,
  explainer: EXPLAINER_MODEL_ID,
};

let cache: Record<ModelRole, string> = { ...ENV_DEFAULT };

/** 起動時と更新時に呼ぶ。 */
export async function loadModelConfig(): Promise<void> {
  const rows = await query<{ key: string; value: string }>(
    "SELECT key, value FROM app_settings WHERE key LIKE 'model.%'",
  );
  const next = { ...ENV_DEFAULT };
  for (const row of rows) {
    const role = row.key.slice('model.'.length) as ModelRole;
    if (role in next && row.value.trim()) next[role] = row.value.trim();
  }
  cache = next;
}

export function modelFor(role: ModelRole): string {
  return cache[role];
}

export interface ModelSettings {
  current: Record<ModelRole, string>;
  /** 環境変数の既定値。「既定に戻す」の表示に使う。 */
  defaults: Record<ModelRole, string>;
}

export function modelSettings(): ModelSettings {
  return { current: { ...cache }, defaults: { ...ENV_DEFAULT } };
}

/** null を渡すと設定を消して環境変数の値に戻す。 */
export async function setModel(role: ModelRole, modelId: string | null): Promise<void> {
  if (modelId === null || modelId.trim() === '') {
    await query('DELETE FROM app_settings WHERE key = $1', [`model.${role}`]);
  } else {
    await query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [`model.${role}`, modelId.trim()],
    );
  }
  await loadModelConfig();
}

/* ---------- 選択肢の一覧 ---------- */

export interface ModelOption {
  id: string;
  provider: string;
  /** TEXT / IMAGE など。作問には画像とドキュメントを読めるモデルが必要。 */
  inputModalities: string[];
  /** 推論プロファイル経由でしか呼べないモデルは接頭辞つきの id を使う。 */
  profileOnly: boolean;
}

let optionCache: { at: number; items: ModelOption[] } | null = null;

/**
 * 呼び出せるモデルの一覧。10分キャッシュする。
 * 推論プロファイルも含めるので、us. 接頭辞が必要なモデルも選べる。
 */
export async function listModelOptions(): Promise<ModelOption[]> {
  if (optionCache && Date.now() - optionCache.at < 10 * 60 * 1000) return optionCache.items;

  const client = new BedrockClient({ region: REGION });
  const [models, profiles] = await Promise.all([
    client.send(new ListFoundationModelsCommand({ byOutputModality: 'TEXT' })),
    client.send(new ListInferenceProfilesCommand({ typeEquals: 'SYSTEM_DEFINED' })).catch(() => ({
      inferenceProfileSummaries: [],
    })),
  ]);

  const items: ModelOption[] = [];

  for (const model of models.modelSummaries ?? []) {
    if (!model.modelId || !model.inputModalities?.includes('TEXT')) continue;
    const onDemand = model.inferenceTypesSupported?.includes('ON_DEMAND') ?? false;
    items.push({
      id: model.modelId,
      provider: model.providerName ?? '',
      inputModalities: model.inputModalities ?? [],
      profileOnly: !onDemand,
    });
  }

  // プロファイルは基盤モデルのモダリティを引き継ぐ。接頭辞を外して照合する。
  for (const profile of profiles.inferenceProfileSummaries ?? []) {
    const id = profile.inferenceProfileId;
    if (!id) continue;
    const base = items.find((item) => id.endsWith(item.id));
    items.push({
      id,
      provider: base?.provider ?? '',
      inputModalities: base?.inputModalities ?? ['TEXT'],
      profileOnly: false,
    });
  }

  items.sort((a, b) => a.id.localeCompare(b.id));
  optionCache = { at: Date.now(), items };
  return items;
}
