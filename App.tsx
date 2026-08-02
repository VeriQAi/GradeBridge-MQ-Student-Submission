import React, { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { Clock, Download, FileWarning, Play, Upload, AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, ShieldCheck } from 'lucide-react';
import { decryptJson, encryptJson, isEncoded } from './cryptoService';
import {
  AnswerRecord,
  MQAssignmentSpec,
  MQSubmission,
  PresentedQuestion,
} from './types';

type Phase = 'name' | 'load' | 'preamble' | 'quiz' | 'pledge' | 'submitted';

// Fisher-Yates in-place shuffle, returning a NEW array.
function shuffled<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Pick N random elements (without replacement) from arr.
function sampleN<T>(arr: T[], n: number): T[] {
  return shuffled(arr).slice(0, Math.min(n, arr.length));
}

// Render a string that may contain LaTeX in any of these delimiters:
//   $$ ... $$    (display math)
//   $ ... $      (inline math)
//   \[ ... \]    (display math)
//   \( ... \)    (inline math)
// KaTeX is loaded as a global from CDN in index.html.
//
// `enabled` is a hint from the question's katex_present flag, but we always
// attempt to render if delimiters are detected, since some questions slip in
// LaTeX without setting the flag.
const KatexText: React.FC<{ text: string; enabled: boolean }> = ({ text, enabled: _enabled }) => {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const katex = (window as { katex?: { renderToString: (tex: string, opts?: object) => string } }).katex;
    if (!katex) {
      el.textContent = text;
      return;
    }
    // Order: $$..$$, \[..\], $..$, \(..\)
    // Capture groups: 1=$$..$$, 2=\[..\], 3=$..$, 4=\(..\)
    const re = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^\n$]+?)\$|\\\(([\s\S]+?)\\\)/g;
    const html: string[] = [];
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    while ((m = re.exec(text)) !== null) {
      if (m.index > lastIdx) html.push(escapeHtml(text.slice(lastIdx, m.index)));
      const display = m[1] !== undefined || m[2] !== undefined;
      const tex = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
      try {
        html.push(katex.renderToString(tex, { displayMode: display, throwOnError: false }));
      } catch {
        html.push(escapeHtml(m[0]));
      }
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < text.length) html.push(escapeHtml(text.slice(lastIdx)));
    el.innerHTML = html.join('');
  }, [text]);

  return <span ref={ref} />;
};

