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

/** 配布されたクイズをまとめる仮想フォルダー。実体は無い。 */
const SHARED = 'shared';

function formatDate(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function FolderIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6Z" />
    </svg>
  );
}

function QuizIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 2h8l6 6v14H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" />
      <path d="M14 2v6h6" className="fold" />
    </svg>
  );
}

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
  // null = 一番上。フォルダー id か SHARED を入れるとその中を表示する。
  const [current, setCurrent] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const needle = keyword.trim().toLowerCase();
  const matches = (quiz: QuizSummary) =>
    !needle ||
    quiz.title.toLowerCase().includes(needle) ||
    quiz.sourceNames.some((name) => name.toLowerCase().includes(needle));

  const own = quizzes.filter((q) => q.isOwn);
  const shared = quizzes.filter((q) => !q.isOwn);

  // 表示するクイズ。検索中は場所を無視して全体から探す。
  const visible = needle
    ? quizzes.filter(matches)
    : current === null
      ? own.filter((q) => q.folderId === null)
      : current === SHARED
        ? shared
        : own.filter((q) => q.folderId === current);

  const showFolders = !needle && current === null;
  const currentFolder = folders.find((f) => f.id === current);

  const move = (folderId: string | null) => {
    if (dragging) onMove(dragging, folderId);
    setDragging(null);
    setDropTarget(null);
  };

  const dropProps = (key: string, folderId: string | null) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!dragging) return;
      event.preventDefault();
      setDropTarget(key);
    },
    onDragLeave: () => setDropTarget((t) => (t === key ? null : t)),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      move(folderId);
    },
    className: `tile drop${dropTarget === key ? ' over' : ''}`,
  });

  const startRename = (quiz: QuizSummary) => {
    setRenaming(quiz.id);
    setDraft(quiz.title);
  };

  const commitRename = async (quiz: QuizSummary) => {
    const title = draft.trim();
    setRenaming(null);
    if (title && title !== quiz.title) await onRename(quiz.id, title);
  };

  return (
    <section className="card">
      {/* パンくず。フォルダーの外に出したいときはここへドロップする */}
      <div className="row between">
        <div className="row tight crumbs">
          <button
            type="button"
            className={`crumb${dropTarget === 'root' ? ' over' : ''}`}
            onDragOver={(event) => {
              if (!dragging) return;
              event.preventDefault();
              setDropTarget('root');
            }}
            onDragLeave={() => setDropTarget((t) => (t === 'root' ? null : t))}
            onDrop={(event) => {
              event.preventDefault();
              move(null);
            }}
            onClick={() => setCurrent(null)}
          >
            クイズ
          </button>
          {current === SHARED && <span className="crumb-sep">／ 配布されたクイズ</span>}
          {currentFolder && <span className="crumb-sep">／ {currentFolder.name}</span>}
        </div>
        <span className="stat">{visible.length} 件</span>
      </div>

      <div className="row">
        <input
          type="search"
          value={keyword}
          placeholder="名前・資料名で探す（全体から）"
          aria-label="クイズを検索"
          style={{ flex: '1 1 12rem' }}
          onChange={(event) => setKeyword(event.target.value)}
        />
        {current === null && !needle && (
          <>
            <input
              type="text"
              className="auto"
              value={newFolder}
              placeholder="新しいフォルダー"
              aria-label="新しいフォルダー名"
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
          </>
        )}
        {currentFolder && (
          <button
            type="button"
            className="link"
            onClick={() => {
              const ok = window.confirm(
                `フォルダー「${currentFolder.name}」を削除します。中のクイズは未分類に戻るだけで消えません。`,
              );
              if (ok) {
                onDeleteFolder(currentFolder.id);
                setCurrent(null);
              }
            }}
          >
            このフォルダーを削除
          </button>
        )}
      </div>

      {dragging && <p className="stat">フォルダーへドラッグすると移動します。</p>}

      <div className="explorer">
        {showFolders &&
          folders.map((folder) => (
            <div
              key={folder.id}
              {...dropProps(folder.id, folder.id)}
              onDoubleClick={() => setCurrent(folder.id)}
            >
              <button type="button" className="tile-main" onClick={() => setCurrent(folder.id)}>
                <FolderIcon />
                <span className="tile-name">{folder.name}</span>
                <span className="tile-meta">
                  {folder.quizCount} 件{folder.shared && '・配布中'}
                </span>
              </button>
            </div>
          ))}

        {showFolders && shared.length > 0 && (
          <div className="tile">
            <button type="button" className="tile-main" onClick={() => setCurrent(SHARED)}>
              <FolderIcon />
              <span className="tile-name">配布されたクイズ</span>
              <span className="tile-meta">{shared.length} 件</span>
            </button>
          </div>
        )}

        {visible.map((quiz) => (
          <div
            key={quiz.id}
            className={`tile${dragging === quiz.id ? ' dragging' : ''}`}
            draggable={quiz.isOwn && renaming !== quiz.id}
            onDragStart={() => setDragging(quiz.id)}
            onDragEnd={() => {
              setDragging(null);
              setDropTarget(null);
            }}
            onDoubleClick={() => onOpen(quiz.id)}
          >
            {renaming === quiz.id ? (
              <input
                type="text"
                value={draft}
                autoFocus
                maxLength={120}
                aria-label="クイズの名前"
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => void commitRename(quiz)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void commitRename(quiz);
                  if (event.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <button type="button" className="tile-main" onClick={() => onOpen(quiz.id)}>
                <QuizIcon />
                <span className="tile-name">{quiz.title}</span>
                <span className="tile-meta">
                  {quiz.questionCount}問
                  {quiz.weakCount > 0 && `・苦手${quiz.weakCount}`}
                  {!quiz.isOwn && `・${quiz.ownerName}`}
                </span>
                <span className="tile-meta">{formatDate(quiz.createdAt)}</span>
              </button>
            )}

            <div className="tile-actions">
              {quiz.weakCount > 0 && (
                <button type="button" className="link" onClick={() => onReview(quiz.id)}>
                  復習
                </button>
              )}
              <button type="button" className="link" onClick={() => onHistory(quiz)}>
                履歴
              </button>
              {quiz.isOwn && (
                <>
                  <button type="button" className="link" onClick={() => startRename(quiz)}>
                    名前
                  </button>
                  <button type="button" className="link" onClick={() => onDelete(quiz.id)}>
                    削除
                  </button>
                </>
              )}
            </div>
          </div>
        ))}

        {visible.length === 0 && !showFolders && <p className="muted">ここには何もありません。</p>}
        {visible.length === 0 && showFolders && folders.length === 0 && shared.length === 0 && (
          <p className="muted">まだクイズがありません。</p>
        )}
      </div>
    </section>
  );
}
