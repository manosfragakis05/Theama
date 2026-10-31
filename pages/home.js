import { fetchTMDBEndpoint } from '../user-addons/catalogs.js';
import { appState, showToast } from '../services/config.js';
import { supabase } from '../user-data/db.js';
import { getCurrentUserSettings } from '../user-data/user-settings.js';
import { resolveLibraryTorrents } from './app-library.js';
import { buildSeriesQueue, startQueueFromEpisode, startQueueFromItem } from '../streaming/playlist.js';
import { buildRemainingTorrentQueue } from '../metadata/picker.js';
import { requestLink } from '../streaming/player.js';
import { openAddonLibraryMedia } from './addon-library.js';
import {
    renderHomeCarousel, renderHomeMessage, renderWatchProgress, renderWatchProgressMessage,
    renderHomeRecommendations, renderHomeRecommendationsMessage
} from './home-renderer.js';

let loadPromise = null;
let loadedAt = 0;
const CACHE_MS = 60 * 60 * 1000;
const PROGRESS_CACHE_MS = 60 * 1000;
const metadataCache = new Map();
let progressUserId = null;
let progressLoadedAt = 0;
let progressRequest = null;
let progressVersion = 0;
let resumeVersion = 0;
let progressItems = [];
let recommendationsUserId = null;
let recommendationsLoadedAt = 0;
let recommendationsRequest = null;
let recommendationsVersion = 0;
const HIDDEN_PROGRESS_PREFIX = 'theama_hidden_watch_progress:';
let hiddenProgressUserId = null;
let hiddenProgressIds = new Set();

function getHiddenProgress(userId) {
    if (hiddenProgressUserId === userId) return hiddenProgressIds;
    hiddenProgressUserId = userId;
    hiddenProgressIds = new Set();
    if (!userId) return hiddenProgressIds;
    try {
        const saved = JSON.parse(localStorage.getItem(HIDDEN_PROGRESS_PREFIX + userId));
        if (Array.isArray(saved)) {
            hiddenProgressIds = new Set(saved.filter(key => typeof key === 'string'
                && /^(movie|tv):[1-9]\d*$/.test(key)));
        }
    } catch (error) {
        console.warn('Could not restore hidden watch history:', error);
    }
    return hiddenProgressIds;
}

function saveHiddenProgress(userId) {
    try {
        localStorage.setItem(HIDDEN_PROGRESS_PREFIX + userId, JSON.stringify([...hiddenProgressIds]));
    } catch (error) {
        console.warn('Could not save hidden watch history:', error);
        showToast('This change will last for this visit. Browser storage is unavailable.', 'info');
    }
}

function renderVisibleWatchProgress() {
    const root = document.getElementById('home-watch-progress');
    if (!root) return;
    const userId = appState.currentUser?.id ?? null;
    const hidden = getHiddenProgress(userId);
    const items = progressItems.filter(item => item.userId === userId && !hidden.has(`${item.type}:${item.id}`));
    renderWatchProgress(root, items, playWatchProgress, {
        onHide: hideWatchProgress,
        onRestore: restoreWatchProgress,
        hiddenCount: userId ? hidden.size : 0
    });
}

function hideWatchProgress(item) {
    const userId = appState.currentUser?.id;
    if (!userId || item.userId !== userId) return;
    getHiddenProgress(userId).add(`${item.type}:${item.id}`);
    saveHiddenProgress(userId);
    renderVisibleWatchProgress();
}

function restoreWatchProgress() {
    const userId = appState.currentUser?.id;
    if (!userId) return;
    getHiddenProgress(userId).clear();
    saveHiddenProgress(userId);
    renderVisibleWatchProgress();
}

function fetchHomeMetadata(endpoint) {
    const cached = metadataCache.get(endpoint);
    if (cached && Date.now() - cached.loadedAt < CACHE_MS) return cached.promise;
    const entry = { loadedAt: Date.now(), promise: null };
    entry.promise = fetchTMDBEndpoint(endpoint).catch(error => {
        if (metadataCache.get(endpoint) === entry) metadataCache.delete(endpoint);
        throw error;
    });
    metadataCache.set(endpoint, entry);
    if (metadataCache.size > 100) metadataCache.delete(metadataCache.keys().next().value);
    return entry.promise;
}

