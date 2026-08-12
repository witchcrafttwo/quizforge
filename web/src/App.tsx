import { useCallback, useEffect, useState } from 'react';
import * as api from './api';
import { loadConfig, saveConfig } from './configStore';
import AdminPanel from './components/AdminPanel';
import AttemptHistory from './components/AttemptHistory';
import AuthPanel from './components/AuthPanel';
import HistoryList from './components/HistoryList';
import PlanBar from './components/PlanBar';
import QuizConfigForm from './components/QuizConfigForm';
import QuizRunner from './components/QuizRunner';
import ResultView from './components/ResultView';
import UploadPanel from './components/UploadPanel';
import type {
  AnswerMap,
  AnswerValue,
  GradeResult,
  Question,
  Quiz,
  QuizAttemptView,
  QuizConfig,
  QuizSummary,
  ScoredQuestion,
} from './types';

type View = 'setup' | 'quiz' | 'result';
type Tab = 'create' | 'library' | 'admin';

const TAB_PATH: Record<Tab, string> = {
  create: '/',
  library: '/library',
  admin: '/admin',
};

function tabFromPath(pathname: string): Tab {
  const path = pathname.replace(/\/+$/, '');
  if (path.endsWith('/admin')) return 'admin';
  if (path.endsWith('/library')) return 'library';
  return 'create';
}

/** 各問 0〜100 点の平均を総合点にする（サーバ側の計算と同じ定義）。 */
function totalOf(scored: ScoredQuestion[]): number {
  if (scored.length === 0) return 0;
  return Math.round(scored.reduce((sum, s) => sum + s.score, 0) / scored.length);
}

