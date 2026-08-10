// 問題文・選択肢・解説に含まれるコードを整形して表示する。
// 依存を増やさないため、扱うのはフェンス付きコードブロックとインラインコードだけ。

const FENCE = /```([\w+#.-]*)\n?([\s\S]*?)```/g;

interface Props {
  text: string;
  /** 段落タグに付けるクラス */
  className?: string;
}

/** バッククォート1つで囲まれた部分を <code> にする。 */
function inline(text: string, keyPrefix: string) {
  const parts = text.split(/`([^`\n]+)`/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <code key={`${keyPrefix}-c${i}`} className="inline-code">
        {part}
      </code>
    ) : (
      <span key={`${keyPrefix}-t${i}`}>{part}</span>
    ),
  );
}

export default function RichText({ text, className }: Props) {
  const blocks: React.ReactNode[] = [];
  let cursor = 0;
  let index = 0;

  for (const match of text.matchAll(FENCE)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      const before = text.slice(cursor, start);
      if (before.trim()) {
        blocks.push(
          <p key={`p${index}`} className={className}>
            {inline(before.replace(/\n+$/, ''), `p${index}`)}
          </p>,
        );
      }
    }

    const language = match[1] ?? '';
    const code = (match[2] ?? '').replace(/\n$/, '');
    blocks.push(
      <div key={`k${index}`} className="code-block">
        {language && <span className="code-lang">{language}</span>}
        <pre>
          <code>{code}</code>
        </pre>
      </div>,
    );

    cursor = start + match[0].length;
    index += 1;
  }

  if (cursor < text.length) {
    const rest = text.slice(cursor);
    if (rest.trim()) {
      blocks.push(
        <p key={`p${index}`} className={className}>
          {inline(rest, `p${index}`)}
        </p>,
      );
    }
  }

  // フェンスもインラインコードも無い場合は素の段落1つ。
  if (blocks.length === 0) {
    return <p className={className}>{inline(text, 'only')}</p>;
  }

  return <>{blocks}</>;
}
