/**
 * ==========================================
 * ui.js
 * Handles Navigation, Search, and External Players
 * ==========================================
 */

import { appState, showToast } from './services/config.js';
import { renderList } from './pages/library.js';
import { searchTMDB, loadDiscover } from './api.js';
import { stopPlayback } from './streaming/player.js';

// --- NAVIGATION & TABS ---

export function goHome() {
    stopPlayback();

    document.getElementById('player-wrapper').classList.add('hidden');
    document.getElementById('search-input').value = '';
    switchTab('library-page');
}

export function switchTab(targetId) {
    // 1. Hide ALL pages
    document.querySelectorAll('.page-view').forEach(page => {
        page.classList.add('hidden');
    });

    // 2. Show the TARGET page
    const targetPage = document.getElementById(targetId);
    if (targetPage) {
        targetPage.classList.remove('hidden');
    }

    // 3. Remove 'active' state from ALL navigation buttons
    document.querySelectorAll('.nav-link').forEach(btn => {
        btn.classList.remove('active');
    });

    // 4. Add 'active' state to the matching buttons (both PC and Mobile)
    document.querySelectorAll(`.nav-link[data-target="${targetId}"]`).forEach(btn => {
        btn.classList.add('active');
    });

    // 5. Page-Specific Logic
    handlePageSpecificLogic(targetId);
}

function handlePageSpecificLogic(pageId) {
    switch (pageId) {
        case 'library-page':
            // E.g., refresh library or reset views
            break;
        case 'discover-page':
            // Only fetch from the API if the grid is empty!
            if (document.getElementById('trending-movies-row').innerHTML.trim() === '') {
                loadDiscover();
            }
            break;
        case 'settings-tab':
            // E.g., load user preferences
            break;
    }
}

// Profile Dropdown
export function toggleProfile(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('profile-dropdown');
    menu.classList.toggle('hidden');
}

function updateProfileDropdown() {
    const dropdown = document.getElementById('profile-dropdown');
    if (!dropdown) return;

    // Start with your base header that is always there
    let htmlContent = "";

    // Check our Single Source of Truth
    if (appState.currentUser) {
        // Logged In State
        const username = appState.currentUser.user_metadata?.username || 'User';
        const email = appState.currentUser.email || '';

        htmlContent += `
            <div class="mb-4">
                <p class="font-bold text-white text-lg truncate">Welcome ${username}!</p>
                ${email ? `<p class="text-xs text-slate-400 truncate">${email}</p>` : ''}
            </div>
            <hr class="border-slate-700 my-2">
            <button onclick="switchTab('profile-page')" class="w-full text-left px-3 py-2 hover:bg-slate-700 rounded-lg text-sm text-slate-300 transition-colors">
                Public Profile
            </button>
            <button onclick="logOutUser()" class="w-full text-left px-3 py-2 hover:bg-red-500/20 hover:text-red-400 rounded-lg text-sm text-slate-400 transition-colors mt-1">
                Log Out
            </button>
        `;
    } else {
        // Logged Out State
        htmlContent += `
            <div class="mb-4">
                <p class="font-bold text-white text-lg">Guest</p>
                <p class="text-xs text-slate-400">Not logged in</p>
            </div>
            <button onclick="switchTab('settings-page')" class="w-full text-center bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-bold transition-all shadow-lg">
                Log In / Sign Up
            </button>
        `;
    }

    // Inject the new HTML
    dropdown.innerHTML = htmlContent;
}

// Close profile dropdown when clicking outside
window.addEventListener('click', function (event) {
    if (!event.target.closest('.w-10') && !event.target.closest('#profile-dropdown')) {
        const dropdown = document.getElementById('profile-dropdown');
        if (dropdown) {
            dropdown.classList.add('hidden');
        }
    }
});

// --- SEARCH LOGIC ---

let searchTimeout = null;

export function handleSearch() {
    const query = document.getElementById('search-input').value.toLowerCase().trim();

    // Filter the local TorBox library instantly
    const filtered = appState.allTorrents.filter(t => t.name.toLowerCase().includes(query));
    renderList(filtered);

    clearTimeout(searchTimeout);

    // If the query is 3 letters or more, trigger the TMDB global search
    if (query.length >= 3) {
        searchTimeout = setTimeout(() => {
            switchTab('discover-page');
            searchTMDB(query);
        }, 800);
    } else {
        const globalResults = document.getElementById('global-search-results');
        if (globalResults) globalResults.classList.add('hidden');
    }
}

// --- EXTERNAL PLAYERS ---
export function openExternalPlayer(player) {
    const videoUrl = appState.currentStreamUrl;

    if (!videoUrl) {
        showToast("No video stream selected yet.", "error");
        return;
    }

    if (videoUrl.startsWith('blob:')) {
        showToast("Local device files cannot be cast to external players. Please play them directly in the browser.", "error");
        document.getElementById('external-player-modal').classList.add('hidden');
        return;
    }

    const encodedUrl = encodeURIComponent(videoUrl);
    let deepLink = '';

    switch (player) {
        case 'vlc':
            deepLink = videoUrl.replace(/^https?:\/\//i, 'vlc://');
            break;

        case 'infuse':
            deepLink = `infuse://x-callback-url/play?url=${encodedUrl}`;
            break;

        case 'outplayer':
            deepLink = `outplayer://${encodedUrl}`;
            break;

        case 'mxplayer':
            deepLink = `intent:${videoUrl}#Intent;package=com.mxtech.videoplayer.ad;S.title=${encodeURIComponent("TorBox Stream")};end`;
            break;

        case 'iina':
            deepLink = `iina://weblink?url=${encodedUrl}`;
            break;
    }

    // Hide the modal
    document.getElementById('external-player-modal').classList.add('hidden');

    // Trigger the OS app
    window.location.href = deepLink;
}

// Auth Listener
window.addEventListener('auth-state-changed', (event) => {
    updateProfileDropdown();
});