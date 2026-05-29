/**
 * ==========================================
 * config.js
 * Global Constants, State, and Utilities
 * ==========================================
 */

//#region Constants
export const TMDB_KEY = 'ee7a32cee36ed0cd1f028f10c32fa0cf';

export const TRAKT_CLIENT_ID = '027c95542a22d861d8a4e82b7535560b457639527f09b5526315682c611488c9';

// PASTE YOUR CLOUDFLARE URL BELOW (keep the /?url= at the end!)
export const MY_PROXY = "https://bt-kd-8478.manosfragakis05.workers.dev/?url=";
//#endregion

//#region Global State
// By keeping all variables inside an object, other modules can safely update them 
// without triggering read-only ES6 import errors.
export const appState = {
    currentStreamUrl: "",
    clickCooldown: false,
    allTorrents: [],
    currentTorrentId: null
};
//#endregion

//#region Core Utilities
export const getTbKey = () => localStorage.getItem('tb_api_key');

// Cloudflare Proxy Fetcher
export async function smartFetch(targetUrl, options = {}) {
    return fetch(MY_PROXY + encodeURIComponent(targetUrl), options);
}

// GLOBAL NOTIFICATION UI
export function showToast(message, type = 'info') {
    const toast = document.createElement('div');

    // Set colors and icons based on the type
    let bgColors = "bg-blue-600 border-blue-500";
    let icon = 'ℹ️';

    if (type === 'success') {
        bgColors = "bg-emerald-700 border-emerald-500";
        icon = '✅';
    } else if (type === 'error') {
        bgColors = "bg-red-700 border-red-500";
        icon = '❌';
    }

    // Modern, sliding, premium UI
    toast.className = `fixed top-5 right-5 ${bgColors} text-white border p-4 rounded-xl shadow-2xl z-[9999] transition-all duration-300 transform translate-y-[-20px] opacity-0 flex items-center gap-3 backdrop-blur-md`;

    toast.innerHTML = `
        <span class="text-xl drop-shadow-md">${icon}</span> 
        <span class="text-sm font-bold tracking-wide leading-tight">${message}</span>
    `;

    document.body.appendChild(toast);

    // 1. Animate In
    requestAnimationFrame(() => {
        toast.classList.remove('translate-y-[-20px]', 'opacity-0');
        toast.classList.add('translate-y-0', 'opacity-100');
    });

    // 2. Wait 3 seconds, Animate Out, then Delete
    setTimeout(() => {
        toast.classList.remove('translate-y-0', 'opacity-100');
        toast.classList.add('translate-y-[-20px]', 'opacity-0');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
//#endregion