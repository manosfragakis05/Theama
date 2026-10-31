import { appState, smartFetch } from '../services/config.js';
import { supabase } from '../user-data/db.js';
import { fetchTMDBEndpoint } from '../user-addons/catalogs.js';
import { getAddonStreams } from '../user-addons/scrapers.js';
import { getTmdbSeasonEpisodes } from '../metadata/metadata.js';
import { openAddonPicker } from '../metadata/picker.js';
import { fetchAnimeMapping, updateActiveKitsuMapping } from '../api.js';
import { startQueueFromItem } from '../streaming/playlist.js';
import { getTorboxLink, requestLink } from '../streaming/player.js';
import { getStreamHash } from '../utils/streams.js';

const metadataCache = new Map();

async function loadAddonMedia(media) {
    const userId = appState.currentUser?.id;
    const cacheKey = `${userId}:${media.media_type || media.mediaType}:${media.id}:${media.tmdb_id || media.tmdbId}`;
    if (metadataCache.has(cacheKey)) return metadataCache.get(cacheKey);
    const promise = (async () => {
        let record = media;
        const tmdbId = Number(media.tmdb_id || media.tmdbId);
        if (!tmdbId && !media.base_url && !media.baseUrl) {
            const { data, error } = await supabase.from('global_media').select('*').eq('media_id', media.id).maybeSingle();
            if (error) throw error;
            if (data) record = { ...media, ...data };
        }
        const type = (record.media_type || record.mediaType || record.type) === 'movie' ? 'movie' : 'series';
        const id = Number(record.tmdb_id || record.tmdbId);
        let details;
        if (Number.isSafeInteger(id) && id > 0) {
            details = await fetchTMDBEndpoint(`${type === 'movie' ? 'movie' : 'tv'}/${id}?append_to_response=external_ids`);
        } else {
            const baseUrl = record.base_url || record.baseUrl;
            if (!baseUrl) throw new Error('This saved title has no metadata source.');
            const response = await smartFetch(`${baseUrl}/meta/${type}/${record.id}.json`);
            if (!response.ok) throw new Error('Could not load this title from its add-on.');
            details = (await response.json()).meta;
        }
        if (!details) throw new Error('Could not load this saved title.');
        let animeMappings;
        if (type === 'series' && details.original_language === 'ja'
            && details.genres?.some(genre => genre.id === 16)) {
            const mapping = await fetchAnimeMapping(id);
            animeMappings = (mapping?.data?.matches || mapping?.matches || []).map(match => ({
                kitsuId: match.kitsu_id, season: match.season?.tmdb ?? 1,
                episodeOffset: match.episode_offset?.tmdb ?? 0
            }));
        }
        return {
            id: record.id, tmdbId: Number.isSafeInteger(id) && id > 0 ? id : null,
            title: record.title || details.title || details.name,
            type, poster: record.poster_path || record.poster || '',
            year: (details.release_date || details.first_air_date || '').slice(0, 4),
            baseUrl: record.base_url || record.baseUrl || null,
            streamId: details.external_ids?.imdb_id || details.imdb_id || details.imdbId || details.id || record.id,
            details, animeMappings
        };
    })();
    metadataCache.set(cacheKey, promise);
    try { return await promise; }
    catch (error) { metadataCache.delete(cacheKey); throw error; }
}