export async function formatWatchProgress(row, userId = appState.currentUser?.id) {
    const id = Number(row.tmdb_id);
    const type = row.media_type;
    if (!Number.isSafeInteger(id) || id <= 0 || !['movie', 'tv'].includes(type)) return null;
    const match = type === 'tv' ? /^(\d+):([1-9]\d*)$/.exec(row.current_episode || '') : null;
    const season = match ? Number(match[1]) : null;
    const episode = match ? Number(match[2]) : null;
    const [titleResult, episodeResult] = await Promise.allSettled([
        fetchHomeMetadata(`${type}/${id}`),
        match ? fetchHomeMetadata(`tv/${id}/season/${season}/episode/${episode}`) : Promise.resolve(null)
    ]);
    const title = titleResult.status === 'fulfilled' ? titleResult.value : null;
    const episodeData = episodeResult.status === 'fulfilled' ? episodeResult.value : null;
    const duration = Math.max(0, Number(row.duration_seconds) || 0);
    const position = Math.max(0, Math.min(Number(row.position_seconds) || 0, duration));
    const progress = duration > 0 ? position / duration * 100 : 0;
    return {
        id, type, season, episode,
        userId,
        currentHash: typeof row.current_hash === 'string' ? row.current_hash.trim() : '',
        fileId: row.t_id != null && Number.isInteger(Number(row.t_id)) && Number(row.t_id) >= 0
            ? Number(row.t_id) : null,
        title: title?.title || title?.name || (type === 'movie' ? 'Movie' : 'Series'),
        year: (title?.release_date || title?.first_air_date || '').slice(0, 4),
        episodeTitle: episodeData?.name || '',
        image: imageUrl(type === 'movie' ? title?.backdrop_path : episodeData?.still_path, 'w500'),
        positionSeconds: position,
        durationSeconds: duration,
        progress,
        completed: progress >= 90,
        remainingMinutes: Math.ceil((duration - position) / 60)
    };
}

export async function playWatchProgress(item) {
    const version = ++resumeVersion;
    const userId = appState.currentUser?.id;
    try {
        if (!userId || item.userId !== userId) throw new Error('Sign in to resume your watch history.');
        if (!item.currentHash) {
            throw new Error('Play this title from your library once to enable direct resume.');
        }
        if (item.type === 'tv' && (!Number.isInteger(item.season) || !Number.isInteger(item.episode))) {
            throw new Error('Choose this episode from your library to save its playback details.');
        }
        if (!getCurrentUserSettings().user_preferences.torboxApiKey) {
            await openAddonLibraryMedia({
                id: String(item.id), tmdb_id: item.id, media_type: item.type,
                title: item.title, poster_path: item.image,
                sources: [{ hash: item.currentHash }]
            }, { resume: { season: item.season, episode: item.episode, positionSeconds: item.positionSeconds } });
            return;
        }
        if (item.fileId === null) throw new Error('Choose this episode from your library to refresh its playback details.');
        const [torrent] = await resolveLibraryTorrents([{ hash: item.currentHash }]);
        if (version !== resumeVersion || userId !== appState.currentUser?.id) return;
        const file = (torrent.files || []).find(candidate => String(candidate.id) === String(item.fileId));
        if (!file) throw new Error('The saved episode file is no longer available in this torrent.');

        const resumeItem = {
            tid: torrent.id, fid: file.id, hash: torrent.hash,
            torrentName: torrent.name, fileName: file.name || file.short_name,
            tmdbId: item.id, mediaType: item.type,
            seasonNumber: item.season, episodeNumber: item.episode, watchEpisodeNumber: item.episode,
            seriesTitle: item.type === 'tv' ? item.title : '',
            season: item.season !== null ? `Season ${item.season}` : '',
            title: item.episodeTitle || item.title, thumbnail: item.image
        };
        const episodes = item.type === 'tv'
            ? await buildRemainingTorrentQueue(torrent, item.id, file.id, item.title, item.image)
            : [];
        if (version !== resumeVersion || userId !== appState.currentUser?.id) return;

        let current;
        if (episodes.length > 0) {
            // Keep the saved episode mapping and position for the exact resumed file.
            episodes[0] = { ...episodes[0], ...resumeItem };
            buildSeriesQueue(episodes);
            current = startQueueFromEpisode();
        } else {
            current = startQueueFromItem(resumeItem);
        }
        await requestLink(current.tid, current.fid, current.torrentName, current.fileName,
            current.uid, item.positionSeconds);
    } catch (error) {
        if (version === resumeVersion && userId === appState.currentUser?.id) {
            showToast(error.message || 'Could not resume this title.', 'error');
        }
    }
}

