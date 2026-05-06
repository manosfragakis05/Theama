import { smartFetch, showToast, MY_PROXY } from './script.js';
import { parseMediaData } from './parseMedia.js';

//#region TMDB LOGIC
export const TMDB_KEY = 'ee7a32cee36ed0cd1f028f10c32fa0cf';

const activeMedia = { id: null, type: null, poster: null };

const rowState = {
    'trending-row': { page: 1, endpoint: 'trending/movie/week', loading: false, hasMore: true },
    'new-row': { page: 1, endpoint: 'movie/now_playing', loading: false, hasMore: true },
    'global-search-grid': { page: 1, query: '', loading: false, hasMore: true },
    'action-row': { page: 1, endpoint: 'discover/movie?with_genres=28', loading: false, hasMore: true },
    'comedy-row': { page: 1, endpoint: 'discover/movie?with_genres=35&without_genres=80,18,28,53', loading: false, hasMore: true },
    'thriller-row': { page: 1, endpoint: 'discover/movie?with_genres=53,96&without_genres=28,878', loading: false, hasMore: true }, 'anime-row': { page: 1, endpoint: 'discover/movie?with_genres=16&with_original_language=ja', loading: false, hasMore: true },
    'top-row': { page: 1, endpoint: 'movie/top_rated', loading: false, hasMore: true },
    'my-picks-row': { loading: false }
};

let isDragging = false;

// --- 🚨 GLOBAL DRAG STATE 🚨 ---
let isDown = false;
let activeSlider = null;
let startX;
let scrollLeft;
let globalDragInitialized = false;

// We attach the movement to the WINDOW, not the row. 
// This lets you drag your mouse way outside the box without it stopping!
function initGlobalDrag() {
    if (globalDragInitialized) return;

    window.addEventListener('mousemove', (e) => {
        if (!isDown || !activeSlider) return;

        e.preventDefault(); // Stops the weird "ghost image" dragging

        // Actively kill any accidental blue text highlighting on the screen
        if (window.getSelection) {
            window.getSelection().removeAllRanges();
        }

        const x = e.pageX - activeSlider.offsetLeft;
        const walk = (x - startX) * 2; // The * 2 makes it scroll slightly faster than you drag

        if (Math.abs(walk) > 5) isDragging = true;

        activeSlider.scrollLeft = scrollLeft - walk;
    });

    window.addEventListener('mouseup', () => {
        if (!isDown || !activeSlider) return;
        isDown = false;

        activeSlider.classList.remove('cursor-grabbing');
        // ❌ DELETED: activeSlider.classList.add('snap-x');

        document.body.classList.remove('select-none');

        setTimeout(() => {
            isDragging = false;
            activeSlider = null;
        }, 50);
    })

    globalDragInitialized = true;
}

export function enableDragScroll(containerId) {
    initGlobalDrag(); // Set up the window listeners (it only runs once)

    const slider = document.getElementById(containerId);
    if (!slider || slider.dataset.dragEnabled) return;

    slider.dataset.dragEnabled = "true";

    slider.addEventListener('mousedown', (e) => {
        isDown = true;
        isDragging = false;
        activeSlider = slider;

        slider.classList.add('cursor-grabbing');

        document.body.classList.add('select-none');

        startX = e.pageX - slider.offsetLeft;
        scrollLeft = slider.scrollLeft;
    });

    let isThrottled = false;

    slider.addEventListener('scroll', () => {
        // If we are currently throttled, ignore the scroll completely
        if (isThrottled) return;

        // Otherwise, lock the gate for 150 milliseconds
        isThrottled = true;
        setTimeout(() => { isThrottled = false; }, 150);

        // Now do the math!
        if (slider.scrollWidth - slider.scrollLeft - slider.clientWidth < 300) {
            // Only fetch if it's NOT the episode list
            if (containerId !== 'episode-list') {
                fetchNextPage(containerId);
            }
        }
    });
}

// LIST THE SHOWS
function appendCards(movies, containerId) {
    const row = document.getElementById(containerId);

    movies.forEach(movie => {
        if (movie.media_type === 'person' || !movie.poster_path) return;

        const detectedType = movie.media_type || (movie.name ? 'tv' : 'movie');
        const displayTitle = movie.title || movie.name;
        const displayDate = movie.release_date || movie.first_air_date || '';
        const year = displayDate.split('-')[0] || 'N/A';

        const card = document.createElement('div');
        card.className = "relative flex-none w-32 md:w-40 cursor-pointer transition-transform hover:scale-105 select-none";

        // Removed the Anime Badge logic and HTML injection completely
        card.innerHTML = `
            <img src="https://image.tmdb.org/t/p/w500${movie.poster_path}" 
                 class="rounded-lg shadow-lg w-full h-auto object-cover border border-slate-700/50 bg-slate-800 aspect-[2/3]" 
                 draggable="false" 
                 alt="${displayTitle}">
            <p class="text-xs text-slate-300 mt-2 truncate font-semibold pl-1">${displayTitle}</p>
            <p class="text-[10px] text-slate-500 pl-1">${year}</p>
        `;

        card.onclick = (e) => {
            if (isDragging) { e.preventDefault(); return; }

            // 🛤️ Send EVERYTHING to the unified router!
            openMasterDetail(movie.id, detectedType, displayTitle, movie.backdrop_path, movie.poster_path);
        };
        row.appendChild(card);
    });
}

async function fetchAndBuildRow(endpoint, containerId) {
    const row = document.getElementById(containerId);
    row.innerHTML = '<p class="text-slate-400 pl-2 text-sm mt-4">Loading...</p>';

    // --- THE SHUFFLE LOGIC ---
    let startPage = 1;
    const staticRows = ['trending-row', 'new-row'];
    if (!staticRows.includes(containerId)) {
        startPage = Math.floor(Math.random() * 3) + 1;
    }

    rowState[containerId].page = startPage;
    rowState[containerId].hasMore = true;
    rowState[containerId].loading = true;
    rowState[containerId].endpoint = endpoint;

    try {
        const separator = endpoint.includes('?') ? '&' : '?';
        // Use our startPage variable here!
        const url = `https://api.themoviedb.org/3/${endpoint}${separator}api_key=${TMDB_KEY}&language=en-US&page=${startPage}`;

        const response = await fetch(url);
        const data = await response.json();

        row.innerHTML = '';
        appendCards(data.results, containerId);

        if (data.page >= data.total_pages) rowState[containerId].hasMore = false;
    } catch (e) {
        row.innerHTML = '<p class="text-red-500 pl-2">Failed to load.</p>';
    } finally {
        rowState[containerId].loading = false;
    }
}

async function fetchNextPage(containerId) {
    const state = rowState[containerId];
    if (!state || state.loading || !state.hasMore) return;

    state.loading = true;
    state.page += 1;

    let url = '';
    if (containerId === 'global-search-grid') {
        url = `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_KEY}&query=${encodeURIComponent(state.query)}&page=${state.page}`;
    } else {
        // SMART URL BUILDER FOR PAGINATION
        const separator = state.endpoint.includes('?') ? '&' : '?';
        url = `https://api.themoviedb.org/3/${state.endpoint}${separator}api_key=${TMDB_KEY}&language=en-US&page=${state.page}`;
    }

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.results.length === 0 || state.page >= data.total_pages) {
            state.hasMore = false;
        }

        appendCards(data.results, containerId);
    } catch (e) {
        console.error("Pagination Error:", e);
    } finally {
        state.loading = false;
    }
}

// TMDB Search Engine (Page 1)
export async function searchTMDB(query) {
    const container = document.getElementById('global-search-results');
    const row = document.getElementById('global-search-grid');

    container.classList.remove('hidden');
    row.innerHTML = '<p class="text-slate-500 pl-2 text-sm mt-4">Searching the web...</p>';

    // Reset state for new searches
    rowState['global-search-grid'].query = query;
    rowState['global-search-grid'].page = 1;
    rowState['global-search-grid'].hasMore = true;
    rowState['global-search-grid'].loading = true;

    try {
        const url = `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}&page=1`;
        const response = await fetch(url);
        const data = await response.json();

        row.innerHTML = '';

        if (data.results.length === 0) {
            row.innerHTML = '<p class="text-slate-500 pl-2 text-sm mt-4">No results found.</p>';
            return;
        }

        appendCards(data.results, 'global-search-grid');
        if (data.page >= data.total_pages) rowState['global-search-grid'].hasMore = false;
    } catch (e) {
        row.innerHTML = '<p class="text-red-500 pl-2 text-sm mt-4">Search failed.</p>';
    } finally {
        rowState['global-search-grid'].loading = false;
    }
}

