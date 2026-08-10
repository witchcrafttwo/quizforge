import { query, queryOne } from './db.js';

/* ---------- モデル単価 ---------- */

export interface ModelPrice {
  modelId: string;
  inputPer1m: number;
  outputPer1m: number;
  /** 単価が未設定（両方0）ならコストを計算しない */
  configured: boolean;
}

/** 使用履歴に現れたモデルの行を用意する。管理画面で単価を入れられるようにするため。 */
export async function ensureModelPriceRows(): Promise<void> {
  await query(
    `INSERT INTO model_prices (model_id)
     SELECT DISTINCT model_id FROM usage_log
     ON CONFLICT (model_id) DO NOTHING`,
  );
}

export async function listModelPrices(): Promise<ModelPrice[]> {
  await ensureModelPriceRows();
  const rows = await query<{
    modelId: string;
    inputPer1m: string;
    outputPer1m: string;
  }>(
    `SELECT model_id AS "modelId",
            input_per_1m::text  AS "inputPer1m",
            output_per_1m::text AS "outputPer1m"
       FROM model_prices
      ORDER BY model_id`,
  );
  return rows.map((row) => {
    const inputPer1m = Number(row.inputPer1m);
    const outputPer1m = Number(row.outputPer1m);
    return {
      modelId: row.modelId,
      inputPer1m,
      outputPer1m,
      configured: inputPer1m > 0 || outputPer1m > 0,
    };
  });
}

export async function upsertModelPrice(
  modelId: string,
  inputPer1m: number,
  outputPer1m: number,
): Promise<ModelPrice> {
  await query(
    `INSERT INTO model_prices (model_id, input_per_1m, output_per_1m, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (model_id) DO UPDATE
       SET input_per_1m = EXCLUDED.input_per_1m,
           output_per_1m = EXCLUDED.output_per_1m,
           updated_at = now()`,
    [modelId, inputPer1m, outputPer1m],
  );
  return {
    modelId,
    inputPer1m,
    outputPer1m,
    configured: inputPer1m > 0 || outputPer1m > 0,
  };
}

/** SQL 内でコストを出す式。単価が入っていないモデルは 0 として扱う。 */
const COST_EXPR = `
  coalesce(sum(l.input_tokens)  / 1000000.0 * coalesce(p.input_per_1m, 0), 0)
+ coalesce(sum(l.output_tokens) / 1000000.0 * coalesce(p.output_per_1m, 0), 0)`;

export interface AdminUserRow {
  id: string;
  username: string;
  disabled: boolean;
  planId: string;
  planName: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  quizCount: number;
  attemptCount: number;
  generateCalls: number;
  gradeCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** 使ったモデルそれぞれの単価で計算した合計（USD） */
  cost: number;
  generationsToday: number;
}

/** ユーザー一覧。トークン量とコストは指定日数の合計。 */
export async function listUsers(days: number): Promise<AdminUserRow[]> {
  await ensureModelPriceRows();
  const rows = await query<
    AdminUserRow & { inputTokens: string; outputTokens: string; cost: string }
  >(
    `SELECT u.id,
            u.username,
            u.disabled,
            u.plan_id      AS "planId",
            p.name         AS "planName",
            u.created_at   AS "createdAt",
            u.last_seen_at AS "lastSeenAt",
            (SELECT count(*)::int FROM quizzes q WHERE q.owner_id = u.id)  AS "quizCount",
            (SELECT count(*)::int FROM attempts a
              WHERE a.user_id = u.id AND a.completed_at IS NOT NULL)       AS "attemptCount",
            coalesce(s.generate_calls, 0)::int  AS "generateCalls",
            coalesce(s.grade_calls, 0)::int     AS "gradeCalls",
            coalesce(s.input_tokens, 0)::text   AS "inputTokens",
            coalesce(s.output_tokens, 0)::text  AS "outputTokens",
            coalesce(s.cost, 0)::text           AS cost,
            (SELECT count(*)::int FROM usage_log l
              WHERE l.user_id = u.id AND l.kind = 'generate'
                AND l.created_at > now() - interval '1 day')               AS "generationsToday"
       FROM users u
       LEFT JOIN plans p ON p.id = u.plan_id
       LEFT JOIN (
         SELECT l.user_id,
                count(*) FILTER (WHERE l.kind = 'generate') AS generate_calls,
                count(*) FILTER (WHERE l.kind = 'grade')    AS grade_calls,
                sum(l.input_tokens)                          AS input_tokens,
                sum(l.output_tokens)                         AS output_tokens,
                -- 行ごとに、そのモデルの単価で計算して足す
                sum(l.input_tokens  / 1000000.0 * coalesce(p.input_per_1m, 0)
                  + l.output_tokens / 1000000.0 * coalesce(p.output_per_1m, 0)) AS cost
           FROM usage_log l
           LEFT JOIN model_prices p ON p.model_id = l.model_id
          WHERE l.created_at > now() - ($1 || ' days')::interval
          GROUP BY l.user_id
       ) s ON s.user_id = u.id
      ORDER BY u.created_at`,
    [days],
  );

  return rows.map((row) => ({
    ...row,
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    cost: Number(row.cost),
  }));
}

