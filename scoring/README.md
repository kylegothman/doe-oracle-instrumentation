# Scoring the answers against the expert

This folder scores every answer in a harness export against Dr. Wong's answers. It runs outside the harness. Nothing here calls the DOE Oracle, Copilot, or Google: the answers come from the export, and promptfoo's `echo` provider hands each one back for checking.

## What you need

- Python 3.9 or newer, with PyYAML (`pip install pyyaml`). Reading an `.xlsx` export also needs `openpyxl`; a `.csv` export does not.
- Node.js 20 or newer. The scripts run `npx promptfoo@0.126.0`, so nothing has to be installed first.
- An API key for each judge, in a file named `.env` in this folder. Copy `.env.example` and fill it in. Never commit `.env`.

## Running it

Run every command from this folder.

1. Review `expert-answer-key.yaml` as a team and change `status: draft` to `status: frozen`. Do this before anyone reads the subjects' answers.
2. Check that every step works, with no API key and no network:

   ```
   python3 run_scoring.py path/to/TestLog-2026-11-28.csv --dry-run
   ```

3. Check the keys and the model names by sending two answers to each real judge:

   ```
   python3 run_scoring.py path/to/TestLog-2026-11-28.csv --smoke 2
   ```

4. Run the full scoring:

   ```
   python3 run_scoring.py path/to/TestLog-2026-11-28.csv
   ```

If the export holds practice trials as well, limit it with `--session <session ID>` (repeat the flag for several sessions) or with `--from-test` and `--to-test`. If one judge fails, run it again alone with `--only-judge <name>`; the other judges' results are kept.

## What comes out

Everything is written to `out/`.

| File | What it holds |
|---|---|
| `scores.csv` | One row per answer: every measure, each judge's result, and the panel result |
| `by_subject.csv` | One row per subject, for the headline chart |
| `by_question.csv` | Key-point coverage by question and subject, for the question table |
| `judge_agreement.csv` | How often the judges made the same decision |
| `judge_reasons.csv` | Every decision with the judge's reason, for the check by hand |
| `problems.txt` | Decisions that did not come back, if any |

## What is measured

| Measure | How | Decided by |
|---|---|---|
| Key terms | Share of the expert's term groups that appear in the answer. A group counts once, whichever wording appears | Code |
| Length | Words in the answer | Code |
| Meaning match | Cosine similarity between the answer and the expert's answer, from an embedding model | Code |
| Key-point coverage | Share of the expert's key points the answer states, in any wording. One decision per key point | Judges |
| Contradicts the expert | Whether any statement disagrees with the expert's answer | Judges |
| Made-up facts | Whether the answer contains a false or invented specific | Judges |
| Declines or hedges | Whether the answer says it does not know or is outside its sources | Judges |
| Gives an example | Whether the answer includes a concrete example or worked numbers | Judges |

The judges are listed in `judges.json`. Each one makes every decision once. The panel result for key-point coverage is the median of the judges, and for the yes or no checks it is the majority.

## Choices built into the scripts

- **The judge is blind to the subject.** It is given the answer, the question, the expert's answer, and the criterion. The subject and the test number stay in the test's metadata, which promptfoo does not send to the judge. An answer can still give its source away in its own words.
- **One answer per subject and question.** If a subject has several answered trials for a question, the newest is used and a warning names the others. Add `--strict` to stop instead.
- **A question with no answer scores zero.** A Google trial saved as "no answer found", a failed request, or a missing trial counts as zero on key points, key terms, and examples, and is listed with its status in `scores.csv`.
- **A decision that does not come back is left out.** If a judge call fails, that decision is listed in `problems.txt` and the panel result is formed from the judges that did answer.
- **Replies are cached.** A second run reuses saved replies. Add `--no-cache` to ask every judge again.
- **The promptfoo version is pinned** in `run_scoring.py`, so the judge's instructions stay the same for the whole study.

## Files

| File | Purpose |
|---|---|
| `expert-answer-key.yaml` | The expert's answers, key points, and key terms |
| `build_tests.py` | Turns an export and the answer key into promptfoo test cases |
| `promptfooconfig.code.yaml`, `checks.js` | The code checks |
| `promptfooconfig.judge.yaml` | The judge checks |
| `judges.json` | The judges and their promptfoo provider IDs |
| `run_scoring.py` | Runs every step |
| `summarize.py` | Builds the score tables from promptfoo's results |
| `stand_in_judge.js` | The stand-in judge used by `--dry-run` |

## Status

Every step has been run end to end on the practice exports with the stand-in judge. No real judge has been called yet. The first `--smoke 2` run is the check that the three provider IDs in `judges.json` and the embedding model are accepted.
