import { useId, useRef, useState } from 'react';

export const ACCEPTED = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.md,.html,.png,.jpg,.jpeg,.gif,.webp';

interface Props {
  files: File[];
  onFilesChange: (files: File[]) => void;
  text: string;
  onTextChange: (text: string) => void;
  /** プランの上限。0 は無制限。サーバでも同じ判定をする。 */
  maxFiles?: number;
  maxTotalMb?: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function UploadPanel({
  files,
  onFilesChange,
  text,
  onTextChange,
  maxFiles = 0,
  maxTotalMb = 0,
}: Props) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const textId = useId();

  const add = (incoming: FileList | null) => {
    if (!incoming) return;
    const merged = [...files];
    for (const file of Array.from(incoming)) {
      if (maxFiles > 0 && merged.length >= maxFiles) break;
      if (!merged.some((f) => f.name === file.name && f.size === file.size)) merged.push(file);
    }
    onFilesChange(merged);
  };

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const overLimit =
    (maxFiles > 0 && files.length > maxFiles) ||
    (maxTotalMb > 0 && totalBytes > maxTotalMb * 1024 * 1024);

  return (
    <section className="card">
      <h2>授業資料</h2>

      <div
        className={`dropzone${over ? ' over' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          add(event.dataTransfer.files);
        }}
      >
        <p>PDF、Word、Excel、テキスト、板書の写真</p>
        <button type="button" onClick={() => inputRef.current?.click()}>
          ファイルを選ぶ
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          multiple
          hidden
          onChange={(event) => {
            add(event.target.files);
            event.target.value = '';
          }}
        />
      </div>

      {files.length > 0 && (
        <>
          <div className="explorer">
            {files.map((file) => (
              <div key={`${file.name}-${file.size}`} className="ex-row files">
                <span className="ex-name">
                  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 2h8l6 6v14H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" />
                    <path d="M14 2v6h6" className="fold" />
                  </svg>
                  <span className="ex-text">{file.name}</span>
                </span>
                <span className="ex-col">{formatSize(file.size)}</span>
                <span className="ex-actions">
                  <button
                    type="button"
                    className="link"
                    aria-label={`${file.name} を削除`}
                    onClick={() => onFilesChange(files.filter((f) => f !== file))}
                  >
                    削除
                  </button>
                </span>
              </div>
            ))}
          </div>
          <p className={overLimit ? 'stat bad-text' : 'stat'}>
            {files.length}
            {maxFiles > 0 && ` / ${maxFiles}`} 件、{formatSize(totalBytes)}
            {maxTotalMb > 0 && ` / ${maxTotalMb}MB`}
            {overLimit && '（プランの上限超過）'}
          </p>
        </>
      )}

      <div className="field">
        <label htmlFor={textId}>テキストを貼り付け</label>
        <textarea
          id={textId}
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
        />
      </div>
    </section>
  );
}
