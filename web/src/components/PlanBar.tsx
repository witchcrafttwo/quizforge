import type { Plan } from '../api';

interface Props {
  plan: Plan;
  usage: { daily: number; monthly: number };
}

const isUnlimited = (value: number) => value <= 0;

const used = (count: number, limit: number) =>
  isUnlimited(limit) ? `${count}` : `${count} / ${limit}`;

/** 現在のプランと使用状況。制限に当たる前に気づけるように出す。 */
export default function PlanBar({ plan, usage }: Props) {
  const ratio = isUnlimited(plan.dailyGenerations)
    ? 0
    : Math.min(1, usage.daily / plan.dailyGenerations);

  const barColor = ratio >= 1 ? 'var(--bad)' : ratio > 0.7 ? 'var(--warn)' : 'var(--accent)';

  return (
    <section className="card">
      <div className="row between">
        <span className="row tight">
          <strong>{plan.name}</strong>
          {plan.priceJpy > 0 && (
            <span className="stat">月額 {plan.priceJpy.toLocaleString()}円</span>
          )}
        </span>
        <span className="stat">
          本日 {used(usage.daily, plan.dailyGenerations)}、30日{' '}
          {used(usage.monthly, plan.monthlyGenerations)}
        </span>
      </div>

      {!isUnlimited(plan.dailyGenerations) && (
        <div className="progress thick" aria-hidden="true">
          <div style={{ width: `${ratio * 100}%`, background: barColor }} />
        </div>
      )}

      <p className="stat">
        1回につき ファイル {isUnlimited(plan.maxFiles) ? '無制限' : `${plan.maxFiles}件`}、合計{' '}
        {isUnlimited(plan.maxTotalMb) ? '無制限' : `${plan.maxTotalMb}MB`}、出題{' '}
        {isUnlimited(plan.maxQuestions) ? '無制限' : `${plan.maxQuestions}問`}
      </p>
    </section>
  );
}
