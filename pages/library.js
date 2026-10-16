/**
 * ==========================================
 * library.js
 * Handles fetching, parsing, and rendering the debrid library
 * ==========================================
 */

import { getCurrentUserSettings, getStorage } from '../user-data/user-settings.js';
import { appState, smartFetch, showToast } from '../services/config.js';

import { parseMediaData } from '../utils/parseMedia.js';
import { getPosterForLibrary, getTmdbId } from '../metadata/metadata.js';
import { openPicker } from '../metadata/picker.js';

import { requestLink } from '../streaming/player.js';
import { downloadFile } from '../streaming/download.js';
import { createLibraryCard } from './library-renderer.js';
import { loadAppLibrary } from './app-library.js';

export { downloadFile } from '../streaming/download.js';


export function initializeLibraryTabs() {
    const tabs = [...document.querySelectorAll('[data-library-tab]')];

    function selectTab(selectedTab) {
        tabs.forEach(tab => {
            const selected = tab === selectedTab;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            document.getElementById(tab.dataset.libraryTab).classList.toggle('hidden', !selected);
        });
        if (selectedTab.dataset.libraryTab === 'library-panel') loadAppLibrary();
        if (selectedTab.dataset.libraryTab === 'cloud-panel') fetchLibrary();
    }

    tabs.forEach(tab => {
        tab.addEventListener('click', () => selectTab(tab));
    });
}

//#region Torbox
export async function fetchLibrary() {
    const key = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!key) return;

    try {
        const res = await smartFetch('https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true', {
            headers: { 'Authorization': `Bearer ${key}` }
        });
        const data = await res.json();

        if (data.success) {
            const torrents = data.data.filter(t => t.download_finished);
            //Set globally
            appState.allTorrents = torrents;

            const items = await getLibraryMetadata(torrents);

            if (appState.allTorrents === torrents) {
                renderList(items);
            }

        } else {
            showToast("Error: " + data.detail, 'error');
        }
    } catch (e) {
        console.error('Cloud library load failed:', e);
        const libraryText = document.getElementById('library-info-text');
        libraryText.textContent = 'Could not load your cloud library. Please try again.';
        libraryText.classList.remove('hidden');
        showToast("Could not load your cloud library. See the console for details.", 'error');
    }
}

// --- API ACTIONS ---

export async function deleteTorrent(torrentId, event) {
    if (event) event.stopPropagation();
    if (!confirm("Are you sure you want to delete this from TorBox?")) return false;

    const key = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!key) return false;

    try {
        const res = await smartFetch('https://api.torbox.app/v1/api/torrents/controltorrent', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ torrent_id: torrentId, operation: "delete" })
        });

        const data = await res.json();

        if (data.success) {
            showToast("Deleted from Torbox successfully!", 'success');

            const deletedTorrent = appState.allTorrents.find(t => t.id === torrentId);
            appState.allTorrents = appState.allTorrents.filter(t => t.id !== torrentId);
            if (deletedTorrent?.hash) {
                const cache = getLocalMetaCache();
                delete cache[deletedTorrent.hash];
                writeMetaCache(cache);
            }

            return true; // Tell the UI it succeeded!
        } else {
            showToast("Error: " + data.detail, 'error');
            return false;
        }
    } catch (e) {
        console.error("Delete Error:", e);
        showToast("Failed to delete torrent.", 'error');
        return false;
    }
}
//#endregion


//#region Cache Data
const CACHE_KEY = 'theama_meta_cache';
// Older entries may contain addon IDs incorrectly labeled as TMDB IDs.
const CACHE_VERSION = 2;

function getLocalMetaCache() {
    try {
        const cache = JSON.parse(getStorage().getItem(CACHE_KEY) || '{}');
        return cache && typeof cache === 'object' && !Array.isArray(cache) ? cache : {};
    } catch {
        return {}; // Fallback if JSON is corrupted
    }
}

