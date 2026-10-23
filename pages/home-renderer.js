import { openMasterDetail } from '../api.js';
import {
    isDragging, initGlobalDrag, initGlobalClickListener, injectCatalogShell, renderRow, teardownRow
} from '../user-addons/catalog-renderer.js';
import { homeCatalogs, formatCatalogItem } from '../user-addons/catalogs.js';

function clearHomeRecommendations(root) {
    for (const type of ['movie', 'tv']) {
        const containerId = `home-recommended-${type}-row`;
        teardownRow(containerId);
        delete homeCatalogs[containerId];
    }
    root.replaceChildren();
}

function createHomeStatus(message) {
    const status = document.createElement('p');
    status.className = 'home-empty-state text-sm text-slate-400';
    status.setAttribute('role', 'status');
    status.textContent = message;
    return status;
}

export function renderHomeRecommendations(root, recommendations, message = null) {
    clearHomeRecommendations(root);
    initGlobalDrag();
    initGlobalClickListener();
    root.hidden = false;
    for (const type of ['movie', 'tv']) {
        const items = (recommendations[type] || []).map(item => formatCatalogItem(item, type));
        if (!items.length) {
            const section = document.createElement('section');
            section.className = 'catalog-section';
            const heading = document.createElement('h2');
            heading.className = 'mb-4 text-white';
            heading.id = `home-recommended-${type}-heading`;
            heading.textContent = type === 'movie' ? 'Recommended movies' : 'Recommended series';
            section.setAttribute('aria-labelledby', heading.id);
            section.append(heading, createHomeStatus(message || (type === 'movie'
                ? 'Add movies to your library to discover your next favourite.'
                : 'Add series to your library to find your next binge-worthy show.')));
            root.appendChild(section);
            continue;
        }
        const containerId = `home-recommended-${type}-row`;
        const catalog = {
            containerId, type, title: type === 'movie' ? 'Recommended movies' : 'Recommended series',
            addonName: 'customTMDB', items, hasOptions: false, hasMore: false, loading: false
        };
        homeCatalogs[containerId] = catalog;
        root.hidden = false;
        injectCatalogShell(catalog, root);
        const row = document.getElementById(containerId);
        row.tabIndex = 0;
        row.setAttribute('aria-label', catalog.title);
        renderRow(items, catalog);
    }
}

export function renderHomeRecommendationsMessage(root, message) {
    renderHomeRecommendations(root, {}, message);
}

function cloneTemplate(id) {
    return document.getElementById(id).content.firstElementChild.cloneNode(true);
}