export default function App() {
  const [user, setUser] = useState<api.User | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  const [view, setView] = useState<View>('setup');
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState('');
  // 前回の設定を端末内から復元する。
  const [config, setConfig] = useState<QuizConfig>(loadConfig);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [result, setResult] = useState<QuizAttemptView | null>(null);
  const [history, setHistory] = useState<QuizSummary[]>([]);
  // 挑戦履歴を開いているクイズ。null なら一覧を表示。
  const [historyOf, setHistoryOf] = useState<QuizSummary | null>(null);
  // 「完璧」「復習」の自己申告。問題 id をキーに持つ。
  const [marks, setMarks] = useState<Record<string, api.QuestionMark>>({});
  const [folders, setFolders] = useState<api.Folder[]>([]);
  // 進行中の生成ジョブ。null なら生成していない。
  const [job, setJob] = useState<api.Job | null>(null);
  // できあがったクイズの id。自動では開かず、案内だけ出す。
  const [doneQuizId, setDoneQuizId] = useState<string | null>(null);
  const [busy, setBusy] = useState<'generate' | 'open' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);

  // 差し替えは資料を Bedrock へ再送するので、手元に資料が残っているときだけできる。
  const canReplaceQuestions = files.length > 0 || text.trim().length > 0;
  // ルータは入れず pathname だけ見る。/library と /admin を直接開ける。
  const [tab, setTab] = useState<Tab>(() => tabFromPath(window.location.pathname));
  const showAdmin = tab === 'admin';
  const [isAdmin, setIsAdmin] = useState(false);
  const [plan, setPlan] = useState<api.Plan | null>(null);
  const [planUsage, setPlanUsage] = useState({ daily: 0, monthly: 0 });

  // 出題設定は端末内に保存する。変わるたびに書き込む（同期処理なので軽い）。
  useEffect(() => {
    saveConfig(config);
  }, [config]);

  /* ---------- 生成ジョブの監視 ---------- */

  // 再読み込みしても進行中の生成に戻れるようにする。
  useEffect(() => {
    if (!user) return;
    api
      .listActiveJobs()
      .then((active) => {
        const first = active[0];
        if (first) {
          setJob(first);
          setBusy('generate');
        }
      })
      .catch(() => undefined);
  }, [user]);

  // 完了するまで2秒ごとに状態を見る。
  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'failed') return;

    const timer = setInterval(() => {
      api
        .getJob(job.id)
        .then(setJob)
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
          setJob(null);
          setBusy(null);
        });
    }, 2000);
    return () => clearInterval(timer);
  }, [job]);

  // 完了しても勝手に出題を始めない。一覧を更新して、案内だけ出す。
  useEffect(() => {
    if (!job) return;

    if (job.status === 'failed') {
      setError(job.error ?? '生成に失敗しました。');
      setJob(null);
      setBusy(null);
      return;
    }
    if (job.status === 'done' && job.quizId) {
      setDoneQuizId(job.quizId);
      setJob(null);
      setBusy(null);
      refreshHistory();
      refreshMe();
    }
    // refreshHistory / refreshMe はこの下で宣言しているため依存に入れない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  /* ---------- 認証 ---------- */

  useEffect(() => {
    api
      .me()
      .then((info) => {
        setUser(info.user);
        setIsAdmin(info.isAdmin);
        setPlan(info.plan);
        setPlanUsage(info.usage);
      })
      .catch(() => setUser(null))
      .finally(() => setCheckingAuth(false));
  }, []);

  const refreshHistory = useCallback(() => {
    if (!user) return;
    api
      .listQuizzes()
      .then(setHistory)
      .catch(() => setHistory([]));
    api
      .listFolders()
      .then(setFolders)
      .catch(() => setFolders([]));
  }, [user]);

  /** フォルダー操作は失敗をそのまま画面に出し、成功したら一覧を取り直す。 */
  const withRefresh = (run: () => Promise<unknown>) => {
    run()
      .then(refreshHistory)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  };

  useEffect(refreshHistory, [refreshHistory]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  // ブラウザの戻る/進むでタブを同期させる。
  // 出題中に戻られたら一覧の状態へ落とす（タブと画面が食い違うと何も表示されなくなる）。
  useEffect(() => {
    const sync = () => {
      setTab(tabFromPath(window.location.pathname));
      setView('setup');
    };
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  /** タブ移動。URL だけ変えて画面は常に一覧側へ戻す。 */
  const goTab = useCallback((next: Tab) => {
    setTab(next);
    if (window.location.pathname !== TAB_PATH[next]) {
      window.history.pushState({}, '', TAB_PATH[next]);
    }
  }, []);

  /** タブのボタンから呼ぶ。出題中でも確実に一覧へ戻す。 */
  const switchTab = useCallback(
    (next: Tab) => {
      setView('setup');
      goTab(next);
    },
    [goTab],
  );

  /** 出題を抜けて設定・一覧へ戻す。中断と「別のクイズを作る」で共用。 */
  const leaveQuiz = useCallback(
    (next: Tab, attemptToDiscard?: string | null) => {
      // 1問も解いていない挑戦はサーバ側でも消して履歴を汚さない。
      if (attemptToDiscard) api.discardAttempt(attemptToDiscard).catch(() => undefined);
      setQuiz(null);
      setAttemptId(null);
      setResult(null);
      setError(null);
      setView('setup');
      goTab(next);
    },
    [goTab],
  );

  const handleLogout = async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
    setQuiz(null);
    setResult(null);
    setHistory([]);
    setIsAdmin(false);
    setJob(null);
    setDoneQuizId(null);
    goTab('create');
    setView('setup');
  };

  const refreshMe = useCallback(() => {
    api
      .me()
      .then((info) => {
        setIsAdmin(info.isAdmin);
        setPlan(info.plan);
        setPlanUsage(info.usage);
      })
      .catch(() => undefined);
  }, []);

  const handleAuthenticated = (found: api.User) => {
    setUser(found);
    // プランと管理者判定はサーバに聞く。出題設定は端末内の値をそのまま使う。
    refreshMe();
  };



  /* ---------- 生成と出題 ---------- */

  const startQuiz = async (target: Quiz, mode: api.AttemptMode = 'full') => {
    const attempt = await api.startAttempt(target.id, mode);
    // 復習では出題範囲が絞られるので、返ってきた id の問題だけにする。
    const scoped = attempt.questionIds
      ? { ...target, questions: target.questions.filter((q) => attempt.questionIds?.includes(q.id)) }
      : target;
    setQuiz(scoped);
    setAttemptId(attempt.id);
    setResult(null);
    setView('quiz');
    goTab('create');
    window.scrollTo({ top: 0 });
  };

  /**
   * 生成は受け付けだけしてサーバのジョブに任せる。
   * 完了までポーリングするので、プロキシのタイムアウトに影響されない。
   */
  const handleGenerate = async () => {
    setError(null);
    setBusy('generate');
    try {
      const uploaded = await Promise.all(files.map(api.fileToUploaded));
      const started = await api.requestGeneration({
        config: { ...config, focus: config.focus?.trim() || undefined },
        files: uploaded,
        text: text.trim() || undefined,
      });
      setJob(started);
      refreshMe();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(null);
    }
  };

  const handleOpen = async (quizId: string, mode: api.AttemptMode = 'full') => {
    setError(null);
    setBusy('open');
    try {
      setHistoryOf(null);
      await startQuiz(await api.getQuiz(quizId), mode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  /** 1問分をサーバへ送って採点結果を受け取る。正誤判定はサーバが行う。 */
  const handleSubmitAnswer = async (
    question: Question,
    response: AnswerValue,
  ): Promise<GradeResult | null> => {
    if (!attemptId) return null;
    try {
      return await api.submitAnswer(attemptId, question.id, response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  };

  /** 「AI解説」ボタン用。サーバ側で一度生成したものはキャッシュされる。 */
  const handleRequestAiExplanation = async (questionId: string): Promise<string> => {
    if (!attemptId) throw new Error('解答の記録が見つかりません');
    const { explanation } = await api.explainAnswer(attemptId, questionId);
    return explanation;
  };

  /**
   * 不適切な問題を捨てる。手元に資料が残っていれば同じ形式・難易度で1問作り直し、
   * 無ければ削除だけする（差し替えには資料を Bedrock に再送する必要があるため）。
   */
  const handleDiscardQuestion = async (questionId: string): Promise<'replaced' | 'deleted'> => {
    if (!quiz) throw new Error('クイズが読み込まれていません');
    setError(null);

    if (!canReplaceQuestions) {
      await api.deleteQuestion(quiz.id, questionId);
      setQuiz({ ...quiz, questions: quiz.questions.filter((q) => q.id !== questionId) });
      return 'deleted';
    }

    const uploaded = await Promise.all(files.map(api.fileToUploaded));
    const next = await api.replaceQuestion(quiz.id, questionId, {
      config,
      files: uploaded,
      text: text.trim() || undefined,
    });
    setQuiz({
      ...quiz,
      questions: quiz.questions.map((q) => (q.id === questionId ? next : q)),
    });
    refreshMe();
    return 'replaced';
  };

  /** 「完璧」「復習」の切り替え。押した瞬間に反映し、保存は裏で行う。 */
  const handleMark = (questionId: string, mark: api.QuestionMark | null) => {
    setMarks((prev) => {
      const next = { ...prev };
      if (mark === null) delete next[questionId];
      else next[questionId] = mark;
      return next;
    });
    api.setQuestionMark(questionId, mark).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  /** 結果画面から、いま間違えた問題だけをすぐ解き直す。 */
  const handleReviewWrong = async () => {
    if (!quiz) return;
    await handleOpen(quiz.id, 'review');
  };

  const handleComplete = async (scored: ScoredQuestion[], answers: AnswerMap) => {
    if (!quiz) return;
    let totalScore = totalOf(scored);
    if (attemptId) {
      // 総合点はサーバの集計を正とする。失敗しても手元の計算で表示は続ける。
      totalScore = await api
        .completeAttempt(attemptId)
        .then((r) => r.totalScore)
        .catch(() => totalScore);
    }
    setResult({ quiz, answers, scored, totalScore, completedAt: new Date().toISOString() });
    setView('result');
    refreshHistory();
    window.scrollTo({ top: 0 });
  };

  /* ---------- 描画 ---------- */

  if (checkingAuth) {
    return (
      <div className="app">
        <p className="muted">読み込み中</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="app">
        <header className="app-header">
          <div>
            <h1>QuizForge</h1>
            <p>授業資料から問題をつくる</p>
          </div>
        </header>
        <div className="narrow">
          <AuthPanel onAuthenticated={handleAuthenticated} />
        </div>
      </div>
    );
  }

  const canGenerate = (files.length > 0 || text.trim().length > 0) && busy === null && online;

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>QuizForge</h1>
          <p>授業資料から問題をつくる</p>
        </div>
        <span className="row tight">
          {!online && <span className="badge hard">オフライン</span>}
          <span className="stat">{user.username}</span>
          <button type="button" className="link" onClick={handleLogout}>
            ログアウト
          </button>
        </span>
      </header>

      {!showAdmin && view === 'setup' && (
        <nav className="tabs" aria-label="画面切り替え">
          <button
            type="button"
            className={tab === 'create' ? 'tab current' : 'tab'}
            aria-current={tab === 'create'}
            onClick={() => switchTab('create')}
          >
            つくる
          </button>
          <button
            type="button"
            className={tab === 'library' ? 'tab current' : 'tab'}
            aria-current={tab === 'library'}
            onClick={() => switchTab('library')}
          >
            クイズ
            {history.length > 0 && <span className="tab-count">{history.length}</span>}
          </button>
        </nav>
      )}

      {showAdmin &&
        (isAdmin ? (
          <AdminPanel currentUserId={user.id} onClose={() => goTab('create')} />
        ) : (
          <section className="card error" role="alert">
            <div className="row between">
              <strong>権限がありません</strong>
              <button type="button" className="link" onClick={() => goTab('create')}>
                閉じる
              </button>
            </div>
            <p className="muted">管理者アカウントでログインし直してください。</p>
          </section>
        ))}

      {error && (
        <div className="card error" role="alert">
          {error}
        </div>
      )}

      {!showAdmin && view === 'setup' && tab === 'library' && historyOf && (
        <AttemptHistory
          quiz={historyOf}
          onClose={() => setHistoryOf(null)}
          onReview={() => void handleOpen(historyOf.id, 'review')}
          onMark={handleMark}
        />
      )}

      {!showAdmin && view === 'setup' && tab === 'library' && !historyOf && (
        <HistoryList
          quizzes={history}
          folders={folders}
          onMove={(quizId, folderId) => withRefresh(() => api.moveQuizToFolder(quizId, folderId))}
          onCreateFolder={(name) => withRefresh(() => api.createFolder(name))}
          onDeleteFolder={(id) => withRefresh(() => api.deleteFolder(id))}
          onOpen={handleOpen}
          onReview={(id) => void handleOpen(id, 'review')}
          onHistory={setHistoryOf}
          onRename={async (id, title) => {
            try {
              await api.renameQuiz(id, title);
              refreshHistory();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }}
          onDelete={async (id) => {
            await api.deleteQuiz(id).catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : String(cause));
            });
            refreshHistory();
          }}
        />
      )}

      {!showAdmin && view === 'setup' && tab === 'create' && (
        <div className="layout">
          <div>
            <UploadPanel
              files={files}
              onFilesChange={setFiles}
              text={text}
              onTextChange={setText}
              maxFiles={plan?.maxFiles ?? 0}
              maxTotalMb={plan?.maxTotalMb ?? 0}
            />
            <QuizConfigForm
              config={config}
              onChange={setConfig}
              maxQuestions={plan?.maxQuestions ?? 50}
            />

            <div className="actions">
              <button
                type="button"
                className="primary block"
                onClick={handleGenerate}
                disabled={!canGenerate}
              >
                {busy === 'generate' ? '作成中' : 'クイズをつくる'}
              </button>
            </div>

            {job && (
              <p className="muted">
                {job.status === 'queued' ? '順番待ちです' : '作成しています'}（
                {job.elapsedSeconds} 秒）。
                このページを閉じても作成は続きます。
              </p>
            )}

            {doneQuizId && (
              <div className="card nested">
                <div className="row between">
                  <strong>クイズができました</strong>
                  <button type="button" className="link" onClick={() => setDoneQuizId(null)}>
                    閉じる
                  </button>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      const id = doneQuizId;
                      setDoneQuizId(null);
                      void handleOpen(id);
                    }}
                  >
                    いま解く
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDoneQuizId(null);
                      switchTab('library');
                    }}
                  >
                    一覧で見る
                  </button>
                </div>
              </div>
            )}
            {!online && <p className="muted">オフラインでは作成できません。</p>}
          </div>

          <div className="side">
            {plan && <PlanBar plan={plan} usage={planUsage} />}
            {history.length > 0 && (
              <section className="card">
                <div className="row between">
                  <h2 className="tight">最近</h2>
                  <button type="button" className="link" onClick={() => goTab('library')}>
                    すべて
                  </button>
                </div>
                <ul className="rows">
                  {history.slice(0, 3).map((quiz) => (
                    <li key={quiz.id}>
                      <span className="grow">{quiz.title}</span>
                      <button type="button" className="fixed" onClick={() => handleOpen(quiz.id)}>
                        解く
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      )}

      {!showAdmin && view === 'quiz' && quiz && attemptId && (
        <div className="narrow">
          <QuizRunner
            key={attemptId ?? quiz.id}
            quiz={quiz}
            onSubmitAnswer={handleSubmitAnswer}
            onComplete={handleComplete}
            onAbort={() => leaveQuiz('library', attemptId)}
            onRequestAiExplanation={handleRequestAiExplanation}
            onDiscardQuestion={handleDiscardQuestion}
            canReplace={canReplaceQuestions}
            marks={marks}
            onMark={handleMark}
          />
        </div>
      )}

      {!showAdmin && view === 'result' && result && (
        <div className="narrow">
          <ResultView
            attempt={result}
            onRequestAiExplanation={handleRequestAiExplanation}
            onReviewWrong={() => void handleReviewWrong()}
            marks={marks}
            onMark={handleMark}
            onRestart={() => {
              if (quiz) void handleOpen(quiz.id);
            }}
            onNewQuiz={() => leaveQuiz('create')}
          />
        </div>
      )}
    </div>
  );
}
