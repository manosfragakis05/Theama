import { showToast, appState } from '../services/config.js';
import { supabase } from "./db.js";
import { openPlayerSelection } from '../streaming/external-players.js';

let userSettings = {
    addon_links: [],
    user_preferences: {
        saveKeyToCloud: false,
        torboxApiKey: "",
        saveAddonsToCloud: false,
        trustThisDevice: true,
        parseAddonLinks: true,
        defaultPlayer: "Internal"
    }
};

// GLOBAL GETTER AND SETTERS
export function getCurrentUserSettings() {
    return userSettings;
}

// 3. New Setter: Updates preferences and auto-saves
export async function updateUserPreference(key, value) {
    userSettings.user_preferences[key] = value;
    await saveSettings();
}

//#region Init Settings

// Cloud preferences will overwrite local changes when the user logs in,
// but addon saves will be upserted when the user logs in.

export async function initializeSettings() {
    console.log("INITIALIZING");
    if (appState.currentUser) {
        const { data: settings, error: settingsErr } = await supabase
            .from('user_data')
            .select('addon_links, user_preferences')
            .eq('id', appState.currentUser.id)
            .maybeSingle();

        if (settings && !settingsErr) {
            const storedSettings = sessionStorage.getItem('user_settings') || localStorage.getItem('user_settings');
            const localSettings = storedSettings ? JSON.parse(storedSettings) : null;

            const localAddons = localSettings ? localSettings.addon_links : [];
            const cloudAddons = settings.addon_links || [];

            // Merge addons
            const mergedAddons = [...new Set([...localAddons, ...cloudAddons])];
            // Update memory
            userSettings.addon_links = mergedAddons;

            const localPrefs = localSettings ? localSettings.user_preferences : userSettings.user_preferences;

            userSettings.user_preferences = {
                ...localPrefs, // Keep local defaults
                ...settings.user_preferences,      // Overwrite with cloud settings

                torboxApiKey: settings.user_preferences.torboxApiKey || localPrefs.torboxApiKey
            };

            // Save only if they dont match
            if (mergedAddons.length !== cloudAddons.length) await saveSettings();
        } else {

            const storedSettings = sessionStorage.getItem('user_settings') || localStorage.getItem('user_settings');
            if (storedSettings) {
                userSettings = JSON.parse(storedSettings);
            }
        }
    } else {
        const storedSettings = sessionStorage.getItem('user_settings') || localStorage.getItem('user_settings');
        if (storedSettings) {
            userSettings = JSON.parse(storedSettings);
        }
    }

    // Update UI
    if (userSettings.user_preferences) {
        document.getElementById('cloud-key-toggle').checked = userSettings.user_preferences.saveKeyToCloud || false;
        document.getElementById('cloud-addons-toggle').checked = userSettings.user_preferences.saveAddonsToCloud || false;
        document.getElementById('trust-device-toggle').checked = userSettings.user_preferences.trustThisDevice || false;
        document.getElementById('parse-links-toggle').checked = userSettings.user_preferences.parseAddonLinks || false;
        
        const defaultPlayer = userSettings.user_preferences.defaultPlayer || 'Internal';
        const playerButton = Array.from(document.querySelectorAll('#external-player-modal .external-player-btn'))
            .find(button => button.dataset.player === defaultPlayer);
        document.getElementById('select-player-btn').textContent =
            playerButton?.querySelector('.font-bold').textContent.trim() || 'Internal';
    }

    attachSettingsListeners();
}

let settingsListenersAttached = false;
function attachSettingsListeners() {
    if (settingsListenersAttached) return;
    settingsListenersAttached = true;

    document.getElementById('select-player-btn').addEventListener('click', () => {
        openPlayerSelection(async (player, label) => {
            try {
                await updateUserPreference('defaultPlayer', player);
                document.getElementById('select-player-btn').textContent = label;
            } catch (error) {
                console.error('Failed to save default player:', error);
                showToast('Failed to save default player.', 'error');
            }
        });
    });

    document.getElementById('cloud-key-toggle').addEventListener('click', (e) => {
        if (!appState.currentUser) {
            e.preventDefault();
            e.target.checked = false;
            showToast("Please log in to sync your API key.", "error");
            return;
        }
        userSettings.user_preferences.saveKeyToCloud = e.target.checked;
        saveSettings();
    });

    document.getElementById('cloud-addons-toggle').addEventListener('click', (e) => {
        if (!appState.currentUser) {
            e.preventDefault();
            e.target.checked = false;
            showToast("Please log in to sync add-ons to the cloud.", "error");
            return;
        }
        userSettings.user_preferences.saveAddonsToCloud = e.target.checked;
        saveSettings();
    });

    document.getElementById('trust-device-toggle').addEventListener('click', (e) => {
        userSettings.user_preferences.trustThisDevice = e.target.checked;
        // SWITCH BETWEEN SESSIONSTORAGE AND LOCALSTORAGE
        switchStorageMode(e.target.checked);
    });

    document.getElementById('parse-links-toggle').addEventListener('change', (e) => {
        userSettings.user_preferences.parseAddonLinks = e.target.checked;
        saveSettings();
    });
}