export async function resolveAddonQueueSource(item) {
    const userId = appState.currentUser?.id;
    if (!userId) throw new Error('Sign in to play your saved library.');
    const context = await loadAddonMedia({
        id: item.sourceMediaId, tmdbId: item.tmdbId, mediaType: item.mediaType,
        title: item.seriesTitle || item.title, poster: item.thumbnail
    });
    const selection = {
        ...context, activeSeason: item.seasonNumber ?? 1,
        activeEpisode: item.watchEpisodeNumber ?? item.episodeNumber ?? 1
    };
    if (context.animeMappings?.length) updateActiveKitsuMapping(selection);
    const requests = [
        selection.currentKitsuId && { id: selection.currentKitsuId, episode: selection.kitsuEpisode },
        { id: item.streamId || context.streamId, episode: selection.activeEpisode },
        context.tmdbId && { id: `tmdb:${context.tmdbId}`, episode: selection.activeEpisode }
    ].filter(Boolean);
    const hashes = new Set([...(item.sourceHashes || []), item.hash].filter(Boolean).map(hash => hash.toLowerCase()));
    const seen = new Set();
    for (const request of requests) {
        const key = `${request.id}:${request.episode}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const streams = await getAddonStreams(context.type, request.id, selection.activeSeason, request.episode);
        if (userId !== appState.currentUser?.id) throw new Error('Your account changed. Open this title again.');
        const stream = streams.find(stream => /^https?:\/\//i.test(stream.url || '')
            && (!hashes.size || hashes.has(getStreamHash(stream))));
        if (stream) return { url: stream.url, fileName: stream.behaviorHints?.filename || '', hash: getStreamHash(stream) };
    }
    throw new Error('Your add-ons are not returning this saved source for the selected episode. Choose another source in Discover.');
}

export function createAddonQueueItem(context, sources, seasonNumber = null, episodeNumber = null, episode = {}) {
    const hashes = sources.map(source => source.hash).filter(Boolean);
    return {
        sourceType: 'addon', sourceMediaId: String(context.id), streamId: episode.streamId || String(context.streamId),
        sourceHashes: hashes, hash: hashes[0] || '',
        tid: `addon:${context.id}`, fid: `addon:${seasonNumber}:${episodeNumber}`,
        tmdbId: context.tmdbId, mediaType: context.type === 'movie' ? 'movie' : 'tv',
        seasonNumber, episodeNumber, watchEpisodeNumber: episodeNumber,
        seriesTitle: context.type === 'movie' ? '' : context.title,
        title: episode.title || context.title, torrentName: context.title,
        fileName: episode.title || context.title,
        thumbnail: episode.thumbnail || context.poster
    };
}

export async function downloadAddonQueueItem(item) {
    const source = await resolveAddonQueueSource(item);
    const url = await getTorboxLink(null, null, undefined, source.url);
    if (!url) return;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = item.fileName || item.title;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
}

export async function openAddonLibraryMedia(media, { download = false, resume = null } = {}) {
    const userId = appState.currentUser?.id;
    if (!userId) throw new Error('Sign in to view your library.');
    const context = await loadAddonMedia(media);
    if (userId !== appState.currentUser?.id) return;
    const sources = media.sources || [];
    if (context.type === 'movie' || resume) {
        const item = createAddonQueueItem(context, sources, resume?.season, resume?.episode);
        if (download) return downloadAddonQueueItem(item);
        const current = startQueueFromItem(item);
        return requestLink(current.tid, current.fid, current.torrentName, current.fileName, current.uid, resume?.positionSeconds || 0);
    }
    const seasons = context.tmdbId
        ? await Promise.all((context.details.seasons || []).filter(season => season.season_number > 0).map(async season => ({
            seasonNumber: season.season_number, name: season.name,
            episodes: (await getTmdbSeasonEpisodes(context.tmdbId, season.season_number)).map(episode => ({
                episodeNumber: episode.episode_number, title: episode.name,
                thumbnail: episode.still_path ? `https://image.tmdb.org/t/p/w500${episode.still_path}` : context.poster
            }))
        })))
        : [...new Set((context.details.videos || []).map(video => Number(video.season) || 1))].map(season => ({
            seasonNumber: season, name: `Season ${season}`,
            episodes: (context.details.videos || []).filter(video => (Number(video.season) || 1) === season).map((video, index) => ({
                episodeNumber: Number(video.episode) || index + 1, title: video.title || video.name,
                thumbnail: video.thumbnail, streamId: video.id
            }))
        }));
    if (userId !== appState.currentUser?.id) return;
    const availableSeasons = seasons.filter(season => season.episodes.length)
        .sort((a, b) => a.seasonNumber - b.seasonNumber);
    if (!availableSeasons.length) throw new Error('No episodes are available for this saved title.');
    return openAddonPicker(context, sources, availableSeasons);
}
