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

async function removeFromAppLibrary(mediaIds) {
    const userId = appState.currentUser?.id;
    if (!userId || !confirm('Remove this movie from your library?')) return;
    try {
        const { error } = await supabase.from('added_sources')
            .delete()
            .eq('user_id', userId)
            .eq('media_id', mediaIds);
        if (error) throw error;
        await loadAppLibrary();
        showToast('Removed from your library.', 'success');
    } catch (error) {
        showToast(error.message || 'Could not remove this movie.', 'error');
    }
}
//#endregion

//#region Load Library
export async function loadAppLibrary() {
    const userId = appState.currentUser?.id;
    const list = document.getElementById('app-library-list');
    const info = document.getElementById('app-library-info-text');
    if (!list || !info) return;

    list.replaceChildren();
    info.textContent = userId ? 'Loading your library...' : 'Sign in to view your library.';
    info.classList.remove('hidden');
    if (!userId) return;

    try {
        const items = await fetchAppLibraryData();
        if (userId !== appState.currentUser?.id) return;
        renderAppLibrary(items);
    } catch (error) {
        if (userId !== appState.currentUser?.id) return;
        console.error('App library load failed:', error);
        info.textContent = 'Could not load your library. Select Library to try again.';
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
        .eq('added_via_app', true);

    if (error) throw error;

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
    const list = document.getElementById('app-library-list');
    const info = document.getElementById('app-library-info-text');
    list.replaceChildren();
    info.textContent = 'Your library is empty.';
    info.classList.toggle('hidden', items.length > 0);

    for (const media of items) {
        const torrent = appState.allTorrents.find(t => media.sources.some(source => source.hash === t.hash));
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
            try {
                const sourceTorrents = await resolveLibraryTorrents(media.sources);
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
                showToast(error.message || 'Could not open this media.', 'error');
            } finally {
                busy = false;
                card.style.opacity = '1';
            }
        });
        list.appendChild(card);
    }
}

export async function resolveLibraryTorrents(sources) {
    const hashes = new Set(sources.map(source => source.hash).filter(Boolean));
    const cachedTorrents = appState.allTorrents.filter(torrent => hashes.has(torrent.hash) && torrent.download_finished);
    if (cachedTorrents.length === hashes.size && cachedTorrents.length > 0) return cachedTorrents;

    const tbKey = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!tbKey) throw new Error('Link TorBox in settings to play or download this media.');
    const userId = appState.currentUser?.id;

    // 1. Fetch the user's active Torbox library
    const res = await smartFetch('https://api.torbox.app/v1/api/torrents/mylist', {
        headers: { 'Authorization': `Bearer ${tbKey}` }
    });
    const result = await res.json();
    if (!result.success || !Array.isArray(result.data)) {
        throw new Error(result.detail || 'Could not load your TorBox files.');
    }
    if (tbKey === getCurrentUserSettings().user_preferences.torboxApiKey
        && userId === appState.currentUser?.id) {
        appState.allTorrents = result.data.filter(torrent => torrent.download_finished);
    }

    // 2. Resolve all linked hashes in one request.
    const matchingTorrents = result.data.filter(torrent => hashes.has(torrent.hash));

    if (matchingTorrents.length === 0) {
        throw new Error("Torrent not found in Torbox. Did you delete it?");
    }

    const readyTorrents = matchingTorrents.filter(torrent => torrent.download_finished);
    if (readyTorrents.length > 0) return readyTorrents;
    throw new Error('No source is ready yet. Check its download in TorBox.');
}
//#endregion
