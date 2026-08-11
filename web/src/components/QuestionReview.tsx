import { useState } from 'react';
import { DIFFICULTY_LABEL, TYPE_LABEL } from '../plan';
import type { QuestionMark, ScoredQuestion, Verdict } from '../types';
import ClozeQuestion from './ClozeQuestion';
import RichText from './RichText';

const KEYS = ['A', 'B', 'C', 'D', 'E'];

const VERDICT_LABEL: Record<Verdict, string> = {
  correct: '正解',
  partial: '部分正解',
  incorrect: '不正解',
};

const VERDICT_CLASS: Record<Verdict, string> = {
  correct: 'verdict correct',
  partial: 'verdict partial',
  incorrect: 'verdict incorrect',
};

interface Props {
  item: ScoredQuestion;
  number: number;
  showQuestionText?: boolean;
  boxed?: boolean;
  /** AI に追加解説を生成させる。未指定ならそのボタンを出さない。 */
  onRequestAiExplanation?: (questionId: string) => Promise<string>;
  /** いまのマーク。未指定なら自動判定に任せている状態。 */
  mark?: QuestionMark | null;
  /** 「完璧」「復習」を保存する。未指定ならボタンを出さない。 */
  onMark?: (questionId: string, mark: QuestionMark | null) => void;
}

export default function QuestionReview({
  item,
  number,
  showQuestionText = true,
  boxed = true,
  onRequestAiExplanation,
  mark = null,
  onMark,
}: Props) {
  const { question, answer } = item;

  // 解説は既定で隠す。押したときだけ出す。
  const [showExplanation, setShowExplanation] = useState(false);
  const [aiExplanation, setAiExplanation] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const requestAi = async () => {
    if (!onRequestAiExplanation) return;
    setAiBusy(true);
    setAiError(null);
    try {
      setAiExplanation(await onRequestAiExplanation(question.id));
    } catch (cause) {
      setAiError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAiBusy(false);
    }
  };

  const isChoice = question.type === 'multiple_choice' || question.type === 'multi_select';
  const noAnswer = answer === undefined || (Array.isArray(answer) && answer.length === 0);

  const body = (
    <>
      <div className="row between">
        <span className="stat">第 {number} 問</span>
        <span className="row tight">
          <span className="badge">{TYPE_LABEL[question.type]}</span>
          <span className={`badge ${question.difficulty}`}>
            {DIFFICULTY_LABEL[question.difficulty]}
          </span>
          <span className={`badge ${VERDICT_CLASS[item.verdict]}`}>
            {VERDICT_LABEL[item.verdict]} {item.score}
          </span>
        </span>
      </div>

      {showQuestionText && question.type !== 'cloze' && (
        <RichText text={question.question} className="question-text" />
      )}

      {question.type === 'cloze' && (
        <ClozeQuestion
          question={question}
          values={Array.isArray(answer) ? answer.map(String) : []}
          blankResults={item.blankResults}
          readOnly
        />
      )}

      {isChoice && (
        <div className="choices">
          {(question.choices ?? []).map((choice, i) => {
            const isAnswer =
              question.type === 'multi_select'
                ? (question.answerIndexes ?? []).includes(i)
                : i === question.answerIndex;
            const isPicked =
              question.type === 'multi_select'
                ? Array.isArray(answer) && (answer as number[]).includes(i)
                : answer === i;
            return (
              <div
                key={choice}
                className={`choice${isAnswer ? ' correct' : isPicked ? ' wrong' : ''}`}
              >
                <span className="key" aria-hidden="true">
                  {KEYS[i]}
                </span>
                <span className="body">
                  <RichText text={choice} />
                  {isAnswer && <span className="mark ok">正解</span>}
                  {isPicked && !isAnswer && <span className="mark ng">選んだ解答</span>}
                </span>
              </div>
            );
          })}
          {noAnswer && <p className="muted">未回答</p>}
        </div>
      )}

      {question.type === 'short_answer' && (
        <div className="answer-block">
          <label>あなたの解答</label>
          <p>{typeof answer === 'string' && answer.trim() ? answer : '未記入'}</p>
          <label>模範解答</label>
          <RichText text={question.answerText ?? ''} />
          {question.keyPoints && question.keyPoints.length > 0 && (
            <>
              <label style={{ marginTop: '0.9rem' }}>採点観点</label>
              <ul>
                {question.keyPoints.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {onMark && (
        <div className="actions">
          <button
            type="button"
            className={mark === 'mastered' ? 'primary' : ''}
            aria-pressed={mark === 'mastered'}
            onClick={() => onMark(question.id, mark === 'mastered' ? null : 'mastered')}
          >
            完璧
          </button>
          <button
            type="button"
            className={mark === 'review' ? 'primary' : ''}
            aria-pressed={mark === 'review'}
            onClick={() => onMark(question.id, mark === 'review' ? null : 'review')}
          >
            復習
          </button>
          <span className="stat">
            {mark === 'mastered'
              ? '復習に出しません'
              : mark === 'review'
                ? '正解しても復習に出します'
                : '未選択なら正誤で判断します'}
          </span>
        </div>
      )}

      <div className="actions">
        <button type="button" onClick={() => setShowExplanation(!showExplanation)}>
          {showExplanation ? '解説を閉じる' : '解説'}
        </button>
        {onRequestAiExplanation && aiExplanation === null && (
          <button type="button" onClick={() => void requestAi()} disabled={aiBusy}>
            {aiBusy ? (
              <span className="row tight">
                <span className="spinner" /> 生成中
              </span>
            ) : (
              'AI解説'
            )}
          </button>
        )}
      </div>

      {showExplanation && (
        <div className="note">
          <RichText text={question.explanation} />
          {question.sourceQuote && <p className="quote">資料より「{question.sourceQuote}」</p>}
        </div>
      )}

      {aiError && (
        <p className="notice" role="alert">
          {aiError}
        </p>
      )}

      {aiExplanation && (
        <div className="note ai">
          <h3>あなたの解答をもとにした解説</h3>
          <RichText text={aiExplanation} />
        </div>
      )}
    </>
  );

  if (!boxed) return body;
  return <div className="card nested">{body}</div>;
}
