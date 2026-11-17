import { filterAndSortStreams } from './scraper-renderer.js';
import { getAllAddons } from './user-addons.js';
import { smartFetch } from '../services/config.js';
import { getStreamHash } from '../utils/streams.js';

//#region Fetch Streams
export function getScrapingProviders() {
    const userAddons = getAllAddons();

    return userAddons.filter(addon => addon.capabilities && addon.capabilities.streams === true);
}

// Notify the caller as each add-on finishes; the final result keeps provider order.
export async function loadAllAddonsParallel(type, streamId, season = null, episode = null, onAddonLoaded = null) {
    const userAddons = getScrapingProviders();
    const pathId = getStreamPathId(type, streamId, season, episode);

    return Promise.all(userAddons.map(async addon => {
        const shortName = addon.name.split(' ')[0];
        let packedData;
        try {
            const streams = await fetchSingleAddon(addon, type, pathId);
            packedData = filterAndSortStreams(streams, shortName);
        } catch (error) {
            packedData = { addonName: shortName, bucket4K: [], bucket1080p: [], bucketOther: [], error: error.message };
        }
        onAddonLoaded?.(packedData);

        return packedData;
    }));
}

// Library playback fetches fresh sources without opening the stream selection UI.
export async function getAddonStreams(type, streamId, season = null, episode = null) {
    const addons = getScrapingProviders();
    if (!addons.length) throw new Error('Install a streaming add-on in Settings to play this title.');
    const pathId = getStreamPathId(type, streamId, season, episode);
    const results = await Promise.allSettled(addons.map(addon => fetchSingleAddon(addon, type, pathId)));
    const streams = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    const failure = results.find(result => result.status === 'rejected');
    if (!streams.length && failure) throw failure.reason;
    return streams;
}

export function getStreamPathId(type, streamId, season = null, episode = null) {
    // Format the ID once for everyone
    const safeId = String(streamId);
    let pathId = safeId;

    if (type === "series" || type === "tv" || type === "anime") {

        if (safeId.startsWith("tt")) {
            if (!safeId.includes(":")) {
                pathId = `${safeId}:${season}:${episode}`;
            }
        }
        else if (safeId.startsWith("kitsu")) {
            if (safeId.split(':').length === 2) {
                pathId = `${safeId}:${episode}`;
            }
        }
        else {
            if (!safeId.includes(":") || /^tmdb:\d+$/.test(safeId)) {
                const baseTmdb = safeId.startsWith("tmdb:") ? safeId : `tmdb:${safeId}`;
                pathId = `${baseTmdb}:${season}:${episode}`;
            }
        }
    }
    else if (type === "movie") {
        if (!safeId.startsWith("tt") && !safeId.startsWith("kitsu") && !safeId.startsWith("tmdb:")) {
            pathId = `tmdb:${safeId}`;
        } else {
            pathId = safeId;
        }
    }

    return pathId;
}

async function fetchSingleAddon(addon, type, pathId) {
    console.log(`Fetching ${addon.name}...`, pathId);

    const streamUrl = addon.url.replace('/manifest.json', `/stream/${type}/${pathId}.json`);
    try {
        return await readAddonStreams(await fetch(streamUrl, {
            credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30000)
        }), addon.name);
    } catch {
        // Do not log configured URLs: their paths can contain provider API keys.
    }
    try {
        return await readAddonStreams(await smartFetch(streamUrl, { signal: AbortSignal.timeout(35000) }), addon.name);
    } catch (error) {
        console.warn(`[${addon.name}] Stream request failed:`, error.message);
        throw error;
    }
}

async function readAddonStreams(response, addonName) {
    if (!response.ok) {
        const reason = response.status === 429 ? 'Add-on rate limit reached. Try again shortly.'
            : response.status === 403 ? 'The add-on rejected the request.'
            : response.status === 504 ? 'The add-on request timed out.'
            : 'Could not fetch streams from the add-on.';
        throw new Error(`${reason} (HTTP ${response.status})`);
    }
    let data;
    try {
        data = await response.json();
    } catch {
        throw new Error('The add-on returned an invalid response.');
    }
    if (!Array.isArray(data?.streams)) throw new Error('The add-on did not return a streams list.');

    //data.streams.forEach(stream => {
    //    const hash = getStreamHash(stream);
    //    console.log(`[${addonName}]`, hash);
    //});
    return data.streams;
}
//#endregion
