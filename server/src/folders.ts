import { randomUUID } from 'node:crypto';
import { query, queryOne } from './db.js';

export interface Folder {
  id: string;
  name: string;
  quizCount: number;
  /** 配布中か（全体または何らかのグループへ） */
  shared: boolean;
  createdAt: string;
}

export function listFolders(userId: string): Promise<Folder[]> {
  return query<Folder>(
    `SELECT f.id,
            f.name,
            f.created_at AS "createdAt",
            (SELECT count(*)::int FROM quizzes q WHERE q.folder_id = f.id) AS "quizCount",
            EXISTS (SELECT 1 FROM shares s WHERE s.folder_id = f.id)       AS shared
       FROM folders f
      WHERE f.owner_id = $1
      ORDER BY f.name`,
    [userId],
  );
}

/** 管理者の配布画面用。全ユーザーのフォルダーを所有者つきで返す。 */
export function listAllFolders(): Promise<
  { id: string; name: string; ownerName: string; quizCount: number }[]
> {
  return query(
    `SELECT f.id,
            f.name,
            u.username AS "ownerName",
            (SELECT count(*)::int FROM quizzes q WHERE q.folder_id = f.id) AS "quizCount"
       FROM folders f
       JOIN users u ON u.id = f.owner_id
      ORDER BY u.username, f.name`,
  );
}

export async function createFolder(userId: string, name: string): Promise<Folder> {
  const id = randomUUID();
  await query('INSERT INTO folders (id, owner_id, name) VALUES ($1, $2, $3)', [id, userId, name]);
  return { id, name, quizCount: 0, shared: false, createdAt: new Date().toISOString() };
}

export async function renameFolder(
  folderId: string,
  userId: string,
  name: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'UPDATE folders SET name = $3 WHERE id = $1 AND owner_id = $2 RETURNING id',
    [folderId, userId, name],
  );
  return rows.length > 0;
}

/** フォルダーを消す。中のクイズは未分類に戻るだけで消さない。 */
export async function deleteFolder(folderId: string, userId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'DELETE FROM folders WHERE id = $1 AND owner_id = $2 RETURNING id',
    [folderId, userId],
  );
  return rows.length > 0;
}

/** クイズの所属フォルダーを変える。null で未分類へ。 */
export async function moveQuiz(
  quizId: string,
  userId: string,
  folderId: string | null,
): Promise<boolean> {
  if (folderId) {
    const owned = await queryOne<{ id: string }>(
      'SELECT id FROM folders WHERE id = $1 AND owner_id = $2',
      [folderId, userId],
    );
    if (!owned) return false;
  }
  const rows = await query<{ id: string }>(
    'UPDATE quizzes SET folder_id = $3 WHERE id = $1 AND owner_id = $2 RETURNING id',
    [quizId, userId, folderId],
  );
  return rows.length > 0;
}
