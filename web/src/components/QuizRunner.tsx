import { useState } from 'react';
import { countBlanks } from '../cloze';
import { DIFFICULTY_LABEL, TYPE_LABEL } from '../plan';
import type {
  AnswerMap,
  AnswerValue,
  GradeResult,
  Question,
  QuestionMark,
  Quiz,
  ScoredQuestion,
} from '../types';
import ClozeQuestion from './ClozeQuestion';
import QuestionReview from './QuestionReview';
import RichText from './RichText';

interface Props {
  quiz: Quiz;
  /** 1問分の解答をサーバへ送り、採点結果を受け取る。失敗なら null。 */
  onSubmitAnswer: (question: Question, response: AnswerValue) => Promise<GradeResult | null>;
  onComplete: (scored: ScoredQuestion[], answers: AnswerMap) => void;
  onAbort: () => void;
  onRequestAiExplanation: (questionId: string) => Promise<string>;
  /**
   * 不適切な問題を捨てる。資料が手元にあれば新しい1問に差し替え、
   * 無ければ削除だけする。差し替えられたかを返す。
   */
  onDiscardQuestion: (questionId: string) => Promise<'replaced' | 'deleted'>;
  /** 資料が手元にあるか（差し替えできるか） */
  canReplace: boolean;
  marks: Record<string, QuestionMark>;
  onMark: (questionId: string, mark: QuestionMark | null) => void;
}

const KEYS = ['A', 'B', 'C', 'D', 'E'];

function blankCountOf(question: Question): number {
  return question.blanks?.length ?? countBlanks(question.question);
}

