import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import * as admin from './admin.js';
import { gradeAnswer } from './answer.js';
import {
  AuthError,
  adminAccountConfigured,
  checkSignupCode,
  clearFailures,
  clearSessionCookie,
  createSession,
  createUser,
  currentUser,
  destroySession,
  guardAttempts,
  login,
  recordFailure,
  readSessionCookie,
  requireAdmin,
  requireUser,
  setSessionCookie,
} from './auth.js';
import { MODEL_ID, REGION, SUPPORTED_EXTENSIONS, UnsupportedFileError } from './bedrock.js';
import { explainAnswer } from './explain.js';
import * as repo from './repo.js';
import { generateQuiz, generateReplacement } from './quiz.js';
import * as folders from './folders.js';
import * as jobs from './jobs.js';
import * as modelConfig from './modelConfig.js';
import * as plans from './plans.js';
import * as sharing from './sharing.js';
import {
  credentialsSchema,
  folderNameSchema,
  generateRequestSchema,
  groupNameSchema,
  modelPriceSchema,
  modelRoleSchema,
  planLimitsSchema,
  questionMarkSchema,
  quizTitleSchema,
  shareSchema,
  signupSchema,
  submitAnswerSchema,
  uuidSchema,
} from './validation.js';

// 認証はセッションクッキー。インターネットに公開する場合は HTTPS 必須で、
// COOKIE_SECURE=1 を立ててクッキーに Secure を付けること。
/**
 * フロントのビルド成果物の場所を決める。
 * WEB_DIST があればそれを、無ければ server/dist から見た ../../web/dist を使う。
 * 存在しなければ null を返し、静的配信を行わない（開発時は Vite が担当）。
 */
function resolveWebDist(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = process.env.WEB_DIST
    ? path.resolve(process.env.WEB_DIST)
    : path.resolve(here, '../../web/dist');

  if (!existsSync(path.join(candidate, 'index.html'))) {
    console.warn(`[web] ${candidate} が見つかりません。API のみで起動します。`);
    return null;
  }
  console.log(`web  : ${candidate}`);
  return candidate;
}

