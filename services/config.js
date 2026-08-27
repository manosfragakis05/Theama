/**
 * ==========================================
 * config.js
 * Global Constants, State, and Utilities
 * ==========================================
 */

//#region Constants
if (!import.meta.env.VITE_TMDB_KEY) {
    console.warn("Missing TMDB Key in .env file!");
}

export const TMDB_KEY = import.meta.env.VITE_TMDB_KEY;

export const TRAKT_CLIENT_ID = import.meta.env.VITE_TRAKT_CLIENT_ID;

export const MY_PROXY = import.meta.env.VITE_MY_PROXY;

export const SUPABASEURL = import.meta.env.VITE_SUPABASE_URL;
export const SUPABASEKEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
//#endregion

//#region Global State
export const appState = {
    currentStreamUrl: "",
    clickCooldown: false,
    allTorrents: [],
    currentTorrentId: null,
    currentUser: null
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
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');

    // 1. Premium frosted-glass colored backgrounds tailored for dark mode
    let bgColors = "bg-blue-600/60 border-blue-400/30 shadow-blue-900/50";
    let icon = 'ℹ️';

    if (type === 'success') {
        bgColors = "bg-emerald-600/60 border-emerald-400/30 shadow-emerald-900/50";
        icon = '✅';
    } else if (type === 'error') {
        bgColors = "bg-red-600/60 border-red-400/30 shadow-red-900/50";
        icon = '❌';
    }

    // 2. Build the UI
    toast.className = `${bgColors} text-white border p-4 rounded-xl shadow-lg transition-all duration-300 transform translate-y-[-20px] opacity-0 flex items-center gap-3 backdrop-blur-md pointer-events-auto w-max max-w-sm`;
    
    toast.innerHTML = `
        <span class="text-xl drop-shadow-md">${icon}</span> 
        <span class="text-sm font-bold tracking-wide leading-tight">${message}</span>
    `;

    container.appendChild(toast);

    // 3. Animate In
    setTimeout(() => {
        toast.classList.remove('translate-y-[-20px]', 'opacity-0');
        toast.classList.add('translate-y-0', 'opacity-100');
    }, 10);

    // 4. Animate Out
    setTimeout(() => {
        toast.classList.remove('translate-y-0', 'opacity-100');
        toast.classList.add('opacity-0', 'scale-95');
        setTimeout(() => toast.remove(), 300);
    }, 500);
}
//#endregion