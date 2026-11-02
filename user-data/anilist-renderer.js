import { openMasterDetail } from '../api.js';
import { showToast } from '../services/config.js';
import { readAniListSession } from '../services/anilist-auth.js';
import { isDragging } from '../user-addons/row-drag.js';
import { switchTab } from '../utils/ui.js';
import { fetchAniListWatchlists, fetchPublicAniListWatchlists, fetchAniListDetail, mergeAniListGroups, clearAniListWatchlistCache } from './anilist-data.js';
import { loadAniListStats, resetAniListStats } from './anilist-stats-renderer.js';

let personal = false;
let publicAccount = null;
let publicView = false;
let publicMessage = '';
let initialized = false;
let generation = 0;
let controller = null;
let detailController = null;
let owner = null;
let groups = [];
let chunk = 0;
let hasMore = false;
let loadedAt = 0;

function root() { return document.getElementById('profile-anilist-section'); }
function isVisible() {
    return (personal || publicView) && !document.getElementById('profile-page')?.classList.contains('hidden')
        && !document.getElementById('profile-anilist-panel')?.hidden;
}
function connectionIsCurrent(connection, accountId) {
    return connection ? personal && readAniListSession()?.accessToken === connection.accessToken
        : !personal && publicAccount?.id === accountId;
}

function message(text, retry = false) {
    const status = document.getElementById('profile-anilist-status');
    status.textContent = text;
    status.classList.toggle('hidden', !text);
    document.getElementById('profile-anilist-retry').classList.toggle('hidden', !retry);
}

function renderGroups() {
    const container = document.getElementById('profile-anilist-lists');
    const positions = [...container.children].map(row => row.querySelector('.wl-row-track')?.scrollLeft || 0);
    container.replaceChildren();
    groups.filter(group => group.items.length).forEach((group, index) => {
        const row = document.getElementById('watchlist-row-template').content.cloneNode(true);
        row.querySelector('.wl-row-name').textContent = group.name;
        const count = document.createElement('span');
        count.className = 'profile-count';
        count.textContent = group.items.length;
        row.querySelector('h3').append(count);
        row.querySelector('.wl-row-edit-btn').remove();
        row.querySelector('.wl-row-empty').remove();
        const track = row.querySelector('.wl-row-track');
        track.tabIndex = 0;
        track.setAttribute('aria-label', `AniList ${group.name}`);
        for (const media of group.items) {
            const fragment = document.getElementById('poster-card-template').content.cloneNode(true);
            const card = fragment.querySelector('.poster-card');
            card.dataset.anilistId = media.anilistId;
            card.setAttribute('role', 'button');
            card.tabIndex = 0;
            card.setAttribute('aria-label', `Open ${media.title}`);
            card.querySelector('.remove-btn').remove();
            card.querySelector('.poster-title').textContent = media.title;
            const image = card.querySelector('.poster-img');
            image.alt = media.title;
            if (media.poster) image.src = media.poster;
            else image.hidden = true;
            image.addEventListener('error', () => { image.hidden = true; }, { once: true });
            if (media.year) {
                const year = card.querySelector('.poster-year');
                year.textContent = media.year;
                year.classList.remove('hidden');
            }
            card.addEventListener('click', event => {
                event.stopPropagation();
                if (!isDragging) openAnime(media, card);
            });
            card.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    card.click();
                }
            });
            track.append(fragment);
        }
        container.append(row);
        track.scrollLeft = positions[index] || 0;
    });
    document.getElementById('profile-anilist-more').classList.toggle('hidden', !hasMore);
}

async function openAnime(media, card) {
    detailController?.abort();
    const request = new AbortController();
    detailController = request;
    card.setAttribute('aria-busy', 'true');
    try {
        const detail = await fetchAniListDetail(media, { signal: request.signal });
        if (!request.signal.aborted && isVisible()) await openMasterDetail(detail);
    } catch (error) {
        if (!request.signal.aborted) showToast(error.message, 'error');
    } finally {
        card.removeAttribute('aria-busy');
    }
}

export function setAniListProfileVisibility(visible, account = null, publicState = {}) {
    const nextPublicView = !visible && (Boolean(account) || publicState.show === true);
    const changed = personal !== visible || publicAccount?.id !== account?.id || publicView !== nextPublicView;
    personal = visible;
    publicAccount = visible ? null : account || null;
    publicView = nextPublicView;
    publicMessage = publicState.message || 'This user has not linked an AniList account to their Theama profile.';
    if (!root()) return;
    root().classList.toggle('hidden', !personal && !publicView);
    if (changed || (!personal && !publicView)) {
        ++generation;
        controller?.abort();
        detailController?.abort();
        groups = []; owner = null; chunk = 0; hasMore = false; loadedAt = 0;
        clearAniListWatchlistCache();
        resetAniListStats();
        document.getElementById('profile-anilist-lists').replaceChildren();
        message('');
        root().setAttribute('aria-busy', 'false');
    }
    if (isVisible()) loadAniListWatchlists();
}

