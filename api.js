import { smartFetch, showToast, MY_PROXY } from './script.js';
import { parseTorrentio } from './parseMedia.js';

export const TMDB_KEY = 'ee7a32cee36ed0cd1f028f10c32fa0cf';

const rowState = {
    'trending-row': { page: 1, endpoint: 'trending/all/week', loading: false, hasMore: true },
    'new-row': { page: 1, endpoint: 'movie/now_playing', loading: false, hasMore: true },
    'top-row': { page: 1, endpoint: 'movie/top_rated', loading: false, hasMore: true },
    'action-row': { page: 1, endpoint: 'discover/movie?with_genres=28&sort_by=vote_count.desc&vote_average.gte=7&vote_count.gte=3000', loading: false, hasMore: true },
    'comedy-row': { page: 1, endpoint: 'discover/movie?with_genres=35&sort_by=vote_count.desc&vote_average.gte=6.5&vote_count.gte=2000', loading: false, hasMore: true },
    'thriller-row': { page: 1, endpoint: 'discover/movie?with_genres=53&without_genres=27,28&sort_by=vote_count.desc&vote_average.gte=7.5&vote_count.gte=1500', loading: false, hasMore: true },
    'anime-row': { page: 1, endpoint: 'discover/tv?with_genres=16&with_original_language=ja&sort_by=vote_count.desc&vote_count.gte=500', loading: false, hasMore: true },

    // Empty default states for dynamic rows
    'global-search-grid': { page: 1, query: '', loading: false, hasMore: true },
    'my-picks-row': { loading: false }
};

// DRAG CONTROLLER
let isDragging = false;
let isDown = false;
let activeSlider = null;
let startX;
let scrollLeft;
let isTicking = false;

export function initGlobalDrag() {
    // 1. The Global Mouse Down (Delegated)
    document.addEventListener('mousedown', (e) => {
        // Look for our specific class instead of an ID
        const slider = e.target.closest('.draggable-row');
        if (!slider) return;

        isDown = true;
        isDragging = false; // from your global state
        activeSlider = slider;

        slider.classList.add('cursor-grabbing');
        document.body.classList.add('select-none');

        startX = e.pageX - slider.offsetLeft;
        scrollLeft = slider.scrollLeft;
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDown || !activeSlider) return;
        e.preventDefault();

        const x = e.pageX - activeSlider.offsetLeft;
        const walk = (x - startX) * 3;

        if (Math.abs(walk) > 5) {
            isDragging = true;
            if (window.getSelection) window.getSelection().removeAllRanges();

            activeSlider.classList.add('pointer-events-none');
            document.body.classList.add('cursor-grabbing');
        }

        if (!isTicking) {
            window.requestAnimationFrame(() => {
                activeSlider.scrollLeft = scrollLeft - walk;
                isTicking = false;
            });
            isTicking = true;
        }
    });

    window.addEventListener('mouseup', () => {
        if (!isDown || !activeSlider) return;

        isDown = false;

        activeSlider.classList.remove('cursor-grabbing', 'pointer-events-none');
        document.body.classList.remove('select-none', 'cursor-grabbing');

        setTimeout(() => {
            isDragging = false;
            activeSlider = null;
        }, 50);
    });
}

// 👀 --- MODERN SCROLL PAGINATION ---
const paginationObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        // If the sentinel is visible on screen...
        if (entry.isIntersecting) {
            const containerId = entry.target.dataset.targetRow;

            // Un-observe it so we don't trigger multiple times while loading
            paginationObserver.unobserve(entry.target);

            // Fetch the next page!
            renderRow(null, containerId);
        }
    });
}, {
    root: null,
    rootMargin: '0px 600px 0px 0px',
    threshold: 0
});


//#region TMDB LOGIC

// Fetch card data
async function fetchTMDBEndpoint(endpoint, page = 1) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `https://api.themoviedb.org/3/${endpoint}${separator}api_key=${TMDB_KEY}&language=en-US&page=${page}`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`TMDB Fetch Failed: ${response.status}`);
    return await response.json();
}

function createCardHTML(movie) {
    if (movie.media_type === 'person' || !movie.poster_path) return '';

    const detectedType = movie.media_type || (movie.name ? 'tv' : 'movie');
    const displayTitle = movie.title || movie.name;
    const displayDate = movie.release_date || movie.first_air_date || '';
    const year = displayDate.split('-')[0] || 'N/A';

    return `
        <div class="media-card relative flex-none w-32 md:w-40 cursor-pointer transition-transform hover:scale-105 select-none"
             data-id="${movie.id}"
             data-type="${detectedType}"
             data-title="${displayTitle}"
             data-backdrop="${movie.backdrop_path || ''}"
             data-poster="${movie.poster_path}">
             
            <img src="https://image.tmdb.org/t/p/w500${movie.poster_path}" 
                 class="rounded-lg shadow-lg w-full h-auto object-cover border border-slate-700/50 bg-slate-800 aspect-[2/3]"
                 loading="lazy" draggable="false" alt="${displayTitle}">
            <p class="text-xs text-slate-300 mt-2 truncate font-semibold pl-1">${displayTitle}</p>
            <p class="text-[10px] text-slate-500 pl-1">${year}</p>
        </div>
    `;
}

function renderCardsToRow(movies, containerId) {
    const row = document.getElementById(containerId);
    if (!row) return;

    const oldSentinel = row.querySelector('.scroll-sentinel');
    if (oldSentinel) oldSentinel.remove();

    const htmlContent = movies.map(createCardHTML).join('');
    row.insertAdjacentHTML('beforeend', htmlContent);

    if (rowState[containerId].hasMore) {
        row.insertAdjacentHTML('beforeend', `<div class="scroll-sentinel w-1 flex-none" data-target-row="${containerId}"></div>`);
        paginationObserver.observe(row.querySelector('.scroll-sentinel:last-child'));
    }
}

function setupRowClickListener(containerId) {
    const row = document.getElementById(containerId);
    if (!row || row.dataset.listenerAttached) return;

    row.addEventListener('click', (e) => {
        if (isDragging) { e.preventDefault(); return; }

        const card = e.target.closest('.media-card');
        if (!card) return;

        // Note: Assuming you import or have access to updateDetailView/openMasterDetail below
        openMasterDetail(
            card.dataset.id,
            card.dataset.title,
            card.dataset.type,
            card.dataset.poster,
            card.dataset.backdrop
        );
    });

    row.dataset.listenerAttached = 'true';
}

