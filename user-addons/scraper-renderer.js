import { sendMagnetToTorbox } from "../services/torbox.js";
import { parseFormated } from "../utils/parseMedia";
import { showToast } from '../services/config.js';

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
        console.log(addon);
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

        // 4. Render Supported Types (Movies, Series, Anime, etc.)
        if (typesContainer && addon.types && addon.types.length > 0) {
            typesContainer.innerHTML = '';
            // Only show the first 4 types so it doesn't wrap excessively on mobile
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

                    console.log("Copied to clipboard:", addon.url);

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

//#endregion

//#region Parse Streams

export function filterAndSortStreams(streams, addonName) {

    // Pass all streams to ptt
    let parsedStreams = streams.map(stream => {
        const rawTitle = stream.description || stream.title || stream.name || "";
        const streamName = (stream.name || "").toLowerCase();

        const parsed = parseFormated(stream);

        // Audio Tier Classification
        let audioTier = parsed.audioType;

        // Video Tier Classification
        let videoTier = parsed.source;

        console.log(rawTitle, parsed);

        return {
            rawStream: stream,
            parsedData: parsed,
            isCached: parsed.isCached,
            resolution: parsed.resolution,
            audioTier: audioTier,
            videoTier: videoTier
        };
    });

    const bucket4K = [];
    const bucket1080p = [];
    const bucketOther = [];

    parsedStreams.forEach(stream => {
        const res = stream.resolution;
        if (res === "4K" || res === "4k HDR") {
            bucket4K.push(stream);
        } else if (res === "1080p" || res === "1440p") {
            bucket1080p.push(stream);
        } else {
            bucketOther.push(stream);
        }
    });

    return { addonName: addonName, bucket4K, bucket1080p, bucketOther };
}
//#endregion

//#region Render All Streams

export const streamState = {
    addons: {}
};

// Panel with streams from each addon
export function showStreamPicker(mainTitle) {
    const modal = document.getElementById('stream-picker-modal');
    const tabsContainer = document.getElementById('addon-tabs-container');
    const list = document.getElementById('stream-picker-list');

    document.getElementById('stream-picker-title').innerText = `${mainTitle}`;

    const userAddons = JSON.parse(localStorage.getItem('user_addons')) || [];

    streamState.addons = {}; // Clean slate!

    // 2. --- PREPARE CONTAINERS ---
    tabsContainer.innerHTML = '';
    list.innerHTML = '';
    const template = document.getElementById('addon-panel-template');

    // Helper to build a tab button
    const createTabButton = (name, isActive) => {
        const btn = document.createElement('button');
        btn.id = `tab-${name}`;

        if (isActive) {
            btn.className = "addon-tab flex-shrink-0 rounded-full px-4 py-1.5 text-xs font-bold whitespace-nowrap transition-all bg-blue-600 text-white shadow-md shadow-blue-900/20 active:scale-95";
        } else {
            btn.className = "addon-tab flex-shrink-0 rounded-full px-4 py-1.5 text-xs font-bold whitespace-nowrap transition-all bg-slate-700/50 text-slate-400 hover:bg-slate-700 hover:text-slate-200 border border-slate-600/50 active:scale-95";
        }

        btn.innerText = name;
        btn.addEventListener('click', () => switchAddonTab(name));
        tabsContainer.appendChild(btn);
    };

    // Helper to mount the panel
    const mountPanel = (addonName, isActive) => {
        const clone = template.content.cloneNode(true);
        const panel = clone.querySelector('.addon-panel');

        panel.id = `panel-${addonName}`;

        const loadingText = panel.querySelector('.loading-text');
        if (loadingText) {
            loadingText.innerText = `Searching ${addonName}...`;
        }

        if (isActive) {
            panel.classList.remove('hidden');
            panel.classList.add('flex');
        }

        list.appendChild(clone);
    };

    if (userAddons.length > 0) {
        tabsContainer.classList.remove('hidden');

        userAddons.forEach((addon, index) => {
            const shortName = addon.name.split(' ')[0];
            const isFirst = index === 0;

            // Init state
            streamState.addons[shortName] = { status: 'loading', streams: [] };

            // Build DOM
            createTabButton(shortName, isFirst);
            mountPanel(shortName, isFirst);
        });
    } else {
        tabsContainer.classList.add('hidden');
        list.innerHTML = `
            <div class="text-center py-10">
                <p class="text-slate-400 font-bold">No Add-ons Installed</p>
                <p class="text-xs text-slate-500 mt-2">Go to Settings to install stream providers.</p>
            </div>
        `;
    }

    modal.classList.remove('hidden');
}

// TAB SWITCHER
function switchAddonTab(addonName) {
    const allTabs = document.querySelectorAll('.addon-tab');

    allTabs.forEach(tab => {
        // Reset all tabs to the gray, inactive style
        tab.className = "addon-tab flex-shrink-0 rounded-full px-4 py-1.5 text-xs font-bold whitespace-nowrap transition-all bg-slate-700/50 text-slate-400 hover:bg-slate-700 hover:text-slate-200 border border-slate-600/50 active:scale-95";
    });

    const activeTab = document.getElementById(`tab-${addonName}`);
    if (activeTab) {
        // Highlight the clicked tab in blue
        activeTab.className = "addon-tab flex-shrink-0 rounded-full px-4 py-1.5 text-xs font-bold whitespace-nowrap transition-all bg-blue-600 text-white shadow-md shadow-blue-900/20 active:scale-95";
    }

    // 2. --- SWAP THE PANELS ---
    const allPanels = document.querySelectorAll('.addon-panel');

    allPanels.forEach(panel => {
        // Hide every panel
        panel.classList.add('hidden');
        panel.classList.remove('flex');
    });

    const targetPanel = document.getElementById(`panel-${addonName}`);
    if (targetPanel) {
        // Reveal only the panel that matches the clicked tab
        targetPanel.classList.remove('hidden');
        targetPanel.classList.add('flex');
    }
};

// Helper to create category headers dynamically
const createHeader = (title, colorClass, borderClass, bgClass) => {
    const header = document.createElement('div');
    header.className = `flex items-center gap-1.5 mb-1.5 mt-2`;
    header.innerHTML = `
        <div class="px-2 py-[3px] rounded-md ${bgClass} border ${borderClass}">
            <span class="${colorClass} font-bold text-[12px] uppercase tracking-wider">${title}</span>
        </div>
        <span class="h-[1px] flex-1 ${bgClass}"></span>
    `;
    return header;
};

// 🎨 THE PARENT RENDERER
export function renderAddonData(packedData) {
    // 1. Unpack the data
    const { addonName, bucket4K, bucket1080p, bucketOther } = packedData;

    // 2. Find the specific universe for this add-on
    const panel = document.getElementById(`panel-${addonName}`);
    if (!panel) return; // Failsafe

    const loadingSpinner = panel.querySelector('.panel-loading');
    const contentContainer = panel.querySelector('.panel-content');

    // 3. Hide the spinner, show and clean the content area
    if (loadingSpinner) loadingSpinner.classList.add('hidden');
    contentContainer.classList.remove('hidden');
    contentContainer.innerHTML = '';

    // 4. Check for Empty State
    const totalStreams = bucket4K.length + bucket1080p.length + bucketOther.length;

    if (totalStreams === 0) {
        contentContainer.innerHTML = `
            <div class="p-6 text-center flex flex-col items-center justify-center bg-red-900/10 border border-red-500/20 rounded-xl mt-4">
                <span class="text-red-400 font-bold text-sm">No streams found for ${addonName}.</span>
            </div>`;
        return;
    }

    const sliceTopAndMore = (bucket) => ({ top: bucket.slice(0, 3), more: bucket.slice(3) });

    if (bucket4K.length > 0) {
        contentContainer.appendChild(createHeader('4K UHD', 'text-amber-400', 'border-amber-400/20', 'bg-amber-400/10'));

        const container4K = document.createElement('div');
        container4K.className = 'flex flex-col gap-2.5 mb-4';
        container4K.id = `container-4k-${addonName}`;
        contentContainer.appendChild(container4K);

        const sliced = sliceTopAndMore(bucket4K);
        renderStreamCategory(container4K.id, sliced.top, sliced.more);
    }

    if (bucket1080p.length > 0) {
        contentContainer.appendChild(createHeader('1080p HD', 'text-blue-400', 'border-blue-400/20', 'bg-blue-400/10'));

        const container1080p = document.createElement('div');
        container1080p.className = 'flex flex-col gap-2.5 mb-4';
        container1080p.id = `container-1080p-${addonName}`;
        contentContainer.appendChild(container1080p);

        const sliced = sliceTopAndMore(bucket1080p);
        renderStreamCategory(container1080p.id, sliced.top, sliced.more);
    }

    if (bucketOther.length > 0) {
        contentContainer.appendChild(createHeader('Others / 720p', 'text-slate-400', 'border-slate-500/20', 'bg-slate-500/10'));

        const containerOther = document.createElement('div');
        containerOther.className = 'flex flex-col gap-2.5 mb-4';
        containerOther.id = `container-other-${addonName}`;
        contentContainer.appendChild(containerOther);

        const sliced = sliceTopAndMore(bucketOther);
        renderStreamCategory(containerOther.id, sliced.top, sliced.more);
    }
}

function renderStreamCategory(containerId, topStreams, moreStreams) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    topStreams.forEach((stream, index) => {
        const isRecommended = index === 0;
        container.appendChild(createStreamCard(stream, isRecommended));
    });

    if (moreStreams.length > 0) {
        const moreContainer = document.createElement('div');
        moreContainer.className = "hidden flex-col gap-2.5 w-full mt-1";

        moreStreams.forEach(stream => {
            moreContainer.appendChild(createStreamCard(stream, false));
        });

        const loadBtn = document.createElement('button');
        loadBtn.className = "w-full py-2.5 mt-1 bg-slate-800/40 text-slate-400 border border-slate-700/50 rounded-xl text-[11px] font-bold tracking-widest uppercase hover:bg-slate-700/60 hover:text-white transition-all hover:border-slate-600 flex justify-center items-center gap-2";
        loadBtn.innerHTML = `Load ${moreStreams.length} More`;

        loadBtn.onclick = () => {
            moreContainer.classList.remove('hidden');
            moreContainer.classList.add('flex');
            loadBtn.remove();
        };

        container.appendChild(loadBtn);
        container.appendChild(moreContainer);
    }
}

