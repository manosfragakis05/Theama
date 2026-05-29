import { smartFetch, showToast, MY_PROXY, getTbKey, TMDB_KEY } from './services/config.js';
import { parseTorrentio } from './utils/parseMedia.js';

const rowState = {
    'trending-movies-row': { page: 1, endpoint: 'trending/movie/week', loading: false, hasMore: true },
    'trending-shows-row': { page: 1, endpoint: 'trending/tv/week', loading: false, hasMore: true },
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


let isDragInitialized = false;
export function initGlobalDrag() {
    if (isDragInitialized) return;
    isDragInitialized = true;

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
    window.addEventListener('mouseleave', () => {
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

const rowObservers = {};

function getObserverFor(containerId) {
    // If we already created an observer for this row, just return it
    if (rowObservers[containerId]) {
        return rowObservers[containerId];
    }

    // Otherwise, create a new one specifically locked to this row's boundaries
    const rowElement = document.getElementById(containerId);

    rowObservers[containerId] = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const targetId = entry.target.dataset.targetRow;

                // Un-observe it so we don't trigger multiple times
                rowObservers[targetId].unobserve(entry.target);

                // Fetch the next page
                renderRow(null, targetId);
            }
        });
    }, {
        root: rowElement,
        rootMargin: '0px 1000px 0px 0px',
        threshold: 0
    });

    return rowObservers[containerId];
}

//#region TMDB LOGIC

