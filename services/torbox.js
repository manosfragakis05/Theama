/**
 * ===============================================
 * torboxAuth.js
 * Handles TorBox API Key Verification & Addition
 * ===============================================
 */


import { smartFetch, showToast, appState } from './config.js';
import { getCurrentUserSettings, saveTorboxKey, deleteTorboxKey, shouldPlayOnAdd } from '../user-data/user-settings.js';

import { mediaStore } from '../api.js';

import { fetchLibrary } from '../pages/library.js';
import { addToAppLibrary, linkHashToMedia } from '../pages/app-library.js';
import { requestTorboxDeviceCode, waitForTorboxDeviceToken } from './torbox-device-auth.js';
import { requestLink } from '../streaming/player.js';
import { buildSeriesQueue, startQueueFromEpisode, startQueueFromItem } from '../streaming/playlist.js';
import { buildSelectedTorrentQueue } from '../metadata/picker.js';
import { getStreamHash } from '../utils/streams.js';

let pairingController = null;
let pairingUserId;
let manualAuthenticationPending = false;

function cancelTorboxPairing() {
    pairingController?.abort();
    pairingController = null;
    pairingUserId = undefined;
    document.getElementById('torbox-pairing').classList.add('hidden');
    document.getElementById('torbox-pair-code').textContent = '';
    document.getElementById('torbox-pair-link').removeAttribute('href');
    document.getElementById('torbox-pair-status').classList.add('hidden');
    document.getElementById('torbox-pair-cancel').disabled = false;
    document.getElementById('login-btn').disabled = manualAuthenticationPending;
    const button = document.getElementById('torbox-pair-btn');
    button.disabled = manualAuthenticationPending;
    button.textContent = 'Pair with TorBox';
}

export function initializeTorboxPairing() {
    document.getElementById('torbox-pair-btn').addEventListener('click', startTorboxPairing);
    document.getElementById('torbox-pair-cancel').addEventListener('click', cancelTorboxPairing);
    window.addEventListener('pagehide', cancelTorboxPairing);
    window.addEventListener('auth-state-changed', () => {
        // Supabase also emits auth events on tab focus and token refresh.
        // Only an account change should discard an active TorBox authorization.
        if (pairingController && pairingUserId !== (appState.currentUser?.id ?? null)) {
            cancelTorboxPairing();
        }
    });
}

