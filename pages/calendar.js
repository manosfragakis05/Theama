import { appState, TMDB_KEY } from '../services/config.js';
import { fetchAppLibraryData } from './app-library.js';
import { fetchTMDBEndpoint } from '../user-addons/catalogs.js';
import { openMasterDetail } from '../api.js';
import { initializeCalendarView, renderCalendar, localDateKey } from './calendar-renderer.js';

const CACHE_MS = 60 * 60 * 1000;
const metadataCache = new Map();
let selectedMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let initializedRoot = null;
let loadVersion = 0;
let calendarUserId = null;

function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function getCalendarWindow(month) {
    return {
        start: localDateKey(new Date(month.getFullYear(), month.getMonth(), 1)),
        end: localDateKey(new Date(month.getFullYear(), month.getMonth() + 1, 0))
    };
}

function inWindow(date, window) {
    return validDate(date) && date >= window.start && date <= window.end;
}

function fetchCalendarMetadata(endpoint) {
    const cached = metadataCache.get(endpoint);
    if (cached && Date.now() - cached.loadedAt < CACHE_MS) return cached.promise;
    const entry = { loadedAt: Date.now(), promise: null };
    entry.promise = fetchTMDBEndpoint(endpoint).catch(error => {
        if (metadataCache.get(endpoint) === entry) metadataCache.delete(endpoint);
        throw error;
    });
    metadataCache.set(endpoint, entry);
    if (metadataCache.size > 500) metadataCache.delete(metadataCache.keys().next().value);
    return entry.promise;
}

export function getCalendarSeasons(details, window) {
    const seasons = (details.seasons || []).filter(season => Number.isInteger(season.season_number) && season.season_number >= 0);
    return seasons.filter(season => {
        if (!validDate(season.air_date)) return true; // Episodes may have dates even when their season doesn't.
        if (season.air_date > window.end) return false;
        if (season.season_number === 0) return true;
        // Skip older seasons whose following season already started before this month.
        return !seasons.some(next => next.season_number > season.season_number
            && validDate(next.air_date) && next.air_date <= window.start);
    }).sort((a, b) => a.season_number - b.season_number);
}

// Keep scheduling separate from rendering so a failed season can retain known dates.
export async function fetchCalendarReleases(media, window, fetchMetadata = fetchCalendarMetadata, isCurrent = () => true) {
    const type = media.media_type === 'series' ? 'tv' : media.media_type;
    const tmdbId = Number(media.tmdb_id);
    if (!['tv', 'movie'].includes(type) || !Number.isSafeInteger(tmdbId) || tmdbId <= 0) {
        return { releases: [], failedSeasons: 0 };
    }
    const details = await fetchMetadata(`${type}/${tmdbId}`);
    if (!isCurrent()) return { releases: [], failedSeasons: 0 };
    const base = {
        tmdbId, type,
        title: details.name || details.title || media.title || 'Untitled',
        poster: details.poster_path || media.poster_path || null,
        year: (details.first_air_date || details.release_date || '').slice(0, 4)
    };
    if (type === 'movie') {
        return { releases: inWindow(details.release_date, window)
            ? [{ ...base, id: `movie:${tmdbId}`, kind: 'movie', date: details.release_date }]
            : [], failedSeasons: 0 };
    }

    const releases = new Map();
    const addEpisode = (episode, fallbackSeason) => {
        const season = episode.season_number ?? fallbackSeason;
        const number = episode.episode_number;
        if (!inWindow(episode.air_date, window) || !Number.isInteger(season) || season < 0
            || !Number.isInteger(number) || number < 1) return;
        const id = `tv:${tmdbId}:${season}:${number}`;
        releases.set(id, { ...base, id, kind: 'episode', date: episode.air_date, season, episode: number, name: episode.name || '' });
    };
    // This stays useful even if the full season request fails.
    if (details.next_episode_to_air) addEpisode(details.next_episode_to_air);
    let failedSeasons = 0;
    for (const season of getCalendarSeasons(details, window)) {
        if (!isCurrent()) break;
        try {
            const data = await fetchMetadata(`tv/${tmdbId}/season/${season.season_number}`);
            if (!isCurrent()) break;
            for (const episode of data.episodes || []) addEpisode(episode, season.season_number);
        } catch {
            failedSeasons++;
        }
        // An announced premiere can exist before individual episodes are entered.
        if (inWindow(season.air_date, window)
            && !releases.has(`tv:${tmdbId}:${season.season_number}:1`)) {
            const id = `tv:${tmdbId}:season:${season.season_number}`;
            releases.set(id, { ...base, id, kind: 'season', date: season.air_date, season: season.season_number });
        }
    }
    return { releases: [...releases.values()], failedSeasons };
}