function buildStreamBlueprint(stream) {
    const parsed = stream.parsedData || {};

    // 1. Determine Audio Color cleanly using Optional Chaining
    let audioColor = "slate";
    const audioTierString = stream.audioTier?.tier || "Standard";

    if (audioTierString === "Lossless") audioColor = "purple";
    else if (audioTierString === "Premium") audioColor = "blue";

    let displayTitle = null;
    if (parsed.title) {
        displayTitle = parsed.title
            .replace(/[^a-zA-Z0-9]+$/, '')
            .replace(/\b\w/g, char => char.toUpperCase())
            .trim();
    }

    // 2. Safely extract Codecs
    let displayAudio = null;
    const codecs = parsed.audioType?.codecs || []; // Now safely defaults to an array

    if (codecs.length > 0) {
        displayAudio = codecs.join('/').toUpperCase();
    }

    let displayLangs = null;
    if (parsed.languages && parsed.languages.length > 0) {
        if (parsed.languages.length > 5) {
            const firstFive = parsed.languages.slice(0, 5).join(', ');
            const extras = parsed.languages.length - 5;
            displayLangs = `🌐 ${firstFive} +${extras}`;
        } else {
            displayLangs = `🌐 ${parsed.languages.join(', ')}`;
        }
    }

    // 3. Safely extract Video Source
    const videoSourceText = parsed.source?.source; // Will grab "WEB-DL", "BluRay", etc.

    const uiData = {
        line1: [
            { type: 'text', text: `${displayTitle}`, size: 'medium' },
            stream.isCached ? { type: 'badge', text: '⚡ Cached', color: 'emerald' } : { type: 'badge', text: '⚠️ Uncached', color: 'orange' }
        ].filter(Boolean),

        line2: [
            videoSourceText && videoSourceText !== "Unknown" ? { type: 'text', text: `📹 ${videoSourceText}`, size: 'small', color: 'blue', bold: true } : null,
            displayAudio ? { type: 'text', text: `🔊 ${displayAudio}`, size: 'small', color: audioColor, bold: true } : null,
            parsed.seasonDetails ? { type: 'badge', text: parsed.seasonDetails, size: 'small', color: 'blue', bold: true } : null
        ].filter(Boolean),

        line3: [
            displayLangs ? { type: 'text', text: displayLangs, color: 'blue' } : null,
            parsed.seeders !== undefined ? { type: 'text', text: `👤 ${parsed.seeders}` } : null,
            parsed.size && String(parsed.size).toLowerCase() !== 'unknown' ? { type: 'text', text: `💾 ${parsed.size}` } : null
        ].filter(Boolean)
    };

    return uiData;
}

