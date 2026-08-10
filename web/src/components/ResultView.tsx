import type { QuestionMark, QuizAttemptView } from '../types';
import QuestionReview from './QuestionReview';

interface Props {
  attempt: QuizAttemptView;
  onRestart: () => void;
  onNewQuiz: () => void;
  onReviewWrong: () => void;
  onRequestAiExplanation: (questionId: string) => Promise<string>;
  marks: Record<string, QuestionMark>;
  onMark: (questionId: string, mark: QuestionMark | null) => void;
}

export default function ResultView({
  attempt,
  onRestart,
  onNewQuiz,
  onReviewWrong,
  onRequestAiExplanation,
  marks,
  onMark,
}: Props) {
  const { scored, totalScore } = attempt;
  const correct = scored.filter((s) => s.verdict === 'correct').length;
  const partial = scored.filter((s) => s.verdict === 'partial').length;
  const wrong = scored.length - correct;

  return (
    <>
      <section className="card">
        <h2>{attempt.quiz.title}</h2>
        <div className="row between">
          <div>
            <div className="score">{totalScore}</div>
            <div className="stat">100点満点</div>
          </div>
          <div className="stat">
            <div>
              正解 {correct} / {scored.length} 問
            </div>
            {partial > 0 && <div>部分正解 {partial} 問</div>}
          </div>
        </div>
        <div className="actions">
          {wrong > 0 && (
            <button type="button" className="primary" onClick={onReviewWrong}>
              間違えた {wrong} 問を復習
            </button>
          )}
          <button type="button" onClick={onRestart}>
            もう一度全問
          </button>
          <button type="button" onClick={onNewQuiz}>
            別のクイズを作る
          </button>
        </div>
      </section>

      {scored.map((item, i) => (
        <QuestionReview
          key={item.question.id}
          item={item}
          number={i + 1}
          onRequestAiExplanation={onRequestAiExplanation}
          mark={marks[item.question.id] ?? null}
          onMark={onMark}
        />
      ))}
    </>
  );
}
