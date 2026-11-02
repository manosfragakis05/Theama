import { requestAniList } from '../services/anilist-auth.js';
import { normalizeAniListGroups } from './anilist-data.js';

const STATS_QUERY = `query TheamaAniListStats($userId: Int!) {
    User(id: $userId) {
        id name
        statistics { anime { count episodesWatched minutesWatched } }
    }
    mostRewatched: Page(page: 1, perPage: 3) {
        mediaList(userId: $userId, type: ANIME, sort: [REPEAT_DESC, SCORE_DESC, MEDIA_ID]) { ...TheamaStatEntry }
    }
    mostWatched: Page(page: 1, perPage: 3) {
        mediaList(userId: $userId, type: ANIME, sort: [PROGRESS_DESC, SCORE_DESC, MEDIA_ID]) { ...TheamaStatEntry }
    }
    highestRated: Page(page: 1, perPage: 3) {
        mediaList(userId: $userId, type: ANIME, sort: [SCORE_DESC, PROGRESS_DESC, MEDIA_ID]) { ...TheamaStatEntry }
    }
}
fragment TheamaStatEntry on MediaList {
    private repeat progress score(format: POINT_100)
    media {
        id format
        title { userPreferred english romaji native }
        coverImage { large }
        startDate { year }
    }
}`;

let privateSnapshot = null;
export function clearAniListStatsCache() { privateSnapshot = null; }

function total(value) { return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null; }

export function normalizeAniListStats(data, { publicOnly = false } = {}) {
    const anime = data.User?.statistics?.anime;
    function ranked(field, metric) {
        const seen = new Set();
        return (data[field]?.mediaList || []).flatMap(entry => {
            if (publicOnly && entry?.private === true) return [];
            const value = entry?.[metric];
            if (!Number.isFinite(value) || value <= 0) return [];
            const item = normalizeAniListGroups([{ isCustomList: true, entries: [entry] }])[0].items[0];
            if (!item || seen.has(item.anilistId)) return [];
            seen.add(item.anilistId);
            return [{ ...item, value }];
        }).sort((a, b) => b.value - a.value || a.anilistId - b.anilistId).slice(0, 3);
    }
    return {
        username: typeof data.User?.name === 'string' ? data.User.name : '',
        totals: { anime: total(anime?.count), episodes: total(anime?.episodesWatched), minutes: total(anime?.minutesWatched) },
        mostRewatched: ranked('mostRewatched', 'repeat'),
        mostWatched: ranked('mostWatched', 'progress'),
        highestRated: ranked('highestRated', 'score')
    };
}

async function fetchStats(userId, accessToken, { force = false, signal, fetcher = fetch } = {}) {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Invalid AniList account.');
    const key = accessToken ? `${userId}:${accessToken}` : null;
    if (key && !force && privateSnapshot?.key === key && Date.now() - privateSnapshot.at < 5 * 60 * 1000) {
        return privateSnapshot.data;
    }
    const data = await requestAniList(accessToken, STATS_QUERY, { userId }, { signal, fetcher });
    if (data.User?.id !== userId) throw new Error('This AniList account\'s statistics are unavailable.');
    const result = normalizeAniListStats(data, { publicOnly: !accessToken });
    if (key && !signal?.aborted) privateSnapshot = { key, at: Date.now(), data: result };
    return result;
}

export function fetchAniListStats(connection, options) {
    if (!connection?.accessToken) throw new Error('Connect your AniList account to see your stats.');
    return fetchStats(connection.viewer?.id, connection.accessToken, options);
}

// No token parameter and no shared cache with the owner's statistics.
export function fetchPublicAniListStats(userId, options) { return fetchStats(userId, null, options); }

export function formatAniListTime(minutes) {
    if (!Number.isFinite(minutes) || minutes < 0) return '—';
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes % 1440 / 60);
    if (days) return `${days.toLocaleString()}d ${hours}h`;
    if (hours) return `${hours}h ${Math.floor(minutes % 60)}m`;
    return `${Math.floor(minutes)}m`;
}
