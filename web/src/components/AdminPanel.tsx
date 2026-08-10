import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';

interface Props {
  currentUserId: string;
  onClose: () => void;
}

const PERIODS = [1, 7, 30, 90];

type AdminTab = 'overview' | 'users' | 'quizzes' | 'plans' | 'prices';

const ADMIN_TABS: { key: AdminTab; label: string }[] = [
  { key: 'overview', label: '概要' },
  { key: 'users', label: 'ユーザー' },
  { key: 'quizzes', label: '配布' },
  { key: 'plans', label: 'プラン' },
  { key: 'prices', label: '単価' },
];

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function PriceEditor({
  price,
  onSave,
}: {
  price: api.ModelPrice;
  onSave: (input: number, output: number) => Promise<void>;
}) {
  const [input, setInput] = useState(price.inputPer1m);
  const [output, setOutput] = useState(price.outputPer1m);
  const [saving, setSaving] = useState(false);

  return (
    <div className="card nested">
      <div className="row between">
        <strong>{price.modelId}</strong>
        {!price.configured && <span className="badge hard">未設定</span>}
      </div>

      <div className="grid-2">
        <div>
          <label htmlFor={`in-${price.modelId}`}>入力 $ / 1M</label>
          <input
            id={`in-${price.modelId}`}
            type="number"
            min={0}
            step={0.001}
            value={input}
            onChange={(event) => setInput(Number(event.target.value))}
          />
        </div>
        <div>
          <label htmlFor={`out-${price.modelId}`}>出力 $ / 1M</label>
          <input
            id={`out-${price.modelId}`}
            type="number"
            min={0}
            step={0.001}
            value={output}
            onChange={(event) => setOutput(Number(event.target.value))}
          />
        </div>
      </div>

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(input, output);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? '保存中' : '保存'}
        </button>
      </div>
    </div>
  );
}

type PlanValues = Omit<api.Plan, 'id' | 'sortOrder'>;

const PLAN_FIELDS: { key: keyof PlanValues; label: string; step?: number }[] = [
  { key: 'priceJpy', label: '月額（円）' },
  { key: 'maxFiles', label: 'ファイル数' },
  { key: 'maxFileMb', label: '1ファイル MB', step: 0.5 },
  { key: 'maxTotalMb', label: '合計 MB' },
  { key: 'maxQuestions', label: '最大出題数' },
  { key: 'dailyGenerations', label: '1日の作成' },
  { key: 'monthlyGenerations', label: '30日の作成' },
];

function PlanEditor({ plan, onSave }: { plan: api.Plan; onSave: (v: PlanValues) => Promise<void> }) {
  const [draft, setDraft] = useState<PlanValues>({
    name: plan.name,
    priceJpy: plan.priceJpy,
    maxFiles: plan.maxFiles,
    maxFileMb: plan.maxFileMb,
    maxTotalMb: plan.maxTotalMb,
    maxQuestions: plan.maxQuestions,
    dailyGenerations: plan.dailyGenerations,
    monthlyGenerations: plan.monthlyGenerations,
  });
  const [saving, setSaving] = useState(false);

  return (
    <div className="card nested">
      <div className="row between">
        <input
          type="text"
          className="auto"
          value={draft.name}
          aria-label={`${plan.id} のプラン名`}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <span className="stat">{plan.id}</span>
      </div>

      <div className="grid-2">
        {PLAN_FIELDS.map((field) => (
          <div key={field.key}>
            <label htmlFor={`${plan.id}-${field.key}`}>{field.label}</label>
            <input
              id={`${plan.id}-${field.key}`}
              type="number"
              min={0}
              step={field.step ?? 1}
              value={draft[field.key] as number}
              onChange={(event) => setDraft({ ...draft, [field.key]: Number(event.target.value) })}
            />
          </div>
        ))}
      </div>

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(draft);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? '保存中' : '保存'}
        </button>
      </div>
    </div>
  );
}

