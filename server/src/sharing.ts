import { randomUUID } from 'node:crypto';
import { query, queryOne } from './db.js';

/**
 * クイズ q がユーザーから見えるかの条件。SQL に埋め込んで使う。
 * 判定を1か所に集約して、一覧・取得・問題の権限確認で食い違わないようにする。
 *
 * 見える条件は3つ:
 *  - 自分が作った
 *  - quizzes.shared（旧方式の全体配布。互換のため残す）
 *  - shares にクイズ単体かフォルダー単位の配布があり、全体配布か所属グループ向け
 */
export function visibleSql(userParam: string): string {
  return `(
    q.owner_id = ${userParam}
    OR q.shared
    OR EXISTS (
      SELECT 1 FROM shares s
       WHERE (s.quiz_id = q.id
              OR (s.folder_id IS NOT NULL AND s.folder_id = q.folder_id))
         AND (s.group_id IS NULL
              OR EXISTS (SELECT 1 FROM group_members gm
                          WHERE gm.group_id = s.group_id AND gm.user_id = ${userParam}))
    )
  )`;
}

/* ---------- グループ ---------- */

export interface Group {
  id: string;
  name: string;
  memberCount: number;
  createdAt: string;
}

export function listGroups(): Promise<Group[]> {
  return query<Group>(
    `SELECT g.id,
            g.name,
            g.created_at AS "createdAt",
            (SELECT count(*)::int FROM group_members m WHERE m.group_id = g.id) AS "memberCount"
       FROM groups g
      ORDER BY g.name`,
  );
}

export async function createGroup(name: string): Promise<Group> {
  const id = randomUUID();
  await query('INSERT INTO groups (id, name) VALUES ($1, $2)', [id, name]);
  return { id, name, memberCount: 0, createdAt: new Date().toISOString() };
}

export async function renameGroup(groupId: string, name: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'UPDATE groups SET name = $2 WHERE id = $1 RETURNING id',
    [groupId, name],
  );
  return rows.length > 0;
}

export async function deleteGroup(groupId: string): Promise<boolean> {
  const rows = await query<{ id: string }>('DELETE FROM groups WHERE id = $1 RETURNING id', [
    groupId,
  ]);
  return rows.length > 0;
}

/** グループ全体の所属表。管理画面のチェックボックス表示に使う。 */
export async function groupMemberships(): Promise<Record<string, string[]>> {
  const rows = await query<{ group_id: string; user_id: string }>(
    'SELECT group_id, user_id FROM group_members',
  );
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    (out[row.group_id] ??= []).push(row.user_id);
  }
  return out;
}

export async function setGroupMember(
  groupId: string,
  userId: string,
  member: boolean,
): Promise<void> {
  if (member) {
    await query(
      'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [groupId, userId],
    );
    return;
  }
  await query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
}

/* ---------- 配布 ---------- */

export interface Share {
  id: string;
  quizId: string | null;
  folderId: string | null;
  groupId: string | null;
  /** 表示用。クイズ名かフォルダー名。 */
  targetName: string;
  targetKind: 'quiz' | 'folder';
  ownerName: string;
  /** null なら全体配布。 */
  groupName: string | null;
  createdAt: string;
}

export function listShares(): Promise<Share[]> {
  return query<Share>(
    `SELECT s.id,
            s.quiz_id   AS "quizId",
            s.folder_id AS "folderId",
            s.group_id  AS "groupId",
            CASE WHEN s.quiz_id IS NOT NULL THEN 'quiz' ELSE 'folder' END AS "targetKind",
            coalesce(q.title, f.name)                AS "targetName",
            coalesce(qu.username, fu.username)       AS "ownerName",
            g.name                                   AS "groupName",
            s.created_at                             AS "createdAt"
       FROM shares s
       LEFT JOIN quizzes q  ON q.id = s.quiz_id
       LEFT JOIN users qu   ON qu.id = q.owner_id
       LEFT JOIN folders f  ON f.id = s.folder_id
       LEFT JOIN users fu   ON fu.id = f.owner_id
       LEFT JOIN groups g   ON g.id = s.group_id
      ORDER BY s.created_at DESC`,
  );
}

/** 同じ対象・同じ相手の重複を作らない。 */
export async function createShare(
  target: { kind: 'quiz' | 'folder'; id: string },
  groupId: string | null,
): Promise<string | null> {
  const quizId = target.kind === 'quiz' ? target.id : null;
  const folderId = target.kind === 'folder' ? target.id : null;

  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM shares
      WHERE quiz_id IS NOT DISTINCT FROM $1
        AND folder_id IS NOT DISTINCT FROM $2
        AND group_id IS NOT DISTINCT FROM $3`,
    [quizId, folderId, groupId],
  );
  if (existing) return existing.id;

  const id = randomUUID();
  await query('INSERT INTO shares (id, quiz_id, folder_id, group_id) VALUES ($1, $2, $3, $4)', [
    id,
    quizId,
    folderId,
    groupId,
  ]);
  return id;
}

export async function deleteShare(shareId: string): Promise<boolean> {
  const rows = await query<{ id: string }>('DELETE FROM shares WHERE id = $1 RETURNING id', [
    shareId,
  ]);
  return rows.length > 0;
}
