/**
 * ===================================
 * Keep track of media added in Theama
 * ===================================
 */

import { supabase } from '../user-data/db.js';
import { appState, showToast } from '../services/config.js';

import { createLibraryCard } from './library-renderer.js';
import { openPicker } from '../metadata/picker.js';
import { getTorrentObjectFromHash } from '../utils/streams.js';


//#region Manage Library
export async function addToGlobalMedia(mediaData) {
    if (!appState.currentUser) return;

    const { error } = await supabase.from('global_media').insert({
        media_id: mediaData.id,
        tmdb_id: mediaData.tmdbId,
        media_type: mediaData.type,
        title: mediaData.title,
        poster_path: mediaData.poster,
        base_url: mediaData.baseUrl
    });
    // A duplicate means the media already exists, so source linking can continue.
    if (error && error.code !== '23505') throw error;
}

export async function linkHashToMedia(mediaData, sourceKey = null) {
    if (!appState.currentUser || typeof sourceKey !== 'string' || !sourceKey) return;
    const userId = appState.currentUser.id;

    let sourceEpisode = "";
    if (mediaData.activeEpisode != null && mediaData.activeSeason != null) {
        sourceEpisode = `${mediaData.activeSeason}:${mediaData.activeEpisode}`;
    }

    if (typeof sourceKey === 'string' && /^https?:\/\//i.test(sourceKey)) {
        const urlFilter = 'added_hash.ilike.http://%,added_hash.ilike.https://%';
        const { data: urls, error: readError } = await supabase.from('added_sources')
            .select('added_hash')
            .eq('user_id', userId)
            .eq('media_id', mediaData.id)
            .or(urlFilter)
            .order('created_at', { ascending: false });
        if (readError) throw readError;

        // Reuse the incoming URL's row if already saved to avoid a unique-key conflict.
        const existing = urls.find(row => row.added_hash === sourceKey) || urls[0];
        const source = { added_hash: sourceKey, source_episode: sourceEpisode || null };
        const { error: saveError } = existing
            ? await supabase.from('added_sources').update(source)
                .eq('user_id', userId)
                .eq('media_id', mediaData.id)
                .eq('added_hash', existing.added_hash)
                .or(urlFilter)
            : await supabase.from('added_sources').insert({
                user_id: userId, media_id: mediaData.id, ...source
            });
        if (saveError) throw saveError;

        // Clean up older URL duplicates only after the new URL has been saved.
        if (urls.length > 1) {
            const { error: cleanupError } = await supabase.from('added_sources').delete()
                .eq('user_id', userId)
                .eq('media_id', mediaData.id)
                .or(urlFilter)
                .neq('added_hash', sourceKey);
            if (cleanupError) throw cleanupError;
        }
        return;
    }

    // Link the source hash or URL to the global media item.
    const { error } = await supabase.from('added_sources').insert({
        user_id: userId,
        media_id: mediaData.id,
        added_hash: sourceKey,
        source_episode: sourceEpisode ? sourceEpisode : null
    });

    if (error?.code === '23505' && sourceKey) {
        const { error: updateError } = await supabase.from('added_sources')
            .update({ media_id: mediaData.id })
            .eq('user_id', userId)
            .eq('added_hash', sourceKey);
        if (updateError) throw updateError;
    } else if (error) {
        throw error;
    }
}

export async function addToAppLibrary(item, sourceKey) {
    if (!item || !sourceKey) return;

    const mediaData = {
        id: item.id,
        tmdbId: item.tmdbId,
        type: item.type,
        title: item.title,
        poster: item.poster || null,
        baseUrl: item.baseUrl || null
    };
    if (Object.values(mediaData).some(value => !value || (typeof value === 'string' && !value.trim()))) return;

    const userId = appState.currentUser?.id;
    if (!userId) throw new Error('Sign in to add cloud items to your library.');

    await addToGlobalMedia(mediaData);

    mediaData.activeEpisode = item.activeEpisode ?? null;
    mediaData.activeSeason = item.activeSeason ?? null;

    try {
        saveEpisodeUrl(mediaData, sourceKey);
        await linkHashToMedia(mediaData, sourceKey);
    } catch (error) {
        showToast(error.message || 'Could not add this source.', 'error');
        return;
    }

    await loadAppLibrary();
    return true;
}

