import { appState, showToast } from '../services/config.js';
import { supabase } from './db.js';
import { mediaStore, openMasterDetail } from '../api.js';
import { handleProfileRouting } from '../main.js';
import {
    renderAllWatchlists,
    renderMediaCards,
    renderFriendsSidebar as renderSidebar,
    renderWatchlistPicker,
    closeWatchlistPicker,
    showPersonalProfile,
    setProfileUsername,
    getNewListInput,
    clearNewListInput,
    showEditListModal,
    closeEditListModal,
    setEditListDeleting
} from './profile-renderer.js';

//#region Data

// Get watchlists without media
async function getAvailableCustomLists() {
    if (!appState.currentUser) return [];

    const { data, error } = await supabase
        .from('lists')
        .select('id, name, is_private')
        .eq('user_id', appState.currentUser.id)
        .order('created_at', { ascending: true });

    if (error) {
        console.error("Error fetching custom lists:", error.message);
        return [];
    }

    return (data || []).filter(list => list.name.toLowerCase() !== 'favourites');
}

async function getFavouritesList() {
    // 1. Standardized Guest Object
    if (!appState.currentUser) {
        return { id: 'local-fav', name: 'Favourites', is_private: true };
    }

    // 2. Authenticated: Safely check for existing Favourites
    const { data, error } = await supabase
        .from('lists')
        .select('*')
        .eq('user_id', appState.currentUser.id)
        .ilike('name', 'Favourites')
        .maybeSingle(); // maybeSingle won't throw an error if 0 rows are found

    if (data) return data;

    // 3. If missing, create it bulletproof against race conditions
    const { data: newList, error: insertError } = await supabase
        .from('lists')
        .insert({
            user_id: appState.currentUser.id,
            name: 'Favourites',
            is_private: true // Favourites are typically private
        })
        .select()
        .single();

    if (insertError) {
        console.error("Error creating Favourites list:", insertError);
    }

    return newList;
}

async function getListMedia(list) {
    if (appState.currentUser) {
        if (!list || !list.id) return []; // Safety check

        const { data, error } = await supabase
            .from('media')
            .select('id, list_id, media_id, title, media_type, poster_path, base_url')
            .eq('user_id', appState.currentUser.id)
            .eq('list_id', list.id)
            .order('created_at', { ascending: false });

        if (error) {
            console.error(`Error fetching ${list.name}:`, error.message);
            return [];
        }
        return data || [];
    } else {
        // Guest routing
        const normalizedList = list.name.toLowerCase();
        const localData = localStorage.getItem(`guest_watchlist_${normalizedList}`);
        return localData ? JSON.parse(localData) : [];
    }
}

// Save media to a list
async function saveMediaToList(mediaData, list) {
    const payload = {
        media_id: mediaData.id,
        media_type: mediaData.type,
        title: mediaData.title,
        poster_path: mediaData.poster,
        base_url: mediaData.baseUrl
    };

    if (appState.currentUser) {
        // Cloud routing
        payload.user_id = appState.currentUser.id;
        payload.list_id = list.id;

        const { error } = await supabase.from('media').insert(payload);

        // Prevents duplicate movies in the same list
        if (error && error.code === '23505') return { status: 'duplicate' };
        if (error) throw error;

        return { status: 'success' };
    } else {
        // Guest routing
        const normalizedList = list.name.toLowerCase();
        const existingData = await getListMedia(list);

        // Prevents duplicate movies in the same local list
        if (existingData.some(item => item.media_id === payload.media_id)) {
            return { status: 'duplicate' };
        }

        payload.list_id = list.id;
        existingData.unshift(payload);

        localStorage.setItem(`guest_watchlist_${normalizedList}`, JSON.stringify(existingData));
        return { status: 'success' };
    }
}

// Delete media
async function removeMediaFromList(mediaId, list) {
    if (appState.currentUser) {
        const { error } = await supabase
            .from('media')
            .delete()
            .eq('user_id', appState.currentUser.id)
            .eq('media_id', mediaId)
            .eq('list_id', list.id);

        if (error) throw error;
    } else {
        // Guest routing
        const normalizedList = list.name.toLowerCase();
        const existingData = await getListMedia(list);
        const filteredData = existingData.filter(item => item.media_id !== mediaId);

        localStorage.setItem(`guest_watchlist_${normalizedList}`, JSON.stringify(filteredData));
    }
}

