// web/src/types.ts と同じ内容を保つこと（フロント・バックで共有する契約）。

export type QuestionType = 'multiple_choice' | 'multi_select' | 'short_answer' | 'cloze';
export type Difficulty = 'easy' | 'medium' | 'hard';

/** 合計 100 になる必要はなく、相対比として扱う。 */
export interface TypeRatio {
  multiple_choice: number;
  multi_select: number;
  short_answer: number;
  cloze: number;
}

export interface DifficultyRatio {
  easy: number;
  medium: number;
  hard: number;
}

export interface QuizConfig {
  /** 出題数 1〜50 */
  questionCount: number;
  typeRatio: TypeRatio;
  difficultyRatio: DifficultyRatio;
  /** 出題の観点・範囲の指定（任意） */
  focus?: string;
  language: 'ja' | 'en';
}

export interface UploadedFile {
  name: string;
  /** data URL ではなく生の base64 */
  base64: string;
  mimeType: string;
}

/** 穴埋めの空欄1つ分。表記ゆれを許容するため候補を複数持つ。 */
export interface ClozeBlank {
  /** 許容する解答。先頭を代表表記として表示する。 */
  answers: string[];
}

export interface Question {
  id: string;
  type: QuestionType;
  difficulty: Difficulty;
  /** cloze のときは {{1}} {{2}} … が空欄位置を表す。 */
  question: string;
  /** multiple_choice / multi_select のときちょうど 5 件 */
  choices?: string[];
  /** multiple_choice の正解インデックス（0-4） */
  answerIndex?: number;
  /** multi_select の正解インデックス（2〜4件、昇順） */
  answerIndexes?: number[];
  /** short_answer の模範解答 */
  answerText?: string;
  /** short_answer の採点観点 */
  keyPoints?: string[];
  /** cloze の空欄。question 中の {{n}} と同じ順序・同じ個数。 */
  blanks?: ClozeBlank[];
  explanation: string;
  /** 根拠となる教材中の記述 */
  sourceQuote?: string;
}

export interface Quiz {
  id: string;
  title: string;
  createdAt: string;
  config: QuizConfig;
  sourceNames: string[];
  questions: Question[];
}

/** 一覧表示用。問題本体は含めない。 */
export interface QuizSummary {
  id: string;
  title: string;
  createdAt: string;
  sourceNames: string[];
  /** 全ユーザーへ配布されているか */
  shared: boolean;
  /** 自分が作ったものか（名前変更・削除ができるか） */
  isOwn: boolean;
  ownerName: string;
  folderId: string | null;
  folderName: string | null;
  questionCount: number;
  attemptCount: number;
  bestScore: number | null;
  lastScore: number | null;
  /** 直近の解答が不正解・部分正解だった問題の数（復習の対象） */
  weakCount: number;
}

export type Verdict = 'correct' | 'partial' | 'incorrect';

/**
 * 解答値。形式ごとに型が違う。
 * multiple_choice: 選択肢インデックス / multi_select: インデックスの配列
 * short_answer: 文字列 / cloze: 空欄ごとの文字列配列
 */
export type AnswerValue = number | string | string[] | number[];

export interface GradeResult {
  questionId: string;
  /** 0〜100 */
  score: number;
  verdict: Verdict;
  feedback: string;
  /** cloze のとき、空欄ごとの正誤 */
  blankResults?: boolean[];
}

export interface GenerateRequest {

  config: QuizConfig;
  files: UploadedFile[];
  /** 教材の代わり、または補足として貼り付けたテキスト */
  text?: string;
}

/** 1問ずつ解答を送るときのリクエスト。 */
export interface SubmitAnswerRequest {
  questionId: string;
  response: AnswerValue;
}

export type AttemptMode = 'full' | 'review';

export interface Attempt {
  id: string;
  quizId: string;
  mode: AttemptMode;
  /** 復習のときは出題した問題の id。全問なら null。 */
  questionIds: string[] | null;
  startedAt: string;
  completedAt: string | null;
  totalScore: number | null;
}

/** 履歴一覧用。 */
export interface AttemptSummary extends Attempt {
  questionCount: number;
  correctCount: number;
}

/** 解答後の自己申告。'review' はまた解く、'mastered' は完璧。 */
export type QuestionMark = 'review' | 'mastered';

/** 挑戦1回分の記録。振り返り画面で使う。 */
export interface AttemptDetail extends Attempt {
  quiz: Quiz;
  answers: Record<string, AnswerValue>;
  results: GradeResult[];
  marks: Record<string, QuestionMark>;
}

export interface GradeRequestItem {
  questionId: string;
  question: string;
  modelAnswer: string;
  keyPoints: string[];
  userAnswer: string;
}

export interface GradeRequest {
  language: 'ja' | 'en';
  items: GradeRequestItem[];
}
