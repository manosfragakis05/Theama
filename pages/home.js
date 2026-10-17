import { fetchTMDBEndpoint } from '../user-addons/catalogs.js';
import { openMasterDetail } from '../api.js';

let loadPromise = null;
let loadedAt = 0;
const CACHE_MS = 60 * 60 * 1000;

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function imageUrl(path, size) {
    return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

function renderMessage(root, message, retry = false) {
    const container = element('div', 'home-hero-message');
    container.setAttribute('role', 'status');
    container.append(
        element('span', 'home-hero-eyebrow', 'Trending this week'),
        element('p', '', message)
    );
    if (retry) {
        const button = element('button', 'home-hero-details', 'Try again');
        button.type = 'button';
        button.addEventListener('click', loadHome);
        container.append(button);
    }
    root.replaceChildren(container);
}

function createSlide(item, index, count) {
    const title = item.title || item.name || 'Untitled';
    const year = (item.release_date || item.first_air_date || '').slice(0, 4);
    const rating = Number(item.vote_average);
    const backdrop = imageUrl(item.backdrop_path, 'w1280');
    const poster = imageUrl(item.poster_path, 'w500');
    const slide = element('article', 'home-hero-slide');
    slide.setAttribute('role', 'group');
    slide.setAttribute('aria-roledescription', 'slide');
    slide.setAttribute('aria-label', `${index + 1} of ${count}: ${title}`);

    if (backdrop || poster) {
        const artwork = element('picture', 'home-hero-artwork');
        if (poster) {
            const source = element('source');
            source.media = '(max-width: 767px)';
            source.srcset = `${poster} 500w, ${imageUrl(item.poster_path, 'w780')} 780w`;
            source.sizes = '100vw';
            artwork.append(source);
        }
        const image = element('img', 'home-hero-image');
        image.alt = '';
        image.draggable = false;
        image.loading = index === 0 ? 'eager' : 'lazy';
        image.decoding = 'async';
        image.fetchPriority = index === 0 ? 'high' : 'low';
        if (backdrop) {
            image.srcset = `${imageUrl(item.backdrop_path, 'w780')} 780w, ${backdrop} 1280w`;
            image.sizes = '100vw';
        }
        image.src = backdrop || poster;
        let fallbackAttempted = false;
        image.addEventListener('error', () => {
            if (!fallbackAttempted && poster) {
                fallbackAttempted = true;
                artwork.querySelectorAll('source').forEach(source => source.remove());
                image.removeAttribute('srcset');
                image.src = poster;
                return;
            }
            artwork.remove();
        });
        artwork.append(image);
        slide.append(artwork);
    }

    const content = element('div', 'home-hero-content');
    const meta = element('div', 'home-hero-meta');
    meta.append(element('span', 'home-hero-type', item.media_type === 'tv' ? 'Series' : 'Movie'));
    if (year) meta.append(element('span', '', year));
    if (Number.isFinite(rating) && rating > 0) {
        const score = element('span', 'home-hero-rating', `\u2605 ${rating.toFixed(1)}`);
        score.setAttribute('aria-label', `Rated ${rating.toFixed(1)} out of 10`);
        meta.append(score);
    }

    const button = element('button', 'home-hero-details', 'View details');
    button.type = 'button';
    button.setAttribute('aria-label', `View details for ${title}`);
    button.addEventListener('click', () => openMasterDetail({
        id: item.id,
        title,
        type: item.media_type,
        year,
        overview: item.overview || '',
        rating: Number.isFinite(rating) && rating > 0 ? rating.toFixed(1) : '',
        poster,
        backdrop: backdrop || poster,
        addonName: 'customTMDB'
    }));

    content.append(
        element('span', 'home-hero-eyebrow', 'Trending this week'),
        meta,
        element('h1', 'home-hero-title', title)
    );
    if (item.overview) content.append(element('p', 'home-hero-overview', item.overview));
    content.append(button);
    slide.append(content);
    return slide;
}

function renderCarousel(root, items) {
    let activeIndex = 0;
    let pointerStart = null;
    const viewport = element('div', 'home-hero-viewport');
    viewport.id = 'home-hero-viewport';
    viewport.tabIndex = 0;
    viewport.setAttribute('aria-label', 'Trending titles. Use left and right arrow keys to change slides.');
    const track = element('div', 'home-hero-track');
    const controls = element('div', 'home-hero-controls');
    const dots = element('div', 'home-hero-dots');
    dots.setAttribute('role', 'group');
    dots.setAttribute('aria-label', 'Choose a featured title');
    const arrows = element('div', 'home-hero-arrows');
    const slides = items.map((item, index) => createSlide(item, index, items.length));
    const dotButtons = items.map((item, index) => {
        const button = element('button', 'home-hero-dot');
        button.type = 'button';
        button.setAttribute('aria-label', `Show ${index + 1}: ${item.title || item.name || 'Untitled'}`);
        button.setAttribute('aria-controls', viewport.id);
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

    for (const [direction, label, path] of [
        [-1, 'Previous title', 'M15 18l-6-6 6-6'],
        [1, 'Next title', 'M9 6l6 6-6 6']
    ]) {
        const button = element('button', 'home-hero-arrow');
        button.type = 'button';
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-controls', viewport.id);
        // Only static icon markup is inserted as HTML; title data uses textContent.
        button.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="${path}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
        button.addEventListener('click', () => selectSlide(activeIndex + direction));
        arrows.append(button);
    }

    root.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        // Keep focus in a visible slide when its details button initiated navigation.
        if (event.target.closest('.home-hero-slide')) viewport.focus({ preventScroll: true });
        selectSlide(activeIndex + (event.key === 'ArrowRight' ? 1 : -1));
    }, { signal: carouselListeners.signal });
    viewport.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0 || event.target.closest('button')) return;
        pointerStart = { x: event.clientX, y: event.clientY };
        viewport.setPointerCapture(event.pointerId);
    });
    viewport.addEventListener('pointerup', event => {
        if (!pointerStart) return;
        const dx = event.clientX - pointerStart.x;
        const dy = event.clientY - pointerStart.y;
        pointerStart = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            selectSlide(activeIndex + (dx < 0 ? 1 : -1));
        }
    });
    viewport.addEventListener('pointercancel', () => { pointerStart = null; });

    track.append(...slides);
    viewport.append(track);
    dots.append(...dotButtons);
    controls.append(dots, arrows);
    controls.hidden = items.length < 2;
    root.replaceChildren(viewport, controls);
    selectSlide(0);
}

let carouselListeners = new AbortController();

export async function loadHome() {
    const root = document.getElementById('home-hero');
    if (!root || Date.now() - loadedAt < CACHE_MS) return;
    if (loadPromise) return loadPromise;

    carouselListeners.abort();
    carouselListeners = new AbortController();
    root.setAttribute('aria-busy', 'true');
    renderMessage(root, "Loading this week's picks...");
    loadPromise = (async () => {
        try {
            const data = await fetchTMDBEndpoint('trending/all/week');
            // Keep the first eight results in API order; people cannot open in the media detail view.
            const items = (data.results || []).slice(0, 8).filter(item =>
                item.id != null && (item.media_type === 'movie' || item.media_type === 'tv')
            );
            if (!items.length) {
                renderMessage(root, 'No trending titles are available right now.', true);
                return;
            }
            renderCarousel(root, items);
            loadedAt = Date.now();
        } catch (error) {
            console.error('Home trending feed failed:', error);
            renderMessage(root, "Couldn't load this week's picks. Please try again.", true);
        } finally {
            root.setAttribute('aria-busy', 'false');
            loadPromise = null;
        }
    })();
    return loadPromise;
}
