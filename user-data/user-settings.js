import { showToast, appState } from '../services/config.js';
import { supabase } from "./db.js";

let userSettings = {
    addon_links: [],
    user_preferences: {
        saveKeyToCloud: false,
        saveAddonsToCloud: false,
        parseAddonLinks: true
    }
};
let settingsListenersAttached = false;

// GLOBAL GETTER
export function getCurrentUserSettings() {
    return userSettings;
}

//#region Init Settings
export async function initializeSettings() {
    if (appState.currentUser) {
        const { data: settings, error: settingsErr } = await supabase
            .from('user_data')
            .select('addon_links, user_preferences')
            .eq('id', appState.currentUser.id)
            .single();
        if (settings && !settingsErr) {
            userSettings = settings;

            localStorage.setItem('user_preferences', JSON.stringify(userSettings));
        } else {
            const storedSettings = localStorage.getItem('user_preferences');
            if (storedSettings) {
                userSettings = JSON.parse(storedSettings);
            }
        }
    } else {
        const storedSettings = localStorage.getItem('user_preferences');
        if (storedSettings) {
            userSettings = JSON.parse(storedSettings);
        }
    }

    // Update UI
    if (userSettings.user_preferences) {
        document.getElementById('saveKeyToCloud').checked = userSettings.user_preferences.saveKeyToCloud || false;
        document.getElementById('saveAddonsToCloud').checked = userSettings.user_preferences.saveAddonsToCloud || false;
        document.getElementById('parseAddonLinks').checked = userSettings.user_preferences.parseAddonLinks || false;
    }

    attachSettingsListeners();
}

function attachSettingsListeners() {
    if (settingsListenersAttached) return;
    settingsListenersAttached = true;
    document.getElementById('saveKeyToCloud').addEventListener('change', (e) => {
        userSettings.user_preferences.saveKeyToCloud = e.target.checked;
        saveSettings();
    });

    document.getElementById('saveAddonsToCloud').addEventListener('change', (e) => {
        userSettings.user_preferences.saveAddonsToCloud = e.target.checked;
        if(e.target.checked) {
            const localAddons = JSON.parse(localStorage.getItem('user_addons')) || [];
            saveAddonsToCloud(localAddons);
        } else {
            // Pass an empty array to delete the urls from the cloud
            saveAddonsToCloud([]);
        }
    });

    document.getElementById('parseAddonLinks').addEventListener('change', (e) => {
        userSettings.user_preferences.parseAddonLinks = e.target.checked;
        saveSettings();
    });
}

async function saveSettings() {
    // Convert the Javascript object to a string and store it
    localStorage.setItem('user_preferences', JSON.stringify(userSettings));
    console.log("Settings saved to localStorage:", userSettings);

    if (appState.currentUser) {
        const { error } = await supabase
            .from('user_data')
            .upsert({
                id: appState.currentUser.id,
                addon_links: userSettings.addon_links,
                user_preferences: userSettings.user_preferences
            });

        if (error) {
            console.error("Failed to sync settings to Supabase:", error.message);
            showToast("Failed to sync settings", "error");
        } else {
            console.log("Settings synced to Supabase successfully.");
        }
    }
}

export async function saveAddonsToCloud(userAddons) {
    if (!userAddons) return;

    // Store only the url
    const manifestList = userAddons
        .map(addon => addon.url)
        .filter(url => url !== null && url !== "");

    userSettings.addon_links = manifestList;

    await saveSettings();
}
