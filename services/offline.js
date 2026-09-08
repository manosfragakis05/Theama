/**
 * ==========================================
 * offline.js
 * Handles OPFS downloads, saving metadata, and the Local Ghost Library
 * ==========================================
 */

import { appState, showToast } from './config.js';
import { parseFormated } from '../utils/parseMedia.js';
import { getPosterForLibrary } from './metadata.js';
import { getTorboxLink, startPlayer } from '../streaming/player.js';

let expectedLocalFile = null;

// --- GHOST LIBRARY (Local Files) ---

export function triggerLocalFilePicker(expectedName = null, expectedSize = null) {
    if (expectedName) {
        expectedLocalFile = { name: expectedName, size: expectedSize };
        showToast(`Please re-select: ${expectedName}`, 'info');
    } else {
        expectedLocalFile = null;
    }
    document.getElementById('local-file-input').click();
}

export async function processLocalFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    event.target.value = '';

    if (expectedLocalFile) {
        if (file.name !== expectedLocalFile.name || file.size !== expectedLocalFile.size) {
            showToast(`Incorrect file! Expected: ${expectedLocalFile.name}`, 'error');
            return;
        }
    }

    const localVault = JSON.parse(localStorage.getItem('local_ghost_vault') || '{}');

    if (!localVault[file.name]) {
        showToast("Adding to library...", "info");
        const parsedData = parseFormated(file.name);

        let posterUrl = '';
        try {
            const tmdbData = await getPosterForLibrary(parsedData.title, parsedData.year);
            posterUrl = typeof tmdbData === 'string' ? tmdbData : (tmdbData?.poster || '');
        } catch (e) { console.warn("Could not fetch poster for local file."); }

        localVault[file.name] = {
            name: file.name,
            size: file.size,
            cleanTitle: parsedData.title,
            poster: posterUrl,
            lastPlayed: Date.now()
        };
        localStorage.setItem('local_ghost_vault', JSON.stringify(localVault));
        renderLocalLibrary();
    } else {
        localVault[file.name].lastPlayed = Date.now();
        localStorage.setItem('local_ghost_vault', JSON.stringify(localVault));
    }

    const fileBlobUrl = URL.createObjectURL(file);
    startPlayer(fileBlobUrl, file.name, file);
}

export function renderLocalLibrary() {
    const localVault = JSON.parse(localStorage.getItem('local_ghost_vault') || '{}');
    const files = Object.values(localVault).sort((a, b) => b.lastPlayed - a.lastPlayed);

    const list = document.getElementById('local-file-list');
    const emptyState = document.getElementById('local-empty-state');

    if (!list || !emptyState) return;

    list.innerHTML = '';

    if (files.length === 0) {
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    files.forEach(fileData => {
        const card = document.createElement('div');
        card.className = "relative flex-col cursor-pointer transition-transform hover:scale-105 select-none group";

        const fallbackInitials = (fileData.cleanTitle || "Unknown").substring(0, 2).toUpperCase();

        card.innerHTML = `
            <div class="relative w-full aspect-[2/3] bg-slate-800 rounded-lg shadow-lg overflow-hidden border border-slate-700/50">
                ${fileData.poster
                ? `<img src="${fileData.poster}" class="absolute inset-0 w-full h-full object-cover">`
                : `<div class="absolute inset-0 flex items-center justify-center p-4 text-center text-slate-500 font-bold text-2xl bg-slate-800">${fallbackInitials}</div>`
            }
                
                <div class="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-center items-center pb-4">
                    <div class="w-12 h-12 bg-emerald-500/90 rounded-full flex items-center justify-center text-white shadow-lg backdrop-blur-sm transform scale-75 group-hover:scale-100 transition-all">
                        <svg class="w-6 h-6 ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                    <span class="text-white text-[10px] font-bold mt-2 uppercase tracking-widest text-center px-2">Tap to re-link<br>and play</span>
                </div>
                
                <button onclick="event.stopPropagation(); deleteLocalGhost(\`${fileData.name.replace(/`/g, '')}\`)" class="absolute top-2 right-2 text-white bg-black/60 hover:bg-red-600 p-1.5 rounded-full transition opacity-0 group-hover:opacity-100 backdrop-blur-sm">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <p class="text-xs text-slate-300 mt-2 truncate font-semibold pl-1">${fileData.cleanTitle}</p>
        `;

        card.onclick = () => triggerLocalFilePicker(fileData.name, fileData.size);
        list.appendChild(card);
    });
}

export function deleteLocalGhost(fileName) {
    if (!confirm("Remove this from your device library? (The actual file will NOT be deleted from your device).")) return;

    const localVault = JSON.parse(localStorage.getItem('local_ghost_vault') || '{}');
    delete localVault[fileName];
    localStorage.setItem('local_ghost_vault', JSON.stringify(localVault));
    renderLocalLibrary();
}