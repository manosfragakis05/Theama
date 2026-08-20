/**
 * ==========================================
 * library.js
 * Handles fetching, parsing, and rendering the main TorBox library grid
 * ==========================================
 */

import { appState, getTbKey, smartFetch, showToast } from '../services/config.js';
import { getPosterForLibrary } from '../services/metadata.js';
import { parseMediaData } from '../utils/parseMedia.js';
import { requestLink } from '../streaming/player.js';

import { openPicker } from '../streaming/picker.js';

// --- DATA FETCHING ---

export async function loadLibrary() {
    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('file-list').innerHTML = '';

    const key = getTbKey();
    if (!key) return;

    try {
        const res = await smartFetch('https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=false', {
            headers: { 'Authorization': `Bearer ${key}` }
        });
        const data = await res.json();
        document.getElementById('loading').classList.add('hidden');

        if (data.success) {
            // Save to our global state so other files can search/filter it
            appState.allTorrents = data.data.filter(t => t.download_finished);
            renderList(appState.allTorrents);
        } else {
            showToast("Error: " + data.detail, 'error');
        }
    } catch (e) {
        showToast("Network Error", 'error');
    }
}

// --- API ACTIONS ---

export async function deleteTorrent(torrentId, event) {
    if (event) event.stopPropagation();
    if (!confirm("Are you sure you want to delete this from TorBox?")) return;


    const key = getTbKey();
    if (!key) return;
    const targetUrl = 'https://api.torbox.app/v1/api/torrents/controltorrent';

    try {
        const res = await smartFetch(targetUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                torrent_id: torrentId,
                operation: "delete"
            })
        });

        const data = await res.json();

        if (data.success) {
            showToast("Deleted successfully!", 'success');
            
            appState.allTorrents = appState.allTorrents.filter(t => t.id !== torrentId);            
            renderList(appState.allTorrents);
        } else {
            showToast("Error: " + data.detail, 'error');
        }
    } catch (e) {
        console.error("Delete Error:", e);
        showToast("Failed to delete torrent.", 'error');
    }
}

// --- UI RENDERING ---

