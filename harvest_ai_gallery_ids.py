"""
ImageFap AI Generated gallery ID harvester.

Downloads the list of gallery IDs from the "AI Generated" category listing
(https://www.imagefap.com/pics/70/gallery.php?type=1&userid=&gen=70&search=&page=N&perpage=150)
and writes them to a text file, one ID per line.

Full harvest (default):
    Pages from page 1 (newest) to the end (oldest), appending every ID. The run
    is resumable: it remembers the last completed page, so you can re-run it as
    often as you like.

Update (--update):
    Reads the existing IDs from --out, then fetches from page 1 and stops after
    passing the known region with a "full" page. This adds only the galleries
    new since the last run, so you do not have to re-harvest everything.

NOTE: imagefap ignores perpage above 120, so each page holds ~120 galleries.
The first pages are short (~120) because recently uploaded galleries are counted
but not yet shown; deeper pages are full (~147). This is why the update stops
after a full page rather than at the first known ID.

Usage:
    python harvest_ai_gallery_ids.py                 # full harvest
    python harvest_ai_gallery_ids.py --update        # update an existing list
    python harvest_ai_gallery_ids.py --out ai_ids.txt --delay 1.5

Notes:
    * This hits the site a lot. Keep --delay >= 1.5 and watch for the CAPTCHA
      page. If a CAPTCHA is detected, the script stops and tells you to solve it
      in the browser, then re-run to continue.
    * GitHub is a good place to host the produced file for the userscript
      bootstrap (no 512KB cap, revision history):
        https://gist.githubusercontent.com/<user>/<gist-id>/raw
        https://raw.githubusercontent.com/<user>/<repo>/<branch>/<path>
"""

import argparse
import json
import os
import re
import sys
import time

try:
    import requests
except ImportError:
    print("This script needs the 'requests' package. Install it with:")
    print("    pip install requests")
    sys.exit(1)


BASE = (
    "https://www.imagefap.com/pics/70/gallery.php"
    "?type=1&userid=&gen=70&search=&perpage=150"
)
GID_RE = re.compile(r"gallery(?:\.php\?gid=|%3Fgid=|%253Fgid=|\/)(\d+)", re.IGNORECASE)
CAPTCHA_RE = re.compile(r"(captcha|are you a human|verify you are human|access denied|blocked)", re.IGNORECASE)

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def load_state(state_path):
    if os.path.exists(state_path):
        with open(state_path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    return {"page": 1, "done": False}


def save_state(state_path, state):
    tmp = state_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh)
    os.replace(tmp, state_path)


def fetch_page(session, page, timeout):
    url = BASE + "&page=" + str(page)
    resp = session.get(url, timeout=timeout)
    resp.raise_for_status()
    return resp.text


def parse_gids(html):
    """Return gallery IDs from a listing page, deduplicated, in page order."""
    out = []
    seen = set()
    for gid in GID_RE.findall(html):
        if gid not in seen:
            seen.add(gid)
            out.append(gid)
    return out


def run_update(session, args, known, all_seen):
    """Fetch new galleries only: page 1 downward until the known region is passed.

    The first pages of the listing are short because recently uploaded galleries
    are counted but not yet shown. Stop only once we have seen a known ID (the
    old region) AND a "full" page, so late-published galleries are not dropped.
    """
    page = 1
    seen_known = False
    total_new = 0

    print("Update mode: %d known IDs. Starting at page 1." % len(known))

    while True:
        try:
            html = fetch_page(session, page, args.timeout)
        except Exception as exc:  # noqa: BLE001
            print("Page %d request failed: %s" % (page, exc))
            print("Re-run with --update to try again.")
            break

        if CAPTCHA_RE.search(html) and not parse_gids(html):
            print("")
            print("=" * 60)
            print("CAPTCHA or block page detected on page %d." % page)
            print("Solve it in your browser, then re-run with --update.")
            print("=" * 60)
            break

        gids = parse_gids(html)
        if not gids:
            print("Page %d had no galleries; update complete." % page)
            break

        page_has_known = any(gid in known for gid in gids)
        new_gids = []
        for gid in gids:
            if gid not in all_seen:
                all_seen.add(gid)
                new_gids.append(gid)

        if new_gids:
            with open(args.out, "a", encoding="utf-8") as fh:
                for gid in new_gids:
                    fh.write(gid + "\n")
            total_new += len(new_gids)

        if page_has_known:
            seen_known = True

        print("Page %d: %d galleries, +%d new (known region: %s)"
              % (page, len(gids), len(new_gids), "seen" if page_has_known else "not yet"), flush=True)

        if seen_known and len(gids) >= args.min_full_page:
            print("Reached the known region and a full page; update complete.")
            break

        page += 1
        time.sleep(args.delay)

    print("Update finished. %d new IDs collected. Total: %d" % (total_new, len(all_seen)))


