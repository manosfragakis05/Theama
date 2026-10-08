/**
 * ===============================================
 * torboxAuth.js
 * Handles TorBox API Key Verification & Addition
 * ===============================================
 */


import { smartFetch, showToast } from './config.js';
import { getCurrentUserSettings, saveTorboxKey, deleteTorboxKey} from '../user-data/user-settings.js';
import { fetchLibrary } from '../pages/library.js';
import { mediaStore } from '../api.js';

export async function authenticateTorboxUser() {
    const input = document.getElementById('api-input');
    const button = document.getElementById('login-btn');

    let key = "";

    // IF INPUT IS EMPTY GET KEY FROM EITHER METHOD
    if (input.value) {
        key = input.value.trim();
        if (!key) return;

        button.innerText = "Verifying...";
        button.disabled = true;
        input.disabled = true;

    } else {
        key = getCurrentUserSettings().user_preferences.torboxApiKey;
        
        checkAuth();
        console.log(key);
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

            button.innerText = "Connected!";
            button.classList.replace('bg-blue-600', 'bg-green-600');

            fetchLibrary();

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


// Renderer and final check
function checkAuth() {
    const key = getCurrentUserSettings().user_preferences.torboxApiKey;

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

export async function logoutTorBox() {
    if (confirm("Disconnect TorBox API?")) {
        await deleteTorboxKey();
        window.location.reload();
    }
}

//#region Add to Library
export async function addStreamtoTorbox(finalLink) {
    if (finalLink.startsWith("magnet")) {
        const torrentId = await sendMagnetToTorbox(finalLink);
        if (torrentId) {
            await editTorrentInfo(torrentId);
            console.log("Edited magnet");
            return;
        } else {
            console.log
        }
    }
}

// Add a link to users library  
async function sendMagnetToTorbox(magnetLink) {
    const tbKey = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!tbKey) return;

    const currentMedia = mediaStore.get();
    const customName = currentMedia ? `${currentMedia.title} (${currentMedia.year})`.trim() : `${currentMedia.title}`;

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

        console.log('TorBox createtorrent response:', createData);

        if (!createData.success) {
            throw new Error(
                createData.detail || 'TorBox rejected the magnet.'
            );
            return;
        }

        closeStreamPicker();
        showToast('Successfully added to library', 'success');

        return createData.data?.torrent_id;

    } catch (e) {
        console.error('TorBox create failed:', e);
        showToast(`Failed to add: ${e.message}`, 'error');
    }
}

async function editTorrentInfo(torrentId) {
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
