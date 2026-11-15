// Fast Gallery: an Instagram-style replacement for SillyTavern's "Show Gallery".
//
// - Square grid, loaded in batches as you scroll.
// - Tap a tile to open it full screen. Swipe or use the arrows to move, tap to zoom.
// - Long-press a tile to start selecting, then drag across tiles to select more.
//   Drag near the top or bottom edge to scroll while selecting.
// - Delete the selection, or the item open in the viewer. Deletes are permanent.
// - Video posters are made on demand and cached in Cache Storage.

import { characters, this_chid, getRequestHeaders, eventSource, event_types } from '../../../../script.js';
import { selected_group } from '../../../group-chats.js';
import { getSanitizedFilename } from '../../../utils.js';
import { MEDIA_REQUEST_TYPE, VIDEO_EXTENSIONS } from '../../../constants.js';

const CACHE_NAME = 'st-fast-gallery-posters-v1';
const CONCURRENCY = 2;
const POSTER_TIMEOUT_MS = 8000;
const MAX_POSTER_SIDE = 360;
const BATCH = 60;
const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE_PX = 10;
const EDGE_ZONE_PX = 80;
const MAX_AUTOSCROLL_PX = 20;
const SWIPE_MIN_PX = 60;

const ROOT_ID = 'stfg-overlay';
const BUTTON_ID = 'stfg_wand_button';
const CHAR_OPTION_ID = 'stfg_char_gallery';
const BUILTIN_IDS = ['show_gallery_wand_button', 'show_char_gallery'];

const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#161616"/></svg>',
);

const videoRegexes = VIDEO_EXTENSIONS.map(ext => new RegExp(`\\.${ext}$`, 'i'));
const isVideo = name => videoRegexes.some(re => re.test(name));

/** The open gallery, or null while it is closed. */
let session = null;
/** Used only when Cache Storage is unavailable (insecure origin). */
const memoryPosterCache = new Map();

// ---------- poster queue ----------

const jobs = [];
let running = 0;

function runQueued(fn) {
    return new Promise((resolve, reject) => {
        jobs.push({ fn, resolve, reject });
        drainQueue();
    });
}

function drainQueue() {
    while (running < CONCURRENCY && jobs.length > 0) {
        const { fn, resolve, reject } = jobs.shift();
        running++;
        Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
                running--;
                drainQueue();
            });
    }
}

// ---------- posters ----------

/**
 * Decodes one frame from the middle of a video and returns it as a JPEG blob.
 * Rejects after POSTER_TIMEOUT_MS, and always releases the video element.
 */
function makePoster(src) {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';

        let timer = null;
        const cleanup = () => {
            clearTimeout(timer);
            video.onloadeddata = null;
            video.onseeked = null;
            video.onerror = null;
            video.removeAttribute('src');
            video.load();
        };
        const fail = (err) => {
            cleanup();
            reject(err);
        };

        timer = setTimeout(() => fail(new Error(`poster timed out: ${src}`)), POSTER_TIMEOUT_MS);

        const draw = () => {
            try {
                const w = video.videoWidth;
                const h = video.videoHeight;
                if (!w || !h) {
                    throw new Error(`no video dimensions: ${src}`);
                }
                const scale = Math.min(1, MAX_POSTER_SIDE / Math.max(w, h));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(w * scale));
                canvas.height = Math.max(1, Math.round(h * scale));
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                canvas.toBlob((blob) => {
                    cleanup();
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error(`toBlob failed: ${src}`));
                    }
                }, 'image/jpeg', 0.82);
            } catch (err) {
                fail(err);
            }
        };

        video.onerror = () => fail(new Error(`cannot decode video: ${src}`));
        video.onloadeddata = () => {
            const middle = Number.isFinite(video.duration) ? video.duration / 2 : 0;
            if (middle > 0) {
                video.onseeked = draw;
                video.currentTime = middle;
            } else {
                draw();
            }
        };

        video.src = src;
    });
}

