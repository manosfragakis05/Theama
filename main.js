/**
 * ==========================================
 * main.js
 * The Application Entry Point
 * ==========================================
 */

// 1. Import from our newly created modules
import { authenticateTorboxUser, checkAuth, logoutTorBox, toggleProfile } from './services/torbox.js';
import { initializeSupabase, changeAuthState } from './services/db.js';
import { goHome, switchTab, handleSearch, openExternalPlayer } from './ui.js';
import { deleteTorrent } from './pages/library.js';
import { closePicker } from './streaming/picker.js';
import { playDirect } from './streaming/player.js';
import {
    downloadToOPFS,
    triggerLocalFilePicker,
    processLocalFile,
    deleteLocalGhost,
    scanLocalOPFSDirectory,
    renderLocalLibrary
} from './services/offline.js';


// 2. Global Bindings for HTML Inline Functions
// This maps our modular, protected code back to the global window
// so that your `<button onclick="functionName()">` tags still work perfectly.
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

// Offline & Local File Bindings
window.triggerLocalFilePicker = triggerLocalFilePicker;
window.processLocalFile = processLocalFile;
window.deleteLocalGhost = deleteLocalGhost;
window.renderLocalLibrary = renderLocalLibrary;

const fileInput = document.getElementById('local-file-input');
if (fileInput) {
    fileInput.addEventListener('change', processLocalFile);
}

// --- PWA BOOT SEQUENCE & FAILSAFE ---
window.addEventListener('load', () => {
    const splash = document.getElementById('pwa-splash');

    // Helper function to gracefully kill the splash screen
    const dropShield = () => {
        if (splash && splash.style.opacity !== '0') {
            splash.style.opacity = '0';
            setTimeout(() => splash.remove(), 500);
        }
    };

    // 1. THE FAILSAFE (Your 4-second rule)
    // If the network hangs, kill the splash screen anyway so the user isn't trapped.
    const failsafeTimer = setTimeout(() => {
        console.warn("Network is slow. Dropping splash screen via failsafe.");
        dropShield();
    }, 4000);

    // 2. THE ACTUAL BOOT LOGIC
    async function bootApp() {
        try {
            // Run your local setup 
            await checkAuth(); 
            
            await initializeSupabase();
            
            await scanLocalOPFSDirectory();
            renderLocalLibrary();

            // Add any TorBox API network checks here if you have them!

            // If we successfully get to this line before 4 seconds, 
            // cancel the failsafe timer and drop the shield immediately!
            clearTimeout(failsafeTimer);
            dropShield();

        } catch (error) {
            console.error("Boot error:", error);
            // Even if the app crashes, drop the shield so the user can see what broke
            clearTimeout(failsafeTimer);
            dropShield();
        }
    }

    // Start the boot process
    bootApp();
});