import { showToast, MY_PROXY, TMDB_KEY } from './services/config.js';
import { loadAllAddonsParallel } from './user-addons/scrapers.js';
import { showStreamPicker } from './user-addons/scraper-renderer.js';

//#region State and Data
export const mediaStore = (() => {
    let state = { id: null, title: null, type: null };
    return {
        get: () => ({ ...state }),
        set: (newData) => { state = { ...state, ...newData }; },
        clear: () => { state = { id: null, title: null, type: null }; }
    };
})();

export async function openMasterDetail(mediaObject) {

    // Render UI
    renderMasterDetailView(mediaObject);

    const seasonsContainer = document.getElementById('media-seasons');
    if (mediaObject.type === 'series' || mediaObject.type === 'tv') {
        seasonsContainer.classList.remove("hidden");

        // --- INJECT LOADING STATE ---
        const dropdownBtn = document.getElementById('season-dropdown-btn');
        const dropdownText = document.getElementById('season-dropdown-text');
        const listContainer = document.getElementById('episode-list-container');

        if (dropdownBtn) dropdownBtn.disabled = true; // Prevent clicks while loading
        if (dropdownText) dropdownText.textContent = "Loading episodes...";

        if (listContainer) {
            // Tailwind spinner and pulsing text
            listContainer.innerHTML = `
                <div class="flex flex-col items-center justify-center py-16 px-4 col-span-full">
                    <svg class="animate-spin h-10 w-10 text-blue-500 mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <p class="text-slate-400 font-medium animate-pulse">Fetching episodes...</p>
                </div>
            `;
        }
    } else {
        seasonsContainer.classList.add("hidden");
    }

    // Fetch missing data
    checkFullData(mediaObject);
}