async function renderRow(initialEndpoint = null, containerId) {
    if (initialEndpoint) {
        showRowLoading(containerId);

        let startPage = 1;
        if (!['trending-row', 'new-row'].includes(containerId)) {
            startPage = Math.floor(Math.random() * 3) + 1;
        }

        rowState[containerId] = { endpoint: initialEndpoint, page: startPage, hasMore: true, loading: false };
    }

    const state = rowState[containerId];
    if (!state || state.loading || !state.hasMore) return;

    state.loading = true;
    if (!initialEndpoint) state.page += 1;

    try {
        let fetchUrl = state.endpoint;
        if (containerId === 'global-search-grid' && state.query) {
            fetchUrl = `search/multi?query=${encodeURIComponent(state.query)}`;
        }

        const data = await fetchTMDBEndpoint(fetchUrl, state.page);

        if (initialEndpoint) {
            const row = document.getElementById(containerId);
            if (row) row.innerHTML = '';
        }

        if (data.results.length === 0 || data.page >= data.total_pages) {
            state.hasMore = false;
        }

        renderCardsToRow(data.results, containerId);

    } catch (e) {
        console.error(`Error on ${containerId}:`, e);
        if (initialEndpoint) showRowError(containerId);
        state.hasMore = false;
    } finally {
        state.loading = false;
    }
}

// 🎨 --- UI RENDERERS ---
function showRowLoading(containerId) {
    const row = document.getElementById(containerId);
    if (row) row.innerHTML = '<p class="text-slate-400 pl-2 text-sm mt-4">Loading...</p>';
}

function showRowError(containerId) {
    const row = document.getElementById(containerId);
    if (row) row.innerHTML = '<p class="text-red-500 pl-2 text-sm mt-4">Failed to load.</p>';
}

function showRowEmpty(containerId, message = "No results found.") {
    const row = document.getElementById(containerId);
    if (row) row.innerHTML = `<p class="text-slate-500 pl-2 text-sm mt-4">${message}</p>`;
}

// 🚀 APP BOOTER (Massively simplified)
export async function loadDiscover() {
    initGlobalDrag();

    // 1. Automatically attach listeners to ALL rows in the state (including the empty search row!)
    Object.keys(rowState).forEach(containerId => {
        setupRowClickListener(containerId);
    });

    // 2. Automatically fetch data for standard rows using their predefined endpoints
    const standardRows = ['trending-row', 'new-row', 'top-row', 'action-row', 'comedy-row', 'thriller-row', 'anime-row'];
    standardRows.forEach(rowId => {
        renderRow(rowState[rowId].endpoint, rowId);
    });

    loadMyPicks();
}

// 🔍 SEARCH (Now clean and bug-free)
export async function searchTMDB(query) {
    const containerId = 'global-search-grid';
    const container = document.getElementById('global-search-results');
    const row = document.getElementById(containerId);

    if (!container || !row) return;

    container.classList.remove('hidden');
    showRowLoading(containerId);

    rowState[containerId].query = query;
    rowState[containerId].page = 1;
    rowState[containerId].hasMore = true;
    rowState[containerId].loading = true;

    try {
        const endpoint = `search/multi?query=${encodeURIComponent(query)}`;
        const data = await fetchTMDBEndpoint(endpoint, 1);

        row.innerHTML = '';

        if (data.results.length === 0) {
            showRowEmpty(containerId);
            rowState[containerId].hasMore = false;
            return;
        }

        renderCardsToRow(data.results, containerId);

        if (data.page >= data.total_pages) {
            rowState[containerId].hasMore = false;
        }
    } catch (e) {
        console.error("Search failed:", e);
        showRowError(containerId);
        rowState[containerId].hasMore = false;
    } finally {
        rowState[containerId].loading = false;
    }
}

// MY PICKS
export async function loadMyPicks() {
    const containerId = 'my-picks-row';

    showRowLoading(containerId);

    const myFavorites = [
        // THE GOATS
        { id: 1396, type: 'tv' },     // Breaking Bad
        { id: 1607, type: 'movie' },  // A Bronx Tale
        { id: 278, type: 'movie' },   // Shawshank Redemption
        { id: 389, type: 'movie' },   // 12 Angry Men

        // THE TRILOGIES
        { id: 11, type: 'movie' },    // Star Wars: A New Hope
        { id: 1891, type: 'movie' },  // Empire Strikes Back
        { id: 1892, type: 'movie' },  // Return of the Jedi
        { id: 1893, type: 'movie' },  // Phantom Menace (For Darth Maul)
        { id: 1894, type: 'movie' },  // Attack of the Clones
        { id: 1895, type: 'movie' },  // Revenge of the Sith

        // THE CAPED CRUSADERS
        { id: 155, type: 'movie' },   // The Dark Knight
        { id: 414906, type: 'movie' }, // The Batman (2022)
        { id: 299534, type: 'movie' }, // Avengers: Endgame

        // THE ANIME PEAK
        { id: 1429, type: 'tv' },     // Attack on Titan
        { id: 45790, type: 'tv' },    // Jojo's
        { id: 95479, type: 'tv' },    // Jujutsu Kaisen
        { id: 30984, type: 'tv' },    // Bleach
        { id: 127532, type: 'tv' }    // Solo Leveling
    ];

    try {
        const movieData = await Promise.all(myFavorites.map(async (item) => {
            const url = `https://api.themoviedb.org/3/${item.type}/${item.id}?api_key=${TMDB_KEY}&language=en-US`;
            const res = await fetch(url);
            const data = await res.json();
            return {
                ...data,
                title: data.title || data.name,
                release_date: data.release_date || data.first_air_date,
                media_type: item.type
            };
        }));

        const row = document.getElementById(containerId);
        if (row) row.innerHTML = '';

        renderCardsToRow(movieData, containerId);
    } catch (e) {
        console.error("Couldnt load row:", e);
        showRowError(containerId);
    }
}
//#endregion

//#region State and Data
// STATE MANAGEMENT
export const mediaStore = (() => {
    let state = {
        id: null,
        title: null,
        type: null,     // movie or tv
        poster: null,
        backdrop: null,
        overview: null,
        tagline: null,
        genre: null,
        cast: null,
        voteAverage: null,
        releaseYear: null,

        imdbId: null,
        anilistId: null,
        kitsuId: null,
        seasons: null,  // seasons metadata
        activeSeason: null,
        activeEpisode: null
    };

    return {
        // READ
        get: () => ({ ...state }),

        // WRITE (Bulk metadata updates)
        set: (newData) => {
            state = { ...state, ...newData };

        },

        clear: () => {
            state = {
                id: null, title: null, type: null, poster: null, backdrop: null,
                overview: null, tagline: null, genre: null, cast: null, voteAverage: null, releaseYear: null,
                imdbId: null, anilistId: null, kitsuId: null,
                seasons: null, activeSeason: null, activeEpisode: null
            };
        },

        // UTILITY
        exportForLibrary: () => {
            return {
                id: state.id,
                title: state.title,
                type: state.type,
                poster: state.poster,
                anilistId: state.anilistId,
                kitsuId: state.kitsuId
            };
        }
    };
})();


