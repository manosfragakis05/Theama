import { openMasterDetail } from '../api.js';

export function renderAllWatchlists(customLists, onEditList = null) {
    const container = document.getElementById('profile-watchlists-container');
    if (!container) return;

    container.innerHTML = '';

    if (customLists.length > 0) {
        container.classList.remove('hidden');
    } else {
        container.classList.add('hidden');
    }

    customLists.forEach(list => {
        const clone = document.getElementById('watchlist-row-template').content.cloneNode(true);
        const nameEl = clone.querySelector('.wl-row-name');
        const trackEl = clone.querySelector('.wl-row-track');
        const editBtn = clone.querySelector('.wl-row-edit-btn');

        nameEl.textContent = list.name;

        if (!list.is_private) {
            nameEl.insertAdjacentHTML('afterend', `
            <svg class="w-5 h-5 text-slate-400 ml-2 inline-block align-middle relative -bottom-[1px] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <title>Public List</title>
                <circle cx="12" cy="12" r="10"></circle>
                <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path>
                <path d="M2 12h20"></path>
            </svg>
        `);
        }

        if (onEditList) editBtn.onclick = () => onEditList(list);
        else editBtn.remove();

        trackEl.id = `watchlist-track-${list.id}`;
        container.appendChild(clone);
    });
}

// Render cards
export function renderMediaCards(mediaData, trackId, onRemoveClick = null, onCardClick = null) {
    const trackEl = document.getElementById(trackId);
    if (!trackEl) return;

    const cardTemplate = document.getElementById('poster-card-template');

    const emptyState =
        trackEl.querySelector('.wl-row-empty') ||
        trackEl.querySelector('[id$="-empty-state"]');

    trackEl.querySelectorAll('.poster-card').forEach(card => card.remove());

    if (!mediaData || mediaData.length === 0) {
        if (emptyState) emptyState.style.display = 'block';
        return;
    }

    if (emptyState) emptyState.style.display = 'none';

    // Render Cards
    mediaData.forEach(media => {
        const clone = cardTemplate.content.cloneNode(true);
        const card = clone.querySelector('.poster-card');
        const img = clone.querySelector('.poster-img');
        const title = clone.querySelector('.poster-title');
        const yearEl = clone.querySelector('.poster-year');
        const removeBtn = clone.querySelector('.remove-btn');

        title.textContent = media.title;

        if (yearEl) yearEl.remove();

        // Remove Button
        if (onRemoveClick && removeBtn) {
            removeBtn.classList.remove('hidden');
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                onRemoveClick(media.media_id);
            };
        } else {
            if (removeBtn) removeBtn.remove();
        }

        if (media.poster_path) {
            const imgUrl = media.poster_path.startsWith('http')
                ? media.poster_path
                : `https://image.tmdb.org/t/p/w300${media.poster_path}`;
            img.src = imgUrl;
            img.onload = () => {
                img.classList.remove('opacity-0');
            };
        }

        if (onCardClick) {
            card.onclick = (e) => {
                e.stopPropagation();
                onCardClick(media);
            }
        }

        trackEl.appendChild(clone);
    });
}

export function showPersonalProfile(username) {
    const usernameDisplay = document.getElementById('profile-username-display');
    if (usernameDisplay) {
        const heading = usernameDisplay.parentElement;
        heading.textContent = 'Welcome, ';
        heading.appendChild(usernameDisplay);
        heading.append('!');
        usernameDisplay.textContent = username;
        if (heading.nextElementSibling) {
            heading.nextElementSibling.textContent = 'Manage your watchlists and profile.';
        }
    }

    document.getElementById('back-to-profile-btn')?.classList.add('hidden');
    const followBtn = document.getElementById('profile-follow-btn');
    if (followBtn) followBtn.style.display = 'none';

    for (const element of [
        document.getElementById('profile-settings-btn'),
        document.getElementById('profile-share-btn'),
        document.querySelector('button[onclick*="create-list-modal"]'),
        document.getElementById('default-watchlists-container')
    ]) {
        if (element) element.style.display = '';
    }

    const watchlistsContainer = document.getElementById('profile-watchlists-container');
    if (watchlistsContainer) watchlistsContainer.innerHTML = '';
}

