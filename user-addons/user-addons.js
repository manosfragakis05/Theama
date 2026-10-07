import { showToast, MY_PROXY, appState } from '../services/config.js';
import { getCurrentUserSettings, getStorage, saveAddons } from '../user-data/user-settings.js';
import { renderAddonData } from './scraper-renderer.js';

// 1. In-Memory State: The single source of truth for the UI while the app is running
let cachedAddons = [];

export async function initAddonManager() {
    const settings = getCurrentUserSettings();

    // The official list of what the user should have installed
    const officialUrls = settings.addon_links || [];

    const storage = getStorage();
    let storedData = JSON.parse(storage.getItem('full_addon_data')) || [];

    // STEP 1: Clean up Ghost Add-ons
    // Keep the local default TMDB, and only keep addons that exist in the officialUrls list
    storedData = storedData.filter(addon =>
        addon.id === "local.default.addon" || officialUrls.includes(addon.url)
    );

    // STEP 2: Identify Missing Add-ons
    // Create a Set of URLs we already have full data for, to easily find what's missing
    const storedUrls = new Set(storedData.map(addon => addon.url));
    const missingUrls = officialUrls.filter(url => !storedUrls.has(url));

    // STEP 3: Fetch & Hydrate Missing Add-ons
    if (missingUrls.length > 0) {
        console.log(`Hydrating ${missingUrls.length} missing add-ons from cloud...`);

        const fetchPromises = missingUrls.map(url => detectAndValidateAddon(url));
        const results = await Promise.all(fetchPromises);

        results.forEach(result => {
            if (result && result.success) {
                const manifest = result.manifest;
                storedData.push({
                    id: manifest.id,
                    name: manifest.name,
                    url: result.url,
                    catalogs: manifest.catalogs || [],
                    version: manifest.version,
                    logo: manifest.logo || null,
                    description: manifest.description || null,
                    configurable: manifest.behaviorHints?.configurable || false,
                    types: manifest.types || [],
                    idPrefixes: getStreamIdPrefixes(manifest),
                    capabilities: result.capabilities
                });
            } else {
                console.warn(`Failed to hydrate addon: ${result?.error}`);
            }
        });
    }

    // STEP 4: Ensure the Local Default Add-on exists
    let defaultAddon = storedData.find(addon => addon.id === "local.default.addon");
    if (!defaultAddon) {
        defaultAddon = await formatTMDBAddon();
        storedData.push(defaultAddon);
    }

    // STEP 5: Update Memory and Storage
    cachedAddons = storedData;

    // Only persist the cache to storage if the user trusts the device

    storage.setItem("full_addon_data", JSON.stringify(cachedAddons));


    return cachedAddons;
}

export async function initCustomAddons() {
    // 1. Let the Manager reconcile URLs, clean storage, and hydrate the cache
    const fullAddonData = await initAddonManager();

    // 2. Render the UI
    renderInstalledAddons(fullAddonData);
}

// Simple Getter for the rest of your app to use without touching localStorage
export function getAllAddons() {
    return cachedAddons;
}
async function formatTMDBAddon() {
    return {
        id: "local.default.addon",
        name: "TMDB",
        url: null,
        catalogs: [],
        version: "1.0",
        logo: "https://www.themoviedb.org/assets/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg" || null,
        description: "Default TMDB metadata, with a custom Kitsu integration for better anime url results",
        configurable: false,
        types: ["movie", "series"],
        idPrefixes: ["tmdb:", "tt", "kitsu"],
        capabilities: { streams: false, catalogs: true, meta: true }
    };
}

//#endregion


