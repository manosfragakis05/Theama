/**
 * ==========================================
 * library.js
 * Handles fetching, parsing, and rendering the debrid library
 * ==========================================
 */

import { getCurrentUserSettings } from '../user-data/user-settings.js';
import { appState, smartFetch, showToast } from '../services/config.js';

import { parseMediaData } from '../utils/parseMedia.js';
import { getPosterForLibrary, getTmdbId } from '../metadata/metadata.js';
import { openPicker } from '../metadata/picker.js';

import { requestLink } from '../streaming/player.js';
import { startQueueFromItem } from '../streaming/playlist.js';
import { downloadFile } from '../streaming/download.js';
import { createLibraryCard } from './library-renderer.js';
import { createLibraryGrid } from './library-grid.js';
import { loadAppLibrary, removeHashFromAppLibrary } from './app-library.js';

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
let libraryRequestId = 0;

export async function fetchLibrary() {
    const key = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!key) return;
    const requestId = ++libraryRequestId;
    const context = getMetadataContext();
    const isCurrent = () => requestId === libraryRequestId && context === getMetadataContext();

    try {
        const res = await smartFetch('https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true', {
            headers: { 'Authorization': `Bearer ${key}` }
        });
        const data = await res.json();
        if (!isCurrent()) return;

        if (data.success && Array.isArray(data.data)) {
            const torrents = data.data.filter(t => t.download_finished);
            appState.allTorrents = torrents;
            const hashes = new Set(data.data.map(t => t.hash));
            for (const hash of metadataCache.keys()) {
                if (!hashes.has(hash)) metadataCache.delete(hash);
            }
            renderList(torrents);

        } else {
            showToast("Error: " + data.detail, 'error');
        }
    } catch (e) {
        if (!isCurrent()) return;
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

    const userId = appState.currentUser?.id ?? null;
    const context = getMetadataContext();
    const deletedTorrent = appState.allTorrents.find(t => String(t.id) === String(torrentId));

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
            if (context === getMetadataContext()) {
                // Invalidate list requests started before this deletion completed.
                libraryRequestId++;
                appState.allTorrents = appState.allTorrents.filter(t => String(t.id) !== String(torrentId));
                metadataCache.delete(deletedTorrent?.hash);
                if (cloudGrid) renderList(renderedCloudTorrents.filter(t => String(t.id) !== String(torrentId)));
            }

            try {
                await removeHashFromAppLibrary(deletedTorrent?.hash, userId);
                showToast("Deleted from TorBox and your library successfully!", 'success');
            } catch (error) {
                console.error('App library cleanup failed:', error);
                showToast('Deleted from TorBox, but could not update your app library. Please try removing it from Library.', 'error');
            }

            return true; // The TorBox card must disappear even if database cleanup failed.
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
// Metadata and pending requests live only for this page's lifetime.
const metadataCache = new Map();
const torrentDetailsCache = new WeakMap();
let metadataContext = null;
const metadataQueue = [];
let activeMetadataRequests = 0;

function getMetadataContext() {
    const key = getCurrentUserSettings().user_preferences.torboxApiKey;
    const userId = appState.currentUser?.id;
    if (!metadataContext || metadataContext.key !== key || metadataContext.userId !== userId) {
        metadataCache.clear();
        metadataContext = { key, userId };
    }
    return metadataContext;
}

function getTorrentDetails(torrent) {
    let details = torrentDetailsCache.get(torrent);
    if (!details || details.sourceName !== torrent.name || details.files !== torrent.files) {
        const parsed = parseMediaData(torrent.name);
        details = {
            sourceName: torrent.name, files: torrent.files, parsed,
            name: parsed.title.replace(/(^\w|[\s-]\w)/g, m => m.toUpperCase()),
            mediaText: getMediaText(torrent, parsed)
        };
        torrentDetailsCache.set(torrent, details);
    }
    return details;
}

function createLibraryItem(torrent) {
    const { name, mediaText } = getTorrentDetails(torrent);
    const entry = metadataCache.get(torrent.hash);
    const metadata = entry?.sourceName === torrent.name && entry.mediaText === mediaText
        ? entry.metadata : null;
    return {
        torrent,
        name,
        mediaText,
        size: torrent.size,
        ...metadata
    };
}

function runMetadataQueue() {
    while (activeMetadataRequests < 4 && metadataQueue.length > 0) {
        const { task, resolve } = metadataQueue.shift();
        activeMetadataRequests++;
        Promise.resolve().then(task).catch(error => {
            console.warn('Library metadata lookup failed:', error);
            return null;
        }).then(resolve).finally(() => {
            activeMetadataRequests--;
            runMetadataQueue();
        });
    }
}

function getTorrentMetadata(torrent, isNeeded) {
    const context = getMetadataContext();
    const { mediaText } = getTorrentDetails(torrent);
    const cached = metadataCache.get(torrent.hash);
    if (cached?.sourceName === torrent.name && cached.mediaText === mediaText) {
        if (!cached.metadata) cached.consumers.push(isNeeded);
        return cached.promise;
    }

    const entry = { sourceName: torrent.name, mediaText, metadata: null, promise: null, consumers: [isNeeded] };
    const isCurrent = () => context === getMetadataContext()
        && metadataCache.get(torrent.hash) === entry
        && appState.allTorrents.some(t => t.hash === torrent.hash && t.name === torrent.name);
    entry.promise = new Promise(resolve => {
        metadataQueue.push({ resolve, task: async () => {
            if (!isCurrent() || !entry.consumers.some(needed => needed())) return null;
            const metadata = await fetchTorrentMetadata(torrent);
            if (!isCurrent()) return null;
            if (metadata.tmdbId) entry.metadata = metadata;
            else metadataCache.delete(torrent.hash);
            return metadata;
        } });
    }).then(metadata => {
        entry.consumers = [];
        if (!entry.metadata && metadataCache.get(torrent.hash) === entry) metadataCache.delete(torrent.hash);
        return metadata;
    });
    metadataCache.set(torrent.hash, entry);
    runMetadataQueue();
    return entry.promise;
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
    getMetadataContext();
    renderList(appState.allTorrents, searchString.trim().toLowerCase());
}

async function fetchTorrentMetadata(torrent) {
    const { parsed: mediaInfo, name: cleanName, mediaText } = getTorrentDetails(torrent);
    const type = mediaText === 'Series' || mediaText === 'Single Episode' ? 'tv' : 'movie';
    try {
        const tmdbId = await getTmdbId(cleanName, mediaInfo.year, type);
        const candidate = tmdbId?.id;
        if (!Number.isSafeInteger(candidate) || candidate <= 0) {
            return { name: cleanName, tmdbId: null, poster: null };
        }
        const poster = await getPosterForLibrary(tmdbId.id, type);
        return { name: tmdbId.officialName || cleanName, tmdbId, poster };
    } catch (error) {
        console.warn(`Failed to fetch library metadata for ${cleanName}:`, error);
        return { name: cleanName, tmdbId: null, poster: null };
    }
}

//#endregion

//#region Rendering
let metadataObserver = null;
let libraryRenderId = 0;
let cloudGrid = null;
let renderedCloudTorrents = [];

export function renderList(torrents, query = document.getElementById('library-search-input')?.value.trim().toLowerCase() || '') {
    torrents = torrents.filter(t => t.name.toLowerCase().includes(query));
    cloudGrid?.destroy();
    cloudGrid = null;
    renderedCloudTorrents = torrents;
    metadataObserver?.disconnect();
    const renderId = ++libraryRenderId;
    const context = getMetadataContext();
    const libraryText = document.getElementById('library-info-text');
    const list = document.getElementById('file-list');
    list.replaceChildren();

    if (torrents.length === 0) {
        libraryText.textContent = query ? 'No cloud files match your search.' : 'No files added yet.';
        libraryText.classList.remove("hidden");
        return;
    }

    libraryText.classList.add("hidden");
    const pendingCards = new WeakMap();
    const hydrate = async (card, item) => {
        const metadata = await getTorrentMetadata(item.torrent,
            () => card.isConnected && renderId === libraryRenderId && context === getMetadataContext());
        if (!metadata || renderId !== libraryRenderId || context !== getMetadataContext() || !card.isConnected) return;
        Object.assign(item, metadata);
        updateCardMetadata(card, item);
    };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
        if (renderId !== libraryRenderId || context !== getMetadataContext()) return;
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const item = pendingCards.get(entry.target);
            if (!item) continue;
            pendingCards.delete(entry.target);
            observer.unobserve(entry.target);
            void hydrate(entry.target, item);
        }
    }, { root: document.getElementById('app-main'), rootMargin: '400px 0px' });
    metadataObserver = observer;

    const cardItems = new WeakMap();
    cloudGrid = createLibraryGrid(list, {
        items: torrents,
        createCard(torrent) {
            const item = createLibraryItem(torrent);
            const card = renderItem(item);
            cardItems.set(card, item);
            return card;
        },
        onMount(card) {
            const item = cardItems.get(card);
            if (item.tmdbId) return;
            if (observer) {
                pendingCards.set(card, item);
                observer.observe(card);
            } else {
                void hydrate(card, item);
            }
        },
        onUnmount(card) {
            observer?.unobserve(card);
            pendingCards.delete(card);
        }
    });
}

