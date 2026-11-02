import { fetchAniListStats, fetchPublicAniListStats, clearAniListStatsCache, formatAniListTime } from './anilist-stats-data.js';

const categories = [
    { key: 'mostRewatched', label: 'Most rewatched', theme: 'rewatched', unit: 'rewatches', empty: 'No rewatches recorded yet.', hint: 'Ranked by completed rewatches on AniList.' },
    { key: 'mostWatched', label: 'Most watched', theme: 'watched', unit: 'episodes', empty: 'No episodes logged yet.', hint: 'Ranked by episode progress on AniList.' },
    { key: 'highestRated', label: 'Highest rated', theme: 'rated', unit: '/ 100', empty: 'No ratings recorded yet.', hint: 'Personal ratings, converted to a 100-point scale.' }
];
const number = value => Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—';
let generation = 0;
let controller = null;
let owner = null;
let loadedAt = 0;

function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function poster(item, className) {
    const picture = element('div', className);
    if (item.poster) {
        const image = document.createElement('img');
        image.src = item.poster;
        image.alt = '';
        image.loading = 'lazy';
        image.addEventListener('error', () => image.remove(), { once: true });
        picture.append(image);
    }
    return picture;
}

function highlight(item, category, onOpen) {
    const card = element('button', 'ani-highlight-winner');
    card.type = 'button';
    const metric = `${number(item.value)} ${category.unit}`;
    card.setAttribute('aria-label', `${category.label}: ${item.title}, ${metric}. Open details`);
    card.title = item.title;
    card.append(poster(item, 'ani-highlight-poster'));
    const copy = element('span', 'ani-highlight-copy');
    const value = element('span', 'ani-highlight-value', number(item.value));
    value.append(element('span', 'ani-highlight-unit', category.unit));
    copy.append(value);
    copy.append(element('span', 'ani-highlight-name', item.title));
    copy.append(element('span', 'ani-highlight-format', [item.format?.replaceAll('_', ' '), item.year].filter(Boolean).join(' · ')));
    card.append(copy);
    card.addEventListener('click', () => onOpen(item, card));
    return card;
}

function status(message, retry = false) {
    const text = document.getElementById('profile-anilist-stats-status');
    text.textContent = message;
    text.hidden = !message;
    document.getElementById('profile-anilist-stats-retry').hidden = !retry;
}

function totals(data = {}) {
    document.getElementById('anilist-total-anime').textContent = number(data.anime);
    document.getElementById('anilist-total-episodes').textContent = number(data.episodes);
    document.getElementById('anilist-total-time').textContent = formatAniListTime(data.minutes);
    document.getElementById('anilist-total-hours').textContent = Number.isFinite(data.minutes)
        ? `${number(Math.round(data.minutes / 60 * 10) / 10)} hours of anime` : 'Time spent watching';
}

function heading(username) {
    document.getElementById('anilist-stats-heading').textContent = `${username || 'AniList'} Stats`;
}

export function resetAniListStats() {
    ++generation;
    controller?.abort(); controller = null;
    owner = null; loadedAt = 0;
    clearAniListStatsCache();
    const root = document.getElementById('profile-anilist-stats');
    if (!root) return;
    root.hidden = true;
    root.setAttribute('aria-busy', 'false');
    root.classList.remove('is-loading');
    document.getElementById('profile-anilist-highlights').replaceChildren();
    document.getElementById('profile-anilist-stats-retry').onclick = null;
    heading();
    totals();
    status('');
}

export async function loadAniListStats({ connection = null, userId, force = false, onOpen, isCurrent = () => true }) {
    const root = document.getElementById('profile-anilist-stats');
    if (!root || !isCurrent()) return;
    const key = connection ? `personal:${userId}:${connection.accessToken}` : `public:${userId}`;
    if (!force && owner === key && (controller || connection && Date.now() - loadedAt < 5 * 60 * 1000)) return;
    const current = ++generation;
    controller?.abort();
    const request = new AbortController();
    controller = request; owner = key;
    root.hidden = false;
    root.classList.add('is-loading');
    root.setAttribute('aria-busy', 'true');
    heading(connection?.viewer?.name);
    totals();
    const highlights = document.getElementById('profile-anilist-highlights');
    highlights.replaceChildren(...categories.map(() => {
        const placeholder = element('div', 'ani-highlight-skeleton');
        placeholder.setAttribute('aria-hidden', 'true');
        return placeholder;
    }));
    status('Loading anime stats…');
    document.getElementById('profile-anilist-stats-retry').onclick = () => loadAniListStats({ connection, userId, force: true, onOpen, isCurrent });
    try {
        const options = { force, signal: request.signal };
        const data = connection ? await fetchAniListStats(connection, options) : await fetchPublicAniListStats(userId, options);
        if (current !== generation || request.signal.aborted || !isCurrent()) return;
        heading(data.username || connection?.viewer?.name);
        totals(data.totals);
        highlights.replaceChildren(...categories.map(category => {
            const panel = element('article', `ani-highlight ani-highlight--${category.theme}`);
            const heading = element('h4', 'ani-highlight-heading', category.label);
            heading.title = category.hint;
            panel.append(heading);
            const items = data[category.key];
            if (items.length) panel.append(highlight(items[0], category, onOpen));
            else panel.append(element('p', 'ani-highlight-empty', category.empty));
            return panel;
        }));
        loadedAt = Date.now();
        status(Object.values(data.totals).every(value => value === null) ? 'AniList has not provided totals for this account yet.' : '');
    } catch (error) {
        if (current !== generation || request.signal.aborted || !isCurrent()) return;
        highlights.replaceChildren();
        status(error.message || 'Could not load anime stats. Please try again.', true);
    } finally {
        if (current === generation) {
            controller = null;
            root.classList.remove('is-loading');
            root.setAttribute('aria-busy', 'false');
        }
    }
}