function imageUrl(path, size) {
    return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

let carouselListeners = null;

export function renderHomeMessage(root, message, onRetry = null) {
    carouselListeners?.abort();
    const container = cloneTemplate('home-hero-message-template');
    container.querySelector('.home-hero-message-text').textContent = message;
    const retry = container.querySelector('.home-hero-retry');
    retry.classList.toggle('hidden', !onRetry);
    if (onRetry) retry.addEventListener('click', onRetry);
    root.replaceChildren(container);
}

function createSlide(item, index, count) {
    const slide = cloneTemplate('home-hero-slide-template');
    const title = item.title || item.name || 'Untitled';
    const year = (item.release_date || item.first_air_date || '').slice(0, 4);
    const rating = Number(item.vote_average);
    const backdrop = imageUrl(item.backdrop_path, 'original');
    const poster = imageUrl(item.poster_path, 'w500');
    slide.setAttribute('aria-label', `${index + 1} of ${count}: ${title}`);

    const artwork = slide.querySelector('picture');
    if (backdrop || poster) {
        const source = artwork.querySelector('source');
        if (poster) source.srcset = `${poster} 500w, ${imageUrl(item.poster_path, 'w780')} 780w`;
        else source.remove();
        const image = artwork.querySelector('img');
        image.loading = index === 0 ? 'eager' : 'lazy';
        image.fetchPriority = index === 0 ? 'high' : 'low';
        image.src = backdrop || poster;
        let fallbackAttempted = false;
        image.addEventListener('error', () => {
            if (!fallbackAttempted && poster) {
                fallbackAttempted = true;
                artwork.querySelector('source')?.remove();
                image.removeAttribute('srcset');
                image.src = poster;
            } else artwork.remove();
        });
    } else artwork.remove();

    slide.querySelector('.home-hero-type').textContent = item.media_type === 'tv' ? 'Series' : 'Movie';
    const yearElement = slide.querySelector('.home-hero-year');
    yearElement.textContent = year;
    yearElement.classList.toggle('hidden', !year);
    const score = slide.querySelector('.home-hero-rating');
    score.classList.toggle('hidden', !Number.isFinite(rating) || rating <= 0);
    if (Number.isFinite(rating) && rating > 0) {
        score.textContent = `\u2605 ${rating.toFixed(1)}`;
        score.setAttribute('aria-label', `Rated ${rating.toFixed(1)} out of 10`);
    }
    slide.querySelector('.home-hero-title').textContent = title;
    const overview = slide.querySelector('.home-hero-overview');
    overview.textContent = item.overview || '';
    overview.classList.toggle('hidden', !item.overview);
    const button = slide.querySelector('.home-hero-details');
    button.setAttribute('aria-label', `View details for ${title}`);
    button.addEventListener('click', () => openMasterDetail({
        id: item.id, title, type: item.media_type, year,
        overview: item.overview || '',
        rating: Number.isFinite(rating) && rating > 0 ? rating.toFixed(1) : '',
        poster, backdrop: backdrop || poster, addonName: 'customTMDB'
    }));
    return slide;
}

export function renderHomeCarousel(root, items) {
    carouselListeners?.abort();
    carouselListeners = new AbortController();
    let activeIndex = 0;
    let pointerStart = null;
    let suppressClick = false;
    const carousel = cloneTemplate('home-hero-carousel-template');
    const viewport = carousel.querySelector('.home-hero-viewport');
    const track = carousel.querySelector('.home-hero-track');
    const controls = carousel.querySelector('.home-hero-controls');
    const dots = carousel.querySelector('.home-hero-dots');
    const slides = items.map((item, index) => createSlide(item, index, items.length));
    const dotButtons = items.map((item, index) => {
        const button = cloneTemplate('home-hero-dot-template');
        button.setAttribute('aria-label', `Show ${index + 1}: ${item.title || item.name || 'Untitled'}`);
        button.addEventListener('click', () => selectSlide(index));
        return button;
    });

    function selectSlide(index) {
        activeIndex = (index + items.length) % items.length;
        track.style.transform = `translateX(-${activeIndex * 100}%)`;
        slides.forEach((slide, i) => {
            slide.inert = i !== activeIndex;
            slide.setAttribute('aria-hidden', String(i !== activeIndex));
            dotButtons[i].setAttribute('aria-current', String(i === activeIndex));
        });
    }

    carousel.querySelector('.home-hero-previous').addEventListener('click', () => selectSlide(activeIndex - 1));
    carousel.querySelector('.home-hero-next').addEventListener('click', () => selectSlide(activeIndex + 1));
    root.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        if (event.target.closest('.home-hero-slide')) viewport.focus({ preventScroll: true });
        selectSlide(activeIndex + (event.key === 'ArrowRight' ? 1 : -1));
    }, { signal: carouselListeners.signal });
    viewport.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        suppressClick = false;
        pointerStart = { x: event.clientX, y: event.clientY };
        // Keep taps targeted at the slide button while tracking swipes outside it.
        const target = event.target.closest('.home-hero-details') || viewport;
        target.setPointerCapture(event.pointerId);
    });
    viewport.addEventListener('pointerup', event => {
        if (!pointerStart) return;
        const dx = event.clientX - pointerStart.x;
        const dy = event.clientY - pointerStart.y;
        pointerStart = null;
        suppressClick = Math.abs(dx) > 10 || Math.abs(dy) > 10;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            selectSlide(activeIndex + (dx < 0 ? 1 : -1));
        }
    });
    viewport.addEventListener('pointercancel', () => {
        pointerStart = null;
        suppressClick = true;
    });
    viewport.addEventListener('click', event => {
        // Keyboard activation has no pointer movement and should always work.
        if (!suppressClick || event.detail === 0) return;
        event.preventDefault();
        event.stopPropagation();
    }, { capture: true });
    track.append(...slides);
    dots.append(...dotButtons);
    controls.classList.toggle('hidden', items.length < 2);
    root.replaceChildren(carousel);
    selectSlide(0);
}