async function checkFullData(mediaObject) {
    if (!mediaObject || !mediaObject.id || !mediaObject.type) return;

    if (mediaObject.addonName == "customTMDB" || !mediaObject.baseUrl) {
        try {
            const url = `https://api.themoviedb.org/3/${mediaObject.type}/${mediaObject.id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits,external_ids`;
            const res = await fetch(url);
            if (!res.ok) throw new Error("TMDB item fetch failed");

            const detailedData = await res.json();

            // Format Data Safely
            const tmdbGenre = detailedData.genres?.[0]?.name || '';
            const tmdbRuntime = detailedData.runtime ? `${detailedData.runtime}m` : '';
            const tmdbCast = (detailedData.credits?.cast || []).slice(0, 5).map(a => a.name).join(', ');
            const tmdbTagline = detailedData.tagline;
            const tmdbRating = detailedData.vote_average ? detailedData.vote_average.toFixed(1) : '';

            if (detailedData.external_ids?.imdb_id) {
                mediaObject.imdb_id = detailedData.external_ids.imdb_id;
            }

            mediaObject.overview ||= detailedData.overview || '';
            mediaObject.genre ||= tmdbGenre;
            mediaObject.cast ||= tmdbCast;
            mediaObject.runtime ||= tmdbRuntime;
            mediaObject.tagline ||= tmdbTagline;
            mediaObject.rating ||= tmdbRating;

            if ((mediaObject.type === "tv" || mediaObject.type === "series") && detailedData.seasons) {
                const validSeasons = detailedData.seasons.filter(s => s.season_number > 0);

                const seasonPromises = validSeasons.map(s =>
                    fetch(`https://api.themoviedb.org/3/tv/${mediaObject.id}/season/${s.season_number}?api_key=${TMDB_KEY}`)
                        .then(r => r.json())
                );

                const tmdbSeasonsData = await Promise.all(seasonPromises);

                // Format into universal Stremio structure
                mediaObject.seasons = tmdbSeasonsData.map(tmdbSeason => ({
                    seasonNumber: tmdbSeason.season_number,
                    name: tmdbSeason.name || `Season ${tmdbSeason.season_number}`,
                    episodes: tmdbSeason.episodes.map(ep => ({
                        id: mediaObject.imdb_id || mediaObject.id,
                        episodeNumber: ep.episode_number,
                        title: ep.name,
                        thumbnail: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : null,
                        duration: ep.runtime
                    }))
                }));

                // Set defaults as integers
                const defaultSeason = mediaObject.seasons.find(s => s.seasonNumber > 0) || mediaObject.seasons[0];

                mediaObject.activeSeason = defaultSeason?.seasonNumber ?? 1;
                mediaObject.activeEpisode = defaultSeason?.episodes[0]?.episodeNumber ?? 1;

                // Set for scrapper after fetching
                mediaObject.type = "series";

                renderSeason(mediaObject);
            }

            const animeId = await fetchAnimeMapping(mediaObject.id);
            if (animeId) {
                const rawMatches = animeId.data ? animeId.data.matches : animeId.matches;
                const formatted = formatAnimeMappings(rawMatches);

                mediaObject.animeMappings = formatted;
                if (mediaObject.activeSeason) {
                    updateActiveKitsuMapping(mediaObject);
                }
                console.log("Formatted array:", formatted);
            }

            // Render all data
            renderMasterDetailView(mediaObject);
            return;

        } catch (e) {
            console.error("Detail Fetch Error:", e);

            // If it fails, replace the spinner with an error message
            const listContainer = document.getElementById('episode-list-container');
            const dropdownText = document.getElementById('season-dropdown-text');
            if ((mediaObject.type === 'series' || mediaObject.type === "tv") && listContainer) {
                dropdownText.textContent = "Error";
                listContainer.innerHTML = `
                    <div class="py-10 text-center col-span-full">
                        <p class="text-red-400 font-semibold mb-1">Failed to load episodes.</p>
                        <p class="text-slate-400 text-sm text-balance">The metadata provider might be down or missing this show.</p>
                    </div>
                `;
            }
        }
    } else if (mediaObject.baseUrl) {
        // --- STREMIO ADDON ROUTE ---
        try {
            const url = `${mediaObject.baseUrl}/meta/${mediaObject.type}/${mediaObject.id}.json`;
            const res = await fetch(url);

            if (!res.ok) throw new Error("Stremio Addon meta fetch failed");
            const data = await res.json();
            const meta = data.meta;

            console.log(meta, meta.id);
            if (!meta) return;

            const rawCast = meta.app_extras?.cast || meta.cast;
            const formattedCast = Array.isArray(rawCast)
                ? rawCast.slice(0, 5).map(c => c.name || c).join(', ')
                : '';

            // 1. Fill in missing details (Mapping Stremio keys to your keys)
            mediaObject.overview ||= meta.description || '';
            mediaObject.year ||= meta.year || '';
            mediaObject.runtime ||= meta.runtime || '';
            mediaObject.rating ||= meta.imdbRating || '';
            mediaObject.backdrop = meta.background || mediaObject.backdrop || '';
            mediaObject.cast ||= formattedCast || '';
            mediaObject.genre ||= Array.isArray(meta.genres) ? meta.genres[0] : meta.genres || '';


            // 2. Handle TV Seasons
            if (mediaObject.type === 'series' && meta.videos && meta.videos.length > 0) {
                const seasonsMap = {};

                // Group Stremio's flat video array into seasons
                meta.videos.forEach(vid => {
                    const sNum = vid.season ?? 1;

                    if (!seasonsMap[sNum]) {
                        seasonsMap[sNum] = {
                            seasonNumber: sNum,
                            name: `Season ${sNum}`,
                            episodes: []
                        };
                    }

                    seasonsMap[sNum].episodes.push({
                        id: vid.id, // Keep the raw Stremio ID (e.g., tt12345:1:1) for stream scrapers!
                        episodeNumber: vid.episode ?? 1,
                        title: vid.title || vid.name || `Episode ${vid.episode}`,
                        thumbnail: vid.thumbnail,
                        overview: vid.overview || vid.description,
                        duration: vid.runtime
                    });
                });

                // Sort seasons and episodes numerically
                const sortedSeasons = Object.values(seasonsMap).sort((a, b) => a.seasonNumber - b.seasonNumber);
                sortedSeasons.forEach(s => s.episodes.sort((a, b) => a.episodeNumber - b.episodeNumber));

                mediaObject.seasons = sortedSeasons;

                const defaultSeason = sortedSeasons.find(s => s.seasonNumber > 0) || sortedSeasons[0];
                mediaObject.activeSeason = defaultSeason?.seasonNumber ?? 1;
                mediaObject.activeEpisode = defaultSeason?.episodes[0]?.episodeNumber ?? 1;

                mediaObject.activeEpisodeId = defaultSeason?.episodes[0]?.id;

                renderSeason(mediaObject);
            }

            // 3. Silently update the UI with the enriched data
            renderMasterDetailView(mediaObject);
            console.log(mediaObject);

        } catch (e) {
            console.error("Detail Fetch Error:", e);

            // If it fails, replace the spinner with an error message
            const listContainer = document.getElementById('episode-list-container');
            const dropdownText = document.getElementById('season-dropdown-text');
            if (mediaObject.type === 'series' && listContainer) {
                dropdownText.textContent = "Error";
                listContainer.innerHTML = `
                    <div class="py-10 text-center col-span-full">
                        <p class="text-red-400 font-semibold mb-1">Failed to load episodes.</p>
                        <p class="text-slate-400 text-sm text-balance">The metadata provider might be down or missing this show.</p>
                    </div>
                `;
            }
        }
    }
}

