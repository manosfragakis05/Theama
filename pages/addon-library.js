import { appState, smartFetch, showToast } from '../services/config.js';
import { supabase } from '../user-data/db.js';
import { fetchTMDBEndpoint } from '../user-addons/catalogs.js';
import { getAddonStreams } from '../user-addons/scrapers.js';
import { openPicker } from '../metadata/picker.js';
import { fetchAnimeMapping, updateActiveKitsuMapping } from '../api.js';
import { startQueueFromItem } from '../streaming/playlist.js';
import { getTorboxLink, requestLink } from '../streaming/player.js';
import { getStreamHash, getTorrentObjectFromHash } from '../utils/streams.js';

const metadataCache = new Map();
const normalizeHash = hash => typeof hash === 'string' ? hash.trim().toLowerCase() : '';

async function loadAddonMedia(media) {
    const userId = appState.currentUser?.id;
    media = {
        ...media,
        id: media.id ?? media.sourceMediaId,
        tmdb_id: media.tmdb_id ?? media.tmdbId,
        media_type: media.media_type ?? media.mediaType ?? media.type,
        base_url: media.base_url ?? media.baseUrl,
        poster_path: media.poster_path ?? media.poster
    };
    
    const cacheKey = `${userId}:${media.media_type}:${media.id}:${media.tmdb_id}`;
    if (metadataCache.has(cacheKey)) return metadataCache.get(cacheKey);

    const promise = (async () => {
        let record = media;
        
        const tmdbId = Number(media.tmdb_id);
        if (!tmdbId && !media.base_url) {
            const { data, error } = await supabase.from('global_media').select('*').eq('media_id', media.id).maybeSingle();
            if (error) throw error;
            if (data) record = { ...media, ...data };
        }

        const type = (record.media_type) === 'movie' ? 'movie' : 'series';
        const id = Number(record.tmdb_id);

        let details;
        if (Number.isSafeInteger(id) && id > 0) {
            details = await fetchTMDBEndpoint(`${type === 'movie' ? 'movie' : 'tv'}/${id}?append_to_response=external_ids`);
        } else {
            const baseUrl = record.base_url;
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
    const hashes = new Set([...(item.sourceHashes || []), item.hash].map(normalizeHash).filter(Boolean));
    if (!hashes.size) throw new Error('No source is linked to this saved item. Choose a source in Discover.');
    const context = await loadAddonMedia({
        id: item.sourceMediaId, tmdbId: item.tmdbId, mediaType: item.mediaType,
        title: item.seriesTitle || item.title, poster: item.thumbnail
    });
    if (userId !== appState.currentUser?.id) throw new Error('Your account changed. Open this title again.');
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
    const seen = new Set();
    let lookupError;
    let receivedStreams = false;
    for (const request of requests) {
        const key = `${request.id}:${request.episode}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let streams;
        try {
            streams = await getAddonStreams(context.type, request.id, selection.activeSeason, request.episode);
        } catch (error) {
            if (userId !== appState.currentUser?.id) throw new Error('Your account changed. Open this title again.');
            lookupError = error;
            continue;
        }
        if (userId !== appState.currentUser?.id) throw new Error('Your account changed. Open this title again.');
        receivedStreams = true;
        const stream = streams.find(stream => /^https?:\/\//i.test(stream.url || '')
            && hashes.has(getStreamHash(stream)));
        if (stream) return { url: stream.url, fileName: stream.behaviorHints?.filename || '', hash: getStreamHash(stream) };
    }
    if (!receivedStreams && lookupError) throw lookupError;
    throw new Error('Your add-ons are not returning this saved source for the selected episode. Choose another source in Discover.');
}

export function createAddonQueueItem(context, sources, seasonNumber = null, episodeNumber = null, episode = {}) {
    const hashes = [...new Set(sources.map(source => normalizeHash(source.hash)).filter(Boolean))];
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
    const url = await getTorboxLink(null, null, source.url);
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
    // Build cards only from files belonging to saved hashes, never a show's full episode catalog.
    const hashSources = new Map();
    sources.forEach(source => {
        const hash = normalizeHash(source.hash);
        if (hash && !hashSources.has(hash)) hashSources.set(hash, source);
    });
    if (!hashSources.size) throw new Error('No torrent files are linked to this title. Open its saved playback URL instead.');
    const results = await Promise.allSettled([...hashSources].map(async ([hash, source], index) => {
        const cached = appState.allTorrents.find(torrent => normalizeHash(torrent.hash) === hash && Array.isArray(torrent.files));
        const torrent = cached || await getTorrentObjectFromHash(hash);
        if (torrent.hash && normalizeHash(torrent.hash) !== hash) throw new Error('The returned torrent does not match the saved hash.');
        const files = (torrent.files || []).filter(file => typeof file?.name === 'string' && /\.(mkv|mp4|avi|mov)$/i.test(file.name));
        if (!files.length) throw new Error('No video files were found for this saved source.');
        return {
            ...torrent,
            id: `addon:${hash}`,
            hash,
            name: torrent.name || context.title,
            files: files.map(file => ({ ...file, id: file.id ?? file.name, short_name: file.short_name || file.name.split(/[\\/]/).at(-1) })),
            addonMedia: context,
            addonSources: [{ ...source, hash }],
            libraryAddedAt: source.addedAt || null,
            librarySourceOrder: hashSources.size - index
        };
    }));
    if (userId !== appState.currentUser?.id) return;
    const torrents = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    if (!torrents.length) throw results.find(result => result.status === 'rejected').reason;
    if (torrents.length < results.length) showToast('Some saved sources could not load their files. Open this title again to retry.', 'info');
    return openPicker(torrents, context.tmdbId, context.title);
}
