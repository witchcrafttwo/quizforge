import { useState } from 'react';
import type { Folder } from '../api';
import type { QuizSummary } from '../types';

interface Props {
  quizzes: QuizSummary[];
  folders: Folder[];
  onOpen: (id: string) => void;
  onReview: (id: string) => void;
  onHistory: (quiz: QuizSummary) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onMove: (quizId: string, folderId: string | null) => void;
  onCreateFolder: (name: string) => void;
  onDeleteFolder: (id: string) => void;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function QuizRow({
  quiz,
  folders,
  onOpen,
  onReview,
  onHistory,
  onDelete,
  onRename,
  onMove,
}: {
  quiz: QuizSummary;
  folders: Folder[];
  onOpen: Props['onOpen'];
  onReview: Props['onReview'];
  onHistory: Props['onHistory'];
  onDelete: Props['onDelete'];
  onRename: Props['onRename'];
  onMove: Props['onMove'];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(quiz.title);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const title = draft.trim();
    if (!title || title === quiz.title) {
      setEditing(false);
      setDraft(quiz.title);
      return;
    }
    setSaving(true);
    try {
      await onRename(quiz.id, title);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setEditing(false);
    setDraft(quiz.title);
  };

  if (editing) {
    return (
      <li>
        <input
          type="text"
          value={draft}
          maxLength={120}
          autoFocus
          aria-label="クイズの名前"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save();
            if (event.key === 'Escape') cancel();
          }}
        />
        <span className="row tight fixed">
          <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
            保存
          </button>
          <button type="button" className="link" onClick={cancel}>
            取消
          </button>
        </span>
      </li>
    );
  }

  return (
    <li>
      <div className="grow">
        <div>{quiz.title}</div>
        <div className="stat">
          {!quiz.isOwn && `${quiz.ownerName}、`}
          {formatDate(quiz.createdAt)}、{quiz.questionCount}問
          {quiz.attemptCount > 0 &&
            `、${quiz.attemptCount}回挑戦（最高 ${quiz.bestScore} / 直近 ${quiz.lastScore}）`}
          {quiz.weakCount > 0 && `、苦手 ${quiz.weakCount}問`}
        </div>
      </div>
      <span className="row tight fixed">
        <button type="button" onClick={() => onOpen(quiz.id)}>
          解く
        </button>
        {quiz.weakCount > 0 && (
          <button type="button" onClick={() => onReview(quiz.id)}>
            復習 {quiz.weakCount}
          </button>
        )}
        <button type="button" className="link" onClick={() => onHistory(quiz)}>
          履歴
        </button>
        {/* 配布されたクイズは作成者だけが名前変更・削除・移動できる */}
        {quiz.isOwn && folders.length > 0 && (
          <select
            className="auto"
            value={quiz.folderId ?? ''}
            aria-label={`${quiz.title} のフォルダー`}
            onChange={(event) => onMove(quiz.id, event.target.value || null)}
          >
            <option value="">未分類</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
        )}
        {quiz.isOwn && (
          <>
            <button
              type="button"
              className="link"
              aria-label={`${quiz.title} の名前を変更`}
              onClick={() => setEditing(true)}
            >
              名前
            </button>
            <button
              type="button"
              className="link"
              aria-label={`${quiz.title} を削除`}
              onClick={() => onDelete(quiz.id)}
            >
              削除
            </button>
          </>
        )}
      </span>
    </li>
  );
}

type SortKey = 'new' | 'name' | 'score';