//#region Install Addon
// Add new Addon
async function installAddon(rawUrl) {
    if (!rawUrl) return { success: false, error: "URL is required" };

    // 1. Fetch and Validate
    const result = await detectAndValidateAddon(rawUrl);
    if (!result || !result.success) {
        return { success: false, error: result?.error || "Invalid add-on URL" };
    }

    const manifest = result.manifest;
    const cleanUrl = result.url;
    const addonId = manifest.id;

    // 2. Format the full add-on object
    const addonData = {
        id: manifest.id,
        name: manifest.name,
        url: cleanUrl,
        catalogs: manifest.catalogs || [],
        version: manifest.version,
        logo: manifest.logo || null,
        description: manifest.description || null,
        configurable: manifest.behaviorHints?.configurable || false,
        types: manifest.types || [],
        idPrefixes: getStreamIdPrefixes(manifest),
        capabilities: result.capabilities
    };

    // 3. Update the Official URL List (Source of Truth)
    const settings = getCurrentUserSettings();
    let currentUrls = settings.addon_links || [];

    const existingCacheIndex = cachedAddons.findIndex(a => a.id === addonId);

    if (existingCacheIndex !== -1) {
        // Update old addon
        const oldUrl = cachedAddons[existingCacheIndex].url;

        // Remove old url
        currentUrls = currentUrls.filter(url => url !== oldUrl);

        // Add the new url
        if (!currentUrls.includes(cleanUrl)) currentUrls.push(cleanUrl);

        // Overwrite the cache with the fresh manifest data
        cachedAddons[existingCacheIndex] = addonData;

    } else {
        // --- BRAND NEW ADD-ON ---
        if (!currentUrls.includes(cleanUrl)) currentUrls.push(cleanUrl);
        cachedAddons.push(addonData);
    }

    await saveAddons(currentUrls);

    // Update local cache
    getStorage().setItem("full_addon_data", JSON.stringify(cachedAddons));

    // 6. Return success
    return {
        success: true,
        addon: addonData,
        isUpdate: existingCacheIndex !== -1
    };
}

export async function submitNewAddon() {
    const inputField = document.getElementById('addon-url-input');
    const submitBtn = document.getElementById('addon-submit-btn') || inputField.nextElementSibling;
    const rawUrl = inputField.value.trim();

    if (!rawUrl) return;

    // UI Feedback: Show loading state
    const originalText = submitBtn.innerText;
    submitBtn.innerText = "Verifying...";
    submitBtn.disabled = true;

    // Let the Addon Manager do all the work
    const result = await installAddon(rawUrl);

    // Restore UI state
    submitBtn.innerText = originalText;
    submitBtn.disabled = false;

    if (result.success) {
        if (result.isUpdate) {
            showToast(`${result.addon.name} configuration updated.`, "success");
        } else {
            showToast(`Success! ${result.addon.name} was added.`, "success");
        }

        inputField.value = '';

        // Re-render the UI using the Manager's universally updated cache
        renderInstalledAddons(getAllAddons());
    } else {
        showToast(`Error: ${result.error}`, "error");
    }
}

// Helper to see what ids the addon supports
function getStreamIdPrefixes(manifest) {
    if (manifest.idPrefixes && Array.isArray(manifest.idPrefixes)) {
        return manifest.idPrefixes;
    }

    if (manifest.resources && Array.isArray(manifest.resources)) {
        const streamResource = manifest.resources.find(
            (res) => typeof res === 'object' && res.name === 'stream'
        );

        if (streamResource && Array.isArray(streamResource.idPrefixes)) {
            return streamResource.idPrefixes;
        }
    }
    return [];
}

