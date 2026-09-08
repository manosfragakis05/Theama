/**
 * ==========================================
 * library.js
 * Handles fetching, parsing, and rendering the debrid library
 * ==========================================
 */

import { appState, getTbKey, smartFetch, showToast } from '../services/config.js';
import { getPosterForLibrary, getTmdbId } from '../services/metadata.js';
import { parseMediaData } from '../utils/parseMedia.js';
import { requestLink } from '../streaming/player.js';

import { openPicker } from '../streaming/picker.js';

// --- DATA FETCHING ---

export async function fetchLibrary(bypassCache = true) {
    const key = getTbKey();
    if (!key) return;

    try {
        const res = await smartFetch(`https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=${bypassCache}`, {
            headers: { 'Authorization': `Bearer ${key}` }
        });
        const data = await res.json();

        if (data.success) {
            // Save to our global state so other files can search/filter it
            appState.allTorrents = data.data.filter(t => t.download_finished);
            renderList(appState.allTorrents);
        } else {
            showToast("Error: " + data.detail, 'error');
        }
    } catch (e) {
        showToast("Network Error", 'error');
    }
}

// --- API ACTIONS ---

export async function deleteTorrent(torrentId, event) {
    if (event) event.stopPropagation();
    if (!confirm("Are you sure you want to delete this from TorBox?")) return;

    const key = getTbKey();
    if (!key) return;
    const targetUrl = 'https://api.torbox.app/v1/api/torrents/controltorrent';

    try {
        const res = await smartFetch(targetUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                torrent_id: torrentId,
                operation: "delete"
            })
        });

        const data = await res.json();

        if (data.success) {
            showToast("Deleted successfully!", 'success');

            // Delete data from localstorage


            appState.allTorrents = appState.allTorrents.filter(t => t.id !== torrentId);
            renderList(appState.allTorrents);
        } else {
            showToast("Error: " + data.detail, 'error');
        }
    } catch (e) {
        console.error("Delete Error:", e);
        showToast("Failed to delete torrent.", 'error');
    }
}

// --- DOWNLOAD ---

/**
 * Requests a direct CDN link from TorBox and triggers a download.
 * On iOS standalone PWAs (no native download manager), tries Chrome,
 * Brave, then Firefox via custom URL schemes before falling back to
 * the native share sheet.
 *
 * @param {string|number} torrentId
 * @param {string|number} fileId
 * @param {string} fileName - used as the share-sheet title on iOS fallback
 */
export async function downloadFile(torrentId, fileId, fileName) {
    const key = getTbKey();
    if (!key) {
        showToast("API key not found.", "error");
        return;
    }

    showToast("Starting download...", "info");

    try {
        const apiUrl = `https://api.torbox.app/v1/api/torrents/requestdl?token=${key}&torrent_id=${torrentId}&file_id=${fileId}`;
        const response = await smartFetch(apiUrl);
        const result = await response.json();

        if (!result.success || !result.data) {
            showToast(result.detail || "Failed to get download link.", "error");
            return;
        }

        const cdnUrl = result.data;

        if (isIOS() && isStandalonePWA()) {
            await openWithBrowserFallbackChain(cdnUrl, fileName);
            return;
        }

        const a = document.createElement('a');
        a.href = cdnUrl;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

    } catch (error) {
        console.error("Download error:", error);
        showToast("Network error starting download.", "error");
    }
}

// --- UI RENDERING ---

