import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import { query, queryOne } from './db.js';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SESSION_COOKIE = 'qf_session';
const SESSION_DAYS = Number(process.env.SESSION_DAYS ?? 30);

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
  }
}

export interface UserRow {
  id: string;
  username: string;
  role: string;
  disabled?: boolean;
}

/* ---------- パスワード ---------- */

/** `salt:hash` 形式で保存する。scrypt なので追加依存なしで使える。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;

  const derived = await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}

/* ---------- セッション ---------- */

/**
 * セッショントークンは平文をクッキーに入れ、DB にはハッシュだけ保存する。
 * DB が漏れてもセッションを再現できないようにするため。
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await query(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [hashToken(token), userId, expiresAt],
  );
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

async function userForToken(token: string): Promise<UserRow | undefined> {
  return queryOne<UserRow>(
    `SELECT u.id,
            u.username,
            u.role,
            u.disabled
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
}

/* ---------- クッキー ---------- */

/**
 * Secure 属性を付けるか。COOKIE_SECURE=1 で強制でき、指定が無くても
 * Cloudflare Tunnel 経由（X-Forwarded-Proto: https）なら自動で付ける。
 * 環境変数の付け忘れでクッキーが平文で飛ぶのを防ぐため。
 */
function useSecureCookie(req: Request): boolean {
  if (process.env.COOKIE_SECURE === '1') return true;
  if (process.env.COOKIE_SECURE === '0') return false;
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function cookieParts(req: Request, value: string, maxAge: number): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (useSecureCookie(req)) parts.push('Secure');
  return parts.join('; ');
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  res.setHeader('Set-Cookie', cookieParts(req, token, SESSION_DAYS * 24 * 60 * 60));
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.setHeader('Set-Cookie', cookieParts(req, '', 0));
}

/* ---------- 総当たり対策 ---------- */

// プロセス内のみの簡易カウンタ。多重起動するなら Postgres か Redis へ移す。
const failures = new Map<string, { count: number; until: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

/** ログイン・登録の前に呼ぶ。試行が多すぎれば例外を投げる。 */
export function guardAttempts(key: string): void {
  const state = failures.get(key);
  if (!state) return;
  if (state.until < Date.now()) {
    failures.delete(key);
    return;
  }
  if (state.count >= MAX_ATTEMPTS) {
    const minutes = Math.ceil((state.until - Date.now()) / 60000);
    throw new AuthError(`試行回数が多すぎます。${minutes} 分後に再試行してください。`, 429);
  }
}

export function recordFailure(key: string): void {
  const now = Date.now();
  const state = failures.get(key);
  if (!state || state.until < now) {
    failures.set(key, { count: 1, until: now + WINDOW_MS });
    return;
  }
  state.count += 1;
}

export function clearFailures(key: string): void {
  failures.delete(key);
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    if (pair.slice(0, index).trim() === SESSION_COOKIE) {
      return decodeURIComponent(pair.slice(index + 1).trim()) || null;
    }
  }
  return null;
}

/* ---------- ミドルウェア ---------- */

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserRow;
    sessionToken?: string;
  }
}

/** ログイン必須のルートに付ける。 */
export async function requireUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = readSessionCookie(req);
    if (!token) throw new AuthError('ログインが必要です');

    const user = await userForToken(token);
    if (!user) throw new AuthError('セッションが無効か期限切れです');
    if (user.disabled) throw new AuthError('このアカウントは管理者により無効化されています', 403);

    req.user = user;
    req.sessionToken = token;
    next();
  } catch (error) {
    next(error);
  }
}

/** 管理画面用。.env で定義した管理者アカウントでログインしていることを要求する。 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await requireUser(req, res, (error?: unknown) => {
    if (error) {
      next(error);
      return;
    }
    if (req.user?.role !== 'admin') {
      next(new AuthError('管理者アカウントでログインしてください', 403));
      return;
    }
    next();
  });
}

/* ---------- 管理者アカウント（.env 定義） ---------- */

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME ?? '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';

export const adminAccountConfigured = ADMIN_USERNAME.length > 0 && ADMIN_PASSWORD.length > 0;

/** 管理者アカウント名かどうか。一般ユーザーが同名で登録するのを防ぐのに使う。 */
export function isAdminUsername(username: string): boolean {
  return (
    adminAccountConfigured && username.trim().toLowerCase() === ADMIN_USERNAME.toLowerCase()
  );
}

/**
 * 起動時に .env の管理者アカウントを users テーブルへ反映する。
 * 既に存在する場合はパスワードと role を上書きするので、.env を変えて再起動すれば
 * パスワードの変更・ローテーションができる。
 * 未設定なら何もしない（管理画面は使えないまま = フェイルクローズ）。
 */
export async function seedAdminUser(): Promise<string | null> {
  if (!adminAccountConfigured) return null;

  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM users WHERE lower(username) = lower($1)',
    [ADMIN_USERNAME],
  );

  if (existing) {
    await query(
      "UPDATE users SET username = $2, password_hash = $3, role = 'admin', disabled = false WHERE id = $1",
      [existing.id, ADMIN_USERNAME, passwordHash],
    );
    return ADMIN_USERNAME;
  }

  await query(
    "INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, 'admin')",
    [randomUUID(), ADMIN_USERNAME, passwordHash],
  );
  return ADMIN_USERNAME;
}

/** 現在のユーザーを返す。未ログインなら undefined。 */
export async function currentUser(req: Request): Promise<UserRow | undefined> {
  const token = readSessionCookie(req);
  if (!token) return undefined;
  return userForToken(token);
}

/* ---------- 登録 ---------- */

const SIGNUP_CODE = process.env.SIGNUP_CODE ?? '';

export function checkSignupCode(code: string | undefined): void {
  if (!SIGNUP_CODE) {
    throw new AuthError(
      'サーバで SIGNUP_CODE が設定されていないため登録できません。.env に招待コードを設定してください。',
      403,
    );
  }
  if (code !== SIGNUP_CODE) throw new AuthError('招待コードが違います', 403);
}

export async function createUser(username: string, password: string): Promise<UserRow> {
  // 管理者アカウント名での登録は禁止（乗っ取り防止）。
  if (isAdminUsername(username)) {
    throw new AuthError('そのユーザー名は使えません', 409);
  }

  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM users WHERE lower(username) = lower($1)',
    [username],
  );
  if (existing) throw new AuthError('そのユーザー名は使われています', 409);

  const id = randomUUID();
  const passwordHash = await hashPassword(password);
  // 管理権限はユーザー属性ではなく ADMIN_PASSWORD による解錠で与えるため、
  // 登録されるユーザーは常に一般ユーザー。
  await query('INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, $4)', [
    id,
    username,
    passwordHash,
    'user',
  ]);
  return { id, username, role: 'user' };
}

export async function login(username: string, password: string): Promise<UserRow> {
  const row = await queryOne<UserRow & { password_hash: string; disabled: boolean }>(
    'SELECT id, username, role, disabled, password_hash FROM users WHERE lower(username) = lower($1)',
    [username],
  );
  // ユーザーが存在しない場合もハッシュ検証と同程度の時間をかけ、存在の有無を漏らさない。
  const stored = row?.password_hash ?? (await hashPassword('dummy'));
  const ok = await verifyPassword(password, stored);
  if (!row || !ok) throw new AuthError('ユーザー名またはパスワードが違います');
  if (row.disabled) throw new AuthError('このアカウントは管理者により無効化されています', 403);

  return { id: row.id, username: row.username, role: row.role };
}
