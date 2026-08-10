import { randomUUID } from 'node:crypto';
import type { TokenUsage } from './bedrock.js';
import { query, queryOne, withTransaction } from './db.js';
import { visibleSql } from './sharing.js';
import type {
  Attempt,
  AttemptDetail,
  AttemptMode,
  AttemptSummary,
  AnswerValue,
  ClozeBlank,
  GradeResult,
  Question,
  Quiz,
  QuizSummary,
  Verdict,
} from './types.js';

interface QuestionRow {
  id: string;
  quiz_id: string;
  position: number;
  type: string;
  difficulty: string;
  question: string;
  choices: string[] | null;
  answer_index: number | null;
  answer_indexes: number[] | null;
  answer_text: string | null;
  key_points: string[] | null;
  blanks: ClozeBlank[] | null;
  explanation: string;
  source_quote: string | null;
}

interface QuizRow {
  id: string;
  owner_id: string;
  title: string;
  config: Quiz['config'];
  source_names: string[];
  shared: boolean;
  created_at: Date;
}

function toQuestion(row: QuestionRow): Question {
  const question: Question = {
    id: row.id,
    type: row.type as Question['type'],
    difficulty: row.difficulty as Question['difficulty'],
    question: row.question,
    explanation: row.explanation,
  };
  if (row.choices) question.choices = row.choices;
  if (row.answer_index !== null) question.answerIndex = row.answer_index;
  if (row.answer_indexes) question.answerIndexes = row.answer_indexes;
  if (row.answer_text) question.answerText = row.answer_text;
  if (row.key_points) question.keyPoints = row.key_points;
  if (row.blanks) question.blanks = row.blanks;
  if (row.source_quote) question.sourceQuote = row.source_quote;
  return question;
}

/* ---------- クイズ ---------- */

