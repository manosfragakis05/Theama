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
    startPlayer(fileBlobUrl, file.name);
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

// --- OPFS DOWNLOADS ---

export async function downloadToOPFS(torrentId, fileId, folderName, fileName, posterUrl, thumbUrl, epTitle, epNumber, buttonElement) {
    if (appState.clickCooldown) return;

    buttonElement.disabled = true;
    buttonElement.innerHTML = `<span class="animate-spin inline-block">⏳</span>`;

    const downloadUrl = await getTorboxLink(torrentId, fileId);
    if (!downloadUrl) {
        buttonElement.innerHTML = `⬇️`;
        buttonElement.disabled = false;
        return;
    }

    let wakeLock = null;

    try {
        if ('wakeLock' in navigator) {
            try { wakeLock = await navigator.wakeLock.request('screen'); }
            catch (err) { console.warn(`Wake Lock failed: ${err.message}`); }
        }

        const pathParts = fileName.split('/');
        let safeName = pathParts[pathParts.length - 1].replace(/[\\/:*?"<>|]/g, '_').trim();
        if (!safeName) safeName = `video_${Date.now()}.mkv`;

        if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
        const opfsRoot = await navigator.storage.getDirectory();

        let targetDirectory = opfsRoot;
        if (folderName) {
            targetDirectory = await opfsRoot.getDirectoryHandle(folderName, { create: true });
        }

        if (posterUrl) savePosterToOPFS(folderName || fileName, posterUrl);

        const fileHandle = await targetDirectory.getFileHandle(safeName, { create: true });
        const writable = await fileHandle.createWritable();

        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

        const contentLength = response.headers.get('content-length');
        const total = parseInt(contentLength, 10);
        let loaded = 0;

        const reader = response.body.getReader();
        const progressStream = new ReadableStream({
            async start(controller) {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        controller.close();
                        break;
                    }
                    loaded += value.byteLength;
                    if (total) {
                        const percent = Math.round((loaded / total) * 100);
                        buttonElement.innerText = `${percent}%`;
                    } else {
                        const mbLoaded = (loaded / (1024 * 1024)).toFixed(0);
                        buttonElement.innerText = `${mbLoaded}M`;
                    }
                    controller.enqueue(value);
                }
            }
        });

        await progressStream.pipeTo(writable);

        buttonElement.innerHTML = '✅';
        buttonElement.classList.replace('text-white', 'text-emerald-400');
        buttonElement.classList.replace('hover:bg-slate-700', 'hover:bg-emerald-900');
        showToast(`Downloaded for offline viewing!`, 'success');

    } catch (error) {
        showToast(`Download failed: ${error.message}`, 'error');
        buttonElement.innerHTML = '⬇️';
        buttonElement.disabled = false;
    } finally {
        if (wakeLock !== null) wakeLock.release();
    }
}

export async function savePosterToOPFS(showName, posterUrl) {
    if (!posterUrl || !showName) return;
    let catalog = JSON.parse(localStorage.getItem('offline_catalog') || '{}');
    if (catalog[showName] && catalog[showName].posterSaved) return;

    try {
        const response = await fetch(posterUrl);
        if (!response.ok) throw new Error("Image fetch failed");
        const imageBlob = await response.blob();

        const opfsRoot = await navigator.storage.getDirectory();
        const safeFolderName = showName.replace(/[\\/:*?"<>|]/g, '').trim();
        const showFolder = await opfsRoot.getDirectoryHandle(safeFolderName, { create: true });

        const fileHandle = await showFolder.getFileHandle('poster.jpg', { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(imageBlob);
        await writable.close();

        if (!catalog[showName]) catalog[showName] = {};
        catalog[showName].posterSaved = true;
        localStorage.setItem('offline_catalog', JSON.stringify(catalog));
    } catch (e) {
        console.error("Failed to save poster:", e);
    }
}

export async function saveEpisodeDataToOPFS(showName, epNumber, epTitle, thumbUrl) {
    if (!showName || epNumber == null) return;
    let catalog = JSON.parse(localStorage.getItem('offline_catalog') || '{}');

    if (!catalog[showName]) catalog[showName] = { posterSaved: false, episodes: {} };
    if (!catalog[showName].episodes) catalog[showName].episodes = {};

    const epKey = `E${epNumber}`;
    if (catalog[showName].episodes[epKey] && catalog[showName].episodes[epKey].thumbSaved) return;

    try {
        const safeFolderName = showName.replace(/[\\/:*?"<>|]/g, '').trim();
        let thumbFileName = `${epKey}_thumb.jpg`;

        if (thumbUrl) {
            const response = await fetch(thumbUrl);
            if (response.ok) {
                const imageBlob = await response.blob();
                const opfsRoot = await navigator.storage.getDirectory();
                const showFolder = await opfsRoot.getDirectoryHandle(safeFolderName, { create: true });
                const fileHandle = await showFolder.getFileHandle(thumbFileName, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(imageBlob);
                await writable.close();
            } else {
                thumbFileName = null;
            }
        } else {
            thumbFileName = null;
        }

        catalog[showName].episodes[epKey] = {
            title: epTitle,
            episodeNumber: epNumber,
            thumbSaved: !!thumbFileName,
            thumbFileName: thumbFileName
        };
        localStorage.setItem('offline_catalog', JSON.stringify(catalog));

    } catch (e) {
        console.error("Failed to save episode metadata:", e);
    }
}

export async function scanLocalOPFSDirectory() {
    try {
        if (!navigator.storage || !navigator.storage.getDirectory) return;
        const opfsRoot = await navigator.storage.getDirectory();

        let fileCount = 0;
        let totalBytes = 0;

        for await (const [name, handle] of opfsRoot.entries()) {
            if (handle.kind === 'file') {
                const file = await handle.getFile();
                fileCount++;
                totalBytes += file.size;
            }
        }

        if (fileCount > 0) {
            const totalGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(2);
            console.log(`📊 OPFS Summary: ${fileCount} files, using ${totalGB} GB total.`);
        }
    } catch (error) {
        console.error("Failed to read OPFS directory:", error);
    }
}