async function getPosterBlob(url) {
    const key = new URL(url, location.href).href;

    if ('caches' in window) {
        const cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(key);
        if (hit) {
            return hit.blob();
        }
        const blob = await runQueued(() => makePoster(url));
        await cache.put(key, new Response(blob, { headers: { 'Content-Type': 'image/jpeg' } }));
        return blob;
    }

    if (memoryPosterCache.has(key)) {
        return memoryPosterCache.get(key);
    }
    const blob = await runQueued(() => makePoster(url));
    memoryPosterCache.set(key, blob);
    return blob;
}

/** Forgets the cached poster for a file that has been deleted. */
async function dropPoster(url) {
    const key = new URL(url, location.href).href;
    memoryPosterCache.delete(key);
    if ('caches' in window) {
        try {
            const cache = await caches.open(CACHE_NAME);
            await cache.delete(key);
        } catch {
            // Cache Storage unavailable; nothing to forget.
        }
    }
}

// ---------- data ----------

function currentFolderKey() {
    if (selected_group) {
        return selected_group;
    }
    if (this_chid === undefined) {
        return null;
    }
    const char = characters?.[this_chid];
    if (!char) {
        return null;
    }
    // Same folder mapping the built-in gallery uses.
    const folders = SillyTavern.getContext().extensionSettings?.gallery?.folders ?? {};
    return folders[char.avatar] ?? char.name;
}

async function listGalleryFiles(folderKey) {
    const response = await fetch('/api/images/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            folder: folderKey,
            sortField: 'date',
            sortOrder: 'asc',
            type: MEDIA_REQUEST_TYPE.IMAGE | MEDIA_REQUEST_TYPE.VIDEO,
        }),
    });
    if (!response.ok) {
        throw new Error(`images/list failed: ${response.status}`);
    }
    return response.json();
}

function createSession(folderKey, base, files) {
    return {
        folderKey,
        items: files.map((file) => {
            const path = `${base}/${file}`;
            return {
                file,
                path,
                url: '/' + path.split('/').map(encodeURIComponent).join('/'),
                video: isVideo(file),
            };
        }),
        rendered: 0,
        visible: BATCH,
        selectMode: false,
        selected: new Set(),
        drag: null,
        press: null,
        pressTimer: null,
        longFired: false,
        suppressClick: false,
        swipe: null,
        pending: [],
        lbIndex: -1,
        lastX: 0,
        lastY: 0,
        raf: 0,
        objectUrls: [],
        dom: null,
        tileObserver: null,
        moreObserver: null,
    };
}

// ---------- overlay ----------