// HELPER FUNCTIONS TO BUILD UI CARDS
const BADGE_THEMES = {
    emerald: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    slate: "bg-slate-700/50 text-slate-200 border-slate-600",
    blue: "bg-blue-500/10 text-blue-300 border-blue-500/20",
    orange: "bg-red-500/10 text-orange-300 border-red-500/20"
};

const TEXT_COLOR_MAP = {
    emerald: "text-emerald-400",
    purple: "text-purple-400",
    blue: "text-blue-400",
    slate: "text-slate-300"
};

const TEXT_SIZE_MAP = {
    small: "text-sm",
    medium: "text-base",
    large: "text-lg",
};

const renderBadge = (item) => {
    const theme = BADGE_THEMES[item.color] || BADGE_THEMES.slate;
    return `<span class="${theme} border text-[10px] px-1.5 py-0.5 rounded uppercase font-bold tracking-wider shadow-sm flex items-center gap-1">${item.text}</span>`;
};

const renderText = (item) => {
    const fontWeight = item.bold ? "font-bold" : "font-medium";
    const textColor = TEXT_COLOR_MAP[item.color] || "text-slate-300";
    const textSize = TEXT_SIZE_MAP[item.size] || "text-base";
    return `<span class="${fontWeight} ${textSize} ${textColor}">${item.text}</span>`;
};

