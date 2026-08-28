import { openEditListModal } from "./profile";

// Pass data arrays
export function renderAllWatchlists(customLists) {
    const container = document.getElementById('profile-watchlists-container');
    if (!container) return;

    container.innerHTML = '';

    if (customLists.length > 0) {
        container.classList.remove('hidden');
    } else {
        container.classList.add('hidden');
    }

    customLists.forEach(list => {
        const trackDOM = createWatchlistTrack(list);
        container.appendChild(trackDOM);
    });
}

// Build row
function createWatchlistTrack(list) {
    const template = document.getElementById('watchlist-row-template');
    const clone = template.content.cloneNode(true);

    const nameEl = clone.querySelector('.wl-row-name');
    const trackEl = clone.querySelector('.wl-row-track');
    const editBtn = clone.querySelector('.wl-row-edit-btn');

    nameEl.textContent = list.name;

    // Add icon
    if (!list.is_private) {
        nameEl.insertAdjacentHTML('afterend', `
            <svg class="w-[18px] h-[18px] text-slate-400 ml-2 inline-block align-middle relative -bottom-[1px] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" title="Public List">
                <circle cx="12" cy="12" r="10"></circle>
                <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path>
                <path d="M2 12h20"></path>
            </svg>
        `);
    }

    // Attach Edit Event
    if (editBtn) editBtn.onclick = () => openEditListModal(list);

    const safeId = list.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    trackEl.id = `watchlist-track-${safeId}`;

    return clone;
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
        const skeleton = clone.getElementById('poster-skeleton');
        const removeBtn = clone.querySelector('.remove-btn');

        title.textContent = media.title;

        if (yearEl) yearEl.remove();

        // Remove Button
        if (onRemoveClick && removeBtn) {
            removeBtn.classList.remove('hidden');
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                onRemoveClick(media.tmdb_id);
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
                skeleton.classList.add('hidden');
                img.classList.remove('opacity-0');
            };
        } else {
            skeleton.classList.add('hidden');
        }

        if (onCardClick) {
            card.onclick = () => onCardClick(media);
        }

        trackEl.appendChild(clone);
    });
}