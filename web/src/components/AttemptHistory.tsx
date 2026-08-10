import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import type {
  AttemptDetail,
  AttemptSummary,
  QuestionMark,
  QuizSummary,
  ScoredQuestion,
} from '../types';
import QuestionReview from './QuestionReview';

interface Props {
  quiz: QuizSummary;
  onClose: () => void;
  onReview: () => void;
  onMark: (questionId: string, mark: QuestionMark | null) => void;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 保存済みの解答から、振り返り表示用の形に組み直す。 */
function toScored(detail: AttemptDetail): ScoredQuestion[] {
  const byId = new Map(detail.results.map((r) => [r.questionId, r]));
  return detail.quiz.questions.map((question) => {
    const result = byId.get(question.id);
    return {
      question,
      answer: detail.answers[question.id],
      score: result?.score ?? 0,
      verdict: result?.verdict ?? 'incorrect',
      feedback: result?.feedback,
      ...(result?.blankResults ? { blankResults: result.blankResults } : {}),
    };
  });
}

export default function AttemptHistory({ quiz, onClose, onReview, onMark }: Props) {
  const [attempts, setAttempts] = useState<AttemptSummary[]>([]);
  const [detail, setDetail] = useState<AttemptDetail | null>(null);
  const [localMarks, setLocalMarks] = useState<Record<string, QuestionMark | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listAttempts(quiz.id)
      .then(setAttempts)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setLoading(false));
  }, [quiz.id]);

  useEffect(load, [load]);

  const openDetail = async (attemptId: string) => {
    setError(null);
    try {
      setDetail(await api.getAttempt(attemptId));
      window.scrollTo({ top: 0 });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (detail) {
    const scored = toScored(detail);
    return (
      <>
        <section className="card">
          <div className="row between">
            <h2 className="tight">{formatDateTime(detail.completedAt)} の結果</h2>
            <button type="button" className="link" onClick={() => setDetail(null)}>
              履歴へ戻る
            </button>
          </div>
          <div className="row between">
            <div>
              <div className="score">{detail.totalScore ?? 0}</div>
              <div className="stat">
                {detail.mode === 'review' ? '復習' : '全問'} {scored.length} 問
              </div>
            </div>
          </div>
        </section>

        {scored.map((item, i) => (
          <QuestionReview
            key={item.question.id}
            item={item}
            number={i + 1}
            mark={
              item.question.id in localMarks
                ? localMarks[item.question.id]
                : (detail.marks[item.question.id] ?? null)
            }
            onMark={(questionId, mark) => {
              setLocalMarks((prev) => ({ ...prev, [questionId]: mark }));
              onMark(questionId, mark);
            }}
          />
        ))}
      </>
    );
  }

  return (
    <section className="card">
      <div className="row between">
        <h2 className="tight">{quiz.title}</h2>
        <button type="button" className="link" onClick={onClose}>
          閉じる
        </button>
      </div>

      <p className="stat">
        {quiz.questionCount} 問、{quiz.attemptCount} 回挑戦
        {quiz.weakCount > 0 && `、苦手 ${quiz.weakCount} 問`}
      </p>

      {quiz.weakCount > 0 && (
        <div className="actions">
          <button type="button" className="primary" onClick={onReview}>
            苦手な {quiz.weakCount} 問を復習
          </button>
        </div>
      )}

      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}

      {loading && <p className="muted">読み込み中</p>}

      {!loading && attempts.length === 0 && <p className="muted">まだ挑戦の記録がありません。</p>}

      {attempts.length > 0 && (
        <ul className="rows">
          {attempts.map((attempt) => (
            <li key={attempt.id}>
              <div className="grow">
                <div className="row tight">
                  <span>{attempt.totalScore ?? 0} 点</span>
                  {attempt.mode === 'review' && <span className="badge">復習</span>}
                </div>
                <div className="stat">
                  {formatDateTime(attempt.completedAt)}、正解 {attempt.correctCount} /{' '}
                  {attempt.questionCount}
                </div>
              </div>
              <button type="button" className="fixed" onClick={() => void openDetail(attempt.id)}>
                内容を見る
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
