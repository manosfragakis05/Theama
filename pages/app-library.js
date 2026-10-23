/**
 * ===================================
 * Keep track of media added in Theama
 * ===================================
 */

import { supabase } from '../user-data/db.js';
import { appState, smartFetch, showToast } from '../services/config.js';

import { getCurrentUserSettings } from '../user-data/user-settings.js';
import { requestLink } from '../streaming/player.js';
import { startQueueFromItem } from '../streaming/playlist.js';
import { parseMediaData } from '../utils/parseMedia.js';
import { downloadFile } from '../streaming/download.js';
import { createLibraryCard } from './library-renderer.js';
import { createLibraryGrid } from './library-grid.js';
import { getMediaText } from './library.js';
import { openPicker } from '../metadata/picker.js';


//#region Manage Library
export async function addToAppLibrary(mediaData) {
    if (!appState.currentUser) return;

    try {
        const candidate = Number(mediaData.tmdbId);
        const tmdbId = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
        // Refresh existing entries when a TMDB mapping is available.
        const { error } = await supabase.from('global_media').upsert({
            media_id: mediaData.id,
            tmdb_id: tmdbId,
            media_type: mediaData.type,
            title: mediaData.title,
            poster_path: mediaData.poster,
            base_url: mediaData.baseUrl
        }, { onConflict: 'media_id', ignoreDuplicates: tmdbId === null });
        if (error) throw error;

        console.log("Successfully linked Torbox source to App Library.");
    } catch (err) {
        console.error("Database linking failed:", err.message);
    }
}

export async function linkHashToMedia(mediaData, torboxHash, addedViaApp = false) {
    if (!appState.currentUser) return;
    const userId = appState.currentUser.id;
    
    // Link the Torbox Hash to the Media ID
    const { error } = await supabase.from('added_sources').insert({
        user_id: userId,
        media_id: mediaData.id,
        added_hash: torboxHash,
        added_via_app: addedViaApp
    });

    if (error && error.code === '23505') {
        if (addedViaApp) {
            const { error: updateError } = await supabase.from('added_sources')
                .update({ added_via_app: true })
                .eq('user_id', userId)
                .eq('added_hash', torboxHash);
            if (updateError) throw updateError;
        }
    } else if (error) {
        throw error;
    }

    if (addedViaApp) await loadAppLibrary();
}

export async function removeHashFromAppLibrary(hash, userId = appState.currentUser?.id) {
    if (!userId || !hash) return;

    // Remove only this source, preserving any other torrents linked to the media.
    const { error } = await supabase.from('added_sources')
        .delete()
        .eq('user_id', userId)
        .eq('added_hash', hash);
    if (error) throw error;

    if (userId === appState.currentUser?.id) await loadAppLibrary();
}

async function removeFromAppLibrary(mediaIds, {
    message = 'Remove this media from your library?',
    hashes,
    userId = appState.currentUser?.id
} = {}) {
    if (!userId || userId !== appState.currentUser?.id || !confirm(message)) return;
    try {
        let removal = supabase.from('added_sources')
            .delete()
            .eq('user_id', userId)
            .in('media_id', mediaIds);
        // A missing-item prompt only applies to the sources that were checked.
        if (hashes) removal = removal.in('added_hash', hashes);
        const { error } = await removal;
        if (error) throw error;
        if (userId !== appState.currentUser?.id) return;
        await loadAppLibrary();
        showToast('Removed from your library.', 'success');
    } catch (error) {
        showToast(error.message || 'Could not remove this media.', 'error');
    }
}
//#endregion

//#region Load Library
let libraryLoadId = 0;
let appLibraryGrid = null;
let renderedUserId = null;
let loadedLibraryItems = [];

export function searchAppLibrary() {
    if (renderedUserId !== appState.currentUser?.id || !appState.currentUser) return;
    renderAppLibrary(loadedLibraryItems);
}

export async function loadAppLibrary() {
    const loadId = ++libraryLoadId;
    const userId = appState.currentUser?.id;
    const list = document.getElementById('app-library-list');
    const info = document.getElementById('app-library-info-text');
    if (!list || !info) return;

    if (userId !== renderedUserId) {
        loadedLibraryItems = [];
        appLibraryGrid?.destroy();
        appLibraryGrid = null;
        list.replaceChildren();
        renderedUserId = userId;
    }
    info.textContent = userId ? 'Loading your library...' : 'Sign in to view your library.';
    info.classList.toggle('hidden', !!userId && list.children.length > 0);
    if (!userId) return;

    try {
        const items = await fetchAppLibraryData();
        if (loadId !== libraryLoadId || userId !== appState.currentUser?.id) return;
        renderAppLibrary(items);
    } catch (error) {
        if (loadId !== libraryLoadId || userId !== appState.currentUser?.id) return;
        console.error('App library load failed:', error);
        info.textContent = 'Could not load your library. Select Library to try again.';
        info.classList.remove('hidden');
    }
}

