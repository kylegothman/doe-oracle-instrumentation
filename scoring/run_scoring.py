#!/usr/bin/env python3
"""Score a harness export against the expert answer key, end to end.

Usage:
    python3 run_scoring.py EXPORT [--dry-run] [--smoke N] [--only-judge NAME]
                                  [--session ID ...] [--from-test N] [--to-test N] [--strict]

Steps:
    1. build_tests.py turns the export and the answer key into test cases (out/).
    2. promptfoo runs the code checks once.
    3. promptfoo runs the judge checks once for each judge in judges.json.
    4. summarize.py writes the score tables to out/.

--dry-run uses a stand-in judge and makes no network call. Its scores mean nothing;
it only shows that every step works before any API key is spent.

--smoke N sends only the first N answers to the real judges and prints what came back.
Use it once to check the API keys and model names before the full run.

API keys are read from a .env file next to this script (see .env.example).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROMPTFOO_VERSION = "0.126.0"  # pinned so every run of the study uses the same grader prompt


def promptfoo_command() -> list[str]:
    override = os.environ.get("PROMPTFOO_BIN")
    if override:
        return [override]
    if not shutil.which("npx"):
        sys.exit("run_scoring: npx was not found. Install Node.js first.")
    return ["npx", "-y", f"promptfoo@{PROMPTFOO_VERSION}"]


def run(command: list[str], env: dict | None = None) -> None:
    print("\n$ " + " ".join(command))
    completed = subprocess.run(command, cwd=HERE, env=env)
    # promptfoo exits with 100 when a test "fails". Here a failed check is a result, not an error.
    if completed.returncode not in (0, 100):
        sys.exit(f"run_scoring: the command stopped with exit code {completed.returncode}")


def report_smoke(out: Path, judges: list[dict]) -> None:
    """Prints, for each judge, how many decisions came back and one sample reason."""
    sys.path.insert(0, str(HERE))
    from summarize import component_ok, load_results

    print("\nSmoke test. These are partial results; nothing was summarized.")
    for judge in judges:
        path = out / f"results.judge.{judge['name']}.json"
        components = [c for answer in load_results(path).values() for c in answer["components"]]
        judged = [c for c in components if component_ok(c)]
        print(f"  {judge['name']} ({judge['provider']}): {len(judged)} of {len(components)} decisions came back")
        sample = (judged or components or [{}])[0]
        print(f"    sample: {str(sample.get('reason', 'no reply'))[:160]}")
        if len(judged) < len(components):
            failed = next(c for c in components if not component_ok(c))
            print(f"    problem: {str(failed.get('reason'))[:200]}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("export", type=Path)
    parser.add_argument("--dry-run", action="store_true", help="use the stand-in judge; no API keys, no network")
    parser.add_argument("--smoke", type=int, metavar="N", help="send only the first N answers to each judge, then report and stop")
    parser.add_argument("--only-judge", help="run one judge from judges.json and keep the other results")
    parser.add_argument("--session", action="append", default=[])
    parser.add_argument("--from-test", type=int)
    parser.add_argument("--to-test", type=int)
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--no-cache", action="store_true", help="ask every judge again instead of reusing saved replies")
    args = parser.parse_args()

    export = args.export.resolve()
    if not export.exists():
        sys.exit(f"run_scoring: {export} does not exist")
    judges = json.loads((HERE / "judges.json").read_text(encoding="utf-8"))
    if args.only_judge:
        judges = [judge for judge in judges if judge["name"] == args.only_judge]
        if not judges:
            sys.exit(f"run_scoring: no judge named {args.only_judge!r} in judges.json")

    env = dict(os.environ)
    env.setdefault("PROMPTFOO_DISABLE_TELEMETRY", "1")
    env.setdefault("PROMPTFOO_DISABLE_UPDATE", "1")
    env.setdefault("PROMPTFOO_DISABLE_SHARING", "1")
    env.setdefault("PROMPTFOO_CONFIG_DIR", str(HERE / ".promptfoo"))

    out = HERE / "out"
    if not args.only_judge and out.exists():
        for stale in list(out.glob("results.*.json")) + list(out.glob("*.csv")) + list(out.glob("problems.txt")):
            stale.unlink()

    build = [sys.executable, "build_tests.py", str(export), "--out", "out"]
    for session in args.session:
        build += ["--session", session]
    if args.from_test is not None:
        build += ["--from-test", str(args.from_test)]
    if args.to_test is not None:
        build += ["--to-test", str(args.to_test)]
    if args.strict:
        build.append("--strict")
    if args.dry_run:
        build += ["--embedding", "file://stand_in_judge.js"]
    run(build, env)

    promptfoo = promptfoo_command()
    common = ["--no-progress-bar", "--no-table"]
    if args.no_cache or args.dry_run:
        common.append("--no-cache")
    if (HERE / ".env").exists() and not args.dry_run:
        common += ["--env-file", ".env"]
    if args.smoke:
        common += ["--filter-first-n", str(args.smoke)]

    if not args.only_judge:
        run([*promptfoo, "eval", "-c", "promptfooconfig.code.yaml", "--output", "out/results.code.json", *common], env)
    for judge in judges:
        provider = "file://stand_in_judge.js" if args.dry_run else judge["provider"]
        judge_env = dict(env, STAND_IN_JUDGE=judge["name"])
        run([*promptfoo, "eval", "-c", "promptfooconfig.judge.yaml", "--grader", provider,
             "--output", f"out/results.judge.{judge['name']}.json", *common], judge_env)

    if args.smoke:
        report_smoke(out, judges)
        return
    run([sys.executable, "summarize.py", "--out", "out"], env)
    if args.dry_run:
        print("\nDry run: the judge was a stand-in, so these scores mean nothing.")


if __name__ == "__main__":
    main()
