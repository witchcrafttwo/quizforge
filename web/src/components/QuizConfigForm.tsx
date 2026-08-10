import { useEffect, useId } from 'react';
import { DIFFICULTY_LABEL, QUESTION_TYPES, TYPE_LABEL, allocate, buildPlan } from '../plan';
import type { Difficulty, DifficultyRatio, QuestionType, QuizConfig, TypeRatio } from '../types';

interface Props {
  config: QuizConfig;
  onChange: (config: QuizConfig) => void;
  /** プランの出題数上限。0 は無制限として 50 まで。 */
  maxQuestions?: number;
}

const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

const PRESETS: { label: string; ratio: DifficultyRatio }[] = [
  { label: '基礎固め', ratio: { easy: 60, medium: 30, hard: 10 } },
  { label: 'バランス', ratio: { easy: 30, medium: 50, hard: 20 } },
  { label: '試験対策', ratio: { easy: 10, medium: 40, hard: 50 } },
];

/**
 * 総数を保ったまま1問だけ移動する。
 * +1 は最も多い他の枠から奪い、-1 は最も多い他の枠へ渡す。
 */
function transfer<K extends string>(
  counts: Record<K, number>,
  key: K,
  delta: 1 | -1,
): Record<K, number> {
  const others = (Object.keys(counts) as K[]).filter((k) => k !== key);
  const largest = others.reduce(
    (best, k) => (best === null || counts[k] > counts[best] ? k : best),
    null as K | null,
  );
  if (largest === null) return counts;

  if (delta === 1) {
    if (counts[largest] <= 0) return counts;
    return { ...counts, [key]: counts[key] + 1, [largest]: counts[largest] - 1 };
  }
  if (counts[key] <= 0) return counts;
  return { ...counts, [key]: counts[key] - 1, [largest]: counts[largest] + 1 };
}

interface StepperProps {
  label: string;
  badgeClass?: string;
  value: number;
  canDecrease: boolean;
  canIncrease: boolean;
  onStep: (delta: 1 | -1) => void;
}

function Stepper({ label, badgeClass, value, canDecrease, canIncrease, onStep }: StepperProps) {
  return (
    <div className="stepper">
      {badgeClass ? (
        <span className={`badge ${badgeClass}`}>{label}</span>
      ) : (
        <span className="name">{label}</span>
      )}
      <span className="row tight fixed">
        <button
          type="button"
          className="step"
          aria-label={`${label} を1問減らす`}
          disabled={!canDecrease}
          onClick={() => onStep(-1)}
        >
          −
        </button>
        <span className="step-value">{value}</span>
        <button
          type="button"
          className="step"
          aria-label={`${label} を1問増やす`}
          disabled={!canIncrease}
          onClick={() => onStep(1)}
        >
          ＋
        </button>
      </span>
    </div>
  );
}

export default function QuizConfigForm({ config, onChange, maxQuestions = 50 }: Props) {
  const countId = useId();
  const focusId = useId();
  const langId = useId();

  const ceiling = maxQuestions > 0 ? Math.min(50, maxQuestions) : 50;
  const total = Math.min(config.questionCount, ceiling);

  useEffect(() => {
    if (config.questionCount > ceiling) onChange({ ...config, questionCount: ceiling });
  }, [ceiling, config, onChange]);

  // 保存されている比率を実際の問題数に落として表示する。
  const typeCounts = allocate(total, config.typeRatio) as TypeRatio;
  const difficultyCounts = allocate(total, config.difficultyRatio) as DifficultyRatio;

  const stepType = (key: QuestionType, delta: 1 | -1) => {
    onChange({ ...config, typeRatio: transfer(typeCounts, key, delta) as TypeRatio });
  };

  const stepDifficulty = (key: Difficulty, delta: 1 | -1) => {
    onChange({
      ...config,
      difficultyRatio: transfer(difficultyCounts, key, delta) as DifficultyRatio,
    });
  };

  const plan = buildPlan(config);

  return (
    <section className="card">
      <h2>出題設定</h2>

      <div className="grid-2">
        <div>
          <label htmlFor={countId}>
            問題数 {total}
            {ceiling < 50 && `（上限 ${ceiling}）`}
          </label>
          <input
            id={countId}
            type="range"
            min={1}
            max={ceiling}
            value={total}
            onChange={(event) => onChange({ ...config, questionCount: Number(event.target.value) })}
          />
        </div>

        <div>
          <label htmlFor={langId}>言語</label>
          <select
            id={langId}
            value={config.language}
            onChange={(event) =>
              onChange({ ...config, language: event.target.value as QuizConfig['language'] })
            }
          >
            <option value="ja">日本語</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>

      <div className="fieldset">
        <label>形式</label>
        {QUESTION_TYPES.map((key) => (
          <Stepper
            key={key}
            label={TYPE_LABEL[key]}
            value={typeCounts[key]}
            canDecrease={typeCounts[key] > 0}
            canIncrease={QUESTION_TYPES.some((k) => k !== key && typeCounts[k] > 0)}
            onStep={(delta) => stepType(key, delta)}
          />
        ))}
        <div className="row tight" style={{ marginTop: '0.5rem' }}>
          {QUESTION_TYPES.map((only) => (
            <button
              key={only}
              type="button"
              className="link"
              onClick={() =>
                onChange({
                  ...config,
                  typeRatio: {
                    multiple_choice: only === 'multiple_choice' ? total : 0,
                    multi_select: only === 'multi_select' ? total : 0,
                    short_answer: only === 'short_answer' ? total : 0,
                    cloze: only === 'cloze' ? total : 0,
                  },
                })
              }
            >
              {TYPE_LABEL[only]}だけ
            </button>
          ))}
        </div>
      </div>

      <div className="fieldset">
        <label>難易度</label>
        {DIFFICULTIES.map((key) => (
          <Stepper
            key={key}
            label={DIFFICULTY_LABEL[key]}
            badgeClass={key}
            value={difficultyCounts[key]}
            canDecrease={difficultyCounts[key] > 0}
            canIncrease={DIFFICULTIES.some((k) => k !== key && difficultyCounts[k] > 0)}
            onStep={(delta) => stepDifficulty(key, delta)}
          />
        ))}
        <div className="row tight" style={{ marginTop: '0.5rem' }}>
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="link"
              onClick={() => onChange({ ...config, difficultyRatio: preset.ratio })}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label htmlFor={focusId}>出題範囲・観点</label>
        <textarea
          id={focusId}
          className="short"
          value={config.focus ?? ''}
          onChange={(event) => onChange({ ...config, focus: event.target.value })}
          placeholder="第3章の需給曲線に絞る、計算問題を含める、など"
        />
      </div>

      <ul className="plan" style={{ marginTop: '1rem' }}>
        {plan.map((cell) => (
          <li key={`${cell.type}-${cell.difficulty}`}>
            <span className={`badge ${cell.difficulty}`}>
              {TYPE_LABEL[cell.type]}・{DIFFICULTY_LABEL[cell.difficulty]} {cell.count}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
