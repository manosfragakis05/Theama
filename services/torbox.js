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
import { addToAppLibrary } from '../pages/app-library.js';

import { requestTorboxDeviceCode, waitForTorboxDeviceToken } from './torbox-device-auth.js';
import { requestLink } from '../streaming/player.js';

import { startQueueFromItem } from '../streaming/playlist.js';

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
export async function addStreamtoTorbox(hash, rawStream) {
    const key = getCurrentUserSettings().user_preferences.torboxApiKey;

    const magnetLink = hash ? `magnet:?xt=urn:btih:${hash}` : null;

    const media = mediaStore.get();
    const playOnAdd = shouldPlayOnAdd();

    console.log(media, rawStream);

    let response;
    if (magnetLink && key) {
        response = await sendMagnetToTorbox(magnetLink, media);
    } else {
        response = await sendUrltoTorbox(rawStream.url);
    }
    
    if (!response) return;
    await Promise.all([
        (async () => {
            try {
                await addToAppLibrary(media, hash || rawStream.url);
                showToast(`Added ${media.title} to library`, 'success');
            } catch (error) {
                showToast('Added to TorBox, but could not save to your Theama library.', 'error');
                console.error('App library save failed:', error);
            }
        })(),
        playOnAdd ? playAddedItem(rawStream.url, { ...media, hash }) : Promise.resolve()
    ]);
}

async function playAddedItem(source, media = mediaStore.get()) {
    try {
        const current = startQueueFromItem({
            sourceType: 'addon', sourceMediaId: String(media.id), streamId: media.streamId,
            hash: media.hash,
            tid: `addon:${media.id}`, fid: `addon:${media.seasonNumber ?? 1}:${media.episodeNumber ?? 1}`,
            tmdbId: media.tmdbId, mediaType: media.type === 'movie' ? 'movie' : 'tv',
            seasonNumber: media.seasonNumber, episodeNumber: media.episodeNumber,
            watchEpisodeNumber: media.episodeNumber,
            title: media.title, thumbnail: media.poster, torrentName: media.title,
            fileName: media.fileName || media.title || 'Stream'
        });
        closeStreamPicker();

        return await requestLink(current.tid, current.fid, current.torrentName, current.fileName, current.uid,
            media.resumePosition || 0, { sourceUrl: source });
    } catch (error) {
        console.error('Play after add failed:', error);
        showToast(`Could not play: ${error.message}`, 'error');
        return false;
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
        const createUrl = 'https://api.torbox.app/v1/api/torrents/createtorrent';

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

        return createData.data;

    } catch (e) {
        console.error('TorBox create failed:', e);
        showToast(`Failed to add: ${e.message}`, 'error');
    }
}

// Ping the configured add-on without following playback redirects or reading
// media. The add-on's TorBox submission cannot be validated by this request.
async function sendUrltoTorbox(streamUrl) {
    try {
        let source;
        try { source = new URL(streamUrl); } catch { /* Report invalid input below. */ }
        if (!source || !['http:', 'https:'].includes(source.protocol)) {
            throw new Error('Provide an HTTP or HTTPS add-on playback URL.');
        }

        const response = await fetch(source.href, {
            method: 'GET',
            redirect: 'manual',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            cache: 'no-store'
        });
        await response.body?.cancel();
        const redirected = response.type === 'opaqueredirect'
            || [301, 302, 303, 307, 308].includes(response.status);
        if (!response.ok && !redirected) {
            throw new Error(`Add-on request failed (HTTP ${response.status}).`);
        }

        return { response };
    } catch (error) {
        console.error('[TorBox] Add-on request failed:', error);
        showToast(`Could not request this source: ${error.message}`, 'error');
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

//#region Cloud
export async function getTorboxCloudList(key, torboxType = 'torrent') {
    const section = torboxType === 'usenet' ? 'usenet' : 'torrents';
    const response = await smartFetch(`https://api.torbox.app/v1/api/${section}/mylist?bypass_cache=true`, {
        headers: { Authorization: `Bearer ${key}` }
    });
    const result = await response.json();
    if (!response.ok || !result.success || !Array.isArray(result.data)) {
        throw new Error(`Could not load your TorBox ${section} downloads.`);
    }
    return result.data.map(item => ({ ...item, torboxType }));
}

export function isReadyCloudDownload(item) {
    return Boolean(item.download_finished && (item.torboxType !== 'usenet'
        || (item.cached !== false && item.download_present !== false)));
}

//#endregion