// Detect media type (Western or Anime)
async function openMasterDetail(tmdbId, TMDBTitle, type, posterImage, backdropImage) {
    mediaStore.clear();

    // Save the main data
    mediaStore.set({
        id: tmdbId,
        title: TMDBTitle,
        type: type,
        poster: posterImage,
        backdrop: backdropImage,
    });

    if (type === 'tv') {
        const animeSeasons = await fetchAnimeMapping(tmdbId);
        if (animeSeasons && animeSeasons.kitsuId) {
            mediaStore.set({
                anilistId: animeSeasons.anilistId,
                kitsuId: animeSeasons.kitsuId
            });
        }
    }

    // 4. Hand off to the detail fetcher for the heavy lifting
    return openTMDBDetail();
}

// Anime detector and mappings
export async function fetchAnimeMapping(tmdbId) {
    const workerBaseUrl = MY_PROXY.replace('/?url=', '');

    try {
        const mapUrl = `${workerBaseUrl}/map?tmdb_id=${tmdbId}`;
        const res = await fetch(mapUrl);

        if (res.ok) {
            const data = await res.json();
            if (data.kitsu_id || data.anilist_id) { // Look for any ID
                console.log(`Fribb Hit. ${data.kitsu_id}, ${data.anilist_id}`);
                return { kitsuId: data.kitsu_id, anilistId: data.anilist_id };
            }
        } else if (res.status !== 404) {
            // Log the actual server error if it's not just a standard "Not Found"
            const errText = await res.text();
            console.warn("Fribb Worker Error:", res.status, errText);
        }
    } catch (e) {
        console.warn("Fribb Network failed.", e);
    }

    console.log("No IDS found in fribb, likely not an anime");
    return null;
}

// FULL TMDB DATA WITH THE FIRST TMDB SEASON IF "TV"
async function openTMDBDetail() {
    const state = mediaStore.get();

    try {
        const url = `https://api.themoviedb.org/3/${state.type}/${state.id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits,external_ids`;
        const res = await fetch(url);

        if (!res.ok) throw new Error("TMDB item fetch failed");
        const detailedData = await res.json();

        const primaryGenre = detailedData.genres?.[0]?.name || 'N/A';
        const year = (detailedData.first_air_date || detailedData.release_date || '').split('-')[0] || 'N/A';
        const rating = detailedData.vote_average ? detailedData.vote_average.toFixed(1) : 'N/A';

        const topCast = (detailedData.credits?.cast || []).slice(0, 6).map(a => a.name).join(', ');
        const topCrew = (detailedData.credits?.crew || []).slice(0, 3).map(m => m.name).join(', ');
        const finalCreditsString = topCast ? `Cast: ${topCast}` : (topCrew ? `Credits: ${topCrew}` : '');

        const fetchedImdbId = state.type === 'movie'
            ? detailedData.imdb_id
            : detailedData.external_ids?.imdb_id;

        mediaStore.set({
            overview: detailedData.overview || '',
            tagline: detailedData.tagline || '',
            genre: primaryGenre,
            cast: finalCreditsString,
            voteAverage: rating,
            releaseYear: year,
            imdbId: fetchedImdbId
        });
        renderMasterDetailView();

        // Seasons only
        let seasons = [];
        let activeSeason = null;
        let activeEpisode = null;

        if (state.type === 'tv' && detailedData.seasons?.length > 0) {
            const seasonLoader = document.getElementById('season-loading-indicator');

            if (state.kitsuId) {
                if (seasonLoader) {
                    seasonLoader.classList.remove('hidden');
                    seasonLoader.classList.add('flex');
                }

                seasons = await buildKitsuSeasons(state.kitsuId);
                activeSeason = await loadKitsuSeason(state.kitsuId);

                if (seasonLoader) {
                    seasonLoader.classList.add('hidden');
                    seasonLoader.classList.remove('flex');
                }

            } else {
                seasons = detailedData.seasons.filter(season => season.season_number > 0);
                activeSeason = await loadTMDBSeason(seasons[0].season_number);
            }

            activeEpisode = activeSeason.episodes[0]?.episodeNumber || 1;

            mediaStore.set({ seasons, activeSeason, activeEpisode });

            renderSeason(activeSeason, seasons);
        }

    } catch (e) {
        console.error("Detail View Error:", e);
    }
}

// TMDB Seasons
export async function loadTMDBSeason(seasonNumber) {
    const state = mediaStore.get();

    try {
        // 1. Fetch the raw episode data
        const url = `https://api.themoviedb.org/3/tv/${state.id}/season/${seasonNumber}?api_key=${TMDB_KEY}`;
        const res = await fetch(url);

        if (!res.ok) throw new Error("TMDB season fetch failed");
        const seasonData = await res.json();

        const rawEpisodes = seasonData.episodes || [];
        const fallbackBackdrop = state.backdrop ? `https://image.tmdb.org/t/p/w500${state.backdrop}` : null;

        const formattedEpisodes = rawEpisodes.map(ep => {
            let thumbUrl = fallbackBackdrop;
            if (ep.still_path) {
                thumbUrl = `https://image.tmdb.org/t/p/w500${ep.still_path}`;
            }

            return {
                episodeNumber: ep.episode_number,
                title: ep.name,
                duration: ep.runtime,
                thumbnail: thumbUrl
            };
        });

        const activeSeason = {
            season_number: seasonNumber,
            seasonName: seasonData.name,
            episodes: formattedEpisodes
        };

        mediaStore.set({ activeSeason: activeSeason });

        return activeSeason;

    } catch (e) {
        console.error("Failed to load standard TMDB episodes:", e);
        showToast("Failed to load episodes.", "error");
    }
}

