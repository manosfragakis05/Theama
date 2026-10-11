import { getCurrentUserSettings } from '../user-data/user-settings.js';
import { smartFetch, showToast } from '../services/config.js';

// --- DOWNLOAD ---

/**
 * Requests a direct CDN link from TorBox and triggers a download.
 * On iOS standalone PWAs (no native download manager), tries Chrome,
 * Brave, then Firefox via custom URL schemes before falling back to
 * the native share sheet.
 *
 * @param {string|number} torrentId
 * @param {string|number} fileId
 * @param {string} fileName - used as the share-sheet title on iOS fallback
 */
export async function downloadFile(torrentId, fileId, fileName) {
    const key = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!key) {
        showToast("API key not found.", "error");
        return;
    }

    showToast("Starting download...", "info");

    try {
        const apiUrl = `https://api.torbox.app/v1/api/torrents/requestdl?token=${key}&torrent_id=${torrentId}&file_id=${fileId}`;
        const response = await smartFetch(apiUrl);
        const result = await response.json();

        if (!result.success || !result.data) {
            showToast(result.detail || "Failed to get download link.", "error");
            return;
        }

        const cdnUrl = result.data;

        if (isIOS() && isStandalonePWA()) {
            await openWithBrowserFallbackChain(cdnUrl, fileName);
            return;
        }

        const a = document.createElement('a');
        a.href = cdnUrl;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

    } catch (error) {
        console.error("Download error:", error);
        showToast("Network error starting download.", "error");
    }
}

function attemptOpenScheme(schemeUrl, timeout = 500) {
    return new Promise((resolve) => {
        let backgrounded = false;
        const onVisibilityChange = () => {
            if (document.hidden) backgrounded = true;
        };
        document.addEventListener('visibilitychange', onVisibilityChange);

        window.location.href = schemeUrl;

        setTimeout(() => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            resolve(backgrounded);
        }, timeout);
    });
}

async function openWithBrowserFallbackChain(url, shareTitle) {
    const chromeUrl = url.replace(/^https:\/\//, 'googlechromes://')
        .replace(/^http:\/\//, 'googlechrome://');
    const braveUrl = `brave://open-url?url=${encodeURIComponent(url)}`;
    const firefoxUrl = `firefox://open-url?url=${encodeURIComponent(url)}`;

    if (await attemptOpenScheme(chromeUrl)) return;
    if (await attemptOpenScheme(braveUrl)) return;
    if (await attemptOpenScheme(firefoxUrl)) return;

    // None of the three appear installed — fall back to the share sheet
    if (navigator.share) {
        try {
            await navigator.share({ url, title: shareTitle });
        } catch (shareErr) {
            showToast("Open this link in Safari to download.", "info");
        }
    } else {
        showToast("Downloads don't work in the installed app — open this site in Safari instead.", "info");
    }
}

function isIOS() {
    const ua = navigator.userAgent;
    const isIPad = ua.includes('Macintosh') && navigator.maxTouchPoints > 1;
    return /iPad|iPhone|iPod/.test(ua) || isIPad;
}

function isStandalonePWA() {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
}