// App Booter
export async function loadDiscover() {
    // 1. Activate Drag Scrolling
    enableDragScroll('global-search-grid');
    enableDragScroll('episode-list');
    enableDragScroll('trending-row');
    enableDragScroll('new-row');
    enableDragScroll('top-row');
    enableDragScroll('action-row');
    enableDragScroll('comedy-row');
    enableDragScroll('thriller-row');
    enableDragScroll('anime-row');
    enableDragScroll('my-picks-row');

    // 2. Fetch the Data
    // 1. THE FRESH STUFF (Always loads Page 1 to stay current)
    fetchAndBuildRow('trending/all/week', 'trending-row'); // 'all' includes hot TV shows too!
    fetchAndBuildRow('movie/now_playing', 'new-row');

    // 2. THE SHUFFLED CLASSICS (These will use the random page logic below)
    fetchAndBuildRow('movie/top_rated', 'top-row');

    // Action Bangers: High votes guarantee you get Die Hard / Matrix / Dark Knight instead of direct-to-DVD junk
    fetchAndBuildRow('discover/movie?with_genres=28&sort_by=vote_count.desc&vote_average.gte=7&vote_count.gte=3000', 'action-row');

    // Comedy Legends: (Note: Comedies naturally score lower on TMDB, so 6.5 is the sweet spot)
    fetchAndBuildRow('discover/movie?with_genres=35&sort_by=vote_count.desc&vote_average.gte=6.5&vote_count.gte=2000', 'comedy-row');

    // Thriller Masterpieces: (without_genres=27,28 removes pure Horror and pure Action)
    fetchAndBuildRow('discover/movie?with_genres=53&without_genres=27,28&sort_by=vote_count.desc&vote_average.gte=7.5&vote_count.gte=1500', 'thriller-row');

    // Anime Peak: Switched to discover/tv so you actually get Attack on Titan, Death Note, etc.
    fetchAndBuildRow('discover/tv?with_genres=16&with_original_language=ja&sort_by=vote_count.desc&vote_count.gte=500', 'anime-row');

    loadMyPicks();
}

// MY PICKS
export async function loadMyPicks() {
    const containerId = 'my-picks-row';
    const row = document.getElementById(containerId);
    if (!row) return;

    row.innerHTML = '<p class="text-slate-500 pl-2">Assembling the legends...</p>';

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

        row.innerHTML = '';
        appendCards(movieData, containerId);

    } catch (e) {
        console.error("Vibe Check Failed:", e);
    }
}

//#region IN SHOW
// --- THE MASTER ROUTER ---
async function openMasterDetail(tmdbId, type, fallbackTitle, backdropPath, posterPath) {
    const view = document.getElementById('movie-detail-view');

    const backdrop = backdropPath ? `https://image.tmdb.org/t/p/original${backdropPath}` : '';
    const poster = posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : '';

    document.getElementById('detail-backdrop').style.backgroundImage = `url(${backdrop})`;
    document.getElementById('detail-poster').src = poster;
    document.getElementById('detail-title').innerText = fallbackTitle || "Loading...";
    document.getElementById('detail-overview').innerText = "Scanning databases...";
    document.getElementById('tv-controls').classList.add('hidden');

    view.classList.remove('translate-y-full');
    document.body.style.overflow = 'hidden';

    // 1. THE VIBE CHECK 🕵️‍♂️ (Hits Fribb)
    document.getElementById('detail-overview').innerText = "Checking Anime databases...";
    const animeIds = await getAnimeIds(tmdbId);

    // 2. IF IT IS ANIME: Pass the MAL ID to our new UI!
    if (animeIds && animeIds.malId) {
        console.log(`🌸 Routing to Anime UI (MAL ID: ${animeIds.malId})`);
        document.getElementById('detail-overview').innerText = "Translating episode data...";

        // 🚨 ADD THE `type` VARIABLE HERE!
        return openAnimeDetail(tmdbId, type, animeIds.malId, fallbackTitle, backdropPath, posterPath);
    }

    // 3. THE FALLBACK 🎬 (Western TV or Standard Movies)
    console.log(`🎬 Vibe Check: Routing to Standard TMDB UI`);
    document.getElementById('detail-overview').innerText = "Loading details...";
    activeMedia.malData = null; // Clear it out just in case
    return openMovieDetail(tmdbId, fallbackTitle, type);
}

