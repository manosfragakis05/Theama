import { getTbKey, smartFetch, showToast } from '../services/config.js';
import { streamState, renderInstalledAddons, renderAddonData, filterAndSortStreams } from './scraper-renderer.js';

//#region Addon Options

// Add new Addon
export async function submitNewAddon() {
    const inputField = document.getElementById('addon-url-input');
    const submitBtn = document.getElementById('addon-submit-btn') || inputField.nextElementSibling;
    const rawUrl = inputField.value.trim();

    if (!rawUrl) return;

    // UI Feedback: Show loading state
    const originalText = submitBtn.innerText;
    submitBtn.innerText = "Verifying...";
    submitBtn.disabled = true;

    // Call our new detector
    const result = await detectAndValidateAddon(rawUrl);

    submitBtn.innerText = originalText;
    submitBtn.disabled = false;

    if (result.success) {
        const manifest = result.manifest;
        let userAddons = JSON.parse(localStorage.getItem('user_addons')) || [];

        // 1. Build the complete add-on object
        const addonData = {
            id: manifest.id,
            name: manifest.name,
            url: result.url,
            version: manifest.version || '1.0.0',
            logo: manifest.logo || null,
            description: manifest.description || null,
            configurable: manifest.behaviorHints?.configurable || false,
            types: manifest.types || [],
            idPrefixes: manifest.idPrefixes || [],
            capabilities: result.capabilities
        };

        // 2. Prevent duplicates, but allow configuration updates (Upsert)
        const existingIndex = userAddons.findIndex(a => a.id === manifest.id);

        if (existingIndex !== -1) {
            // Overwrite existing (User updated their settings/URL)
            userAddons[existingIndex] = addonData;
            showToast(`${manifest.name} configuration updated.`, "success");
        } else {
            // Save brand new add-on
            userAddons.push(addonData);
            showToast(`Success! ${manifest.name} was added.`, "success");
        }

        // Save to storage and refresh UI
        localStorage.setItem('user_addons', JSON.stringify(userAddons));
        renderInstalledAddons();

        inputField.value = '';
    } else {
        showToast(`Error: ${result.error}`, "error");
    }
}

async function detectAndValidateAddon(rawUrl) {
    let url = rawUrl.trim();

    if (!url.endsWith('manifest.json')) {
        url = url.endsWith('/') ? `${url}manifest.json` : `${url}/manifest.json`;
    }

    // Replace stremio:// protocol with https:// if the user copied a deep link
    url = url.replace('stremio://', 'https://');

    try {
        // Fetch the Manifest (With CORS Fallback)
        let response;
        try {
            response = await fetch(url);
        } catch (e) {
            console.warn("Direct fetch blocked by CORS. Using proxy...");
            // Ensure MY_PROXY is defined or imported in this file
            const proxyUrl = MY_PROXY.replace('/?url=', '');
            response = await fetch(`${proxyUrl}/?url=${encodeURIComponent(url)}`);
        }

        if (!response.ok) {
            throw new Error(`Server returned status: ${response.status}`);
        }

        const manifest = await response.json();

        // Schema Validation: Is it actually a Stremio Add-on?
        if (!manifest.id || !manifest.name || !manifest.resources || !Array.isArray(manifest.resources)) {
            throw new Error("Invalid format. This is not a recognized Stremio add-on.");
        }

        // Detect capabilities
        const providesStreams = manifest.resources.some(r => r === 'stream' || r.name === 'stream');
        const providesCatalogs = manifest.resources.some(r => r === 'catalog' || r.name === 'catalog');
        const providesMeta = manifest.resources.some(r => r === 'meta' || r.name === 'meta');

        // Optional: Reject if it doesn't provide anything useful to your specific app
        if (!providesStreams && !providesCatalogs && !providesMeta) {
            throw new Error(`Rejected: '${manifest.name}' does not provide streams, catalogs, or metadata.`);
        }

        // Success! Return the clean data and its capabilities.
        return {
            success: true,
            manifest: manifest,
            url: url,
            capabilities: {
                streams: providesStreams,
                catalogs: providesCatalogs,
                meta: providesMeta
            }
        };

    } catch (error) {
        console.error("Detector Failed:", error);
        return {
            success: false,
            error: error.message || "Failed to parse the add-on manifest."
        };
    }
}

//#endregion


//#region Fetch Streams
export async function loadAllAddonsParallel(type, streamId, season = null, episode = null) {
    const userAddons = JSON.parse(localStorage.getItem('user_addons')) || [];

    // Format the ID once for everyone
    let pathId = streamId;
    if (type === 'anime' && !String(pathId).startsWith('kitsu:')) pathId = `kitsu:${pathId}`;
    if (type === 'series') pathId = `${pathId}:${season}:${episode}`;
    else if (type === 'anime') pathId = `${pathId}:${episode}`;

    // Fire all addons in parallel
    userAddons.forEach(addon => {
        fetchSingleAddon(addon, type, pathId)
            .then(streams => {
                if (streams === null) {
                    console.log(`🚨 ${addon.name} is offline or failed.`);
                }
                else if (streams.length === 0) {
                    console.log(`📭 ${addon.name} found 0 streams.`);
                }
                else {
                    const shortName = addon.name.split(' ')[0];

                    // 1. Filter and pack the data
                    const packedData = filterAndSortStreams(streams, shortName);

                    //Cach it
                    streamState.addons[shortName] = packedData;

                    // 3. Draw it to the screen
                    renderAddonData(packedData);
                }
            });

    });
}

async function fetchSingleAddon(addon, type, pathId) {
    console.log(`🕵️‍♂️ Fetching ${addon.name}...`);

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