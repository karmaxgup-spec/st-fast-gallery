// Fast Gallery: a replacement for SillyTavern's built-in "Show Gallery".
//
// The built-in gallery decodes every video in the character's folder, one at a
// time, before it shows anything. This extension instead:
//   - renders only the visible page of thumbnails,
//   - creates video posters on demand, with at most 2 running at once,
//   - gives each poster a timeout so one bad file cannot block the gallery,
//   - caches posters in the Cache Storage API (or memory on insecure origins).

import { characters, this_chid, getRequestHeaders, eventSource, event_types } from '../../../../script.js';
import { selected_group } from '../../../group-chats.js';
import { getSanitizedFilename, loadFileToDocument } from '../../../utils.js';
import { MEDIA_REQUEST_TYPE, VIDEO_EXTENSIONS } from '../../../constants.js';

const NANO_JS = 'scripts/extensions/gallery/jquery.nanogallery2.min.js';
const NANO_CSS = 'scripts/extensions/gallery/nanogallery2.woff.min.css';
const CACHE_NAME = 'st-fast-gallery-posters-v1';
const CONCURRENCY = 2;
const POSTER_TIMEOUT_MS = 8000;
const THUMB_HEIGHT = 150;
const MAX_POSTER_SIDE = 225;
const MAX_POSTER_RETRIES = 5;

const OVERLAY_ID = 'stfg-overlay';
const GRID_ID = 'stfg-grid';
const BUTTON_ID = 'stfg_wand_button';
const CHAR_OPTION_ID = 'stfg_char_gallery';
const BUILTIN_IDS = ['show_gallery_wand_button', 'show_char_gallery'];

const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="225" height="150">' +
    '<rect width="100%" height="100%" fill="#222"/>' +
    '<text x="50%" y="55%" fill="#ddd" font-size="48" text-anchor="middle" dominant-baseline="middle">&#9654;</text>' +
    '</svg>',
);

const videoRegexes = VIDEO_EXTENSIONS.map(ext => new RegExp(`\\.${ext}$`, 'i'));
const isVideo = name => videoRegexes.some(re => re.test(name));

/** Blob URLs created for posters; revoked when the gallery closes. */
const objectUrls = [];
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
                }, 'image/jpeg', 0.8);
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

async function getPosterBlob(src) {
    const key = new URL(src, location.href).href;
    const hasCacheApi = 'caches' in window;

    if (hasCacheApi) {
        const cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(key);
        if (hit) {
            return hit.blob();
        }
        const blob = await runQueued(() => makePoster(src));
        await cache.put(key, new Response(blob, { headers: { 'Content-Type': 'image/jpeg' } }));
        return blob;
    }

    if (memoryPosterCache.has(key)) {
        return memoryPosterCache.get(key);
    }
    const blob = await runQueued(() => makePoster(src));
    memoryPosterCache.set(key, blob);
    return blob;
}

/** Fills one video thumbnail with its poster. Retries briefly if nanogallery has not built the <img> yet. */
async function fillPoster($thumb, src, attempt = 0) {
    const img = $thumb.find('img').first();
    if (!img.length) {
        if (attempt < MAX_POSTER_RETRIES) {
            setTimeout(() => fillPoster($thumb, src, attempt + 1), 100);
        }
        return;
    }
    if (img.attr('data-stfg-src') === src) {
        return;
    }
    img.attr('data-stfg-src', src);
    try {
        const blob = await getPosterBlob(src);
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        // nanogallery starts thumbnails at opacity 0 and fades them in from its own
        // load handler, which has already run by now, so reveal the poster here.
        img.one('load', () => img.css('opacity', 1));
        img.attr('src', url);
        if (img.attr('data-src') !== undefined) {
            img.attr('data-src', url);
        }
    } catch (err) {
        console.warn('[Fast Gallery] no poster for', src, err);
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

// ---------- UI ----------

let nanogalleryReady = null;

function ensureNanogallery() {
    if (!nanogalleryReady) {
        nanogalleryReady = (async () => {
            if ($.fn.nanogallery2 === undefined) {
                await loadFileToDocument(NANO_CSS, 'css');
                await loadFileToDocument(NANO_JS, 'js');
            }
        })().catch((err) => {
            nanogalleryReady = null;
            throw err;
        });
    }
    return nanogalleryReady;
}

function closeOverlay() {
    const grid = $(`#${GRID_ID}`);
    if (grid.length) {
        try {
            grid.nanogallery2('destroy');
        } catch {
            // nanogallery was never initialised in this overlay
        }
    }
    $(`#${OVERLAY_ID}`).remove();
    for (const url of objectUrls.splice(0)) {
        URL.revokeObjectURL(url);
    }
}

function openOverlay(title) {
    closeOverlay();
    const el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.innerHTML = `
        <div class="stfg-bar">
            <span class="stfg-title"></span>
            <div class="menu_button interactable stfg-close" title="Close"><i class="fa-solid fa-xmark fa-fw"></i></div>
        </div>
        <div id="${GRID_ID}"></div>`;
    el.querySelector('.stfg-title').textContent = title;
    el.querySelector('.stfg-close').addEventListener('click', closeOverlay);
    document.body.appendChild(el);
    return el;
}

async function openGallery() {
    const folderKey = currentFolderKey();
    if (folderKey === null || folderKey === undefined) {
        toastr.warning('Open a character or group first.');
        return;
    }

    try {
        await ensureNanogallery();
        const files = await listGalleryFiles(folderKey);
        const base = `user/images/${await getSanitizedFilename(folderKey)}`;
        const items = files.map((file) => {
            const src = `${base}/${file}`;
            return {
                src,
                // Videos start with a placeholder; their posters are filled in per page.
                srct: isVideo(file) ? PLACEHOLDER : src,
                title: file,
            };
        });

        openOverlay(`Gallery: ${folderKey} (${items.length})`);

        const maxRows = Math.max(1, Math.min(10, Math.floor((window.innerHeight * 0.9 - 75) / THUMB_HEIGHT)));
        $(`#${GRID_ID}`).nanogallery2({
            items,
            thumbnailWidth: 'auto',
            thumbnailHeight: THUMB_HEIGHT,
            paginationVisiblePages: 5,
            paginationMaxLinesPerPage: 2,
            galleryMaxRows: maxRows,
            galleryPaginationTopButtons: false,
            galleryNavigationOverlayButtons: true,
            galleryPaginationMode: 'rectangles',
            galleryDisplayMode: 'pagination',
            fnThumbnailInit: function ($thumbnail, item) {
                if (!item?.src) {
                    return;
                }
                $thumbnail.attr('title', String(item.src).split('/').pop());
                if (isVideo(item.src)) {
                    fillPoster($thumbnail, item.src);
                }
            },
        });
    } catch (err) {
        console.error('[Fast Gallery]', err);
        toastr.error('Could not open the gallery. See the console for details.');
    }
}

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

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && document.getElementById(OVERLAY_ID)) {
            closeOverlay();
        }
    });
}
