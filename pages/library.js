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
import { addToAppLibrary, linkHashToMedia, loadAppLibrary } from './app-library.js';
import { supabase } from '../user-data/db.js';

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

            // LAYER 1: LOCAL CACHE
            const localCache = getLocalMetaCache();
            const fullyCachedItems = [];
            const missingFromLocal = [];

            for (const t of torrents) {
                const cachedMeta = localCache[t.hash];
                if (cachedMeta) {
                    // Rebuild the item using fresh Torbox data + cached metadata
                    fullyCachedItems.push({
                        torrent: t,
                        name: cachedMeta.name,
                        isSingle: (t.files || []).filter(f => /\.(mkv|mp4|avi|mov)$/i.test(f.name)).length === 1,
                        size: t.size,
                        tmdbId: cachedMeta.tmdbId,
                        poster: cachedMeta.poster
                    });
                } else {
                    missingFromLocal.push(t);
                }
            }
            if (missingFromLocal.length === 0) {
                if (appState.allTorrents === torrents) renderList(fullyCachedItems);
                return;
            }

            // LAYER 2: CLOUD CACHE
            const cloudRows = (await getMediaFromHash(missingFromLocal)).filter(row => row.global_media);
            const cloudHashes = new Set(cloudRows.map(r => r.added_hash));

            const cloudItems = cloudRows.map(row => {
                const t = missingFromLocal.find(x => x.hash === row.added_hash);
                return {
                    torrent: t,
                    name: row.global_media.title,
                    isSingle: (t.files || []).filter(f => /\.(mkv|mp4|avi|mov)$/i.test(f.name)).length === 1,
                    size: t.size,
                    tmdbId: { id: row.media_id },
                    poster: row.global_media.poster_path
                };
            });

            // LAYER 3: TMDB FETCH & UPLOAD
            const needsTmdb = missingFromLocal.filter(t => !cloudHashes.has(t.hash));
            const newTmdbItems = needsTmdb.length > 0 ? await fetchMainMetadata(needsTmdb) : [];

            // Save new findings (from both Supabase and TMDB) to Local Storage for next time
            saveToMetaCache([...cloudItems, ...newTmdbItems]);

            // Combine all arrays
            const allItems = [...fullyCachedItems, ...cloudItems, ...newTmdbItems];

            // Map over original torbox array to perfectly preserve the user's native TorBox order
            const sortedItems = torrents
                .map(t => allItems.find(item => item.torrent.hash === t.hash))
                .filter(Boolean);

            if (appState.allTorrents === torrents) {
                renderList(sortedItems);
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

            // 1. Find the deleted torrent and remove it from Supabase (Background)
            const deletedTorrent = appState.allTorrents.find(t => t.id === torrentId);
            if (deletedTorrent && appState.currentUser?.id) {
                supabase.from('added_sources')
                    .delete()
                    .eq('user_id', appState.currentUser.id)
                    .eq('added_hash', deletedTorrent.hash)
                    .then(({ error }) => { if (error) console.error("DB cleanup failed:", error); });
            }

            // 2. Remove it from your local appState
            appState.allTorrents = appState.allTorrents.filter(t => t.id !== torrentId);

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


//#region Cach Data
async function getMediaFromHash(torrents) {
    const userId = appState.currentUser?.id;
    if (!userId || !torrents || torrents.length === 0) return [];

    // 1. Extract just the hash strings into an array
    const hashes = torrents.map(t => t.hash);

    // 2. Fetch all matching sources for this user in a single query
    const { data, error } = await supabase
        .from('added_sources')
        .select(`
            media_id,
            added_hash,
            global_media ( media_type, title, poster_path )
        `)
        .eq('user_id', userId)
        .in('added_hash', hashes);

    if (error) {
        console.error("Error fetching cached media:", error.message);
        return [];
    }

    return  data || [];
}

const CACHE_KEY = 'theama_meta_cache';

function getLocalMetaCache() {
    // Get active storage
    const storage = getStorage();

    try {
        return JSON.parse(storage.getItem(CACHE_KEY) || '{}');
    } catch {
        return {}; // Fallback if JSON is corrupted
    }
}

function saveToMetaCache(itemsToCache) {
    const cache = getLocalMetaCache();
    const storage = getStorage();

    for (const item of itemsToCache) {
        if (!item || !item.torrent?.hash) continue;

        // Save only the static metadata tied to the hash
        cache[item.torrent.hash] = {
            name: item.name,
            poster: item.poster,
            tmdbId: item.tmdbId
        };
    }
    storage.setItem(CACHE_KEY, JSON.stringify(cache));
}

//#endregion

//#region Metadata

export async function searchLibrary(searchString) {
    const filtered = appState.allTorrents.filter(t => t.name.toLowerCase().includes(searchString));

    const items = await fetchMainMetadata(filtered);
    if (appState.allTorrents === torrents) renderList(items);
}

// Prepare torrent metadata without touching the DOM or reading a cache.
async function fetchMainMetadata(items) {
    const RATE_LIMIT_MS = 50;

    const promises = items.map(async (torrent, index) => {
        const allFiles = (torrent.files || []).filter(f => /\.(mkv|mp4|avi|mov)$/i.test(f.name));

        const vidCount = allFiles.length;
        const isSingle = vidCount == 1;

        // Pass main folder title
        const mediaInfo = parseMediaData(torrent.name);

        // Check if its type based on seasons found
        const hasSeason = (mediaInfo.seasons?.length || 0) > 0 || allFiles.some(file => {
            const parsed = parseMediaData(file.short_name || file.name);
            return !parsed.isExtra && parsed.fileType !== 'MOVIE'
                && ((parsed.episodes?.length || 0) > 0 || (parsed.seasons?.length || 0) > 0);
        });
        const cleanName = mediaInfo.title.replace(/(^\w|[\s-]\w)/g, m => m.toUpperCase());

        let mediaText = "";
        
        if(!isSingle && hasSeason) mediaText = "Series";
        if(isSingle && hasSeason) mediaText = "Single Episode";
        if(isSingle && !hasSeason) mediaText = "Movie";
        if(!isSingle && !hasSeason) mediaText = "Collection";

        const item = {
            torrent: torrent,
            name: cleanName,
            mediaText: mediaText,
            size: torrent.size
        };

        const type = hasSeason ? 'tv' : 'movie'

        // Stagger metadata lookups by 50ms and fetch fresh data for every item.
        await new Promise(resolve => setTimeout(resolve, index * RATE_LIMIT_MS));

        try {
            const tmdbId = await getTmdbId(cleanName, mediaInfo.year, type);
            const poster = tmdbId ? await getPosterForLibrary(tmdbId.id, type) : null;

            if (!tmdbId) return { ...item, tmdbId: null, poster: null };

            const global_media = {
                id: tmdbId.id,
                type: type,
                title: tmdbId.officialName,
                poster: poster,
                base_url: null,
                season: null,
                episode: null
            };

            if (appState.currentUser && tmdbId.officialName && poster) {
                // 1. Save the media to global_media (ignoring if it exists)
                await addToAppLibrary(global_media);

                // 2. Link this specific user and hash to the media
                await linkHashToMedia(global_media, torrent.hash);
            }

            return { ...item, tmdbId, poster };
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
            openPicker(t, item.tmdbId?.id);
        }
    });

    document.getElementById('file-list').appendChild(card);
    return card;
}
//#endregion