//#region Save Settings
async function saveSettings() {
    const storage = getStorage();

    // Store based on trustDevice
    storage.setItem('user_settings', JSON.stringify(userSettings));

    if (appState.currentUser) {
        // Screenshot current setting so i can change the sync object without touching the RAM
        const prefsToSync = { ...userSettings.user_preferences };

        // Dont upload device trust to the cloud
        delete prefsToSync.trustThisDevice;

        // Apply API Key privacy logic to the clone
        if (!prefsToSync.saveKeyToCloud) {
            prefsToSync.torboxApiKey = "";
        }

        // Build the final payload
        const payload = {
            id: appState.currentUser.id,
            user_preferences: prefsToSync
        };

        // 5. Apply Addon privacy logic
        if (userSettings.user_preferences.saveAddonsToCloud) {
            payload.addon_links = userSettings.addon_links;
        } else {
            payload.addon_links = [];
        }

        const { error } = await supabase
            .from('user_data')
            .upsert(payload);

        if (error) {
            console.error("Failed to sync settings to Supabase:", error.message);
            showToast("Failed to sync settings", "error");
        } else {
            console.log("Settings synced to Supabase successfully.");
        }
    } else {
        userSettings.user_preferences.saveKeyToCloud = false;
        userSettings.user_preferences.saveAddonsToCloud = false;
    }
}

export function getStorage() {
    const trustDevice = userSettings.user_preferences.trustThisDevice;
    return trustDevice ? localStorage : sessionStorage;
}

// OIHFSOIVUHOSIV
function switchStorageMode(trustDevice) {
    // Grab the addon cache from whichever storage currently holds it before we switch
    const currentAddonData = sessionStorage.getItem('full_addon_data') || localStorage.getItem('full_addon_data');
    const currentSettings = getCurrentUserSettings();

    const sbTokenKey = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'))
        || Object.keys(sessionStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));

    const sbTokenData = sbTokenKey ? (sessionStorage.getItem(sbTokenKey) || localStorage.getItem(sbTokenKey)) : null;

    if (trustDevice) {
        sessionStorage.removeItem("user_settings");
        if (currentSettings) localStorage.setItem("user_settings", JSON.stringify(currentSettings));

        // Move full addons
        if (currentAddonData) localStorage.setItem("full_addon_data", currentAddonData);
        sessionStorage.removeItem("full_addon_data");

        // Move Supabase Token to Local Storage
        if (sbTokenKey && sbTokenData) {
            localStorage.setItem(sbTokenKey, sbTokenData);
            sessionStorage.removeItem(sbTokenKey);
        }

        showToast("Data will remain in local storage", "info");
    } else {

        if (confirm("Any saved data will be forgotten. Data saved in your Theama account will remain, but you will have to sign back in.")) {

            localStorage.removeItem("user_settings");
            if (currentSettings) sessionStorage.setItem("user_settings", JSON.stringify(currentSettings));

            if (currentAddonData) sessionStorage.setItem("full_addon_data", currentAddonData);
            localStorage.removeItem("full_addon_data");

            if (sbTokenKey && sbTokenData) {
                sessionStorage.setItem(sbTokenKey, sbTokenData);
                localStorage.removeItem(sbTokenKey);
            }
        } else {
            document.getElementById('trust-device-toggle').checked = true;
            userSettings.user_preferences.trustThisDevice = e.target.checked;
        }
    }
}
//#endregion

//#region Conditional Data

// Save addons based on saveAddonsToCloud and trustThisDevice
export async function saveAddons(userAddons) {
    if (!userAddons) return;

    userSettings.addon_links = userAddons;

    // Save
    await saveSettings();
}

// Always save in RAM and active storage, but save in cloud if saveKeyToCloud is true
export async function saveTorboxKey(key) {
    if (!key) return;

    userSettings.user_preferences.torboxApiKey = key;

    await saveSettings();
}
export async function deleteTorboxKey() {
    // Wipe the key from local memory
    userSettings.user_preferences.torboxApiKey = "";

    await saveSettings();
}
//#endregion