function buildOverlay(s) {
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `
        <header class="stfg-top">
            <button type="button" class="stfg-icon-btn stfg-close" title="Close (Esc)" aria-label="Close gallery">
                <i class="fa-solid fa-xmark"></i>
            </button>
            <div class="stfg-top-text">
                <div class="stfg-name"></div>
                <div class="stfg-sub"></div>
            </div>
            <button type="button" class="stfg-text-btn stfg-select">Select</button>
        </header>

        <main class="stfg-scroll">
            <div class="stfg-grid"></div>
            <div class="stfg-more"></div>
            <div class="stfg-empty" hidden>
                <div class="stfg-empty-ring"><i class="fa-regular fa-image"></i></div>
                <h3>No photos or videos yet</h3>
                <p>Images and videos for this character will appear here.</p>
            </div>
        </main>

        <footer class="stfg-actions">
            <button type="button" class="stfg-text-btn stfg-selall">Select all</button>
            <span class="stfg-selcount">0 selected</span>
            <button type="button" class="stfg-delete" disabled><i class="fa-solid fa-trash"></i> Delete</button>
        </footer>

        <div class="stfg-lightbox" hidden>
            <div class="stfg-lb-top">
                <button type="button" class="stfg-icon-btn stfg-lb-close" aria-label="Close viewer">
                    <i class="fa-solid fa-xmark"></i>
                </button>
                <span class="stfg-lb-count"></span>
                <button type="button" class="stfg-icon-btn stfg-lb-delete" title="Delete (Del)" aria-label="Delete this item">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
            <div class="stfg-lb-stage">
                <button type="button" class="stfg-lb-nav stfg-lb-prev" aria-label="Previous">
                    <i class="fa-solid fa-chevron-left"></i>
                </button>
                <div class="stfg-lb-media"></div>
                <button type="button" class="stfg-lb-nav stfg-lb-next" aria-label="Next">
                    <i class="fa-solid fa-chevron-right"></i>
                </button>
            </div>
            <div class="stfg-lb-name"></div>
        </div>

        <div class="stfg-sheet-wrap" hidden>
            <div class="stfg-sheet" role="dialog" aria-modal="true">
                <div class="stfg-sheet-title"></div>
                <div class="stfg-sheet-text"></div>
                <button type="button" class="stfg-sheet-ok stfg-sheet-danger">Delete</button>
                <button type="button" class="stfg-sheet-cancel">Cancel</button>
            </div>
        </div>`;

    const q = sel => root.querySelector(sel);
    s.dom = {
        root,
        name: q('.stfg-name'),
        sub: q('.stfg-sub'),
        select: q('.stfg-select'),
        scroll: q('.stfg-scroll'),
        grid: q('.stfg-grid'),
        more: q('.stfg-more'),
        empty: q('.stfg-empty'),
        selAll: q('.stfg-selall'),
        selCount: q('.stfg-selcount'),
        del: q('.stfg-delete'),
        lb: q('.stfg-lightbox'),
        lbStage: q('.stfg-lb-stage'),
        lbMedia: q('.stfg-lb-media'),
        lbCount: q('.stfg-lb-count'),
        lbName: q('.stfg-lb-name'),
        lbPrev: q('.stfg-lb-prev'),
        lbNext: q('.stfg-lb-next'),
        sheet: q('.stfg-sheet-wrap'),
        sheetTitle: q('.stfg-sheet-title'),
        sheetText: q('.stfg-sheet-text'),
        sheetOk: q('.stfg-sheet-ok'),
    };

    q('.stfg-close').addEventListener('click', closeOverlay);
    s.dom.select.addEventListener('click', () => (s.selectMode ? exitSelectMode(s) : enterSelectMode(s)));
    s.dom.selAll.addEventListener('click', () => toggleSelectAll(s));
    s.dom.del.addEventListener('click', () => confirmDelete(s, selectedItems(s)));

    q('.stfg-lb-close').addEventListener('click', () => closeLightbox(s));
    q('.stfg-lb-delete').addEventListener('click', () => confirmDelete(s, [s.items[s.lbIndex]]));
    s.dom.lbPrev.addEventListener('click', () => stepLightbox(s, -1));
    s.dom.lbNext.addEventListener('click', () => stepLightbox(s, 1));
    s.dom.lbStage.addEventListener('pointerdown', e => onStagePointerDown(s, e));
    s.dom.lbStage.addEventListener('pointerup', e => onStagePointerUp(s, e));
    s.dom.lbStage.addEventListener('click', (e) => {
        if (s.suppressClick) {
            s.suppressClick = false;
            return;
        }
        if (e.target.closest('.stfg-lb-media img')) {
            s.dom.lbStage.classList.toggle('is-zoomed');
        }
    });

    q('.stfg-sheet-cancel').addEventListener('click', () => hideSheet(s));
    s.dom.sheet.addEventListener('click', (e) => {
        if (e.target === s.dom.sheet) {
            hideSheet(s);
        }
    });
    s.dom.sheetOk.addEventListener('click', () => {
        const targets = s.pending;
        hideSheet(s);
        performDelete(s, targets);
    });

    s.dom.grid.addEventListener('pointerdown', e => onPointerDown(s, e));
    s.dom.grid.addEventListener('click', e => onTileClick(s, e));
    s.dom.grid.addEventListener('contextmenu', e => e.preventDefault());

    s.tileObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                s.tileObserver.unobserve(entry.target);
                hydrateTile(s, entry.target);
            }
        }
    }, { root: s.dom.scroll, rootMargin: '300px 0px' });

    s.moreObserver = new IntersectionObserver((entries) => {
        if (entries.some(entry => entry.isIntersecting) && s.rendered < s.items.length) {
            s.visible += BATCH;
            appendTiles(s);
        }
    }, { root: s.dom.scroll, rootMargin: '400px 0px' });

    return root;
}

// ---------- grid ----------