async function detectAndValidateAddon(rawUrl) {
    let url = rawUrl.trim();

    if (!url.endsWith('manifest.json')) return { success: false, error: "URL must end with manifest.json" };

    try {
        // Fetch the Manifest (With CORS Fallback)
        let response;
        try {
            response = await fetch(url);
        } catch (e) {
            console.warn("Direct fetch blocked by CORS. Using proxy...");
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

//#region Render Addons

// Show Addons
function renderInstalledAddons(userAddons) {
    const container = document.getElementById('installed-addons-list');
    const template = document.getElementById('installed-addon-template');

    if (!container || !template) return;

    // Clear out the container first
    container.innerHTML = '';

    if (userAddons.length === 0) {
        container.innerHTML = `
            <div class="text-center py-8 bg-slate-900/30 rounded-xl border border-dashed border-slate-700/50 mt-2">
                <p class="text-sm text-slate-500 font-medium">No add-ons installed yet.</p>
            </div>
        `;
        return;
    }

    userAddons.forEach(addon => {
        const clone = template.content.cloneNode(true);
        const firstLetter = (addon.name || 'A').charAt(0).toUpperCase();

        // DOM References
        const logoImg = clone.querySelector('.addon-logo');
        const logoFallback = clone.querySelector('.addon-fallback');
        const nameEl = clone.querySelector('.addon-name');
        const versionEl = clone.querySelector('.addon-version');
        const descEl = clone.querySelector('.addon-description');

        const capabilitiesContainer = clone.querySelector('.addon-capabilities');
        const typesContainer = clone.querySelector('.addon-types');

        const addonShareBtn = clone.querySelector('.addon-share-btn');
        const configBtn = clone.querySelector('.addon-config-btn');
        const uninstallBtn = clone.querySelector('.addon-uninstall-btn');

        // 1. Text Data
        nameEl.textContent = addon.name;
        versionEl.textContent = `v${addon.version || '1.0.0'}`;

        if (addon.description) {
            descEl.textContent = addon.description;
        } else {
            descEl.classList.add('hidden');
        }

        // 2. Logo Logic
        if (addon.logo) {
            logoImg.src = addon.logo;
            logoImg.alt = `${addon.name} logo`;
            logoImg.classList.remove('hidden');
            logoFallback.classList.add('hidden');

            logoImg.onerror = () => {
                logoImg.classList.add('hidden');
                logoFallback.classList.remove('hidden');
                logoFallback.textContent = firstLetter;
            };
        } else {
            logoFallback.textContent = firstLetter;
        }

        // 3. Render Capabilities (Streams, Catalogs, Meta)
        if (capabilitiesContainer && addon.capabilities) {
            capabilitiesContainer.innerHTML = '';
            if (addon.capabilities.streams) {
                capabilitiesContainer.innerHTML += `<span class="bg-blue-500/10 text-blue-400 text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider border border-blue-500/20">Streams</span>`;
            }
            if (addon.capabilities.catalogs) {
                capabilitiesContainer.innerHTML += `<span class="bg-purple-500/10 text-purple-400 text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider border border-purple-500/20">Catalogs</span>`;
            }
            if (addon.capabilities.meta) {
                capabilitiesContainer.innerHTML += `<span class="bg-emerald-500/10 text-emerald-400 text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider border border-emerald-500/20">Meta</span>`;
            }
        }

        if (typesContainer && addon.types && addon.types.length > 0) {
            typesContainer.innerHTML = '';
            // Only show the first 4 types
            addon.types.slice(0, 4).forEach(type => {
                typesContainer.innerHTML += `<span class="bg-slate-800 text-slate-300 text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider border border-slate-700/50">${type}</span>`;
            });
        }

        // Wire addon share to the url
        if (addon.url) {
            addonShareBtn.classList.remove('hidden');
            addonShareBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(addon.url);

                    showToast("Copied your addons configuration", "success")

                } catch (err) {
                    console.error("Failed to copy URL: ", err);
                }
            });
        }

        // 5. Wire up the Configure Button (if applicable)
        if (addon.configurable && configBtn) {
            configBtn.classList.remove('hidden');
            configBtn.addEventListener('click', () => {
                const configUrl = addon.url.replace(/\/manifest\.json.*$/, '/configure');
                window.open(configUrl, '_blank');
            });
        }

        // Skip for TMDB
        if (uninstallBtn) {
            if (addon.id === "local.default.addon") {
                uninstallBtn.classList.add('hidden');
            } else {
                uninstallBtn.classList.remove('hidden');
                uninstallBtn.addEventListener('click', async () => {
                    await removeAddon(addon.url);
                });
            }
        }
        container.appendChild(clone);
    });
}

// Uninstall Addon
async function removeAddon(addonUrl) {
    // Let the Addon Manager handle database, memory, and local storage cleanup
    const result = await uninstallAddon(addonUrl);

    if (result.success) {
        // Fetch the fresh list of full objects and re-render
        renderInstalledAddons(getAllAddons());
        showToast("Add-on uninstalled.", "success");
    } else {
        showToast(result.error || "Failed to uninstall add-on.", "error");
    }
}
export async function uninstallAddon(urlToRemove) {
    if (!urlToRemove) return { success: false, error: "No URL provided" };

    const settings = getCurrentUserSettings();
    let currentUrls = settings.addon_links || [];

    currentUrls = currentUrls.filter(url => url !== urlToRemove);

    // saveAddons handles both local settings update and Supabase sync
    await saveAddons(currentUrls);

    cachedAddons = cachedAddons.filter(addon => addon.url !== urlToRemove);

    getStorage().setItem("full_addon_data", JSON.stringify(cachedAddons));

    return { success: true };
}