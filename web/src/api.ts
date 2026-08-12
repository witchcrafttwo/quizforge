import type {
  Attempt,
  AttemptDetail,
  AttemptMode,
  AttemptSummary,
  AnswerValue,
  GradeResult,
  Question,
  QuestionMark,
  Quiz,
  QuizConfig,
  QuizSummary,
  UploadedFile,
} from './types';

const BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** セッションクッキーを送るため credentials: 'include' を必ず付ける。 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: init.body ? { 'content-type': 'application/json', ...init.headers } : init.headers,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(
      payload?.error ?? `リクエストに失敗しました (${response.status})`,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/* ---------- 認証 ---------- */

export interface User {
  id: string;
  username: string;
  role: string;
}

/** 上限値の 0 は無制限。 */
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

export interface MeResponse {
  user: User;
  plan: Plan;
  usage: { daily: number; monthly: number };
  /** .env で定義した管理者アカウントでログインしているか */
  isAdmin: boolean;
  /** サーバに管理者アカウントが設定されているか */
  adminAvailable: boolean;
}

export const me = () => request<MeResponse>('/api/auth/me');

export const listPlans = () => request<{ plans: Plan[] }>('/api/plans').then((r) => r.plans);

export const login = (username: string, password: string) =>
  post<{ user: User }>('/api/auth/login', { username, password });

export const signup = (username: string, password: string, signupCode: string) =>
  post<{ user: User }>('/api/auth/signup', { username, password, signupCode });

export const logout = () => post<void>('/api/auth/logout');

/* ---------- クイズ ---------- */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  status: JobStatus;
  quizId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedSeconds: number;
}

/** 生成を依頼する。すぐ返るので、あとは getJob で状態を見る。 */
export const requestGeneration = (input: {
  config: QuizConfig;
  files: UploadedFile[];
  text?: string;
}) => post<Job>('/api/quiz/generate', input);

export const getJob = (id: string) => request<Job>(`/api/jobs/${id}`);

export const listActiveJobs = () =>
  request<{ jobs: Job[] }>('/api/jobs').then((r) => r.jobs);

export const listQuizzes = () =>
  request<{ quizzes: QuizSummary[] }>('/api/quizzes').then((r) => r.quizzes);

export const getQuiz = (id: string) => request<Quiz>(`/api/quizzes/${id}`);

export const deleteQuiz = (id: string) => request<void>(`/api/quizzes/${id}`, { method: 'DELETE' });

export const deleteQuestion = (quizId: string, questionId: string) =>
  request<void>(`/api/quizzes/${quizId}/questions/${questionId}`, { method: 'DELETE' });

export const replaceQuestion = (
  quizId: string,
  questionId: string,
  input: { config: QuizConfig; files: UploadedFile[]; text?: string },
) => post<Question>(`/api/quizzes/${quizId}/questions/${questionId}/replace`, input);

/* ---------- フォルダー ---------- */

export interface Folder {
  id: string;
  name: string;
  quizCount: number;
  shared: boolean;
  createdAt: string;
}

export const listFolders = () =>
  request<{ folders: Folder[] }>('/api/folders').then((r) => r.folders);

export const createFolder = (name: string) => post<Folder>('/api/folders', { name });