//Open FULL file page(description and both playbacks)
export async function openMovieDetail(id, fallbackTitle, type = 'movie') {
    const view = document.getElementById('movie-detail-view');

    try {
        // 1. Fetch the correct endpoint based on our detected type
        const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}&language=en-US`;
        const res = await fetch(url);
        const data = await res.json();

        // 2. Map data (Handle both Movie and TV formats safely)
        const title = data.title || data.name;
        const date = data.release_date || data.first_air_date || '';
        const year = date ? date.split('-')[0] : 'N/A';
        const runtime = data.runtime ? `${data.runtime}m` : (data.episode_run_time && data.episode_run_time.length > 0 ? `${data.episode_run_time[0]}m` : 'N/A');
        const backdrop = data.backdrop_path ? `https://image.tmdb.org/t/p/original${data.backdrop_path}` : '';
        const poster = data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : '';

        activeMedia.id = id;
        activeMedia.type = type;
        activeMedia.poster = poster;

        // 3. Fill the HTML Info
        document.getElementById('detail-backdrop').style.backgroundImage = `url(${backdrop})`;
        document.getElementById('detail-poster').src = poster;
        document.getElementById('detail-title').innerText = title;
        document.getElementById('detail-year').innerText = year;
        document.getElementById('detail-runtime').innerText = runtime;
        document.getElementById('detail-rating').innerText = `★ ${data.vote_average?.toFixed(1)}`;
        document.getElementById('detail-overview').innerText = data.overview || "No description available.";

        // --- 🚨 THE CUSTOM PREMIUM TV CONTROLS LOGIC 🚨 ---
        const tvControls = document.getElementById('tv-controls');
        // We now use a hidden input for the season value
        const seasonSelectInput = document.getElementById('season-select');
        const customSeasonTrigger = document.getElementById('custom-season-trigger');
        const customSeasonText = document.getElementById('custom-season-text');
        const customSeasonMenu = document.getElementById('custom-season-menu');
        const seasonChevron = document.getElementById('season-chevron');

        const episodeList = document.getElementById('episode-list');
        const selectedEpisodeInput = document.getElementById('selected-episode');

        if (type === 'tv' && tvControls) {
            tvControls.classList.remove('hidden');
            tvControls.classList.add('flex');
            customSeasonMenu.innerHTML = '';
            customSeasonMenu.classList.add('hidden'); // Ensure closed on load
            seasonChevron.classList.remove('rotate-180');

            const validSeasons = data.seasons ? data.seasons.filter(s => s.season_number >= 0) : [];

            // The function that runs when you pick a new season
            const handleSeasonChange = async (sNum) => {
                // Update the UI
                seasonSelectInput.value = sNum;
                customSeasonText.innerText = sNum === 0 ? "OVA / Specials" : `Season ${sNum}`;
                customSeasonMenu.classList.add('hidden');
                seasonChevron.classList.remove('rotate-180');

                // Style the selected option in the list
                document.querySelectorAll('.season-option').forEach(opt => {
                    if (opt.dataset.season == sNum) {
                        opt.classList.add('bg-blue-600/20', 'text-blue-400', 'border-l-4', 'border-blue-500');
                        opt.classList.remove('text-white', 'border-l-4', 'border-transparent');
                    } else {
                        opt.classList.remove('bg-blue-600/20', 'text-blue-400', 'border-blue-500');
                        opt.classList.add('text-white', 'border-transparent');
                    }
                });

                // Fetch the episodes for this season
                const sUrl = `https://api.themoviedb.org/3/tv/${id}/season/${sNum}?api_key=${TMDB_KEY}`;
                const sRes = await fetch(sUrl);
                const sData = await sRes.json();

                episodeList.innerHTML = '';

                if (sData.episodes && sData.episodes.length > 0) {
                    selectedEpisodeInput.value = sData.episodes[0].episode_number;

                    sData.episodes.forEach((ep, index) => {
                        const imgPath = ep.still_path ? ep.still_path : data.backdrop_path;
                        const stillImage = imgPath ? `https://image.tmdb.org/t/p/w300${imgPath}` : '';

                        const isSelected = index === 0 ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 bg-slate-800/50';

                        const card = document.createElement('div');
                        card.className = `episode-card relative flex-none w-40 md:w-48 rounded-xl border-2 ${isSelected} overflow-hidden cursor-pointer transition-all hover:border-blue-400 shrink-0 group select-none`;

                        card.onclick = (e) => {
                            if (isDragging) {
                                e.preventDefault();
                                return;
                            }
                            selectedEpisodeInput.value = ep.episode_number;
                            document.querySelectorAll('.episode-card').forEach(c => {
                                c.classList.remove('border-blue-500', 'bg-blue-500/10');
                                c.classList.add('border-slate-700', 'bg-slate-800/50');
                            });
                            card.classList.remove('border-slate-700', 'bg-slate-800/50');
                            card.classList.add('border-blue-500', 'bg-blue-500/10');
                        };

                        card.innerHTML = `
                            <div class="relative aspect-video bg-slate-900 w-full">
                                <img src="${stillImage}" draggable="false" class="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" loading="lazy">
                                <div class="absolute bottom-1 right-1 bg-black/80 px-1.5 py-0.5 rounded text-[9px] text-white font-bold">
                                    ${ep.runtime ? ep.runtime + 'm' : ''}
                                </div>
                            </div>
                            <div class="p-2">
                                <p class="text-xs text-blue-400 font-bold tracking-wide">E${ep.episode_number}</p>
                                <p class="text-[10px] text-slate-300 truncate mt-0.5" title="${ep.name}">${ep.name}</p>
                            </div>
                        `;
                        episodeList.appendChild(card);
                    });
                } else {
                    // 🎬 WESTERN TV FALLBACK (Safe)
                    episodeList.innerHTML = '<p class="text-slate-500 p-4 text-sm">No episodes found for this season.</p>';
                }
            };

            // Populate the Custom Dropdown Menu
            validSeasons.forEach(s => {
                const btn = document.createElement('button');
                // These are your beautiful, styled options!
                btn.className = `season-option w-full text-left px-5 py-3 hover:bg-slate-700/50 transition border-l-4 border-transparent text-white font-bold text-sm border-b border-slate-700/30 last:border-b-0`;
                btn.dataset.season = s.season_number;
                btn.innerText = s.season_number === 0 ? "OVA / Specials" : `Season ${s.season_number}`;
                btn.onclick = () => handleSeasonChange(s.season_number);
                customSeasonMenu.appendChild(btn);
            });

            // Toggle Menu logic (Open/Close on click)
            customSeasonTrigger.onclick = () => {
                customSeasonMenu.classList.toggle('hidden');
                seasonChevron.classList.toggle('rotate-180');
            };

            // Trigger the first season to load automatically
            if (validSeasons.length > 0) {
                const defaultSeason = validSeasons.find(s => s.season_number === 1) || validSeasons[0];
                handleSeasonChange(defaultSeason.season_number);
            }
        } else if (tvControls) {
            tvControls.classList.add('hidden');
            tvControls.classList.remove('flex');
        }

        // 🧠 5. BIND THE PLAY BUTTONS
        const btnTorrent = document.getElementById('btn-torrent');
        const btnScraper = document.getElementById('btn-scraper');

        // Play (High Quality) Button
        btnTorrent.onclick = () => {
            startTorrentioStream(id, fallbackTitle, type);
        };

        // 4. Show the page!
        view.classList.remove('translate-y-full');
        document.body.style.overflow = 'hidden';

    } catch (e) {
        console.error("Detail View Error:", e);
        showToast(`Failed to load info. TMDB might be missing data for this ${type}.`, 'error');
    }
}

// CHECK IF ITS AN ANIME (FRIBB API)
export async function getAnimeIds(tmdbId) {
    const workerBaseUrl = MY_PROXY.replace('/?url=', '');

    // 1. Ask Fribb (The Gatekeeper)
    try {
        const mapUrl = `${workerBaseUrl}/map?tmdb=${tmdbId}`;
        const res = await fetch(mapUrl);

        if (res.ok) {
            const data = await res.json();
            if (data.mal_id || data.anilist_id) {
                console.log(`Fribb Hit. TMDB ${tmdbId} -> MAL ${data.mal_id}, ANILIST ${data.anilist_id}`);
                return { kitsuId: data.kitsu_id, malId: data.mal_id, anilistId: data.anilist_id};
            }
        }
        console.log("🎬 Not found in Anime DB (Likely Western Media).");
    } catch (e) {
        console.warn("🚨 Fribb Worker failed.", e);
    }

    return null;
}