export interface AdminOverview {
  userCount: number;
  activeUserCount: number;
  quizCount: number;
  attemptCount: number;
  inputTokens: number;
  outputTokens: number;
  /** モデルごとに個別計算したコストの合計（USD） */
  estimatedCost: number;
  /** 単価が未設定のまま使われているモデル。合計に含まれていない分。 */
  unpricedModels: string[];
  days: number;
}

export async function overview(days: number): Promise<AdminOverview> {
  const [row, byModel] = await Promise.all([
    queryOne<{
      userCount: number;
      activeUserCount: number;
      quizCount: number;
      attemptCount: number;
      inputTokens: string;
      outputTokens: string;
    }>(
      `SELECT (SELECT count(*)::int FROM users) AS "userCount",
              (SELECT count(DISTINCT user_id)::int FROM usage_log
                WHERE created_at > now() - ($1 || ' days')::interval) AS "activeUserCount",
              (SELECT count(*)::int FROM quizzes) AS "quizCount",
              (SELECT count(*)::int FROM attempts WHERE completed_at IS NOT NULL) AS "attemptCount",
              (SELECT coalesce(sum(input_tokens), 0)::text FROM usage_log
                WHERE created_at > now() - ($1 || ' days')::interval) AS "inputTokens",
              (SELECT coalesce(sum(output_tokens), 0)::text FROM usage_log
                WHERE created_at > now() - ($1 || ' days')::interval) AS "outputTokens"`,
      [days],
    ),
    usageByModel(days),
  ]);

  // 合計は「モデルごとに計算した額の和」。単価の違うモデルを混ぜて平均しない。
  const estimatedCost = byModel.reduce((sum, m) => sum + (m.cost ?? 0), 0);
  const unpricedModels = byModel.filter((m) => m.cost === null).map((m) => m.modelId);

  return {
    userCount: row?.userCount ?? 0,
    activeUserCount: row?.activeUserCount ?? 0,
    quizCount: row?.quizCount ?? 0,
    attemptCount: row?.attemptCount ?? 0,
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    estimatedCost,
    unpricedModels,
    days,
  };
}

export interface DailyUsage {
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/** 日別の使用量。グラフや推移確認用。 */
export async function dailyUsage(days: number): Promise<DailyUsage[]> {
  const rows = await query<{
    day: string;
    calls: number;
    inputTokens: string;
    outputTokens: string;
  }>(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            count(*)::int                     AS calls,
            sum(input_tokens)::text           AS "inputTokens",
            sum(output_tokens)::text          AS "outputTokens"
       FROM usage_log
      WHERE created_at > now() - ($1 || ' days')::interval
      GROUP BY 1
      ORDER BY 1 DESC`,
    [days],
  );
  return rows.map((row) => ({
    day: row.day,
    calls: row.calls,
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
  }));
}

export interface ModelUsage {
  modelId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** そのモデルの単価で計算したコスト（USD）。単価未設定なら null。 */
  cost: number | null;
  inputPer1m: number;
  outputPer1m: number;
}

/** モデル別の内訳。モデルごとの単価で個別にコストを計算する。 */
export async function usageByModel(days: number): Promise<ModelUsage[]> {
  await ensureModelPriceRows();
  const rows = await query<{
    modelId: string;
    calls: number;
    inputTokens: string;
    outputTokens: string;
    cost: string;
    inputPer1m: string;
    outputPer1m: string;
  }>(
    `SELECT l.model_id AS "modelId",
            count(*)::int AS calls,
            sum(l.input_tokens)::text  AS "inputTokens",
            sum(l.output_tokens)::text AS "outputTokens",
            (${COST_EXPR})::text       AS cost,
            coalesce(max(p.input_per_1m), 0)::text  AS "inputPer1m",
            coalesce(max(p.output_per_1m), 0)::text AS "outputPer1m"
       FROM usage_log l
       LEFT JOIN model_prices p ON p.model_id = l.model_id
      WHERE l.created_at > now() - ($1 || ' days')::interval
      GROUP BY l.model_id, p.input_per_1m, p.output_per_1m
      ORDER BY sum(l.input_tokens + l.output_tokens) DESC`,
    [days],
  );

  return rows.map((row) => {
    const inputPer1m = Number(row.inputPer1m);
    const outputPer1m = Number(row.outputPer1m);
    const priced = inputPer1m > 0 || outputPer1m > 0;
    return {
      modelId: row.modelId,
      calls: row.calls,
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cost: priced ? Number(row.cost) : null,
      inputPer1m,
      outputPer1m,
    };
  });
}

/* ---------- ユーザー操作 ---------- */

export async function setUserDisabled(userId: string, disabled: boolean): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'UPDATE users SET disabled = $2 WHERE id = $1 RETURNING id',
    [userId, disabled],
  );
  // 無効化したらセッションも切る
  if (disabled) await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  return rows.length > 0;
}

export async function deleteUser(userId: string): Promise<boolean> {
  const rows = await query<{ id: string }>('DELETE FROM users WHERE id = $1 RETURNING id', [userId]);
  return rows.length > 0;
}
