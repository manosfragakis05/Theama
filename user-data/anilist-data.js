import { requestAniList } from '../services/anilist-auth.js';

const LIST_QUERY = `query TheamaAniListWatchlists($userId: Int!, $chunk: Int!) {
    MediaListCollection(userId: $userId, type: ANIME, chunk: $chunk, perChunk: 100) {
        hasNextChunk
        lists {
            name status isCustomList
            entries {
                media {
                    id format
                    title { userPreferred english romaji native }
                    coverImage { large }
                    startDate { year }
                }
            }
        }
    }
}`;
const CACHE_MS = 5 * 60 * 1000;
let cachedOwner = null;
const pages = new Map();

export function clearAniListWatchlistCache() {
    cachedOwner = null;
    pages.clear();
}

export function normalizeAniListGroups(lists) {
    return (Array.isArray(lists) ? lists : []).map(list => {
        const name = typeof list?.name === 'string' ? list.name : list?.status || 'Anime';
        const seen = new Set();
        const items = [];
        for (const entry of list?.entries || []) {
            const media = entry?.media;
            if (!Number.isSafeInteger(media?.id) || media.id <= 0 || seen.has(media.id)) continue;
            seen.add(media.id);
            const poster = media.coverImage?.large;
            items.push({
                anilistId: media.id,
                title: media.title?.userPreferred || media.title?.english || media.title?.romaji || media.title?.native || 'Untitled anime',
                poster: typeof poster === 'string' && poster.startsWith('https://') ? poster : '',
                year: media.startDate?.year || null,
                format: media.format || ''
            });
        }
        return { key: JSON.stringify([Boolean(list?.isCustomList), list?.status || '', name]), name, items };
    });
}

export function mergeAniListGroups(previous, incoming) {
    const merged = new Map(previous.map(group => [group.key, { ...group, items: [...group.items] }]));
    for (const group of incoming) {
        const existing = merged.get(group.key);
        if (!existing) {
            merged.set(group.key, { ...group, items: [...group.items] });
            continue;
        }
        const ids = new Set(existing.items.map(item => item.anilistId));
        for (const item of group.items) {
            if (!ids.has(item.anilistId)) existing.items.push(item);
            ids.add(item.anilistId);
        }
    }
    return [...merged.values()];
}

export async function fetchAniListWatchlists(connection, { chunk = 1, force = false, signal, fetcher = fetch } = {}) {
    if (!connection?.accessToken || !Number.isSafeInteger(connection.viewer?.id)) {
        throw new Error('Connect your AniList account in Settings to see your lists.');
    }
    if (!Number.isSafeInteger(chunk) || chunk < 1) throw new Error('Invalid AniList list page.');
    const owner = `${connection.viewer.id}:${connection.accessToken}`;
    if (owner !== cachedOwner) {
        clearAniListWatchlistCache();
        cachedOwner = owner;
    }
    const cached = pages.get(chunk);
    if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.data;
    const data = await requestAniList(connection.accessToken, LIST_QUERY, { userId: connection.viewer.id, chunk }, { signal, fetcher });
    const collection = data.MediaListCollection;
    if (!Array.isArray(collection?.lists)) throw new Error('AniList did not return your anime lists. Please try again.');
    const result = { groups: normalizeAniListGroups(collection.lists), hasMore: collection.hasNextChunk === true };
    if (cachedOwner === owner && !signal?.aborted) pages.set(chunk, { at: Date.now(), data: result });
    return result;
}

// Never pass an AniList ID to a TMDB endpoint. Resolve the existing mapping
// before building the same media payload used by the other profile cards.
export function createAniListDetail(media, matches) {
    const candidates = new Map();
    for (const match of matches || []) {
        if (![].concat(match.anilist_id ?? []).map(Number).includes(media.anilistId)) continue;
        const ids = match.themoviedb_id || {};
        for (const id of [].concat(ids.movie ?? []).map(Number)) {
            if (Number.isSafeInteger(id) && id > 0) candidates.set(`movie:${id}`, { id, type: 'movie' });
        }
        const id = Number(ids.tv);
        if (Number.isSafeInteger(id) && id > 0) {
            const season = match.season?.tmdb;
            const offset = match.episode_offset?.tmdb;
            const activeSeason = Number.isInteger(season) && season >= 0 ? season : 1;
            const activeEpisode = Number.isInteger(offset) ? Math.max(1, offset + 1) : 1;
            candidates.set(`series:${id}:${activeSeason}:${activeEpisode}`, { id, type: 'series', activeSeason, activeEpisode });
        }
    }
    const all = [...candidates.values()];
    const preferred = all.filter(item => item.type === (media.format === 'MOVIE' ? 'movie' : 'series'));
    const choices = preferred.length ? preferred : all;
    if (choices.length !== 1) {
        throw new Error(choices.length ? 'This anime has multiple detail matches. Open it through Discover to choose the right one.'
            : 'This anime does not have a matching Theama detail page yet.');
    }
    const match = choices[0];
    return {
        ...match, tmdbId: match.id, anilistId: media.anilistId,
        title: media.title, poster: media.poster, year: media.year,
        baseUrl: null, addonName: 'customTMDB'
    };
}

export async function fetchAniListDetail(media, { fetcher = fetch, signal } = {}) {
    const response = await fetcher(`/map?anilist_id=${encodeURIComponent(media.anilistId)}`, { signal });
    if (response.status === 404) return createAniListDetail(media, []);
    if (!response.ok) throw new Error('Could not match this anime right now. Please try again.');
    const data = await response.json();
    return createAniListDetail(media, data.matches);
}