async function fetchAppLibraryData() {
    const userId = appState.currentUser?.id;
    if (!userId) return [];

    const { data, error } = await supabase
        .from('added_sources')
        .select(`
            media_id,
            added_hash,
            global_media (
                tmdb_id,
                media_type,
                title,
                poster_path,
                base_url
            )
        `)
        .eq('user_id', userId)
        .eq('added_via_app', true)
        .order('created_at', { ascending: false });

    if (error) throw error;

    // Map insertion order keeps titles sorted by their most recently added source.
    const groupedLibrary = new Map();

    for (const row of data || []) {
        const meta = row.global_media;
        if (!meta) continue;

        // Normalize series/tv so both use the same grouping key.
        const type = meta.media_type === 'series'
            ? 'tv'
            : meta.media_type;

        const candidate = Number(meta.tmdb_id);
        const tmdbId = Number.isSafeInteger(candidate) && candidate > 0
            ? candidate
            : null;

        // Separate movies from shows, and TMDB IDs from original IDs.
        const groupKey = tmdbId
            ? `${type}:tmdb:${tmdbId}`
            : `${type}:original:${row.media_id}`;

        if (!groupedLibrary.has(groupKey)) {
            groupedLibrary.set(groupKey, {
                ...meta,
                id: row.media_id,
                media_type: type,
                tmdb_id: tmdbId,
                media_ids: [],
                sources: []
            });
        }

        const group = groupedLibrary.get(groupKey);

        if (!group.media_ids.includes(row.media_id)) {
            group.media_ids.push(row.media_id);
        }

        group.sources.push({
            hash: row.added_hash,
            media_id: row.media_id
        });
    }

    return [...groupedLibrary.values()];
}

export function renderAppLibrary(items) {
    loadedLibraryItems = items;
    const query = document.getElementById('library-search-input')?.value.trim().toLowerCase() || '';
    items = items.filter(item => (item.title || '').toLowerCase().includes(query));
    const list = document.getElementById('app-library-list');
    const info = document.getElementById('app-library-info-text');
    appLibraryGrid?.destroy();
    info.textContent = query ? 'No saved titles match your search.' : 'Your library is empty.';
    info.classList.toggle('hidden', items.length > 0);

    const torrentsByHash = new Map(appState.allTorrents.map(torrent => [torrent.hash, torrent]));
    appLibraryGrid = createLibraryGrid(list, { items, createCard(media) {
        const torrent = media.sources.map(source => torrentsByHash.get(source.hash)).find(Boolean);
        const isPacked = new Set(media.sources.map(source => source.hash).filter(Boolean)).size > 1;
        const mediaText = isPacked
            ? media.media_type === 'tv' ? 'Series' : 'Collection'
            : torrent ? getMediaText(torrent) : media.media_type === 'tv' ? 'Series' : 'Movie';

        const card = createLibraryCard(
            media.title || 'Untitled movie',
            media.poster_path,
            mediaText,
            torrent?.size,
        );

        if (isPacked) {
            const badge = card.querySelector('.library-size');
            badge.textContent = 'PACKED TORRENT';
            badge.classList.remove('hidden');
        }

        let busy = false;
        card.addEventListener('click', async event => {
            const action = event.target.closest('button')?.dataset.action;
            if (action) event.stopPropagation();
            if (busy) return;
            if (action === 'delete') {
                await removeFromAppLibrary(media.media_ids);
                return;
            }
            if (!action && appState.clickCooldown) {
                showToast('Please wait a moment.');
                return;
            }
            if (!action) {
                appState.clickCooldown = true;
                setTimeout(() => appState.clickCooldown = false, 2000);
            }

            busy = true;
            card.style.opacity = '0.5';
            const userId = appState.currentUser?.id;
            const key = getCurrentUserSettings().user_preferences.torboxApiKey;
            const isCurrent = () => userId === appState.currentUser?.id
                && key === getCurrentUserSettings().user_preferences.torboxApiKey;
            try {
                const sourceTorrents = await resolveLibraryTorrents(media.sources, { refresh: true });
                if (!isCurrent()) return;
                const sourceTorrent = sourceTorrents[0];
                const files = sourceTorrent.files || [];
                const playableFile = files.find(file => /\.(mkv|mp4|avi|mov)$/i.test(file.name)) || files[0];
                const sourceMediaText = getMediaText(sourceTorrent);

                if (action === 'download') {
                    if (playableFile) await downloadFile(sourceTorrent.id, playableFile.id, playableFile.name);
                    else showToast('No playable files found.', 'error');
                } else if (sourceTorrents.length === 1 && (sourceMediaText === 'Movie' || sourceMediaText === 'Single Episode')) {
                    if (!playableFile) return showToast('No playable files found.', 'error');
                    const parsed = parseMediaData(playableFile.short_name || playableFile.name);
                    const torrentInfo = parseMediaData(sourceTorrent.name);
                    const current = startQueueFromItem({
                        tid: sourceTorrent.id, fid: playableFile.id,
                        hash: sourceTorrent.hash,
                        torrentName: sourceTorrent.name, fileName: playableFile.name,
                        title: media.title, thumbnail: media.poster_path,
                        tmdbId: media.tmdb_id, mediaType: media.media_type,
                        seasonNumber: parsed.seasons?.[0] ?? torrentInfo.seasons?.[0] ?? 1,
                        episodeNumber: parsed.episodes?.[0] ?? torrentInfo.episodes?.[0]
                    });
                    await requestLink(current.tid, current.fid, current.torrentName, current.fileName, current.uid);
                } else {
                    await openPicker(sourceTorrents, media.tmdb_id, media.title);
                }
            } catch (error) {
                if (!isCurrent()) return;
                if (error.code === 'TORBOX_SOURCE_NOT_FOUND') {
                    await removeFromAppLibrary(media.media_ids, {
                        userId,
                        hashes: media.sources.map(source => source.hash).filter(Boolean),
                        message: `None of the sources for "${media.title || 'this item'}" were found in TorBox. Remove this item from your library?`
                    });
                } else {
                    showToast(error.message || 'Could not open this media.', 'error');
                }
            } finally {
                busy = false;
                card.style.opacity = '1';
            }
        });
        return card;
    } });
}

