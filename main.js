/**
 * ==========================================
 * main.js
 * The Application Entry Point
 * ==========================================
 */

// 1. Import from our newly created modules
import { registerSW } from 'virtual:pwa-register';

import { authenticateTorboxUser, checkAuth, logoutTorBox } from './services/torbox.js';
import { appState } from './services/config.js';
import { initializeSupabase, changeAuthState } from './services/db.js';
import { goHome, toggleProfile, switchTab, handleSearch, openExternalPlayer } from './ui.js';
import { initGlobalDrag } from './api.js';
import { deleteTorrent } from './pages/library.js';
import { closePicker } from './streaming/picker.js';
import { playDirect } from './streaming/player.js';
import { renderFriendsSidebar, updateProfilePage, addToWatchlist, createNewList, openWatchlists } from './profile.js';
import { initFriendProfile, fetchFriendsList } from './network.js';

import {
    downloadToOPFS,
    triggerLocalFilePicker,
    processLocalFile,
    deleteLocalGhost,
    scanLocalOPFSDirectory,
    renderLocalLibrary
} from './services/offline.js';


// Global Bindings
window.authenticateTorboxUser = authenticateTorboxUser;
window.changeAuthState = changeAuthState;
window.playDirect = playDirect;
window.goHome = goHome;
window.switchTab = switchTab;
window.handleSearch = handleSearch;
window.toggleProfile = toggleProfile;
window.logoutTorBox = logoutTorBox;
window.closePicker = closePicker;
window.deleteTorrent = deleteTorrent;
window.openExternalPlayer = openExternalPlayer;
window.downloadToOPFS = downloadToOPFS;

window.updateProfilePage = updateProfilePage;
window.openWatchlists = openWatchlists;
window.addToWatchlist = addToWatchlist;
window.createNewList = createNewList;


// Offline & Local File Bindings
window.triggerLocalFilePicker = triggerLocalFilePicker;
window.processLocalFile = processLocalFile;
window.deleteLocalGhost = deleteLocalGhost;
window.renderLocalLibrary = renderLocalLibrary;

const fileInput = document.getElementById('local-file-input');
if (fileInput) {
    fileInput.addEventListener('change', processLocalFile);
}

// --- PWA AUTO-UPDATE TRIGGER ---
const updateSW = registerSW({
    immediate: true, // Forces the page to reload instantly when a new update is ready
    onRegistered(r) {
        // Check for new commits every 15 minutes while the app is open
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
                checkAuth(),
                scanLocalOPFSDirectory()
            ]);

            const friends = await fetchFriendsList();
            renderFriendsSidebar(friends);

            renderLocalLibrary();
            clearTimeout(failsafeTimer);

        } catch (error) {
            console.error("Boot error:", error);
            clearTimeout(failsafeTimer);
        } finally {
            dropShield();
        }
    }

    // Start the boot process
    bootApp();
});