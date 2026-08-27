import { showToast, MY_PROXY, TMDB_KEY } from './services/config.js';
import { loadAllAddonsParallel } from './user-addons/scrapers.js';
import { showStreamPicker } from './user-addons/scraper-renderer.js';

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

        // For watchlist data
        exportForLibrary: () => {
            return {
                id: state.id,
                type: state.type,
                title: state.title,
                poster: state.poster,
            };
        }
    };
})();


// Detect media type (Western or Anime)
export async function openMasterDetail(tmdbId, TMDBTitle, type, posterImage, backdropImage) {
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
                console.log(data);
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
export function handlePlayAction() {
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

    const playBtn = document.getElementById('add-library-btn');
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

    // Update menu data every time
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

    // Remove the loading classes from handleSeasonChangeClick
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

document.addEventListener('click', async (event) => {
    const playBtn = event.target.closest('#add-library-btn');

    if (!playBtn) return;
    if (playBtn.disabled) return;

    await handlePlayAction();
});