// Migrate Local Favourites to Cloud upon Login
async function syncLocalFavouritesToCloud() {
    if (!appState.currentUser) return;

    // 1. Check if there's anything to migrate
    const localFavsRaw = localStorage.getItem('guest_watchlist_favourites');
    if (!localFavsRaw) return;

    const localFavs = JSON.parse(localFavsRaw);
    if (localFavs.length === 0) return;

    console.log("Migrating local Favourites to the cloud...");

    try {
        // 2. Ensure the DB Favourites list exists and get its ID
        const favList = await getFavouritesList();

        for (const media of localFavs) {
            await saveMediaToList({
                id: media.media_id,
                type: media.media_type,
                title: media.title,
                poster: media.poster_path,
                base_url: media.base_url
            }, favList);
        }

        localStorage.removeItem('guest_watchlist_favourites');
        console.log("Migration complete!");

    } catch (err) {
        console.error("Failed to migrate Favourites:", err);
    }
}

async function fetchFollowingSidebarList() {
    if (!appState.currentUser) return [];

    // Step 1: Get the IDs of everyone we follow
    const { data: follows, error: followErr } = await supabase
        .from('follows')
        .select('following_id')
        .eq('follower_id', appState.currentUser.id);

    // If there's an error or we follow no one, return an empty array
    if (followErr || !follows || follows.length === 0) return [];

    // Extract just the IDs into an array: ['uuid-1', 'uuid-2']
    const followingIds = follows.map(f => f.following_id);

    // Step 2: Fetch their profiles using those IDs (Sorted alphabetically!)
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

// Clear viewing state
export async function returnToMyProfile() {
    window.history.pushState({}, document.title, window.location.pathname);
    showPersonalProfile(appState.currentUser?.user_metadata?.username || (appState.currentUser ? 'User' : 'Guest'));
    await loadAndRenderProfile();
}

export async function shareMyProfile() {
    if (!appState.currentUser) {
        showToast("Please log in to share your profile.", "error");
        return;
    }

    const myId = appState.currentUser.id;
    const shareUrl = `${window.location.origin}/?user=${myId}`;
    const myUsername = appState.currentUser.user_metadata?.username || "me";

    const shareData = {
        title: 'Check out my watchlists!',
        text: `Follow ${myUsername} to see what they are watching.`,
        url: shareUrl
    };

    // 1. THE AUTO-DETECT: Does their device support native sharing?
    if (navigator.share) {
        // 2. THE TRY/CATCH: Did they actually share it, or did they hit cancel?
        try {
            await navigator.share(shareData);
            console.log("Profile shared successfully!");
        } catch (err) {
            console.log("User cancelled the share menu.");
        }
    }
    // 3. THE FALLBACK: Desktop users get a copied link instead
    else {
        try {
            await navigator.clipboard.writeText(shareUrl);
            showToast("Profile link copied to clipboard!", "success");
        } catch (err) {
            console.error("Failed to copy text: ", err);
            showToast("Failed to copy link.", "error");
        }
    }
}
//#endregion


//#region Profile actions
async function loadAndRenderProfile() {
    // 1. Fetch the Shelves
    const customLists = await getAvailableCustomLists();
    const favList = await getFavouritesList();
    const allLists = [favList, ...customLists];

    renderAllWatchlists(customLists, openEditListModal);

    // THE OPTIMIZED FIX:
    let allUserMovies = [];
    if (appState.currentUser) {
        const { data } = await supabase
            .from('media')
            .select('id, list_id, media_id, title, media_type, poster_path, base_url')
            .eq('user_id', appState.currentUser.id)
            .order('created_at', { ascending: false });
        allUserMovies = data || [];
    }

    async function populateTrack(listObj, trackId) {
        let mediaData = [];

        if (appState.currentUser) {
            mediaData = allUserMovies.filter(media => media.list_id === listObj.id);
        } else {
            mediaData = await getListMedia(listObj); // Keep guest local storage logic
        }

        const handleRemove = async (mediaId) => {
            await handleRemoveMedia(mediaId, listObj);
            await loadAndRenderProfile(); // Re-run the optimized render
        };

        const handleCardClick = (dbMedia) => {
            // Re-map the database columns to match what openMasterDetail expects
            const formattedMedia = {
                id: dbMedia.media_id,
                type: dbMedia.media_type,
                title: dbMedia.title,
                poster: dbMedia.poster_path,
                baseUrl: dbMedia.base_url || null
            };

            openMasterDetail(formattedMedia);
        };

        renderMediaCards(mediaData, trackId, handleRemove, handleCardClick);
    }

    // 4. Trigger population instantly
    allLists.forEach(list => {
        const safeId = list.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const trackId = `watchlist-track-${safeId}`;
        populateTrack(list, trackId);
    });
}

export function renderFriendsSidebar(friendsList) {
    renderSidebar(friendsList, friend => {
        window.history.pushState({}, '', `?user=${friend.id}`);
        handleProfileRouting();
    });
}

export async function openWatchlists() {
    const [customLists, favList] = await Promise.all([
        getAvailableCustomLists(),
        getFavouritesList()
    ]);
    renderWatchlistPicker(customLists, favList, Boolean(appState.currentUser), addToWatchlist);
}

export function updateProfilePage() {
    setProfileUsername(appState.currentUser?.user_metadata?.username || (appState.currentUser ? 'User' : 'Guest'));
}

// Create list popup
export async function createNewList() {
    const input = getNewListInput();
    if (!input) return;
    const { name: listName, isPrivate } = input;

    if (!appState.currentUser) {
        showToast("Please log in to create custom lists.", "error");
        return;
    }
    if (!listName) {
        showToast("Please enter a name for your list.", "error");
        return;
    }
    if (listName.toLowerCase() === 'favourites') {
        showToast("You already have a Favourites list.", "error");
        return;
    }

    try {
        // Insert directly into the new lists table
        const { error } = await supabase
            .from('lists')
            .insert({
                user_id: appState.currentUser.id,
                name: listName,
                is_private: isPrivate
            });

        if (error && error.code === '23505') {
            showToast("You already have a list with this name.", "info");
            return;
        }
        if (error) throw error;

        showToast("List created successfully!", "success");
        clearNewListInput();

        // Re-fetch and render the lists
        await loadAndRenderProfile();
    } catch (err) {
        console.error("Error creating list:", err);
        showToast("Failed to create list.", "error");
    }
}

// Helper for the popup
export async function addToWatchlist(list) {
    const mediaData = mediaStore.get();

    if (!mediaData || !mediaData.id) {
        showToast("No media loaded to save.", "error");
        return;
    }

    try {
        const result = await saveMediaToList(mediaData, list);

        if (result.status === 'duplicate') {
            showToast(`This is already in ${list.name}.`, "info");
        } else if (result.status === 'success') {
            showToast(`Added to ${list.name}!`, "success");
            closeWatchlistPicker();

            await loadAndRenderProfile();
        }
    } catch (err) {
        console.error("Unexpected error saving media:", err);
        showToast("Something went wrong.", "error");
    }
}

// Delete media from a list
async function handleRemoveMedia(mediaId, list) {
    try {
        await removeMediaFromList(mediaId, list);
        showToast("Removed from list.", "info");
    } catch (err) {
        console.error("Error removing media:", err);
        showToast("Failed to remove item.", "error");
    }
}

// Edit watchlists
export function openEditListModal(list) {
    showEditListModal(list, async (newName, changeVisibility) => {
        const newIsPrivate = changeVisibility ? !list.is_private : list.is_private;

        if (!newName) {
            showToast("List name cannot be empty.", "error");
            return;
        }
        if (list.name === newName && !changeVisibility) {
            closeEditListModal();
            return;
        }

        const customLists = await getAvailableCustomLists();
        if (list.name !== newName && customLists.some(l => l.name.toLowerCase() === newName.toLowerCase())) {
            showToast("You already have a list with this name.", "info");
            return;
        }
        if (newName.toLowerCase() === 'favourites') {
            showToast("You already have a Favourites", "error");
            return;
        }

        try {
            const { error } = await supabase
                .from('lists')
                .update({ name: newName, is_private: newIsPrivate })
                .eq('id', list.id);
            if (error) throw error;

            closeEditListModal();
            await loadAndRenderProfile();
        } catch (err) {
            console.error("Error updating list:", err);
            showToast("Failed to update list.", "error");
        }
    }, async () => {
        const isSure = window.confirm(`Are you sure you want to delete "${list.name}"? This will remove all saved movies and cannot be undone.`);
        if (!isSure) return;

        setEditListDeleting(true);
        try {
            const { error } = await supabase
                .from('lists')
                .delete()
                .eq('id', list.id);
            if (error) throw error;

            showToast("List deleted.", "success");
            closeEditListModal();
            await loadAndRenderProfile();
        } catch (err) {
            console.error("Error deleting list:", err);
            showToast("Failed to delete list.", "error");
        } finally {
            setEditListDeleting(false);
        }
    });
}

let lastRenderedUserId = null;
window.addEventListener('auth-state-changed', async () => {
    const currentUserId = appState.currentUser ? appState.currentUser.id : 'guest';
    if (lastRenderedUserId === currentUserId) {
        return;
    }

    lastRenderedUserId = currentUserId;

    const urlParams = new URLSearchParams(window.location.search);
    const isViewingFriend = urlParams.has('user');

    if (appState.currentUser) {
        await syncLocalFavouritesToCloud();
    }

    if (isViewingFriend) {
        console.log("Viewing friend's profile. Ignoring personal UI update.");
        return;
    }

    // 5. Actually update the screen
    updateProfilePage();
    await loadAndRenderProfile();
});
//#endregion