export function loadWatchProgress() {
    const root = document.getElementById('home-watch-progress');
    if (!root) return Promise.resolve();
    const userId = appState.currentUser?.id ?? null;
    if (progressUserId !== userId) {
        progressUserId = userId;
        progressLoadedAt = 0;
        progressRequest = null;
        progressVersion++;
        progressItems = [];
        renderVisibleWatchProgress();
    }
    if (!userId) {
        renderVisibleWatchProgress();
        return Promise.resolve();
    }
    if (Date.now() - progressLoadedAt < PROGRESS_CACHE_MS) return Promise.resolve();
    if (progressRequest) return progressRequest;
    const version = ++progressVersion;
    const isCurrent = () => version === progressVersion && appState.currentUser?.id === userId;
    root.setAttribute('aria-busy', 'true');
    if (!progressLoadedAt) renderWatchProgressMessage(root, 'Loading your watch history...');
    const request = (async () => {
        try {
            const { data, error } = await supabase.from('watch_progress')
                .select('tmdb_id,media_type,current_episode,position_seconds,duration_seconds,last_watched_at,current_hash,t_id')
                .eq('user_id', userId)
                .order('last_watched_at', { ascending: false })
                .limit(20);
            if (error) throw error;
            if (!isCurrent()) return;
            const items = (await Promise.all((data || []).map(row => formatWatchProgress(row, userId)))).filter(Boolean);
            if (!isCurrent()) return;
            progressItems = items;
            renderVisibleWatchProgress();
            progressLoadedAt = Date.now();
        } catch (error) {
            if (!isCurrent()) return;
            console.error('Home watch history failed:', error);
            renderWatchProgressMessage(root, "Couldn't load your watch history. Try visiting Home again.");
        } finally {
            if (isCurrent()) root.setAttribute('aria-busy', 'false');
            if (progressRequest === request) progressRequest = null;
        }
    })();
    progressRequest = request;
    return request;
}

async function getRecommendationSeeds(type, userId, isCurrent) {
    const ids = new Set();
    const pageSize = 32;
    // Several sources can belong to one show; collect four distinct titles.
    for (let offset = 0; isCurrent(); offset += pageSize) {
        const { data, error } = await supabase.from('added_sources')
            .select('global_media!inner(tmdb_id,media_type)')
            .eq('user_id', userId)
            .eq('added_via_app', true)
            .in('global_media.media_type', type === 'tv' ? ['tv', 'series'] : ['movie'])
            .not('global_media.tmdb_id', 'is', null)
            .order('created_at', { ascending: false })
            .range(offset, offset + pageSize - 1);
        if (error) throw error;
        if (!isCurrent()) return [];
        for (const row of data || []) {
            const id = Number(row.global_media?.tmdb_id);
            if (Number.isSafeInteger(id) && id > 0) ids.add(id);
            if (ids.size === 4) return [...ids];
        }
        if (!data || data.length < pageSize) break;
    }
    return [...ids];
}

function mixRecommendationResults(results, seedIds) {
    const lists = results.filter(result => result.status === 'fulfilled')
        .map(result => Array.isArray(result.value?.results) ? result.value.results : []);
    const seen = new Set(seedIds);
    const mixed = [];
    const length = Math.max(0, ...lists.map(list => list.length));
    // Alternate between seeds so each title contributes to the row.
    for (let index = 0; index < length; index++) {
        for (const list of lists) {
            const item = list[index];
            const id = Number(item?.id);
            if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
            seen.add(id);
            mixed.push({ ...item, id });
        }
    }
    return mixed;
}

export function loadHomeRecommendations() {
    const root = document.getElementById('home-recommendations');
    if (!root) return Promise.resolve();
    const userId = appState.currentUser?.id ?? null;
    if (recommendationsUserId !== userId) {
        recommendationsUserId = userId;
        recommendationsLoadedAt = 0;
        recommendationsRequest = null;
        recommendationsVersion++;
        renderHomeRecommendations(root, {});
        root.setAttribute('aria-busy', 'false');
    }
    if (!userId) {
        renderHomeRecommendations(root, {});
        return Promise.resolve();
    }
    if (Date.now() - recommendationsLoadedAt < PROGRESS_CACHE_MS) return Promise.resolve();
    if (recommendationsRequest) return recommendationsRequest;
    const version = ++recommendationsVersion;
    const isCurrent = () => version === recommendationsVersion && appState.currentUser?.id === userId;
    root.setAttribute('aria-busy', 'true');
    if (!recommendationsLoadedAt) renderHomeRecommendationsMessage(root, 'Finding recommendations from your library...');
    const request = (async () => {
        try {
            const types = ['movie', 'tv'];
            const seeds = await Promise.all(types.map(type => getRecommendationSeeds(type, userId, isCurrent)));
            if (!isCurrent()) return;
            const recommendations = await Promise.all(types.map(async (type, index) => {
                const results = await Promise.allSettled(seeds[index].map(id =>
                    fetchHomeMetadata(`${type}/${id}/recommendations`)));
                if (results.length && results.every(result => result.status === 'rejected')) {
                    console.warn(`Could not load ${type} recommendations:`, results[0].reason);
                }
                return { results, items: mixRecommendationResults(results, seeds[index]) };
            }));
            if (!isCurrent()) return;
            const failed = recommendations.some(row => row.results.some(result => result.status === 'rejected'));
            if (recommendations.some(row => row.items.length)) {
                renderHomeRecommendations(root, Object.fromEntries(types.map((type, index) => [type, recommendations[index].items])));
            } else if (!failed && seeds.every(ids => ids.length === 0)) {
                renderHomeRecommendations(root, {});
            } else {
                renderHomeRecommendationsMessage(root, failed
                    ? "Couldn't load recommendations. Try visiting Home again."
                    : 'No recommendations found for your recent library additions yet.');
            }
            if (!failed) recommendationsLoadedAt = Date.now();
        } catch (error) {
            if (!isCurrent()) return;
            console.error('Home recommendations failed:', error);
            renderHomeRecommendationsMessage(root, "Couldn't load recommendations. Try visiting Home again.");
        } finally {
            if (isCurrent()) root.setAttribute('aria-busy', 'false');
            if (recommendationsRequest === request) recommendationsRequest = null;
        }
    })();
    recommendationsRequest = request;
    return request;
}