export async function openCollectionGrid(collectionItem) {
    if (!collectionItem) return;

    // 1. Instantly open the modal and show loading states
    mediaStore.clear();
    const seasonsContainer = document.getElementById('media-seasons');
    seasonsContainer.classList.remove("hidden");

    const listContainer = document.getElementById('episode-list-container');
    if (listContainer) {
        listContainer.innerHTML = `
            <div class="flex flex-col items-center justify-center py-16 px-4 col-span-full">
                <svg class="animate-spin h-10 w-10 text-blue-500 mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <p class="text-slate-400 font-medium animate-pulse">Loading collection...</p>
            </div>
        `;
    }

    try {
        // 2. Fetch the metadata from the addon
        const url = `${collectionItem.baseUrl}/meta/${collectionItem.type}/${collectionItem.id}.json`;
        const res = await fetch(url);

        if (!res.ok) throw new Error("Failed to fetch collection");
        const data = await res.json();
        const meta = data.meta;
        console.log(meta);

        if (!meta || !meta.videos) throw new Error("Collection is empty");

        // 3. Build the Master Object with the 'isCollection' flag
        const collectionData = {
            isCollection: true,
            type: "movie",
            backdrop: meta.background,
            baseUrl: collectionItem.baseUrl,

            // Set the first movie as the default top-banner data
            id: meta.videos[0].id,
            title: meta.videos[0].title || meta.videos[0].name,
            poster: meta.videos[0].thumbnail,
            overview: meta.overview || meta.videos[0].description || meta.description,

            activeSeason: 1,
            activeEpisode: meta.videos[0].id, // Use the movie ID as the active tracker

            // Map all movies into a single "Season"
            seasons: [{
                seasonNumber: 1,
                name: meta.name || "Collection Items",
                episodes: meta.videos.map((vid, index) => ({
                    id: vid.id,
                    episodeNumber: vid.id, // Store the IMDb ID here so we can track clicks
                    title: vid.title || vid.name,
                    thumbnail: vid.thumbnail,
                    overview: vid.overview || vid.description,
                    duration: vid.released ? new Date(vid.released).getFullYear() : null // Show year instead of duration
                }))
            }]
        };

        // 4. Render the top banner and the movie list
        renderMasterDetailView(collectionData);
        renderSeason(collectionData);

    } catch (e) {
        console.error("Collection Fetch Error:", e);
        if (listContainer) listContainer.innerHTML = `<p class="text-red-400 py-10 text-center col-span-full">Failed to load collection.</p>`;
    }
}