export function renderPublicProfile(userId, profile) {
    const usernameDisplay = document.getElementById('profile-username-display');
    const heading = usernameDisplay.parentElement;
    heading.replaceChildren(usernameDisplay);
    usernameDisplay.textContent = profile?.username || 'User not found';
    heading.append("'s Profile");
    heading.nextElementSibling.textContent = profile
        ? 'Browsing public watchlists.' : 'This profile is unavailable.';

    document.getElementById('back-to-profile-btn').classList.remove('hidden');
    for (const element of [
        document.getElementById('profile-settings-btn'),
        document.getElementById('profile-share-btn'),
        document.querySelector('button[onclick*="create-list-modal"]'),
        document.getElementById('default-watchlists-container')
    ]) {
        if (element) element.style.display = 'none';
    }

    const followBtn = document.getElementById('profile-follow-btn');
    followBtn.dataset.friendId = userId;
    followBtn.style.display = profile ? 'flex' : 'none';
    if (profile) setFollowButton(profile.isFollowing);

    renderAllWatchlists(profile?.lists || []);
    for (const list of profile?.lists || []) {
        renderMediaCards(list.media || [], `watchlist-track-${list.id}`, null, media => {
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

export function setFollowButton(isFollowing) {
    const btn = document.getElementById('profile-follow-btn');
    btn.dataset.following = String(isFollowing);
    btn.className = isFollowing
        ? 'px-6 py-3 rounded-2xl font-bold text-sm transition-all flex items-center gap-2 border shadow-sm outline-none bg-slate-800/80 text-slate-300 border-slate-700 hover:bg-slate-700 hover:text-white'
        : 'px-6 py-3 rounded-2xl font-bold text-sm transition-all flex items-center gap-2 border shadow-sm outline-none bg-blue-600 hover:bg-blue-500 text-white border-blue-500';
    document.getElementById('follow-text').textContent = isFollowing ? 'Following' : 'Follow';
    document.getElementById('follow-icon').innerHTML = isFollowing
        ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>'
        : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"></path>';
}

export function renderFriendsSidebar(friendsList) {
    const container = document.getElementById('sidebar-following-list');
    const emptyState = document.getElementById('sidebar-following-empty');
    const template = document.getElementById('following-user-template');
    if (!container || !template) return;

    container.querySelectorAll('.following-btn').forEach(btn => btn.remove());
    if (!friendsList || friendsList.length === 0) {
        if (emptyState) emptyState.classList.remove('hidden');
        return;
    }

    if (emptyState) emptyState.classList.add('hidden');
    friendsList.forEach(friend => {
        const clone = template.content.cloneNode(true);
        const btn = clone.querySelector('.following-btn');
        const avatar = clone.querySelector('.following-avatar');
        const nameEl = clone.querySelector('.following-name');

        nameEl.textContent = friend.username;
        avatar.textContent = friend.username.charAt(0).toUpperCase();
        btn.dataset.friendId = friend.id;
        container.appendChild(clone);
    });
}

export function renderWatchlistPicker(customLists, favList, isLoggedIn, onSelect) {
    const modal = document.getElementById('watchlist-picker-modal');
    const container = document.getElementById('watchlist-options-container');
    if (!modal || !container) return;

    container.innerHTML = '';
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
                    ${isLoggedIn ? 'Saved to Cloud (Private)' : 'Saved to Device'}
                </div>
            </div>
        </div>
    `;
    favBtn.addEventListener('click', () => onSelect(favList));
    container.appendChild(favBtn);

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
            listBtn.addEventListener('click', () => onSelect(list));
            container.appendChild(listBtn);
        });
    }
    modal.classList.remove('hidden');
}

export function closeWatchlistPicker() {
    document.getElementById('watchlist-picker-modal')?.classList.add('hidden');
}

export function getNewListInput() {
    const nameInput = document.getElementById('new-list-input');
    const privateToggle = document.getElementById('new-list-private');
    if (!nameInput || !privateToggle) return null;
    return { name: nameInput.value.trim(), isPrivate: privateToggle.checked };
}

export function clearNewListInput() {
    document.getElementById('new-list-input').value = '';
    document.getElementById('new-list-private').checked = false;
    document.getElementById('create-list-modal').classList.add('hidden');
}

export function showEditListModal(list, onSave, onDelete) {
    const modal = document.getElementById('edit-list-modal');
    const nameInput = document.getElementById('edit-list-input');
    const checkbox = document.getElementById('edit-list-private');
    const visibilityText = document.getElementById('edit-list-visibility-text');
    const submitBtn = document.getElementById('save-list-edit-btn');
    const deleteBtn = document.getElementById('delete-list-btn');

    modal.classList.remove('hidden');
    nameInput.value = list.name;
    checkbox.checked = false;
    visibilityText.textContent = list.is_private ? 'Change list to public' : 'Change list to private';

    submitBtn.onclick = () => onSave(nameInput.value.trim(), checkbox.checked);
    deleteBtn.onclick = () => onDelete();
}

export function closeEditListModal() {
    document.getElementById('edit-list-modal')?.classList.add('hidden');
}

export function setEditListDeleting(isDeleting) {
    const deleteBtn = document.getElementById('delete-list-btn');
    deleteBtn.disabled = isDeleting;
    if (isDeleting) {
        deleteBtn.dataset.originalContent = deleteBtn.innerHTML;
        deleteBtn.textContent = 'Deleting...';
    } else {
        deleteBtn.innerHTML = deleteBtn.dataset.originalContent;
        delete deleteBtn.dataset.originalContent;
    }
}
