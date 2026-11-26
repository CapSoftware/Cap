#!/usr/bin/env python3
"""Merge queue helpers for the GitHub Actions workflows.

GitHub ignores `paths` filters for merge_group events, so a workflow that
runs in the merge queue decides its own scope with `scope`, from the same
`pull_request` paths filter it declares, applied to the queue commit's diff.
The "Merge queue" check (merge-queue.yml) runs `gate`, which waits for every
workflow that declares merge_group to finish on the queue commit.

Commands:
  files  --base SHA --head SHA          changed paths, one per line
  scope  --workflow FILE --base --head  run=true|false for GITHUB_OUTPUT
  expected                              workflow files that run in the queue
  gate   --head SHA                     wait for those workflows, fail on red
  test                                  self-test
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
GATE_WORKFLOW = ".github/workflows/merge-queue.yml"
OK_CONCLUSIONS = {"success", "skipped"}


def glob_regex(pattern):
    """GitHub's filter pattern syntax: `*` stops at `/`, `**` does not, `**/`
    also matches no directory, `?` and `+` repeat the preceding character."""
    out = []
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if c == "*":
            if pattern.startswith("**", i):
                i += 2
                if pattern.startswith("/", i):
                    out.append("(?:.*/)?")
                    i += 1
                else:
                    out.append(".*")
                continue
            out.append("[^/]*")
        elif c in "?+" and out:
            out.append(c)
        elif c == "[":
            end = pattern.find("]", i + 1)
            if end == -1:
                out.append(re.escape(c))
            else:
                out.append(pattern[i : end + 1])
                i = end
        else:
            out.append(re.escape(c))
        i += 1
    return re.compile("".join(out) + r"\Z")


def matches(path, patterns):
    hit = False
    for pattern in patterns:
        negate = pattern.startswith("!")
        if glob_regex(pattern[1:] if negate else pattern).match(path):
            hit = not negate
    return hit


def _scalar(text):
    text = text.split(" #", 1)[0].strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        return text[1:-1]
    return text


def _inline_list(text):
    text = text.strip()
    if text.startswith("[") and text.endswith("]"):
        return [_scalar(item) for item in text[1:-1].split(",") if item.strip()]
    return None


def triggers(workflow):
    """The workflow's `on:` events and their list-valued filters, read without
    a YAML library (runner images do not all ship one). Every workflow in the
    repository is checked against PyYAML by `test`."""
    lines = Path(workflow).read_text().splitlines()
    events = {}
    for index, line in enumerate(lines):
        if not re.match(r"""^["']?on["']?:""", line):
            continue
        rest = line.split(":", 1)[1].strip()
        if rest and not rest.startswith("#"):
            inline = _inline_list(rest)
            for name in inline if inline is not None else [_scalar(rest)]:
                events[name] = {}
            return events
        event_indent = key_indent = None
        event = key = None
        for raw in lines[index + 1 :]:
            if not raw.strip() or raw.lstrip().startswith("#"):
                continue
            indent = len(raw) - len(raw.lstrip())
            if indent == 0:
                break
            text = raw.strip()
            if event_indent is None:
                event_indent = indent
            if indent == event_indent:
                event = _scalar(text.split(":", 1)[0])
                events[event] = {}
                key = key_indent = None
                continue
            if key_indent is None:
                key_indent = indent
            if indent == key_indent and not text.startswith("- "):
                name, value = text.split(":", 1)
                inline = _inline_list(value)
                key = _scalar(name) if inline is not None or not value.strip() else None
                if key is not None:
                    events[event][key] = inline if inline is not None else []
                    if inline is not None:
                        key = None
            elif indent > key_indent and key is not None:
                if text.startswith("- "):
                    events[event][key].append(_scalar(text[2:]))
                else:
                    del events[event][key]
                    key = None
        return events
    raise SystemExit(f"{workflow}: no on: block")


def run_git(*args, cwd=ROOT):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


def changed_files(base, head, cwd=ROOT):
    partial = subprocess.run(["git", "config", "remote.origin.promisor"], cwd=cwd, capture_output=True, text=True)
    fetch = ["fetch", "--no-tags", "--depth=1"] + (["--filter=blob:none"] if partial.stdout.strip() == "true" else [])
    for sha in (base, head):
        if subprocess.run(["git", "cat-file", "-e", f"{sha}^{{commit}}"], cwd=cwd, capture_output=True).returncode:
            run_git(*fetch, "origin", sha, cwd=cwd)
    # -z: without it git quotes non-ASCII paths, which then match no filter.
    return [path for path in run_git("diff", "--no-renames", "--name-only", "-z", base, head, cwd=cwd).split("\0") if path]


def cmd_files(args):
    for path in changed_files(args.base, args.head):
        print(path)


def cmd_scope(args):
    workflow = ROOT / args.workflow
    pull_request = triggers(workflow).get("pull_request", {})
    paths = pull_request.get("paths")
    ignore = pull_request.get("paths-ignore")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    try:
        files = changed_files(args.base, args.head)
    except subprocess.CalledProcessError as error:
        print(f"::warning::could not diff {args.base}..{args.head} ({error.stderr.strip()}); running in full", file=sys.stderr)
        print("run=true")
        return
    if paths:
        hits = [path for path in files if matches(path, paths)]
    elif ignore:
        hits = [path for path in files if not matches(path, ignore)]
    else:
        hits = files or ["(no filter)"]
    run = bool(hits)
    note = (
        f"Merge queue: {len(files)} changed files, {len(hits)} in this workflow's pull_request paths; "
        + ("running." if run else "nothing to run.")
    )
    print(note, file=sys.stderr)
    if summary:
        with open(summary, "a") as handle:
            handle.write(note + "\n")
            for path in hits[:20]:
                handle.write(f"- `{path}`\n")
    print(f"run={'true' if run else 'false'}")


def queue_workflows():
    out = []
    for workflow in sorted([*WORKFLOWS.glob("*.yml"), *WORKFLOWS.glob("*.yaml")]):
        rel = workflow.relative_to(ROOT).as_posix()
        if rel != GATE_WORKFLOW and "merge_group" in triggers(workflow):
            out.append(rel)
    return out


def cmd_expected(_args):
    for path in queue_workflows():
        print(path)


class Api:
    """GitHub REST reads with ETags: a 304 does not count against the token's
    hourly limit, and most polls of a long queue run change nothing."""

    def __init__(self, token):
        self.token = token
        self.cache = {}

    def get(self, url):
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if url in self.cache:
            headers["If-None-Match"] = self.cache[url][0]
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
                body = (json.load(response), response.headers.get("Link", ""))
                if response.headers.get("ETag"):
                    self.cache[url] = (response.headers["ETag"], body)
                return body
        except urllib.error.HTTPError as error:
            if error.code == 304 and url in self.cache:
                return self.cache[url][1]
            raise

    def pages(self, url, key):
        items = []
        while url:
            body, link = self.get(url)
            items.extend(body.get(key, []))
            url = next((part.split(";")[0].strip(" <>") for part in link.split(",") if 'rel="next"' in part), None)
        return items


FAILED_JOBS = {"failure", "cancelled", "timed_out", "action_required", "startup_failure"}


def gate_verdict(expected, runs, checks=()):
    """(state, lines): state is pass, fail or wait. A failed job fails the gate
    at once, before the rest of its workflow finishes."""
    latest = {}
    for run in runs:
        path = run.get("path", "").split("@", 1)[0]
        if path in expected and (path not in latest or run["id"] > latest[path]["id"]):
            latest[path] = run
    suites = {run.get("check_suite_id"): path for path, run in latest.items()}
    failed_jobs = {}
    for check in checks:
        path = suites.get((check.get("check_suite") or {}).get("id"))
        if path and check.get("conclusion") in FAILED_JOBS:
            failed_jobs.setdefault(path, []).append(f"{check['name']} {check['conclusion']}")
    lines, failed, waiting = [], [], []
    for path in expected:
        run = latest.get(path)
        if run is None:
            waiting.append(path)
            lines.append(f"{path}: not started")
        elif path in failed_jobs:
            failed.append(path)
            lines.append(f"{path}: {', '.join(failed_jobs[path])} {run['html_url']}")
        elif run["status"] != "completed":
            waiting.append(path)
            lines.append(f"{path}: {run['status']} {run['html_url']}")
        else:
            lines.append(f"{path}: {run['conclusion']} {run['html_url']}")
            if run["conclusion"] not in OK_CONCLUSIONS:
                failed.append(path)
    if failed:
        return "fail", lines
    return ("wait" if waiting else "pass"), lines


def cmd_gate(args):
    api = Api(os.environ["GITHUB_TOKEN"])
    repo = os.environ["GITHUB_REPOSITORY"]
    api_url = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    expected = queue_workflows()
    print("Waiting for:\n  " + "\n  ".join(expected), flush=True)
    runs_url = f"{api_url}/repos/{repo}/actions/runs?head_sha={args.head}&event=merge_group&per_page=100"
    checks_url = f"{api_url}/repos/{repo}/commits/{args.head}/check-runs?filter=latest&per_page=100"
    started = time.monotonic()
    delay = args.first_poll
    lines = []
    while True:
        time.sleep(delay)
        delay = args.poll
        try:
            runs = api.pages(runs_url, "workflow_runs")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            print(f"::warning::listing runs failed ({error}); retrying", flush=True)
            continue
        try:
            checks = api.pages(checks_url, "check_runs")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            # Without job results the gate still fails, once the failing workflow finishes.
            print(f"::warning::reading check runs failed ({error}); judging by workflow conclusions", flush=True)
            checks = []
        state, lines = gate_verdict(expected, runs, checks)
        elapsed = time.monotonic() - started
        pending = [line for line in lines if not line.split(": ", 1)[1].startswith(("success", "skipped"))]
        print(f"[{int(elapsed // 60)}m] {state}: " + ("; ".join(pending) or "all green"), flush=True)
        if state == "pass":
            break
        if state == "fail":
            write_gate_summary("failed", lines)
            print("::error::a workflow failed on the merge queue commit (see the list above)")
            return 1
        missing = [line for line in lines if line.endswith(": not started")]
        if missing and elapsed > args.start_grace * 60:
            write_gate_summary("failed", lines)
            print(f"::error::{len(missing)} queue workflows never started on {args.head}")
            return 1
    write_gate_summary("passed", lines)
    print("every merge queue workflow passed")
    return 0


def write_gate_summary(verdict, lines):
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as handle:
            handle.write(f"## Merge queue {verdict}\n\n")
            for line in lines:
                handle.write(f"- {line}\n")


def cmd_test(_args):
    cases = [
        ("apps/desktop-gpui/**", "apps/desktop-gpui/src/main.rs", True),
        ("apps/desktop-gpui/**", "apps/desktop-gpui", False),
        ("apps/web/lib/infra-**", "apps/web/lib/infra-billing/x.ts", True),
        ("apps/web/lib/infra-**", "apps/web/lib/infra.ts", False),
        ("scripts/gpui-bench-*", "scripts/gpui-bench-run.py", True),
        ("scripts/gpui-bench-*", "scripts/gpui-bench-x/y.py", False),
        ("packages/web-*/**", "packages/web-backend/src/a.ts", True),
        ("packages/web-*/**", "packages/webx/a.ts", False),
        ("apps/web/app/(infra)/**", "apps/web/app/(infra)/page.tsx", True),
        ("apps/web/app/(infra)/**", "apps/web/app/infra/page.tsx", False),
        ("apps/web/lib/space-video-order*", "apps/web/lib/space-video-order.ts", True),
        ("**/README.md", "README.md", True),
        ("**/README.md", "docs/a/README.md", True),
        ("docs/**/*.md", "docs/a.md", True),
        ("*.md", "docs/a.md", False),
        ("bun.lock", "bun.lock", True),
        ("bun.lock", "apps/bun.lock", False),
        ("Cargo.lock", "Cargo.lock", True),
        (".github/workflows/ci.yml", ".github/workflows/ci.yml", True),
        (".github/workflows/ci.yml", ".github/workflows/ciXyml", False),
    ]
    for pattern, path, want in cases:
        got = matches(path, [pattern])
        assert got == want, f"{pattern!r} vs {path!r}: {got}"
    assert matches("a/b.rs", ["a/**", "!a/*.rs"]) is False
    assert matches("a/b.rs", ["a/**", "!a/*.rs", "a/b.rs"]) is True

    try:
        import yaml
    except ImportError:
        yaml = None
    checked = 0
    for workflow in sorted(WORKFLOWS.glob("*.yml")):
        mine = triggers(workflow)
        if yaml is None:
            continue
        data = yaml.safe_load(workflow.read_text())
        on = data.get("on", data.get(True))
        if isinstance(on, str):
            on = {on: None}
        elif isinstance(on, list):
            on = {name: None for name in on}
        assert set(mine) == set(on), f"{workflow.name}: events {sorted(mine)} != {sorted(on)}"
        for event, config in on.items():
            if not isinstance(config, dict):
                continue
            for key in ("paths", "paths-ignore", "branches"):
                theirs = (config or {}).get(key)
                if theirs is not None:
                    assert mine[event].get(key) == theirs, f"{workflow.name} {event}.{key}: {mine[event].get(key)} != {theirs}"
        checked += 1

    with tempfile.TemporaryDirectory() as repo:
        env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
        git = lambda *a: subprocess.run(["git", *a], cwd=repo, check=True, capture_output=True, env={**os.environ, **env})
        git("init", "-q")
        Path(repo, "a.txt").write_text("a")
        git("add", "-A"); git("commit", "-q", "-m", "base")
        base = run_git("rev-parse", "HEAD", cwd=repo).strip()
        Path(repo, "apps/status/public").mkdir(parents=True)
        Path(repo, "apps/status/public/caf\u00e9 x.svg").write_text("b")
        Path(repo, "a.txt").rename(Path(repo, "b.txt"))
        git("add", "-A"); git("commit", "-q", "-m", "head")
        head = run_git("rev-parse", "HEAD", cwd=repo).strip()
        got = sorted(changed_files(base, head, cwd=repo))
        assert got == ["a.txt", "apps/status/public/caf\u00e9 x.svg", "b.txt"], got
        assert matches(got[1], ["apps/status/**"])

    runs = [
        {"id": 1, "path": ".github/workflows/a.yml", "status": "completed", "conclusion": "failure", "html_url": "u1"},
        {"id": 2, "path": ".github/workflows/a.yml", "status": "completed", "conclusion": "success", "html_url": "u2"},
        {"id": 3, "path": ".github/workflows/b.yml", "status": "in_progress", "conclusion": None, "html_url": "u3"},
    ]
    assert gate_verdict([".github/workflows/a.yml"], runs)[0] == "pass"
    assert gate_verdict([".github/workflows/a.yml", ".github/workflows/b.yml"], runs)[0] == "wait"
    assert gate_verdict([".github/workflows/c.yml"], runs)[0] == "wait"
    runs[2].update(status="completed", conclusion="cancelled")
    assert gate_verdict([".github/workflows/a.yml", ".github/workflows/b.yml"], runs)[0] == "fail"
    runs[2]["conclusion"] = "skipped"
    assert gate_verdict([".github/workflows/b.yml"], runs)[0] == "pass"
    runs[1].update(status="in_progress", conclusion=None, check_suite_id=20)
    checks = [
        {"name": "Clippy", "conclusion": "failure", "check_suite": {"id": 20}},
        {"name": "Merge queue", "conclusion": "failure", "check_suite": {"id": 99}},
    ]
    state, lines = gate_verdict([".github/workflows/a.yml"], runs, checks)
    assert state == "fail" and "Clippy failure" in lines[0], lines
    assert gate_verdict([".github/workflows/a.yml"], runs, checks[1:])[0] == "wait"
    print(f"ok ({len(cases)} patterns, {checked} workflows cross-checked, {len(queue_workflows())} run in the queue)")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    files = sub.add_parser("files")
    files.add_argument("--base", required=True)
    files.add_argument("--head", required=True)
    scope = sub.add_parser("scope")
    scope.add_argument("--workflow", required=True)
    scope.add_argument("--base", required=True)
    scope.add_argument("--head", required=True)
    sub.add_parser("expected")
    gate = sub.add_parser("gate")
    gate.add_argument("--head", required=True)
    gate.add_argument("--first-poll", type=float, default=30)
    gate.add_argument("--poll", type=float, default=60)
    gate.add_argument("--start-grace", type=float, default=20, help="minutes a queue workflow may take to start")
    sub.add_parser("test")
    args = parser.parse_args()
    handler = {
        "files": cmd_files,
        "scope": cmd_scope,
        "expected": cmd_expected,
        "gate": cmd_gate,
        "test": cmd_test,
    }[args.command]
    sys.exit(handler(args) or 0)


if __name__ == "__main__":
    main()
