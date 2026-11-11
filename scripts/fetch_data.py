#!/usr/bin/env python3
"""Pull Letterboxd, Hardcover and Strava activity into data/data.json.

Summary fields only: no GPS routes, maps, locations or activity names.
History accumulates: each run merges new entries into the existing file,
so data older than a feed's recent window is kept.

Secrets come from environment variables (set as GitHub Actions secrets):
  STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN, HARDCOVER_TOKEN
Python standard library only.
"""
import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "data.json"
LETTERBOXD_USER = "atlas_atticus"
HARDCOVER_URL = "https://api.hardcover.app/v1/graphql"
UA = "batticusjournalsystem/1.0 (personal journal tool)"
NS = {"lb": "https://letterboxd.com"}


def http(url, data=None, headers=None, method=None, timeout=40):
    req = urllib.request.Request(
        url, data=data, headers={"User-Agent": UA, **(headers or {})}, method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        # Include the service's own error text (it never echoes our secrets).
        body = exc.read().decode("utf-8", "replace")[:300]
        parsed = urllib.parse.urlparse(url)
        raise RuntimeError(f"HTTP {exc.code} from {parsed.netloc}{parsed.path}: {body}") from None


def merge(existing, new, key):
    """Merge lists of dicts by key; new entries win."""
    merged = {item[key]: item for item in existing}
    for item in new:
        merged[item[key]] = item
    return list(merged.values())


# ---------------------------------------------------------------- Letterboxd


def _clean_review(description):
    """Turn the feed's HTML into plain review text ('' if it is only a log)."""
    paragraphs = re.split(r"</p>", description or "")
    kept = []
    for p in paragraphs:
        if re.search(r"<img", p) and not re.sub(r"<[^>]+>", "", p).strip():
            continue
        text = html.unescape(re.sub(r"<[^>]+>", "", p)).strip()
        if not text or text.startswith("Watched on "):
            continue
        kept.append(text)
    return "\n\n".join(kept)


def parse_letterboxd(xml_text):
    root = ET.fromstring(xml_text)
    movies = []
    for item in root.iter("item"):
        watched = item.findtext("lb:watchedDate", namespaces=NS)
        if not watched:  # lists and other non-film entries
            continue
        guid = (item.findtext("guid") or item.findtext("link") or "").strip()
        rating = item.findtext("lb:memberRating", namespaces=NS)
        year = item.findtext("lb:filmYear", namespaces=NS)
        movies.append(
            {
                "id": guid,
                "title": item.findtext("lb:filmTitle", namespaces=NS),
                "year": int(year) if year and year.isdigit() else None,
                "watched_date": watched,
                "rating": float(rating) if rating else None,
                "rewatch": (item.findtext("lb:rewatch", namespaces=NS) or "").lower() == "yes",
                "review": _clean_review(item.findtext("description")),
                "url": item.findtext("link"),
            }
        )
    return movies


def fetch_letterboxd():
    xml_text = http(f"https://letterboxd.com/{LETTERBOXD_USER}/rss/")
    return parse_letterboxd(xml_text)


# ----------------------------------------------------------------- Hardcover

HC_FIELDS_BOOK = "book { title contributions { author { name } } }"
HC_QUERIES = [
    # richest first; fall back if a field name is rejected by the schema
    "query { me { user_books(order_by: {updated_at: desc}, limit: 500) "
    "{ id status_id rating review_raw reviewed_at date_added updated_at "
    + HC_FIELDS_BOOK
    + " user_book_reads { id started_at finished_at progress_pages } } } }",
    "query { me { user_books(order_by: {updated_at: desc}, limit: 500) "
    "{ id status_id rating date_added updated_at "
    + HC_FIELDS_BOOK
    + " user_book_reads { id started_at finished_at progress_pages } } } }",
    "query { me { user_books(limit: 500) { id status_id rating " + HC_FIELDS_BOOK + " } } }",
]


def hardcover_request(token, query):
    auth = token if token.lower().startswith("bearer ") else f"Bearer {token}"
    body = json.dumps({"query": query}).encode()
    raw = http(
        HARDCOVER_URL,
        data=body,
        headers={"Content-Type": "application/json", "authorization": auth},
        method="POST",
    )
    return json.loads(raw)


def parse_hardcover(payload):
    me = payload["data"]["me"]
    me = me[0] if isinstance(me, list) else me
    books = []
    for ub in me.get("user_books") or []:
        book = ub.get("book") or {}
        authors = [
            (c.get("author") or {}).get("name")
            for c in (book.get("contributions") or [])
            if (c.get("author") or {}).get("name")
        ]
        reads = [
            {
                "started_at": r.get("started_at"),
                "finished_at": r.get("finished_at"),
                "progress_pages": r.get("progress_pages"),
            }
            for r in (ub.get("user_book_reads") or [])
        ]
        books.append(
            {
                "id": str(ub["id"]),
                "title": book.get("title"),
                "authors": authors,
                "status_id": ub.get("status_id"),
                "rating": ub.get("rating"),
                "review": ub.get("review_raw") or "",
                "reviewed_at": ub.get("reviewed_at"),
                "date_added": ub.get("date_added"),
                "updated_at": ub.get("updated_at"),
                "reads": reads,
            }
        )
    return books


def fetch_hardcover(token):
    errors = []
    for query in HC_QUERIES:
        payload = hardcover_request(token, query)
        if payload.get("errors") or not payload.get("data"):
            errors.append(json.dumps(payload.get("errors"))[:300])
            continue
        return parse_hardcover(payload)
    raise RuntimeError("Hardcover queries failed: " + " | ".join(errors))


# -------------------------------------------------------------------- Strava


def strava_access_token(client_id, client_secret, refresh_token):
    body = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }
    ).encode()
    resp = json.loads(
        http(
            "https://www.strava.com/oauth/token",
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
    )
    if resp.get("refresh_token") and resp["refresh_token"] != refresh_token:
        print(
            "::warning::Strava issued a new refresh token. Update the "
            "STRAVA_REFRESH_TOKEN secret if the next run fails to authorize."
        )
    return resp["access_token"]


def fetch_strava(access_token, after_epoch=None):
    workouts = []
    for page in range(1, 26):
        url = f"https://www.strava.com/api/v3/athlete/activities?per_page=200&page={page}"
        if after_epoch:
            url += f"&after={after_epoch}"
        items = json.loads(http(url, headers={"Authorization": f"Bearer {access_token}"}))
        if not items:
            break
        for a in items:
            workouts.append(
                {
                    "id": str(a["id"]),
                    "type": a.get("sport_type") or a.get("type"),
                    "start_local": a.get("start_date_local"),
                    "distance_m": a.get("distance"),
                    "moving_time_s": a.get("moving_time"),
                    "elapsed_time_s": a.get("elapsed_time"),
                    "elevation_gain_m": a.get("total_elevation_gain"),
                }
            )
    return workouts


def strava_after_epoch(existing):
    starts = [w["start_local"] for w in existing if w.get("start_local")]
    if not starts:
        return None
    latest = max(starts).replace("Z", "+00:00")
    dt = datetime.fromisoformat(latest) - timedelta(days=3)  # catch late edits
    return int(dt.replace(tzinfo=timezone.utc).timestamp())


# ---------------------------------------------------------------------- main


def main():
    data = {"generated_at": None, "sources": {}, "movies": [], "books": [], "workouts": []}
    if DATA_FILE.exists():
        data.update(json.loads(DATA_FILE.read_text()))
    failures = []

    try:
        data["movies"] = merge(data["movies"], fetch_letterboxd(), "id")
        data["sources"]["letterboxd"] = "ok"
    except Exception as exc:  # keep going so one source can't block the others
        data["sources"]["letterboxd"] = f"error: {exc}"
        failures.append("letterboxd")

    try:
        token = os.environ["HARDCOVER_TOKEN"]
        data["books"] = merge(data["books"], fetch_hardcover(token), "id")
        data["sources"]["hardcover"] = "ok"
    except Exception as exc:
        data["sources"]["hardcover"] = f"error: {exc}"
        failures.append("hardcover")

    try:
        access = strava_access_token(
            os.environ["STRAVA_CLIENT_ID"],
            os.environ["STRAVA_CLIENT_SECRET"],
            os.environ["STRAVA_REFRESH_TOKEN"],
        )
        new = fetch_strava(access, strava_after_epoch(data["workouts"]))
        data["workouts"] = merge(data["workouts"], new, "id")
        data["sources"]["strava"] = "ok"
    except Exception as exc:
        data["sources"]["strava"] = f"error: {exc}"
        failures.append("strava")

    data["movies"].sort(key=lambda m: m.get("watched_date") or "", reverse=True)
    data["workouts"].sort(key=lambda w: w.get("start_local") or "", reverse=True)
    data["books"].sort(key=lambda b: b.get("updated_at") or "", reverse=True)
    data["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

    for name in failures:
        print(f"::error::{name} failed: {data['sources'][name]}")
    print(
        f"movies={len(data['movies'])} books={len(data['books'])} "
        f"workouts={len(data['workouts'])} failures={failures or 'none'}"
    )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
