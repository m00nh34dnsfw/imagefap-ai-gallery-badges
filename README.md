# ImageFap AI Generated Gallery Badge

A small browser extension that adds a **🤖 AI** badge next to ImageFap galleries that are AI Generated — so you can see which ones they are at a glance.

## What it does

When you browse ImageFap's galleries, a small purple badge appears beside any gallery in the AI Generated category. No clicking, no waiting.

## Why it's built this way

ImageFap's main gallery page doesn't say which galleries are AI Generated. Finding out the slow way means opening each gallery and checking its categories.

So this extension keeps a list of AI Generated gallery IDs and checks each gallery against it. The answer is instant, and the site is barely touched.

## How it works

1. A list of AI Generated gallery IDs lives right here, in the **`ai_ids.txt`** file.
2. The first time the extension runs, it reads that list from this page and keeps a copy in your browser.
3. From then on, it checks galleries against your local copy — no waiting, no extra requests.
4. When you come across a gallery newer than anything in your copy, the extension quietly picks up the newest galleries and adds them to your list, so it stays up to date.

## Why the list lives here

The list is far too large to include inside the extension, and it needs one stable home that everyone can reach. Hosting it on this page gives it exactly that — and lets it be refreshed over time without changing the extension itself.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or a similar browser extension).
2. Open **`ImageFap AI Generated Gallery Badge-1.2.user.js`** on this page.
3. Click **Install**.
4. Browse ImageFap — AI Generated galleries now carry the badge.

## Keeping the list fresh

The list is refreshed now and then. If you look after it, update the **`ai_ids.txt`** file on this page and save the change. The extension picks up new galleries on its own as they appear.

---

Made for ImageFap. Not affiliated with or endorsed by ImageFap.
