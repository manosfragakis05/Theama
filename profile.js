import { appState, showToast } from './services/config.js';
import { supabase } from './services/db.js';
import { mediaStore, openMasterDetail } from './api.js';

// ==========================================
// PHASE 1: DATA HELPERS (Getters & Setters)
// ==========================================

/**
 * Gets the custom lists from the user's profile metadata.
 * Guests always return an empty array.
 */
function getAvailableCustomLists() {
    if (!appState.currentUser) return [];
    return appState.currentUser.user_metadata?.custom_lists || [];
}

/**
 * Fetches media for a specific list.
 * Routes to Supabase for users, LocalStorage for guests.
 */
async function getListMedia(listName) {
    const normalizedList = listName.toLowerCase();

    if (appState.currentUser) {
        // --- LOGGED IN: Fetch from Supabase ---
        const { data, error } = await supabase
            .from('watchlists')
            .select('*')
            .eq('user_id', appState.currentUser.id)
            .eq('status', normalizedList)
            .order('created_at', { ascending: false });

        if (error) {
            console.error(`Error fetching ${listName}:`, error.message);
            return [];
        }
        return data || [];
    } else {
        // --- GUEST: Fetch from LocalStorage ---
        const localData = localStorage.getItem(`guest_watchlist_${normalizedList}`);
        return localData ? JSON.parse(localData) : [];
    }
}

/**
 * Saves a single media item to a specific list.
 */
async function saveMediaToList(mediaData, listName) {
    const normalizedList = listName.toLowerCase();

    const payload = {
        tmdb_id: mediaData.id,
        media_type: mediaData.type,
        title: mediaData.title,
        poster_path: mediaData.poster,
        status: normalizedList,
    };

    if (appState.currentUser) {
        // --- LOGGED IN: Save to Supabase ---
        payload.user_id = appState.currentUser.id;
        const { error } = await supabase.from('watchlists').insert(payload);

        if (error && error.code === '23505') return { status: 'duplicate' };
        if (error) throw error;

        return { status: 'success' };
    } else {
        // --- GUEST: Save to LocalStorage ---
        const existingData = await getListMedia(normalizedList);

        if (existingData.some(item => item.tmdb_id === payload.tmdb_id)) {
            return { status: 'duplicate' };
        }

        existingData.unshift(payload);
        localStorage.setItem(`guest_watchlist_${normalizedList}`, JSON.stringify(existingData));
        return { status: 'success' };
    }
}

/**
 * Removes a single media item from a specific list.
 */
async function removeMediaFromList(tmdbId, listName) {
    const normalizedList = listName.toLowerCase();

    if (appState.currentUser) {
        const { error } = await supabase
            .from('watchlists')
            .delete()
            .eq('user_id', appState.currentUser.id)
            .eq('tmdb_id', tmdbId)
            .eq('status', normalizedList);

        if (error) throw error;
    } else {
        const existingData = await getListMedia(normalizedList);
        const filteredData = existingData.filter(item => item.tmdb_id !== tmdbId);
        localStorage.setItem(`guest_watchlist_${normalizedList}`, JSON.stringify(filteredData));
    }
}


// ==========================================
// PHASE 2: UI RENDERERS (The Painters)
// ==========================================

/**
 * Draws the empty container rows for Custom Lists and triggers the media fetch.
 */
export async function renderProfileWatchlists() {
    const container = document.getElementById('profile-watchlists-container');
    const template = document.getElementById('watchlist-row-template');

    if (!container || !template) return;

    container.innerHTML = '';

    const customLists = getAvailableCustomLists();

    customLists.forEach(list => {
        const clone = template.content.cloneNode(true);
        const nameEl = clone.querySelector('.wl-row-name');
        const iconEl = clone.querySelector('.wl-row-icon');
        const privacyEl = clone.querySelector('.wl-row-privacy');
        const trackEl = clone.querySelector('.wl-row-track');

        nameEl.textContent = list.name;
        iconEl.textContent = list.name.charAt(0);
        if (list.isPrivate) privacyEl.classList.remove('hidden');

        const safeId = list.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        trackEl.id = `watchlist-track-${safeId}`;

        container.appendChild(clone);
    });

    // FIX: Run all card renders concurrently and surface any rejections instead
    // of fire-and-forgetting them as unawaited calls.
    const renderTasks = [
        renderMediaCards('favorites', 'watchlist-track-favorites'),
        ...customLists.map(list => {
            const safeId = list.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
            return renderMediaCards(list.name, `watchlist-track-${safeId}`);
        }),
    ];

    await Promise.all(renderTasks).catch(err =>
        console.error('Error rendering watchlist cards:', err)
    );
}

/**
 * Fetches the media for a list and draws the poster cards inside the specified track.
 */
async function renderMediaCards(listName, trackId) {
    const trackEl = document.getElementById(trackId);
    if (!trackEl) return;

    // FIX: Guard against a missing template element before iterating over media
    // data — without this, cardTemplate.content.cloneNode() throws a TypeError.
    const cardTemplate = document.getElementById('poster-card-template');
    if (!cardTemplate) {
        console.error('Missing required template: #poster-card-template');
        return;
    }

    const emptyState =
        trackEl.querySelector('.wl-row-empty') ||
        trackEl.querySelector('[id$="-empty-state"]');

    trackEl.querySelectorAll('.poster-card').forEach(card => card.remove());

    const mediaData = await getListMedia(listName);

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

        removeBtn.onclick = (e) => handleRemoveMedia(e, media.tmdb_id, listName, trackId);
        card.onclick = () => openMasterDetail(media.tmdb_id, media.title, media.media_type, media.poster_path, media.poster_path);

        trackEl.appendChild(clone);
    });
}