export default function QuizRunner({
  quiz,
  onSubmitAnswer,
  onComplete,
  onAbort,
  onRequestAiExplanation,
  onDiscardQuestion,
  canReplace,
  marks,
  onMark,
}: Props) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [scored, setScored] = useState<Record<string, ScoredQuestion>>({});
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const question = quiz.questions[index];
  if (!question) return null;

  const total = quiz.questions.length;
  const isLast = index === total - 1;
  const current = answers[question.id];
  const revealed = scored[question.id];

  const clozeValues = Array.isArray(current) ? (current as string[]) : [];
  const selected = Array.isArray(current) ? (current as number[]) : [];

  const setAnswer = (value: AnswerValue) => {
    setAnswers((prev) => ({ ...prev, [question.id]: value }));
  };

  const setBlank = (blankIndex: number, value: string) => {
    const next = [...clozeValues];
    while (next.length < blankCountOf(question)) next.push('');
    next[blankIndex] = value;
    setAnswer(next);
  };

  const toggleSelected = (target: number) => {
    setAnswer(
      selected.includes(target)
        ? selected.filter((i) => i !== target)
        : [...selected, target].sort((a, b) => a - b),
    );
  };

  const handleAnswer = async () => {
    setError(null);
    setBusy(true);
    try {
      const response: AnswerValue =
        question.type === 'cloze'
          ? Array.from({ length: blankCountOf(question) }, (_, i) => clozeValues[i] ?? '')
          : question.type === 'multi_select'
            ? selected
            : (current as AnswerValue);

      const grade = await onSubmitAnswer(question, response);
      setScored((prev) => ({
        ...prev,
        [question.id]: {
          question,
          answer: response,
          score: grade?.score ?? 0,
          verdict: grade?.verdict ?? 'incorrect',
          feedback: grade?.feedback,
          ...(grade?.blankResults ? { blankResults: grade.blankResults } : {}),
        },
      }));
      if (!grade) setError('採点できませんでした。解説を読んで自己採点してください。');
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async () => {
    setError(null);
    setDiscarding(true);
    try {
      const result = await onDiscardQuestion(question.id);
      // この問題への入力と採点結果は無効になるので捨てる。
      setAnswers((prev) => {
        const { [question.id]: _drop, ...rest } = prev;
        return rest;
      });
      setScored((prev) => {
        const { [question.id]: _drop, ...rest } = prev;
        return rest;
      });
      // 削除の場合は問題数が減るので、末尾にいたら1つ前へ戻る。
      if (result === 'deleted' && index >= quiz.questions.length - 1) {
        setIndex((i) => Math.max(0, i - 1));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiscarding(false);
    }
  };

  const handleNext = () => {
    if (!isLast) {
      setIndex((i) => i + 1);
      setError(null);
      return;
    }
    const ordered = quiz.questions.map(
      (q): ScoredQuestion =>
        scored[q.id] ?? {
          question: q,
          answer: answers[q.id],
          score: 0,
          verdict: 'incorrect',
        },
    );
    onComplete(ordered, answers);
  };

  const canAnswer = (() => {
    if (busy) return false;
    if (question.type === 'multiple_choice') return typeof current === 'number';
    if (question.type === 'multi_select') return selected.length > 0;
    if (question.type === 'cloze') {
      const need = blankCountOf(question);
      return Array.from({ length: need }, (_, i) => clozeValues[i] ?? '').every((v) => v.trim());
    }
    return typeof current === 'string' && current.trim().length > 0;
  })();

  return (
    <section className="card">
      <div className="progress" aria-hidden="true">
        <div style={{ width: `${((index + 1) / total) * 100}%` }} />
      </div>

      <div className="row between">
        <span className="stat">
          {index + 1} / {total}
        </span>
        <span className="row tight">
          <span className="badge">{TYPE_LABEL[question.type]}</span>
          <span className={`badge ${question.difficulty}`}>
            {DIFFICULTY_LABEL[question.difficulty]}
          </span>
        </span>
      </div>

      {question.type === 'cloze'
        ? !revealed && (
            <ClozeQuestion question={question} values={clozeValues} onChange={setBlank} />
          )
        : <RichText text={question.question} className="question-text" />}

      {question.type === 'multiple_choice' && !revealed && (
        <div className="choices" role="group" aria-label="選択肢">
          {(question.choices ?? []).map((choice, i) => (
            <button
              key={choice}
              type="button"
              className="choice"
              aria-pressed={current === i}
              onClick={() => setAnswer(i)}
            >
              <span className="key" aria-hidden="true">
                {KEYS[i]}
              </span>
              <span className="body">
                <RichText text={choice} />
              </span>
            </button>
          ))}
        </div>
      )}

      {question.type === 'multi_select' && !revealed && (
        <div className="choices" role="group" aria-label="選択肢（複数選択）">
          {(question.choices ?? []).map((choice, i) => (
            <button
              key={choice}
              type="button"
              className="choice"
              aria-pressed={selected.includes(i)}
              onClick={() => toggleSelected(i)}
            >
              <span className="key box" aria-hidden="true">
                {selected.includes(i) ? '✓' : KEYS[i]}
              </span>
              <span className="body">
                <RichText text={choice} />
              </span>
            </button>
          ))}
        </div>
      )}

      {question.type === 'short_answer' && !revealed && (
        <div className="field" style={{ marginTop: '1rem' }}>
          <textarea
            aria-label="解答"
            value={typeof current === 'string' ? current : ''}
            onChange={(event) => setAnswer(event.target.value)}
          />
        </div>
      )}

      {revealed && (
        <QuestionReview
          key={question.id}
          item={revealed}
          number={index + 1}
          showQuestionText={false}
          boxed={false}
          onRequestAiExplanation={onRequestAiExplanation}
          mark={marks[question.id] ?? null}
          onMark={onMark}
        />
      )}

      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}

      <div className="actions between">
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setIndex((i) => Math.max(0, i - 1));
            setError(null);
          }}
          disabled={index === 0}
        >
          戻る
        </button>

        {revealed ? (
          <button type="button" className="primary" onClick={handleNext}>
            {isLast ? '結果' : '次へ'}
          </button>
        ) : (
          <button type="button" className="primary" onClick={handleAnswer} disabled={!canAnswer}>
            {busy ? (
              <span className="row tight">
                <span className="spinner" /> 採点中
              </span>
            ) : (
              '解答'
            )}
          </button>
        )}
      </div>

      <div className="actions center">
        <button type="button" className="link" onClick={() => void handleDiscard()} disabled={discarding}>
          {discarding
            ? canReplace
              ? '差し替え中'
              : '削除中'
            : canReplace
              ? 'この問題を差し替える'
              : 'この問題を削除する'}
        </button>
        <button type="button" className="link" onClick={onAbort}>
          中断
        </button>
      </div>
    </section>
  );
}