// 🚨 ADD tmdbType to the function signature!
export async function openAnimeDetail(tmdbId, tmdbType, baseMalId, fallbackTitle, backdropPath, posterPath) {
    const tvControls = document.getElementById('tv-controls');
    const customSeasonMenu = document.getElementById('custom-season-menu');
    const episodeList = document.getElementById('episode-list');

    try {
        // 🚨 1. USE DYNAMIC TYPE FOR TMDB DATA 
        const tmdbUrl = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${TMDB_KEY}`;
        const tmdbRes = await fetch(tmdbUrl);
        const tmdbData = await tmdbRes.json();

        // (Keep the detail-year / detail-rating assignments the same)
        document.getElementById('detail-year').innerText = (tmdbData.first_air_date || tmdbData.release_date || '').split('-')[0] || 'N/A';
        document.getElementById('detail-rating').innerText = `★ ${tmdbData.vote_average?.toFixed(1)}`;
        document.getElementById('detail-overview').innerText = tmdbData.overview || "No description available.";

        activeMedia.id = tmdbId;
        activeMedia.type = tmdbType; // 🚨 DYNAMIC TYPE!
        activeMedia.malId = baseMalId;


        tvControls.classList.remove('hidden');
        tvControls.classList.add('flex');
        document.getElementById('custom-season-trigger').classList.remove('hidden');

        const handleSeasonChange = async (targetMalId, uiTitle, cleanTitle, optionElement, targetTmdbSeason = 1, totalEpisodes = 1, subtype = 'TV') => {
            activeMedia.subtype = subtype;
            
            // --- ANIZIP TRANSLATOR PROBE ---
            console.log(`\n🔍 --- TRANSLATING: ${cleanTitle} ---`);
            console.log(`Target MAL ID: ${targetMalId}`);
            
            try {
                // 🚨 The Holy Grail API for Anime Apps
                const zipUrl = `https://api.ani.zip/mappings?mal_id=${targetMalId}`;
                
                fetch(zipUrl).then(res => {
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    return res.json();
                }).then(zipData => {
                    
                    const mappings = zipData.mappings;
                    if (!mappings) {
                        console.log(`⚠️ WARNING: AniZip has no mappings for this ID.`);
                        return;
                    }

                    if (mappings.tmdb_id) {
                        console.log(`📺 TRANSLATED: TMDB ID [${mappings.tmdb_id}]`);
                    }
                    if (mappings.kitsu_id) {
                        console.log(`🦊 TRANSLATED: Kitsu ID [${mappings.kitsu_id}]`);
                    }
                    if (mappings.imdb_id) {
                        console.log(`🎬 TRANSLATED: IMDB ID [${mappings.imdb_id}]`);
                    }

                    console.log(`📦 Full AniZip Payload:`, zipData);
                    console.log(`--------------------------------------\n`);
                    
                }).catch(e => console.warn("AniZip API Fetch Failed.", e));
            } catch (e) {
                // Silent catch
            }
            // ------------------------------------------------

            document.getElementById('custom-season-text').innerHTML = uiTitle;
            customSeasonMenu.classList.add('hidden');
            document.getElementById('season-chevron').classList.remove('rotate-180');

            document.querySelectorAll('.season-option').forEach(opt => {
                opt.classList.remove('bg-fuchsia-600/20', 'text-fuchsia-400', 'border-fuchsia-500');
                opt.classList.add('text-white', 'border-transparent');
            });
            if (optionElement) {
                optionElement.classList.add('bg-fuchsia-600/20', 'text-fuchsia-400', 'border-fuchsia-500');
                optionElement.classList.remove('text-white', 'border-transparent');
            }

            episodeList.innerHTML = '<p class="text-fuchsia-400 font-bold p-4 animate-pulse">Loading Episodes...</p>';

            episodeList.innerHTML = '<p class="text-fuchsia-400 font-bold p-4 animate-pulse">Loading Episodes & Thumbnails...</p>';

            const allEpisodes = await fetchAllMalEpisodes(targetMalId);
            
            // 🧪 --- ANIZIP THUMBNAIL MATCHER ---
            let anizipEpisodes = {};
            try {
                const zipRes = await fetch(`https://api.ani.zip/mappings?mal_id=${targetMalId}`);
                if (zipRes.ok) {
                    const zipData = await zipRes.json();
                    if (zipData.episodes) anizipEpisodes = zipData.episodes;
                    
                    // 🧠 BONUS: Save the Kitsu ID into activeMedia right now so Torrentio can use it later!
                    if (zipData.mappings && zipData.mappings.kitsu_id) {
                        activeMedia.kitsuId = zipData.mappings.kitsu_id;
                    }
                }
            } catch (e) {
                console.warn("AniZip fetch failed, falling back to TMDB posters.", e);
            }
            // ------------------------------------

            episodeList.innerHTML = '';
            let fallbackBg = backdropPath ? `https://image.tmdb.org/t/p/w500${backdropPath}` : '';

            // 🎬 RENDER LOGIC
            if (allEpisodes.length > 0) {
                document.getElementById('selected-episode').value = allEpisodes[0].mal_id;

                allEpisodes.forEach((ep, index) => {
                    const epNumber = ep.mal_id;
                    const rawTitle = ep.title || `Episode ${epNumber}`;
                    const epTitle = rawTitle.replace(/<\/?[^>]+(>|$)/g, ""); 
                    
                    // 🖼️ THE UPGRADE: Use the AniZip Thumbnail if it exists!
                    let thumb = fallbackBg;
                    if (anizipEpisodes[epNumber] && anizipEpisodes[epNumber].image) {
                        thumb = anizipEpisodes[epNumber].image;
                    }
                    
                    const isSelected = index === 0 ? 'border-fuchsia-500 bg-fuchsia-500/10' : 'border-slate-700 bg-slate-800/50';

                    const card = document.createElement('div');
                    card.className = `episode-card relative flex-none w-40 md:w-48 rounded-xl border-2 ${isSelected} overflow-hidden cursor-pointer transition-all hover:border-fuchsia-400 shrink-0 group select-none`;

                    card.onclick = (e) => {
                        if (isDragging) { e.preventDefault(); return; }
                        document.getElementById('selected-episode').value = epNumber;

                        document.querySelectorAll('.episode-card').forEach(c => {
                            c.classList.remove('border-fuchsia-500', 'bg-fuchsia-500/10');
                            c.classList.add('border-slate-700', 'bg-slate-800/50');
                        });
                        card.classList.remove('border-slate-700', 'bg-slate-800/50');
                        card.classList.add('border-fuchsia-500', 'bg-fuchsia-500/10');
                    };

                    card.innerHTML = `
                        <div class="relative aspect-video bg-slate-900 w-full">
                            <img src="${thumb}" draggable="false" class="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" loading="lazy">
                        </div>
                        <div class="p-2">
                            <p class="text-xs text-fuchsia-400 font-bold tracking-wide">E${epNumber}</p>
                            <p class="text-[10px] text-slate-300 truncate mt-0.5" title="${epTitle}">${epTitle}</p>
                        </div>
                    `;
                    episodeList.appendChild(card);
                });
            } else {
                // 🎬 THE DYNAMIC MOVIE/OVA FALLBACK
                // We use the Spider's official episode count. (If MAL says 0/unknown, we draw at least 1).
                const cardCount = totalEpisodes > 0 ? totalEpisodes : 1;
                document.getElementById('selected-episode').value = 1; 

                for (let i = 1; i <= cardCount; i++) {
                    const isSelected = i === 1 ? 'border-fuchsia-500 bg-fuchsia-500/10' : 'border-slate-700 bg-slate-800/50';

                    const card = document.createElement('div');
                    card.className = `episode-card relative flex-none w-40 md:w-48 rounded-xl border-2 ${isSelected} overflow-hidden cursor-pointer transition-all hover:border-fuchsia-400 shrink-0 group select-none`;

                    card.onclick = (e) => {
                        if (isDragging) { e.preventDefault(); return; }
                        document.getElementById('selected-episode').value = i;
                        
                        document.querySelectorAll('.episode-card').forEach(c => {
                            c.classList.remove('border-fuchsia-500', 'bg-fuchsia-500/10');
                            c.classList.add('border-slate-700', 'bg-slate-800/50');
                        });
                        card.classList.remove('border-slate-700', 'bg-slate-800/50');
                        card.classList.add('border-fuchsia-500', 'bg-fuchsia-500/10');
                    };

                    card.innerHTML = `
                        <div class="relative aspect-video bg-slate-900 w-full">
                            <img src="${fallbackBg}" draggable="false" class="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" loading="lazy">
                        </div>
                        <div class="p-2">
                            <p class="text-xs text-fuchsia-400 font-bold tracking-wide">E${i}</p>
                            <p class="text-[10px] text-slate-300 truncate mt-0.5" title="${cleanTitle}">${cleanTitle}</p>
                        </div>
                    `;
                    episodeList.appendChild(card);
                }
            }

            activeMedia.malId = targetMalId;
            activeMedia.tmdbSeason = targetTmdbSeason;
        };

        // 🕸️ UI LOADING STATE PREPARATION
        const spinnerHtml = `
            <span class="text-[12px] text-fuchsia-400 ml-3 animate-pulse inline-flex items-center gap-1.5 align-middle">
                <svg class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                Mapping Universe...
            </span>`;

        // Put a spinner inside the dropdown menu so it doesn't look empty if clicked early!
        customSeasonMenu.innerHTML = `
            <div class="p-5 text-fuchsia-400 text-sm font-bold animate-pulse flex items-center gap-3">
                <svg class="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                Spider is crawling MAL...
            </div>`;
        customSeasonMenu.classList.add('hidden');

        // Load the initial fallback episode
        handleSeasonChange(baseMalId, fallbackTitle, fallbackTitle, null, 1, 1);

        // Re-inject the spinner into the button (because handleSeasonChange just wiped it out!)
        document.getElementById('custom-season-text').innerHTML = fallbackTitle + spinnerHtml;

        // 🧠 4. WAKE UP THE SPIDER
        buildGlobalMalGrid(baseMalId).then(franchiseTimeline => {

            // 🌟 3-TIER SMART SORTER
            franchiseTimeline.sort((a, b) => {
                const typeScore = { 'TV': 1, 'ONA': 1, 'Movie': 2, 'OVA': 3, 'Special': 3 };
                const scoreA = typeScore[a.subtype] || 4;
                const scoreB = typeScore[b.subtype] || 4;

                if (scoreA !== scoreB) return scoreA - scoreB;

                const getRelationScore = (rel) => {
                    if (rel === 'Base' || rel === 'Sequel' || rel === 'Prequel') return 1; 
                    if (rel === 'Spin-off' || rel === 'Side story' || rel === 'Alternative setting' || rel === 'Alternative version') return 2; 
                    return 3; 
                };
                
                const relScoreA = getRelationScore(a.relationTag);
                const relScoreB = getRelationScore(b.relationTag);

                if (relScoreA !== relScoreB) return relScoreA - relScoreB;

                const getSeasonNumber = (title) => {
                    const match = title.match(/season\s*(\d+)|(\d+)(?:st|nd|rd|th)\s*season|part\s*(\d+)/i);
                    return match ? parseInt(match[1] || match[2] || match[3]) : null;
                };

                const sNumA = getSeasonNumber(a.title);
                const sNumB = getSeasonNumber(b.title);

                if (sNumA !== null && sNumB !== null && sNumA !== sNumB) {
                    return sNumA - sNumB;
                }

                const dateA = new Date(a.startDate || '2099-01-01').getTime();
                const dateB = new Date(b.startDate || '2099-01-01').getTime();
                return dateA - dateB;
            });

            let availableSeasons = [];
            let tmdbSeasonCounter = 1;

            franchiseTimeline.forEach(item => {
                let badge = '';
                let tmdbSeason = 0;

                if (item.subtype === 'Movie') badge = ' 🎬 Movie';
                else if (item.subtype === 'OVA' || item.subtype === 'Special') badge = ' ⭐ Special';
                else if (item.subtype === 'TV' || item.subtype === 'ONA') {
                    badge = ' 📺 TV';
                    if (item.relationTag === 'Base' || item.relationTag === 'Sequel' || item.relationTag === 'Prequel') {
                        tmdbSeason = tmdbSeasonCounter++;
                    }
                }

                availableSeasons.push({
                    malId: item.malId,
                    cleanTitle: item.title, 
                    uiTitle: `${item.title} <span class="text-[10px] text-slate-500 ml-2">${badge}</span>`, 
                    tmdbSeason: tmdbSeason,
                    episodeCount: item.episodeCount,
                    subtype: item.subtype
                });
            });

            if (availableSeasons.length === 0) {
                availableSeasons.push({ malId: baseMalId, cleanTitle: fallbackTitle, uiTitle: fallbackTitle, tmdbSeason: 1, episodeCount: 1, subtype: 'TV' });
            }

            customSeasonMenu.innerHTML = '';

            availableSeasons.forEach(season => {
                const btn = document.createElement('button');
                btn.className = `season-option w-full text-left px-5 py-3 hover:bg-slate-700/50 transition border-l-4 border-transparent text-white font-bold text-sm border-b border-slate-700/30 last:border-b-0`;
                btn.innerHTML = season.uiTitle;

                // 🧠 AND PASS IT TO THE FUNCTION HERE!
                btn.onclick = () => handleSeasonChange(season.malId, season.uiTitle, season.cleanTitle, btn, season.tmdbSeason, season.episodeCount, season.subtype);
                customSeasonMenu.appendChild(btn);
            });

            const activeSeason = availableSeasons.find(s => s.malId === baseMalId);
            if (activeSeason) {
                // When the Spider finishes, this visually removes the spinner!
                document.getElementById('custom-season-text').innerHTML = activeSeason.uiTitle;
                activeMedia.tmdbSeason = activeSeason.tmdbSeason;

                const matchingBtn = Array.from(customSeasonMenu.children).find(btn => btn.innerHTML === activeSeason.uiTitle);
                if (matchingBtn) {
                    matchingBtn.classList.add('bg-fuchsia-600/20', 'text-fuchsia-400', 'border-fuchsia-500');
                    matchingBtn.classList.remove('text-white', 'border-transparent');
                }
            }
        }).catch(e => {
            console.error("Background Spider Failed:", e);
            document.getElementById('custom-season-text').innerHTML = fallbackTitle;
        });

        document.getElementById('custom-season-trigger').onclick = () => {
            customSeasonMenu.classList.toggle('hidden');
            document.getElementById('season-chevron').classList.toggle('rotate-180');
        };

        
        const btnTorrent = document.getElementById('btn-torrent');
        if (btnTorrent) {
            btnTorrent.onclick = null;
            btnTorrent.onclick = () => {
                // 🚨 PASS DYNAMIC TYPE TO TORRENTIO!
                startTorrentioStream(tmdbId, fallbackTitle, tmdbType);
            };
        }

    } catch (e) {
        console.error("Anime Detail Error:", e);
    }
}

