/**
 * ==========================================
 * ui.js
 * Handles Navigation and Search 
 * ==========================================
 */

import { searchLibrary, fetchLibrary } from '../pages/library.js';
import { searchAppLibrary, loadAppLibrary } from '../pages/app-library.js';
import { stopPlayback } from '../streaming/player.js';
import { loadDiscover, searchTMDB } from '../user-addons/catalogs.js';
import { returnToMyProfile } from '../user-data/profile.js';
import { loadHome } from '../pages/home.js';

// --- NAVIGATION & TABS ---

export function goHome() {
    stopPlayback();

    returnToMyProfile();
    
    document.getElementById('player-wrapper').classList.add('hidden');
    switchTab('home-page');
}

export function switchTab(targetId) {
    // 1. Hide ALL pages
    document.querySelectorAll('.page-view').forEach(page => {
        page.classList.add('hidden');
        // Hide full detail view
        document.getElementById('full-detail-view').classList.add("hidden");
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
        case 'home-page':
            loadHome();
            break;
        case 'library-page':
            if (document.getElementById('library-tab').getAttribute('aria-selected') === 'true') {
                loadAppLibrary();
            } else {
                fetchLibrary();
            }
            break;
        case 'discover-page':
            loadDiscover();
            break;
        case 'help-page':
            document.getElementById('app-main').scrollTop = 0;
            document.getElementById('help-title')?.focus({ preventScroll: true });
            break;
        case 'settings-tab':
            // E.g., load user preferences
            break;
    }
}

// --- SEARCH LOGIC ---

let searchTimeout = null;

export function handleSearch(event) {
    const query = event.target.value.toLowerCase().trim();
    if (event.target.id === 'library-search-input') {
        searchLibrary(query);
        searchAppLibrary();
        return;
    }

    clearTimeout(searchTimeout);

    // 800ms debounce
    if (query.length >= 3) {
        searchTimeout = setTimeout(() => {
            searchTMDB(query);
        }, 800);
    } else {
        const globalResults = document.getElementById('global-search-results');
        if (globalResults) globalResults.classList.add('hidden');
    }
}

export function toggleSidebar()
{
    const sidebar = document.getElementById('desktop-sidebar');
    sidebar.classList.toggle('collapsed');
}