function writeMetaCache(cache) {
    try {
        getStorage().setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (error) {
        console.warn('Could not save local library metadata:', error);
    }
}

function saveToMetaCache(itemsToCache) {
    const cache = getLocalMetaCache();

    for (const item of itemsToCache) {
        if (!item || !item.torrent?.hash) continue;
        if (!Number.isSafeInteger(item.tmdbId?.id) || item.tmdbId.id <= 0) continue;

        // Save only the static metadata tied to the hash
        cache[item.torrent.hash] = {
            version: CACHE_VERSION,
            name: item.name,
            poster: item.poster,
            tmdbId: item.tmdbId
        };
    }
    writeMetaCache(cache);
}

async function getLibraryMetadata(torrents) {
    const cache = getLocalMetaCache();
    const cachedItems = new Map();
    const missing = [];

    for (const torrent of torrents) {
        const meta = cache[torrent.hash];
        if (meta?.version === CACHE_VERSION && meta.name
            && Number.isSafeInteger(meta.tmdbId?.id) && meta.tmdbId.id > 0) {
            cachedItems.set(torrent.hash, {
                torrent,
                name: meta.name,
                mediaText: getMediaText(torrent),
                size: torrent.size,
                tmdbId: meta.tmdbId,
                poster: meta.poster
            });
        } else {
            missing.push(torrent);
        }
    }

    if (missing.length > 0) {
        const freshItems = await fetchMainMetadata(missing);
        saveToMetaCache(freshItems);
        for (const item of freshItems) cachedItems.set(item.torrent.hash, item);
    }

    return torrents.map(torrent => cachedItems.get(torrent.hash));
}

//#endregion

//#region Metadata

// Derive the label from current torrent files, regardless of metadata source.
export function getMediaText(torrent, mediaInfo = parseMediaData(torrent.name)) {
    const videoFiles = (torrent.files || []).filter(f => /\.(mkv|mp4|avi|mov)$/i.test(f.name));
    const isSingle = videoFiles.length === 1;
    const hasSeason = (mediaInfo.seasons?.length || 0) > 0 || videoFiles.some(file => {
        const parsed = parseMediaData(file.short_name || file.name);
        return !parsed.isExtra && parsed.fileType !== 'MOVIE'
            && ((parsed.episodes?.length || 0) > 0 || (parsed.seasons?.length || 0) > 0);
    });

    if (hasSeason) return isSingle ? 'Single Episode' : 'Series';
    return isSingle ? 'Movie' : 'Collection';
}

export async function searchLibrary(searchString) {
    const torrents = appState.allTorrents;
    const query = searchString.toLowerCase();
    const filtered = torrents.filter(t => t.name.toLowerCase().includes(query));

    const items = await getLibraryMetadata(filtered);
    if (appState.allTorrents === torrents) renderList(items);
}

// Prepare torrent metadata without touching the DOM or reading a cache.
async function fetchMainMetadata(items) {
    const RATE_LIMIT_MS = 50;

    const promises = items.map(async (torrent, index) => {
        // Pass main folder title
        const mediaInfo = parseMediaData(torrent.name);
        const cleanName = mediaInfo.title.replace(/(^\w|[\s-]\w)/g, m => m.toUpperCase());
        const mediaText = getMediaText(torrent, mediaInfo);

        const item = {
            torrent: torrent,
            name: cleanName,
            mediaText: mediaText,
            size: torrent.size
        };

        const type = mediaText === 'Series' || mediaText === 'Single Episode' ? 'tv' : 'movie';

        // Stagger metadata lookups by 50ms and fetch fresh data for every item.
        await new Promise(resolve => setTimeout(resolve, index * RATE_LIMIT_MS));

        try {
            const tmdbId = await getTmdbId(cleanName, mediaInfo.year, type);
            const poster = tmdbId ? await getPosterForLibrary(tmdbId.id, type) : null;

            if (!tmdbId) return { ...item, tmdbId: null, poster: null };

            return { ...item, name: tmdbId.officialName || cleanName, tmdbId, poster };
        } catch (error) {
            console.warn(`Failed to fetch library metadata for ${cleanName}:`, error);
            return { ...item, tmdbId: null, poster: null };
        }

    });

    // Preserve torrent order even when requests finish out of order.
    return Promise.all(promises);
}

//#endregion

//#region Rendering
export function renderList(items) {
    const libraryText = document.getElementById('library-info-text');
    const list = document.getElementById('file-list');
    list.replaceChildren();

    if (items.length === 0) {
        libraryText.textContent = "No files added yet.";
        libraryText.classList.remove("hidden");
        return;
    }

    libraryText.classList.add("hidden");
    items.forEach(renderItem);
}

function renderItem(item) {
    const t = item.torrent;
    const files = t.files || [];
    const video = files.find(f => /\.(mkv|mp4|avi|mov)$/i.test(f.name));
    const playableFile = video || files[0];

    const card = createLibraryCard(
        item.name,
        item.poster,
        item.mediaText,
        item.size
    );

    // Handle Clicks cleanly
    card.addEventListener('click', async (event) => {
        const btn = event.target.closest('button');

        // Handle Actions
        if (btn?.dataset.action === 'delete') {
            event.stopPropagation();

            // Wait for the delete function to finish
            const success = await deleteTorrent(t.id, event);

            if (success) {
                // Instantly wipe the card from the screen without re-rendering the list!
                card.remove();

                // Show the "empty library" text if that was their very last torrent
                if (appState.allTorrents.length === 0) {
                    const libraryText = document.getElementById('library-info-text');
                    libraryText.textContent = "No files added yet.";
                    libraryText.classList.remove("hidden");
                }
            }
            return;
        }
        if (btn?.dataset.action === 'download') {
            event.stopPropagation();
            return playableFile
                ? downloadFile(t.id, playableFile.id, playableFile.name)
                : showToast("No playable files found.", "error");
        }

        // Handle Card Click (Play/Open)
        if (appState.clickCooldown) { showToast("Please wait a moment."); return; }
        appState.clickCooldown = true;
        setTimeout(() => appState.clickCooldown = false, 2000);


        if (item.mediaText == "Movie" || item.mediaText == "Single Episode") {
            playableFile
                ? requestLink(t.id, playableFile.id, t.name, playableFile.name)
                : showToast("No playable files found.", "error");
        } else {
            console.log(item);
            openPicker(t, item.tmdbId?.id);
        }
    });

    document.getElementById('file-list').appendChild(card);
    return card;
}
//#endregion