def run_full(session, args, state, state_path, seen):
    """Page from the stored resume point to the end of the list."""
    page = int(state.get("page", 1))
    start_page = page
    total_new = 0

    print("Resuming from page %d. Already have %d IDs." % (start_page, len(seen)))

    while True:
        if args.pages and page > start_page + args.pages - 1:
            break

        try:
            html = fetch_page(session, page, args.timeout)
        except Exception as exc:  # noqa: BLE001
            print("Page %d request failed: %s" % (page, exc))
            print("Will retry from this page on the next run.")
            break

        if CAPTCHA_RE.search(html) and not parse_gids(html):
            print("")
            print("=" * 60)
            print("CAPTCHA or block page detected on page %d." % page)
            print("Solve it in your browser, then re-run this script to continue.")
            print("=" * 60)
            break

        gids = parse_gids(html)
        if not gids:
            print("Page %d had no galleries. Reached the end of the list." % page)
            state["done"] = True
            state["page"] = page + 1
            save_state(state_path, state)
            break

        new_gids = []
        for gid in gids:
            if gid not in seen:
                seen.add(gid)
                new_gids.append(gid)

        if new_gids:
            with open(args.out, "a", encoding="utf-8") as fh:
                for gid in new_gids:
                    fh.write(gid + "\n")
            total_new += len(new_gids)

        print("Page %d: %d galleries, +%d new (total %d)"
              % (page, len(gids), len(new_gids), len(seen)), flush=True)

        state["page"] = page + 1
        save_state(state_path, state)
        page += 1
        time.sleep(args.delay)

    print("Finished. %d new IDs collected. Total: %d" % (total_new, len(seen)))


def main():
    ap = argparse.ArgumentParser(description="Harvest ImageFap AI Generated gallery IDs.")
    ap.add_argument("--out", default="ai_ids.txt", help="Output file for gallery IDs.")
    ap.add_argument("--pages", type=int, default=0,
                    help="Max pages to fetch (0 = until no more galleries). Full harvest only.")
    ap.add_argument("--delay", type=float, default=1.5,
                    help="Seconds to wait between requests.")
    ap.add_argument("--timeout", type=float, default=30.0, help="HTTP timeout in seconds.")
    ap.add_argument("--resume", action="store_true", default=True,
                    help="Resume from the last completed page (default on).")
    ap.add_argument("--no-resume", dest="resume", action="store_false",
                    help="Start from page 1.")
    ap.add_argument("--update", action="store_true",
                    help="Update an existing list incrementally instead of a full harvest.")
    ap.add_argument("--min-full-page", type=int, default=140,
                    help="In --update mode, stop after passing the known region and reaching "
                         "a page with at least this many galleries.")
    ap.add_argument("--cookie", default="", help="Optional Cookie header value.")
    ap.add_argument("--user-agent", default=DEFAULT_UA)
    args = ap.parse_args()

    session = requests.Session()
    session.headers.update({"User-Agent": args.user_agent})
    if args.cookie:
        session.headers["Cookie"] = args.cookie

    known = set()
    if os.path.exists(args.out):
        with open(args.out, "r", encoding="utf-8") as fh:
            for line in fh:
                gid = line.strip()
                if gid:
                    known.add(gid)

    if args.update:
        if not known:
            print("No existing IDs found in %s. Run a full harvest first." % args.out)
            sys.exit(1)
        run_update(session, args, known, set(known))
        return

    state_path = args.out + ".state.json"
    state = load_state(state_path) if args.resume else {"page": 1, "done": False}
    run_full(session, args, state, state_path, known)


if __name__ == "__main__":
    main()
