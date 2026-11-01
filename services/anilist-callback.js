import {
    ANILIST_PENDING_KEY, ANILIST_RESULT_KEY, parseAuthorizationResponse, fetchAniListViewer, saveAniListSession
} from './anilist-auth.js';

// This entry deliberately does not load Supabase or the main app. Remove OAuth
// credentials from history before making any requests or registering the PWA.
const callbackUrl = window.location.href;
window.history.replaceState(null, '', window.location.pathname);

async function completeConnection() {
    try {
        const pending = JSON.parse(sessionStorage.getItem(ANILIST_PENDING_KEY) || 'null');
        sessionStorage.removeItem(ANILIST_PENDING_KEY);
        const credentials = parseAuthorizationResponse(callbackUrl, pending);
        const viewer = await fetchAniListViewer(credentials.accessToken);
        saveAniListSession({ ...credentials, viewer }, pending.trustDevice === true);
        sessionStorage.setItem(ANILIST_RESULT_KEY, JSON.stringify({ success: true }));
    } catch (error) {
        try {
            sessionStorage.setItem(ANILIST_RESULT_KEY, JSON.stringify({ success: false, message: error.message }));
        } catch {
            document.getElementById('callback-status').textContent = 'Allow browser storage, then return to Theama and connect again.';
            return;
        }
    }
    window.location.replace('/?integration=anilist');
}

completeConnection();
