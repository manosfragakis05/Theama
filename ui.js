/**
 * ==========================================
 * ui.js
 * Handles Navigation, Search, and External Players
 * ==========================================
 */

import { appState, showToast } from './services/config.js';
import { renderList } from './pages/library.js';
import { stopPlayback } from './streaming/player.js';
import { loadDiscover, searchTMDB } from './user-addons/catalogs.js';

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
            loadDiscover();
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
    const loggedInContainer = document.getElementById('profile-logged-in');
    const loggedOutContainer = document.getElementById('profile-logged-out');

    // Ensure elements exist before trying to modify them
    if (!loggedInContainer || !loggedOutContainer) return;

    if (appState.currentUser) {
        // Logged In State: Update Text Values
        const username = appState.currentUser.user_metadata?.username || 'User';
        const email = appState.currentUser.email || '';

        document.getElementById('dropdown-username').textContent = username;

        const emailEl = document.getElementById('dropdown-email');
        if (email) {
            emailEl.textContent = email;
            emailEl.classList.remove('hidden');
        } else {
            emailEl.classList.add('hidden');
        }

        // Toggle Visibility
        loggedInContainer.classList.remove('hidden');
        loggedOutContainer.classList.add('hidden');
    } else {
        // Logged Out State: Toggle Visibility
        loggedInContainer.classList.add('hidden');
        loggedOutContainer.classList.remove('hidden');
    }
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

export function handleSearch(event) {
    const desktopSearch = document.getElementById('search-input');
    const mobileSearch = document.getElementById('search-input-mobile');

    const rawValue = event.target.value;
    const query = rawValue.toLowerCase().trim();

    if (event.target === desktopSearch && mobileSearch) {
        mobileSearch.value = rawValue;
    } else if (event.target === mobileSearch && desktopSearch) {
        desktopSearch.value = rawValue;
    }

    // Filter TorBox library
    const filtered = appState.allTorrents.filter(t => t.name.toLowerCase().includes(query));
    renderList(filtered);

    clearTimeout(searchTimeout);

    // 800ms debounce
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

export function toggleSidebar()
{
    const sidebar = document.getElementById('desktop-sidebar');
    sidebar.classList.toggle('collapsed');
}

// Auth Listener
window.addEventListener('auth-state-changed', (event) => {
    updateProfileDropdown();
});