function createWatchProgressCard(item, onPlay, onHide) {
    const card = cloneTemplate('home-watch-card-template');
    const image = card.querySelector('.home-watch-image');
    if (item.image) {
        image.src = item.image;
        image.alt = item.type === 'tv' && item.episodeTitle ? item.episodeTitle : item.title;
        image.addEventListener('error', () => image.remove(), { once: true });
    } else image.remove();
    card.querySelector('.home-watch-badge').classList.toggle('hidden', !item.completed);
    const title = card.querySelector('.home-watch-title');
    title.textContent = item.title;
    title.title = item.title;
    const episodeLabel = item.season !== null && item.episode !== null
        ? `S${item.season} \u00b7 E${item.episode}` : 'Series';
    const subtitle = item.type === 'tv'
        ? [episodeLabel, item.episodeTitle].filter(Boolean).join(' \u00b7 ')
        : item.year || 'Movie';
    const description = card.querySelector('.home-watch-description');
    description.textContent = subtitle;
    description.title = subtitle;
    const progress = card.querySelector('.home-watch-progress');
    progress.value = item.progress;
    progress.setAttribute('aria-label', `${item.title}: ${Math.round(item.progress)}% watched`);
    card.querySelector('.home-watch-status').textContent = item.completed ? 'Watched'
        : item.durationSeconds > 0 ? `${item.remainingMinutes} min left` : 'In progress';
    const button = card.querySelector('.home-watch-play');
    const episode = item.type === 'tv' && item.season !== null && item.episode !== null
        ? `, season ${item.season}, episode ${item.episode}` : '';
    button.setAttribute('aria-label', `Resume ${item.title}${episode}`);
    button.addEventListener('click', async () => {
        if (isDragging || button.disabled || !onPlay) return;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        try {
            await onPlay(item);
        } finally {
            button.disabled = false;
            button.setAttribute('aria-busy', 'false');
        }
    });
    const hideButton = card.querySelector('.home-watch-hide');
    hideButton.setAttribute('aria-label', `Hide ${item.title} from Recently watched`);
    hideButton.classList.toggle('hidden', !onHide);
    hideButton.addEventListener('click', event => {
        event.stopPropagation();
        if (!isDragging) onHide?.(item);
    });
    return card;
}

export function renderWatchProgress(root, items, onPlay, { onHide, onRestore, hiddenCount = 0 } = {}) {
    root.hidden = false;
    const row = root.querySelector('#home-watch-row');
    const status = root.querySelector('.home-watch-message');
    status.textContent = hiddenCount > 0
        ? 'Your recently watched titles are hidden. Select Show hidden to bring them back.'
        : 'Start watching to track your movies and series.';
    status.classList.toggle('hidden', items.length > 0);
    root.querySelector('.home-watch-header').classList.remove('hidden');
    const restoreButton = root.querySelector('.home-watch-restore');
    restoreButton.classList.toggle('hidden', hiddenCount === 0);
    restoreButton.onclick = onRestore || null;
    row.classList.toggle('hidden', items.length === 0);
    row.replaceChildren(...items.map(item => createWatchProgressCard(item, onPlay, onHide)));
}

export function renderWatchProgressMessage(root, message) {
    root.hidden = false;
    root.querySelector('.home-watch-header').classList.remove('hidden');
    root.querySelector('.home-watch-restore').classList.add('hidden');
    const row = root.querySelector('#home-watch-row');
    row.classList.add('hidden');
    row.replaceChildren();
    const status = root.querySelector('.home-watch-message');
    status.textContent = message;
    status.classList.remove('hidden');
}
