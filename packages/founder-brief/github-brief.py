#!/usr/bin/env python3
"""Read-only, deterministic GitHub activity brief. Python standard library only.

CLI: --stdin JSON, or --config PATH (regular file, private mode); stdout is the
brief on success. --json emits structured facts/status instead. Failures exit 1
and never emit a normal brief. GITHUB_TOKEN is read only from the environment.
No API origin, token, executable, or arbitrary URL is accepted in configuration.

API contracts checked against docs.github.com/en/rest/{commits/commits,
issues/issues,pulls/pulls,releases/releases} and
/rest/guides/using-pagination-in-the-rest-api.
Commits cover the default branch by committer timestamp. Issues and PRs cover
updated_at, not a complete audit/event history. Comments/reviews are not fetched.
Review queue is a current snapshot of explicit requests, not review status.
Release watch scans the complete bounded release list and filters published_at;
over 300 total releases is incomplete even when the reporting window is small.
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
from http.client import HTTPException
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

API_ORIGIN = "https://api.github.com"
API_VERSION = "2026-03-10"
MAX_REPOSITORIES, MAX_PAGES, PAGE_SIZE = 8, 3, 100
MAX_RESPONSE_BYTES, MAX_CONFIG_BYTES = 2 * 1024 * 1024, 16 * 1024
MAX_TEXT_UNITS, MAX_RUNTIME_SECONDS = 3500, 90
KINDS = ("commits", "issues", "pulls")
WORKFLOWS = ("activity-brief", "review-queue", "release-watch")
REPOSITORY = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9_.-]{1,100}\Z")
ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))")


class BriefError(Exception):
    """Only fixed, public reason codes belong in this exception."""


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"), allow_nan=False)


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise BriefError("invalid_json")
        result[key] = value
    return result


def parse_json(raw):
    try:
        return json.loads(raw, object_pairs_hook=unique_pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(BriefError("invalid_json")))
    except (ValueError, UnicodeError, RecursionError, TypeError):
        raise BriefError("invalid_json") from None


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z", value):
        raise BriefError("invalid_utc_timestamp")
    try:
        base = value[:-1]
        if "." in base:
            whole, fractional = base.rsplit(".", 1)
            base = whole + "." + fractional.ljust(6, "0")
        return datetime.fromisoformat(base + "+00:00")
    except ValueError:
        raise BriefError("invalid_utc_timestamp") from None


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds" if value.microsecond else "seconds").replace("+00:00", "Z")


def validate_config(value, now=None):
    if not isinstance(value, dict) or set(value) - {"schema_version", "repositories", "window_hours", "start", "end", "workflow"}:
        raise BriefError("invalid_config_fields")
    if "workflow" in value and (not isinstance(value["workflow"], str) or value["workflow"] not in WORKFLOWS):
        raise BriefError("invalid_workflow")
    if type(value.get("schema_version")) is not int or value["schema_version"] != 1:
        raise BriefError("invalid_schema_version")
    repositories = value.get("repositories")
    if not isinstance(repositories, list) or not 1 <= len(repositories) <= MAX_REPOSITORIES:
        raise BriefError("invalid_repository_count")
    for repository in repositories:
        if (not isinstance(repository, str) or not REPOSITORY.fullmatch(repository)
                or repository.split("/")[1] in {".", ".."}):
            raise BriefError("invalid_repository")
    repositories = sorted(repository.lower() for repository in repositories)
    if len(set(repositories)) != len(repositories):
        raise BriefError("duplicate_repository")
    hours = value.get("window_hours", 24)
    if type(hours) is not int or not 1 <= hours <= 168:
        raise BriefError("invalid_window_hours")
    if ("start" in value) != ("end" in value) or ("start" in value and "window_hours" in value):
        raise BriefError("invalid_window_fields")
    if "start" in value:
        start, end = timestamp(value["start"]), timestamp(value["end"])
    else:
        end = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(microsecond=0)
        start = end - timedelta(hours=hours)
    if not timedelta(0) < end - start <= timedelta(days=7):
        raise BriefError("invalid_window_range")
    result = {"schema_version": 1, "repositories": repositories, "start": iso(start), "end": iso(end)}
    # Do not change legacy normalized bytes/config hashes merely by upgrading.
    if "workflow" in value:
        result["workflow"] = value["workflow"]
    return result


def sanitize(value, limit=90, secrets=()):
    if not isinstance(value, str):
        raise BriefError("malformed_response")
    value = ANSI.sub("", value)
    value = "".join(" " if unicodedata.category(c).startswith("C") else c for c in value)
    value = " ".join(value.split())
    for secret in secrets:
        if secret:
            value = value.replace(secret, "[redacted]")
    return value[:limit] + ("…" if len(value) > limit else "")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHubClient:
    def __init__(self, token="", *, sleep=time.sleep, clock=time.monotonic):
        if not isinstance(token, str) or len(token) > 4096 or (token and not re.fullmatch(r"[A-Za-z0-9_]+", token)):
            raise BriefError("invalid_github_token")
        self.token, self.sleep, self.clock = token, sleep, clock
        self.origin = API_ORIGIN
        self.deadline = clock() + MAX_RUNTIME_SECONDS
        # Do not let ambient proxies or redirects change the token's destination.
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    @classmethod
    def _for_test(cls, origin, **kwargs):
        """Explicit in-process harness injection; never reachable from CLI/config/env."""
        parsed = urlsplit(origin)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"} or parsed.path or parsed.query or parsed.fragment or parsed.username:
            raise BriefError("invalid_test_origin")
        client = cls(**kwargs)
        client.origin = origin
        return client

    def get(self, endpoint, params):
        if not re.fullmatch(r"/repos/" + REPOSITORY.pattern[:-2] + r"/(?:commits|issues|pulls|releases)", endpoint):
            raise BriefError("invalid_endpoint")
        url = self.origin + endpoint + "?" + urlencode(params)
        for attempt in range(3):
            remaining = self.deadline - self.clock()
            if remaining <= 0:
                raise BriefError("collection_deadline")
            headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION,
                       "User-Agent": "hstack-founder-brief/1"}
            if self.token:
                headers["Authorization"] = "Bearer " + self.token
            try:
                with self.opener.open(Request(url, headers=headers, method="GET"), timeout=min(10, remaining)) as response:
                    raw = response.read(MAX_RESPONSE_BYTES + 1)
                    if len(raw) > MAX_RESPONSE_BYTES:
                        raise BriefError("response_too_large")
                    if response.status != 200:
                        raise BriefError("unexpected_http_status")
                    result = parse_json(raw)
                    if not isinstance(result, list) or len(result) > PAGE_SIZE:
                        raise BriefError("malformed_response")
                    # Inspect next-page presence only; never follow supplied Link URLs.
                    more = bool(re.search(r';\s*rel="next"', response.headers.get("Link", "")))
                    return result, more
            except HTTPError as error:
                status, retry = error.code, error.headers.get("Retry-After")
                rate_limited = status == 429 or (status == 403 and (error.headers.get("X-RateLimit-Remaining") == "0" or retry is not None))
                error.close()
                reason = "rate_limited" if rate_limited else "http_{}".format(status)
                if attempt == 2 or not (rate_limited or 500 <= status < 600):
                    raise BriefError(reason) from None
                delay = 0.5 * (2 ** attempt)
                if retry is not None:
                    if not retry.isdigit() or int(retry) > 3:
                        raise BriefError(reason) from None
                    delay = max(delay, int(retry))
            except (URLError, TimeoutError, OSError, HTTPException):
                if attempt == 2:
                    raise BriefError("network_error") from None
                delay = 0.5 * (2 ** attempt)
            if self.clock() + delay >= self.deadline:
                raise BriefError("collection_deadline")
            self.sleep(delay)
        raise BriefError("network_error")


def fact(repository, kind, item, secrets=()):
    if not isinstance(item, dict):
        raise BriefError("malformed_response")
    if kind == "issues" and "pull_request" in item:
        # The issues endpoint includes PRs; report them only through pulls.
        return None
    if kind == "commits":
        sha = item.get("sha")
        commit = item.get("commit")
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", sha) or not isinstance(commit, dict):
            raise BriefError("malformed_response")
        committer = commit.get("committer")
        if not isinstance(committer, dict):
            raise BriefError("malformed_response")
        date, title = committer.get("date"), commit.get("message")
        identity, url, state = sha, "https://github.com/{}/commit/{}".format(repository, sha), None
    else:
        number, state = item.get("number"), item.get("state")
        if type(number) is not int or not 1 <= number <= 2 ** 53 or state not in {"open", "closed"}:
            raise BriefError("malformed_response")
        date, title = item.get("updated_at"), item.get("title")
        identity = str(number)
        url = "https://github.com/{}/{}/{}".format(repository, "pull" if kind == "pulls" else "issues", number)
    timestamp(date)
    return {"kind": kind, "id": identity, "date": iso(timestamp(date)), "title": sanitize(title, secrets=secrets), "url": url, "state": state}


def login(value):
    # GitHub's bot authors use the literal [bot] suffix.
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}(?:\[bot\])?", value):
        raise BriefError("malformed_response")
    return value


def review_fact(repository, item, cutoff, secrets=()):
    """Current explicit review requests, not inferred approval/readiness status."""
    if not isinstance(item, dict):
        raise BriefError("malformed_response")
    number, state, draft = item.get("number"), item.get("state"), item.get("draft")
    if type(number) is not int or not 1 <= number <= 2 ** 53 or state not in {"open", "closed"} or type(draft) is not bool:
        raise BriefError("malformed_response")
    # The query is state=open. Check defensively rather than showing closed work.
    if state != "open" or draft:
        return None
    author, reviewers, teams = item.get("user"), item.get("requested_reviewers"), item.get("requested_teams")
    if (not isinstance(author, dict) or not isinstance(reviewers, list) or not isinstance(teams, list)
            or len(reviewers) > 100 or len(teams) > 100):
        raise BriefError("malformed_response")
    author_login = login(author.get("login"))
    if any(not isinstance(user, dict) for user in reviewers) or any(not isinstance(team, dict) for team in teams):
        raise BriefError("malformed_response")
    users = sorted(set(login(user.get("login")) for user in reviewers))
    team_names = []
    for team in teams:
        slug = team.get("slug")
        if not isinstance(slug, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", slug):
            raise BriefError("malformed_response")
        team_names.append(slug)
    team_names = sorted(set(team_names))
    created, updated = timestamp(item.get("created_at")), timestamp(item.get("updated_at"))
    if updated < created:
        raise BriefError("malformed_response")
    title = sanitize(item.get("title"), secrets=secrets)
    if not users and not team_names:
        return None
    # New requests after a delayed daily cutoff still belong to this CURRENT
    # snapshot. Only the displayed age is relative to that cutoff (floor at zero).
    return {"kind": "review_requests", "id": str(number), "date": iso(created), "created_at": iso(created),
            "updated_at": iso(updated), "age_days": max(0, (cutoff - created).days), "author": sanitize(author_login, secrets=secrets),
            "requested_reviewers": [sanitize(user, secrets=secrets) for user in users],
            "requested_teams": [sanitize(team, secrets=secrets) for team in team_names], "title": title,
            "url": "https://github.com/{}/pull/{}".format(repository, number), "state": "open"}


def release_fact(repository, item, secrets=()):
    if not isinstance(item, dict):
        raise BriefError("malformed_response")
    identity, draft, prerelease = item.get("id"), item.get("draft"), item.get("prerelease")
    if type(identity) is not int or not 1 <= identity <= 2 ** 53 or type(draft) is not bool or type(prerelease) is not bool:
        raise BriefError("malformed_response")
    if draft:
        return None
    tag, name = item.get("tag_name"), item.get("name")
    if (not isinstance(tag, str) or not 1 <= len(tag) <= 255
            or any(unicodedata.category(char).startswith("C") or char.isspace() for char in tag)
            or tag == "." or ".." in tag or tag.startswith("/") or tag.endswith("/") or "//" in tag
            or (name is not None and not isinstance(name, str))):
        raise BriefError("malformed_response")
    # Redacting inside a tag URL would silently fabricate a different link.
    if any(secret and secret in tag for secret in secrets):
        raise BriefError("secret_in_release_tag")
    published = timestamp(item.get("published_at"))
    return {"kind": "releases", "id": str(identity), "date": iso(published),
            "title": sanitize(name or tag, secrets=secrets), "tag": sanitize(tag, limit=255, secrets=secrets),
            "prerelease": prerelease, "url": "https://github.com/{}/releases/tag/{}".format(repository, quote(tag, safe="")),
            "state": "prerelease" if prerelease else "stable"}


def collect_pack(config, client, workflow):
    """Bounded snapshots/releases; every selected page must be complete."""
    start, end = timestamp(config["start"]), timestamp(config["end"])
    kind = "pulls" if workflow == "review-queue" else "releases"
    reports = []
    for repository in config["repositories"]:
        source = {"status": "ok", "pages": 0, "count": 0}
        seen, fingerprints = {}, {}
        try:
            for page in range(1, MAX_PAGES + 1):
                params = {"per_page": PAGE_SIZE, "page": page}
                if workflow == "review-queue":
                    params.update(state="open", sort="created", direction="asc")
                items, more = client.get("/repos/{}/{}".format(repository, kind), params)
                source["pages"] += 1
                for item in items:
                    identity = item.get("number" if workflow == "review-queue" else "id") if isinstance(item, dict) else None
                    if type(identity) is not int or not 1 <= identity <= 2 ** 53:
                        raise BriefError("malformed_response")
                    fingerprint = hashlib.sha256(canonical(item).encode()).hexdigest()
                    previous = fingerprints.get(identity)
                    if previous is not None and previous != fingerprint:
                        raise BriefError("unstable_pagination")
                    fingerprints[identity] = fingerprint
                    record = (review_fact(repository, item, end, secrets=(client.token,)) if workflow == "review-queue"
                              else release_fact(repository, item, secrets=(client.token,)))
                    if record is None or (workflow == "release-watch" and not start <= timestamp(record["date"]) < end):
                        continue
                    old = seen.get(record["id"])
                    if old is not None and old != record:
                        raise BriefError("unstable_pagination")
                    seen[record["id"]] = record
                # The list API does not promise publication ordering;
                # drafts/edits may publish old releases. Never stop early.
                if not more:
                    break
                if page == MAX_PAGES:
                    source["status"] = "truncated"
            source["count"] = len(seen)
        except BriefError as error:
            source["status"], source["error"] = "error", str(error)
        facts = sorted(seen.values(), key=lambda record: (record["date"], int(record["id"])), reverse=workflow == "release-watch")
        reports.append({"repository": repository, "facts": facts, "sources": {kind: source}})
    return {"schema_version": 1, "config_sha256": hashlib.sha256(canonical(config).encode()).hexdigest(),
            "start": config["start"], "end": config["end"], "complete": all(report["sources"][kind]["status"] == "ok" for report in reports),
            "repositories": reports, "workflow": workflow}


def collect(config, client):
    workflow = config.get("workflow", "activity-brief")
    if workflow in {"review-queue", "release-watch"}:
        return collect_pack(config, client, workflow)
    start, end = timestamp(config["start"]), timestamp(config["end"])
    # GitHub describes "since" as after, while our contract includes start.
    # Fetch a one-second margin with whole-second API parameters, then enforce
    # exact [start,end) locally (also preserves fractional canary boundaries).
    try:
        request_since = iso(start.replace(microsecond=0) - timedelta(seconds=1))
        request_until = iso(end.replace(microsecond=0) + timedelta(seconds=1))
    except OverflowError:
        raise BriefError("invalid_window_range") from None
    reports = []
    for repository in config["repositories"]:
        report = {"repository": repository, "facts": [], "sources": {}}
        for kind in KINDS:
            source = {"status": "ok", "pages": 0, "count": 0}
            seen = {}
            try:
                for page in range(1, MAX_PAGES + 1):
                    params = {"per_page": PAGE_SIZE, "page": page}
                    if kind == "commits":
                        params.update(since=request_since, until=request_until)
                    else:
                        params.update(state="all", sort="updated", direction="desc")
                        if kind == "issues":
                            params["since"] = request_since
                    items, more = client.get("/repos/{}/{}".format(repository, kind), params)
                    source["pages"] += 1
                    dates = []
                    for item in items:
                        record = fact(repository, kind, item, secrets=(client.token,))
                        if record is None:
                            continue
                        date = timestamp(record["date"])
                        dates.append(date)
                        if start <= date < end:
                            old = seen.get(record["id"])
                            if old is not None and old != record:
                                raise BriefError("unstable_pagination")
                            seen[record["id"]] = record
                    if not more:
                        break
                    # Updated-desc issue/PR lists can stop after crossing start.
                    # Do not assume commit topology is sorted by commit timestamp.
                    if kind != "commits" and dates and max(dates) < start:
                        break
                    if page == MAX_PAGES:
                        source["status"] = "truncated"
                source["count"] = len(seen)
                report["facts"].extend(seen.values())
            except BriefError as error:
                source["status"], source["error"] = "error", str(error)
                # Partial source results are never presented as a complete count.
            report["sources"][kind] = source
        report["facts"].sort(key=lambda x: (x["date"], x["kind"], x["id"]), reverse=True)
        reports.append(report)
    complete = all(source["status"] == "ok" for report in reports for source in report["sources"].values())
    result = {"schema_version": 1, "config_sha256": hashlib.sha256(canonical(config).encode()).hexdigest(),
              "start": config["start"], "end": config["end"], "complete": complete, "repositories": reports}
    if "workflow" in config:
        result["workflow"] = workflow
    return result


def text_units(value):
    return len(value.encode("utf-16-le")) // 2


def render_pack(result):
    workflow = result["workflow"]
    if workflow == "review-queue":
        lines = ["GitHub requested review queue", "Current API snapshot fetched at execution; oldest created PR first.",
                 "Explicit user/team requests, not approval status. Age in days at cutoff {} (minimum 0).".format(result["end"])]
    else:
        lines = ["GitHub release watch", "UTC [{}, {})".format(result["start"], result["end"]),
                 "Published releases, including explicitly labelled prereleases; drafts excluded."]
    if not result["complete"]:
        lines.append("INCOMPLETE: source errors or pagination limits; no healthy report produced.")
    summaries = []
    for report in result["repositories"]:
        kind, source = next(iter(report["sources"].items()))
        if source["status"] != "ok":
            summary = "{}: {} {}{}".format(report["repository"], kind, source["status"],
                                            " (" + source["error"] + ")" if "error" in source else "")
        elif workflow == "review-queue":
            summary = "{}: {} open non-draft PR(s) with explicit review requests.".format(report["repository"], source["count"])
            if not source["count"]:
                summary += " No requested reviews in the current snapshot."
        else:
            preview = sum(record["prerelease"] for record in report["facts"])
            summary = "{}: {} stable release(s); {} prerelease(s).".format(report["repository"], source["count"] - preview, preview)
            if not source["count"]:
                summary += " No published releases in this window."
        summaries.append(summary)
    lines.extend(summaries)
    remaining, omitted = MAX_TEXT_UNITS - text_units("\n".join(lines)) - 1, 0
    for report in result["repositories"]:
        for record in report["facts"]:
            if workflow == "review-queue":
                requests = ["@" + user for user in record["requested_reviewers"]] + ["team:" + team for team in record["requested_teams"]]
                request_text = ", ".join(requests[:5]) + (" (+{} more)".format(len(requests) - 5) if len(requests) > 5 else "")
                line = "{} PR #{} by @{} — {}d at cutoff; created {}: {}\nRequested: {}\n{}".format(
                    report["repository"], record["id"], record["author"], record["age_days"], record["created_at"],
                    record["title"], request_text, record["url"])
            else:
                line = "{} {} [{}] published {}: {}\n{}".format(report["repository"], record["tag"], record["state"],
                                                                record["date"], record["title"], record["url"])
            units = text_units(line) + 1
            if units + 100 <= remaining:
                lines.append(line)
                remaining -= units
            else:
                omitted += 1
    if omitted:
        lines.append("{} additional fact(s) omitted from this message; source counts above include them.".format(omitted))
    text = "\n".join(lines)
    if text_units(text) > MAX_TEXT_UNITS:
        raise BriefError("render_limit")
    return text


def render(result):
    """Pure renderer: no Markdown/HTML mode; repository text remains plain data."""
    if result.get("workflow") in {"review-queue", "release-watch"}:
        return render_pack(result)
    lines = ["GitHub daily brief", "UTC [{}, {})".format(result["start"], result["end"]),
             "Default-branch commits; issues/PRs updated in this window."]
    if not result["complete"]:
        lines.append("INCOMPLETE: source errors or pagination limits; no healthy brief produced.")
    remaining = MAX_TEXT_UNITS - text_units("\n".join(lines)) - 1
    omitted = 0
    # Reserve a summary for every selected repository before spending space on titles.
    summaries = []
    for report in result["repositories"]:
        statuses = report["sources"]
        summary = "{}: ".format(report["repository"]) + "; ".join(
            "{} {}".format(kind, source["count"]) if source["status"] == "ok" else
            "{} {}{}".format(kind, source["status"], " (" + source["error"] + ")" if "error" in source else "")
            for kind, source in statuses.items())
        if all(source["status"] == "ok" and source["count"] == 0 for source in statuses.values()):
            summary += " — No activity in this window."
        summaries.append(summary)
    # Repository names/count are bounded by config validation; summaries always fit.
    lines.extend(summaries)
    remaining -= text_units("\n".join(summaries)) + 1
    for report in result["repositories"]:
        for record in report["facts"]:
            label = "commit " + record["id"][:8] if record["kind"] == "commits" else ("PR" if record["kind"] == "pulls" else "issue") + " #" + record["id"] + " (" + record["state"] + ")"
            line = "{} {} {}: {}\n{}".format(report["repository"], label, record["date"], record["title"], record["url"])
            units = text_units(line) + 1
            if units + 100 <= remaining:
                lines.append(line)
                remaining -= units
            else:
                omitted += 1
    if omitted:
        lines.append("{} additional fact(s) omitted from this message; source counts above include them.".format(omitted))
    text = "\n".join(lines)
    if text_units(text) > MAX_TEXT_UNITS:
        raise BriefError("render_limit")
    return text


def read_config(file, stdin):
    if file is None:
        raw = stdin.buffer.read(MAX_CONFIG_BYTES + 1)
    else:
        fd = None
        try:
            fd = os.open(str(file), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
                raise BriefError("config_must_be_private_regular_file")
            with os.fdopen(fd, "rb") as handle:
                fd = None
                raw = handle.read(MAX_CONFIG_BYTES + 1)
        except OSError:
            raise BriefError("config_unreadable") from None
        finally:
            if fd is not None:
                os.close(fd)
    if len(raw) > MAX_CONFIG_BYTES:
        raise BriefError("config_too_large")
    return parse_json(raw)


def installed_settings(script_file):
    """Native no-agent mode: paths come from this deployed script, never $HOME."""
    script = Path(script_file).absolute()
    if script.name != "hstack-founder-brief.py" or script.parent.name != "scripts" or script.is_symlink():
        raise BriefError("not_installed_worker")
    home = script.parent.parent
    config = read_config(home / ".hstack" / "founder-brief.json", sys.stdin)
    env_file = home / ".env"
    fd = None
    try:
        fd = os.open(str(env_file), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 1024 * 1024:
            raise BriefError("env_must_be_private_regular_file")
        with os.fdopen(fd, "rb") as handle:
            fd = None
            raw = handle.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise BriefError("env_too_large")
        text = raw.decode("utf-8")
    except FileNotFoundError:
        text = ""  # Public repositories need no credential.
    except (OSError, UnicodeError):
        raise BriefError("env_unreadable") from None
    finally:
        if fd is not None:
            os.close(fd)
    token, found = "", False
    for line in text.splitlines():
        if not re.match(r"^\s*(?:export\s+)?GITHUB_TOKEN\s*=", line):
            continue
        match = re.fullmatch(r'''\s*(?:export\s+)?GITHUB_TOKEN\s*=\s*(?:"([A-Za-z0-9_]*)"|'([A-Za-z0-9_]*)'|([A-Za-z0-9_]*))\s*(?:\#.*)?''', line)
        if found or not match:
            raise BriefError("invalid_github_token_setting")
        token = next(value for value in match.groups() if value is not None)
        found = True
    return config, token


def main(argv=None):
    parser = argparse.ArgumentParser(description="Collect a bounded read-only GitHub daily brief")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--config", type=Path)
    source.add_argument("--stdin", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.config is None and not args.stdin:
            raw_config, token = installed_settings(__file__)
        else:
            raw_config, token = read_config(args.config, sys.stdin), os.environ.get("GITHUB_TOKEN", "")
        config = validate_config(raw_config)
        result = collect(config, GitHubClient(token))
        if args.json:
            print(canonical(result))
        elif result["complete"]:
            print(render(result))
        if not result["complete"]:
            print("github_brief_incomplete: " + "; ".join(
                "{} {} {}".format(report["repository"], kind, source.get("error", source["status"]))
                for report in result["repositories"] for kind, source in report["sources"].items() if source["status"] != "ok"), file=sys.stderr)
            return 1
        return 0
    except BriefError as error:
        print("github_brief_error=" + str(error), file=sys.stderr)
        return 1
    except (OSError, UnicodeError, ValueError, TypeError, KeyError):
        # No traceback: it can contain private deployment paths or response data.
        print("github_brief_error=unexpected_runtime_error", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