function tileHtml(item, index) {
    return `<div class="stfg-tile${item.video ? ' is-video' : ''}" data-i="${index}">` +
        '<img alt="" draggable="false">' +
        (item.video ? '<span class="stfg-kind"><i class="fa-solid fa-play"></i></span>' : '') +
        '<span class="stfg-check"><i class="fa-solid fa-check"></i></span>' +
        '</div>';
}

function appendTiles(s) {
    const end = Math.min(s.visible, s.items.length);
    if (end > s.rendered) {
        const holder = document.createElement('div');
        let html = '';
        for (let i = s.rendered; i < end; i++) {
            html += tileHtml(s.items[i], i);
        }
        holder.innerHTML = html;
        for (const tile of [...holder.children]) {
            const item = s.items[Number(tile.dataset.i)];
            tile.title = item.file;
            tile.classList.toggle('is-selected', s.selected.has(item.file));
            s.dom.grid.appendChild(tile);
            s.tileObserver.observe(tile);
        }
        s.rendered = end;
    }

    s.dom.more.hidden = s.rendered >= s.items.length;
    if (!s.dom.more.hidden) {
        // Re-observe so the observer reports the sentinel's current position.
        s.moreObserver.unobserve(s.dom.more);
        s.moreObserver.observe(s.dom.more);
    }
    updateChrome(s);
}

function rebuildGrid(s) {
    s.tileObserver.disconnect();
    revokeObjectUrls(s);
    s.rendered = 0;
    s.dom.grid.innerHTML = '';
    appendTiles(s);
}

function hydrateTile(s, tile) {
    const item = itemOf(s, tile);
    const img = tile.querySelector('img');
    if (!item || !img) {
        return;
    }
    img.addEventListener('load', () => tile.classList.add('is-ready'), { once: true });
    img.addEventListener('error', () => tile.classList.add('is-broken'), { once: true });
    if (item.video) {
        img.src = PLACEHOLDER;
        fillPoster(s, img, item);
    } else {
        img.src = item.url;
    }
}

async function fillPoster(s, img, item) {
    try {
        const blob = await getPosterBlob(item.url);
        if (session !== s) {
            return;
        }
        const url = URL.createObjectURL(blob);
        s.objectUrls.push(url);
        img.src = url;
    } catch (err) {
        console.warn('[Fast Gallery] no poster for', item.file, err);
        img.closest('.stfg-tile')?.classList.add('is-broken');
    }
}

function revokeObjectUrls(s) {
    for (const url of s.objectUrls.splice(0)) {
        URL.revokeObjectURL(url);
    }
}

function itemOf(s, tile) {
    return s.items[Number(tile.dataset.i)];
}

function selectedItems(s) {
    return s.items.filter(item => s.selected.has(item.file));
}

// ---------- selection ----------

/** Sets one tile's selection. Returns true if the selection actually changed. */
function setTileSelected(s, tile, on) {
    const item = itemOf(s, tile);
    if (!item || s.selected.has(item.file) === on) {
        return false;
    }
    if (on) {
        s.selected.add(item.file);
    } else {
        s.selected.delete(item.file);
    }
    tile.classList.toggle('is-selected', on);
    return true;
}

function syncTiles(s) {
    s.dom.grid.querySelectorAll('.stfg-tile').forEach((tile) => {
        const item = itemOf(s, tile);
        tile.classList.toggle('is-selected', !!item && s.selected.has(item.file));
    });
}

function enterSelectMode(s) {
    if (s.selectMode) {
        return;
    }
    s.selectMode = true;
    s.dom.root.classList.add('is-selecting');
    updateChrome(s);
}

function exitSelectMode(s) {
    endDrag(s);
    s.selectMode = false;
    s.selected.clear();
    s.dom.root.classList.remove('is-selecting');
    syncTiles(s);
    updateChrome(s);
}

function toggleSelectAll(s) {
    if (s.selected.size === s.items.length) {
        s.selected.clear();
    } else {
        s.items.forEach(item => s.selected.add(item.file));
    }
    syncTiles(s);
    updateChrome(s);
}

