# GradeBridge MQ Student Submission

Take a timed multiple-choice assessment in the browser. Pledge-signed, encrypted, ready to upload to Gradescope.

![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

**[Live Demo](https://veriqai.github.io/GradeBridge-MQ-Student-Submission/)**

---

## The Problem

**LMS quiz tools** lock you into a single platform and can leave you scrambling when the LMS goes down.

**GradeBridge MQ workflow:** an instructor exports an encrypted assignment file from the **[MQ Assignment Maker](https://github.com/VeriQAi/GradeBridge-MQ-Assignment-Maker)**. The student loads it here, takes the timed quiz, signs the honor pledge, and downloads a single ZIP to upload to Gradescope. A Python autograder running in Gradescope decrypts the submission and grades automatically.

**The three-component workflow:**

1. **[MQ Assignment Maker](https://github.com/VeriQAi/GradeBridge-MQ-Assignment-Maker)** — Instructor builds the encrypted assignment file.
2. **MQ Student Submission** (this app) — Student takes the timed quiz and downloads the encrypted submission ZIP.
3. **MQ Autograder** (Python, Docker) — Runs in Gradescope, scores the submission, returns Gradescope `results.json`.

---

## Key Features

- **100% Browser-Based** — No backend, no account, no data leaves your machine until you submit.
- **Timed quiz with hard cutoff** — Visible countdown; auto-submit on expiration. Timer stays alive across the quiz and pledge phases so a student cannot stall.
- **One question at a time** — Plus a numbered palette to jump to any question, and Previous/Next navigation.
- **Random per session** — Picks N random questions from the pool; optionally shuffles answer choices. The original choice order is recorded so the autograder maps shuffled answers back correctly.
- **KaTeX math** — Renders `$ ... $`, `$$ ... $$`, `\( ... \)`, and `\[ ... \]` LaTeX delimiters in question text and answer choices.
- **Honor Code expectations and pledge** — Explicit pre-quiz acknowledgment and a typed-name pledge signature before the submission download.
- **Identity check** — On the Gradescope side, the autograder compares the typed student name to the authenticated submitter and flags mismatches for instructor review.
- **Accommodation aware** — If the instructor distributes a 1.5x or 2x variant file, the app honors the longer time limit and shows the accommodation label on the start screen.
- **Wrong-app detection** *(planned)* — Loading a lab/homework `.json` here will show a friendly "you have the wrong app" redirect.
- **AES-256-GCM encryption** — Submission JSON is encrypted client-side before download. Tampering between download and upload is detected.

---

## Quick Start

### Take a Quiz

1. Get the encrypted assignment `.json` file from your instructor.
2. Go to the [Live Demo](https://veriqai.github.io/GradeBridge-MQ-Student-Submission/).
3. Enter your **first and last name** as they appear in your Gradescope account.
4. Click **Choose .json file** and pick the file your instructor sent.
5. Read the **Honor Code expectations** on the preamble screen, check the acknowledgment box, and click **Begin quiz**.
6. Answer questions. Use the numbered palette to jump back to any question. The timer is visible at the top.
7. On the last question, click **Continue to pledge**. Type your full name to sign the honor pledge.
8. Click **Sign and download submission**. A ZIP file lands in your Downloads folder.
9. Upload the ZIP to the corresponding Gradescope assignment.

### If your time runs out

The app auto-submits whatever answers you have entered. Your submission is marked `auto_submitted: true` and `pledge_signed: false`, so the instructor knows the timer expired before you signed.

### Local Development

```bash
git clone https://github.com/VeriQAi/GradeBridge-MQ-Student-Submission.git
cd GradeBridge-MQ-Student-Submission
npm install
npm run dev
```

The dev server opens at `http://localhost:5173` (Vite default).

### Deploy

```bash
npm run deploy
```

Builds with the `/GradeBridge-MQ-Student-Submission/` base path and pushes the `dist/` folder to the `gh-pages` branch.

---

## Submission JSON Format

After the quiz, the app generates this object, encrypts it with AES-256-GCM, and packages the encrypted blob into a ZIP for Gradescope:

```json
{
  "schema_version": 1,
  "student_first_name": "Jane",
  "student_last_name": "Smith",
  "student_name": "Jane Smith",
  "course_code": "EEC1",
  "assignment_id": "uuid-from-spec",
  "assignment_title": "Module 7 Reading Check",
  "started_at": "2026-05-08T14:00:00Z",
  "submitted_at": "2026-05-08T14:12:30Z",
  "duration_seconds": 750,
  "time_limit_minutes": 15,
  "auto_submitted": false,
  "pledge_signed": true,
  "pledge_signature": "Jane Smith",
  "pledge_signed_at": "2026-05-08T14:12:30Z",
  "answers": [
    {
      "question_id": 123,
      "chosen_index": 2,
      "presented_choices_order": [3, 0, 1, 2],
      "elapsed_seconds": 45
    }
  ]
}
```

`chosen_index` is the slot the student clicked (after choice shuffling). `presented_choices_order[chosen_index]` gives the original choice index, which the autograder compares to `correct_answer_index` from the assignment spec.

---

## Phases

| Phase | Description |
|---|---|
| `name` | Student enters first and last name. |
| `load` | Student loads the encrypted assignment file. |
| `preamble` | Honor Code expectations shown; student must check the acknowledgment box to enable Begin. |
| `quiz` | Timed multiple-choice quiz, one question at a time. |
| `pledge` | Student types name to sign the honor pledge. Timer continues running. |
| `submitted` | Confirmation; ZIP has been downloaded. |

---

## Crypto Contract

Shares the AES-256-GCM key with the rest of the GradeBridge MQ ecosystem:

- `GradeBridge-MQ-Assignment-Maker/cryptoService.ts`
- `GradeBridge-MQ-Autograder/crypto_utils.py`

Wire format: `gb1:` + base64(IV[12 bytes] || ciphertext || GCM tag[16 bytes]).

The submission ZIP contains a single `.json` file (encrypted). Gradescope automatically extracts the ZIP into `/autograder/submission/`, where the autograder finds the `gb1:`-prefixed file.

---

## Tech

- TypeScript + React 18 + Vite
- Tailwind CSS (via CDN at runtime)
- KaTeX (via CDN at runtime)
- JSZip for the submission ZIP
- lucide-react icons
- Web Crypto API (browser native)
- gh-pages for deployment

---

## License

MIT