export function renderList(items) {
    const list = document.getElementById('file-list');
    list.innerHTML = '';

    if (items.length === 0) {
        document.getElementById('empty-state').classList.remove('hidden');
        return;
    }
    document.getElementById('empty-state').classList.add('hidden');

    const vault = JSON.parse(localStorage.getItem('tmdb_vault') || '{}');
    const itemsNeedsFetching = [];

    // 1. INSTANT UI RENDER
    items.forEach((t) => {
        const vidCount = t.files.filter(f => f.name.match(/\.(mkv|mp4|avi|mov)$/i)).length;
        const isShow = vidCount > 1;

        const mediaInfo = parseMediaData(t.name);
        const cleanName = mediaInfo.title.replace(/(^\w|[\s-]\w)/g, match => match.toUpperCase());
        const year = mediaInfo.year;

        const hash = (t.hash || "").toLowerCase();
        let vaultData = vault[hash];

        const card = document.createElement('div');
        card.className = "relative flex-col cursor-pointer transition-transform hover:scale-105 select-none group";

        // Step 1: Remove onclick entirely and add identifier classes ('delete-btn', 'download-btn')
        let actionButtonsHTML = `<button class="delete-btn text-red-500 hover:text-red-400 p-1 bg-black/50 rounded-full transition z-10 w-8 h-8 flex items-center justify-center backdrop-blur-sm shadow-md">🗑️</button>`;

        if (!isShow) {
            const vid = t.files.find(f => f.name.match(/\.(mkv|mp4|avi|mov)$/i)) || t.files[0];
            if (vid) {
                actionButtonsHTML = `
                    <button class="download-btn text-blue-400 hover:text-blue-300 p-1 bg-black/50 rounded-full transition z-10 w-8 h-8 flex items-center justify-center backdrop-blur-sm shadow-md mr-2">⬇️</button>
                    ${actionButtonsHTML}
                `;
            }
        }

        // Inject into the card
        card.innerHTML = `
            <div class="relative w-full aspect-[2/3] bg-slate-800 rounded-lg shadow-lg overflow-hidden border border-slate-700/50">
                <img id="img-${t.id}" src="" class="absolute inset-0 w-full h-full object-cover hidden" draggable="false">
                <div id="fallback-${t.id}" class="absolute inset-0 flex items-center justify-center p-4 text-center text-slate-500 font-bold text-sm bg-slate-800">
                    ${cleanName}
                </div>
                <div class="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3">
                    <div class="flex justify-between items-center mb-1">
                        <span class="text-white font-bold text-xs truncate drop-shadow-md">${isShow ? '📺 Series' : '🎬 Movie'}</span>
                        <div class="flex items-center">
                            ${actionButtonsHTML}
                        </div>
                    </div>
                </div>
                <div class="absolute top-2 right-2 bg-blue-600/90 text-white text-[10px] font-bold px-2 py-1 rounded backdrop-blur shadow-lg">
                    ${(t.size / 1073741824).toFixed(1)} GB
                </div>
            </div>
            <p class="text-xs text-slate-300 mt-2 truncate font-semibold pl-1">${cleanName}</p>
        `;

        // Step 2: Query the newly created HTML for the buttons and attach event listeners dynamically

        const deleteBtn = card.querySelector('.delete-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', (event) => {
                // Event delegation handles this safely inside the loop's closure
                deleteTorrent(t.id, event);
            });
        }

        const downloadBtn = card.querySelector('.download-btn');
        if (downloadBtn) {
            downloadBtn.addEventListener('click', (event) => {
                event.stopPropagation(); // Prevent the main card click event from firing
                const vid = t.files.find(f => f.name.match(/\.(mkv|mp4|avi|mov)$/i)) || t.files[0];
                if (vid) {
                    downloadToOPFS(t.id, vid.id, null, cleanName, event.currentTarget);
                }
            });
        }

        // Maintain your original card click logic
        card.addEventListener('click', () => {
            if (appState.clickCooldown) { showToast("Please wait a moment."); return; }
            appState.clickCooldown = true;
            setTimeout(() => appState.clickCooldown = false, 2000);

            if (isShow) {
                openPicker(t);
            } else {
                const vid = t.files.find(f => f.name.match(/\.(mkv|mp4|avi|mov)$/i)) || t.files[0];
                if (vid) {
                    requestLink(t.id, vid.id, t.name, vid.name);
                } else {
                    showToast("No playable video files found in this torrent.", "error");
                }
            }
        });

        list.appendChild(card);

        // Poster Loading Logic
        const imgElement = document.getElementById(`img-${t.id}`);
        const fallbackElement = document.getElementById(`fallback-${t.id}`);

        if (vaultData && vaultData.poster) {
            imgElement.src = vaultData.poster;
            imgElement.classList.remove('hidden');
            fallbackElement.classList.add('hidden');
        } else {
            itemsNeedsFetching.push({ t, cleanName, year, hash, imgElement, fallbackElement });
        }
    });

    // 2. THE BATCH FETCHER
    if (itemsNeedsFetching.length > 0) {
        const fetchInBatches = async () => {
            const BATCH_SIZE = 5;

            for (let i = 0; i < itemsNeedsFetching.length; i += BATCH_SIZE) {
                const batch = itemsNeedsFetching.slice(i, i + BATCH_SIZE);

                await Promise.all(batch.map(async (item) => {
                    const fetchedData = await getPosterForLibrary(item.cleanName, item.year);
                    const finalPoster = typeof fetchedData === 'string' ? fetchedData : (fetchedData?.poster);

                    if (finalPoster) {
                        item.imgElement.src = finalPoster;
                        item.imgElement.classList.remove('hidden');
                        item.fallbackElement.classList.add('hidden');

                        if (typeof fetchedData === 'object' && fetchedData.id) {
                            let safeVault = JSON.parse(localStorage.getItem('tmdb_vault') || '{}');
                            safeVault[item.hash] = { id: fetchedData.id, type: fetchedData.type, poster: fetchedData.poster };
                            localStorage.setItem('tmdb_vault', JSON.stringify(safeVault));
                        }
                    }
                }));

                await new Promise(resolve => setTimeout(resolve, 250));
            }
        };
        fetchInBatches();
    }
}