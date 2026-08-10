// server/src/types.ts と同じ内容を保つこと（フロント・バックで共有する契約）。

export type QuestionType = 'multiple_choice' | 'multi_select' | 'short_answer' | 'cloze';
export type Difficulty = 'easy' | 'medium' | 'hard';

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
  questionCount: number;
  typeRatio: TypeRatio;
  difficultyRatio: DifficultyRatio;
  focus?: string;
  language: 'ja' | 'en';
}

export interface UploadedFile {
  name: string;
  base64: string;
  mimeType: string;
}

/** 穴埋めの空欄1つ分。表記ゆれを許容するため候補を複数持つ。 */
export interface ClozeBlank {
  answers: string[];
}

export interface Question {
  id: string;
  type: QuestionType;
  difficulty: Difficulty;
  /** cloze のときは {{1}} {{2}} … が空欄位置を表す。 */
  question: string;
  choices?: string[];
  answerIndex?: number;
  /** multi_select の正解インデックス（2〜4件） */
  answerIndexes?: number[];
  answerText?: string;
  keyPoints?: string[];
  blanks?: ClozeBlank[];
  explanation: string;
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

export interface QuizSummary {
  id: string;
  title: string;
  createdAt: string;
  sourceNames: string[];
  /** 全ユーザーへ配布されているか */
  shared: boolean;
  /** 自分が作ったものか */
  isOwn: boolean;
  ownerName: string;
  folderId: string | null;
  folderName: string | null;
  questionCount: number;
  attemptCount: number;
  bestScore: number | null;
  lastScore: number | null;
  /** 直近の解答が正解でなかった問題の数（復習の対象） */
  weakCount: number;
}

export type Verdict = 'correct' | 'partial' | 'incorrect';

/**
 * 解答値。multiple_choice はインデックス、multi_select はインデックスの配列、
 * short_answer は文字列、cloze は空欄ごとの文字列配列。
 */
export type AnswerValue = number | string | string[] | number[];

export interface GradeResult {
  questionId: string;
  score: number;
  verdict: Verdict;
  feedback: string;
  blankResults?: boolean[];
}

export type AttemptMode = 'full' | 'review';

/** 解答後の自己申告。'review' はまた解く、'mastered' は完璧。 */
export type QuestionMark = 'review' | 'mastered';

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

export interface AttemptSummary extends Attempt {
  questionCount: number;
  correctCount: number;
}

export interface AttemptDetail extends Attempt {
  quiz: Quiz;
  answers: Record<string, AnswerValue>;
  results: GradeResult[];
  marks: Record<string, QuestionMark>;
}

/** 画面内で保持する解答。未着手は undefined。 */
export type AnswerMap = Record<string, AnswerValue | undefined>;

export interface ScoredQuestion {
  question: Question;
  answer: AnswerValue | undefined;
  score: number;
  verdict: Verdict;
  feedback?: string;
  blankResults?: boolean[];
}

/** 結果画面に渡す1回分の記録（表示専用。永続化は Postgres 側）。 */
export interface QuizAttemptView {
  quiz: Quiz;
  answers: AnswerMap;
  scored: ScoredQuestion[];
  totalScore: number;
  completedAt: string;
}