export function handlePlayAction(mediaObject) {
    if (!mediaObject || !mediaObject.id || !mediaObject.type) return;

    let id = "";
    let type = "";
    let season = "";
    let episode = "";

    if (mediaObject.addonName == "customTMDB" || !mediaObject.baseUrl) {
        id = mediaObject.currentKitsuId || mediaObject.imdb_id || mediaObject.id;
        type = mediaObject.type;

        season = mediaObject.activeSeason || null;
        episode = mediaObject.kitsuEpisode || mediaObject.activeEpisode || null;
    } else if (mediaObject.baseUrl) {
        id = mediaObject.activeEpisodeId || mediaObject.id;
        type = mediaObject.type;

        season = mediaObject.activeSeason || null;
        episode = mediaObject.activeEpisode || null;
    }

    console.log(id, type, season, episode);

    const playBtn = document.getElementById('add-library-btn');
    const originalContent = playBtn.innerHTML;

    playBtn.disabled = true;
    playBtn.innerHTML = `
    <svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg> Loading...`;

    try {
        showStreamPicker(mediaObject.title);
        loadAllAddonsParallel(type, id, season, episode);
    } catch (e) {
        console.error("Failed to load streams:", e);
        showToast("Error fetching streams.", "error");
    } finally {
        playBtn.innerHTML = originalContent;
        playBtn.disabled = false;
    }
}

//#region Anime Mapping
// Anime detector and mappings for TMBD ONLY
export async function fetchAnimeMapping(tmdbId) {
    const workerBaseUrl = MY_PROXY.replace('/?url=', '');
    try {
        const mapUrl = `${workerBaseUrl}/map?tmdb_id=${tmdbId}`;
        const res = await fetch(mapUrl);
        if (res.ok) {
            const data = await res.json();
            if (data) {
                return { data };
            }
        }
    } catch (e) {
        console.warn("Fribb Network failed.", e);
    }
    return null;
}

function formatAnimeMappings(rawMatches) {
    if (!Array.isArray(rawMatches)) return [];

    return rawMatches.map(match => ({
        kitsuId: match.kitsu_id || null,
        type: match.type || "UNKNOWN",
        season: match.season?.tmdb ?? 1,
        episodeOffset: match.episode_offset?.tmdb ?? 0
    }));
}

export function updateActiveKitsuMapping(mediaObject) {
    if (!mediaObject.animeMappings) return;

    const seasonMappings = mediaObject.animeMappings.filter(m => m.season === mediaObject.activeSeason);
    if (seasonMappings.length === 0) return;

    seasonMappings.sort((a, b) => b.episodeOffset - a.episodeOffset);

    const matchedMapping = seasonMappings.find(m => mediaObject.activeEpisode > m.episodeOffset)
        || seasonMappings[seasonMappings.length - 1]; // Fallback

    // 4. Set the exact Kitsu ID and calculate the corrected Kitsu Episode
    mediaObject.currentKitsuId = `kitsu:${matchedMapping.kitsuId}`;
    mediaObject.kitsuEpisode = mediaObject.activeEpisode - matchedMapping.episodeOffset;

    console.log(`Matched! Kitsu ID: ${mediaObject.currentKitsuId} | Kitsu Ep: ${mediaObject.kitsuEpisode}`);
}
//#endregion

