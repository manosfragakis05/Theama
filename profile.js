import { appState, showToast } from './services/config.js';
import { supabase } from './services/db.js';
import { mediaStore, openMasterDetail } from './api.js';

//#region Data

// Get watchlists
export async function getAvailableCustomLists() {
    if (!appState.currentUser) {
        const localLists = localStorage.getItem('guest_custom_lists');
        return localLists ? JSON.parse(localLists) : [];
    }

    const { data, error } = await supabase
        .from('lists')
        .select('*')
        .eq('user_id', appState.currentUser.id)
        .order('created_at', { ascending: true });

    if (error) {
        console.error("Error fetching custom lists:", error.message);
        return [];
    }

    return (data || []).filter(list => list.name.toLowerCase() !== 'favourites');
}

export async function getFavouritesList() {
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
            .from('watchlists') 
            .select('*')
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
        tmdb_id: mediaData.id,
        media_type: mediaData.type,
        title: mediaData.title,
        poster_path: mediaData.poster
    };

    if (appState.currentUser) {
        // Cloud routing
        payload.user_id = appState.currentUser.id;
        payload.list_id = list.id; 
        
        const { error } = await supabase.from('watchlists').insert(payload); 

        // Prevents duplicate movies in the same list
        if (error && error.code === '23505') return { status: 'duplicate' };
        if (error) throw error;

        return { status: 'status' };
    } else {
        // Guest routing
        const normalizedList = list.name.toLowerCase();
        const existingData = await getListMedia(list); 
        
        // Prevents duplicate movies in the same local list
        if (existingData.some(item => item.tmdb_id === payload.tmdb_id)) {
            return { status: 'duplicate' };
        }
        
        payload.list_id = list.id; 
        existingData.unshift(payload);
        
        localStorage.setItem(`guest_watchlist_${normalizedList}`, JSON.stringify(existingData));
        return { status: 'success' };
    }
}

// Delete media
async function removeMediaFromList(tmdbId, list) {
    if (appState.currentUser) {
        const { error } = await supabase
            .from('watchlists')
            .delete()
            .eq('user_id', appState.currentUser.id)
            .eq('tmdb_id', tmdbId)
            .eq('list_id', list.id);

        if (error) throw error;
    } else {
        // Guest routing
        const normalizedList = list.name.toLowerCase();
        const existingData = await getListMedia(list);
        const filteredData = existingData.filter(item => item.tmdb_id !== tmdbId);
        
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

        // 3. Loop through local items and save them to the DB
        // We reuse saveMediaToList because it already handles duplicates perfectly
        for (const media of localFavs) {
            await saveMediaToList({
                id: media.tmdb_id,
                type: media.media_type,
                title: media.title,
                poster: media.poster_path
            }, favList);
        }

        // 4. Clean up local storage so we don't migrate this again
        localStorage.removeItem('guest_watchlist_favourites');
        console.log("Migration complete!");

    } catch (err) {
        console.error("Failed to migrate Favourites:", err);
    }
}
//#endregion


//#region Renderers

// Render lists
export async function renderProfileWatchlists() {
    const container = document.getElementById('profile-watchlists-container');
    const template = document.getElementById('watchlist-row-template');

    if (!container || !template) return;
    container.innerHTML = '';

    const customLists = await getAvailableCustomLists();
    const favList = await getFavouritesList();

    if(customLists.length > 0)
    {
        container.classList.remove('hidden');
    } else {
        container.classList.add('hidden');
    }

    customLists.forEach(list => {
        const clone = template.content.cloneNode(true);
        const nameEl = clone.querySelector('.wl-row-name');
        const trackEl = clone.querySelector('.wl-row-track');
        const editBtn = clone.querySelector('.wl-row-edit-btn');

        nameEl.textContent = list.name;

        if (!list.is_private) {
            nameEl.insertAdjacentHTML('afterend', `
            <svg class="w-[18px] h-[18px] text-slate-400 ml-2 inline-block align-middle relative -bottom-[1px] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" title="Public List">
                <circle cx="12" cy="12" r="10"></circle>
                <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path>
                <path d="M2 12h20"></path>
            </svg>
        `);
        }

        if (editBtn) editBtn.onclick = () => openEditListModal(list);

        const safeId = list.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        trackEl.id = `watchlist-track-${safeId}`;

        container.appendChild(clone);
    });

    const renderTasks = [
        renderMediaCards(favList, 'watchlist-track-favourites'),
        ...customLists.map(list => {
            const safeId = list.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
            return renderMediaCards(list, `watchlist-track-${safeId}`);
        }),
    ];

    await Promise.all(renderTasks).catch(err =>
        console.error('Error rendering watchlist cards:', err)
    );
}


