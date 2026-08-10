import { parseCloze } from '../cloze';
import type { Question } from '../types';

interface Props {
  question: Question;
  /** 空欄ごとの入力値 */
  values: string[];
  onChange?: (index: number, value: string) => void;
  /** 答え合わせ後は入力を閉じ、正誤と正解を表示する */
  blankResults?: boolean[];
  readOnly?: boolean;
}

/** 問題文中に入力欄を埋め込んで表示する。 */
export default function ClozeQuestion({
  question,
  values,
  onChange,
  blankResults,
  readOnly = false,
}: Props) {
  const segments = parseCloze(question.question);

  return (
    <p className="question-text cloze">
      {segments.map((segment, i) => {
        if (segment.kind === 'text') {
          return <span key={`t-${i}`}>{segment.text}</span>;
        }

        const value = values[segment.index] ?? '';
        const ok = blankResults?.[segment.index];
        const expected = question.blanks?.[segment.index]?.answers[0];

        if (readOnly) {
          const mark = ok === undefined ? '' : ok ? ' ok' : ' ng';
          return (
            <span key={`b-${i}`} className="cloze-blank">
              <span className="cloze-index">{segment.index + 1}</span>
              <span className={`cloze-filled${mark}`}>{value.trim() || '空欄'}</span>
              {ok === false && expected && <span className="cloze-expected">正解 {expected}</span>}
            </span>
          );
        }

        return (
          <span key={`b-${i}`} className="cloze-blank">
            <span className="cloze-index">{segment.index + 1}</span>
            <input
              type="text"
              className="cloze-input"
              value={value}
              aria-label={`空欄 ${segment.index + 1}`}
              onChange={(event) => onChange?.(segment.index, event.target.value)}
            />
          </span>
        );
      })}
    </p>
  );
}
