// =====================================================
// MQ Student Submission - Types
// =====================================================
// Shape of the assignment spec loaded (decrypted) at runtime, plus the
// shape of the submission JSON exported (encrypted) at the end.
//
// Mirrors the types in GradeBridge-MQ-Assignment-Maker/types.ts. Keep in
// sync.
// =====================================================

export type QuestionType = 'multiple_choice' | 'true_false' | 'numeric';

export interface MQQuestion {
  id: number;
  type: QuestionType;
  title: string;
  question_text: string;
  choices: string[];
  correct_answer_index: number;
  points: number;
  tolerance: number;
  feedback_correct: string;
  feedback_incorrect: string;
  bloom_level: string;
  difficulty: number;
  katex_present: boolean;
  module_number: number;
  chapter_number: string;
  chapter_title: string;
  topic_title: string;
  subtopic: string;
}

export interface MQAssignmentSpec {
  schema_version: 1;
  id: string;
  courseCode: string;
  title: string;
  dueDate: string;
  dueTime: string;
  timeLimitMinutes: number;
  questionsPerStudent: number;
  shuffleQuestions: boolean;
  shuffleChoices: boolean;
  preamble: string;
  questionPool: MQQuestion[];
  createdAt: number;
  updatedAt: number;
  variant_label?: string;
  variant_multiplier?: number;
}

// One question in the order it is presented to the student. The question
// content is the original; presentedChoiceOrder records the permutation
// applied to choices for shuffling.
export interface PresentedQuestion {
  question: MQQuestion;
  // presentedChoiceOrder[i] = original index of the choice now shown at slot i
  // e.g. [2, 0, 3, 1] means slot 0 shows original choice 2, slot 1 shows choice 0, etc.
  presentedChoiceOrder: number[];
}

export interface AnswerRecord {
  question_id: number;
  // Index into the SHUFFLED choice array (i.e., the slot the student clicked)
  chosen_index: number | null;
  // Permutation used for this question; lets the autograder map chosen_index back to original
  presented_choices_order: number[];
  // Time spent on this question (seconds), best-effort
  elapsed_seconds: number;
}

export interface MQSubmission {
  schema_version: 1;
  student_first_name: string;
  student_last_name: string;
  student_name: string;
  course_code: string;
  assignment_id: string;
  assignment_title: string;
  started_at: string;
  submitted_at: string;
  duration_seconds: number;
  time_limit_minutes: number;
  auto_submitted: boolean;
  pledge_signed: boolean;
  pledge_signature: string;     // typed-name signature; empty if auto-submitted
  pledge_signed_at: string;     // ISO timestamp; empty if auto-submitted
  answers: AnswerRecord[];
}