export function renderList(items) {
    const libraryText = document.getElementById('library-info-text');
    const list = document.getElementById('file-list');
    list.replaceChildren();

    if (items.length === 0) {
        libraryText.innerText = "No files added yet.";
        libraryText.classList.remove("hidden");
        return;
    }

    libraryText.classList.add("hidden");

    // Read vault ONCE
    const vault = JSON.parse(localStorage.getItem('tmdb_vault') || '{}');
    const itemsNeedsFetching = [];

    // 1. INSTANT UI RENDER
    items.forEach((t) => {
        const vidCount = t.files.filter(f => f.name.match(/\.(mkv|mp4|avi|mov)$/i)).length;
        const isShow = vidCount > 1;

        const mediaInfo = parseMediaData(t.name);
        const cleanName = mediaInfo.title.replace(/(^\w|[\s-]\w)/g, m => m.toUpperCase());

        // Using ID instead of Hash
        const vaultData = vault[t.id];
        const hasVid = t.files.some(f => f.name.match(/\.(mkv|mp4|avi|mov)$/i));

        const card = document.createElement('div');
        card.className = "relative flex-col cursor-pointer transition-transform hover:scale-105 select-none group";

        // Build Action Buttons
        let actionButtonsHTML = `<button data-id="${t.id}" data-action="delete" class="text-red-500 hover:text-red-400 p-1 bg-black/50 rounded-full transition z-10 w-8 h-8 flex items-center justify-center backdrop-blur-sm"
        title="Delete from library">
            <svg class="w-5 h-5" fill="none" stroke="currentColor">
                <use href="#icon-delete"></use>
            </svg>
        </button>`;

        if (!isShow && hasVid) {
            actionButtonsHTML = `
                <button data-id="${t.id}" data-action="download" class="text-blue-400 hover:text-blue-300 p-1 bg-black/50 rounded-full transition z-10 w-8 h-8 flex items-center justify-center backdrop-blur-sm mr-2">
                <svg style="width:22px;height:22px;margin-top:2px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg></button>
                ${actionButtonsHTML}
            `;
        }

        // Inject HTML
        card.innerHTML = `
            <div class="relative w-full aspect-[2/3] bg-slate-800 rounded-lg shadow-lg overflow-hidden border border-slate-700/50">
                <img id="img-${t.id}" src="${vaultData?.poster || ''}" class="absolute inset-0 w-full h-full loading="lazy" object-cover ${vaultData?.poster ? '' : 'hidden'}" draggable="false">
                <div id="fallback-${t.id}" class="absolute inset-0 flex items-center justify-center p-4 text-center text-slate-500 font-bold text-sm bg-slate-800 ${vaultData?.poster ? 'hidden' : ''}">
                    ${cleanName}
                </div>
                <div class="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3">
                    <div class="flex justify-between items-center mb-1">
                        <span class="text-white font-bold text-xs truncate drop-shadow-md">${isShow ? '📺 Series' : '🎬 Movie'}</span>
                        <div class="flex items-center action-buttons">
                            ${actionButtonsHTML}
                        </div>
                    </div>
                </div>
                <div class="absolute top-2 right-2 bg-blue-600/90 text-white text-[10px] font-bold px-2 py-1 rounded backdrop-blur shadow-lg">
                    ${(t.size / 1073741824).toFixed(1)} GB
                </div>
            </div>
            <p class="text-xs text-slate-300 mt-2 truncate font-semibold pl-1">${cleanName}</p>
        `;

        // Handle Clicks cleanly
        card.addEventListener('click', (event) => {
            const btn = event.target.closest('button');

            // Handle Actions
            if (btn?.dataset.action === 'delete') {
                event.stopPropagation();
                return deleteTorrent(t.id, event);
            }
            if (btn?.dataset.action === 'download') {
                event.stopPropagation();
                const vid = t.files.find(f => f.name.match(/\.(mkv|mp4|avi|mov)$/i)) || t.files[0];
                downloadFile(t.id, vid.id, vid.name);
                return;
            }

            // Handle Card Click (Play/Open)
            if (appState.clickCooldown) { showToast("Please wait a moment."); return; }
            appState.clickCooldown = true;
            setTimeout(() => appState.clickCooldown = false, 2000);

            if (isShow) {
                openPicker(t);
            } else {
                const vid = t.files.find(f => f.name.match(/\.(mkv|mp4|avi|mov)$/i)) || t.files[0];
                vid ? requestLink(t.id, vid.id, t.name, vid.name) : showToast("No playable files found.", "error");
            }
        });

        list.appendChild(card);

        // Queue for fetching if no poster
        if (!vaultData?.poster) {
            itemsNeedsFetching.push({
                t, cleanName, year: mediaInfo.year, id: t.id,
                imgElement: card.querySelector(`#img-${t.id}`),
                fallbackElement: card.querySelector(`#fallback-${t.id}`)
            });
        }
    });

    // 2. THE BATCH FETCHER
    if (itemsNeedsFetching.length > 0) {
        processBatchFetches(itemsNeedsFetching, vault);
    }
}

function attemptOpenScheme(schemeUrl, timeout = 500) {
    return new Promise((resolve) => {
        let backgrounded = false;
        const onVisibilityChange = () => {
            if (document.hidden) backgrounded = true;
        };
        document.addEventListener('visibilitychange', onVisibilityChange);

        window.location.href = schemeUrl;

        setTimeout(() => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            resolve(backgrounded);
        }, timeout);
    });
}

async function openWithBrowserFallbackChain(url, shareTitle) {
    const chromeUrl = url.replace(/^https:\/\//, 'googlechromes://')
        .replace(/^http:\/\//, 'googlechrome://');
    const braveUrl = `brave://open-url?url=${encodeURIComponent(url)}`;
    const firefoxUrl = `firefox://open-url?url=${encodeURIComponent(url)}`;

    if (await attemptOpenScheme(chromeUrl)) return;
    if (await attemptOpenScheme(braveUrl)) return;
    if (await attemptOpenScheme(firefoxUrl)) return;

    // None of the three appear installed — fall back to the share sheet
    if (navigator.share) {
        try {
            await navigator.share({ url, title: shareTitle });
        } catch (shareErr) {
            showToast("Open this link in Safari to download.", "info");
        }
    } else {
        showToast("Downloads don't work in the installed app — open this site in Safari instead.", "info");
    }
}

function isIOS() {
    const ua = navigator.userAgent;
    const isIPad = ua.includes('Macintosh') && navigator.maxTouchPoints > 1;
    return /iPad|iPhone|iPod/.test(ua) || isIPad;
}

function isStandalonePWA() {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
}

async function processBatchFetches(items, vault) {
    let vaultUpdated = false;
    const RATE_LIMIT_MS = 50; // 1 request every 50ms = 20 per second

    // Create an array of independent promises
    const promises = items.map(async (item, index) => {

        // 1. Stagger the start time based on index in the queue
        await new Promise(resolve => setTimeout(resolve, index * RATE_LIMIT_MS));

        // 2. Fetch TMDB ID
        const tmdbId = await getTmdbId(item.cleanName, item.year);

        if (tmdbId) {
            // Fetch the poster
            const posterUrl = await getPosterForLibrary(tmdbId.id, tmdbId.type);

            if (posterUrl) {
                // 4. Update UI instantly
                item.imgElement.src = posterUrl;
                item.imgElement.classList.remove('hidden');
                item.fallbackElement.classList.add('hidden');

                // 5. Update Vault Memory
                vault[item.id] = { id: tmdbId, poster: posterUrl };
                vaultUpdated = true;
                return; // Exit this promise successfully
            }
        }

        // 6. Negative Caching (If ID or Poster failed)
        vault[item.id] = { notFound: true };
        vaultUpdated = true;
    });

    // Run them all simultaneously. They will automatically pace themselves 50ms apart.
    await Promise.all(promises);

    // Save to localstorage
    if (vaultUpdated) {
        localStorage.setItem('tmdb_vault', JSON.stringify(vault));
    }
}