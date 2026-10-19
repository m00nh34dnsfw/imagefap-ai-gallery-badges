// ==UserScript==
// @name         ImageFap AI Generated Gallery Badge
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Shows an AI Generated badge next to galleries in the "AI Generated" category on imagefap.com, using a bootstrapped ID list instead of scraping each gallery
// @author       You
// @match        https://www.imagefap.com/gallery.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      www.imagefap.com
// @connect      pastebin.com
// @connect      gist.githubusercontent.com
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // --- Configuration ---
    const AI_CATEGORY_TEXT = 'AI Generated';
    const AI_CATEGORY_ID = 70;
    const AI_BADGE_TITLE = 'This gallery is categorized as AI Generated';

    // The category-specific listing lives under /pics/. The AI Generated
    // category listing is:
    //   https://www.imagefap.com/pics/70/gallery.php?type=1&userid=&gen=70&search=&page=1&perpage=150
    // NOTE: imagefap ignores perpage above 120, so each page holds ~120 galleries.
    const AI_LIST_BASE = 'https://www.imagefap.com/pics/' + AI_CATEGORY_ID + '/gallery.php?type=1&userid=&gen=' + AI_CATEGORY_ID + '&search=&perpage=150';
    const AI_LIST_PAGE_URL = (page) => AI_LIST_BASE + '&page=' + page;

    // Bootstrap sources. Each entry is either a full URL (GitHub Gist, GitHub
    // repo raw, jsDelivr, PasteBin raw, ...) or a bare PasteBin paste ID. All
    // sources are merged; use several only if a single file would exceed a
    // host's limit. GitHub is preferred over PasteBin: no 512KB per-paste cap
    // and full revision history.
    //   Gist: https://gist.githubusercontent.com/<user>/<gist-id>/raw
    //   Repo: https://raw.githubusercontent.com/<user>/<repo>/<branch>/<path>
    //   CDN:  https://cdn.jsdelivr.net/gh/<user>/<repo>@<branch>/<path>
    const PASTEBIN_RAW_BASE = 'https://pastebin.com/raw/';
    const BOOTSTRAP_SOURCES = [
        // GitHub Gist (preferred):
        // 'https://gist.githubusercontent.com/you/0123456789abcdef/raw',
        // GitHub repo raw:
        // 'https://raw.githubusercontent.com/you/imagefap-ai/main/ai_ids.txt',
        // jsDelivr CDN (cached):
        // 'https://cdn.jsdelivr.net/gh/you/imagefap-ai@main/ai_ids.txt',
        // PasteBin (512KB per paste; split across several IDs):
        // 'PASTEBIN_ID_1',
    ];

    // Incremental load tuning. The load fetches listing pages newest-first. The
    // first pages are short (~120) because recently uploaded galleries are
    // counted but not yet shown; deeper pages are full (~147). We stop after
    // passing the known region and reaching a "full" page, so late-published
    // galleries are not dropped.
    const MAX_REFRESH_PAGES = 30;   // Safety cap per load
    const REFRESH_PAGE_DELAY_MS = 1000; // Delay between listing page fetches
    const MIN_FULL_PAGE = 140;      // A page this size is past the pending region

    const LIST_CACHE_KEY = 'imagefap_ai_id_list_v2';

    // --- Styles ---
    GM_addStyle(`
        .ai-gen-badge {
            display: inline-block;
            margin-left: 6px;
            padding: 1px 6px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: bold;
            font-family: Verdana, Arial, sans-serif;
            color: #fff !important;
            background: linear-gradient(135deg, #6366f1, #8b5cf6);
            vertical-align: middle;
            cursor: default;
            white-space: nowrap;
            line-height: 1.4;
            box-shadow: 0 1px 3px rgba(0,0,0,0.25);
        }
        .ai-gen-badge:hover {
            background: linear-gradient(135deg, #4f46e5, #7c3aed);
        }
    `);

    // --- Small helpers ---
    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    // --- Persistent store (GM storage, falls back to localStorage) ---
    function storeGet(key, fallback) {
        try {
            const v = GM_getValue ? GM_getValue(key, null) : null;
            if (v !== null && v !== undefined) return v;
        } catch (e) { /* ignore */ }
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function storeSet(key, value) {
        try {
            if (GM_setValue) {
                GM_setValue(key, value);
                return;
            }
        } catch (e) { /* fall through */ }
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            // Storage might be full; fail silently.
        }
    }

    // --- HTTP helper (cross-origin, bypasses the page origin) ---
    function fetchText(url, timeout) {
        return new Promise(function (resolve) {
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    timeout: timeout || 20000,
                    onload: function (response) { resolve({ ok: true, text: response.responseText || '' }); },
                    onerror: function () { resolve({ ok: false, text: '' }); },
                    ontimeout: function () { resolve({ ok: false, text: '' }); },
                });
            } catch (e) {
                resolve({ ok: false, text: '' });
            }
        });
    }

    // --- Gallery link discovery ---
    function findGalleryLinks() {
        const links = document.querySelectorAll('a.gal_title[href*="gallery.php?gid="]');
        const galleries = [];
        const seen = new Set();
        links.forEach(function (link) {
            const href = link.getAttribute('href');
            if (!href) return;
            const match = href.match(/gallery\.php\?gid=(\d+)/);
            if (!match) return;
            const gid = match[1];
            if (seen.has(gid)) return;
            seen.add(gid);
            if (link.parentElement && link.parentElement.querySelector('.ai-gen-badge')) return;
            galleries.push({ gid: gid, link: link });
        });
        return galleries;
    }

    // --- Parsers ---
    function parseGidsFromHtml(html) {
        const gids = [];
        const seen = new Set();
        // Handles both /gallery.php?gid=12345 and /gallery/12345/ paths.
        const re = /gallery(?:\.php\?gid=|%3Fgid=|%253Fgid=|\/)(\d+)/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
            const gid = m[1];
            if (!seen.has(gid)) {
                seen.add(gid);
                gids.push(gid);
            }
        }
        return gids;
    }

    function parseBootstrapText(text) {
        const trimmed = (text || '').trim();
        if (!trimmed) return [];
        // Accept {"ids": ["1","2",...]} or a bare ["1","2",...] or plain
        // whitespace/comma-separated IDs (what the harvester produces).
        try {
            const data = JSON.parse(trimmed);
            if (Array.isArray(data)) return data.map(String);
            if (data && Array.isArray(data.ids)) return data.ids.map(String);
            if (data && Array.isArray(data.galleries)) return data.galleries.map(String);
        } catch (e) {
            // Not JSON; fall through to whitespace splitting.
        }
        return trimmed.split(/[\s,]+/).filter(Boolean);
    }

    // --- AI ID list store ---
    // Shape: { ids, aiMaxId, lastSeenMaxGid, bootstrapped, updated }
    //  - aiMaxId: newest AI gallery ID we have (contiguous frontier for loading).
    //  - lastSeenMaxGid: newest gallery ID seen while browsing (any category).
    function getList() {
        let list = storeGet(LIST_CACHE_KEY, null);
        if (!list || !Array.isArray(list.ids)) {
            list = { ids: [], aiMaxId: 0, lastSeenMaxGid: 0, bootstrapped: false, updated: 0 };
        }
        if (typeof list.aiMaxId !== 'number') list.aiMaxId = 0;
        if (typeof list.lastSeenMaxGid !== 'number') list.lastSeenMaxGid = 0;
        return list;
    }

    function saveList(list) {
        // Deduplicate while preserving order. Only plain arrays are persisted.
        const seen = new Set();
        list.ids = list.ids.filter(function (id) { return !seen.has(id) && seen.add(id); });
        list.updated = Date.now();
        storeSet(LIST_CACHE_KEY, list);
    }

    function maxIdOf(ids) {
        let max = 0;
        for (let i = 0; i < ids.length; i++) {
            const n = parseInt(ids[i], 10);
            if (!isNaN(n) && n > max) max = n;
        }
        return max;
    }

    // --- Bootstrap: import the full known ID list once ---
    async function loadBootstrap() {
        const merged = [];
        for (const source of BOOTSTRAP_SOURCES) {
            if (!source || source.indexOf('PLACEHOLDER') === 0 || source.indexOf('PASTEBIN_ID_') === 0) continue;
            const url = /^https?:\/\//i.test(source) ? source : PASTEBIN_RAW_BASE + source;
            const res = await fetchText(url);
            const ids = parseBootstrapText(res.text);
            if (ids.length) {
                merged.push.apply(merged, ids);
                console.log('[AI Badge] Bootstrap: loaded ' + ids.length + ' IDs from ' + url);
            } else {
                console.warn('[AI Badge] Bootstrap source empty or not found: ' + url);
            }
        }
        return merged;
    }

    // --- Incremental load: fetch newest listing pages until we catch up ---
    // The listing is sorted newest-first (by gallery ID). We add every ID and
    // stop once we have passed the known region AND reached a "full" page. The
    // first pages are short (~120) because recently uploaded galleries are
    // counted but not yet shown; deeper pages are full (~147). Waiting for a
    // full page gives the overlap needed so galleries that only appear later
    // are not dropped.
    async function incrementalLoad(list) {
        const knownSet = new Set(list.ids || []);
        const merged = new Set(list.ids || []);
        let fetched = 0;
        let seenKnown = false;
        let reachedFrontier = false;

        for (let page = 1; page <= MAX_REFRESH_PAGES; page++) {
            const res = await fetchText(AI_LIST_PAGE_URL(page));
            if (!res.ok || !res.text) {
                console.warn('[AI Badge] Incremental load page ' + page + ' failed; stopping.');
                break;
            }
            const gids = parseGidsFromHtml(res.text);
            if (gids.length === 0) {
                console.log('[AI Badge] Incremental load: no galleries on page ' + page + '; done.');
                reachedFrontier = true;
                break;
            }
            fetched++;

            let pageHasKnown = false;
            for (let i = 0; i < gids.length; i++) {
                merged.add(gids[i]);
                if (knownSet.has(gids[i])) pageHasKnown = true;
            }
            if (pageHasKnown) seenKnown = true;

            if (seenKnown && gids.length >= MIN_FULL_PAGE) {
                reachedFrontier = true;
                console.log('[AI Badge] Incremental load: passed the known region on page ' + page + '.');
                break;
            }
            if (page < MAX_REFRESH_PAGES) await sleep(REFRESH_PAGE_DELAY_MS);
        }

        const out = { ids: Array.from(merged), idSet: merged, reachedFrontier: reachedFrontier };
        console.log('[AI Badge] Incremental load: ' + fetched + ' pages, ' + merged.size + ' IDs total.');
        return out;
    }

    // --- Badge helpers ---
    function addBadgeToGalleryLink(galleryLink) {
        if (galleryLink.parentElement && galleryLink.parentElement.querySelector('.ai-gen-badge')) return;
        const badge = document.createElement('span');
        badge.className = 'ai-gen-badge';
        badge.textContent = '🤖 AI';
        badge.title = AI_BADGE_TITLE;
        galleryLink.parentNode.insertBefore(badge, galleryLink.nextSibling);
    }

    // --- Apply badges to the galleries on the current page ---
    function applyBadges(galleries, idSet) {
        let aiCount = 0;
        galleries.forEach(function (g) {
            if (idSet.has(g.gid)) {
                addBadgeToGalleryLink(g.link);
                aiCount++;
            }
        });
        console.log('[AI Badge] Badged ' + aiCount + ' of ' + galleries.length + ' galleries on this page.');
    }

    // --- Main ---
    async function main() {
        let list = getList();
        const galleries = findGalleryLinks();

        // Import the bootstrap once. Nothing (not even an incremental load) is
        // attempted until we have a real list to compare against.
        if (list.ids.length === 0) {
            const bootstrapped = await loadBootstrap();
            if (bootstrapped.length === 0) {
                console.warn('[AI Badge] No bootstrap data available; add a source to BOOTSTRAP_SOURCES.');
                return;
            }
            list.ids = bootstrapped;
            list.bootstrapped = true;
            // Start both frontiers at the newest AI gallery we know about.
            list.aiMaxId = maxIdOf(list.ids);
            list.lastSeenMaxGid = list.aiMaxId;
            saveList(list);
            console.log('[AI Badge] Bootstrap imported: ' + list.ids.length + ' AI gallery IDs.');
        }

        const idSet = new Set(list.ids);
        applyBadges(galleries, idSet);

        // Trigger an incremental load only when we browse a gallery newer than
        // both the newest AI gallery we know and anything we have seen before.
        let maxOnPage = 0;
        galleries.forEach(function (g) {
            const n = parseInt(g.gid, 10);
            if (!isNaN(n) && n > maxOnPage) maxOnPage = n;
        });
        list.lastSeenMaxGid = Math.max(list.lastSeenMaxGid || 0, maxOnPage);

        const threshold = Math.max(list.aiMaxId || 0, list.lastSeenMaxGid || 0);
        if (maxOnPage > threshold) {
            console.log('[AI Badge] Saw a newer gallery (' + maxOnPage + ' > ' + threshold + '); running incremental load.');
            const loaded = await incrementalLoad(list);
            list.ids = loaded.ids;
            // Only advance the AI frontier once we actually caught up; otherwise
            // keep it so the next load continues where this one left off.
            if (loaded.reachedFrontier) list.aiMaxId = maxIdOf(list.ids);
            saveList(list);
            // Re-apply so galleries that turned out to be AI get badged now.
            applyBadges(findGalleryLinks(), loaded.idSet);
        } else {
            saveList(list);
        }
    }

    main().catch(function (e) { console.warn('[AI Badge]', e); });

})();
