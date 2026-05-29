/**
 * ==========================================
 * main.js
 * The Application Entry Point
 * ==========================================
 */

// 1. Import from our newly created modules
import { authenticateTorboxUser, checkAuth, logoutTorBox, toggleProfile } from './services/torbox.js';
import { updateTheaterAccount } from './services/db.js';
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
window.updateTheaterAccount = updateTheaterAccount;
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


// 3. Application Initialization 
// These run the moment the user opens the web page.

// Check if the user is logged into TorBox (shows Auth screen if not)
checkAuth();

// Check the device's local storage for downloaded files
scanLocalOPFSDirectory();

// Render the local "Ghost" library if they switch to that tab
renderLocalLibrary();

// Attach the file input listener for the Local File picker
const fileInput = document.getElementById('local-file-input');
if (fileInput) {
    fileInput.addEventListener('change', processLocalFile);
}