const App: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('name');
  const [error, setError] = useState<string>('');

  // Step 1: identity
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');

  // Step 2: assignment
  const [spec, setSpec] = useState<MQAssignmentSpec | null>(null);

  // Step 3+: quiz state
  const [presented, setPresented] = useState<PresentedQuestion[]>([]);
  const [chosenSlots, setChosenSlots] = useState<Record<number, number | null>>({});
  const [currentIdx, setCurrentIdx] = useState(0);
  const [readyAck, setReadyAck] = useState(false);
  const [pledgeSignature, setPledgeSignature] = useState('');
  const [autoSubmitting, setAutoSubmitting] = useState(false);
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [submittedAt, setSubmittedAt] = useState<Date | null>(null);
  const [autoSubmitted, setAutoSubmitted] = useState(false);
  const [submissionFilename, setSubmissionFilename] = useState<string>('');

  // Timer
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  const timerRef = useRef<number | null>(null);

  // Per-question time tracking (best-effort)
  const lastFocusTime = useRef<number>(0);
  const elapsedPerQuestion = useRef<Record<number, number>>({});

  // Wrong-app redirect: if the student loads a lab/homework assignment in this MQ app.
  const [wrongApp, setWrongApp] = useState<{ kind: 'lab' } | null>(null);

  // ---- Load assignment file ----
  const handleAssignmentFile = async (file: File) => {
    setError('');
    setWrongApp(null);
    try {
      const text = (await file.text()).trim();
      if (!isEncoded(text)) {
        throw new Error('File does not look like an encoded GradeBridge assignment (missing gb1: prefix).');
      }
      const obj = (await decryptJson(text)) as Record<string, unknown>;

      // Detect file type by shape:
      //   MQ assignments have a questionPool array.
      //   Lab assignments have a problems array (each problem has subsections).
      const looksLikeMq =
        obj && typeof obj === 'object' && Array.isArray((obj as { questionPool?: unknown[] }).questionPool);
      const looksLikeLab =
        obj && typeof obj === 'object' && Array.isArray((obj as { problems?: unknown[] }).problems);

      if (looksLikeLab && !looksLikeMq) {
        setWrongApp({ kind: 'lab' });
        return;
      }

      if (!looksLikeMq) {
        throw new Error('This does not look like a valid MQ assignment spec.');
      }

      const mq = obj as unknown as MQAssignmentSpec;
      if (mq.schema_version !== 1) {
        throw new Error(`Unsupported MQ schema_version: ${mq.schema_version}`);
      }
      setSpec(mq);
      setPhase('preamble');
    } catch (e) {
      setError(`Could not load assignment: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ---- Begin quiz: snapshot questions, start timer ----
  const beginQuiz = () => {
    if (!spec) return;
    const N = Math.min(spec.questionsPerStudent, spec.questionPool.length);
    const picked = sampleN(spec.questionPool, N);
    const ordered = spec.shuffleQuestions ? picked : picked;
    const presentedNow: PresentedQuestion[] = ordered.map((q) => {
      const order = spec.shuffleChoices
        ? shuffled(q.choices.map((_, i) => i))
        : q.choices.map((_, i) => i);
      return { question: q, presentedChoiceOrder: order };
    });
    setPresented(presentedNow);
    setChosenSlots(Object.fromEntries(presentedNow.map((p) => [p.question.id, null])));
    setCurrentIdx(0);
    setStartedAt(new Date());
    setSecondsLeft(spec.timeLimitMinutes * 60);
    setPhase('quiz');
    lastFocusTime.current = Date.now();
  };

  // ---- Timer tick ----
  // Runs across both 'quiz' and 'pledge' phases so a student cannot stall
  // by going to pledge and waiting. On expiration the submission is finalized
  // with whatever answers (and pledge signature, if any) have been entered.
  useEffect(() => {
    if (phase !== 'quiz' && phase !== 'pledge') return;
    timerRef.current = window.setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          if (timerRef.current) window.clearInterval(timerRef.current);
          setAutoSubmitted(true);
          setAutoSubmitting(true);
          setTimeout(() => void finalizeSubmission(true, ''), 0);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ---- Track time per question (rough) ----
  const handleChoose = (questionId: number, slot: number) => {
    const now = Date.now();
    const delta = lastFocusTime.current ? Math.round((now - lastFocusTime.current) / 1000) : 0;
    elapsedPerQuestion.current[questionId] =
      (elapsedPerQuestion.current[questionId] ?? 0) + delta;
    lastFocusTime.current = now;
    setChosenSlots((prev) => ({ ...prev, [questionId]: slot }));
  };

  // ---- Finalize submission: build JSON, encrypt, package as ZIP ----
  const finalizeSubmission = async (isAuto: boolean, pledgeName: string) => {
    if (!spec || !startedAt) return;
    setError('');
    const finishedAt = new Date();
    setSubmittedAt(finishedAt);

    const answers: AnswerRecord[] = presented.map((p) => ({
      question_id: p.question.id,
      chosen_index: chosenSlots[p.question.id] ?? null,
      presented_choices_order: p.presentedChoiceOrder,
      elapsed_seconds: elapsedPerQuestion.current[p.question.id] ?? 0,
    }));

    const submission: MQSubmission = {
      schema_version: 1,
      student_first_name: firstName.trim(),
      student_last_name: lastName.trim(),
      student_name: `${firstName.trim()} ${lastName.trim()}`.trim(),
      course_code: spec.courseCode,
      assignment_id: spec.id,
      assignment_title: spec.title,
      started_at: startedAt.toISOString(),
      submitted_at: finishedAt.toISOString(),
      duration_seconds: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
      time_limit_minutes: spec.timeLimitMinutes,
      auto_submitted: isAuto || autoSubmitted,
      pledge_signed: !isAuto && pledgeName.trim().length > 0,
      pledge_signature: !isAuto ? pledgeName.trim() : '',
      pledge_signed_at: !isAuto ? finishedAt.toISOString() : '',
      answers,
    };

    try {
      const encoded = await encryptJson(submission);

      const zip = new JSZip();
      const safeName = `${firstName}_${lastName}_${spec.courseCode}_mq`.replace(/[^a-z0-9_\-]/gi, '_');
      const jsonName = `${safeName}_submission.json`;
      zip.file(jsonName, encoded);

      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      const filename = `${safeName}_submission.zip`;
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setSubmissionFilename(filename);
      setPhase('submitted');
    } catch (e) {
      setError(`Could not generate submission: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const fmtTime = (s: number) => {
    const mm = Math.floor(s / 60).toString().padStart(2, '0');
    const ss = (s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  };

  const answeredCount = useMemo(
    () => Object.values(chosenSlots).filter((v) => v !== null).length,
    [chosenSlots]
  );

  // -------------------- Render --------------------

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="bg-slate-900 text-white p-4 shadow border-b border-slate-700">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold">
              Veri<span className="text-[#00A4E4]">Q</span>Ai
            </h1>
            <div className="text-xs text-slate-400">MQ Quiz</div>
          </div>
          {(phase === 'quiz' || phase === 'pledge') && (
            <div className="flex items-center gap-3 text-sm font-mono">
              <Clock className="w-4 h-4" />
              <span className={secondsLeft <= 60 ? 'text-red-300' : 'text-slate-200'}>
                {fmtTime(secondsLeft)}
              </span>
              <span className="text-slate-400">
                {answeredCount} / {presented.length} answered
              </span>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4 space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-300 text-red-800 p-3 rounded flex items-start gap-2">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError('')} className="text-red-600 hover:underline text-sm">dismiss</button>
          </div>
        )}

        {/* Phase: name */}
        {phase === 'name' && (
          <section className="bg-white rounded shadow p-6 space-y-4">
            <h2 className="text-xl font-semibold">Step 1: Enter your name</h2>
            <p className="text-sm text-gray-600">
              Use the same name your Gradescope account has. The grader compares
              this to the Gradescope account that uploads the submission; a
              mismatch is flagged for instructor review.
            </p>
            <p className="text-xs text-gray-500">
              Submit only your own work. Do not upload another student's file.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm text-gray-700">First name</span>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="w-full border rounded px-3 py-2 mt-1"
                />
              </label>
              <label className="block">
                <span className="text-sm text-gray-700">Last name</span>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="w-full border rounded px-3 py-2 mt-1"
                />
              </label>
            </div>
            <button
              onClick={() => {
                if (!firstName.trim() || !lastName.trim()) {
                  setError('Please enter both first and last name.');
                  return;
                }
                setPhase('load');
              }}
              className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded font-semibold"
            >
              Continue
            </button>
          </section>
        )}

        {/* Phase: load */}
        {phase === 'load' && (
          <section className="bg-white rounded shadow p-6 space-y-4">
            <h2 className="text-xl font-semibold">Step 2: Load assignment file</h2>
            <p className="text-sm text-gray-600">
              Your instructor will provide a `.json` assignment file (encrypted). Upload it here.
            </p>

            {wrongApp?.kind === 'lab' ? (
              <div className="border-2 border-amber-500 bg-amber-50 rounded p-4 space-y-2">
                <h3 className="font-bold text-amber-900 flex items-center gap-2">
                  <AlertCircle className="w-5 h-5" />
                  This is a lab/homework assignment, not an MQ quiz.
                </h3>
                <p className="text-sm text-amber-900">
                  The file you loaded looks like a regular GradeBridge lab or
                  homework assignment (it has problems with subsections). This
                  app only handles timed multiple-choice quizzes.
                </p>
                <p className="text-sm text-amber-900">
                  Please use the lab Student Submission app instead:
                </p>
                <a
                  href="https://bridgesuite.github.io/GradeBridge-Student-Submission/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block px-4 py-2 bg-amber-700 hover:bg-amber-800 text-white rounded font-semibold"
                >
                  Open lab Student Submission &rarr;
                </a>
                <button
                  onClick={() => setWrongApp(null)}
                  className="block text-xs text-amber-700 hover:underline mt-2"
                >
                  Try a different file
                </button>
              </div>
            ) : (
              <>
                <label className="flex items-center gap-2 px-4 py-2 bg-blue-100 hover:bg-blue-200 rounded cursor-pointer w-fit">
                  <Upload className="w-4 h-4" />
                  <span>Choose .json file</span>
                  <input
                    type="file"
                    accept=".json"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleAssignmentFile(f);
                    }}
                    className="hidden"
                  />
                </label>
                <button
                  onClick={() => setPhase('name')}
                  className="text-sm text-gray-500 hover:underline"
                >
                  Back
                </button>
              </>
            )}
          </section>
        )}

        {/* Phase: preamble */}
        {phase === 'preamble' && spec && (
          <section className="bg-white rounded shadow p-6 space-y-4">
            <div className="text-xs uppercase tracking-wide text-blue-700 font-semibold">
              {spec.courseCode}
            </div>
            <h2 className="text-2xl font-bold">{spec.title}</h2>
            {spec.variant_label && (
              <div className="bg-purple-50 border border-purple-300 rounded px-3 py-2 text-sm text-purple-900">
                <span className="font-semibold">Accommodation variant:</span> {spec.variant_label}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 text-sm bg-blue-50 border border-blue-200 rounded p-3">
              <div>
                <span className="font-semibold">Time limit:</span> {spec.timeLimitMinutes} minutes
              </div>
              <div>
                <span className="font-semibold">Questions:</span> {spec.questionsPerStudent}
              </div>
              <div>
                <span className="font-semibold">Due:</span> {spec.dueDate} {spec.dueTime}
              </div>
              <div>
                <span className="font-semibold">Pool size:</span> {spec.questionPool.length}
              </div>
            </div>

            {spec.preamble && (
              <div className="bg-gray-50 border border-gray-200 rounded p-3 text-sm text-gray-800 whitespace-pre-wrap">
                {spec.preamble}
              </div>
            )}

            <div className="bg-amber-50 border-l-4 border-amber-500 rounded p-4 space-y-2">
              <h3 className="font-bold text-amber-900 flex items-center gap-2">
                <FileWarning className="w-5 h-5" />
                Before you begin
              </h3>
              <p className="text-sm text-amber-900">
                <strong>Do not start this evaluation if you have not finished
                reading and studying.</strong> Once you click Begin, the timer
                starts and cannot be paused. If you close the tab or refresh,
                your in-progress answers are lost.
              </p>
            </div>

            <div className="bg-blue-50 border-l-4 border-blue-500 rounded p-4 space-y-2">
              <h3 className="font-bold text-blue-900 flex items-center gap-2">
                <ShieldCheck className="w-5 h-5" />
                Honor Code expectations
              </h3>
              <p className="text-sm text-blue-900">
                During this assessment you may <strong>not</strong> use any
                assistance from AI tools or from any other party. This must be
                your own work.
              </p>
              <p className="text-sm text-blue-900">
                The studying you did before starting this quiz is permitted; the
                restriction applies only during the timed assessment. You may
                refer to information from the course reader.
              </p>
            </div>

            <label className="flex items-start gap-3 p-3 border border-gray-300 rounded bg-white cursor-pointer">
              <input
                type="checkbox"
                checked={readyAck}
                onChange={(e) => setReadyAck(e.target.checked)}
                className="mt-1"
              />
              <span className="text-sm text-gray-800">
                I have completed my preparation and I understand the Honor Code
                expectations above. I am ready to begin this timed assessment
                under these conditions.
              </span>
            </label>

            <button
              onClick={beginQuiz}
              disabled={!readyAck}
              className={`px-5 py-2.5 rounded font-bold flex items-center gap-2 ${
                readyAck
                  ? 'bg-blue-600 hover:bg-blue-500 text-white'
                  : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
            >
              <Play className="w-4 h-4" />
              Begin quiz
            </button>
          </section>
        )}

        {/* Phase: quiz - one question at a time, with prev/next + palette */}
        {phase === 'quiz' && spec && presented.length > 0 && (() => {
          const safeIdx = Math.min(Math.max(currentIdx, 0), presented.length - 1);
          const p = presented[safeIdx];
          const q = p.question;
          const chosen = chosenSlots[q.id];
          const isLast = safeIdx === presented.length - 1;
          const isFirst = safeIdx === 0;
          const goPrev = () => {
            if (!isFirst) {
              setCurrentIdx(safeIdx - 1);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }
          };
          const goNext = () => {
            if (!isLast) {
              setCurrentIdx(safeIdx + 1);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }
          };
          const goTo = (i: number) => {
            setCurrentIdx(i);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          };
          return (
            <section className="space-y-4">
              {/* Question palette */}
              <div className="bg-white rounded shadow p-3">
                <div className="text-xs text-gray-500 mb-2">
                  Jump to question:
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {presented.map((pp, i) => {
                    const answered = chosenSlots[pp.question.id] !== null && chosenSlots[pp.question.id] !== undefined;
                    const isCurrent = i === safeIdx;
                    return (
                      <button
                        key={pp.question.id}
                        onClick={() => goTo(i)}
                        className={`w-9 h-9 rounded text-sm font-semibold border-2 transition ${
                          isCurrent
                            ? 'bg-blue-600 border-blue-700 text-white'
                            : answered
                            ? 'bg-blue-100 border-blue-300 text-blue-900 hover:bg-blue-200'
                            : 'bg-gray-50 border-gray-300 text-gray-700 hover:bg-gray-100'
                        }`}
                        aria-label={`Go to question ${i + 1}${answered ? ' (answered)' : ' (unanswered)'}${isCurrent ? ' (current)' : ''}`}
                      >
                        {i + 1}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Current question */}
              <div className="bg-white rounded shadow p-6">
                <div className="text-xs text-gray-500 mb-1">
                  Question {safeIdx + 1} of {presented.length}
                  {q.points !== 1 && <> &middot; {q.points} points</>}
                </div>
                <div className="text-sm font-medium mb-2">
                  <KatexText text={q.title} enabled={q.katex_present} />
                </div>
                <div className="text-base text-gray-900 mb-4 whitespace-pre-wrap">
                  <KatexText text={q.question_text} enabled={q.katex_present} />
                </div>
                <div className="space-y-2">
                  {p.presentedChoiceOrder.map((origIdx, slot) => {
                    const choice = q.choices[origIdx];
                    const selected = chosen === slot;
                    return (
                      <label
                        key={slot}
                        className={`flex items-start gap-2 border-2 rounded p-3 cursor-pointer transition ${
                          selected
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:bg-gray-50'
                        }`}
                      >
                        <input
                          type="radio"
                          name={`q_${q.id}`}
                          checked={selected}
                          onChange={() => handleChoose(q.id, slot)}
                          className="mt-1"
                        />
                        <span className="text-sm">
                          <span className="font-semibold mr-1">
                            {String.fromCharCode(65 + slot)}.
                          </span>
                          <KatexText text={choice} enabled={q.katex_present} />
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Sticky bottom bar with nav and submit */}
              <div className="bg-white rounded shadow p-3 sticky bottom-2 flex flex-wrap items-center justify-between gap-2">
                <button
                  onClick={goPrev}
                  disabled={isFirst}
                  className={`px-3 py-2 rounded font-medium flex items-center gap-1 ${
                    isFirst
                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                      : 'bg-gray-200 hover:bg-gray-300 text-gray-800'
                  }`}
                >
                  <ChevronLeft className="w-4 h-4" />
                  Previous
                </button>

                <div className="text-sm text-gray-700">
                  {answeredCount} / {presented.length} answered
                </div>

                {!isLast ? (
                  <button
                    onClick={goNext}
                    className="px-3 py-2 rounded font-medium bg-gray-200 hover:bg-gray-300 text-gray-800 flex items-center gap-1"
                  >
                    Next
                    <ChevronRight className="w-4 h-4" />
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      if (
                        answeredCount < presented.length &&
                        !window.confirm(
                          `You have ${presented.length - answeredCount} unanswered question(s). Continue to the pledge step anyway?`
                        )
                      ) {
                        return;
                      }
                      setPhase('pledge');
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    className="px-4 py-2 rounded font-bold bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-2"
                  >
                    Continue to pledge
                    <ChevronRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            </section>
          );
        })()}

        {/* Phase: pledge - sign before download */}
        {phase === 'pledge' && spec && (() => {
          const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();
          const sigNorm = pledgeSignature.trim().toLowerCase().replace(/\s+/g, ' ');
          const nameNorm = fullName.toLowerCase().replace(/\s+/g, ' ');
          const signatureMatches = sigNorm.length > 0 && sigNorm === nameNorm;
          return (
            <section className="bg-white rounded shadow p-6 space-y-4">
              <h2 className="text-2xl font-bold flex items-center gap-2">
                <ShieldCheck className="w-6 h-6 text-blue-600" />
                Sign the pledge to submit
              </h2>

              <div className="grid grid-cols-2 gap-2 text-sm bg-gray-50 border border-gray-200 rounded p-3">
                <div><span className="font-semibold">Name:</span> {fullName}</div>
                <div><span className="font-semibold">Course:</span> {spec.courseCode}</div>
                <div><span className="font-semibold">Assignment:</span> {spec.title}</div>
                <div><span className="font-semibold">Answered:</span> {answeredCount} / {presented.length}</div>
              </div>

              <div className="bg-blue-50 border-l-4 border-blue-500 rounded p-4 space-y-2 text-sm text-blue-900">
                <p className="font-semibold">By signing my name below I attest that:</p>
                <ul className="list-disc ml-5 space-y-1">
                  <li>This submission represents entirely my own work.</li>
                  <li>I did not use AI tools, generative models, or automated answer lookup during this assessment.</li>
                  <li>I did not consult other students, tutors, or any third party during this assessment.</li>
                  <li>I understand that violation of this pledge constitutes academic misconduct.</li>
                </ul>
              </div>

              <label className="block">
                <span className="text-sm text-gray-700">
                  Type your full name to sign (must match the name you entered at the start of the quiz):
                </span>
                <input
                  type="text"
                  value={pledgeSignature}
                  onChange={(e) => setPledgeSignature(e.target.value)}
                  placeholder={fullName}
                  className="w-full border-2 rounded px-3 py-2 mt-1 font-serif italic text-lg"
                />
                {pledgeSignature.length > 0 && !signatureMatches && (
                  <p className="text-xs text-red-600 mt-1">
                    Signature does not match the name on file ({fullName}).
                  </p>
                )}
              </label>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => {
                    setPhase('quiz');
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300 text-gray-800 font-medium flex items-center gap-1"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Back to quiz
                </button>
                <button
                  onClick={() => void finalizeSubmission(false, pledgeSignature.trim())}
                  disabled={!signatureMatches}
                  className={`px-5 py-2.5 rounded font-bold flex items-center gap-2 ${
                    signatureMatches
                      ? 'bg-blue-600 hover:bg-blue-500 text-white'
                      : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  }`}
                >
                  <Download className="w-4 h-4" />
                  Sign and download submission
                </button>
              </div>
            </section>
          );
        })()}

        {/* Phase: submitted */}
        {phase === 'submitted' && spec && (
          <section className="bg-white rounded shadow p-6 space-y-4">
            <div className="flex items-center gap-2 text-green-700">
              <CheckCircle2 className="w-6 h-6" />
              <h2 className="text-xl font-bold">Submission generated</h2>
            </div>
            {autoSubmitted && (
              <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                Time expired. Your answers were submitted automatically.
              </div>
            )}
            <div className="text-sm text-gray-700 space-y-1">
              <div>
                <strong>File:</strong> {submissionFilename}
              </div>
              <div>
                <strong>Started:</strong> {startedAt?.toLocaleString()}
              </div>
              <div>
                <strong>Submitted:</strong> {submittedAt?.toLocaleString()}
              </div>
              <div>
                <strong>Answered:</strong> {answeredCount} / {presented.length}
              </div>
            </div>
            <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm">
              <strong>Next step:</strong> upload the downloaded ZIP file to the
              corresponding Gradescope assignment for this course. The file is
              encrypted and will be graded automatically.
            </div>
          </section>
        )}
      </main>
    </div>
  );
};

export default App;
