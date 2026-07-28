// Expects the actual data arrays to be passed in!
export function renderAllWatchlists(customLists) {
    const container = document.getElementById('profile-watchlists-container');
    if (!container) return;

    // 1. Clear the board for a fresh render
    container.innerHTML = '';

    // 2. Handle Container Visibility
    if (customLists.length > 0) {
        container.classList.remove('hidden');
    } else {
        container.classList.add('hidden');
    }

    // 3. Loop through lists and append the DOM for each track
    customLists.forEach(list => {
        const trackDOM = createWatchlistTrack(list);
        container.appendChild(trackDOM);
    });
}

// Helper: Builds the DOM for a single row (The "Shelf")
function createWatchlistTrack(list) {
    const template = document.getElementById('watchlist-row-template');
    const clone = template.content.cloneNode(true);

    const nameEl = clone.querySelector('.wl-row-name');
    const trackEl = clone.querySelector('.wl-row-track');
    const editBtn = clone.querySelector('.wl-row-edit-btn');

    // Set Name
    nameEl.textContent = list.name;

    // Add Public Icon if necessary
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

    // Generate Safe ID for the track (so we can find it later to insert posters)
    const safeId = list.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    trackEl.id = `watchlist-track-${safeId}`;

    return clone;
}

// Render cards
/**
 * Renders an array of media items into a specific track.
 * @param {Array} mediaData - The array of movie objects to render.
 * @param {string} trackId - The DOM ID of the container track.
 * @param {Function} onRemoveClick - Callback for when the remove button is clicked. If null, the button is hidden.
 * @param {Function} onCardClick - Callback for when the poster itself is clicked.
 */
export function renderMediaCards(mediaData, trackId, onRemoveClick = null, onCardClick = null) {
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

    // 1. Clear existing cards
    trackEl.querySelectorAll('.poster-card').forEach(card => card.remove());

    // 2. Handle Empty State
    if (!mediaData || mediaData.length === 0) {
        if (emptyState) emptyState.style.display = 'block';
        return;
    }

    if (emptyState) emptyState.style.display = 'none';

    // 3. Render Cards
    mediaData.forEach(media => {
        const clone = cardTemplate.content.cloneNode(true);
        const card = clone.querySelector('.poster-card');
        const img = clone.querySelector('.poster-img');
        const title = clone.querySelector('.poster-title');
        const skeleton = clone.querySelector('.poster-skeleton');
        const removeBtn = clone.querySelector('.remove-btn');

        title.textContent = media.title;

        // Image Loading Logic
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

        if (!onRemoveClick) {
            if (removeBtn) removeBtn.remove();
        } else {
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                onRemoveClick(media.tmdb_id);
            };
        }
        
        // 5. Attach Card Click Callback
        if (onCardClick) {
            card.onclick = () => onCardClick(media);
        }

        trackEl.appendChild(clone);
    });
}