export default function AdminPanel({ currentUserId, onClose }: Props) {
  const [adminTab, setAdminTab] = useState<AdminTab>('overview');
  const [days, setDays] = useState(30);
  const [overview, setOverview] = useState<api.AdminOverview | null>(null);
  const [users, setUsers] = useState<api.AdminUserRow[]>([]);
  const [quizzes, setQuizzes] = useState<api.AdminQuizRow[]>([]);
  const [sharing, setSharing] = useState<api.SharingData | null>(null);
  const [newGroup, setNewGroup] = useState('');
  const [target, setTarget] = useState('');
  const [audience, setAudience] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [o, u, q, s] = await Promise.all([
        api.adminOverview(days),
        api.adminUsers(days),
        api.adminQuizzes(),
        api.adminSharing(),
      ]);
      setOverview(o);
      setUsers(u);
      setQuizzes(q);
      setSharing(s);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (run: () => Promise<unknown>) => {
    setError(null);
    try {
      await run();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const summary = overview?.summary;

  return (
    <>
      <section className="card">
        <div className="row between">
          <h2 className="tight">管理</h2>
          <button type="button" className="link" onClick={onClose}>
            閉じる
          </button>
        </div>

        <nav className="tabs inner" aria-label="管理画面の切り替え">
          {ADMIN_TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={adminTab === item.key ? 'tab current' : 'tab'}
              aria-current={adminTab === item.key}
              onClick={() => setAdminTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {adminTab !== 'plans' && (
          <div className="row tight">
            {PERIODS.map((value) => (
              <button
                key={value}
                type="button"
                className={value === days ? 'primary' : 'ghost'}
                onClick={() => setDays(value)}
              >
                {value}日
              </button>
            ))}
            <button type="button" className="link" onClick={() => void load()}>
              更新
            </button>
          </div>
        )}

        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}

        {loading && !summary && <p className="muted">読み込み中</p>}

        {summary && adminTab === 'overview' && (
          <>
            <dl className="summary">
              <div>
                <dt>ユーザー</dt>
                <dd>
                  <span className="score small">{summary.userCount}</span>
                  <div className="stat">直近{days}日で稼働 {summary.activeUserCount}</div>
                </dd>
              </div>
              <div>
                <dt>トークン</dt>
                <dd>
                  <span className="score small">
                    {formatTokens(summary.inputTokens + summary.outputTokens)}
                  </span>
                  <div className="stat">
                    入力 {formatTokens(summary.inputTokens)} / 出力{' '}
                    {formatTokens(summary.outputTokens)}
                  </div>
                </dd>
              </div>
              <div>
                <dt>クイズ / 挑戦</dt>
                <dd>
                  <span className="score small">
                    {summary.quizCount} / {summary.attemptCount}
                  </span>
                </dd>
              </div>
              <div>
                <dt>コスト（USD）</dt>
                <dd>
                  <span className="score small">${summary.estimatedCost.toFixed(2)}</span>
                  {summary.unpricedModels.length > 0 && (
                    <div className="stat warn-text">
                      単価未設定 {summary.unpricedModels.join('、')}
                    </div>
                  )}
                </dd>
              </div>
            </dl>

            {overview && overview.byModel.length > 0 && (
              <>
                <h3>モデル別</h3>
                <ul className="rows">
                  {overview.byModel.map((row) => (
                    <li key={row.modelId}>
                      <div className="grow">
                        <div>{row.modelId}</div>
                        <div className="stat">
                          {row.calls}回、入力 {formatTokens(row.inputTokens)}、出力{' '}
                          {formatTokens(row.outputTokens)}
                          {row.cost !== null && `、単価 $${row.inputPer1m} / $${row.outputPer1m}`}
                        </div>
                      </div>
                      <span className={row.cost === null ? 'stat warn-text fixed' : 'fixed'}>
                        {row.cost === null ? '単価未設定' : `$${row.cost.toFixed(4)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {overview && overview.daily.length > 0 && (
              <>
                <h3>日別</h3>
                <ul className="rows">
                  {overview.daily.slice(0, 14).map((row) => (
                    <li key={row.day}>
                      <span className="grow">{row.day}</span>
                      <span className="stat fixed">
                        {row.calls}回、{formatTokens(row.inputTokens + row.outputTokens)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>

      {adminTab === 'quizzes' && sharing && (
        <>
          <section className="card">
            <h2 className="tight">グループ</h2>
            <p className="subtle">
              同じ授業を受けている人をまとめます。配布先として選べます。
            </p>

            <div className="row tight">
              <input
                type="text"
                value={newGroup}
                placeholder="グループ名（例: 経済学I 受講者）"
                aria-label="新しいグループ名"
                style={{ flex: '1 1 12rem' }}
                onChange={(event) => setNewGroup(event.target.value)}
              />
              <button
                type="button"
                disabled={!newGroup.trim()}
                onClick={() => {
                  const name = newGroup.trim();
                  setNewGroup('');
                  void act(() => api.adminCreateGroup(name));
                }}
              >
                作成
              </button>
            </div>

            {sharing.groups.length === 0 ? (
              <p className="muted">まだありません。</p>
            ) : (
              sharing.groups.map((group) => (
                <div key={group.id} className="card nested">
                  <div className="row between">
                    <strong>{group.name}</strong>
                    <span className="row tight">
                      <span className="stat">{group.memberCount} 人</span>
                      <button
                        type="button"
                        className="link"
                        onClick={() => {
                          const ok = window.confirm(
                            `グループ「${group.name}」を削除します。このグループ向けの配布も解除されます。`,
                          );
                          if (ok) void act(() => api.adminDeleteGroup(group.id));
                        }}
                      >
                        削除
                      </button>
                    </span>
                  </div>
                  <div className="row tight">
                    {users.map((u) => {
                      const member = (sharing.memberships[group.id] ?? []).includes(u.id);
                      return (
                        <button
                          key={u.id}
                          type="button"
                          className={member ? 'primary' : 'ghost'}
                          onClick={() =>
                            void act(() => api.adminSetGroupMember(group.id, u.id, !member))
                          }
                        >
                          {u.username}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </section>

          <section className="card">
            <h2 className="tight">配布</h2>
            <p className="subtle">
              クイズ1件か、フォルダーまとめて配れます。フォルダー配布なら、あとで中身を
              足した分も自動的に配布対象になります。解答履歴と復習は各自のものです。
            </p>

            <div className="grid-2">
              <div>
                <label htmlFor="share-target">配るもの</label>
                <select
                  id="share-target"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  <option value="">選択してください</option>
                  {sharing.folders.length > 0 && (
                    <optgroup label="フォルダー">
                      {sharing.folders.map((f) => (
                        <option key={f.id} value={`folder:${f.id}`}>
                          {f.name}（{f.ownerName}、{f.quizCount}件）
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="クイズ">
                    {sharing.quizzes.map((q) => (
                      <option key={q.id} value={`quiz:${q.id}`}>
                        {q.title}（{q.ownerName}）
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>
              <div>
                <label htmlFor="share-group">配る相手</label>
                <select
                  id="share-group"
                  value={audience}
                  onChange={(event) => setAudience(event.target.value)}
                >
                  <option value="">全員</option>
                  {sharing.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={!target}
                onClick={() => {
                  const [kind, id] = target.split(':');
                  if (!id || (kind !== 'quiz' && kind !== 'folder')) return;
                  void act(() => api.adminCreateShare(kind, id, audience || null));
                  setTarget('');
                }}
              >
                配布する
              </button>
            </div>

            {sharing.shares.length === 0 ? (
              <p className="muted">配布中のものはありません。</p>
            ) : (
              <ul className="rows">
                {sharing.shares.map((share) => (
                  <li key={share.id}>
                    <div className="grow">
                      <div className="row tight">
                        <span className="badge">
                          {share.targetKind === 'folder' ? 'フォルダー' : 'クイズ'}
                        </span>
                        <span>{share.targetName}</span>
                      </div>
                      <div className="stat">
                        {share.ownerName} → {share.groupName ?? '全員'}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="link fixed"
                      onClick={() => void act(() => api.adminDeleteShare(share.id))}
                    >
                      やめる
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {quizzes.some((q) => q.shared) && (
              <>
                <h3>旧方式で全体配布中</h3>
                <ul className="rows">
                  {quizzes
                    .filter((q) => q.shared)
                    .map((quiz) => (
                      <li key={quiz.id}>
                        <span className="grow">
                          {quiz.title}
                          <span className="stat"> {quiz.ownerName}</span>
                        </span>
                        <button
                          type="button"
                          className="link fixed"
                          onClick={() => void act(() => api.shareQuiz(quiz.id, false))}
                        >
                          やめる
                        </button>
                      </li>
                    ))}
                </ul>
              </>
            )}
          </section>
        </>
      )}

      {adminTab === 'prices' && overview && overview.prices.length > 0 && (
        <section className="card">
          <h2 className="tight">単価（USD / 100万トークン）</h2>
          <p className="subtle">0 のモデルはコスト計算から除外されます。</p>
          {overview.prices.map((price) => (
            <PriceEditor
              key={price.modelId}
              price={price}
              onSave={async (input, output) => {
                await act(() => api.adminUpdatePrice(price.modelId, input, output));
              }}
            />
          ))}
        </section>
      )}

      {adminTab === 'plans' && overview && overview.plans.length > 0 && (
        <section className="card">
          <h2 className="tight">プラン</h2>
          <p className="subtle">0 は無制限。1ファイルは Bedrock の制約で 4.5MB が上限。</p>
          {overview.plans.map((p) => (
            <PlanEditor
              key={p.id}
              plan={p}
              onSave={async (values) => {
                await act(() => api.adminUpdatePlan(p.id, values));
              }}
            />
          ))}
        </section>
      )}

      {adminTab === 'users' && (
        <section className="card">
          <h2 className="tight">ユーザー {users.length}</h2>
          <ul className="rows">
            {users.map((user) => {
              const isSelf = user.id === currentUserId;
              return (
                <li key={user.id}>
                  <div className="grow">
                    <div className="row tight">
                      <span>{user.username}</span>
                      {user.disabled && <span className="badge hard">無効</span>}
                      {isSelf && <span className="badge">自分・上限なし</span>}
                    </div>
                    <div className="stat">
                      登録 {formatDateTime(user.createdAt)}、最終利用{' '}
                      {formatDateTime(user.lastSeenAt)}
                    </div>
                    <div className="stat">
                      作成 {user.generateCalls}（本日 {user.generationsToday}）、採点{' '}
                      {user.gradeCalls}、入力 {formatTokens(user.inputTokens)}、出力{' '}
                      {formatTokens(user.outputTokens)}、${user.cost.toFixed(4)}
                    </div>
                    <div className="stat">
                      クイズ {user.quizCount}、挑戦 {user.attemptCount}
                    </div>
                    <div className="row tight">
                      <label className="inline" htmlFor={`plan-${user.id}`}>
                        プラン
                      </label>
                      <select
                        id={`plan-${user.id}`}
                        className="auto"
                        value={user.planId}
                        onChange={(event) =>
                          void act(() => api.adminSetPlan(user.id, event.target.value))
                        }
                      >
                        {(overview?.plans ?? []).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <span className="row tight fixed">
                    <button
                      type="button"
                      disabled={isSelf}
                      onClick={() => void act(() => api.adminSetDisabled(user.id, !user.disabled))}
                    >
                      {user.disabled ? '有効化' : '無効化'}
                    </button>
                    <button
                      type="button"
                      className="link"
                      disabled={isSelf}
                      onClick={() => {
                        const ok = window.confirm(
                          `${user.username} を削除します。作成したクイズと解答履歴もすべて消え、元に戻せません。続けますか？`,
                        );
                        if (ok) void act(() => api.adminDeleteUser(user.id));
                      }}
                    >
                      削除
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