// Fetch kitsu seasons
export async function buildKitsuSeasons(baseKitsuId) {
    let currentId = baseKitsuId;
    const visited = new Set();
    const timeline = [];
    let fakeSeasonCounter = 1;

    try {
        while (currentId && !visited.has(currentId)) {
            visited.add(currentId);

            const url = `https://kitsu.io/api/edge/anime/${currentId}?include=mediaRelationships.destination`;
            const res = await fetch(url);

            if (!res.ok) break;

            const json = await res.json();
            const animeData = json.data;
            const included = json.included || [];

            timeline.push({
                season_number: fakeSeasonCounter,
                name: animeData.attributes.titles.en || animeData.attributes.canonicalTitle || `Season ${fakeSeasonCounter}`,
                kitsuId: animeData.id
            });

            // 3. THE NEXT LINK: Find the sequel
            const relationships = included.filter(item => item.type === 'mediaRelationships');
            const sequelRel = relationships.find(rel => rel.attributes.role === 'sequel');

            if (sequelRel) {
                currentId = sequelRel.relationships?.destination?.data?.id;
                fakeSeasonCounter++;
            } else {
                currentId = null; // End of the line
            }

            // Breathe to avoid hitting API rate limits
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        mediaStore.set({ seasons: timeline });
        return timeline;

    } catch (error) {
        console.error(`[KITSU] Timeline spider crashed:`, error);
    }
}

// Fetch kitsu episodes with Anizip
export async function loadKitsuSeason(kitsuId) {
    try {
        const state = mediaStore.get();
        const fallbackBackdrop = state.backdrop ? `https://image.tmdb.org/t/p/w500${state.backdrop}` : null;

        // 1. Fetch data (Hybrid setup)
        const kitsuInitialUrl = `https://kitsu.io/api/edge/anime/${kitsuId}/episodes?page[limit]=20`;
        const anizipUrl = `https://api.ani.zip/mappings?kitsu_id=${kitsuId}`;

        const [kitsuRes, aniRes] = await Promise.all([
            fetch(kitsuInitialUrl),
            fetch(anizipUrl).catch(() => null)
        ]);

        if (!kitsuRes.ok) throw new Error(`Kitsu episode fetch failed`);

        let anizipData = {};
        if (aniRes && aniRes.ok) {
            const aniJson = await aniRes.json();
            anizipData = aniJson.episodes || {};
        }

        const formattedEpisodes = [];
        let currentKitsuData = await kitsuRes.json();
        let nextUrl = null;

        while (currentKitsuData) {
            const kitsuEpisodes = currentKitsuData.data || [];

            kitsuEpisodes.forEach(ep => {
                const attrs = ep.attributes;
                const epNum = attrs.number;
                const zipEp = anizipData[epNum] || {};
                let thumbUrl = zipEp.image || attrs.thumbnail?.original || fallbackBackdrop;

                formattedEpisodes.push({
                    episodeNumber: epNum,
                    title: attrs.canonicalTitle || attrs.titles?.en_jp || zipEp.title?.en || `Episode ${epNum}`,
                    overview: attrs.synopsis || zipEp.summary || "No overview available.",
                    duration: attrs.length || zipEp.runtime || 24,
                    thumbnail: thumbUrl,
                    tmdbSeason: zipEp.seasonNumber,
                    tmdbEpisode: zipEp.episodeNumber
                });
            });

            nextUrl = currentKitsuData.links?.next || null;
            if (nextUrl) {
                const nextRes = await fetch(nextUrl);
                currentKitsuData = nextRes.ok ? await nextRes.json() : null;
            } else {
                currentKitsuData = null;
            }
        }

        formattedEpisodes.sort((a, b) => a.episodeNumber - b.episodeNumber);

        const seasonMeta = state.seasons.find(s => s.kitsuId == kitsuId) || { season_number: 1, name: "Season 1" };

        const activeSeason = {
            season_number: seasonMeta.season_number,
            seasonName: seasonMeta.name,
            episodes: formattedEpisodes
        };

        mediaStore.set({ activeSeason: activeSeason, kitsuId });
        return activeSeason;

    } catch (error) {
        console.error(`[EPISODES] Failed to build hybrid Kitsu/AniZIP season:`, error);
        return null;
    }
}

// Play button setup
export async function handlePlayAction() {
    const state = mediaStore.get();

    let type = '';
    let id = '';
    let reqSeason = null;
    let reqEpisode = null;

    if (state.kitsuId) {
        type = 'anime';
        id = state.kitsuId;
        reqEpisode = state.activeEpisode;
    } else if (state.type === 'movie') {
        type = 'movie';
        id = state.imdbId;
    } else if (state.type === 'tv') {
        type = 'series';
        id = state.imdbId;
        reqSeason = state.activeSeason.season_number;
        reqEpisode = state.activeEpisode;
    }

    if (!id) {
        console.error("Missing ID! Cannot scrape.");
        return;
    }

    const playBtn = document.getElementById('btn-torrent');
    const originalContent = playBtn.innerHTML;

    playBtn.disabled = true;
    playBtn.innerHTML = `
        <svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        Loading...
    `;

    try {
        // Fetch the streams
        const streamData = await fetchTorrentioStreams(type, id, reqSeason, reqEpisode);
        console.log(streamData);

        if (streamData && streamData.uniqueStreams) {
            const categorizedStreams = filterAndSortStreams(streamData.uniqueStreams, "western");
            console.log(categorizedStreams);

            const mainTitle = state.title;
            showStreamPicker(categorizedStreams, mainTitle);
        } else {
            showToast("No streams found.", "error");
        }
    } catch (e) {
        console.error("Failed to load streams:", e);
        showToast("Error fetching streams.", "error");
    } finally {
        playBtn.innerHTML = originalContent;
        playBtn.disabled = false;
    }
}

//#region Render Details
export function renderMasterDetailView() {
    const viewContainer = document.getElementById('full-detail-view');
    if (!viewContainer) return;

    const data = mediaStore.get();

    const ui = {
        backdrop: document.getElementById('detail-backdrop'),
        poster: document.getElementById('detail-poster'),
        posterSkeleton: document.getElementById('poster-skeleton'),
        title: document.getElementById('media-title'),
        genre: document.getElementById('detail-genre'),
        runtime: document.getElementById('detail-runtime'),
        rating: document.getElementById('detail-rating'),
        tagline: document.getElementById('detail-tagline'),
        overview: document.getElementById('detail-overview'),
        cast: document.getElementById('detail-cast'),
    };

    // Fill Macro Data
    ui.title.textContent = data.title;
    ui.runtime.textContent = data.releaseYear;
    ui.rating.textContent = data.voteAverage;
    ui.genre.textContent = data.genre;
    ui.tagline.textContent = data.tagline;
    ui.overview.textContent = data.overview;
    ui.cast.textContent = data.cast;

    // Handle Images cleanly (Only update if the image has actually changed to prevent flickering)
    if (data.poster && !ui.poster.src.includes(data.poster)) {
        ui.posterSkeleton.style.display = 'block';
        ui.poster.src = `https://image.tmdb.org/t/p/w500${data.poster}`;
        ui.poster.onload = () => ui.posterSkeleton.style.display = 'none';
    } else if (!data.poster) {
        ui.poster.src = "";
        ui.posterSkeleton.style.display = 'block';
    }

    if (data.backdrop && !ui.backdrop.style.backgroundImage.includes(data.backdrop)) {
        const bgUrl = `https://image.tmdb.org/t/p/original${data.backdrop}`;
        ui.backdrop.style.backgroundImage = `url('${bgUrl}')`;
    } else if (!data.backdrop) {
        ui.backdrop.style.backgroundImage = "none";
    }

    // Reveal modal
    viewContainer.classList.remove('translate-y-full');
    document.body.style.overflow = 'hidden';
}

function renderSeason(activeSeason, seasonsList) {
    const state = mediaStore.get();

    const container = document.getElementById('dynamic-seasons-container');
    if (!container || !seasonsList) return;

    // --- 1. CHECK IF THE UI SKELETON ALREADY EXISTS ---
    let listContainer = container.querySelector('.tmdb-episode-list');
    let seasonMenu = container.querySelector('.tmdb-season-menu');
    let seasonName = container.querySelector('.tmdb-season-text');

    // If it DOES NOT exist (first time loading the show), build it!
    if (!listContainer) {
        container.innerHTML = ''; // Clear out any junk from a previous show

        const template = document.getElementById('tv-controls-template');
        const clone = template.content.cloneNode(true);

        const seasonTrigger = clone.querySelector('.tmdb-season-trigger');
        seasonName = clone.querySelector('.tmdb-season-text');
        seasonMenu = clone.querySelector('.tmdb-season-menu');
        const chevron = clone.querySelector('.tmdb-season-chevron');
        listContainer = clone.querySelector('.tmdb-episode-list');

        seasonTrigger.onclick = () => {
            seasonMenu.classList.toggle('hidden');
            chevron.classList.toggle('rotate-180');
        };

        seasonMenu.onclick = (e) => {
            const btn = e.target.closest('.season-btn');
            if (!btn) return;

            const clickedSeason = btn.dataset.season;

            const currentState = mediaStore.get();
            const currentSeason = currentState.activeSeason;
            if (currentSeason && clickedSeason == currentSeason.season_number) return;

            seasonMenu.classList.add('hidden');

            const clickedSeasonObject = seasonsList.find(s => s.season_number == clickedSeason);
            if (!clickedSeasonObject) {
                console.error("Couldn't find season data for:", clickedSeason);
                return;
            }

            handleSeasonChangeClick(clickedSeasonObject);
        };

        // Append the skeleton to the page
        container.appendChild(clone);

        // Re-grab references now that they are physically in the DOM
        listContainer = container.querySelector('.tmdb-episode-list');
        seasonMenu = container.querySelector('.tmdb-season-menu');
        seasonName = container.querySelector('.tmdb-season-text');
    }

    // --- 2. UPDATE MENU DATA ---
    // (This runs every time, updating text and highlight states)
    seasonName.textContent = activeSeason.seasonName;

    seasonMenu.innerHTML = seasonsList.map(season => {
        const isActive = season.season_number == activeSeason.season_number;
        const activeClasses = isActive ? 'bg-blue-600/20 text-blue-400 border-blue-500' : 'text-white border-transparent';

        return `
            <button data-season="${season.season_number}"
                    class="season-btn w-full text-left px-3 py-2.5 hover:bg-slate-700/50 transition font-semibold text-base whitespace-nowrap border-b-2 border-slate-700/30 last:border-b-0 ${activeClasses}">
                ${season.name}
            </button>
        `;
    }).join('');

    // --- 3. PREPARE THE EPISODE LIST ---
    // Remove the loading classes we added in handleSeasonChangeClick
    listContainer.classList.remove('opacity-50', 'pointer-events-none', 'animate-pulse');

    listContainer.innerHTML = '';

    let episodes = activeSeason.episodes;
    let activeEpisodeNumber = state.activeEpisode;

    episodes.forEach(ep => {
        const epTemplate = document.getElementById('episode-card-template');
        const epClone = epTemplate.content.cloneNode(true);

        const card = epClone.querySelector('.episode-card');
        const title = epClone.querySelector('.ep-title');
        const thumb = epClone.querySelector('.ep-thumbnail');
        const durationBadge = epClone.querySelector('.ep-duration');
        const skeleton = epClone.querySelector('.ep-skeleton');

        title.textContent = `${ep.episodeNumber}. ${ep.title}`;

        if (ep.thumbnail) {
            thumb.src = ep.thumbnail;
            thumb.onload = () => {
                if (skeleton) skeleton.style.display = 'none';
            };
        } else {
            if (skeleton) skeleton.style.display = 'none';
        }

        epClone.querySelector('.ep-text-skeleton').style.display = 'none';

        if (ep.duration > 0) {
            durationBadge.textContent = `${ep.duration}m`;
            durationBadge.classList.remove('hidden');
        }


        if (ep.episodeNumber === activeEpisodeNumber) {
            card.classList.add('border-blue-500', 'bg-blue-500/10');
            card.classList.remove('border-slate-700/50', 'bg-slate-800/40');
        }

        // Local CSS Swap Click Handler (No DOM Reloads!)
        card.onclick = () => {
            const allCards = listContainer.querySelectorAll('.episode-card');
            allCards.forEach(c => {
                c.classList.remove('border-blue-500', 'bg-blue-500/10');
                c.classList.add('border-slate-700/50', 'bg-slate-800/40');
            });

            card.classList.add('border-blue-500', 'bg-blue-500/10');
            card.classList.remove('border-slate-700/50', 'bg-slate-800/40');

            mediaStore.set({ activeEpisode: ep.episodeNumber });
        };

        listContainer.appendChild(epClone);
    });
}

async function handleSeasonChangeClick(targetSeason) {
    const listContainer = document.querySelector('.tmdb-episode-list');
    if (listContainer) {
        listContainer.classList.add('opacity-50', 'pointer-events-none', 'animate-pulse');
    }

    const state = mediaStore.get();
    let newActiveSeason;

    if (targetSeason.kitsuId) {
        newActiveSeason = await loadKitsuSeason(targetSeason.kitsuId);
    } else {
        newActiveSeason = await loadTMDBSeason(targetSeason.season_number);
    }

    if (newActiveSeason) {
        const firstEpisode = newActiveSeason.episodes[0]?.episodeNumber || 1;
        mediaStore.set({ activeEpisode: firstEpisode });

        renderSeason(newActiveSeason, state.seasons);
    }
}

// Global close function
window.closeMovieDetail = () => {
    mediaStore.clear();

    document.getElementById('full-detail-view').classList.add('translate-y-full');
    document.body.style.overflow = '';

    const dynamicSeasons = document.getElementById('dynamic-seasons-container');
    if (dynamicSeasons) dynamicSeasons.innerHTML = '';

    const episodeList = document.getElementById('episode-list');
    if (episodeList) episodeList.innerHTML = '';
    const customSeasonMenu = document.getElementById('custom-season-menu');
    if (customSeasonMenu) customSeasonMenu.innerHTML = '';
};
//#endregion

//#region Filter
function filterAndSortStreams(streams, type) {
    const losslessAudio = ['atmos', 'truehd', 'dts-hd', 'dts:x', 'flac', 'lossless'];
    const premiumAudio = ['dts', 'dd5.1', 'ac3', 'eac3', 'dolby digital', '5.1', '7.1'];
    const premiumVideo = ['remux', 'bluray', 'web-dl'];

    // 1. MAP: Extract all data and format the exact object
    let parsedStreams = streams.map(stream => {
        const rawTitle = stream.title || "";
        const streamName = (stream.name || "").toLowerCase();

        const parsed = parseTorrentio(rawTitle);

        // Debrid Cache Detection
        const isCached = streamName.includes('torbox+') ||
            streamName.includes('tb+') ||
            streamName.includes('rd+') ||
            rawTitle.toLowerCase().includes('cached');

        // Resolution Fallback Detection
        let finalResolution = parsed.resolution || "Unknown";
        if (streamName.includes('4k') || streamName.includes('2160p')) {
            finalResolution = "4K";
        } else if (streamName.includes('1080p')) {
            finalResolution = "1080p";
        } else if (streamName.includes('720p')) {
            finalResolution = "720p";
        } else if (streamName.includes('480p') || streamName.includes('sd')) {
            finalResolution = "SD";
        } else if (streamName.includes('unknown')) {
            finalResolution = parsed.resolution || "Unknown";
        }

        // Audio Tier Classification
        let audioTier = "Standard";
        const parsedAudio = parsed.audioType;
        const checkAudioTier = (audioData, tierArray) => {
            if (!audioData) return false;
            const formats = Array.isArray(audioData) ? audioData : [audioData];
            return formats.some(audio => tierArray.includes(audio.toLowerCase()));
        };
        if (checkAudioTier(parsedAudio, losslessAudio)) {
            audioTier = "Lossless";
        } else if (checkAudioTier(parsedAudio, premiumAudio)) {
            audioTier = "Premium";
        }

        // Video Tier Classification
        let videoTier = "Standard";
        const parsedSource = (parsed.source || "").toLowerCase();
        if (premiumVideo.some(tier => parsedSource.includes(tier))) {
            videoTier = "Premium";
        }

        return {
            rawStream: stream,
            parsedData: parsed,
            isCached: isCached,
            resolution: finalResolution,
            audioTier: audioTier,
            videoTier: videoTier
        };
    });

    const bucket4K = [];
    const bucket1080p = [];
    const bucketOther = [];

    parsedStreams.forEach(stream => {
        const res = stream.resolution;
        if (res === "4K") {
            bucket4K.push(stream);
        } else if (res === "1080p" || res === "1440p") {
            bucket1080p.push(stream);
        } else {
            bucketOther.push(stream);
        }
    });

    const sortStreams = (a, b) => {
        if (a.isCached !== b.isCached) {
            return a.isCached ? -1 : 1;
        }

        // Sort by language
        const aLangCount = a.parsedData.languages ? a.parsedData.languages.length : 0;
        const bLangCount = b.parsedData.languages ? b.parsedData.languages.length : 0;
        if (aLangCount !== bLangCount) {
            return bLangCount - aLangCount;
        }

        // Sort by video codec
        if (a.videoTier !== b.videoTier) {
            return a.videoTier === "Premium" ? -1 : 1;
        }

        // Sort by audio codec
        const audioWeights = { 'Lossless': 3, 'Premium': 2, 'Standard': 1 };
        const aAudioWeight = audioWeights[a.audioTier] || 1;
        const bAudioWeight = audioWeights[b.audioTier] || 1;
        if (aAudioWeight !== bAudioWeight) {
            return bAudioWeight - aAudioWeight;
        }

        if (a.isCached) {
            const parseSize = (sizeStr) => {
                if (!sizeStr) return 0;
                const match = sizeStr.match(/([\d.]+)\s*([KMGT]i?B)/i);
                if (!match) return 0;
                const val = parseFloat(match[1]);
                const unit = match[2].toUpperCase();
                if (unit.includes('G')) return val * 1024 * 1024 * 1024;
                if (unit.includes('M')) return val * 1024 * 1024;
                return val;
            };
            return parseSize(b.parsedData.size) - parseSize(a.parsedData.size);
        } else {
            return (b.parsedData.seeders || 0) - (a.parsedData.seeders || 0);
        }
    };

    bucket4K.sort(sortStreams);
    bucket1080p.sort(sortStreams);
    bucketOther.sort(sortStreams);

    return { bucket4K, bucket1080p, bucketOther };
}

// --- MODAL UI BUILDER ---
function showStreamPicker(categorizedStreams, mainTitle) {
    const modal = document.getElementById('stream-picker-modal');
    const list = document.getElementById('stream-picker-list');

    document.getElementById('stream-picker-title').innerText = `${mainTitle}`;

    list.innerHTML = '';
    modal.classList.remove('hidden');

    const sliceBucket = (bucket) => {
        return {
            top: bucket.slice(0, 3),
            more: bucket.slice(3)
        };
    };

    const streams4K = sliceBucket(categorizedStreams.bucket4K || []);
    const streams1080p = sliceBucket(categorizedStreams.bucket1080p || []);
    const streamsOther = sliceBucket(categorizedStreams.bucketOther || []);

    // Helper to create beautiful category headers
    const createHeader = (title, colorClass, borderClass, bgClass) => {
        const header = document.createElement('div');
        header.className = `flex items-center gap-1.5 mb-1.5 mt-1`;
        header.innerHTML = `
            <div class="px-2 py-0.7 rounded-md ${bgClass} border ${borderClass}">
                <span class="${colorClass} font-bold text-[12px] uppercase tracking-wider">${title}</span>
            </div>
            <span class="h-[1px] flex-1 ${bgClass}"></span>
        `;
        return header;
    };

    // Container for 4K
    if (streams4K.top.length > 0) {
        const container4K = document.createElement('div');
        container4K.id = 'stream-container-4k';
        container4K.className = 'flex flex-col gap-2.5 mb-6';

        list.appendChild(createHeader('4K UHD', 'text-amber-400', 'border-amber-400/20', 'bg-amber-400/10'));
        list.appendChild(container4K);
        renderStreamCategory('stream-container-4k', streams4K.top, streams4K.more);
    }

    // Container for 1080p
    if (streams1080p.top.length > 0) {
        const container1080p = document.createElement('div');
        container1080p.id = 'stream-container-1080p';
        container1080p.className = 'flex flex-col gap-2.5 mb-6';

        list.appendChild(createHeader('1080p HD', 'text-blue-400', 'border-blue-400/20', 'bg-blue-400/10'));
        list.appendChild(container1080p);
        renderStreamCategory('stream-container-1080p', streams1080p.top, streams1080p.more);
    }

    // Container for Standard / Legacy (720p / SD)
    if (streamsOther.top.length > 0) {
        const containerStandard = document.createElement('div');
        containerStandard.id = 'stream-container-standard';
        containerStandard.className = 'flex flex-col gap-2.5 mb-6';

        list.appendChild(createHeader('Standard / 720p', 'text-slate-400', 'border-slate-500/20', 'bg-slate-500/10'));
        list.appendChild(containerStandard);
        renderStreamCategory('stream-container-standard', streamsOther.top, streamsOther.more);
    }

    // Empty State Handling
    if (streams4K.top.length === 0 && streams1080p.top.length === 0 && streamsOther.top.length === 0) {
        list.innerHTML = `
            <div class="p-6 text-center flex flex-col items-center justify-center bg-red-900/10 border border-red-500/20 rounded-xl mt-4">
                <span class="text-red-400 font-bold text-m">No streams found.</span>
            </div>`;
    }
}

// --- RENDER HELPER WITH "LOAD MORE" ---
function renderStreamCategory(containerId, topStreams, moreStreams) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    topStreams.forEach((stream, index) => {
        const isRecommended = index === 0;
        container.appendChild(createStreamCard(stream, isRecommended));
    });

    if (moreStreams.length > 0) {
        const moreContainer = document.createElement('div');
        moreContainer.className = "hidden flex-col gap-2.5 w-full mt-1";

        moreStreams.forEach(stream => {
            moreContainer.appendChild(createStreamCard(stream, false, false));
        });

        const loadBtn = document.createElement('button');
        loadBtn.className = "w-full py-2.5 mt-1 bg-slate-800/40 text-slate-400 border border-slate-700/50 rounded-xl text-[11px] font-bold tracking-widest uppercase hover:bg-slate-700/60 hover:text-white transition-all hover:border-slate-600 flex justify-center items-center gap-2";
        loadBtn.innerHTML = `Load ${moreStreams.length} More`;

        loadBtn.onclick = () => {
            moreContainer.classList.remove('hidden');
            moreContainer.classList.add('flex');
            loadBtn.remove();
        };

        container.appendChild(loadBtn);
        container.appendChild(moreContainer);
    }
}

