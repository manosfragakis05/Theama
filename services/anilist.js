import {
    ANILIST_SESSION_KEY, ANILIST_PENDING_KEY, ANILIST_RESULT_KEY,
    createAuthorization, fetchAniListViewer, readAniListSession, saveAniListSession, clearAniListSession
} from './anilist-auth.js';
import { appState } from './config.js';
import { supabase } from '../user-data/db.js';
import { createAniListProfileStore } from '../user-data/anilist-profile-data.js';
import { updatePublicProfile } from '../user-data/network.js';

const clientId = import.meta.env.VITE_ANILIST_CLIENT_ID?.trim();
const configured = /^\d+$/.test(clientId || '');
let generation = 0;
let initialized = false;
let renderedConnectionToken;
const publicProfiles = createAniListProfileStore(supabase, () => appState.currentUser?.id);
let profileUpdate = Promise.resolve();

function queueProfileUpdate(operation) {
    const result = profileUpdate.catch(() => {}).then(operation);
    profileUpdate = result;
    return result;
}

function renderConnection(connection, message = '', { checking = false, retry = false } = {}) {
    const connected = Boolean(connection);
    const badge = document.getElementById('anilist-status');
    badge.textContent = checking ? 'Checking...' : connected ? 'Connected' : 'Disconnected';
    badge.className = connected
        ? 'shrink-0 bg-green-500/10 text-green-500 px-2.5 py-1 rounded-md text-xs font-bold border border-green-500/20'
        : 'shrink-0 bg-slate-900/50 text-slate-300 px-2.5 py-1 rounded-md text-xs font-bold border border-slate-700';
    const account = document.getElementById('anilist-account');
    account.classList.toggle('hidden', !connected);
    const profile = document.getElementById('anilist-profile');
    profile.textContent = connection?.viewer.name || '';
    if (connected) profile.href = `https://anilist.co/user/${encodeURIComponent(connection.viewer.name)}`;
    else profile.removeAttribute('href');
    const connect = document.getElementById('anilist-connect-btn');
    connect.classList.toggle('hidden', connected);
    connect.disabled = !configured || checking;
    document.getElementById('anilist-disconnect-btn').classList.toggle('hidden', !connected);
    document.getElementById('anilist-retry-btn').classList.toggle('hidden', !retry || checking);
    const status = document.getElementById('anilist-message');
    status.textContent = message || (!configured ? 'AniList connection is not available yet.' : '');
    status.classList.toggle('hidden', !status.textContent);
    const token = connection?.accessToken || null;
    if (token !== renderedConnectionToken) {
        renderedConnectionToken = token;
        window.dispatchEvent(new CustomEvent('anilist:connection-changed'));
    }
}

async function refreshConnection(message = '') {
    const current = ++generation;
    const theamaUserId = appState.currentUser?.id;
    let connection;
    try { connection = readAniListSession(); } catch {
        renderConnection(null, 'Allow browser storage to connect your AniList account.');
        return;
    }
    renderConnection(connection, message, { checking: Boolean(connection) });
    if (!connection) return;
    try {
        const viewer = await fetchAniListViewer(connection.accessToken);
        if (current !== generation) return;
        const saved = readAniListSession();
        if (saved?.accessToken !== connection.accessToken) {
            renderConnection(saved);
            return;
        }
        connection = { ...connection, viewer };
        // Preserve the existing storage choice while Theama settings load.
        // In particular, never promote a session-only token to local storage.
        const persistent = !sessionStorage.getItem(ANILIST_SESSION_KEY) && Boolean(localStorage.getItem(ANILIST_SESSION_KEY));
        saveAniListSession(connection, persistent);
        if (theamaUserId) {
            try {
                await queueProfileUpdate(async () => {
                    if (current !== generation || appState.currentUser?.id !== theamaUserId) return;
                    // Ensure the profile row exists before setting its linked ID.
                    await updatePublicProfile();
                    if (current !== generation || appState.currentUser?.id !== theamaUserId) return;
                    await publicProfiles.save(theamaUserId, viewer);
                });
            } catch (error) {
                if (current === generation) renderConnection(connection, error.message, { retry: true });
                return;
            }
        }
        if (current !== generation) return;
        renderConnection(connection, message);
    } catch (error) {
        if (current !== generation) return;
        if (error.unauthorized) {
            clearAniListSession();
            renderConnection(null, error.message);
        } else {
            renderConnection(connection, error.message, { retry: true });
        }
    }
}

export function initializeAniList() {
    if (initialized) return;
    initialized = true;
    document.getElementById('anilist-connect-btn').addEventListener('click', () => {
        try {
            const authorize = createAuthorization({
                clientId,
                redirectUri: import.meta.env.VITE_ANILIST_REDIRECT_URI?.trim() || '/anilist-callback.html',
                origin: window.location.origin,
                // Read the saved device choice even if account initialization
                // is still in flight when the user selects Connect.
                trustDevice: trustsCurrentDevice()
            });
            window.location.assign(authorize);
        } catch (error) {
            renderConnection(null, error.message);
        }
    });
    document.getElementById('anilist-disconnect-btn').addEventListener('click', async () => {
        const current = ++generation;
        const userId = appState.currentUser?.id;
        let connection;
        const button = document.getElementById('anilist-disconnect-btn');
        button.disabled = true;
        try {
            connection = readAniListSession();
            if (userId) await queueProfileUpdate(() => publicProfiles.remove(userId));
            if (current !== generation) return;
            clearAniListSession();
            sessionStorage.removeItem(ANILIST_PENDING_KEY);
            sessionStorage.removeItem(ANILIST_RESULT_KEY);
            renderConnection(null, 'AniList disconnected from this device.');
        } catch (error) {
            if (current === generation) renderConnection(connection, error.message || 'Could not disconnect AniList. Please try again.');
        } finally {
            button.disabled = false;
        }
    });
    document.getElementById('anilist-retry-btn').addEventListener('click', () => refreshConnection());
    window.addEventListener('storage', event => {
        if (event.key === ANILIST_SESSION_KEY || event.key === null) refreshConnection();
    });
    let theamaUserId = appState.currentUser?.id;
    window.addEventListener('auth-state-changed', () => {
        if (theamaUserId === appState.currentUser?.id) return;
        theamaUserId = appState.currentUser?.id;
        refreshConnection();
    });
    let message = '';
    try {
        const result = JSON.parse(sessionStorage.getItem(ANILIST_RESULT_KEY) || 'null');
        sessionStorage.removeItem(ANILIST_RESULT_KEY);
        if (result) message = result.success ? 'Your AniList account is connected.' : result.message;
    } catch { /* Initial connection still works without a return message. */ }
    refreshConnection(message);
}

function trustsCurrentDevice() {
    try {
        const settings = JSON.parse(sessionStorage.getItem('user_settings') || localStorage.getItem('user_settings') || 'null');
        return settings?.user_preferences?.trustThisDevice !== false;
    } catch {
        return false;
    }
}