// 🕷️ THE JIKAN SPIDER: Fetches the clean MAL franchise universe
export async function buildGlobalMalGrid(initialMalId) {
    console.log(`🕷️ Waking up the Jikan Spider... Starting at MAL ID: ${initialMalId}`);

    const todoQueue = [initialMalId];
    const visitedIds = new Set();
    const franchiseData = [];

    // 🧠 NEW: The Relationship Memory Map
    const relationMap = new Map();
    relationMap.set(initialMalId, 'Base'); // The show you clicked is always the Base

    while (todoQueue.length > 0) {
        const currentId = todoQueue.shift();

        if (visitedIds.has(currentId)) continue;
        visitedIds.add(currentId);

        console.log(`[SPIDER] Inspecting MAL ID: ${currentId}...`);

        try {
            const url = `https://api.jikan.moe/v4/anime/${currentId}/full`;
            const res = await fetch(url);

            await new Promise(resolve => setTimeout(resolve, 500)); // Rate limit protector

            if (!res.ok) {
                if (res.status === 429) {
                    todoQueue.unshift(currentId);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
                continue;
            }

            const json = await res.json();
            const data = json.data;
            if (!data) continue;

            // Save the data AND the relationship tag!
            franchiseData.push({
                malId: currentId,
                title: data.title_english || data.title,
                startDate: data.aired?.from,
                subtype: data.type,
                episodeCount: data.episodes || 0,
                relationTag: relationMap.get(currentId) || 'Unknown' // 🧠 Save the tag!
            });

            if (data.relations) {
                data.relations.forEach(rel => {
                    // 🛡️ THE SMART BOUNCER: Ban Recaps and Profiles. Let "Other" (DVD Extras) through.
                    if (rel.relation === "Summary" || rel.relation === "Character") return;

                    rel.entry.forEach(entry => {
                        if (entry.type === "anime") {
                            if (!relationMap.has(entry.mal_id)) {
                                relationMap.set(entry.mal_id, rel.relation);
                            }

                            if (!visitedIds.has(entry.mal_id) && !todoQueue.includes(entry.mal_id)) {
                                todoQueue.push(entry.mal_id);
                            }
                        }
                    });
                });
            }
        } catch (e) {
            console.warn(`[SPIDER] Failed to fetch MAL ID: ${currentId}`, e);
        }
    }

    franchiseData.sort((a, b) => {
        const dateA = new Date(a.startDate || '2099-01-01');
        const dateB = new Date(b.startDate || '2099-01-01');
        return dateA - dateB;
    });

    return franchiseData;
}

// 📺 FETCH MAL EPISODES
async function fetchAllMalEpisodes(malId) {
    let allEpisodes = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        const url = `https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`;
        const res = await fetch(url);

        await new Promise(resolve => setTimeout(resolve, 350)); // Rate limit protector

        if (!res.ok) {
            if (res.status === 429) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
            break;
        }

        const epData = await res.json();

        if (epData.data && epData.data.length > 0) {
            allEpisodes = allEpisodes.concat(epData.data);
            if (epData.pagination && epData.pagination.has_next_page) {
                page++;
            } else {
                hasMore = false;
            }
        } else {
            hasMore = false;
        }
    }
    return allEpisodes;
}


// Global close function
window.closeMovieDetail = () => {
    document.getElementById('movie-detail-view').classList.add('translate-y-full');
    document.body.style.overflow = ''; // Restore scrolling

    // 🧹 WIPE THE SLATE CLEAN (Prevents UI ghosting on the next click)
    const episodeList = document.getElementById('episode-list');
    if (episodeList) episodeList.innerHTML = '';

    const customSeasonMenu = document.getElementById('custom-season-menu');
    if (customSeasonMenu) customSeasonMenu.innerHTML = '';

    const customSeasonText = document.getElementById('custom-season-text');
    if (customSeasonText) customSeasonText.innerText = 'Loading...';
};

//#region Filter