export async function resolveLibraryTorrents(sources, { refresh = false } = {}) {
    const normalizeHash = hash => typeof hash === 'string' ? hash.trim().toLowerCase() : '';
    const hashes = new Set(sources.map(source => normalizeHash(source.hash)).filter(Boolean));
    if (hashes.size === 0) throw new Error('No valid source is linked to this item.');
    const cachedTorrents = appState.allTorrents.filter(torrent => hashes.has(normalizeHash(torrent.hash)) && torrent.download_finished);
    if (!refresh && cachedTorrents.length === hashes.size && cachedTorrents.length > 0) return cachedTorrents;

    const tbKey = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!tbKey) throw new Error('Link TorBox in settings to play or download this media.');
    const userId = appState.currentUser?.id;

    const isCurrent = () => tbKey === getCurrentUserSettings().user_preferences.torboxApiKey
        && userId === appState.currentUser?.id;
    const torrents = [];
    const matchingTorrents = [];
    const foundHashes = new Set();
    const seenHashes = new Set();
    const pageSize = 1000;
    let complete = false;

    // Verify on demand, bypassing TorBox's cache. Only exhaust the list when
    // some requested sources are still missing; the API defaults to 1,000 items.
    for (let offset = 0; ; offset += pageSize) {
        const res = await smartFetch(
            `https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true&offset=${offset}&limit=${pageSize}`,
            { headers: { 'Authorization': `Bearer ${tbKey}` } }
        );
        if (!res.ok) throw new Error('Could not load your TorBox files.');
        const result = await res.json();
        if (!isCurrent()) throw new Error('Your account changed. Please open this item again.');
        if (!result.success || !Array.isArray(result.data)
            || result.data.some(torrent => !normalizeHash(torrent?.hash))) {
            throw new Error(result.detail || 'TorBox returned an invalid torrent list.');
        }
        let newHashes = 0;
        for (const torrent of result.data) {
            const hash = normalizeHash(torrent.hash);
            if (seenHashes.has(hash)) continue;
            seenHashes.add(hash);
            newHashes++;
            torrents.push(torrent);
            if (hashes.has(hash)) {
                foundHashes.add(hash);
                matchingTorrents.push(torrent);
            }
        }
        complete = result.data.length < pageSize;
        if (complete || foundHashes.size === hashes.size) break;
        if (newHashes === 0) throw new Error('TorBox returned an incomplete torrent list. Please try again.');
    }
    const readyTorrents = matchingTorrents.filter(torrent => torrent.download_finished);
    appState.allTorrents = complete ? torrents.filter(torrent => torrent.download_finished)
        : [...appState.allTorrents.filter(torrent => !hashes.has(normalizeHash(torrent.hash))), ...readyTorrents];

    if (matchingTorrents.length === 0) {
        const error = new Error('None of the linked sources were found in TorBox.');
        error.code = 'TORBOX_SOURCE_NOT_FOUND';
        throw error;
    }

    if (readyTorrents.length > 0) return readyTorrents;
    throw new Error('No source is ready yet. Check its download in TorBox.');
}
//#endregion
