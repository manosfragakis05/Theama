/**
 * ==========================================
 * main.js
 * The Application Entry Point
 * ==========================================
 */

import { registerSW } from 'virtual:pwa-register';

import { authenticateTorboxUser, logoutTorBox, closeStreamPicker } from './services/torbox.js';
import { appState, showToast } from './services/config.js';

import {
    initializeSupabase,
    changeAuthState,
    toggleAuthMode,
    toggleUpdateMode,
    logOutUser,
    sendPasswordResetEmail
} from './user-data/db.js';

import { goHome, toggleProfile, switchTab, handleSearch, toggleSidebar, updateProfileDropdown } from './utils/ui.js';

import { deleteTorrent } from './pages/library.js';

import { closePicker } from './streaming/picker.js';
import { playDirect, stopPlayback } from './streaming/player.js';

import { updatePublicProfile, fetchPublicProfile, fetchFriendsList, handleFollowToggle } from './user-data/network.js';
import { initializeSettings } from './user-data/user-settings.js';

import { initCustomAddons, submitNewAddon } from './user-addons/user-addons.js';

import { initGlobalDrag, closeGridView } from './user-addons/catalog-renderer.js';

import { closeMovieDetail } from './api.js';

import {
    shareMyProfile,
    returnToMyProfile,
    renderPersonalProfile,
    syncLocalFavouritesToCloud,
    createNewList,
    openWatchlists
} from './user-data/profile.js';
import { renderFriendsSidebar, renderProfileFriends, renderPublicProfile, setFollowButton } from './user-data/profile-renderer.js';

import { triggerLocalFilePicker, processLocalFile } from './services/offline.js';

// NEW LOGIC: Setup Static Event Listeners
function setupStaticEventListeners() {
    document.getElementById('close-player-btn')?.addEventListener('click', stopPlayback);

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

    // Attach pc and mobile listeners
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', handleSearch);
    }
    const mobileSearch = document.getElementById('search-input-mobile');
    if (mobileSearch) {
        mobileSearch.addEventListener('input', handleSearch);
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
    document.getElementById('sidebar-collapse-btn')?.addEventListener('click', toggleSidebar);

    document.getElementById('dropdown-profile-btn')?.addEventListener('click', () => switchTab('profile-page'));

    //Network.js
    document.getElementById('profile-follow-btn')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        const friendId = new URLSearchParams(window.location.search).get('user');
        if (!friendId || button.disabled) return;
        button.disabled = true;
        try {
            const wasFollowing = button.dataset.following === 'true';
            await handleFollowToggle(friendId, wasFollowing);
            if (new URLSearchParams(window.location.search).get('user') === friendId) {
                setFollowButton(!wasFollowing);
            }
            await refreshFriendsLists();
        } catch (error) {
            console.error('Follow toggle failed:', error);
            showToast(error.message || 'Could not update follow status.', 'error');
        } finally {
            button.disabled = false;
        }
    });
    for (const containerId of ['sidebar-following-list', 'profile-friends-list']) {
        document.getElementById(containerId)?.addEventListener('click', event => {
            const button = event.target.closest('.following-btn, .profile-friend-btn');
            if (!button?.dataset.friendId) return;
            const url = new URL(window.location.href);
            url.searchParams.set('user', button.dataset.friendId);
            window.history.pushState({}, '', url);
            handleProfileRouting();
        });
    }

    //Offline.js
    document.getElementById('trigger-local-file-btn')?.addEventListener('click', () => triggerLocalFilePicker());

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

    //Api.js
    document.getElementById('close-full-detail-view-btn')?.addEventListener('click', closeMovieDetail);

    //Catalog-renderer.js
    document.getElementById('close-grid-view-btn')?.addEventListener('click', closeGridView);

    // Fix IOS dropdowns
    document.addEventListener('touchstart', (e) => {
        const activeEl = document.activeElement;
        if (activeEl && activeEl.tagName === 'SELECT' && e.target !== activeEl) {
            activeEl.blur();
        }
    }, { passive: true });
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

let routeVersion = 0;
export async function handleProfileRouting() {
    const version = ++routeVersion;
    const url = new URL(window.location.href);
    let friendId = url.searchParams.get('user');
    const openedProfileLink = Boolean(friendId);

    if (friendId && friendId === appState.currentUser?.id) {
        url.searchParams.delete('user');
        window.history.replaceState({}, '', url);
        friendId = null;
    }

    try {
        if (friendId) {
            const profile = await fetchPublicProfile(friendId);
            if (version !== routeVersion) return;
            renderPublicProfile(friendId, profile);
            switchTab('profile-page');
        } else {
            await renderPersonalProfile(() => version === routeVersion);
            if (openedProfileLink && version === routeVersion) switchTab('profile-page');
        }
    } catch (error) {
        if (version !== routeVersion) return;
        console.error('Profile load failed:', error);
        showToast('Could not load the profile.', 'error');
    }
}

async function refreshFriendsLists() {
    const userId = appState.currentUser?.id;
    try {
        const friends = await fetchFriendsList();
        if (userId === appState.currentUser?.id) {
            renderFriendsSidebar(friends);
            renderProfileFriends(friends);
        }
    } catch (error) {
        console.error('Friends list load failed:', error);
    }
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
    // Initialize our new static listeners immediately
    setupStaticEventListeners();
    window.addEventListener('popstate', handleProfileRouting);

    let lastAuthKey;
    let authUpdate = Promise.resolve();
    let appBooted = false;

    window.addEventListener('auth-state-changed', () => {
        updateProfileDropdown();
        const user = appState.currentUser;
        const authKey = JSON.stringify([user?.id, user?.email, user?.user_metadata?.username]);
        if (authKey === lastAuthKey) return;

        lastAuthKey = authKey;

        authUpdate = authUpdate.then(async () => {
            if (appState.currentUser) {
                await Promise.all([syncLocalFavouritesToCloud(), updatePublicProfile()]);
            }
            await Promise.all([handleProfileRouting(), refreshFriendsLists(), initializeSettings()]);
            if (appBooted) {
                await initCustomAddons();
                await authenticateTorboxUser();
            }
        }).catch(error => console.error('Auth update failed:', error));
    });

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
            await initializeSupabase();
            await authUpdate;

            await authenticateTorboxUser();

            await initCustomAddons();
            appBooted = true;

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

const mainContainer = document.getElementById('app-main');
const scrollCache = new Map();
let currentTabId = 'library-page';

document.querySelectorAll('.nav-link').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const targetId = e.currentTarget.getAttribute('data-target');

        if (targetId === currentTabId) return;

        scrollCache.set(currentTabId, mainContainer.scrollTop);

        document.getElementById(currentTabId).classList.add('hidden');
        document.getElementById(targetId).classList.remove('hidden');

        mainContainer.scrollTop = scrollCache.get(targetId) || 0;

        currentTabId = targetId;
    });
});
