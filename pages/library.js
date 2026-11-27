/**
 * ==========================================
 * library.js
 * Handles fetching, parsing, and rendering the debrid library
 * ==========================================
 */

import { getCurrentUserSettings } from '../user-data/user-settings.js';
import { appState, smartFetch, showToast } from '../services/config.js';
import { getTorboxCloudList, isReadyCloudDownload } from '../services/torbox.js';

import { parseMediaData } from '../utils/parseMedia.js';
import { getPosterForLibrary, getTmdbId } from '../metadata/metadata.js';
import { openPicker } from '../metadata/picker.js';

import { downloadFile } from '../streaming/download.js';
import { createLibraryCard } from './library-renderer.js';
import { createLibraryGrid } from './library-grid.js';
import { loadAppLibrary, addToAppLibrary } from './app-library.js';

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
let usenetDownloads = [];
export const getCloudDownloads = () => [...appState.allTorrents, ...usenetDownloads];

export async function fetchLibrary() {
    const key = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!key) return;
    const requestId = ++libraryRequestId;
    const context = getMetadataContext();
    const isCurrent = () => requestId === libraryRequestId && context === getMetadataContext();

    try {
        const results = await Promise.allSettled([
            getTorboxCloudList(key, 'torrent'), getTorboxCloudList(key, 'usenet')
        ]);
        if (!isCurrent()) return;
        if (results.every(result => result.status === 'rejected')) throw new Error('Both cloud lists failed.');
        if (results[0].status === 'fulfilled') appState.allTorrents = results[0].value.filter(isReadyCloudDownload);
        if (results[1].status === 'fulfilled') usenetDownloads = results[1].value.filter(isReadyCloudDownload);
        for (const result of results) {
            if (result.status === 'rejected') showToast(result.reason.message, 'error');
        }
        const downloads = getCloudDownloads();
        const hashes = new Set(downloads.map(item => item.hash));
        for (const hash of metadataCache.keys()) {
            if (!hashes.has(hash)) metadataCache.delete(hash);
        }
        renderList(downloads);
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

export async function deleteFromTorbox(torrentId, event, torboxType = 'torrent') {
    if (event) event.stopPropagation();
    if (!confirm("Are you sure you want to delete this from TorBox?")) return false;

    const key = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!key) return false;

    const context = getMetadataContext();
    const usenet = torboxType === 'usenet';
    const isDeletedItem = item => String(item.id) === String(torrentId)
        && (item.torboxType === 'usenet') === usenet;
    const deletedTorrent = getCloudDownloads().find(isDeletedItem);

    try {
        const res = await smartFetch(`https://api.torbox.app/v1/api/${usenet ? 'usenet/controlusenetdownload' : 'torrents/controltorrent'}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ [usenet ? 'usenet_id' : 'torrent_id']: torrentId, operation: "delete" })
        });

        const data = await res.json();

        if (data.success) {
            if (context === getMetadataContext()) {
                // Invalidate list requests started before this deletion completed.
                libraryRequestId++;
                if (usenet) usenetDownloads = usenetDownloads.filter(item => !isDeletedItem(item));
                else appState.allTorrents = appState.allTorrents.filter(item => !isDeletedItem(item));
                metadataCache.delete(deletedTorrent?.hash);
                if (cloudGrid) renderList(renderedCloudTorrents.filter(item => !isDeletedItem(item)));
            }

            if (usenet) {
                showToast('Deleted from TorBox.', 'success');
                return true;
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
        usenetDownloads = [];
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
            mediaText: getMediaType(torrent, parsed).mediaText,
            mediaType: getMediaType(torrent, parsed).mediaType,
        };
        torrentDetailsCache.set(torrent, details);
    }
    return details;
}

function createLibraryItem(torrent) {
    const { name, mediaText, mediaType } = getTorrentDetails(torrent);
    const entry = metadataCache.get(torrent.hash);
    const metadata = entry?.sourceName === torrent.name && entry.mediaText === mediaText
        ? entry.metadata : null;
    return {
        torrent,
        name,
        mediaText,
        mediaType,
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
        && getCloudDownloads().some(t => t.hash === torrent.hash && t.name === torrent.name);
    entry.promise = new Promise(resolve => {
        metadataQueue.push({
            resolve, task: async () => {
                if (!isCurrent() || !entry.consumers.some(needed => needed())) return null;
                const metadata = await fetchTorrentMetadata(torrent);
                if (!isCurrent()) return null;
                if (metadata.tmdbId) entry.metadata = metadata;
                else metadataCache.delete(torrent.hash);
                return metadata;
            }
        });
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
export function getMediaType(torrent, mediaInfo) {
    const videoFiles = (torrent.files || []).filter(f => /\.(mkv|mp4|avi|mov)$/i.test(f.name));
    const isSingle = videoFiles.length === 1;
    const hasSeason = (mediaInfo.seasons?.length || 0) > 0 || videoFiles.some(file => {
        const parsed = parseMediaData(file.short_name || file.name);
        return !parsed.isExtra && parsed.fileType !== 'MOVIE'
            && ((parsed.episodes?.length || 0) > 0 || (parsed.seasons?.length || 0) > 0);
    });

    let mediaText = "";
    let mediaType = "";

    if (hasSeason) {
        mediaText = isSingle ? 'Single Episode' : 'Series';
        mediaType = "tv";
    } else {
        mediaText = isSingle ? 'Movie' : 'Collection';
        mediaType = "movie";
    }

    return { mediaText, mediaType };
}

export async function searchLibrary(searchString) {
    getMetadataContext();
    renderList(getCloudDownloads(), searchString.trim().toLowerCase());
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
    // Both APIs return their own lists. Merge their chronology before the
    // virtual grid chooses the first visible rows.
    torrents = torrents.filter(t => t.name.toLowerCase().includes(query))
        .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));
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
    updateAddLibraryButton(card, item);
}

function updateAddLibraryButton(card, item) {
    const button = card.querySelector('[data-action="add-library"]');
    const id = item.tmdbId?.id;
    button.classList.toggle('hidden', !Number.isSafeInteger(id) || id <= 0);
    if (button.getAttribute('aria-busy') === 'true') return;
    const label = button.dataset.added === 'true' ? 'Added to library' : `Add ${item.name} to library`;
    button.title = label;
    button.setAttribute('aria-label', label);
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
    if (t.torboxType === 'usenet') card.querySelector('.library-type').textContent = `${item.mediaText} · Usenet`;
    updateAddLibraryButton(card, item);

    // Handle Clicks cleanly
    card.addEventListener('click', async (event) => {
        const btn = event.target.closest('button');

        const getLibraryData = () => ({
            id: item.tmdbId?.id,
            tmdbId: item.tmdbId?.id,
            title: item.tmdbId?.officialName || t.name,
            type: item?.mediaType,
            poster: item?.poster
        });

        // Handle Actions
        if (btn?.dataset.action === 'add-library') {
            event.stopPropagation();
            if (btn.disabled || context !== getMetadataContext() || !card.isConnected) return;
            if (!Number.isSafeInteger(item.tmdbId?.id) || item.tmdbId.id <= 0) return;
            if (!appState.currentUser) {
                showToast('Sign in to add cloud items to your library.', 'error');
                return;
            }

            btn.disabled = true;
            btn.title = 'Adding to library…';
            btn.setAttribute('aria-label', 'Adding to library');
            btn.setAttribute('aria-busy', 'true');

            try {
                const saved = await addToAppLibrary(getLibraryData(), t?.hash);

                if (saved && context === getMetadataContext() && card.isConnected) {
                    btn.dataset.added = 'true';
                    btn.querySelector('path').setAttribute('d', 'M5 12l4 4L19 6');
                    btn.classList.remove('text-white');
                    btn.classList.add('text-emerald-300');
                    showToast('Added to your library.', 'success');
                }
            } catch (error) {
                if (context === getMetadataContext()) showToast(error.message || 'Could not add this item to your library.', 'error');
            } finally {
                btn.removeAttribute('aria-busy');
                btn.disabled = btn.dataset.added === 'true';
                updateAddLibraryButton(card, item);
            }
            return;
        }
        if (btn?.dataset.action === 'delete') {
            event.stopPropagation();

            // Wait for the delete function to finish
            await deleteFromTorbox(t.id, event, t.torboxType);
            return;
        }
        if (btn?.dataset.action === 'download') {
            event.stopPropagation();
            return playableFile
                ? downloadFile(t.id, playableFile.id, playableFile.name, t.torboxType)
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
                || !getCloudDownloads().some(torrent => torrent.hash === t.hash)) return;
            if (metadata) {
                Object.assign(item, metadata);
                updateCardMetadata(card, item);
            }
        }

        const libraryData = { ...getLibraryData(), torrents: [t] };

        await openPicker(libraryData, libraryData.tmdbId, libraryData.title);
    });

    return card;
}
//#endregion
