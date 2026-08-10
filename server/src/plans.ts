import { query, queryOne } from './db.js';

/** Bedrock の document ブロック上限。プラン設定でこれを超えさせない。 */
export const HARD_MAX_FILE_MB = 4.5;

/** 上限値の 0 は「無制限」。 */
export interface Plan {
  id: string;
  name: string;
  priceJpy: number;
  maxFiles: number;
  maxFileMb: number;
  maxTotalMb: number;
  maxQuestions: number;
  dailyGenerations: number;
  monthlyGenerations: number;
  sortOrder: number;
}

const SELECT = `
  SELECT id,
         name,
         price_jpy            AS "priceJpy",
         max_files            AS "maxFiles",
         max_file_mb::float8  AS "maxFileMb",
         max_total_mb::float8 AS "maxTotalMb",
         max_questions        AS "maxQuestions",
         daily_generations    AS "dailyGenerations",
         monthly_generations  AS "monthlyGenerations",
         sort_order           AS "sortOrder"
    FROM plans`;

export function listPlans(): Promise<Plan[]> {
  return query<Plan>(`${SELECT} ORDER BY sort_order, id`);
}

/**
 * 管理者用の無制限プラン。plans テーブルには置かず、role で判定して返す。
 * 誤ってプランを割り当てられても管理者が制限を受けないようにするため。
 * maxFileMb だけは Bedrock の制約なので緩められない。
 */
export const UNLIMITED_PLAN: Plan = {
  id: 'unlimited',
  name: '管理者（無制限）',
  priceJpy: 0,
  maxFiles: 0,
  maxFileMb: HARD_MAX_FILE_MB,
  maxTotalMb: 0,
  maxQuestions: 0,
  dailyGenerations: 0,
  monthlyGenerations: 0,
  sortOrder: 0,
};

export async function getPlanForUser(userId: string, role?: string): Promise<Plan> {
  if (role === 'admin') return UNLIMITED_PLAN;

  const plan = await queryOne<Plan>(
    `${SELECT} WHERE id = (SELECT plan_id FROM users WHERE id = $1)`,
    [userId],
  );
  // プランが消えていても止まらないよう、最小権限の既定値へ落とす。
  return (
    plan ?? {
      id: 'free',
      name: 'フリー',
      priceJpy: 0,
      maxFiles: 3,
      maxFileMb: 4.5,
      maxTotalMb: 10,
      maxQuestions: 10,
      dailyGenerations: 3,
      monthlyGenerations: 30,
      sortOrder: 1,
    }
  );
}

export async function setUserPlan(userId: string, planId: string): Promise<boolean> {
  const exists = await queryOne<{ id: string }>('SELECT id FROM plans WHERE id = $1', [planId]);
  if (!exists) return false;
  const rows = await query<{ id: string }>(
    'UPDATE users SET plan_id = $2 WHERE id = $1 RETURNING id',
    [userId, planId],
  );
  return rows.length > 0;
}

export async function updatePlan(
  planId: string,
  values: Omit<Plan, 'id' | 'sortOrder'>,
): Promise<Plan | undefined> {
  return queryOne<Plan>(
    `UPDATE plans
        SET name = $2,
            price_jpy = $3,
            max_files = $4,
            max_file_mb = $5,
            max_total_mb = $6,
            max_questions = $7,
            daily_generations = $8,
            monthly_generations = $9
      WHERE id = $1
      RETURNING id, name,
                price_jpy            AS "priceJpy",
                max_files            AS "maxFiles",
                max_file_mb::float8  AS "maxFileMb",
                max_total_mb::float8 AS "maxTotalMb",
                max_questions        AS "maxQuestions",
                daily_generations    AS "dailyGenerations",
                monthly_generations  AS "monthlyGenerations",
                sort_order           AS "sortOrder"`,
    [
      planId,
      values.name,
      values.priceJpy,
      values.maxFiles,
      values.maxFileMb,
      values.maxTotalMb,
      values.maxQuestions,
      values.dailyGenerations,
      values.monthlyGenerations,
    ],
  );
}

/* ---------- 使用状況と上限判定 ---------- */

export interface PlanUsage {
  daily: number;
  monthly: number;
}

/**
 * 作成回数。差し替え（replace）も資料を丸ごと再送するので同じ1回として数える。
 * 採点と解説は資料を送らないため数えない。
 */
export async function generationUsage(userId: string): Promise<PlanUsage> {
  const row = await queryOne<{ daily: string; monthly: string }>(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 day')::text   AS daily,
            count(*) FILTER (WHERE created_at > now() - interval '30 days')::text AS monthly
       FROM usage_log
      WHERE user_id = $1 AND kind IN ('generate', 'replace')`,
    [userId],
  );
  return { daily: Number(row?.daily ?? 0), monthly: Number(row?.monthly ?? 0) };
}

function limitError(message: string, status = 429): Error {
  return Object.assign(new Error(message), { status });
}

export async function assertGenerationAllowed(userId: string, plan: Plan): Promise<void> {
  // 両方無制限なら数える必要がない（管理者はここで抜ける）。
  if (plan.dailyGenerations <= 0 && plan.monthlyGenerations <= 0) return;

  const usage = await generationUsage(userId);

  if (plan.dailyGenerations > 0 && usage.daily >= plan.dailyGenerations) {
    throw limitError(
      `${plan.name}プランの1日の作成上限（${plan.dailyGenerations} 回）に達しました。日をまたぐか、プランを上げてください。`,
    );
  }
  if (plan.monthlyGenerations > 0 && usage.monthly >= plan.monthlyGenerations) {
    throw limitError(
      `${plan.name}プランの30日間の作成上限（${plan.monthlyGenerations} 回）に達しました。プランを上げてください。`,
    );
  }
}

/** ファイル数・サイズ・出題数をプランの上限で検査する。違反なら文言を返す。 */
export function checkAgainstPlan(
  plan: Plan,
  files: { name: string; base64: string }[],
  questionCount: number,
): string | null {
  if (plan.maxQuestions > 0 && questionCount > plan.maxQuestions) {
    return `${plan.name}プランで一度に作れるのは ${plan.maxQuestions} 問までです（指定: ${questionCount} 問）。`;
  }
  if (plan.maxFiles > 0 && files.length > plan.maxFiles) {
    return `${plan.name}プランで一度に提出できるのは ${plan.maxFiles} 件までです（指定: ${files.length} 件）。`;
  }

  const perFileMb = Math.min(plan.maxFileMb, HARD_MAX_FILE_MB);
  let total = 0;
  for (const file of files) {
    const bytes = Math.floor((file.base64.length * 3) / 4);
    total += bytes;
    const isPdf = file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf && bytes > perFileMb * 1024 * 1024) {
      return `「${file.name}」が大きすぎます（1ファイル ${perFileMb}MB まで）。分割するか PDF に変換してください。`;
    }
  }
  if (plan.maxTotalMb > 0 && total > plan.maxTotalMb * 1024 * 1024) {
    const usedMb = (total / 1024 / 1024).toFixed(1);
    return `合計サイズが ${plan.name}プランの上限（${plan.maxTotalMb}MB）を超えています（${usedMb}MB）。`;
  }
  return null;
}