async function startTorboxPairing() {
    if (manualAuthenticationPending) return;
    cancelTorboxPairing();
    const controller = new AbortController();
    pairingController = controller;
    pairingUserId = appState.currentUser?.id ?? null;
    const button = document.getElementById('torbox-pair-btn');
    const status = document.getElementById('torbox-pair-status');
    const setStatus = message => {
        status.textContent = message;
        status.classList.remove('hidden');
    };
    button.disabled = true;
    button.textContent = 'Generating code…';

    // Bound the initial request too, so a failed connection leaves a retry action.
    const startTimeout = setTimeout(() => controller.abort(new Error('TorBox took too long to respond. Please try again.')), 30000);
    try {
        const authorization = await requestTorboxDeviceCode(smartFetch, controller.signal);
        clearTimeout(startTimeout);
        controller.signal.throwIfAborted();
        document.getElementById('torbox-pair-code').textContent = authorization.code;
        document.getElementById('torbox-pair-expiry').textContent = `Expires at ${new Date(authorization.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        document.getElementById('torbox-pair-link').href = authorization.verificationUrl;
        document.getElementById('torbox-pairing').classList.remove('hidden');
        button.textContent = 'Generate new code';
        button.disabled = false;
        setStatus('Waiting for approval on TorBox…');

        const key = await waitForTorboxDeviceToken(authorization, {
            request: smartFetch,
            signal: controller.signal,
            onStatus: setStatus
        });
        controller.signal.throwIfAborted();
        // Once authorized, finish saving before allowing another authentication attempt.
        button.disabled = true;
        document.getElementById('torbox-pair-cancel').disabled = true;
        document.getElementById('login-btn').disabled = true;
        setStatus('Connecting TorBox…');
        await saveTorboxKey(key);
        if (pairingController !== controller) return;
        document.getElementById('api-input').value = '';
        cancelTorboxPairing();
        checkAuth();
        showToast('TorBox connected successfully.', 'success');
        fetchLibrary();
    } catch (error) {
        if (pairingController !== controller) return;
        const message = controller.signal.aborted && controller.signal.reason instanceof Error
            ? controller.signal.reason.message : error.message;
        cancelTorboxPairing();
        setStatus(message || 'Could not pair with TorBox. Please try again.');
        button.textContent = 'Try pairing again';
    } finally {
        clearTimeout(startTimeout);
    }
}


export async function authenticateTorboxUser() {
    if (manualAuthenticationPending) return;
    const input = document.getElementById('api-input');
    const button = document.getElementById('login-btn');

    let key = "";

    // IF INPUT IS EMPTY GET KEY FROM EITHER METHOD
    if (input.value) {
        key = input.value.trim();
        if (!key) return;
        cancelTorboxPairing();
        manualAuthenticationPending = true;

        button.innerText = "Verifying...";
        button.disabled = true;
        input.disabled = true;
        input.classList.remove('border-red-500');
        document.getElementById('torbox-pair-btn').disabled = true;

    } else {
        key = getCurrentUserSettings().user_preferences.torboxApiKey;

        checkAuth();
        if (!key) return;
        fetchLibrary();

        return;
    }


    try {
        const targetUrl = 'https://api.torbox.app/v1/api/user/me';
        const res = await smartFetch(targetUrl, {
            headers: { 'Authorization': `Bearer ${key}` }
        });

        const data = await res.json();

        // If the user is found save key even if its saved (COULD OPTIMIZE)
        if (data.success && data.data) {
            const currentKey = getCurrentUserSettings().user_preferences.torboxApiKey;
            if (currentKey !== key) {
                await saveTorboxKey(key);
            }

            input.value = '';

            fetchLibrary();

        } else {
            throw new Error(data.detail || "Invalid API Key");
        }

    } catch (e) {
        showToast("Authentication Failed: " + e.message, 'error');
        input.classList.add('border-red-500');
    } finally {
        manualAuthenticationPending = false;
        button.innerText = 'Connect with API key';
        button.disabled = false;
        input.disabled = false;
        document.getElementById('torbox-pair-btn').disabled = false;
    }
    checkAuth();
}


// Renderer and final check
function checkAuth() {
    const key = getCurrentUserSettings().user_preferences.torboxApiKey;

    const connectedBadge = document.getElementById('tb-status-connected');
    const disconnectedBadge = document.getElementById('tb-status-disconnected');
    const authForm = document.getElementById('torbox-auth-form');
    const connectedActions = document.getElementById('torbox-connected-actions');

    const libraryText = document.getElementById('library-info-text');
    document.getElementById('link-torbox-btn')?.classList.toggle('hidden', Boolean(key));

    if (key) {
        cancelTorboxPairing();
        // User is connected
        connectedBadge.classList.replace('hidden', 'flex');
        disconnectedBadge.classList.replace('flex', 'hidden');
        authForm.classList.add('hidden');
        connectedActions.classList.remove('hidden');
    } else {
        // User is disconnected
        connectedBadge.classList.replace('flex', 'hidden');
        disconnectedBadge.classList.replace('hidden', 'flex');
        authForm.classList.remove('hidden');
        connectedActions.classList.add('hidden');

        libraryText.innerText = 'Link TorBox to view your cloud library.';
        libraryText.classList.remove('hidden');
    }
}

export async function logoutTorBox() {
    if (confirm("Disconnect TorBox API?")) {
        await deleteTorboxKey();
        window.location.reload();
    }
}


//#region Add to Library
export async function addStreamtoTorbox(finalLink, selectedMedia = mediaStore.get(), rawStream = {}) {
    const media = { ...selectedMedia };
    const key = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!key || /^https?:\/\//i.test(finalLink || '')) {
        const directUrl = rawStream.url || finalLink;
        let parsedUrl;
        try {
            parsedUrl = new URL(directUrl);
        } catch {
            // Hash-only sources cannot be played without a torrent service.
        }
        if (!parsedUrl || !['http:', 'https:'].includes(parsedUrl.protocol)) {
            showToast('This source has no direct video URL. Choose a direct stream or connect TorBox.', 'error');
            return;
        }
        let fileName = parsedUrl.pathname.split('/').pop();
        try { fileName = decodeURIComponent(fileName); } catch { /* Keep the original filename. */ }
        const name = rawStream.behaviorHints?.filename
            || (/\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i.test(fileName) ? fileName : media.title)
            || 'Direct stream';
        const userId = appState.currentUser?.id;
        const hash = getStreamHash(rawStream, finalLink);
        const item = userId ? startQueueFromItem({
            sourceType: 'addon', sourceMediaId: String(media.id), streamId: media.streamId || '',
            sourceHashes: hash ? [hash] : [], hash,
            tid: `addon:${media.id}`, fid: `addon:${media.seasonNumber ?? 1}:${media.episodeNumber ?? 1}`,
            tmdbId: media.tmdbId, mediaType: media.type === 'movie' ? 'movie' : 'tv',
            seasonNumber: media.seasonNumber, episodeNumber: media.episodeNumber,
            watchEpisodeNumber: media.episodeNumber, title: media.title,
            thumbnail: media.poster, torrentName: media.title, fileName: name
        }) : null;
        // The queue contains metadata and hashes only; playback URLs stay in memory.
        closeStreamPicker();
        const started = await requestLink(item?.tid ?? null, item?.fid ?? null, media.title, name,
            item?.uid ?? null, media.resumePosition || 0, { sourceUrl: directUrl });
        if (started && userId && userId === appState.currentUser?.id && !media.skipLibrarySave) {
            try {
                await addToAppLibrary(media);
                if (userId === appState.currentUser?.id) await linkHashToMedia(media, hash || null, true);
            } catch (error) {
                console.error('App library save failed:', error);
                showToast('Playback started, but this title could not be saved to your library.', 'error');
            }
        }
        return;
    }
    const playOnAdd = shouldPlayOnAdd();
    const userId = appState.currentUser?.id;
    const isCurrent = () => userId === appState.currentUser?.id
        && key === getCurrentUserSettings().user_preferences.torboxApiKey;
    if (finalLink?.startsWith("magnet")) {
        const createData = await sendMagnetToTorbox(finalLink, media);
        if (!isCurrent()) return;
        if (createData) {
            // Start playback without waiting for the cloud library refresh.
            await Promise.all([
                (async () => {
                    try {
                        await addToAppLibrary(media);
                        if (isCurrent()) await linkHashToMedia(media, createData.hash, true);
                    } catch (error) {
                        if (isCurrent()) showToast('Added to TorBox, but could not save to your Theama library.', 'error');
                        console.error('App library save failed:', error);
                    }
                })(),
                playOnAdd ? playAddedTorrent(createData, media, key, isCurrent) : Promise.resolve()
            ]);
        }
    }
}

async function playAddedTorrent(created, media, key, isCurrent) {
    try {
        const torrentId = created.torrent_id ?? created.id;
        if (torrentId == null) throw new Error('TorBox did not return a torrent ID.');
        const res = await smartFetch(
            `https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true&id=${encodeURIComponent(torrentId)}`,
            { headers: { Authorization: `Bearer ${key}` } }
        );
        if (!isCurrent()) return;
        if (!res.ok) throw new Error('Could not load the added torrent.');
        const result = await res.json();
        if (!isCurrent()) return;
        if (!result.success || !result.data) throw new Error(result.detail || 'Could not load the added torrent.');
        const torrent = result.data;
        if (String(torrent.id) !== String(torrentId)) throw new Error('TorBox returned a different torrent.');
        if (!torrent.download_finished) throw new Error('This torrent is not ready yet. Check its download in TorBox.');

        let current;
        if (media.type === 'series' || media.type === 'tv') {
            const episodes = await buildSelectedTorrentQueue(torrent, media);
            if (!isCurrent()) return;
            if (!episodes.length) throw new Error('The selected episode was not found in this torrent.');
            buildSeriesQueue(episodes);
            current = startQueueFromEpisode();
        } else {
            const files = (torrent.files || []).filter(file => /\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i.test(file.name));
            const file = files.filter(file => !/(?:^|[\W_])sample(?:[\W_]|$)/i.test(file.name))
                .sort((a, b) => (b.size || 0) - (a.size || 0))[0] || files[0];
            if (!file) throw new Error('No playable file was found in this torrent.');
            current = startQueueFromItem({
                tid: torrent.id, fid: file.id, hash: torrent.hash,
                torrentName: torrent.name, fileName: file.name,
                tmdbId: media.tmdbId, mediaType: 'movie', title: media.title, thumbnail: media.poster
            });
        }
        await requestLink(current.tid, current.fid, current.torrentName, current.fileName, current.uid);
    } catch (error) {
        console.error('Play after add failed:', error);
        if (isCurrent()) showToast(`Added to library, but could not play: ${error.message}`, 'error');
    }
}

// Add a link to users library  
async function sendMagnetToTorbox(magnetLink, currentMedia) {
    const tbKey = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!tbKey) {
        showToast('Link TorBox in settings to add media.', 'error');
        return;
    }

    const customName = currentMedia.year ? `${currentMedia.title} (${currentMedia.year})` : currentMedia.title;

    try {
        const createUrl =
            'https://api.torbox.app/v1/api/torrents/createtorrent';

        const formData = new FormData();

        formData.append('magnet', magnetLink);
        formData.append('name', customName);

        const createRes = await smartFetch(createUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tbKey}`
            },
            body: formData
        });

        const createData = await createRes.json();

        if (!createData.success) {
            throw new Error(
                createData.detail || 'TorBox rejected the magnet.'
            );
        }

        closeStreamPicker();
        showToast('Successfully added to library', 'success');

        return createData.data;

    } catch (e) {
        console.error('TorBox create failed:', e);
        showToast(`Failed to add: ${e.message}`, 'error');
    }
}

