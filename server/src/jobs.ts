import { randomUUID } from 'node:crypto';
import { query, queryOne } from './db.js';
import * as plans from './plans.js';
import { generateQuiz } from './quiz.js';
import * as repo from './repo.js';
import type { GenerateRequest } from './types.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  status: JobStatus;
  quizId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 経過秒。目安の表示に使う。 */
  elapsedSeconds: number;
}

const SELECT = `
  SELECT id,
         status,
         quiz_id     AS "quizId",
         error,
         created_at  AS "createdAt",
         started_at  AS "startedAt",
         finished_at AS "finishedAt",
         extract(epoch FROM (coalesce(finished_at, now()) - created_at))::int AS "elapsedSeconds"
    FROM jobs`;

export async function enqueueGeneration(userId: string, request: GenerateRequest): Promise<Job> {
  const id = randomUUID();
  await query('INSERT INTO jobs (id, user_id, kind, payload) VALUES ($1, $2, $3, $4)', [
    id,
    userId,
    'generate',
    JSON.stringify(request),
  ]);

  // 応答を待たせないため、処理は後ろで走らせる。
  setImmediate(() => {
    void runJob(id).catch((error: unknown) => {
      console.error('[jobs] 予期しない失敗', error);
    });
  });

  const job = await getJob(id, userId);
  if (!job) throw new Error('ジョブの作成に失敗しました');
  return job;
}

export function getJob(jobId: string, userId: string): Promise<Job | undefined> {
  return queryOne<Job>(`${SELECT} WHERE id = $1 AND user_id = $2`, [jobId, userId]);
}

/** 未完了のジョブ。再読み込み後に進捗へ戻れるようにする。 */
export function listActiveJobs(userId: string): Promise<Job[]> {
  return query<Job>(
    `${SELECT} WHERE user_id = $1 AND status IN ('queued', 'running') ORDER BY created_at`,
    [userId],
  );
}

/**
 * ジョブを1件処理する。
 * 二重実行を防ぐため、queued のものだけを running に更新できた場合に進む。
 */
async function runJob(jobId: string): Promise<void> {
  const claimed = await queryOne<{ user_id: string; payload: GenerateRequest }>(
    `UPDATE jobs SET status = 'running', started_at = now()
      WHERE id = $1 AND status = 'queued'
      RETURNING user_id, payload`,
    [jobId],
  );
  if (!claimed) return;

  const userId = claimed.user_id;

  try {
    const { quiz, usage } = await generateQuiz(claimed.payload);
    await repo.insertQuiz(userId, quiz);
    await repo.recordUsage(userId, 'generate', usage, quiz.questions.length);
    await repo.touchUser(userId);

    await query(
      `UPDATE jobs SET status = 'done', quiz_id = $2, finished_at = now(), payload = '{}'::jsonb
        WHERE id = $1`,
      [jobId, quiz.id],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[jobs] 生成に失敗', message);
    // payload は資料の base64 を含んで重いので、終わったら捨てる。
    await query(
      `UPDATE jobs SET status = 'failed', error = $2, finished_at = now(), payload = '{}'::jsonb
        WHERE id = $1`,
      [jobId, message],
    );
  }
}

/**
 * 起動時の復帰処理。
 * 前回の停止で running のまま残ったジョブは、実行中のプロセスが無いので失敗にする。
 * queued のものは拾い直す。
 */
export async function recoverJobs(): Promise<void> {
  const stale = await query<{ id: string }>(
    `UPDATE jobs SET status = 'failed', error = 'サーバー再起動により中断されました',
            finished_at = now(), payload = '{}'::jsonb
      WHERE status = 'running'
      RETURNING id`,
  );
  if (stale.length > 0) console.warn(`[jobs] 中断された ${stale.length} 件を失敗にしました`);

  const queued = await query<{ id: string }>(
    "SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at",
  );
  for (const row of queued) {
    setImmediate(() => {
      void runJob(row.id).catch(() => undefined);
    });
  }
  if (queued.length > 0) console.log(`[jobs] 待機中の ${queued.length} 件を再開します`);
}

/** 古いジョブの掃除。履歴として残す必要はない。 */
export async function pruneJobs(): Promise<void> {
  await query("DELETE FROM jobs WHERE finished_at < now() - interval '7 days'");
}
