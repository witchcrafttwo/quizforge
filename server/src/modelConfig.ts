// 使用モデルは管理画面から切り替えられる。DB の値を優先し、無ければ環境変数。
// 呼び出しごとに DB を読むと遅いので、メモリに載せて更新時だけ入れ替える。
import { GRADER_MODEL_ID, EXPLAINER_MODEL_ID, MODEL_ID } from './bedrock.js';
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
  /** 表示名。`id|ラベル` の形で書けば任意の名前を付けられる。 */
  label: string;
}

/**
 * 選択肢は .env の BEDROCK_MODEL_CHOICES に列挙したものだけ。
 * Bedrock の全モデル（150件近く）から選ばせると、作問に使えないものが大半で
 * 誤設定を招くため、運用者が確認したものだけを候補にする。
 *
 * 書式: カンマ区切り。`モデルID` か `モデルID|表示名`。
 * 例: us.anthropic.claude-sonnet-5|Sonnet 5, zai.glm-5|GLM-5 (安い)
 */
function parseChoices(): ModelOption[] {
  const raw = process.env.BEDROCK_MODEL_CHOICES ?? '';
  const items: ModelOption[] = [];

  for (const entry of raw.split(',')) {
    const [id, label] = entry.split('|').map((s) => s.trim());
    if (!id) continue;
    items.push({ id, label: label || id });
  }

  // 未設定なら、いま使っている3つを候補にして最低限選べる状態にする。
  if (items.length === 0) {
    for (const id of new Set(Object.values(ENV_DEFAULT))) {
      items.push({ id, label: id });
    }
  }
  return items;
}

export function listModelOptions(): ModelOption[] {
  return parseChoices();
}

/** 候補に無いモデルへの切り替えを拒否する。誤入力と取り違えを防ぐ。 */
export function isAllowedModel(modelId: string): boolean {
  return parseChoices().some((option) => option.id === modelId);
}