export const renameFolder = (id: string, name: string) =>
  request<{ name: string }>(`/api/folders/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });

export const deleteFolder = (id: string) =>
  request<void>(`/api/folders/${id}`, { method: 'DELETE' });

export const moveQuizToFolder = (quizId: string, folderId: string | null) =>
  request<{ folderId: string | null }>(`/api/quizzes/${quizId}/folder`, {
    method: 'PATCH',
    body: JSON.stringify({ folderId }),
  });

/* ---------- グループと配布（管理者） ---------- */

export interface Group {
  id: string;
  name: string;
  memberCount: number;
  createdAt: string;
}

export interface Share {
  id: string;
  quizId: string | null;
  folderId: string | null;
  groupId: string | null;
  targetKind: 'quiz' | 'folder';
  targetName: string;
  ownerName: string;
  groupName: string | null;
  createdAt: string;
}

export interface SharingData {
  groups: Group[];
  /** グループ id → 所属ユーザー id の配列 */
  memberships: Record<string, string[]>;
  shares: Share[];
  folders: { id: string; name: string; ownerName: string; quizCount: number }[];
  quizzes: AdminQuizRow[];
}

export const adminSharing = () => request<SharingData>('/api/admin/sharing');

export const adminCreateGroup = (name: string) => post<Group>('/api/admin/groups', { name });

export const adminDeleteGroup = (id: string) =>
  request<void>(`/api/admin/groups/${id}`, { method: 'DELETE' });

export const adminSetGroupMember = (groupId: string, userId: string, member: boolean) =>
  post<{ ok: true }>(`/api/admin/groups/${groupId}/members`, { userId, member });

export const adminCreateShare = (
  kind: 'quiz' | 'folder',
  targetId: string,
  groupId: string | null,
) => post<{ id: string }>('/api/admin/shares', { kind, targetId, groupId });

export const adminDeleteShare = (id: string) =>
  request<void>(`/api/admin/shares/${id}`, { method: 'DELETE' });

export const renameQuiz = (id: string, title: string) =>
  request<{ title: string }>(`/api/quizzes/${id}/title`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });

export const shareQuiz = (id: string, shared: boolean) =>
  post<{ shared: boolean }>(`/api/quizzes/${id}/share`, { shared });

export const listAttempts = (quizId: string) =>
  request<{ attempts: AttemptSummary[] }>(`/api/quizzes/${quizId}/attempts`).then(
    (r) => r.attempts,
  );

/* ---------- 挑戦と解答 ---------- */

export type { AttemptMode, AttemptSummary, QuestionMark } from './types';

/** 解答後の自己申告を保存する。null で解除。 */
export const setQuestionMark = (questionId: string, mark: QuestionMark | null) =>
  request<{ mark: QuestionMark | null }>(`/api/questions/${questionId}/mark`, {
    method: 'PUT',
    body: JSON.stringify({ mark }),
  });

export const startAttempt = (quizId: string, mode: AttemptMode = 'full') =>
  post<Attempt>(`/api/quizzes/${quizId}/attempts`, { mode });

export const submitAnswer = (attemptId: string, questionId: string, response: AnswerValue) =>
  post<GradeResult>(`/api/attempts/${attemptId}/answers`, { questionId, response });

export const explainAnswer = (attemptId: string, questionId: string) =>
  post<{ explanation: string; cached: boolean }>(`/api/attempts/${attemptId}/explain`, {
    questionId,
  });

export const discardAttempt = (attemptId: string) =>
  post<void>(`/api/attempts/${attemptId}/discard`);

export const completeAttempt = (attemptId: string) =>
  post<{ totalScore: number }>(`/api/attempts/${attemptId}/complete`);

export const getAttempt = (attemptId: string) =>
  request<AttemptDetail>(`/api/attempts/${attemptId}`);

/* ---------- ファイル ---------- */

/** File を base64（data URL のプレフィックスなし）に変換する。 */
export function fileToUploaded(file: File): Promise<UploadedFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} を読み込めませんでした`));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve({
        name: file.name,
        base64: comma === -1 ? result : result.slice(comma + 1),
        mimeType: file.type || 'application/octet-stream',
      });
    };
    reader.readAsDataURL(file);
  });
}

/* ---------- 管理者 ---------- */

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

export interface ModelPrice {
  modelId: string;
  inputPer1m: number;
  outputPer1m: number;
  configured: boolean;
}

export interface AdminOverview {
  summary: {
    userCount: number;
    activeUserCount: number;
    quizCount: number;
    attemptCount: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
    unpricedModels: string[];
    days: number;
  };
  byModel: ModelUsage[];
  daily: { day: string; calls: number; inputTokens: number; outputTokens: number }[];
  plans: Plan[];
  prices: ModelPrice[];
}

export const adminOverview = (days: number) =>
  request<AdminOverview>(`/api/admin/overview?days=${days}`);

export const adminUsers = (days: number) =>
  request<{ users: AdminUserRow[] }>(`/api/admin/users?days=${days}`).then((r) => r.users);

export const adminSetDisabled = (id: string, disabled: boolean) =>
  post<{ disabled: boolean }>(`/api/admin/users/${id}/disabled`, { disabled });

export type ModelRole = 'generate' | 'grader' | 'explainer';

export interface ModelOption {
  id: string;
  /** .env で `id|表示名` と書いた場合の表示名。無ければ id。 */
  label: string;
}

export interface ModelSettings {
  current: Record<ModelRole, string>;
  defaults: Record<ModelRole, string>;
  options: ModelOption[];
}

export const adminModels = () => request<ModelSettings>('/api/admin/models');

/** modelId に null を渡すと .env の既定値へ戻る。 */
export const adminSetModel = (role: ModelRole, modelId: string | null) =>
  request<ModelSettings>(`/api/admin/models/${role}`, {
    method: 'PUT',
    body: JSON.stringify({ modelId }),
  });

export const adminUpdatePrice = (modelId: string, inputPer1m: number, outputPer1m: number) =>
  request<ModelPrice>(`/api/admin/prices/${encodeURIComponent(modelId)}`, {
    method: 'PUT',
    body: JSON.stringify({ inputPer1m, outputPer1m }),
  });

export interface AdminQuizRow {
  id: string;
  title: string;
  ownerName: string;
  questionCount: number;
  shared: boolean;
  createdAt: string;
}

export const adminQuizzes = () =>
  request<{ quizzes: AdminQuizRow[] }>('/api/admin/quizzes').then((r) => r.quizzes);

export const adminSetPlan = (id: string, planId: string) =>
  post<{ planId: string }>(`/api/admin/users/${id}/plan`, { planId });

export const adminUpdatePlan = (
  id: string,
  values: Omit<Plan, 'id' | 'sortOrder'>,
) => request<Plan>(`/api/admin/plans/${id}`, { method: 'PUT', body: JSON.stringify(values) });

export const adminDeleteUser = (id: string) =>
  request<void>(`/api/admin/users/${id}`, { method: 'DELETE' });