function updateCardMetadata(card, item) {
    card.querySelector('.library-title').textContent = item.name;
    const image = card.querySelector('.library-poster');
    const fallback = card.querySelector('.library-fallback');
    image.alt = item.name;
    fallback.textContent = item.name;
    if (item.poster) {
        image.src = item.poster.startsWith('/') ? `https://image.tmdb.org/t/p/w300${item.poster}` : item.poster;
        image.classList.remove('hidden');
        fallback.classList.add('hidden');
    }
}

function renderItem(item) {
    const context = getMetadataContext();
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
            await deleteTorrent(t.id, event);
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

        // A card can be clicked before its observed metadata request finishes.
        if (!item.tmdbId) {
            const metadata = await getTorrentMetadata(t, () => card.isConnected && context === getMetadataContext());
            if (context !== getMetadataContext() || !card.isConnected
                || !appState.allTorrents.some(torrent => torrent.hash === t.hash)) return;
            if (metadata) {
                Object.assign(item, metadata);
                updateCardMetadata(card, item);
            }
        }

        if (item.mediaText == "Movie" || item.mediaText == "Single Episode") {
            if (!playableFile) return showToast("No playable files found.", "error");
            const parsed = parseMediaData(playableFile.short_name || playableFile.name);
            const torrentInfo = parseMediaData(t.name);
            const current = startQueueFromItem({
                tid: t.id, fid: playableFile.id, torrentName: t.name, fileName: playableFile.name,
                hash: t.hash,
                title: item.name, thumbnail: item.poster,
                tmdbId: item.tmdbId?.id,
                mediaType: item.mediaText === 'Movie' ? 'movie' : 'tv',
                seasonNumber: parsed.seasons?.[0] ?? torrentInfo.seasons?.[0] ?? 1,
                episodeNumber: parsed.episodes?.[0] ?? torrentInfo.episodes?.[0]
            });
            requestLink(current.tid, current.fid, current.torrentName, current.fileName, current.uid);
        } else {
            console.log(item);
            openPicker(t, item.tmdbId?.id);
        }
    });

    return card;
}
//#endregion
