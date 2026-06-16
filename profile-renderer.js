import { getAvailableCustomLists, getFavouritesList, addToWatchlist } from "./profile";
import { appState, showToast } from "./services/config";
import { supabase } from "./services/db";

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