function buildStreamBlueprint(stream) {
    const parsed = stream.parsedData || {};

    // 1. Determine Audio Color cleanly
    let audioColor = "slate";
    if (stream.audioTier === "Lossless") audioColor = "purple";
    else if (stream.audioTier === "Premium") audioColor = "blue";

    let displayTitle = null;
    if (parsed.title) {
        displayTitle = parsed.title
            // 1. Remove ANY trailing characters that are not a letter or number
            .replace(/[^a-zA-Z0-9]+$/, '')
            .replace(/\b\w/g, char => char.toUpperCase())
            .trim();
    }

    let displayAudio = null;
    if (parsed.audioType) {
        const audioArr = Array.isArray(parsed.audioType) ? parsed.audioType : [parsed.audioType];
        displayAudio = audioArr.join('/').toUpperCase();
    }

    let displayLangs = null;
    if (parsed.languages && parsed.languages.length > 0) {
        if (parsed.languages.length > 5) {
            const firstFive = parsed.languages.slice(0, 5).join(', ');
            const extras = parsed.languages.length - 5;
            displayLangs = `🌐 ${firstFive} +${extras}`;
        } else {
            displayLangs = `🌐 ${parsed.languages.join(', ')}`;
        }
    }

    // 2. THE BLUEPRINT: Define exactly what lives on each line
    const uiData = {
        // Line 1: Tracker Name and Cached Status
        line1: [
            { type: 'text', text: parsed.group, size: 'medium' },
            { type: 'text', text: `| ${displayTitle}`, size: 'medium' },
            stream.isCached ? { type: 'badge', text: '⚡ Cached', color: 'emerald' } : { type: 'badge', text: '⚠️ Uncached', color: 'orange' }
        ].filter(Boolean),

        // Line 2: Video Specs & Languages (The Pill Badges)
        line2: [
            parsed.source ? { type: 'text', text: `📹 ${parsed.source}`, size: 'small', color: 'blue', bold: true } : null,
            displayAudio ? { type: 'text', text: `🔊 ${displayAudio}`, size: 'small', color: audioColor, bold: true } : null,
            parsed.seasonDetails ? { type: 'badge', text: parsed.seasonDetails, size: 'small', color: 'blue', bold: true } : null
        ].filter(Boolean),

        // Line 3: Meta Data (The dot-separated text)
        line3: [
            displayLangs ? { type: 'text', text: displayLangs, color: 'blue' } : null,
            parsed.seeders !== undefined ? { type: 'text', text: `👤 ${parsed.seeders}` } : null,
            parsed.size && String(parsed.size).toLowerCase() !== 'unknown' ? { type: 'text', text: `💾 ${parsed.size}` } : null
        ].filter(Boolean)
    };

    return uiData;
}