window.addEventListener('auth-state-changed', () => {
    if (recommendationsUserId === (appState.currentUser?.id ?? null)) return;
    recommendationsUserId = null;
    recommendationsLoadedAt = 0;
    recommendationsRequest = null;
    recommendationsVersion++;
    const root = document.getElementById('home-recommendations');
    if (root) {
        renderHomeRecommendations(root, {});
        root.setAttribute('aria-busy', 'false');
    }
    if (!document.getElementById('home-page')?.classList.contains('hidden')) loadHomeRecommendations();
});

window.addEventListener('auth-state-changed', () => {
    if (progressUserId === (appState.currentUser?.id ?? null)) return;
    resumeVersion++;
    // Clear the previous account's cards even when Home is off screen.
    progressUserId = null;
    progressLoadedAt = 0;
    progressRequest = null;
    progressVersion++;
    progressItems = [];
    const root = document.getElementById('home-watch-progress');
    if (root) {
        renderVisibleWatchProgress();
        root.setAttribute('aria-busy', 'false');
    }
    if (!document.getElementById('home-page')?.classList.contains('hidden')) loadWatchProgress();
});

window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== HIDDEN_PROGRESS_PREFIX + appState.currentUser?.id) return;
    hiddenProgressUserId = null;
    renderVisibleWatchProgress();
});

window.addEventListener('watch-progress:saved', ({ detail }) => {
    if (detail.userId !== appState.currentUser?.id) return;
    if (detail.positionSeconds > 0
        && getHiddenProgress(detail.userId).delete(`${detail.mediaType}:${detail.tmdbId}`)) {
        saveHiddenProgress(detail.userId);
        renderVisibleWatchProgress();
    }
    progressLoadedAt = 0;
    progressVersion++;
    progressRequest = null;
    // Refresh after the player closes, without fetching home artwork during playback.
    const root = document.getElementById('home-watch-progress');
    if (root) root.setAttribute('aria-busy', 'false');
    if (!document.getElementById('home-page')?.classList.contains('hidden')
        && document.getElementById('player-wrapper')?.classList.contains('hidden')) loadWatchProgress();
});

function imageUrl(path, size) {
    return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

async function loadTrendingHome() {
    const root = document.getElementById('home-hero');
    if (!root || Date.now() - loadedAt < CACHE_MS) return;
    if (loadPromise) return loadPromise;

    root.setAttribute('aria-busy', 'true');
    renderHomeMessage(root, "Loading this week's picks...");
    loadPromise = (async () => {
        try {
            const data = await fetchTMDBEndpoint('trending/all/week');
            // Keep the first eight results in API order; people cannot open in the media detail view.
            const items = (data.results || []).slice(0, 8).filter(item =>
                item.id != null && (item.media_type === 'movie' || item.media_type === 'tv')
            );
            if (!items.length) {
                renderHomeMessage(root, 'No trending titles are available right now.', loadHome);
                return;
            }
            renderHomeCarousel(root, items);
            loadedAt = Date.now();
        } catch (error) {
            console.error('Home trending feed failed:', error);
            renderHomeMessage(root, "Couldn't load this week's picks. Please try again.", loadHome);
        } finally {
            root.setAttribute('aria-busy', 'false');
            loadPromise = null;
        }
    })();
    return loadPromise;
}

export async function loadHome() {
    await Promise.all([loadTrendingHome(), loadWatchProgress(), loadHomeRecommendations()]);
}