export async function loadAniListWatchlists({ force = false, more = false } = {}) {
    if (!root() || !isVisible()) return;
    initialize();
    const current = ++generation;
    controller?.abort();
    const request = new AbortController();
    controller = request;
    root().setAttribute('aria-busy', 'false');
    let connection;
    if (personal) {
        try { connection = readAniListSession(); } catch { /* Render the disconnected state. */ }
    }
    const accountId = publicAccount?.id;
    const account = personal ? connection?.viewer : publicAccount;
    document.getElementById('profile-anilist-heading').textContent = personal ? 'Your anime collection' : 'Public anime collection';
    document.getElementById('profile-anilist-account-description').textContent = personal
        ? connection ? `Anime lists from ${connection.viewer.name}. Your view includes private entries. Visitors only see public data.`
            : 'Your AniList lists, together in your profile.'
        : account ? 'Public anime lists from this user\'s linked AniList account.' : 'Public anime lists shared through AniList.';
    document.getElementById('profile-anilist-connect').classList.toggle('hidden', !personal || Boolean(connection));
    document.getElementById('profile-anilist-refresh').classList.toggle('hidden', !account);
    if (!account) {
        resetAniListStats();
        groups = []; owner = null; chunk = 0; hasMore = false;
        clearAniListWatchlistCache();
        renderGroups();
        message(personal ? '' : publicMessage);
        return;
    }
    if (!more) loadAniListStats({ connection, userId: account.id, force, onOpen: openAnime,
        isCurrent: () => connectionIsCurrent(connection, accountId) });
    const nextOwner = personal ? `personal:${connection.accessToken}` : `public:${account.id}`;
    if (owner !== nextOwner || force || (!more && (!personal || Date.now() - loadedAt > 5 * 60 * 1000))) {
        groups = []; chunk = 0; hasMore = false;
        owner = nextOwner;
        if (force) clearAniListWatchlistCache();
    }
    const nextChunk = more && hasMore ? chunk + 1 : chunk || 1;
    renderGroups();
    root().setAttribute('aria-busy', 'true');
    message(groups.length ? 'Refreshing AniList lists...' : 'Loading AniList lists...');
    for (const id of ['profile-anilist-refresh', 'profile-anilist-more', 'profile-anilist-retry']) document.getElementById(id).disabled = true;
    try {
        const options = { chunk: nextChunk, force, signal: request.signal };
        const data = personal ? await fetchAniListWatchlists(connection, options)
            : await fetchPublicAniListWatchlists(accountId, options);
        if (current !== generation || !connectionIsCurrent(connection, accountId)) return;
        if (data.unavailable) resetAniListStats();
        groups = data.unavailable ? [] : mergeAniListGroups(nextChunk === 1 ? [] : groups, data.groups);
        chunk = data.unavailable ? 0 : nextChunk; hasMore = !data.unavailable && data.hasMore;
        loadedAt = Date.now();
        renderGroups();
        message(data.unavailable ? 'This AniList list is private or unavailable.'
            : groups.some(group => group.items.length) ? '' : personal ? 'Your AniList anime lists are empty.' : 'No public anime to show.');
    } catch (error) {
        if (current !== generation || request.signal.aborted || !connectionIsCurrent(connection, accountId)) return;
        if (error.unavailable) resetAniListStats();
        if (!personal) {
            groups = []; chunk = 0; hasMore = false;
            renderGroups();
        }
        message(error.message, true);
    } finally {
        if (current === generation) {
            root().setAttribute('aria-busy', 'false');
            for (const id of ['profile-anilist-refresh', 'profile-anilist-more', 'profile-anilist-retry']) document.getElementById(id).disabled = false;
        }
    }
}

function initialize() {
    if (initialized) return;
    initialized = true;
    document.getElementById('profile-anilist-refresh').addEventListener('click', () => loadAniListWatchlists({ force: true }));
    document.getElementById('profile-anilist-retry').addEventListener('click', () => loadAniListWatchlists({ force: true }));
    document.getElementById('profile-anilist-more').addEventListener('click', () => loadAniListWatchlists({ more: true }));
    document.getElementById('profile-anilist-connect').addEventListener('click', () => {
        switchTab('settings-page');
        document.getElementById('anilist-settings')?.scrollIntoView({ block: 'center' });
    });
    window.addEventListener('anilist:connection-changed', () => {
        if (!personal) return;
        ++generation;
        controller?.abort(); detailController?.abort();
        clearAniListWatchlistCache();
        resetAniListStats();
        groups = []; owner = null; chunk = 0; hasMore = false;
        document.getElementById('profile-anilist-lists').replaceChildren();
        if (isVisible()) loadAniListWatchlists();
    });
}
