/**
 * ===================================
 * Keep track of media added in Theama
 * ===================================
 */

import { supabase } from '../user-data/db.js';
import { appState, smartFetch, showToast } from '../services/config.js';

import { getCurrentUserSettings } from '../user-data/user-settings.js';
import { requestLink } from '../streaming/player.js';
import { downloadFile } from '../streaming/download.js';
import { createLibraryCard } from './library-renderer.js';
import { getMediaText } from './library.js';
import { openPicker } from '../metadata/picker.js';


//#region Manage Library
export async function addToAppLibrary(mediaData) {
    if (!appState.currentUser) return;

    try {
        // Add to Global Media (ignore it if it already exists)
        await supabase.from('global_media').upsert({
            media_id: mediaData.id,
            media_type: mediaData.type,
            title: mediaData.title,
            poster_path: mediaData.poster,
            base_url: mediaData.baseUrl
        }, { onConflict: 'media_id', ignoreDuplicates: true });

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

async function removeFromAppLibrary(mediaId) {
    const userId = appState.currentUser?.id;
    if (!userId || !confirm('Remove this movie from your library?')) return;
    try {
        const { error } = await supabase.from('added_sources')
            .delete()
            .eq('user_id', userId)
            .eq('media_id', mediaId);
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
    if (!appState.currentUser) return [];

    // 1. Fetch sources added through the app, joined with global_media
    const { data, error } = await supabase
        .from('added_sources')
        .select(`
            media_id,
            added_hash,
            global_media ( media_type, title, poster_path, base_url )
        `)
        .eq('user_id', appState.currentUser.id)
        .eq('added_via_app', true);

    if (error) throw error;

    // 2. Group by media_id to remove duplicates (One poster per movie/show)
    const groupedLibrary = new Map();
    for (const row of data || []) {
        if (!groupedLibrary.has(row.media_id)) {
            groupedLibrary.set(row.media_id, {
                id: row.media_id,
                ...row.global_media,
                sources: [] // We pack all the hashes into this array
            });
        }
        groupedLibrary.get(row.media_id).sources.push({
            hash: row.added_hash
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
                await removeFromAppLibrary(media.id);
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
                    if (playableFile) await requestLink(sourceTorrent.id, playableFile.id, sourceTorrent.name, playableFile.name);
                    else showToast('No playable files found.', 'error');
                } else {
                    await openPicker(sourceTorrents, media.id, media.title);
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

async function resolveLibraryTorrents(sources) {
    const hashes = new Set(sources.map(source => source.hash).filter(Boolean));
    const cachedTorrents = appState.allTorrents.filter(torrent => hashes.has(torrent.hash) && torrent.download_finished);
    if (cachedTorrents.length === hashes.size && cachedTorrents.length > 0) return cachedTorrents;

    const tbKey = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!tbKey) throw new Error('Link TorBox in settings to play or download this media.');

    // 1. Fetch the user's active Torbox library
    const res = await smartFetch('https://api.torbox.app/v1/api/torrents/mylist', {
        headers: { 'Authorization': `Bearer ${tbKey}` }
    });
    const result = await res.json();
    if (!result.success || !Array.isArray(result.data)) {
        throw new Error(result.detail || 'Could not load your TorBox files.');
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