function readEpisodeUrls(userId) {
    try {
        const urls = JSON.parse(localStorage.getItem(`library_episode_urls_${userId}`) || '{}');
        if (!urls || typeof urls !== 'object' || Array.isArray(urls)) return {};
        return Object.fromEntries(Object.entries(urls).filter(([, episodes]) =>
            episodes && typeof episodes === 'object' && !Array.isArray(episodes)));
    } catch {
        return {};
    }
}

export function saveEpisodeUrl(mediaData, sourceKey) {
    const url = typeof sourceKey === 'string' ? sourceKey.trim() : '';
    const userId = appState.currentUser?.id;

    if (!userId || !mediaData.id || !/^https?:\/\//i.test(url)) return;

    const storageKey = `library_episode_urls_${userId}`;
    const episodeUrls = readEpisodeUrls(userId);
    const episode = mediaData.type === 'movie'
        ? mediaData.tmdbId
        : `${mediaData.activeSeason}:${mediaData.activeEpisode}`;

    episodeUrls[mediaData.id] ??= {};
    episodeUrls[mediaData.id][episode] = url;
    localStorage.setItem(storageKey, JSON.stringify(episodeUrls));
    return episodeUrls;
}

async function removeFromAppLibrary(mediaIds, { message = 'Remove this media from your library?', userId = appState.currentUser?.id } = {}) {
    if (!userId || userId !== appState.currentUser?.id || !confirm(message)) return;
    try {
        const { error } = await supabase.from('added_sources')
            .delete()
            .eq('user_id', userId)
            .in('media_id', mediaIds);
        if (error) throw error;
        if (userId !== appState.currentUser?.id) return;
        try {
            const episodeUrls = readEpisodeUrls(userId);
            for (const mediaId of mediaIds) delete episodeUrls[mediaId];
            localStorage.setItem(`library_episode_urls_${userId}`, JSON.stringify(episodeUrls));
        } catch (error) {
            console.warn('Could not clear local library URLs:', error);
        }
        await loadAppLibrary();
        showToast('Removed from your library.', 'success');
    } catch (error) {
        showToast(error.message || 'Could not remove this media.', 'error');
    }
}
//#endregion

//#region Load Library
export function searchAppLibrary() {
    const list = document.getElementById('app-library-list');
    const info = document.getElementById('app-library-info-text');
    if (!list || !info || !appState.currentUser || list.getAttribute('aria-busy') === 'true') return;
    const query = document.getElementById('library-search-input')?.value.trim().toLowerCase() || '';
    let visible = 0;
    for (const card of list.children) {
        const matches = card.querySelector('.library-title').textContent.toLowerCase().includes(query);
        card.classList.toggle('hidden', !matches);
        if (matches) visible++;
    }
    info.textContent = query ? 'No saved titles match your search.' : 'Your library is empty.';
    info.classList.toggle('hidden', visible > 0);
}

export async function loadAppLibrary() {
    const userId = appState.currentUser?.id;
    const list = document.getElementById('app-library-list');
    const info = document.getElementById('app-library-info-text');
    if (!list || !info) return;
    document.getElementById('app-library-login-btn')?.classList.toggle('hidden', Boolean(userId));

    list.replaceChildren();
    list.setAttribute('aria-busy', String(Boolean(userId)));
    info.textContent = userId ? 'Loading your library...' : 'Sign in to view your library.';
    info.classList.remove('hidden');
    if (!userId) return;

    try {
        const items = await fetchAppLibraryData();
        if (userId !== appState.currentUser?.id) return;
        renderAppLibrary(items);
        window.dispatchEvent(new CustomEvent('app-library:updated', { detail: { userId } }));
    } catch (error) {
        if (userId !== appState.currentUser?.id) return;
        console.error('App library load failed:', error);
        list.setAttribute('aria-busy', 'false');
        info.textContent = 'Could not load your library. Select Library to try again.';
        info.classList.remove('hidden');
    }
}

export async function fetchAppLibraryData() {
    const userId = appState.currentUser?.id;
    if (!userId) return [];

    const rows = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await supabase
            .from('added_sources')
            .select(`
                media_id,
                added_hash,
                created_at,
                source_episode,
                global_media (
                    tmdb_id,
                    media_type,
                    title,
                    poster_path,
                    base_url
                )
            `)
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + pageSize - 1);
        if (error) throw error;
        rows.push(...data || []);
        if (!data || data.length < pageSize) break;
    }

    const items = [];
    const mediaGroups = new Map();
    for (const row of rows) {
        const value = typeof row.added_hash === 'string' ? row.added_hash.trim() : '';
        const isUrl = /^https?:\/\//i.test(value);
        const source = {
            [isUrl ? 'url' : 'hash']: value,
            addedAt: row.created_at
        };

        const tmdbId = row.global_media?.tmdb_id;
        const groupKey = tmdbId ? `tmdb:${tmdbId}` : `media:${row.media_id}`;
        let media = mediaGroups.get(groupKey);
        if (!media) {
            media = {
                ...row.global_media,
                id: row.media_id,
                sourceEpisode: {},
                mediaIds: [],
                media_type: row.global_media?.media_type === 'series' ? 'tv' : row.global_media?.media_type,
                sources: []
            };
            items.push(media);
            mediaGroups.set(groupKey, media);
        }
        if (!media.mediaIds.includes(row.media_id)) media.mediaIds.push(row.media_id);
        const sourceEpisode = row.global_media?.media_type === 'movie' ? tmdbId : row.source_episode;
        if (sourceEpisode && isUrl) {
            media.sourceEpisode[sourceEpisode] ??= value;
        }
        if (value) media.sources.push(source);
    }

    return items;
}