// SMART LANGUAGE EXTRACTOR
function extractLanguageData(pttLanguages, rawTitle) {
    let flags = new Set();
    let textLangs = new Set();
    let isMulti = false;
    const lowerTitle = rawTitle.toLowerCase();

    // 1. Check for "Multi" or "Dual" Audio tags
    if (lowerTitle.match(/multi.?audio|dual.?audio|multi.?subs|\bmulti\b/)) {
        isMulti = true;
    }

    // 2. Extract Emojis directly from Torrentio's string
    const emojiMatch = rawTitle.match(/(🇬🇧|🇺🇸|🇫🇷|🇲🇽|🇪🇸|🇮🇹|🇷🇺|🇮🇳|🇵🇹|🇩🇪|🇯🇵|🇰🇷)/g);
    if (emojiMatch) {
        // Normalize US flags to UK flags so we don't get duplicates for English
        emojiMatch.forEach(flag => flags.add(flag === '🇺🇸' ? '🇬🇧' : flag));
    }

    // 3. Translate PTT's text array into Emojis!
    const flagDictionary = {
        english: 'EN', eng: 'EN', en: 'EN',
        french: '🇫🇷', fre: '🇫🇷', fra: '🇫🇷',
        spanish: '🇪🇸', spa: '🇪🇸', esp: '🇪🇸',
        italian: '🇮🇹', ita: '🇮🇹',
        russian: '🇷🇺', rus: '🇷🇺',
        german: '🇩🇪', ger: '🇩🇪',
        portuguese: '🇵🇹', por: '🇵🇹',
        japanese: '🇯🇵', jpn: '🇯🇵',
        korean: '🇰🇷', kor: '🇰🇷',
        hindi: '🇮🇳', hin: '🇮🇳'
    };

    if (Array.isArray(pttLanguages)) {
        pttLanguages.forEach(lang => {
            const key = lang.toLowerCase();
            if (flagDictionary[key]) {
                flags.add(flagDictionary[key]);
            } else {
                // If we don't have a flag for it, just capitalize the word (e.g., "Arabic")
                textLangs.add(lang.charAt(0).toUpperCase() + lang.slice(1));
            }
        });
    }

    // 4. Fallback: If nothing was found, but it says "ENG" in the title
    if (flags.size === 0 && textLangs.size === 0 && lowerTitle.match(/\beng\b|\ben\b/)) {
        flags.add('🇬🇧');
    }

    // 5. Build the Beautiful UI String
    let uiString = Array.from(flags).join(' ');
    if (textLangs.size > 0) {
        uiString += (uiString ? ' • ' : '') + Array.from(textLangs).join(', ');
    }

    // Add a highly visible MULTI badge if applicable
    if (isMulti) {
        uiString += (uiString ? ' ' : '') + `<span class="text-[9px] bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded ml-1 border border-blue-500/30 font-bold uppercase tracking-wider">Multi-Audio</span>`;
    }

    // 6. Calculate the "Diversity Score" for the Sorter
    // +1 point per language, +3 bonus points if it's explicitly Multi-Audio
    const score = flags.size + textLangs.size + (isMulti ? 3 : 0);

    return {
        uiText: uiString.trim(),
        score: score,
        isMultiDub: isMulti
    };
}