async function editTorboxInfo(torrentId) {
    const tbKey = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!tbKey) return;

    const currentMedia = mediaStore.get();
    const customName = currentMedia.year ? `${currentMedia.title} (${currentMedia.year})`.trim() : `${currentMedia.title}`;

    /*if (!torrentId) {
       try {
           const listUrl = 'https://api.torbox.app/v1/api/torrents/mylist';
           const listRes = await smartFetch(listUrl, {
               headers: { 'Authorization': `Bearer ${tbKey}` }
           });
           const listData = await listRes.json();

           if (listData.success && listData.data && listData.data.length > 0) {
               const latestTorrent = listData.data[0];
               const latestTorrentId = latestTorrent.id || latestTorrent.torrent_id;

               const editUrl = 'https://api.torbox.app/v1/api/torrents/edittorrent';
               await smartFetch(editUrl, {
                   method: 'PUT',
                   headers: {
                       'Authorization': `Bearer ${tbKey}`,
                       'Content-Type': 'application/json'
                   },
                   body: JSON.stringify({
                       torrent_id: latestTorrentId,
                       name: customName
                   })
               });
           }

           closeStreamPicker();
           showToast("Successfully added and renamed in TorBox!", "success");
           return;
       } catch (e) {
           console.error("Smart link ping failed:", e);
           showToast("Failed to trigger smart link.", "error");
           return;
       }
       console.log("Http edit");
   }*/


    // Magnet Edit
    if (torrentId) {
        const editUrl = 'https://api.torbox.app/v1/api/torrents/edittorrent';
        const editBody = { torrent_id: torrentId, name: customName };

        await smartFetch(editUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${tbKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(editBody)
        });
    }
}

export function closeStreamPicker() {
    document.getElementById('stream-picker-modal').classList.add('hidden');
};
//#endregion