/** Selects or deselects the tile under the pointer, following the drag's mode. */
function selectUnder(s, x, y) {
    const el = document.elementFromPoint(x, y);
    const tile = el?.closest?.('.stfg-tile');
    if (tile && s.dom.grid.contains(tile) && setTileSelected(s, tile, s.drag.select)) {
        updateChrome(s);
    }
}

function beginDrag(s, tile) {
    const item = itemOf(s, tile);
    if (!item) {
        return;
    }
    // Starting on an unselected tile selects everything the drag crosses;
    // starting on a selected one deselects it, like Google Photos.
    s.drag = { select: !s.selected.has(item.file) };
    s.lastX = s.press.x;
    s.lastY = s.press.y;
    setTileSelected(s, tile, s.drag.select);
    s.dom.root.classList.add('is-dragging');
    updateChrome(s);

    const tick = () => {
        if (!s.drag) {
            return;
        }
        const r = s.dom.scroll.getBoundingClientRect();
        const fromTop = s.lastY - r.top;
        const fromBottom = r.bottom - s.lastY;
        let dy = 0;
        if (fromTop < EDGE_ZONE_PX) {
            dy = -MAX_AUTOSCROLL_PX * Math.min(1, Math.max(0, 1 - fromTop / EDGE_ZONE_PX));
        } else if (fromBottom < EDGE_ZONE_PX) {
            dy = MAX_AUTOSCROLL_PX * Math.min(1, Math.max(0, 1 - fromBottom / EDGE_ZONE_PX));
        }
        if (dy) {
            s.dom.scroll.scrollTop += dy;
            selectUnder(s, s.lastX, s.lastY);
        }
        s.raf = requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);
}

function endDrag(s) {
    cancelAnimationFrame(s.raf);
    s.drag = null;
    s.dom?.root.classList.remove('is-dragging');
}

function onPointerDown(s, e) {
    if (e.pointerType === 'mouse' && e.button !== 0) {
        return;
    }
    const tile = e.target.closest('.stfg-tile');
    if (!tile || !s.dom.grid.contains(tile)) {
        return;
    }
    clearTimeout(s.pressTimer);
    s.longFired = false;
    s.press = { id: e.pointerId, tile, x: e.clientX, y: e.clientY };
    window.addEventListener('pointermove', onWindowMove);
    window.addEventListener('pointerup', onWindowUp);
    window.addEventListener('pointercancel', onWindowUp);

    if (s.selectMode) {
        beginDrag(s, tile);
    } else {
        s.pressTimer = setTimeout(() => {
            if (!s.press) {
                return;
            }
            s.longFired = true;
            enterSelectMode(s);
            beginDrag(s, s.press.tile);
        }, LONG_PRESS_MS);
    }
}

function onWindowMove(e) {
    const s = session;
    if (!s || !s.press || e.pointerId !== s.press.id) {
        return;
    }
    if (s.drag) {
        s.lastX = e.clientX;
        s.lastY = e.clientY;
        selectUnder(s, e.clientX, e.clientY);
        return;
    }
    // Moved before the long press fired: this is a scroll, not a press.
    if (Math.hypot(e.clientX - s.press.x, e.clientY - s.press.y) > MOVE_TOLERANCE_PX) {
        endPress(s);
    }
}

function onWindowUp(e) {
    const s = session;
    if (!s || !s.press || e.pointerId !== s.press.id) {
        return;
    }
    endPress(s);
}

function endPress(s) {
    clearTimeout(s.pressTimer);
    s.press = null;
    endDrag(s);
    window.removeEventListener('pointermove', onWindowMove);
    window.removeEventListener('pointerup', onWindowUp);
    window.removeEventListener('pointercancel', onWindowUp);
}

function onTileClick(s, e) {
    const tile = e.target.closest('.stfg-tile');
    if (!tile) {
        return;
    }
    if (s.longFired) {
        // The click that ends a long press; it selected the tile already.
        s.longFired = false;
        return;
    }
    if (s.selectMode) {
        return;
    }
    openLightbox(s, Number(tile.dataset.i));
}

// ---------- status bar ----------