export async function insertQuiz(ownerId: string, quiz: Quiz): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO quizzes (id, owner_id, title, config, source_names, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        quiz.id,
        ownerId,
        quiz.title,
        JSON.stringify(quiz.config),
        JSON.stringify(quiz.sourceNames),
        quiz.createdAt,
      ],
    );

    for (const [position, q] of quiz.questions.entries()) {
      await client.query(
        `INSERT INTO questions
           (id, quiz_id, position, type, difficulty, question, choices,
            answer_index, answer_indexes, answer_text, key_points, blanks, explanation, source_quote)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          q.id,
          quiz.id,
          position,
          q.type,
          q.difficulty,
          q.question,
          q.choices ? JSON.stringify(q.choices) : null,
          q.answerIndex ?? null,
          q.answerIndexes ? JSON.stringify(q.answerIndexes) : null,
          q.answerText ?? null,
          q.keyPoints ? JSON.stringify(q.keyPoints) : null,
          q.blanks ? JSON.stringify(q.blanks) : null,
          q.explanation,
          q.sourceQuote ?? null,
        ],
      );
    }
  });
}

/** 自分のクイズと、他人が共有したクイズを新しい順に返す。 */
export async function listQuizzes(userId: string): Promise<QuizSummary[]> {
  return query<QuizSummary & { createdAt: string }>(
    `SELECT q.id,
            q.title,
            q.created_at            AS "createdAt",
            q.source_names          AS "sourceNames",
            q.shared,
            (q.owner_id = $1)       AS "isOwn",
            u.username              AS "ownerName",
            q.folder_id             AS "folderId",
            f.name                  AS "folderName",
            (SELECT count(*)::int FROM questions qq WHERE qq.quiz_id = q.id) AS "questionCount",
            (SELECT count(*)::int FROM attempts a
              WHERE a.quiz_id = q.id AND a.user_id = $1 AND a.completed_at IS NOT NULL) AS "attemptCount",
            (SELECT max(a.total_score) FROM attempts a
              WHERE a.quiz_id = q.id AND a.user_id = $1 AND a.completed_at IS NOT NULL) AS "bestScore",
            (SELECT a.total_score FROM attempts a
              WHERE a.quiz_id = q.id AND a.user_id = $1 AND a.completed_at IS NOT NULL
              ORDER BY a.completed_at DESC LIMIT 1) AS "lastScore",
            (SELECT count(*)::int
               FROM questions qq
               LEFT JOIN question_marks m
                 ON m.question_id = qq.id AND m.user_id = $1
               LEFT JOIN LATERAL (
                 SELECT an.verdict FROM answers an
                   JOIN attempts a ON a.id = an.attempt_id
                  WHERE an.question_id = qq.id AND a.quiz_id = q.id AND a.user_id = $1
                  ORDER BY an.answered_at DESC LIMIT 1
               ) latest ON true
              WHERE qq.quiz_id = q.id
                AND m.mark IS DISTINCT FROM 'mastered'
                AND (m.mark = 'review'
                     OR (latest.verdict IS NOT NULL AND latest.verdict <> 'correct'))
             ) AS "weakCount"
       FROM quizzes q
       JOIN users u ON u.id = q.owner_id
       LEFT JOIN folders f ON f.id = q.folder_id
      WHERE ${visibleSql('$1')}
      ORDER BY q.created_at DESC
      LIMIT 200`,
    [userId],
  );
}

/** 閲覧権のあるクイズを取得する。権限がなければ undefined。 */
export async function getQuiz(quizId: string, userId: string): Promise<Quiz | undefined> {
  const row = await queryOne<QuizRow>(
    `SELECT q.* FROM quizzes q WHERE q.id = $1 AND ${visibleSql('$2')}`,
    [quizId, userId],
  );
  if (!row) return undefined;

  const questions = await query<QuestionRow>(
    'SELECT * FROM questions WHERE quiz_id = $1 ORDER BY position',
    [quizId],
  );

  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    config: row.config,
    sourceNames: row.source_names,
    questions: questions.map(toQuestion),
  };
}

/** 所有者のみ削除できる。削除できたら true。 */
export async function deleteQuiz(quizId: string, userId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'DELETE FROM quizzes WHERE id = $1 AND owner_id = $2 RETURNING id',
    [quizId, userId],
  );
  return rows.length > 0;
}

/** 所有者のみタイトルを変更できる。 */
export async function renameQuiz(
  quizId: string,
  userId: string,
  title: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'UPDATE quizzes SET title = $3 WHERE id = $1 AND owner_id = $2 RETURNING id',
    [quizId, userId, title],
  );
  return rows.length > 0;
}

/** 問題を1件削除する。最後の1問は残す。 */
export async function deleteQuestion(
  quizId: string,
  questionId: string,
  userId: string,
): Promise<'ok' | 'not_found' | 'last_one'> {
  const owned = await queryOne<{ id: string }>(
    'SELECT id FROM quizzes WHERE id = $1 AND owner_id = $2',
    [quizId, userId],
  );
  if (!owned) return 'not_found';

  const { count } = (await queryOne<{ count: string }>(
    'SELECT count(*)::text AS count FROM questions WHERE quiz_id = $1',
    [quizId],
  )) ?? { count: '0' };
  if (Number(count) <= 1) return 'last_one';

  const rows = await query<{ id: string }>(
    'DELETE FROM questions WHERE id = $1 AND quiz_id = $2 RETURNING id',
    [questionId, quizId],
  );
  return rows.length > 0 ? 'ok' : 'not_found';
}

/** 問題を同じ位置で差し替える。解答済みの記録は外部キーの連鎖で消える。 */
export async function replaceQuestion(
  quizId: string,
  oldQuestionId: string,
  next: Question,
  userId: string,
): Promise<boolean> {
  return withTransaction(async (client) => {
    const owned = await client.query('SELECT id FROM quizzes WHERE id = $1 AND owner_id = $2', [
      quizId,
      userId,
    ]);
    if (owned.rowCount === 0) return false;

    const old = await client.query<{ position: number }>(
      'SELECT position FROM questions WHERE id = $1 AND quiz_id = $2',
      [oldQuestionId, quizId],
    );
    const position = old.rows[0]?.position;
    if (position === undefined) return false;

    await client.query('DELETE FROM questions WHERE id = $1', [oldQuestionId]);
    await client.query(
      `INSERT INTO questions
         (id, quiz_id, position, type, difficulty, question, choices,
          answer_index, answer_indexes, answer_text, key_points, blanks, explanation, source_quote)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        next.id,
        quizId,
        position,
        next.type,
        next.difficulty,
        next.question,
        next.choices ? JSON.stringify(next.choices) : null,
        next.answerIndex ?? null,
        next.answerIndexes ? JSON.stringify(next.answerIndexes) : null,
        next.answerText ?? null,
        next.keyPoints ? JSON.stringify(next.keyPoints) : null,
        next.blanks ? JSON.stringify(next.blanks) : null,
        next.explanation,
        next.sourceQuote ?? null,
      ],
    );
    return true;
  });
}