/**
 * Builds the popup menu when a user clicks "Add to Watchlist".
 */
export function openWatchlists() {
    const modal = document.getElementById('watchlist-picker-modal');
    const container = document.getElementById('watchlist-options-container');
    if (!modal || !container) return;

    const customLists = getAvailableCustomLists();
    container.innerHTML = '';

    // --- Always render the Favorites button first ---
    // innerHTML is safe here because all content is hardcoded — no user data.
    const favBtn = document.createElement('button');
    favBtn.className = 'flex items-center justify-between p-3 rounded-xl bg-slate-800 hover:bg-red-600/20 border border-slate-700 hover:border-red-500 transition text-left group shrink-0';
    favBtn.innerHTML = `
        <div class="flex items-center gap-4">
            <div class="w-12 h-12 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center justify-center text-red-500 group-hover:text-white group-hover:bg-red-500 transition shadow-sm font-black text-xl">
                <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            </div>
            <div class="overflow-hidden">
                <div class="font-bold text-white group-hover:text-red-400 transition truncate">Favorites</div>
                <div class="text-[10px] text-slate-400 flex items-center mt-0.5 uppercase tracking-wider font-bold">
                    ${appState.currentUser ? 'Saved to Cloud' : 'Saved to Device'}
                </div>
            </div>
        </div>
    `;
    favBtn.addEventListener('click', () => addToWatchlist('favorites'));
    container.appendChild(favBtn);

    // --- Render Custom Lists below (only if any exist) ---
    if (customLists.length > 0) {
        const divider = document.createElement('div');
        divider.className = 'h-px bg-slate-800 my-1';
        container.appendChild(divider);

        customLists.forEach(list => {
            const listBtn = document.createElement('button');
            listBtn.className = 'flex items-center justify-between p-3 rounded-xl bg-slate-800 hover:bg-emerald-600/20 border border-slate-700 hover:border-emerald-500 transition text-left group shrink-0';

            // FIX: Use innerHTML only for the static structure, then assign
            // user-controlled values via textContent to prevent XSS. The old
            // approach of interpolating list.name into an innerHTML string
            // (even with the safeName single-quote escape) was unsafe.
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
            listBtn.querySelector('[data-list-privacy]').textContent = list.isPrivate ? 'Private List' : 'Public List';

            listBtn.addEventListener('click', () => addToWatchlist(list.name));
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


// ==========================================
// PHASE 3: ACTION HANDLERS (The Click Events)
// ==========================================

/**
 * Handles the "Create List" button click. Updates metadata and re-renders UI.
 */
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

    const existingLists = getAvailableCustomLists();
    if (existingLists.some(list => list.name.toLowerCase() === listName.toLowerCase())) {
        showToast("You already have a list with this name.", "info");
        return;
    }

    const updatedLists = [...existingLists, { name: listName, isPrivate }];

    try {
        const { data, error } = await supabase.auth.updateUser({
            data: { custom_lists: updatedLists },
        });
        if (error) throw error;

        // FIX: Sync appState immediately after the Supabase update so that the
        // renderProfileWatchlists() call below reads the new list. Without this,
        // getAvailableCustomLists() returns stale metadata because Supabase's
        // onAuthStateChange fires asynchronously — after renderProfileWatchlists
        // has already finished.
        if (data?.user) {
            appState.currentUser = data.user;
        } else {
            appState.currentUser.user_metadata.custom_lists = updatedLists;
        }

        showToast("List created successfully!", "success");
        nameInput.value = '';
        privateToggle.checked = false;

        document.getElementById('create-list-modal').classList.add('hidden');
        renderProfileWatchlists();
    } catch (err) {
        console.error("Error creating list:", err);
        showToast("Failed to create list.", "error");
    }
}

/**
 * Handles the click inside the Watchlists modal to actually save the movie.
 */
export async function addToWatchlist(listName) {
    const mediaData = mediaStore.exportForLibrary();

    if (!mediaData || !mediaData.id) {
        showToast("No media loaded to save.", "error");
        return;
    }

    try {
        const result = await saveMediaToList(mediaData, listName);

        if (result.status === 'duplicate') {
            showToast(`This is already in ${listName}.`, "info");
        } else {
            showToast(`Added to ${listName}!`, "success");

            // FIX: Removed a redundant ternary — for every list name, safeId
            // and the resulting trackId are already identical between branches.
            const safeId = listName.toLowerCase().replace(/[^a-z0-9]/g, '-');
            renderMediaCards(listName, `watchlist-track-${safeId}`);

            document.getElementById('watchlist-picker-modal').classList.add('hidden');
        }
    } catch (err) {
        console.error("Unexpected error saving media:", err);
        showToast("Something went wrong.", "error");
    }
}

// FIX: Expose on window so any HTML that calls addToWatchlist() as a global
// function still works. The original comment described this assignment but
// the line was never actually written, causing a ReferenceError at runtime.
window.addToWatchlist = addToWatchlist;

/**
 * Handles clicking the little 'X' on a poster card to delete it.
 */
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

// ==========================================
// INITIALIZATION
// ==========================================

window.addEventListener('auth-state-changed', () => {
    console.log("Auth state changed. Refreshing Profile Data...");
    updateProfilePage();
    renderProfileWatchlists();
});