export function createApp() {
  const app = express();

  // Cloudflare Tunnel（cloudflared）はローカルへ http で転送してくるので、
  // X-Forwarded-Proto と X-Forwarded-For を信頼しないと
  // 「HTTPS なのに http 扱い」「全員のIPが 127.0.0.1」になる。
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));

  // クッキーを使うので、別オリジンから叩く場合は資格情報付きを許可する。
  const origin = process.env.CORS_ORIGIN;
  app.use(cors(origin ? { origin: origin.split(','), credentials: true } : { credentials: true }));
  // base64 で 4/3 に膨らむので、MAX_TOTAL_MB より十分大きく取る。
  app.use(express.json({ limit: process.env.MAX_BODY_SIZE ?? '96mb' }));

  const wrap =
    (handler: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      handler(req, res).catch(next);
    };

  /* ---------- 稼働確認 ---------- */

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      region: REGION,
      modelId: MODEL_ID,
      supportedExtensions: SUPPORTED_EXTENSIONS,
    });
  });

  /* ---------- 認証 ---------- */

  app.post(
    '/api/auth/signup',
    wrap(async (req, res) => {
      // 招待コードの総当たりを防ぐため、入力検証より前に IP 単位で制限する。
      const key = `signup:${req.ip}`;
      guardAttempts(key);
      try {
        const { username, password, signupCode } = signupSchema.parse(req.body);
        checkSignupCode(signupCode);
        const user = await createUser(username, password);
        clearFailures(key);
        setSessionCookie(req, res, await createSession(user.id));
        res.status(201).json({ user });
      } catch (error) {
        recordFailure(key);
        throw error;
      }
    }),
  );

  app.post(
    '/api/auth/login',
    wrap(async (req, res) => {
      // IP の判定は入力検証より前に行う。不正な形のリクエストを投げ続けるだけで
      // 制限を回避できてしまうため。
      const ipKey = `login-ip:${req.ip}`;
      guardAttempts(ipKey);

      let username = '';
      try {
        const parsed = credentialsSchema.parse(req.body);
        username = parsed.username;

        // ユーザー名単位でも制限する。IP だけだと共有回線の正当な利用を巻き込み、
        // ユーザー名だけだと IP を変えて狙い撃ちされる。
        const userKey = `login-user:${username.toLowerCase()}`;
        guardAttempts(userKey);

        const user = await login(username, parsed.password);
        clearFailures(ipKey);
        clearFailures(userKey);
        setSessionCookie(req, res, await createSession(user.id));
        res.json({ user });
      } catch (error) {
        recordFailure(ipKey);
        if (username) recordFailure(`login-user:${username.toLowerCase()}`);
        throw error;
      }
    }),
  );

  app.post(
    '/api/auth/logout',
    wrap(async (req, res) => {
      const token = readSessionCookie(req);
      if (token) await destroySession(token);
      clearSessionCookie(req, res);
      res.status(204).end();
    }),
  );

  app.get(
    '/api/auth/me',
    wrap(async (req, res) => {
      const user = await currentUser(req);
      if (!user) {
        res.status(401).json({ error: 'ログインしていません' });
        return;
      }
      // 出題設定はブラウザの localStorage に持たせるので、ここでは扱わない。
      const [plan, usage] = await Promise.all([
        plans.getPlanForUser(user.id, user.role),
        plans.generationUsage(user.id),
      ]);
      res.json({
        user,
        plan,
        usage,
        isAdmin: user.role === 'admin',
        adminAvailable: adminAccountConfigured,
      });
    }),
  );

  /** 料金表の表示用。ログインしていなくても見られる。 */
  app.get(
    '/api/plans',
    wrap(async (_req, res) => {
      res.json({ plans: await plans.listPlans() });
    }),
  );

  /* ---------- クイズ ---------- */

  app.post(
    '/api/quiz/generate',
    requireUser,
    wrap(async (req, res) => {
      const user = req.user!;
      const plan = await plans.getPlanForUser(user.id, user.role);
      await plans.assertGenerationAllowed(user.id, plan);

      const parsed = generateRequestSchema.parse(req.body);
      const limitError = plans.checkAgainstPlan(plan, parsed.files, parsed.config.questionCount);
      if (limitError) {
        res.status(413).json({ error: limitError });
        return;
      }

      // 生成は20〜90秒かかるため、ここでは受け付けだけして即座に返す。
      // プロキシのタイムアウト（Cloudflare は100秒）に依存しなくなる。
      res.status(202).json(await jobs.enqueueGeneration(user.id, parsed));
    }),
  );

  app.get(
    '/api/jobs/:id',
    requireUser,
    wrap(async (req, res) => {
      const job = await jobs.getJob(uuidSchema.parse(req.params.id), req.user!.id);
      if (!job) {
        res.status(404).json({ error: 'ジョブが見つかりません' });
        return;
      }
      res.json(job);
    }),
  );

  /** 再読み込み後に進行中の生成へ戻れるようにする。 */
  app.get(
    '/api/jobs',
    requireUser,
    wrap(async (req, res) => {
      res.json({ jobs: await jobs.listActiveJobs(req.user!.id) });
    }),
  );

  app.get(
    '/api/quizzes',
    requireUser,
    wrap(async (req, res) => {
      res.json({ quizzes: await repo.listQuizzes(req.user!.id) });
    }),
  );

  app.get(
    '/api/quizzes/:id',
    requireUser,
    wrap(async (req, res) => {
      const quiz = await repo.getQuiz(uuidSchema.parse(req.params.id), req.user!.id);
      if (!quiz) {
        res.status(404).json({ error: 'クイズが見つかりません' });
        return;
      }
      res.json(quiz);
    }),
  );

  app.delete(
    '/api/quizzes/:id',
    requireUser,
    wrap(async (req, res) => {
      const ok = await repo.deleteQuiz(uuidSchema.parse(req.params.id), req.user!.id);
      if (!ok) {
        res.status(404).json({ error: '削除できませんでした（自分が作成したクイズのみ削除できます）' });
        return;
      }
      res.status(204).end();
    }),
  );

  app.patch(
    '/api/quizzes/:id/title',
    requireUser,
    wrap(async (req, res) => {
      const title = quizTitleSchema.parse(req.body?.title);
      const ok = await repo.renameQuiz(uuidSchema.parse(req.params.id), req.user!.id, title);
      if (!ok) {
        res
          .status(404)
          .json({ error: '名前を変更できませんでした（自分が作成したクイズのみ変更できます）' });
        return;
      }
      res.json({ title });
    }),
  );

  /** 不適切な問題を削除する。最後の1問は残す。 */
  app.delete(
    '/api/quizzes/:id/questions/:questionId',
    requireUser,
    wrap(async (req, res) => {
      const result = await repo.deleteQuestion(
        uuidSchema.parse(req.params.id),
        uuidSchema.parse(req.params.questionId),
        req.user!.id,
      );
      if (result === 'not_found') {
        res.status(404).json({ error: '問題が見つかりません' });
        return;
      }
      if (result === 'last_one') {
        res.status(400).json({ error: '最後の1問は削除できません' });
        return;
      }
      res.status(204).end();
    }),
  );

  /**
   * 不適切な問題を、同じ形式・難易度の別の問題に差し替える。
   * 資料を Bedrock に再送するため、作成回数の枠を1回消費する。
   */
  app.post(
    '/api/quizzes/:id/questions/:questionId/replace',
    requireUser,
    wrap(async (req, res) => {
      const user = req.user!;
      const quizId = uuidSchema.parse(req.params.id);
      const questionId = uuidSchema.parse(req.params.questionId);

      const plan = await plans.getPlanForUser(user.id, user.role);
      await plans.assertGenerationAllowed(user.id, plan);

      const parsed = generateRequestSchema.parse(req.body);
      const limitError = plans.checkAgainstPlan(plan, parsed.files, 1);
      if (limitError) {
        res.status(413).json({ error: limitError });
        return;
      }

      const quiz = await repo.getQuiz(quizId, user.id);
      const target = quiz?.questions.find((q) => q.id === questionId);
      if (!quiz || !target) {
        res.status(404).json({ error: '問題が見つかりません' });
        return;
      }

      const avoid = quiz.questions.filter((q) => q.id !== questionId).map((q) => q.question);
      const { question, usage } = await generateReplacement(
        { ...parsed, config: { ...parsed.config, language: quiz.config.language } },
        { type: target.type, difficulty: target.difficulty },
        avoid,
      );

      const ok = await repo.replaceQuestion(quizId, questionId, question, user.id);
      if (!ok) {
        res.status(404).json({ error: '差し替えできませんでした' });
        return;
      }
      await repo.recordUsage(user.id, 'replace', usage, 1);
      res.json(question);
    }),
  );

  /* ---------- フォルダー（各ユーザー） ---------- */

  app.get(
    '/api/folders',
    requireUser,
    wrap(async (req, res) => {
      res.json({ folders: await folders.listFolders(req.user!.id) });
    }),
  );

  app.post(
    '/api/folders',
    requireUser,
    wrap(async (req, res) => {
      const name = folderNameSchema.parse(req.body?.name);
      res.status(201).json(await folders.createFolder(req.user!.id, name));
    }),
  );

  app.patch(
    '/api/folders/:id',
    requireUser,
    wrap(async (req, res) => {
      const name = folderNameSchema.parse(req.body?.name);
      const ok = await folders.renameFolder(uuidSchema.parse(req.params.id), req.user!.id, name);
      if (!ok) {
        res.status(404).json({ error: 'フォルダーが見つかりません' });
        return;
      }
      res.json({ name });
    }),
  );

  app.delete(
    '/api/folders/:id',
    requireUser,
    wrap(async (req, res) => {
      // 中のクイズは未分類に戻るだけで消えない。
      const ok = await folders.deleteFolder(uuidSchema.parse(req.params.id), req.user!.id);
      if (!ok) {
        res.status(404).json({ error: 'フォルダーが見つかりません' });
        return;
      }
      res.status(204).end();
    }),
  );

  app.patch(
    '/api/quizzes/:id/folder',
    requireUser,
    wrap(async (req, res) => {
      const raw = req.body?.folderId;
      const folderId = raw === null || raw === undefined ? null : uuidSchema.parse(raw);
      const ok = await folders.moveQuiz(uuidSchema.parse(req.params.id), req.user!.id, folderId);
      if (!ok) {
        res.status(404).json({ error: '移動できませんでした' });
        return;
      }
      res.json({ folderId });
    }),
  );

  /* ---------- グループと配布（管理者） ---------- */

  app.get(
    '/api/admin/sharing',
    requireAdmin,
    wrap(async (_req, res) => {
      const [groups, memberships, shares, allFolders, quizzes] = await Promise.all([
        sharing.listGroups(),
        sharing.groupMemberships(),
        sharing.listShares(),
        folders.listAllFolders(),
        repo.listAllQuizzes(),
      ]);
      res.json({ groups, memberships, shares, folders: allFolders, quizzes });
    }),
  );

  app.post(
    '/api/admin/groups',
    requireAdmin,
    wrap(async (req, res) => {
      res.status(201).json(await sharing.createGroup(groupNameSchema.parse(req.body?.name)));
    }),
  );

  app.patch(
    '/api/admin/groups/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const name = groupNameSchema.parse(req.body?.name);
      const ok = await sharing.renameGroup(uuidSchema.parse(req.params.id), name);
      if (!ok) {
        res.status(404).json({ error: 'グループが見つかりません' });
        return;
      }
      res.json({ name });
    }),
  );

  app.delete(
    '/api/admin/groups/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const ok = await sharing.deleteGroup(uuidSchema.parse(req.params.id));
      if (!ok) {
        res.status(404).json({ error: 'グループが見つかりません' });
        return;
      }
      res.status(204).end();
    }),
  );

  app.post(
    '/api/admin/groups/:id/members',
    requireAdmin,
    wrap(async (req, res) => {
      const groupId = uuidSchema.parse(req.params.id);
      const userId = uuidSchema.parse(req.body?.userId);
      await sharing.setGroupMember(groupId, userId, Boolean(req.body?.member));
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/admin/shares',
    requireAdmin,
    wrap(async (req, res) => {
      const { kind, targetId, groupId } = shareSchema.parse(req.body);
      const id = await sharing.createShare({ kind, id: targetId }, groupId);
      res.status(201).json({ id });
    }),
  );

  app.delete(
    '/api/admin/shares/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const ok = await sharing.deleteShare(uuidSchema.parse(req.params.id));
      if (!ok) {
        res.status(404).json({ error: '配布設定が見つかりません' });
        return;
      }
      res.status(204).end();
    }),
  );

  /** 旧方式の全体配布トグル。互換のため残す。 */
  app.post(
    '/api/quizzes/:id/share',
    requireAdmin,
    wrap(async (req, res) => {
      const shared = Boolean(req.body?.shared);
      const ok = await repo.setQuizShared(uuidSchema.parse(req.params.id), shared);
      if (!ok) {
        res.status(404).json({ error: 'クイズが見つかりません' });
        return;
      }
      res.json({ shared });
    }),
  );

  app.get(
    '/api/admin/quizzes',
    requireAdmin,
    wrap(async (_req, res) => {
      res.json({ quizzes: await repo.listAllQuizzes() });
    }),
  );

  app.get(
    '/api/quizzes/:id/attempts',
    requireUser,
    wrap(async (req, res) => {
      const quizId = uuidSchema.parse(req.params.id);
      res.json({ attempts: await repo.listAttempts(quizId, req.user!.id) });
    }),
  );

  /* ---------- 挑戦と解答 ---------- */

  app.post(
    '/api/quizzes/:id/attempts',
    requireUser,
    wrap(async (req, res) => {
      const quizId = uuidSchema.parse(req.params.id);
      const quiz = await repo.getQuiz(quizId, req.user!.id);
      if (!quiz) {
        res.status(404).json({ error: 'クイズが見つかりません' });
        return;
      }

      // 復習なら、直近で間違えた問題だけに絞る。
      if (req.body?.mode === 'review') {
        const weak = await repo.weakQuestionIds(quizId, req.user!.id);
        if (weak.length === 0) {
          res.status(400).json({ error: '復習する問題がありません' });
          return;
        }
        res.status(201).json(await repo.createAttempt(quizId, req.user!.id, 'review', weak));
        return;
      }

      res.status(201).json(await repo.createAttempt(quizId, req.user!.id));
    }),
  );

  app.post(
    '/api/attempts/:id/answers',
    requireUser,
    wrap(async (req, res) => {
      const attemptId = uuidSchema.parse(req.params.id);
      const owner = await repo.getAttemptOwner(attemptId);
      if (!owner || owner.userId !== req.user!.id) {
        res.status(404).json({ error: '挑戦が見つかりません' });
        return;
      }

      const { questionId, response } = submitAnswerSchema.parse(req.body);
      const quiz = await repo.getQuiz(owner.quizId, req.user!.id);
      const question = quiz?.questions.find((q) => q.id === questionId);
      if (!quiz || !question) {
        res.status(404).json({ error: '問題が見つかりません' });
        return;
      }

      const { result, usage } = await gradeAnswer(question, response, quiz.config.language);
      await repo.saveAnswer(attemptId, result, response);
      if (usage) await repo.recordUsage(req.user!.id, 'grade', usage);
      res.json(result);
    }),
  );

  app.post(
    '/api/attempts/:id/explain',
    requireUser,
    wrap(async (req, res) => {
      const attemptId = uuidSchema.parse(req.params.id);
      const owner = await repo.getAttemptOwner(attemptId);
      if (!owner || owner.userId !== req.user!.id) {
        res.status(404).json({ error: '挑戦が見つかりません' });
        return;
      }

      const questionId = uuidSchema.parse(req.body?.questionId);
      const saved = await repo.getAnswer(attemptId, questionId);
      if (!saved) {
        res.status(400).json({ error: '先に解答してください' });
        return;
      }
      // 一度生成したものは使い回して再課金しない。
      if (saved.aiExplanation) {
        res.json({ explanation: saved.aiExplanation, cached: true });
        return;
      }

      const quiz = await repo.getQuiz(owner.quizId, req.user!.id);
      const question = quiz?.questions.find((q) => q.id === questionId);
      if (!quiz || !question) {
        res.status(404).json({ error: '問題が見つかりません' });
        return;
      }

      const { text, usage } = await explainAnswer(question, saved.response, quiz.config.language);
      await repo.saveAiExplanation(attemptId, questionId, text);
      await repo.recordUsage(req.user!.id, 'explain', usage);
      res.json({ explanation: text, cached: false });
    }),
  );

  /** 解答後の自己申告。'review' でまた解く、'mastered' で完璧、null で解除。 */
  app.put(
    '/api/questions/:questionId/mark',
    requireUser,
    wrap(async (req, res) => {
      const questionId = uuidSchema.parse(req.params.questionId);
      const { mark } = questionMarkSchema.parse(req.body);

      const quizId = await repo.findQuizIdOfQuestion(questionId, req.user!.id);
      if (!quizId) {
        res.status(404).json({ error: '問題が見つかりません' });
        return;
      }
      await repo.setQuestionMark(req.user!.id, questionId, mark);
      res.json({ mark });
    }),
  );

  /** 中断。1問も解いていない挑戦は履歴に残さず消す。 */
  app.post(
    '/api/attempts/:id/discard',
    requireUser,
    wrap(async (req, res) => {
      await repo.discardAttempt(uuidSchema.parse(req.params.id), req.user!.id);
      res.status(204).end();
    }),
  );

  app.post(
    '/api/attempts/:id/complete',
    requireUser,
    wrap(async (req, res) => {
      const attemptId = uuidSchema.parse(req.params.id);
      const owner = await repo.getAttemptOwner(attemptId);
      if (!owner || owner.userId !== req.user!.id) {
        res.status(404).json({ error: '挑戦が見つかりません' });
        return;
      }
      const totalScore = await repo.completeAttempt(attemptId);
      res.json({ totalScore });
    }),
  );

  app.get(
    '/api/attempts/:id',
    requireUser,
    wrap(async (req, res) => {
      const detail = await repo.getAttemptDetail(uuidSchema.parse(req.params.id), req.user!.id);
      if (!detail) {
        res.status(404).json({ error: '挑戦が見つかりません' });
        return;
      }
      res.json(detail);
    }),
  );

  /* ---------- 管理者 ---------- */

  const periodDays = (req: Request) => {
    const raw = Number(req.query.days ?? 30);
    if (!Number.isFinite(raw)) return 30;
    return Math.min(365, Math.max(1, Math.trunc(raw)));
  };

  app.get(
    '/api/admin/overview',
    requireAdmin,
    wrap(async (req, res) => {
      const days = periodDays(req);
      const [summary, byModel, daily, planList, prices] = await Promise.all([
        admin.overview(days),
        admin.usageByModel(days),
        admin.dailyUsage(days),
        plans.listPlans(),
        admin.listModelPrices(),
      ]);
      res.json({ summary, byModel, daily, plans: planList, prices });
    }),
  );

  app.get(
    '/api/admin/users',
    requireAdmin,
    wrap(async (req, res) => {
      res.json({ users: await admin.listUsers(periodDays(req)) });
    }),
  );

  app.post(
    '/api/admin/users/:id/disabled',
    requireAdmin,
    wrap(async (req, res) => {
      const targetId = uuidSchema.parse(req.params.id);
      const disabled = Boolean(req.body?.disabled);

      // 最後の管理者を自分で締め出せないようにする。
      if (disabled && targetId === req.user!.id) {
        res.status(400).json({ error: '自分自身を無効化できません' });
        return;
      }
      const ok = await admin.setUserDisabled(targetId, disabled);
      if (!ok) {
        res.status(404).json({ error: 'ユーザーが見つかりません' });
        return;
      }
      res.json({ disabled });
    }),
  );

  app.post(
    '/api/admin/users/:id/plan',
    requireAdmin,
    wrap(async (req, res) => {
      const targetId = uuidSchema.parse(req.params.id);
      const planId = String(req.body?.planId ?? '');
      const ok = await plans.setUserPlan(targetId, planId);
      if (!ok) {
        res.status(404).json({ error: 'ユーザーまたはプランが見つかりません' });
        return;
      }
      res.json({ planId });
    }),
  );

  /** 使用モデルの確認と切り替え。空文字を送ると環境変数の値に戻る。 */
  app.get(
    '/api/admin/models',
    requireAdmin,
    wrap(async (_req, res) => {
      const options = await modelConfig.listModelOptions().catch((error: unknown) => {
        console.error('[models] 一覧の取得に失敗', error);
        return [];
      });
      res.json({ ...modelConfig.modelSettings(), options });
    }),
  );

  app.put(
    '/api/admin/models/:role',
    requireAdmin,
    wrap(async (req, res) => {
      const { role, modelId } = modelRoleSchema.parse({
        role: req.params.role,
        modelId: req.body?.modelId ?? null,
      });
      await modelConfig.setModel(role, modelId);
      res.json(modelConfig.modelSettings());
    }),
  );

  app.put(
    '/api/admin/prices/:modelId',
    requireAdmin,
    wrap(async (req, res) => {
      const { inputPer1m, outputPer1m } = modelPriceSchema.parse(req.body);
      const modelId = String(req.params.modelId);
      res.json(await admin.upsertModelPrice(modelId, inputPer1m, outputPer1m));
    }),
  );

  app.put(
    '/api/admin/plans/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const values = planLimitsSchema.parse(req.body);
      const updated = await plans.updatePlan(String(req.params.id), values);
      if (!updated) {
        res.status(404).json({ error: 'プランが見つかりません' });
        return;
      }
      res.json(updated);
    }),
  );

  app.delete(
    '/api/admin/users/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const targetId = uuidSchema.parse(req.params.id);
      if (targetId === req.user!.id) {
        res.status(400).json({ error: '自分自身は削除できません' });
        return;
      }
      // クイズ・挑戦・使用量も外部キーの ON DELETE CASCADE で消える。
      const ok = await admin.deleteUser(targetId);
      if (!ok) {
        res.status(404).json({ error: 'ユーザーが見つかりません' });
        return;
      }
      res.status(204).end();
    }),
  );

  /* ---------- フロントの配信（本番） ---------- */

  // WEB_DIST を静的配信し、/library や /admin では index.html を返す（SPA フォールバック）。
  // 開発時は Vite が受け持つので、ビルド成果物が無ければ何もしない。
  const webDist = resolveWebDist();
  if (webDist) {
    const indexHtml = path.join(webDist, 'index.html');

    app.use(
      express.static(webDist, {
        index: false,
        setHeaders(res, filePath) {
          const name = path.basename(filePath);
          // index.html と Service Worker を長期キャッシュすると更新が届かなくなる。
          if (name === 'index.html' || name === 'sw.js' || name.endsWith('.webmanifest')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(name)) {
            // Vite は index-B82D7KFU.js のようにハッシュを付ける。内容が変われば
            // 名前も変わるので、長期キャッシュして構わない。
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );

    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) {
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  /* ---------- エラー処理 ---------- */

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      res.status(400).json({ error: '入力が不正です', details: error.issues });
      return;
    }
    if (error instanceof AuthError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof UnsupportedFileError) {
      res.status(415).json({ error: error.message });
      return;
    }

    const status = (error as { status?: number } | null)?.status;
    if (typeof status === 'number') {
      res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    console.error('[api]', name, message);

    if (name === 'AccessDeniedException') {
      res.status(403).json({
        error: `モデル ${MODEL_ID} を ${REGION} で呼び出せません。Bedrock コンソールでモデルアクセスを有効化してください。`,
      });
      return;
    }
    if (name === 'ThrottlingException') {
      res.status(429).json({ error: 'Bedrock がスロットリングしています。少し待って再試行してください。' });
      return;
    }
    if (name === 'ValidationException') {
      res.status(400).json({ error: `Bedrock がリクエストを拒否しました: ${message}` });
      return;
    }
    res.status(500).json({ error: message });
  });

  return app;
}
