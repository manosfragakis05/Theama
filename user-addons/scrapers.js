import { streamState, renderAddonData, filterAndSortStreams } from './scraper-renderer.js';
import { getAllAddons } from './user-addons.js';
import { smartFetch } from '../services/config.js';

//#region Fetch Streams
export function getScrapingProviders() {
    const userAddons = getAllAddons();

    return userAddons.filter(addon => addon.capabilities && addon.capabilities.streams === true);
}

export async function loadAllAddonsParallel(type, streamId, season = null, episode = null) {
    const userAddons = getScrapingProviders();
    const pathId = getStreamPathId(type, streamId, season, episode);

    await Promise.all(userAddons.map(async addon => {
        const streams = await fetchSingleAddon(addon, type, pathId);
        const shortName = addon.name.split(' ')[0];
        const packedData = filterAndSortStreams(streams || [], shortName);
        streamState.addons[shortName] = packedData;
        renderAddonData(packedData);
    }));
}

// Library playback fetches fresh sources without opening the stream selection UI.
export async function getAddonStreams(type, streamId, season = null, episode = null) {
    const addons = getScrapingProviders();
    if (!addons.length) throw new Error('Install a streaming add-on in Settings to play this title.');
    const pathId = getStreamPathId(type, streamId, season, episode);
    const results = await Promise.all(addons.map(addon => fetchSingleAddon(addon, type, pathId)));
    return results.flatMap(streams => streams || []);
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

    try {
        const streamUrl = addon.url.replace('/manifest.json', `/stream/${type}/${pathId}.json`);
        const res = await smartFetch(streamUrl);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        return data.streams || []; // Return the array of streams

    } catch (e) {
        console.warn(`🔴 [${addon.name}] Failed:`, e.message);
        return null;
    }
}
//#endregion
