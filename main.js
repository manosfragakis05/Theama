/**
 * ==========================================
 * main.js
 * The Application Entry Point
 * ==========================================
 */

import { registerSW } from 'virtual:pwa-register';

import { authenticateTorboxUser, checkAuth, logoutTorBox, closeStreamPicker } from './services/torbox.js';
import { appState } from './services/config.js';
import { initializeSupabase, changeAuthState, toggleAuthMode, toggleUpdateMode, logOutUser, sendPasswordResetEmail } from './services/db.js';

import { goHome, toggleProfile, switchTab, handleSearch, openExternalPlayer } from './ui.js';
import { initGlobalDrag } from './api.js';
import { deleteTorrent } from './pages/library.js';

import { closePicker } from './streaming/picker.js';
import { playDirect } from './streaming/player.js';

import { initFriendProfile, fetchFriendsList } from './network.js';

import { submitNewAddon } from './user-addons/scrapers.js';
import { renderInstalledAddons } from './user-addons/scraper-renderer.js';

import {
    renderFriendsSidebar,
    shareMyProfile,
    returnToMyProfile,
    updateProfilePage,
    addToWatchlist,
    createNewList,
    openWatchlists
} from './profile.js';

import {
    downloadToOPFS,
    triggerLocalFilePicker,
    processLocalFile,
    deleteLocalGhost,
    scanLocalOPFSDirectory,
    renderLocalLibrary
} from './services/offline.js';

// NEW LOGIC: Setup Static Event Listeners
function setupStaticEventListeners() {
    // 1. Forms
    const torboxForm = document.getElementById('torbox-auth-form');
    if (torboxForm) {
        torboxForm.addEventListener('submit', (e) => {
            e.preventDefault();
            authenticateTorboxUser();
        });
    }

    const accountForm = document.getElementById('account-form');
    if (accountForm) {
        accountForm.addEventListener('submit', changeAuthState);
    }

    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', handleSearch);
    }

    // 2. Navigation (Using Event Delegation for all .nav-link classes)
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            const target = e.currentTarget.dataset.target;
            if (target) switchTab(target);
        });
    });

    // 3. Static Profile & UI Buttons
    const profileShareBtn = document.getElementById('profile-share-btn');
    if (profileShareBtn) {
        profileShareBtn.addEventListener('click', shareMyProfile);
    }

    const addWatchlistBtn = document.getElementById('btn-add-watchlist');
    if (addWatchlistBtn) {
        addWatchlistBtn.addEventListener('click', openWatchlists);
    }

    // Addons input bar
    const toggleAddonBtn = document.getElementById('show-addon-input-btn');
    if (toggleAddonBtn) {
        toggleAddonBtn.addEventListener('click', () => {
            const container = document.getElementById('addon-input-container');
            if (container) {
                container.classList.toggle('hidden');
            }
        });
    }

    // 4. File Inputs
    const fileInput = document.getElementById('local-file-input');
    if (fileInput) {
        fileInput.addEventListener('change', processLocalFile);
    }


    // UI.js
    document.getElementById('profile-dropdown-login')?.addEventListener('click', () => switchTab('settings-page'));
    document.getElementById('profile-settings-btn')?.addEventListener('click', () => switchTab('settings-page'));
    document.getElementById('header-profile-toggle')?.addEventListener('click', toggleProfile);
    document.getElementById('home-logo-btn')?.addEventListener('click', goHome);

    document.getElementById('dropdown-profile-btn')?.addEventListener('click', () => switchTab('profile-page'));
    
    //Offline.js
    document.getElementById('trigger-local-file-btn')?.addEventListener('click', triggerLocalFilePicker);
    
    //Torbox.js
    document.getElementById('disconnect-torbox-btn')?.addEventListener('click', logoutTorBox);
    document.getElementById('close-stream-picker-btn')?.addEventListener('click', closeStreamPicker);

    //Profile.js
    document.getElementById('back-to-profile-btn')?.addEventListener('click', returnToMyProfile);
    document.getElementById('submit-new-list-btn')?.addEventListener('click', createNewList);

    //Db.js
    document.getElementById('dropdown-logout-btn')?.addEventListener('click', logOutUser);
    document.getElementById('settings-logout-btn')?.addEventListener('click', logOutUser);
    document.getElementById('forgot-password-btn')?.addEventListener('click', sendPasswordResetEmail);
    document.getElementById('toggle-auth-mode-btn')?.addEventListener('click', toggleAuthMode);
    document.getElementById('edit-profile-btn')?.addEventListener('click', toggleUpdateMode);

    //Picker.js
    document.getElementById('close-episode-picker-btn')?.addEventListener('click', closePicker);
    
    //Scraper.js
    document.getElementById('install-addon-btn')?.addEventListener('click', submitNewAddon);

}


// --- PWA AUTO-UPDATE TRIGGER ---
const updateSW = registerSW({
    immediate: true,
    onRegistered(r) {
        r && setInterval(() => {
            console.log('Checking for PWA updates...');
            r.update();
        }, 15 * 60 * 1000);
    }
});

export async function handleProfileRouting() {
    const urlParams = new URLSearchParams(window.location.search);
    const friendId = urlParams.get('user');

    await initializeSupabase();

    if (friendId && appState.currentUser && friendId === appState.currentUser.id) {
        console.log("User viewing their own public link. Stripping parameter.");
        window.history.replaceState({}, document.title, window.location.pathname);
        return;
    }

    if (friendId) {
        console.log("Routing to friend profile:", friendId);
        await initFriendProfile(friendId);
        switchTab('profile-page');
    }
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
    // Initialize our new static listeners immediately
    setupStaticEventListeners();

    const splash = document.getElementById('pwa-splash');
    const dropShield = () => {
        if (splash && splash.style.opacity !== '0') {
            splash.style.opacity = '0';
            setTimeout(() => splash.remove(), 500);
        }
    };

    const failsafeTimer = setTimeout(() => {
        console.warn("Network is slow. Dropping splash screen via failsafe.");
        dropShield();
    }, 4000);

    async function bootApp() {
        try {
            initGlobalDrag();
            await Promise.all([
                handleProfileRouting(),
                authenticateTorboxUser(),
                scanLocalOPFSDirectory()
            ]);

            const friends = await fetchFriendsList();
            renderFriendsSidebar(friends);

            renderLocalLibrary();
            renderInstalledAddons();

            clearTimeout(failsafeTimer);
        } catch (error) {
            console.error("Boot error:", error);
            clearTimeout(failsafeTimer);
        } finally {
            dropShield();
        }
    }

    bootApp();
});