import { appState } from "./services/config";
import { supabase } from "./services/db";
import { renderMediaCards } from "./profile.js";

//#region Public Profile
const urlParams = new URLSearchParams(window.location.search);
let viewingUserId = urlParams.get('user');


// Build your public profile
export async function updatePublicProfile() {    
    if (!appState.currentUser) return;

    // 2. Fetch fresh data from Auth
    const user = appState.currentUser;
    const currentUsername = user.user_metadata?.username;

    const { error: syncError } = await supabase
        .from('profiles')
        .upsert({ 
            id: user.id, 
            username: currentUsername 
        }, { onConflict: 'id' });

    if (syncError) {
        console.error("Failed to sync profile to public table:", syncError.message);
    }
}

// Fetch viewing profile
async function fetchPublicProfile(userId) {
    // 1. Fetch their Username
    const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('username')
        .eq('id', userId)
        .single();

    if (profileError || !profile) {
        showToast("Profile not found.", "error");
        return;
    }

    // 2. Fetch their Public Lists
    const { data: publicLists, error: listsError } = await supabase
        .from('lists')
        .select('*')
        .eq('user_id', userId)
        .eq('is_private', false)
        .order('created_at', { ascending: true });

    if (listsError) console.error("Error fetching public lists:", listsError);

    const listsToRender = (publicLists || []).filter(l => l.name.toLowerCase() !== 'favourites');

    // 3. Adjust the UI for Read-Only Mode
    const usernameDisplay = document.getElementById('profile-username-display');
    if (usernameDisplay) usernameDisplay.textContent = profile.username;

    // Hide Settings Gear
    const settingsBtn = document.querySelector('button[onclick="switchTab(\'settings-page\')"]');
    if (settingsBtn) settingsBtn.style.display = 'none';

    // Hide "New List" Button
    const newListBtn = document.querySelector('button[onclick*="create-list-modal"]');
    if (newListBtn) newListBtn.style.display = 'none';

    // Hide the hardcoded Favourites container (since Favourites are private)
    const favContainer = document.getElementById('default-watchlists-container');
    if (favContainer) favContainer.style.display = 'none';

    // 4. Render the Public Rows
    const container = document.getElementById('profile-watchlists-container');
    const template = document.getElementById('watchlist-row-template');
    
    if (!container || !template) return;
    container.innerHTML = '';

    const renderTasks = [];

    listsToRender.forEach(list => {
        const clone = template.content.cloneNode(true);
        const nameEl = clone.querySelector('.wl-row-name');
        const trackEl = clone.querySelector('.wl-row-track');
        const editBtn = clone.querySelector('.wl-row-edit-btn');

        nameEl.textContent = list.name;

        // Strip out the edit button entirely so they can't mess with it
        if (editBtn) editBtn.remove();

        const safeId = list.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        trackEl.id = `watchlist-track-${safeId}`;
        
        container.appendChild(clone);

        // Reuse your existing renderMediaCards function!
        renderTasks.push(renderMediaCards(list, `watchlist-track-${safeId}`, userId));
    });

    await Promise.all(renderTasks);
}
//#endregion

// ==========================================
// TEMPORARY CONSOLE TESTER
// ==========================================
window.testFriendProfile = async (userId) => {
    console.log(`🔍 Fetching public profile for user: ${userId}...`);
    try {
        await fetchPublicProfile(userId);
        console.log("✅ Success! The UI should now be in Read-Only mode.");
    } catch (err) {
        console.error("❌ Test failed:", err);
    }
};