// Render cards
export async function renderMediaCards(list, trackId, targetUserId = null) {
    const trackEl = document.getElementById(trackId);
    if (!trackEl) return;

    const cardTemplate = document.getElementById('poster-card-template');
    if (!cardTemplate) {
        console.error('Missing required template: #poster-card-template');
        return;
    }

    const emptyState =
        trackEl.querySelector('.wl-row-empty') ||
        trackEl.querySelector('[id$="-empty-state"]');

    trackEl.querySelectorAll('.poster-card').forEach(card => card.remove());

    // FIXED: Pass the ID down
    const mediaData = await getListMedia(list, targetUserId);

    if (mediaData.length === 0) {
        if (emptyState) emptyState.style.display = 'block';
        return;
    }

    if (emptyState) emptyState.style.display = 'none';

    mediaData.forEach(media => {
        const clone = cardTemplate.content.cloneNode(true);
        const card = clone.querySelector('.poster-card');
        const img = clone.querySelector('.poster-img');
        const title = clone.querySelector('.poster-title');
        const skeleton = clone.querySelector('.poster-skeleton');
        const removeBtn = clone.querySelector('.remove-btn');

        title.textContent = media.title;

        if (media.poster_path) {
            const imgUrl = media.poster_path.startsWith('http')
                ? media.poster_path
                : `https://image.tmdb.org/t/p/w300${media.poster_path}`;
            img.src = imgUrl;
            img.onload = () => {
                skeleton.classList.add('hidden');
                img.classList.remove('opacity-0');
            };
        } else {
            skeleton.classList.add('hidden');
        }

        if (targetUserId) {
            if (removeBtn) removeBtn.remove();
        } else {
            removeBtn.onclick = (e) => handleRemoveMedia(e, media.tmdb_id, list, trackId);
        }
        
        card.onclick = () => openMasterDetail(media.tmdb_id, media.title, media.media_type, media.poster_path, media.poster_path);

        trackEl.appendChild(clone);
    });
}

// Add to watchlist popup
export async function openWatchlists() {
    const modal = document.getElementById('watchlist-picker-modal');
    const container = document.getElementById('watchlist-options-container');
    if (!modal || !container) return;

    const customLists = await getAvailableCustomLists();
    const favList = await getFavouritesList();   
    container.innerHTML = '';

    // Favourites Button
    const favBtn = document.createElement('button');
    favBtn.className = 'flex items-center justify-between p-3 rounded-xl bg-slate-800 hover:bg-red-600/20 border border-slate-700 hover:border-red-500 transition text-left group shrink-0';
    favBtn.innerHTML = `
        <div class="flex items-center gap-4">
            <div class="w-12 h-12 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center justify-center text-red-500 group-hover:text-white group-hover:bg-red-500 transition shadow-sm font-black text-xl">
                <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            </div>
            <div class="overflow-hidden">
                <div class="font-bold text-white group-hover:text-red-400 transition truncate">Favourites</div>
                <div class="text-[10px] text-slate-400 flex items-center mt-0.5 uppercase tracking-wider font-bold">
                    ${appState.currentUser ? 'Saved to Cloud' : 'Saved to Device'}
                </div>
            </div>
        </div>
    `;
    favBtn.addEventListener('click', async () => await addToWatchlist(favList)); // <- FIXED: async and object
    container.appendChild(favBtn);

    // Custom lists
    if (customLists.length > 0) {
        const divider = document.createElement('div');
        divider.className = 'h-px bg-slate-800 my-1';
        container.appendChild(divider);

        customLists.forEach(list => {
            const listBtn = document.createElement('button');
            listBtn.className = 'flex items-center justify-between p-3 rounded-xl bg-slate-800 hover:bg-emerald-600/20 border border-slate-700 hover:border-emerald-500 transition text-left group shrink-0';
            listBtn.innerHTML = `
                <div class="flex items-center gap-4">
                    <div class="w-12 h-12 bg-slate-700 group-hover:bg-emerald-600 rounded-lg flex items-center justify-center text-slate-300 group-hover:text-white transition shadow-sm font-black text-xl uppercase" data-list-icon></div>
                    <div class="overflow-hidden">
                        <div class="font-bold text-white group-hover:text-emerald-400 transition truncate max-w-[160px]" data-list-name></div>
                        <div class="text-[10px] text-slate-400 flex items-center mt-0.5 uppercase tracking-wider font-bold" data-list-privacy></div>
                    </div>
                </div>
            `;
            listBtn.querySelector('[data-list-icon]').textContent = list.name.charAt(0);
            listBtn.querySelector('[data-list-name]').textContent = list.name;
            listBtn.querySelector('[data-list-privacy]').textContent = list.is_private ? 'Private List' : 'Public List';

            listBtn.addEventListener('click', async () => await addToWatchlist(list)); // <- FIXED: async
            container.appendChild(listBtn);
        });
    }
    modal.classList.remove('hidden');
}

export function updateProfilePage() {
    const usernameDisplay = document.getElementById('profile-username-display');
    if (!usernameDisplay) return;

    usernameDisplay.textContent = appState.currentUser
        ? (appState.currentUser.user_metadata?.username || 'User')
        : 'Guest';
}


