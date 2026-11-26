#!/usr/bin/env python3
"""Combine the promptfoo results into the score tables.

Usage:
    python3 summarize.py [--out out]

Reads out/manifest.json, out/results.code.json and every out/results.judge.<name>.json.
Writes to the same folder:
    scores.csv           one row per answer, every measure, each judge and the panel result
    by_subject.csv       one row per subject
    by_question.csv      key-point coverage, question by subject
    judge_agreement.csv  how the judges compare with each other
    judge_reasons.csv    every judge decision with the judge's reason, for checking by hand

How the panel result is formed:
    key-point coverage    the median of the judges' coverage for that answer
    yes/no checks         the majority of the judges
An answer that was not given (no answer found, a failed request, or no trial) scores
zero on key points, key terms and examples, and is listed with its status.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import statistics
import sys
from itertools import combinations
from pathlib import Path

SUBJECTS = ["DOE Oracle", "Microsoft Copilot", "Google Search"]
YES_NO = ["contradicts_expert", "made_up_facts", "declines_or_hedges", "gives_example"]
# metric in the test file -> (column, whether a pass means "no")
JUDGE_METRICS = {
    "no_contradiction": ("contradicts_expert", True),
    "no_made_up_facts": ("made_up_facts", True),
    "declines_or_hedges": ("declines_or_hedges", False),
    "gives_example": ("gives_example", False),
}


def load_results(path: Path) -> dict:
    """answerId -> list of component results."""
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data["results"]["results"]
    by_answer = {}
    for row in rows:
        meta = row.get("metadata") or (row.get("testCase") or {}).get("metadata") or {}
        answer_id = meta.get("answerId")
        if not answer_id:
            continue
        components = ((row.get("gradingResult") or {}).get("componentResults")) or []
        by_answer[answer_id] = {"components": components, "error": row.get("error")}
    return by_answer


def component_ok(component: dict) -> bool:
    """False when the check did not produce a judgment (an API error, an unreadable reply)."""
    reason = str(component.get("reason") or "")
    if component.get("error"):
        return False
    if re.search(r"(?i)could not extract json|\bAPI (call )?error:|credit balance is too low", reason):
        return False
    if reason.strip().lower() == "no output":
        return False
    return not re.match(r"(?i)\s*(api (call )?error|error\b|http error|request (failed|timed out)|rate limit|provider error|failed to )", reason)


def median_or_none(values):
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else None


def majority(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return 1 if sum(values) * 2 > len(values) else 0


def fmt(value, digits=3):
    if value is None:
        return ""
    if isinstance(value, float):
        return f"{value:.{digits}f}".rstrip("0").rstrip(".") if digits else str(round(value))
    return str(value)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=Path("out"))
    args = parser.parse_args()
    out = args.out

    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    answers = manifest["answers"]
    code = load_results(out / "results.code.json") if (out / "results.code.json").exists() else {}
    judges = {}
    for path in sorted(out.glob("results.judge.*.json")):
        judges[path.name[len("results.judge."):-len(".json")]] = load_results(path)
    if not judges:
        sys.exit("summarize: no judge results found (out/results.judge.<name>.json)")
    judge_names = list(judges)
    problems: list[str] = []
    reasons: list[list] = []

    table = []
    for answer in answers:
        answer_id, answered = answer["answerId"], answer["status"] == "answered"
        row = dict(answer)
        row["key_terms"] = row["meaning_match"] = None
        if answered:
            for component in (code.get(answer_id) or {}).get("components", []):
                metric = (component.get("assertion") or {}).get("metric")
                if metric in ("key_terms", "meaning_match") and component_ok(component):
                    row[metric] = float(component.get("score") or 0)
            if row["key_terms"] is None:
                problems.append(f"{answer_id}: no key-term result")
            if row["meaning_match"] is None:
                problems.append(f"{answer_id}: no similarity result")
        else:
            row["key_terms"] = 0.0

        per_judge = {}
        for name in judge_names:
            result = {"key_points": None, **{column: None for column in YES_NO}, "points_passed": None}
            if not answered:
                result.update({"key_points": 0.0, "contradicts_expert": 0, "made_up_facts": 0, "declines_or_hedges": None, "gives_example": 0, "points_passed": 0})
                per_judge[name] = result
                continue
            components = (judges[name].get(answer_id) or {}).get("components", [])
            point_votes = []
            for component in components:
                assertion = component.get("assertion") or {}
                metric = assertion.get("metric") or ""
                ok = component_ok(component)
                passed = bool(component.get("pass"))
                reasons.append([answer_id, answer["subject"], answer["question"], answer["testNumber"], name, metric,
                                ("pass" if passed else "fail") if ok else "no judgment", str(component.get("reason") or "").strip()])
                if not ok:
                    problems.append(f"{answer_id}, judge {name}, {metric}: no judgment ({str(component.get('reason'))[:80]})")
                    continue
                if metric.startswith("key_point_"):
                    point_votes.append(1 if passed else 0)
                elif metric in JUDGE_METRICS:
                    column, pass_means_no = JUDGE_METRICS[metric]
                    result[column] = (0 if passed else 1) if pass_means_no else (1 if passed else 0)
            if len(point_votes) == answer["keyPoints"]:
                result["points_passed"] = sum(point_votes)
                result["key_points"] = sum(point_votes) / len(point_votes) if point_votes else 0.0
            else:
                problems.append(f"{answer_id}, judge {name}: {len(point_votes)} of {answer['keyPoints']} key-point decisions")
            per_judge[name] = result
        row["judges"] = per_judge
        row["key_points"] = median_or_none([per_judge[name]["key_points"] for name in judge_names])
        for column in YES_NO:
            row[column] = majority([per_judge[name][column] for name in judge_names])
        table.append(row)

    # scores.csv
    header = ["answer_id", "test_number", "question", "category", "subject", "status", "words", "key_terms", "meaning_match", "key_points", *YES_NO]
    for name in judge_names:
        header += [f"key_points_{name}", *[f"{column}_{name}" for column in YES_NO]]
    with (out / "scores.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        for row in table:
            line = [row["answerId"], fmt(row["testNumber"]), row["question"], row["category"], row["subject"], row["status"], row["words"],
                    fmt(row["key_terms"]), fmt(row["meaning_match"]), fmt(row["key_points"]), *[fmt(row[column]) for column in YES_NO]]
            for name in judge_names:
                line += [fmt(row["judges"][name]["key_points"]), *[fmt(row["judges"][name][column]) for column in YES_NO]]
            writer.writerow(line)

    # by_subject.csv
    def mean(values):
        values = [v for v in values if v is not None]
        return sum(values) / len(values) if values else None

    with (out / "by_subject.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["subject", "questions", "answered", "key_point_coverage_pct", "key_terms_pct", "meaning_match_mean",
                         "answers_contradicting_expert", "answers_with_made_up_facts", "answers_declining_or_hedging", "answers_with_an_example", "median_words",
                         *[f"key_point_coverage_pct_{name}" for name in judge_names]])
        for subject in SUBJECTS:
            rows = [row for row in table if row["subject"] == subject]
            answered_rows = [row for row in rows if row["status"] == "answered"]
            coverage = mean([row["key_points"] for row in rows])
            writer.writerow([
                subject, len(rows), len(answered_rows),
                fmt(None if coverage is None else coverage * 100, 1),
                fmt(None if mean([row["key_terms"] for row in rows]) is None else mean([row["key_terms"] for row in rows]) * 100, 1),
                fmt(mean([row["meaning_match"] for row in answered_rows])),
                sum(row["contradicts_expert"] or 0 for row in rows),
                sum(row["made_up_facts"] or 0 for row in rows),
                sum(row["declines_or_hedges"] or 0 for row in rows),
                sum(row["gives_example"] or 0 for row in rows),
                fmt(statistics.median([row["words"] for row in answered_rows]) if answered_rows else None, 1),
                *[fmt(None if mean([row["judges"][name]["key_points"] for row in rows]) is None else mean([row["judges"][name]["key_points"] for row in rows]) * 100, 1) for name in judge_names],
            ])

    # by_question.csv
    with (out / "by_question.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["question", "category", *[f"{subject} key points %" for subject in SUBJECTS], *[f"{subject} status" for subject in SUBJECTS]])
        for question in range(1, 13):
            rows = {row["subject"]: row for row in table if row["question"] == question}
            category = next(iter(rows.values()))["category"] if rows else ""
            writer.writerow([question, category,
                             *[fmt(None if rows.get(s) is None or rows[s]["key_points"] is None else rows[s]["key_points"] * 100, 0) for s in SUBJECTS],
                             *[(rows[s]["status"] + (" (declines or hedges)" if rows[s]["declines_or_hedges"] else "")) if rows.get(s) else "" for s in SUBJECTS]])

    # judge_agreement.csv: every yes/no decision the judges made on answered answers
    decisions = {}  # (answerId, metric) -> {judge: 0/1}
    for answer_id, _subject, _question, _test, name, metric, verdict, _reason in reasons:
        if verdict in ("pass", "fail"):
            decisions.setdefault((answer_id, metric), {})[name] = 1 if verdict == "pass" else 0
    with (out / "judge_agreement.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["comparison", "decisions_compared", "same_decision", "agreement_pct"])
        complete = [votes for votes in decisions.values() if len(votes) == len(judge_names)]
        unanimous = sum(1 for votes in complete if len(set(votes.values())) == 1)
        writer.writerow(["all judges", len(complete), unanimous, fmt(unanimous / len(complete) * 100 if complete else None, 1)])
        for first, second in combinations(judge_names, 2):
            both = [votes for votes in decisions.values() if first in votes and second in votes]
            same = sum(1 for votes in both if votes[first] == votes[second])
            writer.writerow([f"{first} vs {second}", len(both), same, fmt(same / len(both) * 100 if both else None, 1)])

    with (out / "judge_reasons.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["answer_id", "subject", "question", "test_number", "judge", "check", "verdict", "reason"])
        writer.writerows(reasons)

    print(f"{len(table)} answers, judges: {', '.join(judge_names)}")
    print(f"wrote scores.csv, by_subject.csv, by_question.csv, judge_agreement.csv and judge_reasons.csv to {out}/")
    for warning in manifest.get("warnings", []):
        print(f"warning: {warning}")
    if problems:
        print(f"{len(problems)} decisions are missing and were left out of the panel result:")
        for problem in problems[:20]:
            print(f"  {problem}")
        if len(problems) > 20:
            print(f"  ... and {len(problems) - 20} more")
        (out / "problems.txt").write_text("\n".join(problems) + "\n", encoding="utf-8")
    elif (out / "problems.txt").exists():
        (out / "problems.txt").unlink()


if __name__ == "__main__":
    main()