// Fetch card data
async function fetchTMDBEndpoint(endpoint, page = 1) {
    const base = `https://api.themoviedb.org/3/`;
    const url = new URL(endpoint.startsWith('http') ? endpoint : base + endpoint);

    url.searchParams.append('api_key', TMDB_KEY);
    url.searchParams.append('language', 'en-US');
    url.searchParams.append('page', page.toString());

    const response = await fetch(url.toString());
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
        <div class="media-card relative flex-none w-32 md:w-40 cursor-pointer transition-all duration-150 ease-out hover:scale-105 hover:-translate-1 select-none group"
             data-id="${movie.id}"
             data-type="${detectedType}"
             data-title="${displayTitle}"
             data-backdrop="${movie.backdrop_path || ''}"
             data-poster="${movie.poster_path}">
             
            <div class="rounded-lg overflow-hidden border border-slate-700/50 bg-slate-800 shadow-md aspect-[2/3] transform-gpu">
                <img src="https://image.tmdb.org/t/p/w500${movie.poster_path}" 
                     class="w-full h-full object-cover"
                     loading="lazy" draggable="false" alt="${displayTitle}">
            </div>
            
            <p class="text-xs text-slate-300 mt-2 truncate font-semibold pl-1 group-hover:text-white transition-colors">${displayTitle}</p>
            <p class="text-[10px] text-slate-500 pl-1">${year}</p>
        </div>
    `;
}

function renderCardsToRow(movies, containerId) {
    const row = document.getElementById(containerId);
    if (!row) return;

    const oldSentinel = row.querySelector('.scroll-sentinel');
    if (oldSentinel) {
        // Clean up the old observer reference before removing the element
        getObserverFor(containerId).unobserve(oldSentinel);
        oldSentinel.remove();
    }

    const htmlContent = movies.map(createCardHTML).join('');
    row.insertAdjacentHTML('beforeend', htmlContent);

    if (rowState[containerId].hasMore) {
        row.insertAdjacentHTML('beforeend', `<div class="scroll-sentinel w-1 flex-none" data-target-row="${containerId}"></div>`);

        // 👇 USE THE NEW OBSERVER FUNCTION HERE 👇
        getObserverFor(containerId).observe(row.querySelector('.scroll-sentinel:last-child'));
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
        if (!['trending-movies-row', 'trending-shows-row'].includes(containerId)) {
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
            if (row) {
                const oldSentinel = row.querySelector('.scroll-sentinel');

                // 👇 Update this line to use the new observer system!
                if (oldSentinel) getObserverFor(containerId).unobserve(oldSentinel);

                row.innerHTML = '';
            }
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

function createSkeletonCard() {
    return `
        <div class="relative flex-none w-32 md:w-40 animate-pulse select-none">
            <div class="rounded-lg w-full bg-slate-800 border border-slate-700/50 aspect-[2/3]"></div>
            <div class="h-3 bg-slate-700/50 rounded mt-3 w-3/4"></div>
            <div class="h-2 bg-slate-800 rounded mt-2 w-1/4"></div>
        </div>
    `;
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
    const standardRows = ['trending-movies-row', 'trending-shows-row', 'top-row', 'action-row', 'comedy-row', 'thriller-row', 'anime-row'];
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
            try {
                const url = `https://api.themoviedb.org/3/${item.type}/${item.id}?api_key=${TMDB_KEY}&language=en-US`;
                const res = await fetch(url);
                if (!res.ok) return null; // Gracefully fail this one item
                const data = await res.json();
                return {
                    ...data,
                    title: data.title || data.name,
                    release_date: data.release_date || data.first_air_date,
                    media_type: item.type
                };
            } catch (e) {
                return null;
            }
        }));

        // Filter out any nulls before rendering
        const successfulMovies = movieData.filter(movie => movie !== null);
        renderCardsToRow(successfulMovies, containerId);
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
async function buildKitsuSeasons(baseKitsuId) {
    let currentId = baseKitsuId;
    const visited = new Set();
    const timeline = [];
    let fakeSeasonCounter = 1;
    let maxDepth = 15; // Failsafe to prevent infinite loops

    try {
        while (currentId && !visited.has(currentId) && maxDepth > 0) {
            visited.add(currentId);

            // ⚡ THE FIX: Use Sparse Fieldsets (fields[anime]=titles) to make the download tiny
            const url = `https://kitsu.io/api/edge/anime/${currentId}?include=mediaRelationships.destination&fields[anime]=titles,canonicalTitle`;

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

            // Find the sequel
            const relationships = included.filter(item => item.type === 'mediaRelationships');
            const sequelRel = relationships.find(rel => rel.attributes.role === 'sequel');

            if (sequelRel) {
                currentId = sequelRel.relationships?.destination?.data?.id;
                fakeSeasonCounter++;
            } else {
                currentId = null; // End of the line
            }

            maxDepth--;
        }

        mediaStore.set({ seasons: timeline });
        return timeline;

    } catch (error) {
        console.error(`[KITSU] Timeline spider crashed:`, error);
        return timeline; // Return whatever we managed to scrape before the crash!
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
            try {
                const aniJson = await aniRes.json();
                anizipData = aniJson.episodes || {};
            } catch (e) {
                console.warn("AniZIP failed to parse JSON (likely rate limited or offline):", e);
            }
        }

        let currentKitsuData = await kitsuRes.json();
        const kitsuEpisodes = currentKitsuData.data || [];

        const totalEpisodes = currentKitsuData.meta?.count || kitsuEpisodes.length;
        const totalPages = Math.ceil(totalEpisodes / 20);

        let nextUrl = null;
        const formattedEpisodes = [];

        if (totalPages > 1) {
            const pagePromises = [];

            for (let i = 2; i <= totalPages; i++) {
                const offset = (i - 1) * 20;
                const pageUrl = `https://kitsu.io/api/edge/anime/${kitsuId}/episodes?page[limit]=20&page[offset]=${offset}`;

                pagePromises.push(fetch(pageUrl).then(res => res.ok ? res.json() : null));
            }

            const additionalPages = await Promise.all(pagePromises);

            additionalPages.forEach(pageData => {
                if (pageData && pageData.data) {
                    kitsuEpisodes.push(...pageData.data);
                }
            });
        }

        kitsuEpisodes.forEach(ep => {
            const attrs = ep.attributes;
            const epNum = attrs.number;
            const zipEp = anizipData[epNum] || {};
            let thumbUrl = zipEp.image || attrs.thumbnail?.original || fallbackBackdrop;

            formattedEpisodes.push({
                episodeNumber: epNum,
                title: attrs.canonicalTitle || attrs.titles?.en_jp || zipEp.title?.en || zipEp.title?.['x-jat'] || `Episode ${epNum}`,
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
        showStreamPicker(state.title);    // Always show the picker

        // Fetch the streams
        fetchTorrentioStreams(type, id, reqSeason, reqEpisode)
            .then(streamData => {
                if (streamData && streamData.uniqueStreams && streamData.uniqueStreams.length > 0) {
                    const categorizedStreams = filterAndSortStreams(streamData.uniqueStreams);

                    renderAddonData(categorizedStreams);
                    console.log(categorizedStreams);
                } else {
                    console.log("📭 Torrentio found no streams.");
                }
            })
            .catch(e => console.error("Torrentio crashed:", e));

        loadAllAddonsParallel(type, id, reqSeason, reqEpisode);
    } catch (e) {
        console.error("Failed to load streams:", e);
        showToast("Error fetching streams.", "error");
    } finally {
        playBtn.innerHTML = originalContent;
        playBtn.disabled = false;
    }
}

//#region Render Details
function renderMasterDetailView() {
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

//#region Filter & Sort
function filterAndSortStreams(streams) {
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

    return { addonName: "Torrentio", bucket4K, bucket1080p, bucketOther };
}

export function filterAndSortCustomStreams(streams, addonName) {
    let parsedStreams = streams.map(stream => {
        const rawTitle = stream.description || stream.title || '';
        const streamName = (stream.name || "").toLowerCase();
        const rawText = `${streamName} ${rawTitle}`;

        const isCached = rawText.includes('rd+') ||
            rawText.includes('torbox+') ||
            rawText.includes('tb+') ||
            rawText.includes('cached') ||
            rawText.includes('⚡');

        // 📺 Resolution Detection
        let resolution = "Unknown";
        let resScore = 0;

        if (rawText.includes('4k') || rawText.includes('2160p')) {
            resolution = "4K";
            resScore = 3;
        } else if (rawText.includes('1080p')) {
            resolution = "1080p";
            resScore = 2;
        } else if (rawText.includes('720p') || rawText.includes('sd') || rawText.includes('480p')) {
            resolution = "720p";
            resScore = 1;
        }

        return {
            rawStream: stream,
            isCached: isCached,
            resolution: resolution,
        };
    });

    // 2. SORT: Clean, unified sorting
    parsedStreams.sort((a, b) => {
        // Rule 1: Cached ALWAYS goes to the top
        if (a.isCached !== b.isCached) {
            return a.isCached ? -1 : 1;
        }

        // Rule 2: Sort by Resolution Score (Highest to lowest)
        if (a.resScore !== b.resScore) {
            return b.resScore - a.resScore;
        }

        // Rule 3: Leave them in the order the add-on provided
        return 0;
    });

    // Hard cap at 40 streams to protect mobile performance
    parsedStreams = parsedStreams.slice(0, 40);

    // 3. BUCKET: Exact same format as your Torrentio sorter
    const bucket4K = [];
    const bucket1080p = [];
    const bucketOther = [];

    parsedStreams.forEach(stream => {
        if (stream.resolution === "4K") {
            bucket4K.push(stream);
        } else if (stream.resolution === "1080p") {
            bucket1080p.push(stream);
        } else {
            bucketOther.push(stream);
        }
    });

    return {
        addonName: addonName, // 👈 Just inject the name here!
        bucket4K,
        bucket1080p,
        bucketOther
    };
}
//#endregion


//#region Render Streams
const streamState = {
    addons: {}
};

function showStreamPicker(mainTitle) {
    const modal = document.getElementById('stream-picker-modal');
    const tabsContainer = document.getElementById('addon-tabs-container');
    const list = document.getElementById('stream-picker-list');

    document.getElementById('stream-picker-title').innerText = `${mainTitle}`;

    // 1. --- RESET THE STATE CACHE ---
    streamState.addons = {
        'Torrentio': { status: 'loading', streams: [] }
    };

    const userAddons = JSON.parse(localStorage.getItem('user_addons')) || [];

    userAddons.forEach(addon => {
        const shortName = addon.name.split(' ')[0];
        streamState.addons[shortName] = { status: 'loading', streams: [] };
    });

    // 2. --- BUILD THE ADD-ON TABS (ALL IN JS) ---
    tabsContainer.innerHTML = '';

    // Helper to build a tab button
    const createTabButton = (name, isActive) => {
        const btn = document.createElement('button');
        btn.id = `tab-${name}`;

        if (isActive) {
            btn.className = "addon-tab flex-shrink-0 rounded-full px-4 py-1.5 text-xs font-bold whitespace-nowrap transition-all bg-blue-600 text-white shadow-md shadow-blue-900/20 active:scale-95";
        } else {
            btn.className = "addon-tab flex-shrink-0 rounded-full px-4 py-1.5 text-xs font-bold whitespace-nowrap transition-all bg-slate-700/50 text-slate-400 hover:bg-slate-700 hover:text-slate-200 border border-slate-600/50 active:scale-95";
        }

        btn.innerText = name;

        // Safely attach the click listener!
        btn.addEventListener('click', () => {
            switchTab(name);
        });

        tabsContainer.appendChild(btn);
    };

    if (userAddons.length > 0) {
        tabsContainer.classList.remove('hidden');

        // Build Torrentio (Active)
        createTabButton('Torrentio', true);

        // Build Custom Addons (Inactive)
        userAddons.forEach(addon => {
            const shortName = addon.name.split(' ')[0];
            createTabButton(shortName, false);
        });
    } else {
        tabsContainer.classList.add('hidden');
    }

    // 3. --- STAMP OUT THE PANELS ---
    list.innerHTML = '';
    const template = document.getElementById('addon-panel-template');

    const mountPanel = (addonName, isFirstTab) => {
        const clone = template.content.cloneNode(true);
        const panel = clone.querySelector('.addon-panel');

        panel.id = `panel-${addonName}`;

        // 👇 Inject the custom loading text here!
        const loadingText = panel.querySelector('.loading-text');
        if (loadingText) {
            loadingText.innerText = `Searching ${addonName}...`;
        }

        if (isFirstTab) {
            panel.classList.remove('hidden');
            panel.classList.add('flex');
        }

        list.appendChild(clone);
    };

    // Stamp Torrentio first
    mountPanel('Torrentio', true);

    // Stamp the rest
    userAddons.forEach(addon => {
        const shortName = addon.name.split(' ')[0];
        mountPanel(shortName, false);
    });

    // 4. --- REVEAL MODAL ---
    modal.classList.remove('hidden');
}
// TAB SWITCHER
function switchTab(addonName) {
    const allTabs = document.querySelectorAll('.addon-tab');

    allTabs.forEach(tab => {
        // Reset all tabs to the gray, inactive style
        tab.className = "addon-tab flex-shrink-0 rounded-full px-4 py-1.5 text-xs font-bold whitespace-nowrap transition-all bg-slate-700/50 text-slate-400 hover:bg-slate-700 hover:text-slate-200 border border-slate-600/50 active:scale-95";
    });

    const activeTab = document.getElementById(`tab-${addonName}`);
    if (activeTab) {
        // Highlight the clicked tab in blue
        activeTab.className = "addon-tab flex-shrink-0 rounded-full px-4 py-1.5 text-xs font-bold whitespace-nowrap transition-all bg-blue-600 text-white shadow-md shadow-blue-900/20 active:scale-95";
    }

    // 2. --- SWAP THE PANELS ---
    const allPanels = document.querySelectorAll('.addon-panel');

    allPanels.forEach(panel => {
        // Hide every panel
        panel.classList.add('hidden');
        panel.classList.remove('flex');
    });

    const targetPanel = document.getElementById(`panel-${addonName}`);
    if (targetPanel) {
        // Reveal only the panel that matches the clicked tab
        targetPanel.classList.remove('hidden');
        targetPanel.classList.add('flex');
    }
};

// Helper to create beautiful category headers dynamically
const createHeader = (title, colorClass, borderClass, bgClass) => {
    const header = document.createElement('div');
    header.className = `flex items-center gap-1.5 mb-1.5 mt-2`;
    header.innerHTML = `
        <div class="px-2 py-[3px] rounded-md ${bgClass} border ${borderClass}">
            <span class="${colorClass} font-bold text-[12px] uppercase tracking-wider">${title}</span>
        </div>
        <span class="h-[1px] flex-1 ${bgClass}"></span>
    `;
    return header;
};

// 🎨 THE PARENT RENDERER
export function renderAddonData(packedData) {
    // 1. Unpack the data
    const { addonName, bucket4K, bucket1080p, bucketOther } = packedData;

    const isCustom = addonName !== 'Torrentio';

    // 2. Find the specific universe for this add-on
    const panel = document.getElementById(`panel-${addonName}`);
    if (!panel) return; // Failsafe

    const loadingSpinner = panel.querySelector('.panel-loading');
    const contentContainer = panel.querySelector('.panel-content');

    // 3. Hide the spinner, show and clean the content area
    if (loadingSpinner) loadingSpinner.classList.add('hidden');
    contentContainer.classList.remove('hidden');
    contentContainer.innerHTML = '';

    // 4. Check for Empty State
    const totalStreams = bucket4K.length + bucket1080p.length + bucketOther.length;

    if (totalStreams === 0) {
        contentContainer.innerHTML = `
            <div class="p-6 text-center flex flex-col items-center justify-center bg-red-900/10 border border-red-500/20 rounded-xl mt-4">
                <span class="text-red-400 font-bold text-sm">No streams found for ${addonName}.</span>
            </div>`;
        return;
    }

    const sliceTopAndMore = (bucket) => ({ top: bucket.slice(0, 3), more: bucket.slice(3) });

    if (bucket4K.length > 0) {
        contentContainer.appendChild(createHeader('4K UHD', 'text-amber-400', 'border-amber-400/20', 'bg-amber-400/10'));

        const container4K = document.createElement('div');
        container4K.className = 'flex flex-col gap-2.5 mb-4';
        container4K.id = `container-4k-${addonName}`;
        contentContainer.appendChild(container4K);

        const sliced = sliceTopAndMore(bucket4K);
        renderStreamCategory(container4K.id, sliced.top, sliced.more, isCustom);
    }

    if (bucket1080p.length > 0) {
        contentContainer.appendChild(createHeader('1080p HD', 'text-blue-400', 'border-blue-400/20', 'bg-blue-400/10'));

        const container1080p = document.createElement('div');
        container1080p.className = 'flex flex-col gap-2.5 mb-4';
        container1080p.id = `container-1080p-${addonName}`;
        contentContainer.appendChild(container1080p);

        const sliced = sliceTopAndMore(bucket1080p);
        renderStreamCategory(container1080p.id, sliced.top, sliced.more, isCustom);
    }

    if (bucketOther.length > 0) {
        contentContainer.appendChild(createHeader('Others / 720p', 'text-slate-400', 'border-slate-500/20', 'bg-slate-500/10'));

        const containerOther = document.createElement('div');
        containerOther.className = 'flex flex-col gap-2.5 mb-4';
        containerOther.id = `container-other-${addonName}`;
        contentContainer.appendChild(containerOther);

        const sliced = sliceTopAndMore(bucketOther);
        renderStreamCategory(containerOther.id, sliced.top, sliced.more, isCustom);
    }
}

function renderStreamCategory(containerId, topStreams, moreStreams, isCustom) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    topStreams.forEach((stream, index) => {
        const isRecommended = index === 0;
        container.appendChild(createStreamCard(stream, isRecommended, isCustom));
    });

    if (moreStreams.length > 0) {
        const moreContainer = document.createElement('div');
        moreContainer.className = "hidden flex-col gap-2.5 w-full mt-1";

        moreStreams.forEach(stream => {
            moreContainer.appendChild(createStreamCard(stream, false, isCustom));
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
function createStreamCard(stream, isRecommended, isCustom) {
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
    const rawName = raw.name;
    let rawTitle = raw.description || raw.title;

    rawTitle = rawTitle.replace(/(?:\r\n|\r|\n|\\n)/g, '<br>');
    let rawInfo = `${rawName}<br>${rawTitle}`;

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

    if (isCustom) {
        const btn = document.createElement('button');
        btn.className = `${baseClasses} ${colorClasses}`;

        btn.innerHTML = `
        <div class="w-full flex justify-between items-start text-left cursor-default">            
            <span class="text-[14px] font-semibold text-slate-300 break-words block">${rawInfo}</span>
            <span class="text-[10px] whitespace-nowrap font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg transition-colors flex-shrink-0 mt-0.5 ${buttonHover}">Send to Torbox</span>
        </div>
        `;

        btn.onclick = (e) => {
            closeStreamPicker();
            sendMagnetToTorbox(finalLink);
        };
        return btn;
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

//#region Torrentio
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

    const tbKey = getTbKey();
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


// Add a link to users library  
async function sendMagnetToTorbox(magnetLink) {
    const tbKey = getTbKey();
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
            window.closeStreamPicker();
            showToast("Successfully added", "success")

        } else {
            throw new Error(tbData.detail || "TorBox rejected the magnet.");
        }
    } catch (e) {
        console.error(e);
        showToast(`Failed to add: ${e.message}`, 'error');
    }
}

window.closeStreamPicker = () => {
    document.getElementById('stream-picker-modal').classList.add('hidden');
};
//#endregion

//#region Custom Addons
function loadAllAddonsParallel(type, streamId, season = null, episode = null) {
    const userAddons = JSON.parse(localStorage.getItem('user_addons')) || [];

    // Format the ID once for everyone
    let pathId = streamId;
    if (type === 'anime' && !String(pathId).startsWith('kitsu:')) pathId = `kitsu:${pathId}`;
    if (type === 'series') pathId = `${pathId}:${season}:${episode}`;
    else if (type === 'anime') pathId = `${pathId}:${episode}`;

    // FIRE THEM ALL IN PARALLEL WITHOUT BLOCKING
    userAddons.forEach(addon => {
        fetchSingleAddon(addon, type, pathId)
            .then(streams => {
                if (streams === null) {
                    console.log(`🚨 ${addon.name} is offline or failed.`);
                }
                else if (streams.length === 0) {
                    console.log(`📭 ${addon.name} found 0 streams.`);
                }
                else {
                    const shortName = addon.name.split(' ')[0]; // 👈 Fix 1: Get the clean name!

                    // 1. Filter and pack the data
                    const packedData = filterAndSortCustomStreams(streams, shortName);

                    // 2. 🧠 Save it to the cache! (Crucial for tab switching)
                    streamState.addons[shortName] = packedData;

                    // 3. Draw it to the screen
                    renderAddonData(packedData);
                    console.log(packedData);
                }
            });

    });
}

async function fetchSingleAddon(addon, type, pathId) {
    console.log(`🕵️‍♂️ Fetching ${addon.name}...`);

    try {
        const streamUrl = addon.url.replace('/manifest.json', `/stream/${type}/${pathId}.json`);
        const res = await fetch(streamUrl);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        return data.streams || []; // Return the array of streams!

    } catch (e) {
        console.warn(`🔴 [${addon.name}] Failed:`, e.message);
        return null;
    }
}

/**
 * Detects and validates a Stremio Add-on Manifest.
 * @param {string} rawUrl - The URL pasted by the user.
 * @returns {object} - { success: boolean, manifest: object, url: string, error: string }
 */
export async function detectAndValidateAddon(rawUrl) {
    // 1. Sanitize the URL
    let url = rawUrl.trim();

    // Auto-fix if the user pasted the base URL without manifest.json
    if (!url.endsWith('manifest.json')) {
        url = url.endsWith('/') ? `${url}manifest.json` : `${url}/manifest.json`;
    }

    // Replace stremio:// protocol with https:// if the user copied a deep link
    url = url.replace('stremio://', 'https://');

    try {
        // 2. Fetch the Manifest (With CORS Fallback)
        // Stremio add-ons *should* have CORS enabled by default, but if a browser 
        // blocks it, we catch the failure and route it through your proxy!
        let response;
        try {
            response = await fetch(url);
        } catch (e) {
            console.warn("Direct fetch blocked by CORS. Using proxy...");
            const proxyUrl = MY_PROXY.replace('/?url=', ''); // Clean base proxy URL
            response = await fetch(`${proxyUrl}/?url=${encodeURIComponent(url)}`);
        }

        if (!response.ok) {
            throw new Error(`Server returned status: ${response.status}`);
        }

        const manifest = await response.json();

        // 3. Schema Validation: Is it actually a Stremio Add-on?
        if (!manifest.id || !manifest.name || !manifest.resources || !Array.isArray(manifest.resources)) {
            throw new Error("Invalid format. This is not a recognized Stremio add-on.");
        }

        // 4. The "Streams Only" Enforcer
        // Resources can be an array of strings ["stream"] or objects [{name: "stream", types: ["movie"]}]
        const providesStreams = manifest.resources.some(resource => {
            if (typeof resource === 'string') return resource === 'stream';
            if (typeof resource === 'object') return resource.name === 'stream';
            return false;
        });

        if (!providesStreams) {
            throw new Error(`Rejected: '${manifest.name}' is a catalog/metadata scraper. We only accept stream providers.`);
        }

        // 5. Success! Return the clean data.
        return {
            success: true,
            manifest: manifest,
            url: url
        };

    } catch (error) {
        console.error("Detector Failed:", error);
        return {
            success: false,
            error: error.message || "Failed to parse the add-on manifest."
        };
    }
}


window.submitNewAddon = async () => {
    const inputField = document.getElementById('addon-url-input');
    const submitBtn = inputField.nextElementSibling; // Grabs the save button
    const rawUrl = inputField.value;

    if (!rawUrl) return;

    // UI Feedback: Show loading state
    const originalText = submitBtn.innerText;
    submitBtn.innerText = "Verifying...";
    submitBtn.disabled = true;

    // Call our new detector!
    const result = await detectAndValidateAddon(rawUrl);

    submitBtn.innerText = originalText;
    submitBtn.disabled = false;

    if (result.success) {
        // Save it to the user's browser
        let userAddons = JSON.parse(localStorage.getItem('user_addons')) || [];

        // Prevent duplicates by checking the add-on ID
        if (!userAddons.some(a => a.id === result.manifest.id)) {
            userAddons.push({
                id: result.manifest.id,
                name: result.manifest.name,
                url: result.url,
                version: result.manifest.version
            });
            localStorage.setItem('user_addons', JSON.stringify(userAddons));

            alert(`Success! ${result.manifest.name} was added.`); // Swap for your toast later
            inputField.value = '';
            window.toggleAddonInput();
        } else {
            alert("You already have this add-on installed.");
        }
    } else {
        alert(`Error: ${result.error}`);
    }
};
window.toggleAddonInput = () => {
    const container = document.getElementById('addon-input-container');
    container.classList.toggle('hidden');
};

document.addEventListener('click', async (event) => {
    const playBtn = event.target.closest('#btn-torrent');

    if (!playBtn) return;
    if (playBtn.disabled) return;

    await handlePlayAction();
});