export default function HistoryList({
  quizzes,
  folders,
  onOpen,
  onReview,
  onHistory,
  onDelete,
  onRename,
  onMove,
  onCreateFolder,
  onDeleteFolder,
}: Props) {
  const [keyword, setKeyword] = useState('');
  const [sort, setSort] = useState<SortKey>('new');
  // null = すべて、'' = 未分類、それ以外はフォルダー id
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState('');

  if (quizzes.length === 0) {
    return (
      <section className="card">
        <h2>クイズ</h2>
        <p className="muted">まだありません。</p>
      </section>
    );
  }

  const needle = keyword.trim().toLowerCase();
  const sorted = quizzes
    .filter(
      (quiz) =>
        !needle ||
        quiz.title.toLowerCase().includes(needle) ||
        quiz.sourceNames.some((name) => name.toLowerCase().includes(needle)),
    )
    .filter((quiz) => folderFilter === null || (quiz.folderId ?? '') === folderFilter)
    .sort((a, b) => {
      if (sort === 'name') return a.title.localeCompare(b.title, 'ja');
      if (sort === 'score') return (b.bestScore ?? -1) - (a.bestScore ?? -1);
      return b.createdAt.localeCompare(a.createdAt);
    });

  return (
    <section className="card">
      <div className="row between">
        <h2 className="tight">クイズ</h2>
        <span className="stat">{quizzes.length} 件</span>
      </div>

      <div className="row">
        <input
          type="search"
          value={keyword}
          placeholder="名前・資料名で絞り込む"
          aria-label="クイズを検索"
          style={{ flex: '1 1 12rem' }}
          onChange={(event) => setKeyword(event.target.value)}
        />
        <select
          className="auto"
          value={sort}
          aria-label="並び順"
          onChange={(event) => setSort(event.target.value as SortKey)}
        >
          <option value="new">新しい順</option>
          <option value="name">名前順</option>
          <option value="score">最高点順</option>
        </select>
      </div>

      <div className="row tight">
        <button
          type="button"
          className={folderFilter === null ? 'primary' : 'ghost'}
          onClick={() => setFolderFilter(null)}
        >
          すべて
        </button>
        <button
          type="button"
          className={folderFilter === '' ? 'primary' : 'ghost'}
          onClick={() => setFolderFilter('')}
        >
          未分類
        </button>
        {folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            className={folderFilter === folder.id ? 'primary' : 'ghost'}
            onClick={() => setFolderFilter(folder.id)}
          >
            {folder.name} {folder.quizCount}
            {folder.shared && ' ・配布中'}
          </button>
        ))}
      </div>

      <div className="row tight">
        <input
          type="text"
          value={newFolder}
          placeholder="新しいフォルダー名"
          aria-label="新しいフォルダー名"
          style={{ flex: '1 1 10rem' }}
          onChange={(event) => setNewFolder(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && newFolder.trim()) {
              onCreateFolder(newFolder.trim());
              setNewFolder('');
            }
          }}
        />
        <button
          type="button"
          disabled={!newFolder.trim()}
          onClick={() => {
            onCreateFolder(newFolder.trim());
            setNewFolder('');
          }}
        >
          作成
        </button>
        {folderFilter && folderFilter !== '' && (
          <button
            type="button"
            className="link"
            onClick={() => {
              const folder = folders.find((f) => f.id === folderFilter);
              if (!folder) return;
              const ok = window.confirm(
                `フォルダー「${folder.name}」を削除します。中のクイズは未分類に戻るだけで消えません。続けますか？`,
              );
              if (ok) {
                onDeleteFolder(folder.id);
                setFolderFilter(null);
              }
            }}
          >
            このフォルダーを削除
          </button>
        )}
      </div>

      {sorted.length === 0 && <p className="muted">該当なし</p>}

      {/* 配布されたクイズは自分のものと混ざると分かりにくいので分けて出す */}
      {[
        { label: '自分のクイズ', items: sorted.filter((q) => q.isOwn) },
        { label: '配布されたクイズ', items: sorted.filter((q) => !q.isOwn) },
      ]
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <div key={group.label}>
            <label>
              {group.label} {group.items.length}
            </label>
            <ul className="rows">
              {group.items.map((quiz) => (
                <QuizRow
                  key={quiz.id}
                  quiz={quiz}
                  folders={folders}
                  onOpen={onOpen}
                  onReview={onReview}
                  onHistory={onHistory}
                  onDelete={onDelete}
                  onRename={onRename}
                  onMove={onMove}
                />
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}
