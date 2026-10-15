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
import { parseMediaData } from '../utils/parseMedia.js';


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
        await loadAppLibrary();
    } catch (err) {
        console.error("Database linking failed:", err.message);
    }
}

export async function linkHashToMedia(mediaData, torboxHash) {
    if (!appState.currentUser) return;
    // Link the Torbox Hash to the Media ID
    const { error } = await supabase.from('added_sources').insert({
        user_id: appState.currentUser.id,
        media_id: mediaData.id,
        added_hash: torboxHash,
        season_number: mediaData.season || null,
        episode_number: mediaData.episode || null
    });

    if (error && error.code === '23505') {
        console.log("This specific source is already mapped to this user.");
    } else if (error) {
        throw error;
    }
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

    // 1. Fetch all sources joined with global_media
    const { data, error } = await supabase
        .from('added_sources')
        .select(`
            media_id,
            added_hash,
            season_number,
            episode_number,
            global_media ( media_type, title, poster_path, base_url )
        `)
        .eq('user_id', appState.currentUser.id);

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
            hash: row.added_hash,
            season: row.season_number,
            episode: row.episode_number
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

        if (!isSingle && hasSeason) mediaText = "Series";
        if (isSingle && hasSeason) mediaText = "Single Episode";
        if (isSingle && !hasSeason) mediaText = "Movie";
        if (!isSingle && !hasSeason) mediaText = "Collection";

        const card = createLibraryCard(
            media.title || 'Untitled movie',
            media.poster_path,
            mediaText,
            torrent?.size,
        );

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
                const { torrentId, fileId, fileName } = await resolveMovieSource(media.sources);
                if (action === 'download') await downloadFile(torrentId, fileId, fileName);
                else await requestLink(torrentId, fileId, media.title, fileName);
            } catch (error) {
                showToast(error.message || 'Could not open this movie.', 'error');
            } finally {
                busy = false;
                card.style.opacity = '1';
            }
        });
        list.appendChild(card);
    }
}

async function resolveMovieSource(sources) {
    const tbKey = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!tbKey) throw new Error('Link TorBox in settings to play or download this movie.');

    // 1. Fetch the user's active Torbox library
    const res = await smartFetch('https://api.torbox.app/v1/api/torrents/mylist', {
        headers: { 'Authorization': `Bearer ${tbKey}` }
    });
    const result = await res.json();
    if (!result.success || !Array.isArray(result.data)) {
        throw new Error(result.detail || 'Could not load your TorBox files.');
    }

    // 2. Find the torrent that matches your Supabase hash
    const matchingTorrents = sources.flatMap(source => result.data.filter(t => t.hash === source.hash));

    if (matchingTorrents.length === 0) {
        throw new Error("Torrent not found in Torbox. Did you delete it?");
    }

    // Every library entry plays as a movie, even if its source has multiple videos.
    for (const torrent of matchingTorrents) {
        if (!torrent.download_finished) continue;
        const videoFiles = (torrent.files || []).filter(file =>
            /\.(mp4|mkv|avi|mov)$/i.test(file.name) && !/(^|[\s._/\\-])sample([\s._/\\-]|$)/i.test(file.name)
        );
        const targetFile = videoFiles.reduce((largest, file) =>
            !largest || Number(file.size) > Number(largest.size) ? file : largest, null);
        if (targetFile) {
            return { torrentId: torrent.id, fileId: targetFile.id, fileName: targetFile.name };
        }
    }
    throw new Error('No playable movie file is ready yet. Check its download in TorBox.');
}
//#endregion