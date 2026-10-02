import { appState, showToast } from '../services/config.js';
import { supabase } from './db.js';
import { mediaStore, openMasterDetail } from '../api.js';
import {
    renderAllWatchlists,
    renderMediaCards,
    renderWatchlistPicker,
    closeWatchlistPicker,
    showPersonalProfile,
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
                baseUrl: media.base_url
            }, favList);
        }

        localStorage.removeItem('guest_watchlist_favourites');
        console.log("Migration complete!");

    } catch (err) {
        console.error("Failed to migrate Favourites:", err);
    }
}

// Clear viewing state
export function returnToMyProfile() {
    const url = new URL(window.location.href);
    url.searchParams.delete('user');
    window.history.pushState({}, '', url);
    window.dispatchEvent(new Event('popstate'));
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
export async function renderPersonalProfile(isCurrent = () => !new URLSearchParams(window.location.search).has('user')) {
    if (!isCurrent()) return;
    const [customLists, favList] = await Promise.all([
        getAvailableCustomLists(), getFavouritesList()
    ]);
    if (!isCurrent()) return;

    let allUserMovies = [];
    if (appState.currentUser) {
        const { data } = await supabase
            .from('media')
            .select('id, list_id, media_id, title, media_type, poster_path, base_url')
            .eq('user_id', appState.currentUser.id)
            .order('created_at', { ascending: false });
        allUserMovies = data || [];
    }
    if (!isCurrent()) return;
    showPersonalProfile(appState.currentUser?.user_metadata?.username || 'Guest');
    renderAllWatchlists(customLists, openEditListModal);

    for (const list of [favList, ...customLists].filter(Boolean)) {
        const trackId = list.name.toLowerCase() === 'favourites'
            ? 'watchlist-track-favourites' : `watchlist-track-${list.id}`;
        const mediaData = appState.currentUser
            ? allUserMovies.filter(media => media.list_id === list.id)
            : await getListMedia(list);
        if (!isCurrent()) return;

        renderMediaCards(mediaData, trackId, async mediaId => {
            await handleRemoveMedia(mediaId, list);
            await renderPersonalProfile();
        }, media => {
            openMasterDetail({
                id: media.media_id,
                type: media.media_type,
                title: media.title,
                poster: media.poster_path,
                baseUrl: media.base_url || null
            });
        });
    }
}

export async function openWatchlists() {
    const [customLists, favList] = await Promise.all([
        getAvailableCustomLists(),
        getFavouritesList()
    ]);
    renderWatchlistPicker(customLists, favList, Boolean(appState.currentUser), addToWatchlist);
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
        await renderPersonalProfile();
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

            await renderPersonalProfile();
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
            await renderPersonalProfile();
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
            await renderPersonalProfile();
        } catch (err) {
            console.error("Error deleting list:", err);
            showToast("Failed to delete list.", "error");
        } finally {
            setEditListDeleting(false);
        }
    });
}

export { syncLocalFavouritesToCloud };
//#endregion