export function renderAppLibrary(items) {
    const list = document.getElementById('app-library-list');
    if (!list) return;
    const userId = appState.currentUser?.id;
    const cards = document.createDocumentFragment();

    for (const media of items) {
        const hashes = media.sources.filter(source => source.hash);
        const url = media.sources.find(source => source.url)?.url;

        const mediaIds = media.mediaIds || [media.id];
        const isPacked = media.sources.length > 1;
        const mediaText = media.media_type === 'tv' ? 'Series' : 'Movie';

        const card = createLibraryCard(
            media.title || 'Untitled movie',
            media.poster_path,
            mediaText,
        );

        if (!hashes.length || url) card.querySelector('[data-action="download"]').classList.add('hidden');
        if (url || !hashes.length || isPacked) {
            const badge = card.querySelector('.library-size');
            badge.textContent = isPacked ? `${media.sources.length} SOURCES` : url ? 'PLAYBACK URL' : 'No source found';
            badge.classList.remove('hidden');
        }

        let busy = false;
        card.addEventListener('click', async event => {
            const action = event.target.closest('button')?.dataset.action;
            if (action) event.stopPropagation();
            if (busy || userId !== appState.currentUser?.id) return;

            if (action === 'delete') {
                await removeFromAppLibrary(mediaIds, { userId });
                return;
            }
            if (action === 'download' && url) return;
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

            // Normal click
            try {
                console.log(media);

                let libraryData = [];

                libraryData.type = media.media_type;
                libraryData.savedId = media.id || mediaIds[0];

                // Local url/episode saves
                const savedUrls = readEpisodeUrls(userId);
                const savedMedia = {};
                for (const mediaId of [...mediaIds].reverse()) {
                    Object.assign(savedMedia, savedUrls[mediaId]);
                }

                if (Object.keys(savedMedia).length) {
                    libraryData.savedEpisodes = savedMedia;
                }

                // URL ONLY SUPABASE EPISODES
                libraryData.sourceEpisodes = media.sourceEpisode;

                if (hashes.length > 0) {
                    const results = await Promise.allSettled(hashes.map(source =>
                        getTorrentObjectFromHash(source.hash)));
                    libraryData.torrents = results
                        .filter(result => result.status === 'fulfilled')
                        .map(result => result.value);
                }

                if (userId !== appState.currentUser?.id) return;
                const failedCount = hashes.length - (libraryData.torrents?.length || 0);
                if (failedCount) {
                    showToast(`${failedCount} torrent source${failedCount === 1 ? '' : 's'} could not be loaded.`, 'info');
                }

                await openPicker(
                    libraryData,
                    media.tmdb_id,
                    media.title
                );
            } catch (error) {
                showToast(error.message || 'Could not open this media.', 'error');
            } finally {
                busy = false;
                card.style.opacity = '1';
            }
        });
        cards.append(card);
    }
    list.replaceChildren(cards);
    list.setAttribute('aria-busy', 'false');
    searchAppLibrary();
}
//#endregion