// Create list popup
export async function createNewList() {
    const nameInput = document.getElementById('new-list-input');
    const privateToggle = document.getElementById('new-list-private');
    if (!nameInput || !privateToggle) return;

    const listName = nameInput.value.trim();
    const isPrivate = privateToggle.checked;

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
        nameInput.value = '';
        privateToggle.checked = false;

        document.getElementById('create-list-modal').classList.add('hidden');

        // Re-fetch and render the lists
        renderProfileWatchlists();
    } catch (err) {
        console.error("Error creating list:", err);
        showToast("Failed to create list.", "error");
    }
}

// Helper for the popup
export async function addToWatchlist(list) { 
    const mediaData = mediaStore.exportForLibrary();

    if (!mediaData || !mediaData.id) {
        showToast("No media loaded to save.", "error");
        return;
    }

    try {
        const result = await saveMediaToList(mediaData, list);

        if (result.status === 'duplicate') {
            showToast(`This is already in ${list.name}.`, "info");
        } else {
            showToast(`Added to ${list.name}!`, "success");

            const safeId = list.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
            renderMediaCards(list, `watchlist-track-${safeId}`);

            document.getElementById('watchlist-picker-modal').classList.add('hidden');
        }
    } catch (err) {
        console.error("Unexpected error saving media:", err);
        showToast("Something went wrong.", "error");
    }
}

// Delete media from a list
async function handleRemoveMedia(event, tmdbId, listName, trackId) {
    event.stopPropagation();

    try {
        await removeMediaFromList(tmdbId, listName);
        showToast("Removed from list.", "info");
        renderMediaCards(listName, trackId);
    } catch (err) {
        console.error("Error removing media:", err);
        showToast("Failed to remove item.", "error");
    }
}

// Edit watchlists
export function openEditListModal(list) {
    const modal = document.getElementById('edit-list-modal');
    const nameInput = document.getElementById('edit-list-input');
    const checkbox = document.getElementById('edit-list-private');
    const visibilityText = document.getElementById('edit-list-visibility-text');
    const submitBtn = document.getElementById('save-list-edit-btn');
    const deleteBtn = document.getElementById('delete-list-btn');

    modal.classList.remove('hidden');

    nameInput.value = list.name;
    checkbox.checked = false;

    if (list.is_private) {
        visibilityText.textContent = "Change list to public";
    } else {
        visibilityText.textContent = "Change list to private";
    }

    submitBtn.onclick = async () => {
        const newName = nameInput.value.trim();

        const newIsPrivate = checkbox.checked ? !list.is_private : list.is_private;

        if (!newName) {
            showToast("List name cannot be empty.", "error");
            return;
        }

        if (list.name === newName && !checkbox.checked) {
            modal.classList.add('hidden');
            return;
        }

        const customLists = await getAvailableCustomLists();

        // Prevent dups
        if (list.name !== newName && customLists.some(l => l.name.toLowerCase() === newName.toLowerCase())) {
            showToast("You already have a list with this name.", "info");
            return;
        }
        if (newName.toLowerCase() === 'favourites') {
            showToast("You already have a Favourites", "error");
            return;
        }

        try {
            // Update list
            const { error: dbError } = await supabase
            .from('lists')
            .update({ name: newName, is_private: newIsPrivate })
            .eq('id', list.id)

            if (dbError) throw dbError;

            modal.classList.add('hidden');
            renderProfileWatchlists();

        } catch (err) {
            console.error("Error updating list:", err);
            showToast("Failed to update list.", "error");
        }
    };

    deleteBtn.onclick = async () => {
        const isSure = window.confirm(`Are you sure you want to delete "${list.name}"? This will remove all saved movies and cannot be undone.`);

        if (!isSure) return;

        deleteBtn.disabled = true;
        const originalContent = deleteBtn.innerHTML;
        deleteBtn.textContent = "Deleting...";

        try {
            // 2. Delete all movies inside this list from the SQL Table
            const { error: dbError } = await supabase
            .from('lists')
            .delete()
            .eq('id', list.id)

            if (dbError) throw dbError;

            // 5. Success and Cleanup
            showToast("List deleted.", "success");
            modal.classList.add('hidden');
            renderProfileWatchlists();

        } catch (err) {
            console.error("Error deleting list:", err);
            showToast("Failed to delete list.", "error");
        } finally {
            // Reset the button state just in case
            deleteBtn.disabled = false;
            deleteBtn.innerHTML = originalContent;
        }
    };
}
window.openEditListModal = openEditListModal;

window.addEventListener('auth-state-changed',async () => {
    console.log("Auth state changed. Refreshing Profile Data...");
    updateProfilePage();

    if (appState.currentUser) {
        await syncLocalFavouritesToCloud();
    }
    
    renderProfileWatchlists();
});