const renderLine = (lineData) => lineData.map(item => {
    if (item.type === 'badge') return renderBadge(item);
    if (item.type === 'text') return renderText(item);
    return '';
}).join('');


// 2. MAIN FUNCTION
function createStreamCard(stream, isRecommended) {
    const raw = stream.rawStream;
    let extractedHash;

    if (raw.infoHash) {
        extractedHash = raw.infoHash;
    } else if (raw.url) {
        const urlMatch = raw.url.match(/\/([a-fA-F0-9]{40})\//);
        if (urlMatch) extractedHash = urlMatch[1];
    }

    if (!extractedHash && raw.behaviorHints?.bingeGroup) {
        const bingeMatch = raw.behaviorHints.bingeGroup.match(/\|([a-fA-F0-9]{40})/);
        if (bingeMatch) extractedHash = bingeMatch[1];
    }

    const finalLink = extractedHash
        ? `magnet:?xt=urn:btih:${extractedHash}`
        : raw.url;

    const rawTitle = (raw.description || raw.title || '').replace(/(?:\r\n|\r|\n|\\n)/g, '<br>');
    const rawInfo = `${raw.name}<br>${rawTitle}`;

    // Setup base classes
    const baseClasses = "w-full text-left border p-3.5 rounded-xl transition-all duration-200 flex flex-col group relative overflow-hidden";
    let colorClasses = "bg-slate-800/60 hover:bg-slate-700/80 border-slate-700 hover:border-slate-500 shadow-sm hover:shadow-md";
    let buttonHover = "bg-slate-800 text-slate-300 group-hover:bg-blue-600 group-hover:text-white";

    if (isRecommended) {
        colorClasses = "bg-emerald-900/10 hover:bg-emerald-900/20 border-emerald-500/30 hover:border-emerald-500/60 shadow-[0_0_15px_rgba(16,185,129,0.05)] hover:shadow-[0_0_20px_rgba(16,185,129,0.1)]";
        buttonHover = "bg-emerald-900/50 text-emerald-400 border border-emerald-500/30 group-hover:bg-emerald-600 group-hover:text-white group-hover:border-transparent";
    }

    // Create the button and assign classes exactly ONCE
    const btn = document.createElement('button');
    btn.className = `${baseClasses} ${colorClasses}`;

    // Reusable submit function to prevent repeating logic
    const handleSubmit = () => {
        sendMagnetToTorbox(finalLink);
    };

    // Show Raw Data
    if (false) {
        btn.innerHTML = `
        <div class="w-full flex justify-between items-start text-left cursor-default">            
            <span class="text-[14px] font-semibold text-slate-300 break-words block">${rawInfo}</span>
            <span class="text-[10px] whitespace-nowrap font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg transition-colors flex-shrink-0 mt-0.5 ${buttonHover}">Send to Torbox</span>
        </div>`;

        btn.onclick = handleSubmit;
        return btn;
    }

    const blueprint = buildStreamBlueprint(stream);

    // Handle Standard Stream
    btn.innerHTML = `
        <div class="flex justify-between items-start w-full gap-3">
            <div class="flex flex-col gap-1.5 flex-1 overflow-hidden">
                <div class="flex items-center flex-wrap gap-2">
                    ${renderLine(blueprint.line1)}
                </div>
                <div class="flex items-center flex-wrap gap-1.5">
                    ${renderLine(blueprint.line2)}
                </div>
            </div>
            <span class="text-[10px] whitespace-nowrap font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg transition-colors flex-shrink-0 mt-0.5 ${buttonHover}">Send to Torbox</span>
        </div>
        
        <div class="flex justify-between items-end w-full mt-2">
            <div class="text-[12px] text-slate-300 flex items-center flex-wrap gap-2">
                ${blueprint.line3.length > 0 ? blueprint.line3.map(renderText).join('<span>•</span>') : ''}
            </div>
            
            <span class="expand-btn flex items-center justify-center text-slate-400 hover:text-blue-400 hover:bg-slate-700/60 p-2 rounded-full transition-all z-10 cursor-pointer -mr-2 -mb-2">
                <svg class="chevron w-5 h-5 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7"></path>
                </svg>
            </span>
        </div>

        <div class="details-container hidden w-full flex-col text-left mt-4 pt-4 border-t cursor-default">            
            <span class="text-[13px] font-bold text-slate-500 break-words block">${rawInfo}</span>
        </div>
    `;

    btn.onclick = (e) => {
        const expandBtn = e.target.closest('.expand-btn');
        const detailsContainer = e.target.closest('.details-container');

        if (expandBtn || detailsContainer) {
            e.preventDefault();
            e.stopPropagation();

            if (expandBtn) {
                const container = btn.querySelector('.details-container');
                const chevron = btn.querySelector('.chevron');

                container.classList.toggle('hidden');
                container.classList.toggle('flex');
                chevron.classList.toggle('rotate-180');
            }
            return;
        }

        handleSubmit();
    };

    return btn;
}
//#endregion