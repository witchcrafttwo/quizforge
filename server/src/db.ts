import { Pool, type PoolClient, type QueryResultRow } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL が設定されていません。.env に postgres://user:pass@host:5432/dbname 形式で設定してください。',
  );
}

export const pool = new Pool({
  connectionString,
  max: Number(process.env.PGPOOL_MAX ?? 10),
  // 自己署名証明書の Postgres に繋ぐ場合のみ PGSSL_NO_VERIFY=1 を使う。
  ssl:
    process.env.PGSSL_NO_VERIFY === '1'
      ? { rejectUnauthorized: false }
      : process.env.PGSSL === '1'
        ? {}
        : undefined,
});

export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

/** 複数の書き込みをまとめる。途中で例外が出たらロールバックする。 */
export async function withTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// 冪等なので起動ごとに実行してよい。マイグレーションツールは使わず、
// 追加は「列を足す ALTER を IF NOT EXISTS で並べる」方針で運用する。
const SCHEMA = `
-- 料金プラン。上限値の 0 は「無制限」を意味する。
CREATE TABLE IF NOT EXISTS plans (
  id                  text PRIMARY KEY,
  name                text NOT NULL,
  price_jpy           int NOT NULL DEFAULT 0,
  max_files           int NOT NULL DEFAULT 0,
  max_file_mb         numeric(6,2) NOT NULL DEFAULT 4.5,
  max_total_mb        numeric(6,2) NOT NULL DEFAULT 20,
  max_questions       int NOT NULL DEFAULT 50,
  daily_generations   int NOT NULL DEFAULT 0,
  monthly_generations int NOT NULL DEFAULT 0,
  sort_order          int NOT NULL DEFAULT 0
);

-- 既定プラン。既にある行は上書きしないので、管理画面で調整した値は保たれる。
INSERT INTO plans (id, name, price_jpy, max_files, max_file_mb, max_total_mb,
                   max_questions, daily_generations, monthly_generations, sort_order)
VALUES
  ('free',     'フリー',     0,  3, 4.5,  10, 10,   3,  30, 1),
  ('standard', 'スタンダード', 500, 10, 4.5,  30, 30,  20, 200, 2),
  ('pro',      'プロ',      1500,  0, 4.5, 100, 50, 100,   0, 3)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'user',
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_id text NOT NULL DEFAULT 'free'
  REFERENCES plans(id) ON DELETE SET DEFAULT;


CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS quizzes (
  id           uuid PRIMARY KEY,
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text NOT NULL,
  config       jsonb NOT NULL,
  source_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  shared       boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quizzes_owner_idx ON quizzes (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS quizzes_shared_idx ON quizzes (shared, created_at DESC);

-- 管理者が作るユーザーのグループ（授業・クラス単位）。
CREATE TABLE IF NOT EXISTS groups (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user_idx ON group_members (user_id);

-- 各ユーザーが自分のクイズを整理するフォルダー。
CREATE TABLE IF NOT EXISTS folders (
  id         uuid PRIMARY KEY,
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS folders_owner_idx ON folders (owner_id, name);

ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS quizzes_folder_idx ON quizzes (folder_id);

-- 配布。対象はクイズ単体かフォルダー単位のどちらか一方。
-- group_id が null なら全ユーザーへの配布。
CREATE TABLE IF NOT EXISTS shares (
  id         uuid PRIMARY KEY,
  quiz_id    uuid REFERENCES quizzes(id) ON DELETE CASCADE,
  folder_id  uuid REFERENCES folders(id) ON DELETE CASCADE,
  group_id   uuid REFERENCES groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shares_one_target CHECK ((quiz_id IS NOT NULL) <> (folder_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS shares_quiz_idx ON shares (quiz_id);
CREATE INDEX IF NOT EXISTS shares_folder_idx ON shares (folder_id);

CREATE TABLE IF NOT EXISTS questions (
  id           uuid PRIMARY KEY,
  quiz_id      uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  position     int NOT NULL,
  type         text NOT NULL,
  difficulty   text NOT NULL,
  question     text NOT NULL,
  choices      jsonb,
  answer_index int,
  answer_text  text,
  key_points   jsonb,
  blanks       jsonb,
  explanation  text NOT NULL DEFAULT '',
  source_quote text
);
CREATE INDEX IF NOT EXISTS questions_quiz_idx ON questions (quiz_id, position);

CREATE TABLE IF NOT EXISTS attempts (
  id           uuid PRIMARY KEY,
  quiz_id      uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  total_score  int
);
CREATE INDEX IF NOT EXISTS attempts_quiz_user_idx ON attempts (quiz_id, user_id, started_at DESC);

-- 復習（間違えた問題だけ）の挑戦では出題範囲が一部になる。
-- mode: 'full'（全問） / 'review'（復習）。question_ids が null なら全問。
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'full';
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS question_ids jsonb;

CREATE TABLE IF NOT EXISTS answers (
  attempt_id    uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id   uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  response      jsonb NOT NULL,
  score         int NOT NULL,
  verdict       text NOT NULL,
  feedback      text,
  blank_results jsonb,
  answered_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, question_id)
);

-- 解答後の自己申告。'review'（また解く） / 'mastered'（完璧）。
-- 正誤の自動判定より優先する。行が無ければ自動判定に任せる。
CREATE TABLE IF NOT EXISTS question_marks (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  mark        text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, question_id)
);

-- 生成した AI 解説をキャッシュする。二度押しで再課金しないため。
ALTER TABLE answers ADD COLUMN IF NOT EXISTS ai_explanation text;

-- 複数選択（multi_select）の正解インデックス。
ALTER TABLE questions ADD COLUMN IF NOT EXISTS answer_indexes jsonb;

-- Bedrock を呼ぶたびに1行。管理画面の使用量表示と1日上限の判定に使う。
-- kind: 'generate'（作問） / 'replace'（1問差し替え） / 'grade'（記述式採点） / 'explain'（AI解説）
CREATE TABLE IF NOT EXISTS usage_log (
  id             bigserial PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           text NOT NULL,
  model_id       text NOT NULL,
  input_tokens   bigint NOT NULL DEFAULT 0,
  output_tokens  bigint NOT NULL DEFAULT 0,
  question_count int,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_log_user_idx ON usage_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_log_created_idx ON usage_log (created_at DESC);

-- クイズ生成は20〜90秒かかるため、HTTP リクエストの中で完結させない。
-- 受け付けた時点で行を作り、ワーカーが処理して、クライアントは状態を見に来る。
-- status: 'queued' / 'running' / 'done' / 'failed'
CREATE TABLE IF NOT EXISTS jobs (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  status      text NOT NULL DEFAULT 'queued',
  -- 生成に使う入力（資料の base64 を含むので大きい）
  payload     jsonb NOT NULL,
  -- 成功時は quiz_id、失敗時は error にメッセージ
  quiz_id     uuid REFERENCES quizzes(id) ON DELETE SET NULL,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status, created_at);

-- モデルごとの単価（USD / 100万トークン）。0 のままだとコストを計算しない。
-- 実際の単価は AWS の料金ページで確認して管理画面から入れる。
CREATE TABLE IF NOT EXISTS model_prices (
  model_id      text PRIMARY KEY,
  input_per_1m  numeric(12,4) NOT NULL DEFAULT 0,
  output_per_1m numeric(12,4) NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 追加分は ALTER ... IF NOT EXISTS で冪等に足す。
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
`;

export async function initSchema(): Promise<void> {
  await pool.query(SCHEMA);
  // 期限切れセッションの掃除
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
}
