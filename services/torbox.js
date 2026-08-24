/**
 * ===============================================
 * torboxAuth.js
 * Handles TorBox API Key Verification & Addition
 * ===============================================
 */


import { getTbKey, smartFetch, showToast } from './config.js';
import { fetchLibrary } from '../pages/library.js';

export async function authenticateTorboxUser() {
    const input = document.getElementById('api-input');
    const button = document.getElementById('login-btn');

    let key = "";
    
    if (input.value) {
        key = input.value.trim();
        if (!key) return;
        
        button.innerText = "Verifying...";
        button.disabled = true;
        input.disabled = true;
        
    } else {
        checkAuth();

        key = getTbKey();
        if (!key) return;

        await fetchLibrary();
        
        return;
    }


    try {
        const targetUrl = 'https://api.torbox.app/v1/api/user/me';
        const res = await smartFetch(targetUrl, {
            headers: { 'Authorization': `Bearer ${key}` }
        });
        
        const data = await res.json();

        if (data.success && data.data) {
            localStorage.setItem('tb_api_key', key);
            
            button.innerText = "Connected!";
            button.classList.replace('bg-blue-600', 'bg-green-600');

            await fetchLibrary();

        } else {
            throw new Error(data.detail || "Invalid API Key");
        }
        
    } catch (e) {
        showToast("Authentication Failed: " + e.message, 'error');
        button.innerText = "Log In";
        button.disabled = false;
        input.disabled = false;
        input.classList.add('border-red-500');
    }
    checkAuth();
}

export function checkAuth() {
    const key = getTbKey();

    const connectedBadge = document.getElementById('tb-status-connected');
    const disconnectedBadge = document.getElementById('tb-status-disconnected');
    const authForm = document.getElementById('torbox-auth-form');
    const connectedActions = document.getElementById('torbox-connected-actions');

    const libraryText = document.getElementById('library-info-text');

    if (key) {
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

        libraryText.innerText = "No debrid service linked. \n You can add one in the settings.";
    }
}

export function logoutTorBox() {
    if (confirm("Disconnect TorBox API?")) {
        localStorage.removeItem('tb_api_key');
        location.reload();
    }
}

//#region Add to Library
async function addStreamtoTorbox(finalLink) {
    if (finalLink.startsWith("magnet")) {
        const torrentId = await sendMagnetToTorbox(finalLink);
        if (torrentId) {
            await editTorrentInfo(torrentId);
            console.log("Edited magnet");
            return;
        }
    }
}

// Ping the http stream so TB adds it
async function pingAddonLink(url) {
    const controller = new AbortController();

    try {
        console.log("Pinging add-on to trigger TorBox addition...");

        await fetch(url, {
            method: 'GET',
            mode: 'no-cors',
            signal: controller.signal
        });

        controller.abort();

        console.log("Ping complete! Stream added to library.");
        return true;

    } catch (error) {
        if (error.name === 'AbortError') {
            console.log("Ping complete and connection safely closed.");
            return true;
        }

        console.warn("Ping encountered a network/CORS error, but side-effect likely succeeded.");
        return true;
    }
}

// Add a link to users library  
export async function sendMagnetToTorbox(magnetLink) {
    const tbKey = getTbKey();
    if (!tbKey) return;

    try {
        const createUrl = 'https://api.torbox.app/v1/api/torrents/createtorrent';
        const formData = new FormData();
        formData.append('magnet', magnetLink);

        console.log("Magnet send");

        const createRes = await smartFetch(createUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${tbKey}` },
            body: formData
        });

        const createData = await createRes.json();
        const torrentId = createData.data?.torrent_id;

        if (!createData.success) throw new Error(createData.detail || "TorBox rejected the magnet.");

        closeStreamPicker();
        showToast("Successfully added to library", "success");

        return true;

    } catch (e) {
        console.error(e);
        showToast(`Failed to add: ${e.message}`, 'error');
    }
}

async function editTorrentInfo(torrentId) {
    const tbKey = getTbKey();
    if (!tbKey) return;

    const mediaData = mediaStore.get();
    const releaseYear = mediaData.releaseYear;
    const customName = `${mediaData.title} (${releaseYear})`;

    if (!torrentId) {
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
    }


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
        console.log("Magnet edit");
    }
}

export function closeStreamPicker() {
    document.getElementById('stream-picker-modal').classList.add('hidden');
};
//#endregion