function updateChrome(s) {
    if (!s?.dom) {
        return;
    }
    const d = s.dom;
    const total = s.items.length;
    const n = s.selected.size;
    d.name.textContent = s.folderKey;
    d.sub.textContent = s.selectMode
        ? (n ? `${n} selected` : 'Select items')
        : `${total} ${total === 1 ? 'item' : 'items'}`;
    d.select.textContent = s.selectMode ? 'Cancel' : 'Select';
    d.select.hidden = total === 0;
    d.selAll.textContent = total && n === total ? 'Deselect all' : 'Select all';
    d.selCount.textContent = `${n} selected`;
    d.del.disabled = n === 0;
    d.empty.hidden = total !== 0;
    d.grid.hidden = total === 0;
}

// ---------- viewer ----------

function openLightbox(s, index) {
    s.lbIndex = index;
    s.dom.lb.hidden = false;
    renderLightbox(s);
}

function renderLightbox(s) {
    const item = s.items[s.lbIndex];
    if (!item) {
        closeLightbox(s);
        return;
    }
    const d = s.dom;
    d.lbMedia.innerHTML = '';
    d.lbStage.classList.remove('is-zoomed');
    if (item.video) {
        const video = document.createElement('video');
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.src = item.url;
        d.lbMedia.appendChild(video);
    } else {
        const img = document.createElement('img');
        img.alt = item.file;
        img.draggable = false;
        img.src = item.url;
        d.lbMedia.appendChild(img);
    }
    d.lbCount.textContent = `${s.lbIndex + 1} / ${s.items.length}`;
    d.lbName.textContent = item.file;
    d.lbPrev.disabled = s.lbIndex === 0;
    d.lbNext.disabled = s.lbIndex === s.items.length - 1;
}

function closeLightbox(s) {
    if (!s || !s.dom) {
        return;
    }
    s.dom.lbMedia.querySelector('video')?.pause();
    s.dom.lbMedia.innerHTML = '';
    s.dom.lbStage.classList.remove('is-zoomed');
    s.dom.lb.hidden = true;
    s.lbIndex = -1;
}

function stepLightbox(s, delta) {
    const next = s.lbIndex + delta;
    if (next < 0 || next >= s.items.length) {
        return;
    }
    s.lbIndex = next;
    renderLightbox(s);
}

function onStagePointerDown(s, e) {
    if (e.target.closest('video') || s.dom.lbStage.classList.contains('is-zoomed')) {
        return;
    }
    s.swipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
}

function onStagePointerUp(s, e) {
    const sw = s.swipe;
    s.swipe = null;
    if (!sw || sw.id !== e.pointerId) {
        return;
    }
    const dx = e.clientX - sw.x;
    const dy = e.clientY - sw.y;
    if (Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
        s.suppressClick = true;
        stepLightbox(s, dx < 0 ? 1 : -1);
    }
}

// ---------- delete ----------

function confirmDelete(s, items) {
    const list = items.filter(Boolean);
    if (!list.length) {
        return;
    }
    s.pending = list;
    const n = list.length;
    s.dom.sheetTitle.textContent = `Delete ${n} ${n === 1 ? 'item' : 'items'}?`;
    s.dom.sheetText.textContent = 'They will be permanently deleted from this character\'s gallery. This cannot be undone.';
    s.dom.sheet.hidden = false;
}

function hideSheet(s) {
    s.pending = [];
    s.dom.sheet.hidden = true;
}

