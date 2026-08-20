import { appState, showToast } from "./services/config";
import { supabase } from "./services/db";
import { renderAllWatchlists, renderMediaCards } from './profile-renderer.js';
import { openMasterDetail } from './api.js';

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

//#region Public Data

async function fetchUserProfile(userId) {
    const { data: profile, error } = await supabase
        .from('profiles')
        .select('username')
        .eq('id', userId)
        .single();

    if (error || !profile) {
        console.error("User not found:", error?.message);
        return null;
    }
    return profile;
}

// Set follow state
async function checkFollowStatus(friendId) {
    if (!appState.currentUser) return false;

    const { data: followData, error } = await supabase
        .from('follows')
        .select('*')
        .eq('follower_id', appState.currentUser.id)
        .eq('following_id', friendId)
        .single();

    if (error && error.code !== 'PGRST116') {
        console.error("Error checking follow status:", error.message);
    }

    return !!followData;
}

// Fetch public watchlists
async function fetchWatchlists(friendId) {
    const { data: publicLists, error: listsError } = await supabase
        .from('lists')
        .select(`
            id, name, is_private, created_at,
            movies ( id, tmdb_id, title, media_type, poster_path )
        `)
        .eq('user_id', friendId)
        .eq('is_private', false)
        .order('created_at', { ascending: true });

    if (listsError || !publicLists) {
        console.error("Error fetching public lists:", listsError);
        return [];
    }

    return publicLists.map(list => ({
        ...list,
        items: list.movies || []
    }));
}

export async function initFriendProfile(friendId) {
    console.log(`🔍 Initializing profile view for ID: ${friendId}`);

    if (!friendId) return;

    const userData = await fetchUserProfile(friendId);

    if (!userData) {
        console.log("❌ Profile detection failed. Aborting UI render.");
        // TODO: Later, we can call a UI function here like showUserNotFoundUI()
        return;
    }

    // Fetch extra data
    const [isFollowing, watchlistsData] = await Promise.all([
        checkFollowStatus(friendId),
        fetchWatchlists(friendId)
    ]);

    // 3. Log the structured data so you can inspect it in your console
    console.log("✅ Data successfully fetched and structured!");
    console.log("Profile Data:", userData.username);
    console.log("Is Following:", isFollowing);
    console.log("Watchlists Data:", watchlistsData);

    setReadOnlyUI(userData.username, friendId);
    updateFollowBtnState(isFollowing);
    renderFriendWatchlists(watchlistsData);
}
//#endregion

//#region Render Public Data
function setReadOnlyUI(username, friendId) {
    // 1. Update Header Text
    const usernameDisplay = document.getElementById('profile-username-display');
    const welcomeText = usernameDisplay.parentElement;

    welcomeText.innerHTML = `<span id="profile-username-display" class="text-blue-500 drop-shadow-[0_0_5px_rgba(59,130,246,0.3)]">${username}</span>'s Profile`;
    welcomeText.nextElementSibling.textContent = "Browsing public watchlists.";

    // 2. Hide Personal Settings & Show Back Button
    const settingsBtn = document.getElementById('profile-settings-btn');
    const shareProfileBtn = document.getElementById('profile-share-btn');
    const newListBtn = document.querySelector('button[onclick*="create-list-modal"]');
    const defaultFavs = document.getElementById('default-watchlists-container');
    const backBtn = document.getElementById('back-to-profile-btn'); // <-- Grab the new button

    if (settingsBtn) settingsBtn.style.display = 'none';
    if (shareProfileBtn) shareProfileBtn.style.display = 'none';
    if (newListBtn) newListBtn.style.display = 'none';
    if (defaultFavs) defaultFavs.style.display = 'none';
    if (backBtn) backBtn.classList.remove('hidden'); // <-- Show it!

    // 3. Prepare and Show the Follow Button
    const followBtn = document.getElementById('profile-follow-btn');
    if (followBtn) {
        followBtn.style.display = 'flex';
        followBtn.dataset.friendId = friendId; 
    }
}

