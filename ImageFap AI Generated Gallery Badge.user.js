// ==UserScript==
// @name         ImageFap AI Generated Gallery Badge
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Shows an AI Generated badge next to galleries in the "AI Generated" category on imagefap.com, using a bootstrapped ID list instead of scraping each gallery
// @author       m00nh34dNSFW
// @match        https://www.imagefap.com/gallery.php*
// @match        https://www.imagefap.com/pics/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      www.imagefap.com
// @connect      raw.githubusercontent.com
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

    // Bootstrap sources. Each entry is a full URL to a plain text file of
    // gallery IDs, one per line. The canonical list is hosted in the GitHub
    // repository for this project; the add-on reads it once and then keeps a
    // local copy. Add more URLs only if a single file would be too large.
    const BOOTSTRAP_SOURCES = [
        'https://raw.githubusercontent.com/m00nh34dnsfw/imagefap-ai-gallery-badges/refs/heads/main/ai_ids.txt',
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

    // --- Logging ---
    function log() {
        console.log.apply(console, ['[AI Badge]'].concat(Array.prototype.slice.call(arguments)));
    }

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
    // `anonymous: true` matters: without it Tampermonkey sends the user's
    // cookies (PHPSESSID), and because our listing requests carry
    // `perpage=150`, imagefap stores that as the user's "galleries per page"
    // preference server-side. The public listing is byte-for-byte the same
    // without cookies, so fetching anonymously keeps their settings intact.
    function fetchText(url, timeout) {
        return new Promise(function (resolve) {
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    timeout: timeout || 20000,
                    anonymous: true,
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
        for (const url of BOOTSTRAP_SOURCES) {
            if (!url) continue;
            log('Bootstrap: fetching ' + url);
            const res = await fetchText(url);
            if (!res.ok) {
                console.warn('[AI Badge] Bootstrap fetch failed for ' + url);
                continue;
            }
            const ids = parseBootstrapText(res.text);
            if (ids.length) {
                merged.push.apply(merged, ids);
                log('Bootstrap: got ' + ids.length + ' IDs from ' + url);
            } else {
                console.warn('[AI Badge] Bootstrap source empty: ' + url);
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

        log('Incremental load: starting (stored ' + knownSet.size + ' IDs).');

        for (let page = 1; page <= MAX_REFRESH_PAGES; page++) {
            const res = await fetchText(AI_LIST_PAGE_URL(page));
            if (!res.ok || !res.text) {
                log('Incremental load: page ' + page + ' failed; stopping.');
                break;
            }
            const gids = parseGidsFromHtml(res.text);
            log('Incremental load: page ' + page + ' returned ' + gids.length + ' galleries.');
            if (gids.length === 0) {
                log('Incremental load: page ' + page + ' empty; done.');
                reachedFrontier = true;
                break;
            }
            fetched++;

            let pageHasKnown = false;
            for (let i = 0; i < gids.length; i++) {
                merged.add(gids[i]);
                if (knownSet.has(gids[i])) pageHasKnown = true;
            }
            if (pageHasKnown) {
                seenKnown = true;
                log('Incremental load: page ' + page + ' contains a gallery we already have.');
            }

            if (seenKnown && gids.length >= MIN_FULL_PAGE) {
                reachedFrontier = true;
                log('Incremental load: passed the known region on page ' + page + '.');
                break;
            }
            if (page < MAX_REFRESH_PAGES) await sleep(REFRESH_PAGE_DELAY_MS);
        }

        log('Incremental load: fetched ' + fetched + ' pages, ' + merged.size + ' IDs total.');
        return { ids: Array.from(merged), idSet: merged, reachedFrontier: reachedFrontier };
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
        return aiCount;
    }

    // --- Main ---
    async function main() {
        log('Running on ' + location.href);
        lastGalleryCount = document.querySelectorAll('a.gal_title[href*="gallery.php?gid="]').length;

        let list = getList();
        const galleries = findGalleryLinks();

        if (list.ids.length === 0) {
            log('No stored list. Importing bootstrap...');
            const bootstrapped = await loadBootstrap();
            if (bootstrapped.length === 0) {
                console.warn('[AI Badge] No bootstrap data available; check BOOTSTRAP_SOURCES.');
                return;
            }
            list.ids = bootstrapped;
            list.bootstrapped = true;
            // Start both frontiers at the newest AI gallery we know about.
            list.aiMaxId = maxIdOf(list.ids);
            list.lastSeenMaxGid = list.aiMaxId;
            saveList(list);
            log('Bootstrap imported: ' + list.ids.length + ' IDs, newest ' + list.aiMaxId + '.');
        } else {
            log('Loaded stored list: ' + list.ids.length + ' IDs, newest ' + (list.aiMaxId || 'n/a') + '.');
        }

        const idSet = new Set(list.ids);
        const badged = applyBadges(galleries, idSet);
        log('Checked ' + galleries.length + ' galleries on this page; badged ' + badged + '.');

        // Trigger an incremental load only when we browse a gallery newer than
        // both the newest AI gallery we know and anything we have seen before.
        let maxOnPage = 0;
        galleries.forEach(function (g) {
            const n = parseInt(g.gid, 10);
            if (!isNaN(n) && n > maxOnPage) maxOnPage = n;
        });

        const threshold = Math.max(list.aiMaxId || 0, list.lastSeenMaxGid || 0);
        log('Update check: newest on page ' + maxOnPage + ', newest known AI ' + list.aiMaxId + ', newest seen ' + list.lastSeenMaxGid + ', threshold ' + threshold + '.');

        if (maxOnPage > threshold) {
            log('A newer gallery is on this page; running incremental load...');
            const loaded = await incrementalLoad(list);
            list.ids = loaded.ids;
            // Only advance the AI frontier once we actually caught up; otherwise
            // keep it so the next load continues where this one left off.
            if (loaded.reachedFrontier) list.aiMaxId = maxIdOf(list.ids);
            list.lastSeenMaxGid = Math.max(list.lastSeenMaxGid || 0, maxOnPage);
            saveList(list);
            log('Incremental load done; list now ' + list.ids.length + ' IDs, newest ' + list.aiMaxId + '.');
            const badgedAfter = applyBadges(findGalleryLinks(), loaded.idSet);
            log('Re-applied badges after update; badged ' + badgedAfter + '.');
        } else {
            list.lastSeenMaxGid = Math.max(list.lastSeenMaxGid || 0, maxOnPage);
            saveList(list);
            log('No newer galleries; nothing to update.');
        }
    }

    function runMain() {
        main().catch(function (e) { console.warn('[AI Badge]', e); });
    }

    let lastGalleryCount = -1;
    let debounceTimer = null;

    runMain();

    // Re-run when the page adds galleries (e.g. "next page" or infinite scroll).
    const observer = new MutationObserver(function () {
        const count = document.querySelectorAll('a.gal_title[href*="gallery.php?gid="]').length;
        if (count === lastGalleryCount) return;
        lastGalleryCount = count;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(runMain, 800);
    });
    observer.observe(document.body, { childList: true, subtree: true });

})();