/** 配布の切り替え。管理者は所有者を問わず操作できる。 */
export async function setQuizShared(quizId: string, shared: boolean): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'UPDATE quizzes SET shared = $2 WHERE id = $1 RETURNING id',
    [quizId, shared],
  );
  return rows.length > 0;
}

/** 管理者向けの全クイズ一覧。配布の管理に使う。 */
export async function listAllQuizzes(): Promise<
  { id: string; title: string; ownerName: string; questionCount: number; shared: boolean; createdAt: string }[]
> {
  return query(
    `SELECT q.id,
            q.title,
            u.username   AS "ownerName",
            q.shared,
            q.created_at AS "createdAt",
            (SELECT count(*)::int FROM questions qq WHERE qq.quiz_id = q.id) AS "questionCount"
       FROM quizzes q
       JOIN users u ON u.id = q.owner_id
      ORDER BY q.shared DESC, q.created_at DESC
      LIMIT 300`,
  );
}

/* ---------- 挑戦と解答 ---------- */

/**
 * 復習対象の判定を1か所にまとめる。$1 = quizId, $2 = userId。
 * 「完璧」を付けた問題は正誤にかかわらず除外し、「復習」を付けた問題は
 * 正解していても必ず含める。マークが無ければ直近の解答が正解でないものを拾う。
 * 一度も解いていない問題は、明示的に「復習」を付けた場合だけ含める。
 */
const WEAK_FROM = `
  FROM questions q
  LEFT JOIN question_marks m ON m.question_id = q.id AND m.user_id = $2
  LEFT JOIN LATERAL (
    SELECT an.verdict
      FROM answers an
      JOIN attempts a ON a.id = an.attempt_id
     WHERE an.question_id = q.id AND a.quiz_id = q.quiz_id AND a.user_id = $2
     ORDER BY an.answered_at DESC
     LIMIT 1
  ) latest ON true
 WHERE q.quiz_id = $1
   AND m.mark IS DISTINCT FROM 'mastered'
   AND (m.mark = 'review' OR (latest.verdict IS NOT NULL AND latest.verdict <> 'correct'))`;