function filterAndSortStreams(streams) {
    // 1️⃣ THE VIP LIST & AUDIO TIERS
    const vipGroups = ['tgx', 'qxr', 'rarbg', 'flux', 'fgt', 'rartv', '1337x', 'torrentgalaxy'];
    const losslessAudio = ['truehd', 'atmos', 'dts-hd', 'dts:x', 'flac'];
    const premiumAudio = ['dd+', 'e-ac3', 'ac3', 'dts', 'dolby digital'];

    // 2️⃣ PARSE AND TAG EVERYTHING
    let parsedStreams = streams.map(stream => {
        const fullTitle = (stream.title || "").toLowerCase();
        const rawFileName = (stream.title || "").split('\n')[0];

        // Feed it to PTT
        const parsed = parseMediaData(rawFileName);
        const cleanTitle = parsed.title || "";

        // Seeders & Size
        const seederMatch = fullTitle.match(/👤\s*(\d+)/);
        const seeders = seederMatch ? parseInt(seederMatch[1]) : 0;

        const sizeMatch = fullTitle.match(/💾\s*([\d.]+)\s*([a-zA-Z]+)/);
        const sizeText = sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2]}` : "Unknown";

        // Tracker / Source
        const siteMatch = fullTitle.match(/⚙️\s*([^\n]+)/);
        const trackerName = siteMatch ? siteMatch[1].trim() : "Direct Source";

        // Debrid Cache Detection (Torrentio tags cached links in the stream name)
        const streamName = (stream.name || "").toLowerCase();
        const isCached = streamName.includes('torbox+') || streamName.includes('rd+') || fullTitle.includes('cached');

        // --- SMART SEASON PACK DETECTOR ---
        let seasonText = null;

        // 1. Look for explicit ranges (e.g., "S01-S05", "Seasons 1-4")
        const rangeMatch = fullTitle.match(/(?:s|season[s]?\s*)0*(\d{1,2})\s*-\s*(?:s|season[s]?\s*)?0*(\d{1,2})/i);

        if (rangeMatch) {
            seasonText = `SEASONS ${rangeMatch[1]}-${rangeMatch[2]}`;
        } else if (fullTitle.includes('complete series') || fullTitle.includes('the complete')) {
            seasonText = "COMPLETE SERIES";
        } else if (Array.isArray(parsed.season) && parsed.season.length > 1) {
            // PTT found an array of seasons
            const min = Math.min(...parsed.season);
            const max = Math.max(...parsed.season);
            seasonText = `SEASONS ${min}-${max}`;
        } else if ((fullTitle.includes('season pack') || fullTitle.includes('complete season') || parsed.isComplete) && parsed.season && !Array.isArray(parsed.season)) {
            seasonText = `SEASON ${parsed.season} PACK`;
        } else if (fullTitle.includes('season pack')) {
            seasonText = "SEASON PACK"; // Fallback
        }

        const isSeasonPack = seasonText !== null;

        // VIP Release Group Detection
        const isVIP = vipGroups.some(group => fullTitle.includes(group));

        // --- THE NEW AUDIO HIERARCHY ---
        let audioScore = 0;
        let audioText = "AAC / Standard";
        let audioColor = "text-emerald-400"; // Green for safe/standard

        const metaAudio = (parsed.audio || fullTitle).toLowerCase();

        if (losslessAudio.some(a => metaAudio.includes(a))) {
            audioScore = 100;
            audioText = "Lossless Spatial (Atmos/TrueHD)";
            audioColor = "text-fuchsia-400"; // Premium glowing purple
        } else if (premiumAudio.some(a => metaAudio.includes(a))) {
            audioScore = 50;
            audioText = "Premium Surround (Dolby/DTS)";
            audioColor = "text-blue-400"; // Solid Blue
        }

        // Languages
        const langData = extractLanguageData(parsed.languages, fullTitle);

        // Video Badges
        let videoCodec = (parsed.codec || "HD").toUpperCase();
        if (videoCodec === 'H264' || videoCodec === 'X264') videoCodec = 'x264';
        if (videoCodec === 'H265' || videoCodec === 'X265' || videoCodec === 'HEVC') videoCodec = 'HEVC/x265';

        let badgeText = parsed.quality ? `${videoCodec} • ${parsed.quality}` : videoCodec;
        if (isSeasonPack) badgeText = `📦 ${seasonText} • ${badgeText}`;

        return {
            ...stream, meta: parsed, seeders, fullTitle, sizeText,
            isCached, isSeasonPack, isVIP, audioScore,
            uiTracker: trackerName,
            uiLangs: langData.uiText,
            uiBadge: badgeText,
            uiAudioText: audioText, uiAudioColor: audioColor,

            // 🧠 THE MASTER DEBRID SCORE
            // Cached links get +10,000 to guarantee they beat uncached links
            // VIP gets +500, Season Packs get +1000, Audio gets +100/50, Seeders act as a tie-breaker
            totalScore: (isCached ? 10000 : 0) +
                (isSeasonPack ? 1000 : 0) +
                (isVIP ? 500 : 0) +
                audioScore +
                (seeders > 100 ? 100 : seeders) // Cap seeders so they don't overpower quality
        };
    });

    // 3️⃣ THE INCINERATOR (The Safety Net)
    let validStreams = parsedStreams.filter(s => {
        const noCams = s.meta.quality !== 'Cam' && s.meta.quality !== 'Telesync';
        const noHardcoded = s.meta.hardcoded !== true;
        // Keep it if it has 5+ seeders OR if TorBox already has it cached!
        const isSafe = s.seeders >= 5 || s.isCached;

        return isSafe && noCams && noHardcoded;
    });

    // 4️⃣ THE BIG SORT (Highest Score Wins)
    validStreams.sort((a, b) => b.totalScore - a.totalScore);

    // 5️⃣ THE 3-TIER CATEGORIZATION
    const all4K = validStreams.filter(s => s.meta.resolution === '4k' || s.meta.resolution === '2160p' || s.fullTitle.includes('4k'));
    const all1080p = validStreams.filter(s => s.meta.resolution === '1080p' || (s.fullTitle.includes('1080p') && !s.fullTitle.includes('4k')));

    // The "Everything Else" Tier (720p, SD, or un-tagged older files)
    const allStandard = validStreams.filter(s => !all4K.includes(s) && !all1080p.includes(s));

    // 🎰 6️⃣ THE 3-SLOT PICKER (Grabs the Top 3 for the UI)
    const top4K = all4K.slice(0, 3);
    const top1080p = all1080p.slice(0, 3);
    const topStandard = allStandard.slice(0, 3);

    // 7️⃣ THE LEFTOVERS (For the "Load More" button)
    const more4K = all4K.slice(3);
    const more1080p = all1080p.slice(3);
    const moreStandard = allStandard.slice(3);

    return { top4K, top1080p, topStandard, more4K, more1080p, moreStandard };
}

// --- MODAL UI BUILDER ---
function showStreamPicker(categorizedStreams, movieTitle) {
    const modal = document.getElementById('stream-picker-modal');
    const list = document.getElementById('stream-picker-list');

    document.getElementById('stream-picker-title').innerText = `Select Stream: ${movieTitle}`;
    list.innerHTML = '';
    modal.classList.remove('hidden');

    // Container for 4K
    const container4K = document.createElement('div');
    container4K.id = 'stream-container-4k';
    container4K.className = 'flex flex-col gap-3 mb-6';

    if (categorizedStreams.top4K.length > 0) {
        const header4K = document.createElement('div');
        header4K.className = "text-amber-400 font-bold text-xs mb-2 mt-1 uppercase tracking-wider flex items-center gap-2";
        header4K.innerHTML = `<span>📺 4K UHD Cinematic</span> <span class="h-[1px] flex-1 bg-amber-400/20"></span>`;
        list.appendChild(header4K);
        list.appendChild(container4K);
        renderStreamCategory('stream-container-4k', categorizedStreams.top4K, categorizedStreams.more4K, movieTitle);
    }

    // Container for 1080p
    const container1080p = document.createElement('div');
    container1080p.id = 'stream-container-1080p';
    container1080p.className = 'flex flex-col gap-3 mb-6';

    if (categorizedStreams.top1080p.length > 0) {
        const header1080p = document.createElement('div');
        header1080p.className = "text-blue-400 font-bold text-xs mb-2 mt-4 uppercase tracking-wider flex items-center gap-2";
        header1080p.innerHTML = `<span>💻 1080p HD (Best for Wi-Fi)</span> <span class="h-[1px] flex-1 bg-blue-400/20"></span>`;
        list.appendChild(header1080p);
        list.appendChild(container1080p);
        renderStreamCategory('stream-container-1080p', categorizedStreams.top1080p, categorizedStreams.more1080p, movieTitle);
    }

    // Container for Standard / Legacy (720p / SD)
    const containerStandard = document.createElement('div');
    containerStandard.id = 'stream-container-standard';
    containerStandard.className = 'flex flex-col gap-3 mb-6';

    // Only show this category if there are standard streams, OR if 4K and 1080p are completely empty
    if (categorizedStreams.topStandard.length > 0) {
        const headerStandard = document.createElement('div');
        headerStandard.className = "text-emerald-400 font-bold text-xs mb-2 mt-4 uppercase tracking-wider flex items-center gap-2";
        headerStandard.innerHTML = `<span>📼 Standard / Legacy (720p & SD)</span> <span class="h-[1px] flex-1 bg-emerald-400/20"></span>`;
        list.appendChild(headerStandard);
        list.appendChild(containerStandard);
        renderStreamCategory('stream-container-standard', categorizedStreams.topStandard, categorizedStreams.moreStandard, movieTitle);
    }

    if (categorizedStreams.top4K.length === 0 && categorizedStreams.top1080p.length === 0 && categorizedStreams.topStandard.length === 0) {
        list.innerHTML = `<div class="p-4 text-center text-red-400 font-bold">No safe streams found.</div>`;
    }

    if (categorizedStreams.top4K.length === 0 && categorizedStreams.top1080p.length === 0) {
        list.innerHTML = `<div class="p-4 text-center text-red-400 font-bold">No cached 4K or 1080p streams found.</div>`;
    }
}

// --- RENDER HELPER WITH "LOAD MORE" ---
function renderStreamCategory(containerId, topStreams, moreStreams, movieTitle) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    // 1. Render Top 3
    topStreams.forEach((stream, index) => {
        const isRecommended = index === 0;
        container.appendChild(createStreamCard(stream, movieTitle, true, index === 0));
    });

    // 2. Build Load More
    if (moreStreams.length > 0) {
        const moreContainer = document.createElement('div');
        moreContainer.className = "hidden flex-col gap-2 mt-2 w-full";

        moreStreams.forEach(stream => {
            moreContainer.appendChild(createStreamCard(stream, movieTitle, false, false));
        });

        const loadBtn = document.createElement('button');
        loadBtn.className = "w-full py-2.5 mt-2 bg-slate-800/80 text-slate-400 border border-slate-700 rounded-xl text-xs font-bold tracking-wider uppercase hover:bg-slate-700 hover:text-white transition-all";
        loadBtn.innerHTML = `⬇ Load ${moreStreams.length} More (Sorted by Seeders)`;

        loadBtn.onclick = () => {
            moreContainer.classList.remove('hidden');
            moreContainer.classList.add('flex');
            loadBtn.remove();
        };

        container.appendChild(loadBtn);
        container.appendChild(moreContainer);
    }
}

// HELPER FUNCTION TO BUILD UI CARDS
function createStreamCard(stream, movieTitle, isPremium, isRecommended) {
    // 1. Fallbacks for Seeders/Size
    const seeders = stream.seeders !== undefined ? stream.seeders : "0";
    const size = stream.sizeText || "Unknown Size";

    // 2. HASH EXTRACTION
    let trueHash = stream.infoHash;
    if (!trueHash && stream.url) {
        const hashMatch = stream.url.match(/\/([a-fA-F0-9]{40})\//);
        if (hashMatch) trueHash = hashMatch[1];
    }
    const safeTitle = encodeURIComponent(movieTitle.replace(/\s+/g, '.'));
    const magnetLink = `magnet:?xt=urn:btih:${trueHash}&dn=${safeTitle}`;

    // --- STYLING ---
    const baseClasses = "w-full text-left border p-4 rounded-xl transition-all flex flex-col gap-2 group shadow-lg";
    let colorClasses = isPremium ? "bg-slate-800/80 hover:bg-slate-700 border-slate-600" : "bg-slate-900/50 hover:bg-slate-800 border-slate-800 opacity-80 hover:opacity-100";
    let buttonHover = "group-hover:bg-blue-600";

    if (isRecommended) {
        // Keeps the emerald green glow, but drops the text badge!
        colorClasses = "bg-emerald-900/20 hover:bg-emerald-800/30 border-emerald-500/50";
        buttonHover = "group-hover:bg-emerald-600";
    }

    const customTitleHTML = `
        <div class="flex items-center flex-wrap gap-2">
            <span class="font-bold ${isPremium ? 'text-blue-300' : 'text-slate-400'} text-sm">${stream.uiTracker}</span>
            ${stream.uiLangs ? `<span class="text-sm drop-shadow-md">${stream.uiLangs}</span>` : ''}
            <span class="bg-slate-700/50 text-slate-300 text-[9px] px-1.5 py-0.5 rounded uppercase font-bold border border-slate-600">${stream.uiBadge}</span>
        </div>
    `;

    const btn = document.createElement('button');
    btn.className = `${baseClasses} ${colorClasses}`;

    btn.innerHTML = `
        <div class="flex justify-between items-start w-full gap-2">
            ${customTitleHTML}
            <span class="text-[10px] whitespace-nowrap font-bold uppercase tracking-wider bg-slate-900 px-3 py-1.5 rounded-lg text-slate-300 ${buttonHover} group-hover:text-white transition-colors mt-0.5">Send to TorBox</span>
        </div>
        <span class="text-xs text-slate-300 font-medium flex items-center gap-2 mt-1">
            👤 ${seeders} • ${size} • 
            <span class="font-bold ${stream.uiAudioColor}">🔊 ${stream.uiAudioText}</span>
        </span>
    `;

    btn.onclick = () => {
        closeStreamPicker();
        sendMagnetToTorbox(magnetLink, movieTitle);
    };

    return btn;
}


//#region Torrent Link
export async function startTorrentioStream(id, movieTitle, type) {
    const tbKey = localStorage.getItem('tb_api_key');
    if (!tbKey) return showToast('Please connect your TorBox API in the settings first');

    const btn = document.getElementById('btn-torrent');
    const originalText = btn.innerHTML;
    btn.innerHTML = '⏳ Searching Torrentio...';
    btn.disabled = true;

    try {
        const epInput = document.getElementById('selected-episode');
        const e = (type === 'tv' && epInput) ? epInput.value : 1;

        let streamData = { streams: [] };
        let typePath = '';
        let torrentioUrl = '';
        let kitsuFailed = false;

        // 🌸 ==========================================
        // 🌸 TRACK A: THE ANIME ROUTE (Kitsu Direct)
        // ==========================================

        if (activeMedia.kitsuId) {
            
            // 🚨 FIX 2: Check BOTH MAL's subtype AND TMDB's base type!
            if (activeMedia.subtype === 'Movie' || type === 'movie') {
                typePath = `movie/kitsu:${activeMedia.kitsuId}`;
                console.log(`🎬 [ANIME MOVIE MODE] Fetching Kitsu Route: ${typePath}`);
            } else {
                typePath = `anime/kitsu:${activeMedia.kitsuId}:${e}`;
                console.log(`🌸 [ANIME TV MODE] Fetching Kitsu Route: ${typePath}`);
            }
            
            torrentioUrl = `https://torrentio.strem.fun/torbox=${tbKey}|debridoptions=nodownloadlinks/stream/${typePath}.json`;

            try {
                const streamRes = await fetch(torrentioUrl);
                if (streamRes.ok) {
                    const temp = await streamRes.json();
                    if (temp.streams && temp.streams.length > 0) {
                        streamData = temp;
                    } else kitsuFailed = true; // 0 Streams found!
                } else kitsuFailed = true; // 500 Error crashed!
            } catch (err) {
                kitsuFailed = true;
            }
        } else {
            kitsuFailed = true; // No Kitsu ID available
        }

        // 🎬 ==========================================
        // 🎬 TRACK B: THE WESTERN FALLBACK (IMDB)
        // ==========================================
        if (kitsuFailed) {
            console.log(`🚑 Kitsu failed or returned 0 streams. Falling back to IMDB route...`);
            
            const idUrl = `https://api.themoviedb.org/3/${type}/${id}/external_ids?api_key=${TMDB_KEY}`;
            const idRes = await fetch(idUrl);
            const idData = await idRes.json();
            const imdbId = idData.imdb_id;

            if (!imdbId) throw new Error("No IMDB ID found for streaming.");

            const seasonInput = document.getElementById('season-select');
            
            // 🧠 SMART FALLBACK: If we are falling back on an Anime TV show, use the Spider's season math!
            let s = seasonInput ? seasonInput.value : 1;
            if (activeMedia.type === 'tv' && activeMedia.tmdbSeason) {
                s = activeMedia.tmdbSeason; 
            }

            // If it's technically a movie on MAL, force the Western movie route!
            if (activeMedia.subtype === 'Movie' || type === 'movie') {
                typePath = `movie/${imdbId}`;
            } else {
                typePath = `series/${imdbId}:${s}:${e}`;
            }
            
            torrentioUrl = `https://torrentio.strem.fun/torbox=${tbKey}|debridoptions=nodownloadlinks/stream/${typePath}.json`;

            console.log(`🎬 [WESTERN MODE] Fetching IMDB Route: ${typePath}`);

            const streamRes = await fetch(torrentioUrl);
            if (streamRes.ok) {
                streamData = await streamRes.json();
            } else {
                console.warn(`⚠️ Torrentio Server Error (${streamRes.status}) on IMDB route.`);
            }
        }

        // --- FINAL VALIDATION ---
        if (!streamData.streams || streamData.streams.length === 0) {
            throw new Error("No streams found on Torrentio for this media.");
        }

        const categorizedStreams = filterAndSortStreams(streamData.streams);

        if (categorizedStreams.top4K.length === 0 && categorizedStreams.top1080p.length === 0 && categorizedStreams.topStandard.length === 0) {
            throw new Error("Found streams, but none were safe to play.");
        }

        showStreamPicker(categorizedStreams, movieTitle);

    } catch (e) {
        console.error(e);
        showToast(e.message, 'error');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

window.closeStreamPicker = () => {
    document.getElementById('stream-picker-modal').classList.add('hidden');
};

// Add a link to users library  
async function sendMagnetToTorbox(magnetLink, movieTitle) {
    const tbKey = localStorage.getItem('tb_api_key');
    if (!tbKey) return;

    const btn = document.getElementById('btn-torrent');
    const originalText = btn.innerHTML;
    btn.innerHTML = '⚡ Adding to Cloud...';
    btn.disabled = true;

    try {
        // 🧠 THE METADATA VAULT
        const hashMatch = magnetLink.match(/urn:btih:([a-zA-Z0-9]+)/i);

        // Read directly from the activeMedia
        if (hashMatch && activeMedia.id) {
            const hash = hashMatch[1].toLowerCase();
            let vault = JSON.parse(localStorage.getItem('tmdb_vault') || '{}');

            vault[hash] = {
                id: activeMedia.id,
                type: activeMedia.type,
                poster: activeMedia.poster,
                kitsuId: activeMedia.kitsuId || null
            };
            localStorage.setItem('tmdb_vault', JSON.stringify(vault));
            console.log(`📦 Saved [${hash}] -> ${movieTitle} to Local Vault!`);
        }

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
            showToast(`Added "${movieTitle}" to your Library!`, 'success');

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
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

//#region IFRAMES
const IFRAME_PROVIDERS = [
    // Your current favorite
    { name: "Server 1 (VidSrc Net)", movie: (id) => `https://vidsrc.net/embed/movie?tmdb=${id}`, tv: (id, s, e) => `https://vidsrc.net/embed/tv?tmdb=${id}&season=${s}&episode=${e}` },

    // Solid Alternative - uses different sources
    { name: "Server 2 (VidSrc XYZ)", movie: (id) => `https://vidsrc.xyz/embed/movie/${id}`, tv: (id, s, e) => `https://vidsrc.xyz/embed/tv/${id}/${s}/${e}` },

    // Completely different database (Good for "Video Not Found" errors)
    { name: "Server 3 (SuperEmbed)", movie: (id) => `https://multiembed.mov/?video_id=${id}&tmdb=1`, tv: (id, s, e) => `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}` }
];

// --- SCRAPER IFRAME CONTROLS ---

window.openIframePlayer = (tmdbId, title, type, season, episode) => {
    // 1. Set the Title
    document.getElementById('iframe-title').innerText = `Playing: ${title}`;
    const iframe = document.getElementById('scraper-iframe');
    const injectionPoint = document.getElementById('iframe-header-injection-point');

    // 2. Clear out the dropdown from the last movie you watched
    injectionPoint.innerHTML = '';

    // 3. Create the new Dropdown Menu
    const selectBox = document.createElement('select');
    selectBox.className = "bg-slate-800 text-white border border-slate-600 rounded-lg p-1.5 outline-none text-sm cursor-pointer shadow-lg max-w-[130px] md:max-w-none truncate";

    // 4. Fill the dropdown with our servers
    IFRAME_PROVIDERS.forEach((provider, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.text = provider.name;
        selectBox.appendChild(option);
    });

    // 5. Instantly swap servers when you pick a new one
    selectBox.onchange = (e) => {
        const provider = IFRAME_PROVIDERS[e.target.value];
        iframe.src = type === 'tv' ? provider.tv(tmdbId, season, episode) : provider.movie(tmdbId);
    };

    // 6. Put the dropdown next to the close button
    injectionPoint.appendChild(selectBox);

    // 7. Load Server 1 (VidLink) by default
    const defaultProvider = IFRAME_PROVIDERS[0];
    iframe.src = type === 'tv' ? defaultProvider.tv(tmdbId, season, episode) : defaultProvider.movie(tmdbId);

    // 8. Show the theater and lock scrolling
    document.getElementById('iframe-player-view').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
};

window.closeIframePlayer = () => {
    document.getElementById('scraper-iframe').src = '';
    document.getElementById('iframe-player-view').classList.add('hidden');
    document.body.style.overflow = '';
};