function openCalendarMedia(release) {
    const poster = release.poster?.startsWith('/')
        ? `https://image.tmdb.org/t/p/w500${release.poster}` : release.poster;
    openMasterDetail({
        id: release.tmdbId, tmdbId: release.tmdbId,
        type: release.type === 'tv' ? 'series' : 'movie',
        title: release.title, poster, year: release.year,
        addonName: 'customTMDB',
        ...(release.kind !== 'movie' ? { activeSeason: release.season } : {})
    });
}

function getRoot() {
    const root = document.getElementById('calendar-root');
    if (root && initializedRoot !== root) {
        initializedRoot = root;
        initializeCalendarView(root, {
            onMonthChange: delta => {
                selectedMonth = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() + delta, 1);
                return loadCalendar();
            },
            onToday: () => {
                const today = new Date();
                selectedMonth = new Date(today.getFullYear(), today.getMonth(), 1);
                return loadCalendar();
            },
            onRefresh: () => loadCalendar({ refresh: true })
        });
    }
    return root;
}

export async function loadCalendar({ refresh = false } = {}) {
    const root = getRoot();
    if (!root) return;
    const version = ++loadVersion;
    const userId = appState.currentUser?.id ?? null;
    calendarUserId = userId;
    const month = new Date(selectedMonth);
    const isCurrent = () => version === loadVersion && userId === (appState.currentUser?.id ?? null);
    const render = state => {
        if (isCurrent()) renderCalendar(root, { month, onOpen: openCalendarMedia, ...state });
    };
    if (!userId) {
        render({ message: 'Sign in to see release dates from your app library.' });
        return;
    }
    if (!TMDB_KEY) {
        render({ message: 'Release dates are unavailable because TMDB is not configured.' });
        return;
    }
    if (refresh) metadataCache.clear();
    render({ loading: true, message: 'Checking your app library for release dates…' });
    try {
        const library = await fetchAppLibraryData();
        if (!isCurrent()) return;
        const mapped = new Map();
        let missing = 0;
        for (const media of library) {
            const id = Number(media.tmdb_id);
            const type = media.media_type === 'series' ? 'tv' : media.media_type;
            if (Number.isSafeInteger(id) && id > 0 && ['movie', 'tv'].includes(type)) mapped.set(`${type}:${id}`, media);
            else missing++;
        }
        const items = [...mapped.values()];
        const window = getCalendarWindow(month);
        const releases = [];
        let cursor = 0;
        let failures = 0;
        // Four workers limit TMDB traffic, including each show's season requests.
        await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
            while (cursor < items.length && isCurrent()) {
                const media = items[cursor++];
                try {
                    const result = await fetchCalendarReleases(media, window, fetchCalendarMetadata, isCurrent);
                    releases.push(...result.releases);
                    if (result.failedSeasons) failures++;
                } catch {
                    failures++;
                }
            }
        }));
        if (!isCurrent()) return;
        releases.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title)
            || (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0));
        const notes = [];
        if (!library.length) notes.push('Add titles to your app library to start tracking their release dates.');
        else if (!releases.length && failures === items.length && items.length) notes.push('Could not load release dates. Use Refresh dates to try again.');
        else if (!releases.length) notes.push('No announced drops this month. Try another month or refresh later.');
        if (missing) notes.push(`${missing} ${missing === 1 ? 'title has' : 'titles have'} no supported TMDB mapping yet.`);
        if (failures) notes.push(`Some dates could not be checked for ${failures} ${failures === 1 ? 'title' : 'titles'}. Refresh to retry.`);
        render({ releases, message: notes.join(' ') });
    } catch (error) {
        if (!isCurrent()) return;
        console.error('Calendar library load failed:', error);
        render({ message: 'Could not load your app library. Use Refresh dates to try again.' });
    }
}

window.addEventListener('auth-state-changed', () => {
    if (calendarUserId === (appState.currentUser?.id ?? null)) return;
    calendarUserId = appState.currentUser?.id ?? null;
    ++loadVersion;
    const root = initializedRoot;
    if (root) renderCalendar(root, { month: selectedMonth, releases: [], message: calendarUserId
        ? 'Open Calendar to load your library’s release dates.' : 'Sign in to see release dates from your app library.' });
    if (!document.getElementById('calendar-page')?.classList.contains('hidden')) loadCalendar();
});

window.addEventListener('app-library:updated', ({ detail }) => {
    if (detail?.userId === appState.currentUser?.id
        && !document.getElementById('calendar-page')?.classList.contains('hidden')) loadCalendar();
});