/**
 * Swaps the colors, text, and icon of the Follow button.
 */
function updateFollowBtnState(isFollowing) {
    const btn = document.getElementById('profile-follow-btn');
    const text = document.getElementById('follow-text');
    const icon = document.getElementById('follow-icon');

    if (!btn || !text || !icon) return;

    if (isFollowing) {
        // "Following" State (Muted gray)
        btn.className = "px-6 py-3 rounded-2xl font-bold text-sm transition-all flex items-center gap-2 border shadow-sm outline-none bg-slate-800/80 text-slate-300 border-slate-700 hover:bg-slate-700 hover:text-white";
        text.textContent = "Following";
        icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>`; // Checkmark
    } else {
        // "Follow" State (Active blue)
        btn.className = "px-6 py-3 rounded-2xl font-bold text-sm transition-all flex items-center gap-2 border shadow-sm outline-none bg-blue-600 hover:bg-blue-500 text-white border-blue-500 shadow-[0_0_15px_rgba(37,99,235,0.2)]";
        text.textContent = "Follow";
        icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"></path>`; // User Plus
    }
}

/**
 * Feeds the fetched data into your existing profile-renderer.js functions.
 */
function renderFriendWatchlists(watchlistsData) {
    // 1. Create the empty tracks (Rows)
    renderAllWatchlists(watchlistsData);

    // 2. Strip out the "Edit" buttons since we don't own these lists
    document.querySelectorAll('.wl-row-edit-btn').forEach(btn => btn.remove());

    // 3. Populate each track with its movies
    watchlistsData.forEach(list => {
        const safeId = list.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const trackId = `watchlist-track-${safeId}`;

        const handleCardClick = (media) => {
            openMasterDetail(media.tmdb_id, media.title, media.media_type, media.poster_path, media.poster_path);
        };

        // Render the books (Step 2 function)
        renderMediaCards(list.items, trackId, null, handleCardClick);
    });
}
//#endregion

//#region Follow system

// Fetch friends list
export async function fetchFriendsList() {
    if (!appState.currentUser) return [];

    const { data: follows, error: followErr } = await supabase
        .from('follows')
        .select('following_id')
        .eq('follower_id', appState.currentUser.id);

    if (followErr || !follows || follows.length === 0) return [];

    const followingIds = follows.map(f => f.following_id);

    const { data: profiles, error: profileErr } = await supabase
        .from('profiles')
        .select('id, username')
        .in('id', followingIds)
        .order('username', { ascending: true });

    if (profileErr) {
        console.error("Error fetching friend profiles:", profileErr.message);
        return [];
    }

    return profiles;
}

// Set the changed data
async function toggleFollowState(friendId, isCurrentlyFollowing) {
    if (!appState.currentUser) throw new Error("User not logged in");

    if (isCurrentlyFollowing) {
        // Unfollow: Remove the row
        const { error } = await supabase
            .from('follows')
            .delete()
            .eq('follower_id', appState.currentUser.id)
            .eq('following_id', friendId);

        if (error) throw error;
    } else {
        // Follow: Create the row
        const { error } = await supabase
            .from('follows')
            .insert({
                follower_id: appState.currentUser.id,
                following_id: friendId
            });

        if (error) throw error;
    }

    return true; // Success
}

// Follow / Unfollow
window.handleFollowToggle = async () => {
    const btn = document.getElementById('profile-follow-btn');
    if (!btn) return;

    // 1. Read the current state directly from the DOM
    const friendId = btn.dataset.friendId;
    const currentText = document.getElementById('follow-text').textContent.trim();
    const isCurrentlyFollowing = currentText === "Following";

    updateFollowBtnState(!isCurrentlyFollowing);

    try {
        await toggleFollowState(friendId, isCurrentlyFollowing);
        console.log(`Successfully ${isCurrentlyFollowing ? 'unfollowed' : 'followed'} user!`);
    } catch (error) {
        console.error("Follow toggle failed:", error);

        updateFollowBtnState(isCurrentlyFollowing);

        showToast("Please log in or check your connection.", "error");
    }
};