//#region Render Details
function renderMasterDetailView(mediaObject) {
    const viewContainer = document.getElementById('full-detail-view');
    if (!viewContainer) return;

    viewContainer.classList.remove('hidden');
    requestAnimationFrame(() => viewContainer.classList.remove('translate-y-full'));

    const playBtn = document.getElementById('add-library-btn');
    if (playBtn) {
        playBtn.onclick = () => {
            if (!playBtn.disabled) handlePlayAction(mediaObject);
        };
    }

    const ui = {
        title: document.getElementById('media-title'),
        backdrop: document.getElementById('detail-backdrop'),
        poster: document.getElementById('detail-poster'),
        genre: document.getElementById('detail-genre'),
        runtime: document.getElementById('detail-runtime'),
        rating: document.getElementById('detail-rating'),
        year: document.getElementById('detail-year'),
        tagline: document.getElementById('detail-tagline'),
        overview: document.getElementById('detail-overview'),
        cast: document.getElementById('detail-cast'),
    };

    const updateField = (element, value, prefix = '') => {
        if (!element) return;
        if (value) {
            element.textContent = prefix + value;
            element.classList.remove('hidden');
        } else {
            element.classList.add('hidden');
        }
    };

    // Fill Data Using the Helper
    updateField(ui.title, mediaObject.title);
    updateField(ui.runtime, mediaObject.runtime);
    updateField(ui.rating, mediaObject.rating);
    updateField(ui.year, mediaObject.year);
    updateField(ui.genre, mediaObject.genre);
    updateField(ui.tagline, mediaObject.tagline);
    updateField(ui.overview, mediaObject.overview);
    updateField(ui.cast, mediaObject.cast, 'Cast: '); // Adds "Cast: " only if cast exists

    // Handle Images normally
    if (ui.poster && mediaObject.poster) {
        ui.poster.src = mediaObject.poster;
    }
    if (ui.backdrop) {
        ui.backdrop.style.backgroundImage = mediaObject.backdrop ? `url('${mediaObject.backdrop}')` : 'none';
    }
}

