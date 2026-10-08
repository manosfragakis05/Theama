import { streamState, renderAddonData, filterAndSortStreams } from './scraper-renderer.js';
import { getAllAddons } from './user-addons.js';

//#region Fetch Streams
export function getScrapingProviders() {
    const userAddons = getAllAddons();

    return userAddons.filter(addon => addon.capabilities && addon.capabilities.streams === true);
}

export async function loadAllAddonsParallel(type, streamId, season = null, episode = null) {
    const userAddons = getScrapingProviders();

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
            if (!safeId.includes(":")) {
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

    // Fire all addons in parallel
    // Fire all addons in parallel
    userAddons.forEach(addon => {
        fetchSingleAddon(addon, type, pathId)
            .then(streams => {
                const shortName = addon.name.split(' ')[0];

                if (streams === null || streams.length === 0) {
                    console.log(`${shortName} is offline or found 0 streams.`);

                    // Manually trigger the empty state in the renderer
                    renderAddonData({
                        addonName: shortName,
                        bucket4K: [],
                        bucket1080p: [],
                        bucketOther: []
                    });
                }
                else {
                    // 1. Filter and pack the data
                    const packedData = filterAndSortStreams(streams, shortName);

                    // 2. Cache it
                    streamState.addons[shortName] = packedData;

                    // 3. Draw it to the screen
                    renderAddonData(packedData);
                }
            });
    });
}

async function fetchSingleAddon(addon, type, pathId) {
    console.log(`Fetching ${addon.name}...`, pathId);

    try {
        const streamUrl = addon.url.replace('/manifest.json', `/stream/${type}/${pathId}.json`);
        const res = await fetch(streamUrl);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        return data.streams || []; // Return the array of streams

    } catch (e) {
        console.warn(`🔴 [${addon.name}] Failed:`, e.message);
        return null;
    }
}
//#endregion