#!/usr/bin/env python3
"""Turn a harness export and the expert answer key into promptfoo test cases.

Usage:
    python3 build_tests.py EXPORT [--key expert-answer-key.yaml] [--out out]
                           [--session ID ...] [--from-test N] [--to-test N]
                           [--embedding PROVIDER] [--strict]

EXPORT is the TestLog file the harness wrote: the .csv (its "-supplementary.csv"
is read from the same folder) or the .xlsx workbook.

It writes three files to the output folder:
    tests.code.json    code checks: key terms and similarity to the expert's answer
    tests.judge.json   the checks an LLM judge makes
    manifest.json      every answer that was selected, scored or not

The judge is blind to the subject. A test case carries the answer, the question,
the expert's answer and the criterion. The subject and the test number travel in
the test's metadata, which promptfoo keeps out of the judge's prompt.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

SUBJECTS = ["DOE Oracle", "Microsoft Copilot", "Google Search"]
EXPERT = "Expert"
DEFAULT_EMBEDDING = "openai:embedding:text-embedding-3-large"

LOG_COLUMNS = {
    "Test #": "test",
    "Question Number": "question",
    "Test Subject": "subject",
    "Answer Text": "answer",
    "User Email": "session",
    "Begin Timestamp": "begin",
}


def fail(message: str) -> None:
    sys.exit(f"build_tests: {message}")


def read_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.reader(handle))
    if not rows:
        return []
    header = [cell.strip() for cell in rows[0]]
    return [dict(zip(header, row)) for row in rows[1:] if any(cell.strip() for cell in row)]


def read_sheet(workbook, name: str) -> list[dict]:
    if name not in workbook.sheetnames:
        return []
    table = [[cell for cell in row] for row in workbook[name].iter_rows(values_only=True)]
    for index, row in enumerate(table):
        if any(isinstance(cell, str) and cell.strip() == "Test #" for cell in row):
            header = [cell.strip() if isinstance(cell, str) else cell for cell in row]
            return [
                {key: ("" if value is None else value) for key, value in zip(header, body) if key}
                for body in table[index + 1:]
                if any(value is not None for value in body)
            ]
    return []


def read_export(path: Path) -> tuple[list[dict], list[dict]]:
    """Returns (log rows, supplementary rows) with trimmed header names."""
    if path.suffix.lower() == ".csv":
        supplementary = path.with_name(path.stem + "-supplementary.csv")
        return read_csv(path), (read_csv(supplementary) if supplementary.exists() else [])
    if path.suffix.lower() == ".xlsx":
        try:
            import openpyxl
        except ImportError:
            fail("reading a workbook needs openpyxl (pip install openpyxl), or export as CSV instead")
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
        return read_sheet(workbook, workbook.sheetnames[0]), read_sheet(workbook, "Supplementary")
    fail(f"{path.name}: expected a .csv or .xlsx export")
    return [], []


def load_key(path: Path) -> dict:
    try:
        import yaml
    except ImportError:
        fail("reading the answer key needs PyYAML (pip install pyyaml)")
    key = yaml.safe_load(path.read_text(encoding="utf-8"))
    questions = {int(entry["number"]): entry for entry in key["questions"]}
    if sorted(questions) != list(range(1, 13)):
        fail("the answer key must have questions 1 to 12")
    key["by_number"] = questions
    return key


def as_int(value) -> int | None:
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return None


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def count_words(text: str) -> int:
    return len(re.findall(r"\S+", text))


def select_answers(log: list[dict], supplementary: list[dict], args, warnings: list[str]):
    """One answer per subject and question: the newest successful trial, else the newest attempt."""
    failure_of = {as_int(row.get("Test #")): str(row.get("Failure Type") or "").strip() for row in supplementary}
    trials, expert_rows = [], []
    for raw in log:
        row = {short: raw.get(column, "") for column, short in LOG_COLUMNS.items()}
        test, question = as_int(row["test"]), as_int(row["question"])
        subject = str(row["subject"]).strip()
        if test is None or question is None:
            continue
        session = str(row["session"]).strip()
        if args.session and not any(session.startswith(wanted) for wanted in args.session):
            continue
        if args.from_test is not None and test < args.from_test:
            continue
        if args.to_test is not None and test > args.to_test:
            continue
        answer = str(row["answer"] or "").strip()
        entry = {"testNumber": test, "question": question, "subject": subject, "answer": answer, "session": session}
        if subject == EXPERT:
            expert_rows.append(entry)
            continue
        if subject not in SUBJECTS:
            warnings.append(f"Test #{test}: unknown subject {subject!r}, left out")
            continue
        failure = failure_of.get(test, "")
        entry["status"] = "failed" if failure else ("answered" if answer else "no_answer")
        entry["failureType"] = failure
        trials.append(entry)

    selected = []
    for subject in SUBJECTS:
        for question in range(1, 13):
            attempts = sorted(
                (t for t in trials if t["subject"] == subject and t["question"] == question),
                key=lambda t: t["testNumber"],
            )
            if not attempts:
                warnings.append(f"{subject}, question {question}: no trial in the export")
                selected.append({"subject": subject, "question": question, "status": "missing", "testNumber": None, "answer": "", "failureType": "", "session": ""})
                continue
            answered = [t for t in attempts if t["status"] == "answered"]
            chosen = (answered or attempts)[-1]
            if len(answered) > 1:
                others = ", ".join(f"#{t['testNumber']}" for t in answered[:-1])
                message = f"{subject}, question {question}: {len(answered)} answered trials; using #{chosen['testNumber']}, ignoring {others}"
                if args.strict:
                    fail(message + " (--strict)")
                warnings.append(message)
            selected.append(dict(chosen))
    return selected, expert_rows


def key_term_groups(entry: dict) -> list[list[str]]:
    return [[group["term"], *group.get("also_accept", [])] for group in entry.get("key_terms", [])]


def judge_asserts(entry: dict) -> list[dict]:
    question = entry["question"]
    expert = "{{expert}}"
    notes = entry.get("judge_notes") or []
    note_text = ("\n\nNotes for this question:\n" + "\n".join(f"- {note}" for note in notes)) if notes else ""
    head = f"Question asked: {question}\n"
    reference = f"The expert's answer, to be treated as correct:\n{expert}\n\n"
    checks = []
    for index, point in enumerate(entry["key_points"], start=1):
        checks.append({
            "type": "llm-rubric",
            "metric": f"key_point_{index}",
            "value": head + f"Key point from the expert's answer: {point}\n\n"
            "Pass if the output states this key point, or clearly conveys the same meaning in other words. "
            "A vague or partial mention that leaves out the substance of the point fails. Judge only this one point.",
        })
    checks.append({
        "type": "llm-rubric",
        "metric": "no_contradiction",
        "value": head + reference
        + "Pass if nothing in the output contradicts the expert's answer. Fail if any statement disagrees with it: "
        "a different number, an opposite claim, or accepting something the expert rejects. "
        "Detail the expert does not mention is not a contradiction. An output that gives no answer passes." + note_text,
    })
    checks.append({
        "type": "llm-rubric",
        "metric": "no_made_up_facts",
        "value": head + reference
        + "Pass if the output contains no fabricated or false specifics: wrong numbers, invented definitions, "
        "or invented names, sources or findings. Correct detail beyond the expert's answer is fine. "
        "Fail if any specific claim is false, or if the output answers about a different subject than the question asks about.",
    })
    checks.append({
        "type": "llm-rubric",
        "metric": "declines_or_hedges",
        "value": head
        + "Pass if the output declines to answer, says it does not know, says the question is outside its sources or scope, "
        "or presents its whole answer as uncertain. Fail if it answers with confidence.",
    })
    checks.append({
        "type": "llm-rubric",
        "metric": "gives_example",
        "value": head
        + "Pass if the output includes at least one concrete example, a worked calculation, or specific numbers that illustrate the answer. "
        "A definition or a general description alone fails.",
    })
    return checks


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("export", type=Path)
    parser.add_argument("--key", type=Path, default=Path(__file__).with_name("expert-answer-key.yaml"))
    parser.add_argument("--out", type=Path, default=Path("out"))
    parser.add_argument("--session", action="append", default=[], help="only trials of this session ID (or its first characters); repeatable")
    parser.add_argument("--from-test", type=int, help="only trials with this test number or higher")
    parser.add_argument("--to-test", type=int, help="only trials with this test number or lower")
    parser.add_argument("--embedding", default=DEFAULT_EMBEDDING, help="promptfoo embedding provider for the similarity check")
    parser.add_argument("--strict", action="store_true", help="stop if a subject has more than one answered trial for a question")
    args = parser.parse_args()

    key = load_key(args.key)
    log, supplementary = read_export(args.export)
    if not log:
        fail(f"{args.export.name}: no rows found")

    warnings: list[str] = []
    if str(key.get("status", "")).strip().lower() != "frozen":
        warnings.append(f"the answer key's status is {key.get('status')!r}, not 'frozen'")
    selected, expert_rows = select_answers(log, supplementary, args, warnings)

    for row in expert_rows:
        expected = key["by_number"].get(row["question"], {}).get("expert_answer", "")
        if squash(row["answer"]) != squash(expected):
            warnings.append(f"Test #{row['testNumber']}: the expert's answer to question {row['question']} in the export differs from the answer key")

    code_tests, judge_tests, manifest = [], [], []
    for item in selected:
        entry = key["by_number"][item["question"]]
        subject_code = {"DOE Oracle": "oracle", "Microsoft Copilot": "copilot", "Google Search": "google"}[item["subject"]]
        answer_id = f"{subject_code}-q{item['question']:02d}"
        manifest.append({
            "answerId": answer_id,
            "subject": item["subject"],
            "question": item["question"],
            "category": entry.get("category", ""),
            "testNumber": item["testNumber"],
            "status": item["status"],
            "failureType": item.get("failureType", ""),
            "words": count_words(item["answer"]),
            "keyPoints": len(entry["key_points"]),
            "keyTermGroups": len(entry.get("key_terms", [])),
        })
        if item["status"] != "answered":
            continue
        metadata = {"answerId": answer_id, "subject": item["subject"], "question": item["question"], "testNumber": item["testNumber"]}
        variables = {"answer": item["answer"], "expert": entry["expert_answer"].strip()}
        code_tests.append({
            "description": f"Test #{item['testNumber']}, question {item['question']}",
            "vars": variables,
            "metadata": metadata,
            "assert": [
                {"type": "javascript", "metric": "key_terms", "value": "file://checks.js:keyTerms", "config": {"groups": key_term_groups(entry)}},
                {"type": "similar", "metric": "meaning_match", "value": "{{expert}}", "threshold": 0, "provider": args.embedding},
            ],
        })
        judge_tests.append({
            "description": f"Test #{item['testNumber']}, question {item['question']}",
            "vars": variables,
            "metadata": metadata,
            "assert": judge_asserts(entry),
        })

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "tests.code.json").write_text(json.dumps(code_tests, indent=1, ensure_ascii=False), encoding="utf-8")
    (args.out / "tests.judge.json").write_text(json.dumps(judge_tests, indent=1, ensure_ascii=False), encoding="utf-8")
    (args.out / "manifest.json").write_text(json.dumps({
        "export": args.export.name,
        "answerKey": {"file": args.key.name, "version": key.get("version"), "status": key.get("status")},
        "embedding": args.embedding,
        "answers": manifest,
        "warnings": warnings,
    }, indent=1, ensure_ascii=False), encoding="utf-8")

    counts = {status: sum(1 for m in manifest if m["status"] == status) for status in ("answered", "no_answer", "failed", "missing")}
    judged = sum(len(test["assert"]) for test in judge_tests)
    print(f"{len(manifest)} answers selected: {counts['answered']} answered, {counts['no_answer']} no answer found, {counts['failed']} failed, {counts['missing']} missing")
    print(f"{len(code_tests)} code tests and {len(judge_tests)} judge tests ({judged} judge decisions per judge) written to {args.out}/")
    for warning in warnings:
        print(f"warning: {warning}")


if __name__ == "__main__":
    main()