export async function weakQuestionIds(quizId: string, userId: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT q.id ${WEAK_FROM} ORDER BY q.position`,
    [quizId, userId],
  );
  return rows.map((row) => row.id);
}

/* ---------- 自己申告のマーク ---------- */

export type QuestionMark = 'review' | 'mastered';

/** マークを付け替える。null で解除して自動判定に戻す。 */
export async function setQuestionMark(
  userId: string,
  questionId: string,
  mark: QuestionMark | null,
): Promise<void> {
  if (mark === null) {
    await query('DELETE FROM question_marks WHERE user_id = $1 AND question_id = $2', [
      userId,
      questionId,
    ]);
    return;
  }
  await query(
    `INSERT INTO question_marks (user_id, question_id, mark) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, question_id) DO UPDATE SET mark = EXCLUDED.mark, updated_at = now()`,
    [userId, questionId, mark],
  );
}

/** 問題が閲覧可能なクイズに属しているか確認する。 */
export async function findQuizIdOfQuestion(
  questionId: string,
  userId: string,
): Promise<string | undefined> {
  const row = await queryOne<{ quiz_id: string }>(
    `SELECT qs.quiz_id
       FROM questions qs
       JOIN quizzes q ON q.id = qs.quiz_id
      WHERE qs.id = $1 AND ${visibleSql('$2')}`,
    [questionId, userId],
  );
  return row?.quiz_id;
}

export async function marksForQuiz(
  quizId: string,
  userId: string,
): Promise<Record<string, QuestionMark>> {
  const rows = await query<{ question_id: string; mark: QuestionMark }>(
    `SELECT m.question_id, m.mark
       FROM question_marks m
       JOIN questions q ON q.id = m.question_id
      WHERE q.quiz_id = $1 AND m.user_id = $2`,
    [quizId, userId],
  );
  return Object.fromEntries(rows.map((row) => [row.question_id, row.mark]));
}

export async function createAttempt(
  quizId: string,
  userId: string,
  mode: AttemptMode = 'full',
  questionIds: string[] | null = null,
): Promise<Attempt> {
  const id = randomUUID();
  const row = await queryOne<{ started_at: Date }>(
    `INSERT INTO attempts (id, quiz_id, user_id, mode, question_ids)
     VALUES ($1, $2, $3, $4, $5) RETURNING started_at`,
    [id, quizId, userId, mode, questionIds ? JSON.stringify(questionIds) : null],
  );
  return {
    id,
    quizId,
    mode,
    questionIds,
    startedAt: (row?.started_at ?? new Date()).toISOString(),
    completedAt: null,
    totalScore: null,
  };
}

/** 挑戦が指定ユーザーのものか確認する。 */
export async function getAttemptOwner(
  attemptId: string,
): Promise<{ userId: string; quizId: string } | undefined> {
  const row = await queryOne<{ user_id: string; quiz_id: string }>(
    'SELECT user_id, quiz_id FROM attempts WHERE id = $1',
    [attemptId],
  );
  return row ? { userId: row.user_id, quizId: row.quiz_id } : undefined;
}

/** 1問分の解答と採点結果を保存する。解き直しは上書き。 */
export async function saveAnswer(
  attemptId: string,
  result: GradeResult,
  response: AnswerValue,
): Promise<void> {
  await query(
    `INSERT INTO answers
       (attempt_id, question_id, response, score, verdict, feedback, blank_results)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (attempt_id, question_id) DO UPDATE
       SET response = EXCLUDED.response,
           score = EXCLUDED.score,
           verdict = EXCLUDED.verdict,
           feedback = EXCLUDED.feedback,
           blank_results = EXCLUDED.blank_results,
           answered_at = now()`,
    [
      attemptId,
      result.questionId,
      JSON.stringify(response),
      result.score,
      result.verdict,
      result.feedback,
      result.blankResults ? JSON.stringify(result.blankResults) : null,
    ],
  );
}

/** 保存済みの解答を1件取り出す。AI解説のキャッシュ確認に使う。 */
export async function getAnswer(
  attemptId: string,
  questionId: string,
): Promise<{ response: AnswerValue; aiExplanation: string | null } | undefined> {
  const row = await queryOne<{ response: AnswerValue; ai_explanation: string | null }>(
    'SELECT response, ai_explanation FROM answers WHERE attempt_id = $1 AND question_id = $2',
    [attemptId, questionId],
  );
  return row ? { response: row.response, aiExplanation: row.ai_explanation } : undefined;
}

export async function saveAiExplanation(
  attemptId: string,
  questionId: string,
  text: string,
): Promise<void> {
  await query(
    'UPDATE answers SET ai_explanation = $3 WHERE attempt_id = $1 AND question_id = $2',
    [attemptId, questionId, text],
  );
}

/**
 * 挑戦を完了させ、総合点を確定する。
 * 未解答の問題も 0 点として分母に含めるため、問題数で割る。
 */
/** 中断された挑戦を消す。1問も解いていない場合だけ。履歴を汚さないため。 */
export async function discardAttempt(attemptId: string, userId: string): Promise<void> {
  await query(
    `DELETE FROM attempts
      WHERE id = $1
        AND user_id = $2
        AND completed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM answers WHERE attempt_id = $1)`,
    [attemptId, userId],
  );
}

export async function completeAttempt(attemptId: string): Promise<number> {
  // 分母は出題範囲の問題数。復習では絞った分だけで割る。
  const row = await queryOne<{ total: number }>(
    `WITH counts AS (
       SELECT CASE
                WHEN a.question_ids IS NOT NULL THEN jsonb_array_length(a.question_ids)
                ELSE (SELECT count(*)::int FROM questions q WHERE q.quiz_id = a.quiz_id)
              END AS question_count,
              (SELECT coalesce(sum(score), 0) FROM answers WHERE attempt_id = a.id) AS score_sum
         FROM attempts a
        WHERE a.id = $1
     )
     UPDATE attempts
        SET completed_at = now(),
            total_score = CASE WHEN counts.question_count = 0 THEN 0
                          ELSE round(counts.score_sum::numeric / counts.question_count) END
       FROM counts
      WHERE attempts.id = $1
      RETURNING attempts.total_score AS total`,
    [attemptId],
  );
  return row?.total ?? 0;
}

/** 復習用に、1回分の挑戦を問題と解答つきで取り出す。 */
export async function getAttemptDetail(
  attemptId: string,
  userId: string,
): Promise<AttemptDetail | undefined> {
  const attempt = await queryOne<{
    id: string;
    quiz_id: string;
    mode: AttemptMode;
    question_ids: string[] | null;
    started_at: Date;
    completed_at: Date | null;
    total_score: number | null;
  }>(
    `SELECT id, quiz_id, mode, question_ids, started_at, completed_at, total_score
       FROM attempts WHERE id = $1 AND user_id = $2`,
    [attemptId, userId],
  );
  if (!attempt) return undefined;

  const quiz = await getQuiz(attempt.quiz_id, userId);
  if (!quiz) return undefined;

  const rows = await query<{
    question_id: string;
    response: AnswerValue;
    score: number;
    verdict: string;
    feedback: string | null;
    blank_results: boolean[] | null;
  }>(
    'SELECT question_id, response, score, verdict, feedback, blank_results FROM answers WHERE attempt_id = $1',
    [attemptId],
  );

  const answers: Record<string, AnswerValue> = {};
  const results: GradeResult[] = [];
  for (const row of rows) {
    answers[row.question_id] = row.response;
    results.push({
      questionId: row.question_id,
      score: row.score,
      verdict: row.verdict as Verdict,
      feedback: row.feedback ?? '',
      ...(row.blank_results ? { blankResults: row.blank_results } : {}),
    });
  }

  // 復習の挑戦は出題した問題だけを返す。
  const scoped = attempt.question_ids
    ? { ...quiz, questions: quiz.questions.filter((q) => attempt.question_ids?.includes(q.id)) }
    : quiz;

  return {
    id: attempt.id,
    quizId: attempt.quiz_id,
    mode: attempt.mode,
    questionIds: attempt.question_ids,
    startedAt: attempt.started_at.toISOString(),
    completedAt: attempt.completed_at?.toISOString() ?? null,
    totalScore: attempt.total_score,
    quiz: scoped,
    answers,
    results,
    marks: await marksForQuiz(attempt.quiz_id, userId),
  };
}

/** クイズごとの挑戦履歴（完了分のみ、新しい順）。 */
export async function listAttempts(quizId: string, userId: string): Promise<AttemptSummary[]> {
  return query<AttemptSummary>(
    `SELECT a.id,
            a.quiz_id      AS "quizId",
            a.mode,
            a.question_ids AS "questionIds",
            a.started_at   AS "startedAt",
            a.completed_at AS "completedAt",
            a.total_score  AS "totalScore",
            CASE
              WHEN a.question_ids IS NOT NULL THEN jsonb_array_length(a.question_ids)
              ELSE (SELECT count(*)::int FROM questions q WHERE q.quiz_id = a.quiz_id)
            END AS "questionCount",
            (SELECT count(*)::int FROM answers an
              WHERE an.attempt_id = a.id AND an.verdict = 'correct') AS "correctCount"
       FROM attempts a
      WHERE a.quiz_id = $1 AND a.user_id = $2 AND a.completed_at IS NOT NULL
      ORDER BY a.completed_at DESC
      LIMIT 50`,
    [quizId, userId],
  );
}

/* ---------- 使用量 ---------- */

/** Bedrock 呼び出し1回分を記録する。記録失敗で本処理を落とさない。 */
export async function recordUsage(
  userId: string,
  kind: 'generate' | 'replace' | 'grade' | 'explain',
  usage: TokenUsage,
  questionCount?: number,
): Promise<void> {
  await query(
    `INSERT INTO usage_log (user_id, kind, model_id, input_tokens, output_tokens, question_count)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, kind, usage.modelId, usage.inputTokens, usage.outputTokens, questionCount ?? null],
  ).catch((error: unknown) => {
    console.error('[usage] 記録に失敗しました', error);
  });
}

export async function touchUser(userId: string): Promise<void> {
  await query('UPDATE users SET last_seen_at = now() WHERE id = $1', [userId]).catch(
    () => undefined,
  );
}