// HELPER FUNCTION TO BUILD UI CARDS
function createStreamCard(stream, isRecommended) {
    // 1. Get our clean data blueprint from Step 1
    const blueprint = buildStreamBlueprint(stream);

    let extractedHash = null;
    const raw = stream.rawStream;

    if (raw.infoHash) {
        extractedHash = raw.infoHash;
    } else if (raw.url) {
        const urlMatch = raw.url.match(/\/([a-fA-F0-9]{40})\//);
        if (urlMatch) extractedHash = urlMatch[1];
    }

    if (!extractedHash && raw.behaviorHints?.bingeGroup) {
        const bingeMatch = raw.behaviorHints.bingeGroup.match(/\|([a-fA-F0-9]{40})/);
        if (bingeMatch) extractedHash = bingeMatch[1];
    }

    const finalLink = extractedHash
        ? `magnet:?xt=urn:btih:${extractedHash}`
        : raw.url;

    // 1. Safely grab the raw strings (fallback if rawStream is missing)
    const rawName = raw?.name;
    let rawTitle = raw?.title;

    rawTitle = rawTitle.replace(/(?:\r\n|\r|\n|\\n)/g, '<br>');
    let rawInfo = `${rawName}<br>${rawTitle}`;

    // 3. The Bulletproof Regex: Catches literal "\n" text, actual newlines, and carriage returns

    // 3. Define the UI rendering rules (How to draw each piece of data)
    const renderBadge = (item) => {
        const themes = {
            emerald: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
            slate: "bg-slate-700/50 text-slate-200 border-slate-600",
            blue: "bg-blue-500/10 text-blue-300 border-blue-500/20",
            orange: "bg-red-500/10 text-orange-300 border-red-500/20"
        };
        const theme = themes[item.color] || themes.slate;
        return `<span class="${theme} border text-[10px] px-1.5 py-0.5 rounded uppercase font-bold tracking-wider shadow-sm flex items-center gap-1">${item.text}</span>`;
    };

    const renderText = (item) => {
        const fontWeight = item.bold ? "font-bold" : "font-medium";
        // Map the text color dynamically
        const textColorMap = {
            emerald: "text-emerald-400",
            purple: "text-purple-400",
            blue: "text-blue-400",
            slate: "text-slate-300"
        };
        const textSizeMap = {
            small: "text-sm",
            medium: "text-base",
            large: "text-lg",
        };
        const textColor = textColorMap[item.color] || "text-slate-300";
        const textSize = textSizeMap[item.size] || "text-m";
        return `<span class="${fontWeight} ${textSize} ${textColor}">${item.text}</span>`;
    };

    // 4. The Loop: Converts a line array into a string of HTML
    const renderLine = (lineData) => lineData.map(item => {
        if (item.type === 'badge') return renderBadge(item);
        if (item.type === 'text') return renderText(item);
        return '';
    }).join('');

    // 5. Button styling based on tier
    const baseClasses = "w-full text-left border p-3.5 rounded-xl transition-all duration-200 flex flex-col group relative overflow-hidden";

    let colorClasses = "bg-slate-800/60 hover:bg-slate-700/80 border-slate-700 hover:border-slate-500 shadow-sm hover:shadow-md";
    let buttonHover = "bg-slate-800 text-slate-300 group-hover:bg-blue-600 group-hover:text-white";

    if (isRecommended) {
        colorClasses = "bg-emerald-900/10 hover:bg-emerald-900/20 border-emerald-500/30 hover:border-emerald-500/60 shadow-[0_0_15px_rgba(16,185,129,0.05)] hover:shadow-[0_0_20px_rgba(16,185,129,0.1)]";
        buttonHover = "bg-emerald-900/50 text-emerald-400 border border-emerald-500/30 group-hover:bg-emerald-600 group-hover:text-white group-hover:border-transparent";
    }

    // 6. Create the actual DOM Element
    const btn = document.createElement('button');
    btn.className = `${baseClasses} ${colorClasses}`;

    btn.innerHTML = `
        <div class="flex justify-between items-start w-full gap-3">
            <div class="flex flex-col gap-1.5 flex-1 overflow-hidden">
                <div class="flex items-center flex-wrap gap-2">
                    ${renderLine(blueprint.line1)}
                </div>
                <div class="flex items-center flex-wrap gap-1.5">
                    ${renderLine(blueprint.line2)}
                </div>
            </div>
            <span class="text-[10px] whitespace-nowrap font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg transition-colors flex-shrink-0 mt-0.5 ${buttonHover}">Send to Torbox</span>
        </div>
        
        <div class="flex justify-between items-end w-full mt-2">
            <div class="text-[12px] text-slate-300 flex items-center flex-wrap gap-2">
                ${blueprint.line3.length > 0 ? blueprint.line3.map(item => renderText(item)).join('<span>•</span>') : ''}
            </div>
            
            <span class="expand-btn flex items-center justify-center text-slate-400 hover:text-blue-400 hover:bg-slate-700/60 p-2 rounded-full transition-all z-10 cursor-pointer -mr-2 -mb-2">
                <svg class="chevron w-5 h-5 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7"></path>
                </svg>
            </span>
        </div>

        <div class="details-container hidden w-full flex-col text-left mt-4 pt-4 border-t cursor-default">            
            <span class="text-[13px] font-bold text-slate-500 break-words block">${rawInfo}</span>
        </div>
    `;

    btn.onclick = (e) => {
        // Intercept clicks on either the expand button OR inside the details container
        if (e.target.closest('.expand-btn') || e.target.closest('.details-container')) {
            e.preventDefault();
            e.stopPropagation();

            // If they specifically clicked the expand button, toggle the drawer
            if (e.target.closest('.expand-btn')) {
                const detailsContainer = btn.querySelector('.details-container');
                const chevron = btn.querySelector('.chevron');

                // Toggle visibility
                detailsContainer.classList.toggle('hidden');
                detailsContainer.classList.toggle('flex');

                // Flip the arrow upside down
                chevron.classList.toggle('rotate-180');
            }
            return; // Stop the code here so the stream isn't sent to TorBox
        }

        // Standard behavior (Triggers if they click the main card area)
        closeStreamPicker();
        sendMagnetToTorbox(finalLink);
    };

    return btn;
}

//#region Torrent Services
function getTorrentioConfigUrl(tbKey) {
    if (!tbKey) throw new Error("TorBox API key is missing.");

    // 1. Define your Torrentio settings as a clean dictionary
    const config = {
        providers: ["yts", "eztv", "1337x", "torrentgalaxy", "nyaasi"],

        // Quality Filter (The Incinerator): Excludes these formats entirely
        qualityfilter: ["other", "cam", "unknown", "scr", "threed"],

        limit: 10, // Max results per quality
        torbox: tbKey
    };

    // 2. Build the pipe-separated string
    const configParts = [];

    for (const [key, value] of Object.entries(config)) {
        // If the value is an array, join it with commas. Otherwise, use it as-is.
        const formattedValue = Array.isArray(value) ? value.join(',') : value;
        configParts.push(`${key}=${formattedValue}`);
    }

    const configString = configParts.join('|');

    // 3. Return the full API URL ready for fetching!
    return `https://torrentio.strem.fun/${configString}/manifest.json`;
}

async function fetchTorrentioStreams(type, id, season = null, episode = null) {
    console.log(`Fetching Torrentio streams for: ${type} ${id}`);

    const tbKey = localStorage.getItem('tb_api_key');
    if (!tbKey) {
        console.error("❌ No TorBox key found.");
        return null;
    }

    let streamPath = '';

    if (type === 'movie') {
        streamPath = `movie/${id}`;
    } else if (type === 'series') {
        streamPath = `series/${id}:${season}:${episode}`;
    } else if (type === 'anime') {
        const formattedKitsuId = String(id).includes('kitsu:') ? id : `kitsu:${id}`;
        streamPath = `anime/${formattedKitsuId}:${episode}`;
    }

    const baseUrl = getTorrentioConfigUrl(tbKey);

    const torrentioUrl = baseUrl.replace('/manifest.json', `/stream/${streamPath}.json`);

    try {
        const response = await fetch(torrentioUrl);
        if (!response.ok) throw new Error(`Status: ${response.status}`);

        const data = await response.json();
        const rawStreams = data.streams || [];

        const uniqueStreams = [];
        const seenHashes = new Set();

        rawStreams.forEach(stream => {
            const identifier = stream.infoHash || stream.url;
            if (identifier && !seenHashes.has(identifier)) {
                seenHashes.add(identifier);
                uniqueStreams.push(stream);
            }
        });

        return { uniqueStreams };

    } catch (error) {
        console.error("Torrentio Fetch Failed:", error);
        return null;
    }
}

window.closeStreamPicker = () => {
    document.getElementById('stream-picker-modal').classList.add('hidden');
};

// Add a link to users library  
async function sendMagnetToTorbox(magnetLink) {
    const tbKey = localStorage.getItem('tb_api_key');
    if (!tbKey) return;

    try {
        // --- NORMAL TORBOX API CALL ---
        const tbUrl = 'https://api.torbox.app/v1/api/torrents/createtorrent';
        const formData = new FormData();
        formData.append('magnet', magnetLink);

        const tbRes = await smartFetch(tbUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${tbKey}` },
            body: formData
        });

        const tbData = await tbRes.json();

        if (tbData.success) {
            window.closeMovieDetail();

            // Allow 1.5 seconds for TorBox to parse the file before switching to the library
            setTimeout(() => {
                if (typeof window.showLibraryTab === 'function') window.showLibraryTab();
                if (typeof window.refreshLibrary === 'function') window.refreshLibrary();
                else location.reload();
            }, 1500);

        } else {
            throw new Error(tbData.detail || "TorBox rejected the magnet.");
        }
    } catch (e) {
        console.error(e);
        showToast(`Failed to add: ${e.message}`, 'error');
    }
}

document.addEventListener('click', async (event) => {
    const playBtn = event.target.closest('#btn-torrent');

    if (!playBtn) return;
    if (playBtn.disabled) return;

    await handlePlayAction();
});