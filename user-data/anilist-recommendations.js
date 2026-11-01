import { fetchAniListRecommendations, fetchAniListRelations, fetchAniListDetail } from './anilist-data.js';
import { initGlobalDrag, isDragging } from '../user-addons/row-drag.js';
import { showToast } from '../services/config.js';

const controllers = new Map();
const rows = {
    recommendations: { fetchItems: fetchAniListRecommendations, loading: 'Loading recommendations from AniList...', empty: 'No recommendations on AniList yet.' },
    related: { fetchItems: fetchAniListRelations, loading: 'Loading related anime from AniList...', empty: 'No related anime on AniList yet.' }
};
const formatLabels = { MOVIE: 'Movie', TV: 'TV', TV_SHORT: 'TV short', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'Special', MUSIC: 'Music' };

export function loadAniListDetailRows(media, openDetail) {
    return Promise.all(Object.keys(rows).map(kind => loadAniListRow(kind, media, openDetail)));
}

async function loadAniListRow(kind, media, openDetail) {
    controllers.get(kind)?.abort();
    const request = new AbortController();
    controllers.set(kind, request);
    const section = document.getElementById(`detail-anilist-${kind}`);
    if (!section) return;
    const { fetchItems, loading, empty } = rows[kind];
    const track = section.querySelector('.anilist-media-track');
    const status = section.querySelector('[role="status"]');
    const retry = section.querySelector('.anilist-media-retry');
    track.replaceChildren();
    track.scrollLeft = 0;
    section.classList.toggle('hidden', !media?.anilistId);
    section.setAttribute('aria-busy', 'false');
    retry.classList.add('hidden');
    retry.onclick = null;
    if (!media?.anilistId) return;

    const isCurrent = () => !request.signal.aborted
        && !document.getElementById('full-detail-view').classList.contains('hidden');
    section.querySelector('.anilist-media-link').href = `https://anilist.co/anime/${media.anilistId}`;
    status.textContent = loading;
    section.setAttribute('aria-busy', 'true');
    initGlobalDrag();
    try {
        const items = await fetchItems(media.anilistId, { signal: request.signal });
        if (!isCurrent()) return;
        status.textContent = items.length ? '' : empty;
        for (const item of items) {
            const fragment = document.getElementById('poster-card-template').content.cloneNode(true);
            const card = fragment.querySelector('.poster-card');
            card.dataset.anilistId = item.anilistId;
            card.setAttribute('role', 'button');
            card.setAttribute('aria-label', `Open ${item.title}`);
            card.tabIndex = 0;
            card.classList.add('text-left', 'focus-visible:outline-none', 'focus-visible:ring-2', 'focus-visible:ring-blue-500', 'rounded-xl');
            card.querySelector('.remove-btn').remove();
            card.querySelector('.poster-title').textContent = item.title;
            if (item.relationType) {
                const label = document.createElement('p');
                const relation = item.relationType.replaceAll('_', ' ').toLowerCase();
                label.textContent = [relation.charAt(0).toUpperCase() + relation.slice(1), formatLabels[item.format]].filter(Boolean).join(' · ');
                label.className = 'text-[10px] text-blue-400 mt-1 font-medium';
                card.querySelector('.poster-title').after(label);
            }
            const image = card.querySelector('.poster-img');
            image.alt = item.title;
            if (item.poster) image.src = item.poster;
            else image.hidden = true;
            image.addEventListener('error', () => { image.hidden = true; }, { once: true });
            if (item.year) {
                const year = card.querySelector('.poster-year');
                year.textContent = item.year;
                year.classList.remove('hidden');
            }
            card.addEventListener('click', async event => {
                event.stopPropagation();
                if ((isDragging && event.detail !== 0) || !isCurrent() || card.getAttribute('aria-busy') === 'true') return;
                card.setAttribute('aria-busy', 'true');
                try {
                    const detail = await fetchAniListDetail(item, { signal: request.signal });
                    if (isCurrent()) {
                        await openDetail(detail);
                        document.getElementById('full-detail-view').scrollTop = 0;
                    }
                } catch (error) {
                    if (isCurrent()) showToast(error.message, 'error');
                } finally {
                    card.removeAttribute('aria-busy');
                }
            });
            card.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    card.click();
                }
            });
            track.append(fragment);
        }
    } catch (error) {
        if (!isCurrent()) return;
        status.textContent = error.message;
        retry.classList.remove('hidden');
        retry.onclick = () => loadAniListRow(kind, media, openDetail);
    } finally {
        if (!request.signal.aborted) section.setAttribute('aria-busy', 'false');
    }
}