export function renderSeason(mediaObject) {
    if (!mediaObject || !mediaObject.seasons || mediaObject.seasons.length === 0) return;

    const activeSeasonData = mediaObject.seasons.find(s => s.seasonNumber === mediaObject.activeSeason) || mediaObject.seasons[0];
    console.log(activeSeasonData);

    const dropdownBtn = document.getElementById('season-dropdown-btn');
    const dropdownText = document.getElementById('season-dropdown-text');
    const dropdownMenu = document.getElementById('season-dropdown-menu');
    const chevron = document.getElementById('season-dropdown-chevron');
    const listContainer = document.getElementById('episode-list-container');
    const template = document.getElementById('episode-card-template');

    dropdownText.textContent = activeSeasonData.name || `Season ${activeSeasonData.seasonNumber}`;
    dropdownBtn.disabled = false;

    if (mediaObject.isCollection) {
        dropdownBtn.disabled = true;
        if (chevron) chevron.classList.add('hidden');
    } else {
        dropdownBtn.disabled = false;
        if (chevron) chevron.classList.remove('hidden');
    }

    dropdownBtn.onclick = (e) => {
        e.stopPropagation();
        dropdownMenu.classList.toggle('hidden');
        chevron.classList.toggle('rotate-180');
    };

    dropdownMenu.innerHTML = mediaObject.seasons.map(season => {
        const isActive = season.seasonNumber === mediaObject.activeSeason;
        const activeClasses = isActive ? 'bg-blue-600/20 text-blue-400 border-blue-500' : 'text-white border-transparent';
        return `
            <button data-season="${season.seasonNumber}"
                    class="season-btn w-full text-left px-4 py-3 hover:bg-slate-700/50 transition font-semibold text-base whitespace-nowrap border-b-2 border-slate-700/30 last:border-b-0 ${activeClasses}">
                ${season.name || `Season ${season.seasonNumber}`}
            </button>
        `;
    }).join('');

    dropdownMenu.querySelectorAll('.season-btn').forEach(btn => {
        btn.onclick = (e) => {
            const clickedSeasonNum = parseInt(e.currentTarget.dataset.season);
            dropdownMenu.classList.add('hidden');
            chevron.classList.remove('rotate-180');

            if (clickedSeasonNum !== mediaObject.activeSeason) {
                mediaObject.activeSeason = clickedSeasonNum;
                const newSeason = mediaObject.seasons.find(s => s.seasonNumber === clickedSeasonNum);
                mediaObject.activeEpisode = newSeason?.episodes[0]?.episodeNumber || 1;

                mediaObject.activeEpisodeId = newSeason?.episodes[0]?.id;

                if (mediaObject.animeMappings) updateActiveKitsuMapping(mediaObject);

                renderSeason(mediaObject);
            }
        };
    });

    listContainer.innerHTML = '';

    activeSeasonData.episodes.forEach(ep => {
        const clone = template.content.cloneNode(true);
        const card = clone.querySelector('.episode-card');
        const titleEl = clone.querySelector('.ep-title');
        const thumbEl = clone.querySelector('.ep-thumbnail');
        const durationEl = clone.querySelector('.ep-duration');

        // 1. Grab the parent div that holds the image
        const imageWrapper = thumbEl.parentElement;

        titleEl.textContent = `${ep.episodeNumber}. ${ep.title || `Episode ${ep.episodeNumber}`}`;

        // 2. Adjust for Collections
        if (mediaObject.isCollection) {
            titleEl.textContent = `${ep.title}`;
            imageWrapper.classList.remove('aspect-video');
            imageWrapper.classList.add('aspect-[2/3]');

            card.classList.remove('w-48', 'md:w-64');
            card.classList.add('w-32', 'md:w-44');
        }


        if (ep.thumbnail) {
            thumbEl.src = ep.thumbnail;
        } else {
            thumbEl.style.display = 'none';
        }

        if (ep.duration) {
            const durationStr = String(ep.duration).toLowerCase();
            if (durationStr.includes('m') || durationStr.includes('h')) {
                durationEl.textContent = ep.duration;
            } else {
                durationEl.textContent = `${ep.duration}m`;
            }

            durationEl.classList.remove('hidden');
        }

        if (ep.episodeNumber === mediaObject.activeEpisode) {
            card.classList.add('border-blue-500', 'bg-blue-500/10', 'shadow-[0_0_15px_rgba(59,130,246,0.3)]');
            card.classList.remove('border-slate-700/50', 'bg-slate-800/40');
        }

        card.onclick = () => {
            mediaObject.activeEpisode = ep.episodeNumber;

            // Instantly swap CSS classes
            listContainer.querySelectorAll('.episode-card').forEach(c => {
                c.classList.remove('border-blue-500', 'bg-blue-500/10', 'shadow-[0_0_15px_rgba(59,130,246,0.3)]');
                c.classList.add('border-slate-700/50', 'bg-slate-800/40');
            });
            card.classList.add('border-blue-500', 'bg-blue-500/10', 'shadow-[0_0_15px_rgba(59,130,246,0.3)]');
            card.classList.remove('border-slate-700/50', 'bg-slate-800/40');

            // TMDB ONLY
            if (mediaObject.animeMappings) updateActiveKitsuMapping(mediaObject);

            // Custom only
            if (ep.id) mediaObject.activeEpisodeId = ep.id;

            // --- COLLECTION ---
            if (mediaObject.isCollection) {
                // 1. Update the master object with basic data
                mediaObject.id = ep.id;
                mediaObject.title = ep.title;
                mediaObject.overview = ep.overview;
                mediaObject.poster = ep.thumbnail;

                // Clear out old deep data so the next movie doesn't flash the previous movie's cast/rating
                mediaObject.cast = '';
                mediaObject.runtime = '';
                mediaObject.rating = '';
                mediaObject.year = '';
                mediaObject.genre = '';
                mediaObject.backdrop = '';

                checkFullData(mediaObject);
            }
        };

        listContainer.appendChild(clone);
    });
}

export function closeMovieDetail() {
    const viewContainer = document.getElementById('full-detail-view');
    viewContainer.classList.add('translate-y-full');
    document.body.style.overflow = '';

    viewContainer.addEventListener('transitionend', function hideAfterAnimate() {
        viewContainer.classList.add('hidden');
        viewContainer.removeEventListener('transitionend', hideAfterAnimate);

        // 1. Clear the JavaScript memory
        mediaStore.clear();

        document.getElementById('detail-poster').src = '';
        document.getElementById('detail-backdrop').style.backgroundImage = 'none';

        document.getElementById('episode-list-container').replaceChildren();

    }, { once: true });
}

document.addEventListener('click', () => {
    const dropdownMenu = document.getElementById('season-dropdown-menu');
    const chevron = document.getElementById('season-dropdown-chevron');
    if (dropdownMenu && !dropdownMenu.classList.contains('hidden')) {
        dropdownMenu.classList.add('hidden');
        if (chevron) chevron.classList.remove('rotate-180');
    }
});
//#endregion