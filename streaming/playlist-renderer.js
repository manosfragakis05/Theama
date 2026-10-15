import { getQueueState, selectQueueItem, toggleShuffle, clearQueue, removeFromQueue } from './playlist.js';
import { requestLink } from './player.js';
import { isDragging } from '../user-addons/catalog-renderer.js';

function createQueueCard(item, status, isCurrent = false) {
    const card = document.getElementById('queue-item-template').content.firstElementChild.cloneNode(true);
    const title = item.title || item.fileName || 'Untitled';
    const image = card.querySelector('.queue-item-thumbnail');
    const fallback = card.querySelector('.queue-item-fallback');

    card.dataset.uid = item.uid;

    const button = card.querySelector('.queue-item-play');
    button.setAttribute('aria-label', `Play ${title}`);
    button.addEventListener('click', () => {
        if (isDragging) return;
        const selected = selectQueueItem(item.uid);
        if (selected) requestLink(selected.tid, selected.fid, selected.torrentName, selected.fileName, selected.uid);
    });

    if (isCurrent) card.setAttribute('aria-current', 'true');
    card.querySelector('.queue-item-status').textContent = status;
    card.querySelector('.queue-item-title').textContent = title;
    card.querySelector('.queue-item-title').title = title;

    card.querySelector('.queue-item-meta').textContent = [
        item.seriesTitle,
        item.season,
        item.badge || (item.episodeNumber != null ? `Episode ${item.episodeNumber}` : '')
    ].filter(Boolean).join(' · ');

    fallback.textContent = title;

    const removeButton = card.querySelector('.queue-remove-item');
    removeButton.setAttribute('aria-label', `Remove ${title} from queue`);
    removeButton.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isDragging) return;
        removeFromQueue(item.uid);
    });

    image.addEventListener('error', () => image.classList.add('hidden'), { once: true });
    if (item.thumbnail) {
        image.src = item.thumbnail.startsWith('/')
            ? `https://image.tmdb.org/t/p/w300${item.thumbnail}`
            : item.thumbnail;
        image.classList.remove('hidden');
    }

    return card;
}

export function renderQueue(state = getQueueState()) {
    const section = document.getElementById('playback-queue');
    const list = document.getElementById('playback-queue-items');
    if (!section || !list) return;

    const fragment = document.createDocumentFragment();
    const previousUids = new Set(state.history.map(item => item.uid));
    const currentStatus = { loading: 'Loading', playing: 'Now playing', failed: 'Playback failed', idle: 'Selected' };

    state.entries.forEach(({ item, listType }) => {
        const isCurrent = Boolean(state.current && item.uid === state.current.uid);
        const status = isCurrent ? currentStatus[state.playbackStatus]
            : previousUids.has(item.uid) ? 'Previous'
                : listType === 'priority' ? 'Queued' : 'Up next';
        fragment.appendChild(createQueueCard(item, status, isCurrent));
    });

    list.replaceChildren(fragment);

    const upcomingCount = state.priority.length + state.context.length;
    document.getElementById('playback-queue-count').textContent = `${upcomingCount} up next`;

    // Sync Shuffle button visual state
    const shuffleBtn = document.getElementById('playback-queue-shuffle');
    if (shuffleBtn) {
        shuffleBtn.setAttribute('aria-pressed', String(state.isShuffled));
        shuffleBtn.classList.toggle('bg-blue-600', state.isShuffled);
        shuffleBtn.classList.toggle('text-white', state.isShuffled);
        shuffleBtn.classList.toggle('bg-slate-800', !state.isShuffled);
    }

    // Show the queue whenever entries exist, even if nothing is currently playing
    section.classList.toggle('hidden', state.entries.length === 0);
}

let isInitialized = false;

export function initializeQueueRenderer() {
    if (isInitialized) return;
    isInitialized = true;

    window.addEventListener('queue:updated', handleQueueUpdate);

    document.getElementById('playback-queue-shuffle')?.addEventListener('click', () => {
        toggleShuffle();
    });

    document.getElementById('playback-queue-clear')?.addEventListener('click', () => {
        clearQueue();
    });

    const toggleButton = document.getElementById('playback-queue-toggle');
    toggleButton?.addEventListener('click', () => {
        const expanded = toggleButton.getAttribute('aria-expanded') !== 'true';
        toggleButton.setAttribute('aria-expanded', String(expanded));
        toggleButton.setAttribute('aria-label', expanded ? 'Collapse queue' : 'Expand queue');
        toggleButton.title = expanded ? 'Collapse queue' : 'Expand queue';
        document.getElementById('playback-queue-controls').classList.toggle('hidden', !expanded);
        document.getElementById('playback-queue-items').classList.toggle('hidden', !expanded);
        document.getElementById('playback-queue-header').classList.toggle('mb-4', expanded);
    });

    renderQueue();
}

// Auto-initialize on page load so saved localStorage queues show immediately
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeQueueRenderer);
} else {
    initializeQueueRenderer();
}

function handleQueueUpdate(event) {
    renderQueue(event.detail);
}
