import { showToast, MY_PROXY } from '../services/config.js';

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

        const idPrefix = getStreamIdPrefixes(manifest);

        // 1. Build the complete add-on object
        const addonData = {
            id: manifest.id,
            name: manifest.name,
            url: result.url,
            catalogs: manifest.catalogs || [], // ONLY IF ITS A METADATA PROVIDER
            version: manifest.version,
            logo: manifest.logo || null,
            description: manifest.description || null,
            configurable: manifest.behaviorHints?.configurable || false,
            types: manifest.types || [],
            idPrefixes: idPrefix,
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
export function renderInstalledAddons() {
    const container = document.getElementById('installed-addons-list');
    const template = document.getElementById('installed-addon-template');

    if (!container || !template) return;

    const userAddons = JSON.parse(localStorage.getItem('user_addons')) || [];

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

        // 6. Wire up the Uninstall Button
        if (uninstallBtn) {
            uninstallBtn.addEventListener('click', () => {
                removeAddon(addon.id);
            });
        }

        container.appendChild(clone);
    });
}

// Uninstall Addon
function removeAddon(addonId) {
    let userAddons = JSON.parse(localStorage.getItem('user_addons')) || [];
    userAddons = userAddons.filter(a => a.id !== addonId);
    localStorage.setItem('user_addons', JSON.stringify(userAddons));

    renderInstalledAddons();

    showToast("Add-on uninstalled.", "success");
}