async function performDelete(s, targets) {
    if (!targets.length) {
        return;
    }
    s.dom.root.classList.add('is-busy');
    const currentFile = s.lbIndex >= 0 ? s.items[s.lbIndex]?.file : null;

    const removed = new Set();
    let failed = 0;
    for (const item of targets) {
        try {
            const response = await fetch('/api/images/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ path: item.path }),
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            removed.add(item.file);
            dropPoster(item.url);
        } catch (err) {
            failed++;
            console.warn('[Fast Gallery] could not delete', item.path, err);
        }
    }

    if (session !== s) {
        return;
    }
    s.dom.root.classList.remove('is-busy');

    if (removed.size) {
        s.items = s.items.filter(item => !removed.has(item.file));
        for (const file of removed) {
            s.selected.delete(file);
        }
        rebuildGrid(s);

        if (s.lbIndex >= 0) {
            if (!s.items.length) {
                closeLightbox(s);
            } else {
                // Stay on the same item if it survived, otherwise the one that took its place.
                let idx = currentFile ? s.items.findIndex(item => item.file === currentFile) : -1;
                if (idx < 0) {
                    idx = Math.min(s.lbIndex, s.items.length - 1);
                }
                s.lbIndex = idx;
                renderLightbox(s);
            }
        }
        toastr.success(`Deleted ${removed.size} ${removed.size === 1 ? 'item' : 'items'}`);
    }
    if (failed) {
        toastr.error(`${failed} ${failed === 1 ? 'item' : 'items'} could not be deleted`);
    }
    updateChrome(s);
}

// ---------- open / close ----------

function closeOverlay() {
    const s = session;
    if (!s) {
        return;
    }
    session = null;
    clearTimeout(s.pressTimer);
    cancelAnimationFrame(s.raf);
    window.removeEventListener('pointermove', onWindowMove);
    window.removeEventListener('pointerup', onWindowUp);
    window.removeEventListener('pointercancel', onWindowUp);
    s.tileObserver?.disconnect();
    s.moreObserver?.disconnect();
    revokeObjectUrls(s);
    s.dom?.root.remove();
}

function onKeydown(e) {
    const s = session;
    if (!s) {
        return;
    }
    const d = s.dom;
    if (!d.sheet.hidden) {
        if (e.key === 'Escape') {
            hideSheet(s);
        }
        return;
    }
    if (!d.lb.hidden) {
        if (e.key === 'ArrowLeft') {
            stepLightbox(s, -1);
        } else if (e.key === 'ArrowRight') {
            stepLightbox(s, 1);
        } else if (e.key === 'Escape') {
            if (d.lbStage.classList.contains('is-zoomed')) {
                d.lbStage.classList.remove('is-zoomed');
            } else {
                closeLightbox(s);
            }
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            confirmDelete(s, [s.items[s.lbIndex]]);
        }
        return;
    }
    if (e.key === 'Escape') {
        if (s.selectMode) {
            exitSelectMode(s);
        } else {
            closeOverlay();
        }
    }
}

async function openGallery() {
    const folderKey = currentFolderKey();
    if (folderKey === null || folderKey === undefined) {
        toastr.warning('Open a character or group first.');
        return;
    }

    try {
        const files = await listGalleryFiles(folderKey);
        const base = `user/images/${await getSanitizedFilename(folderKey)}`;
        closeOverlay();
        session = createSession(folderKey, base, files);
        document.body.appendChild(buildOverlay(session));
        appendTiles(session);
    } catch (err) {
        console.error('[Fast Gallery]', err);
        toastr.error('Could not open the gallery. See the console for details.');
    }
}

// ---------- entry points ----------

function addButtons() {
    if (!document.getElementById(BUTTON_ID)) {
        const container = document.getElementById('gallery_wand_container') || document.getElementById('extensionsMenu');
        if (container) {
            const button = document.createElement('div');
            button.id = BUTTON_ID;
            button.className = 'list-group-item flex-container flexGap5';
            button.innerHTML = '<div class="fa-solid fa-images extensionsMenuExtensionButton"></div><span>Show Gallery (Fast)</span>';
            button.addEventListener('click', openGallery);
            container.appendChild(button);
        }
    }

    if (!document.getElementById(CHAR_OPTION_ID)) {
        $('#char-management-dropdown').append($('<option>', {
            id: CHAR_OPTION_ID,
            text: 'Show Gallery (Fast)',
        }));
    }
}

function removeBuiltInEntries() {
    for (const id of BUILTIN_IDS) {
        document.getElementById(id)?.remove();
    }
}

export function init() {
    // The built-in gallery extension loads before this one (loading_order 6 vs 7),
    // so its entries exist by now and can be replaced.
    removeBuiltInEntries();
    addButtons();

    eventSource.on(event_types.CHARACTER_MANAGEMENT_DROPDOWN, (selectedOptionId) => {
        if (selectedOptionId === CHAR_OPTION_ID) {
            openGallery();
        }
    });
    eventSource.on(event_types.CHAT_CHANGED, closeOverlay);
    document.addEventListener('keydown', onKeydown);
}
