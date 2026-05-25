import { playDirect, stopPlayback, getTorboxLink, requestLink, startPlayer } from './player.js';
import { TMDB_KEY, fetchAnimeMapping, searchTMDB, loadDiscover } from './api.js';
import { parseTorrentio } from './parseMedia.js';

let allTorrents = [];
let currentTorrentId = null;

export const TRAKT_CLIENT_ID = '027c95542a22d861d8a4e82b7535560b457639527f09b5526315682c611488c9';
// PASTE YOUR CLOUDFLARE URL BELOW (keep the /?url= at the end!)
export const MY_PROXY = "https://bt-kd-8478.manosfragakis05.workers.dev/?url=";


//#region Global functions

export const appState = {
    currentStreamUrl: "",
    clickCooldown: false
};

// Scan for downloaded content
scanLocalOPFSDirectory();

// Cloudflare Proxy
export async function smartFetch(targetUrl, options = {}) {
    return fetch(MY_PROXY + encodeURIComponent(targetUrl), options);
}

// GLOBAL NOTIFICATION UI
export function showToast(message, type = 'info') {
    const toast = document.createElement('div');

    // Set colors and icons based on the type
    let bgColors = "bg-blue-600 border-blue-500";
    let icon = 'ℹ️';

    if (type === 'success') {
        bgColors = "bg-emerald-700 border-emerald-500";
        icon = '✅';
    } else if (type === 'error') {
        bgColors = "bg-red-700 border-red-500";
        icon = '❌';
    }

    // Modern, sliding, premium UI
    toast.className = `fixed top-5 right-5 ${bgColors} text-white border p-4 rounded-xl shadow-2xl z-[9999] transition-all duration-300 transform translate-y-[-20px] opacity-0 flex items-center gap-3 backdrop-blur-md`;

    toast.innerHTML = `
        <span class="text-xl drop-shadow-md">${icon}</span> 
        <span class="text-sm font-bold tracking-wide leading-tight">${message}</span>
    `;

    document.body.appendChild(toast);

    // 1. Animate In
    requestAnimationFrame(() => {
        toast.classList.remove('translate-y-[-20px]', 'opacity-0');
        toast.classList.add('translate-y-0', 'opacity-100');
    });

    // 2. Wait 3 seconds, Animate Out, then Delete
    setTimeout(() => {
        toast.classList.remove('translate-y-0', 'opacity-100');
        toast.classList.add('translate-y-[-20px]', 'opacity-0');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

window.showToast = showToast;
//#endregion

//#region TorBox Auth
async function authenticateTorboxUser() {
    const input = document.getElementById('api-input');
    const button = document.getElementById('loggin-btn');
    const key = input.value.trim();

    if (!key) return showToast("Please enter an API key.", 'error');

    button.innerText = "Verifying...";
    button.disabled = true;
    input.disabled = true;

    try {
        const targetUrl = 'https://api.torbox.app/v1/api/user/me';
        const res = await smartFetch(targetUrl, {
            headers: { 'Authorization': `Bearer ${key}` }
        });

        const data = await res.json();

        if (data.success && data.data) {
            localStorage.setItem('tb_api_key', key);
            button.innerText = "Connected!";
            button.classList.replace('bg-blue-600', 'bg-green-600');

            setTimeout(() => {
                checkAuth();
            }, 800);

        } else {
            throw new Error(data.detail || "Invalid API Key");
        }

    } catch (e) {
        showToast("Authentication Failed: " + e.message, 'error');
        button.innerText = "Log In";
        button.disabled = false;
        input.disabled = false;
        input.classList.add('border-red-500');
    }
}

function checkAuth() {
    const key = localStorage.getItem('tb_api_key');
    const authScreen = document.getElementById('auth-screen');

    if (!key) {
        authScreen.classList.remove('hidden');
    } else {
        authScreen.classList.add('hidden');
        loadLibrary(key);
    }
}

checkAuth();

function toggleProfile(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('profile-dropdown');
    menu.classList.toggle('hidden');
}

function logoutTorBox() {
    if (confirm("Disconnect TorBox API?")) {
        localStorage.removeItem('tb_api_key');
        location.reload();
    }
}

export function goHome() {
    stopPlayback();

    document.getElementById('player-wrapper').classList.add('hidden');
    document.getElementById('search-input').value = '';
}

// --- LIBRARY ---
async function loadLibrary(key) {
    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('file-list').innerHTML = '';

    try {
        const res = await smartFetch('https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true', {
            headers: { 'Authorization': `Bearer ${key}` }
        });
        const data = await res.json();
        document.getElementById('loading').classList.add('hidden');

        if (data.success) {
            allTorrents = data.data.filter(t => t.download_finished);
            renderList(allTorrents);
        } else {
            showToast("Error: " + data.detail, 'error');
        }
    } catch (e) { showToast("Network Error", 'error'); }
}

export function renderList(items) {
    const list = document.getElementById('file-list');
    list.innerHTML = '';

    if (items.length === 0) {
        document.getElementById('empty-state').classList.remove('hidden');
        return;
    }
    document.getElementById('empty-state').classList.add('hidden');

    const vault = JSON.parse(localStorage.getItem('tmdb_vault') || '{}');
    const itemsNeedsFetching = []; // 🧠 We will store items that need API calls here!

    // 1. INSTANT UI RENDER (Draw all cards immediately so the app feels fast)
    items.forEach((t) => {
        const vidCount = t.files.filter(f => f.name.match(/\.(mkv|mp4|avi|mov)$/i)).length;
        const isShow = vidCount > 1;

        const mediaInfo = parseTorrentio(t.name);
        const cleanName = mediaInfo.title;
        const year = mediaInfo.year;

        const hash = (t.hash || "").toLowerCase();
        let vaultData = vault[hash];

        const card = document.createElement('div');
        card.className = "relative flex-col cursor-pointer transition-transform hover:scale-105 select-none group";

        // 1. Build the action buttons dynamically
        let actionButtonsHTML = `<button onclick="event.stopPropagation(); deleteTorrent(${t.id}, event);" class="text-red-500 hover:text-red-400 p-1 bg-black/50 rounded-full transition z-10 w-8 h-8 flex items-center justify-center backdrop-blur-sm shadow-md">🗑️</button>`;

        if (!isShow) {
            // It's a movie! Grab the primary video file to get its ID and Name
            const vid = t.files.find(f => f.name.match(/\.(mkv|mp4|avi|mov)$/i)) || t.files[0];
            if (vid) {
                const safeFileName = vid.name.replace(/'/g, "\\'");
                // Prepend the download button next to the delete button
                actionButtonsHTML = `
                    <button onclick="event.stopPropagation(); downloadToOPFS(${t.id}, ${vid.id}, null, '${cleanName}', this);" class="text-blue-400 hover:text-blue-300 p-1 bg-black/50 rounded-full transition z-10 w-8 h-8 flex items-center justify-center backdrop-blur-sm shadow-md mr-2">⬇️</button>
                    ${actionButtonsHTML}
                `;
            }
        }

        // 2. Inject into the card
        card.innerHTML = `
            <div class="relative w-full aspect-[2/3] bg-slate-800 rounded-lg shadow-lg overflow-hidden border border-slate-700/50">
                
                <img id="img-${t.id}" src="" class="absolute inset-0 w-full h-full object-cover hidden" draggable="false">

                <div id="fallback-${t.id}" class="absolute inset-0 flex items-center justify-center p-4 text-center text-slate-500 font-bold text-sm bg-slate-800">
                    ${cleanName}
                </div>

                <div class="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3">
                    <div class="flex justify-between items-center mb-1">
                        <span class="text-white font-bold text-xs truncate drop-shadow-md">${isShow ? '📺 Series' : '🎬 Movie'}</span>
                        <div class="flex items-center">
                            ${actionButtonsHTML}
                        </div>
                    </div>
                </div>
                
                <div class="absolute top-2 right-2 bg-blue-600/90 text-white text-[10px] font-bold px-2 py-1 rounded backdrop-blur shadow-lg">
                    ${(t.size / 1073741824).toFixed(1)} GB
                </div>
            </div>
            <p class="text-xs text-slate-300 mt-2 truncate font-semibold pl-1">${cleanName}</p>
        `;

        card.onclick = () => {
            if (appState.clickCooldown) { showToast("Please wait a moment."); return; }
            appState.clickCooldown = true; setTimeout(() => appState.clickCooldown = false, 2000);

            // 🧠 THE FIX: Grab FRESH vault data right at the exact moment of the click!
            const freshVault = JSON.parse(localStorage.getItem('tmdb_vault') || '{}');
            const currentVaultData = freshVault[(t.hash || "").toLowerCase()];

            if (isShow) openPicker(t);
            else {
                const vid = t.files.find(f => f.name.match(/\.(mkv|mp4|avi|mov)$/i)) || t.files[0];
                if (vid) {
                    requestLink(t.id, vid.id, t.name, vid.name);
                } else {
                    showToast("No playable video files found in this torrent.", "error");
                }
            }
        };

        list.appendChild(card);

        // INSTANT POSTER LOADING
        const imgElement = document.getElementById(`img-${t.id}`);
        const fallbackElement = document.getElementById(`fallback-${t.id}`);

        if (vaultData && vaultData.poster) {
            imgElement.src = vaultData.poster;
            imgElement.classList.remove('hidden');
            fallbackElement.classList.add('hidden');
        } else {
            // 🧠 Queue it for the Batch Fetcher instead of bombing the API!
            itemsNeedsFetching.push({ t, cleanName, year, hash, imgElement, fallbackElement });
        }
    });

    // 2. THE BATCH FETCHER (Safely loads 5 missing posters at a time)
    if (itemsNeedsFetching.length > 0) {
        const fetchInBatches = async () => {
            const BATCH_SIZE = 5;

            for (let i = 0; i < itemsNeedsFetching.length; i += BATCH_SIZE) {
                const batch = itemsNeedsFetching.slice(i, i + BATCH_SIZE);

                // Fire 5 requests in parallel
                await Promise.all(batch.map(async (item) => {
                    const fetchedData = await getPosterForLibrary(item.cleanName, item.year);
                    const finalPoster = typeof fetchedData === 'string' ? fetchedData : (fetchedData?.poster);

                    if (finalPoster) {
                        item.imgElement.src = finalPoster;
                        item.imgElement.classList.remove('hidden');
                        item.fallbackElement.classList.add('hidden');

                        if (typeof fetchedData === 'object' && fetchedData.id) {
                            let safeVault = JSON.parse(localStorage.getItem('tmdb_vault') || '{}');
                            safeVault[item.hash] = { id: fetchedData.id, type: fetchedData.type, poster: fetchedData.poster };
                            localStorage.setItem('tmdb_vault', JSON.stringify(safeVault));
                        }
                    }
                }));

                // Wait 250ms before firing the next 5 (The safety valve!)
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        };
        fetchInBatches();
    }
}

async function getPosterForLibrary(cleanTitle, year) {
    try {
        let url = `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_KEY}&query=${encodeURIComponent(cleanTitle)}&page=1`;
        if (year) url += `&primary_release_year=${year}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.results && data.results.length > 0) {
            const bestMatch = data.results[0];

            // Return the full package so the Vault can cache it!
            return {
                id: bestMatch.id,
                type: bestMatch.media_type || (bestMatch.name ? 'tv' : 'movie'),
                poster: bestMatch.poster_path ? `https://image.tmdb.org/t/p/w500${bestMatch.poster_path}` : null
            };
        }
        return null;
    } catch (e) {
        return null;
    }
}

function refreshLibrary() {
    const key = localStorage.getItem('tb_api_key');
    if (key) loadLibrary(key);
}

//#region MULTIPLE IDs
async function getTmdbIdFallback(title) {
    if (!title) return null;
    const cleanTitle = title.toLowerCase().trim();

    // 1. Scan LocalStorage Cache First
    const cacheKey = 'tmdb_title_cache';
    let titleCache = JSON.parse(localStorage.getItem(cacheKey) || '{}');

    if (titleCache[cleanTitle]) {
        console.log(`⚡ Loaded TMDB ID from Cache for: "${title}"`);
        return titleCache[cleanTitle];
    }

    // 2. Fetch from TMDB API if not in cache
    console.log(`🕵️ Fetching TMDB ID via text search for: "${title}"...`);
    try {
        const searchUrl = `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_KEY}&query=${encodeURIComponent(cleanTitle)}&page=1`;
        const searchRes = await fetch(searchUrl);
        const searchData = await searchRes.json();

        if (searchData.results && searchData.results.length > 0) {
            const foundId = searchData.results[0].id;

            // 3. Save it to LocalStorage so we never have to search this title again!
            titleCache[cleanTitle] = foundId;
            localStorage.setItem(cacheKey, JSON.stringify(titleCache));

            console.log(`🎯 TMDB Fallback Success! Found ID: ${foundId}`);
            return foundId;
        } else {
            console.log(`🛑 TMDB returned nothing for "${title}".`);
            return null;
        }
    } catch (e) {
        console.warn("TMDB text search failed.", e);
        return null;
    }
}

// Get Anilist ID from string
async function getAnilistIdFromText(searchText) {
    // 1. ADD THE QUEUE: Protect against AniList's strict Rate Limits (90/min)
    await (anilistQueue = anilistQueue.then(() => new Promise(r => setTimeout(r, 1500))).catch(() => { }));

    const query = `
    query ($search: String) {
      Page (page: 1, perPage: 1) {
        media (search: $search, type: ANIME) {
          id
          title { english romaji }
          episodes
          coverImage { large } 
        }
      }
    }`;

    try {
        const res = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ query, variables: { search: searchText } })
        });

        // 2. CATCH HTTP ERRORS: Stop fetch from silently passing on 429s or 400s
        if (!res.ok) {
            const errText = await res.text();
            console.error(`🚨 AniList API Error (${res.status}):`, errText, "Search Sting:", searchText);
            return null;
        }

        const json = await res.json();
        //console.log(`📡 AniList Raw Response for "${searchText}":`, JSON.stringify(json, null, 2));

        // 3. CATCH GRAPHQL ERRORS: If the query format is somehow rejected
        if (json.errors) {
            console.error("🚨 AniList GraphQL Errors:", json.errors);
            return null;
        }

        const match = json.data?.Page?.media[0];

        return match ? {
            id: match.id,
            title: match.title.english || match.title.romaji,
            coverImage: match.coverImage?.large,
            officialEpisodeCount: match.episodes || null
        } : null;

    } catch (e) {
        // 4. STOP SILENT FAILURES: Actually log network drops
        console.error("🚨 AniList Network/Fetch Exception:", e);
        return null;
    }
}

// 1. Keep this at the top of your file
let anilistQueue = Promise.resolve();

async function getDirectSequel(currentAnilistId) {
    await (anilistQueue = anilistQueue.then(() => new Promise(r => setTimeout(r, 150))).catch(() => { }));

    // 3. Proceed with the normal fetch!
    const query = `
    query ($id: Int) {
      Media (id: $id) {
        relations {
          edges {
            relationType
            node {
              id
              episodes
              title { english romaji }
            }
          }
        }
      }
    }`;

    try {
        const res = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables: { id: currentAnilistId } })
        });
        const json = await res.json();

        const allRelations = json.data?.Media?.relations?.edges || [];
        const sequelEdge = allRelations.find(edge => edge.relationType === 'SEQUEL');

        if (sequelEdge) {
            const sequelTitle = sequelEdge.node.title.english || sequelEdge.node.title.romaji || "Unknown Title";
            return {
                id: sequelEdge.node.id,
                officialEpisodeCount: sequelEdge.node.episodes,
                title: sequelTitle,
            };
        }
        return null;

    } catch (e) {
        console.error("AniList Graph Fetch Failed", e);
        return null;
    }
}

async function fetchAllKitsuEpisodes(kitsuId) {
    let allEpisodes = [];
    let offset = 0;
    const limit = 20;
    let keepFetching = true;

    while (keepFetching) {
        try {
            // Ask for 20 episodes, starting at the current offset
            const epUrl = `https://kitsu.io/api/edge/episodes?filter[mediaId]=${kitsuId}&page[limit]=${limit}&page[offset]=${offset}&sort=number`;

            const res = await fetch(epUrl, {
                headers: {
                    'Accept': 'application/vnd.api+json',
                    'Content-Type': 'application/vnd.api+json'
                }
            });

            if (!res.ok) break;

            const json = await res.json();
            const newEpisodes = json.data || [];

            allEpisodes.push(...newEpisodes);

            // If Kitsu gives us fewer than 20 episodes, we've reached the end!
            if (newEpisodes.length < limit) {
                keepFetching = false;
            } else {
                // Otherwise, increase the offset by 20 for the next loop
                offset += limit;

                // 🛑 SAFETY VALVE: Wait 150ms before asking for the next page to prevent Rate Limiting
                await new Promise(resolve => setTimeout(resolve, 150));
            }

        } catch (e) {
            console.warn(`⚠️ Kitsu pagination failed at offset ${offset}`, e);
            keepFetching = false;
        }
    }

    return allEpisodes;
}

async function processKitsuFallback(kitsuQueue, cleanTitle, season, mappedKitsuId) {
    if (!kitsuQueue || kitsuQueue.length === 0) return;
    console.log(`🦊 Kitsu Fallback triggered for S${season} (${kitsuQueue.length} files)`);

    let targetKitsuId = mappedKitsuId;
    let fallbackPoster = null;
    let fallbackTitle = cleanTitle;

    // -------------------------------------------
    // 1. FIND THE CORRECT KITSU ID
    // -------------------------------------------
    if (!targetKitsuId || (season !== 1 && season !== '1')) {
        let searchString = cleanTitle;
        if (season > 1) searchString += ` Season ${season}`;

        const kitsuMatch = await searchKitsuText(searchString);

        if (kitsuMatch) {
            targetKitsuId = kitsuMatch.id;
            fallbackPoster = kitsuMatch.poster;
            fallbackTitle = kitsuMatch.title || cleanTitle;
        }
    }

    // SAFETY NET: If we still have no ID, gracefully fail the UI
    if (!targetKitsuId) {
        console.warn(`❌ Kitsu Fallback failed: Could not find target ID for ${cleanTitle} S${season}.`);
        kitsuQueue.forEach(file => {
            file.displayTitle = file.episode ? `Episode ${file.episode}` : cleanTitle;
            file.displayThumbnail = fallbackPoster;
            file.relativeEpisode = file.episode;
        });
        return;
    }

    // -------------------------------------------
    // 2. FETCH ALL EPISODES (Using our new loop)
    // -------------------------------------------
    const fetchedEpisodes = await fetchAllKitsuEpisodes(targetKitsuId);
    console.log(`🦊 Kitsu found ${fetchedEpisodes.length} total episodes for ID ${targetKitsuId}`);

    // -------------------------------------------
    // 3. MAP LOCAL FILES TO KITSU DATA
    // -------------------------------------------
    for (const file of kitsuQueue) {

        // PATH A: Movies or unparsed files
        if (!file.episode || file.fileType !== 'TV') {
            file.displayTitle = cleanTitle;
            file.displayTitle = fallbackTitle;
            file.displayThumbnail = fallbackPoster;
            continue;
        }

        // PATH B: TV Episodes
        const fileEpInt = parseInt(file.episode, 10);

        // Find the match in our massive array
        const epMatch = fetchedEpisodes.find(ep =>
            ep.attributes?.relativeNumber === fileEpInt ||
            ep.attributes?.number === fileEpInt
        );

        if (epMatch) {
            file.displayTitle = epMatch.attributes?.canonicalTitle || `Episode ${file.episode}`;
            file.displayThumbnail = epMatch.attributes?.thumbnail?.original || fallbackPoster;

            // THE FIX: Prioritize Kitsu's Absolute Number first so long-running shows don't reset!
            file.relativeEpisode = epMatch.attributes?.number || epMatch.attributes?.relativeNumber || file.episode;
        } else {
            // No match found in the array
            file.displayTitle = `Episode ${file.episode}`;
            file.displayThumbnail = fallbackPoster;
            file.relativeEpisode = file.episode;
        }
    }
}

async function searchKitsuText(searchString) {
    try {
        // We encode the string so spaces and special characters don't break the URL
        const url = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(searchString)}`;

        const res = await fetch(url, {
            headers: {
                'Accept': 'application/vnd.api+json',
                'Content-Type': 'application/vnd.api+json'
            }
        });

        const json = await res.json();
        const match = json.data?.[0];

        if (match) {
            return {
                id: match.id,
                title: match.attributes?.canonicalTitle,
                // Fallback through their image sizes to ensure we get something
                poster: match.attributes?.posterImage?.large || match.attributes?.posterImage?.original
            };
        }
    } catch (e) {
        console.error("🦊 Kitsu search failed:", e);
    }
    return null;
}
//#endregion

//#region Grouping
function preProcessTorrentData(videoFiles, mainShowTitle) {
    const franchiseGroups = {};

    videoFiles.forEach(file => {
        const fileData = parseTorrentio(file.name);

        // 1. Cleaned up redundant ORs
        let mergedInfo = {
            title: fileData.title || mainShowTitle || 'Unknown',
            episode: fileData.episode || null,
            season: fileData.season || 1,
            year: parseInt(fileData.year || fileData.airDate, 10) || null,
            fileType: fileData.fileType || ''
        };

        const sizeInMB = file.size / (1024 * 1024);

        // 2. CRITICAL FIX: Force to UPPERCASE to match the switch cases
        const fileType = mergedInfo.fileType.toUpperCase();
        let finalFileType = "TV";

        switch (fileType) {
            case 'MOVIE': finalFileType = 'Movie'; break;
            case 'OVA':
            case 'OAD':
            case 'ODA':
            case 'ONA': finalFileType = 'OVA'; break;
            case 'SPECIAL':
            case 'SP': finalFileType = 'Special'; break;
            case 'OP':
            case 'OPENING':
            case 'NCOP':
            case 'ED':
            case 'ENDING':
            case 'NCED':
            case 'THEME': finalFileType = 'Theme'; break;
            case 'PV':
            case 'PROMO':
            case 'TRAILER': finalFileType = 'Trailer'; break;
            case 'TV':
            default: finalFileType = 'TV'; break;
        }

        const cleanTitle = mergedInfo.title.toLowerCase().trim();

        // 3. Initialize the group if it doesn't exist
        if (!franchiseGroups[cleanTitle]) {
            franchiseGroups[cleanTitle] = {
                title: mergedInfo.title,
                files: []
                // Removed finalType from here so groups can hold mixed types safely
            };
        }

        // 4. Push the file, including its individual type and size
        franchiseGroups[cleanTitle].files.push({
            originalFile: file,
            season: mergedInfo.season,
            episode: mergedInfo.episode,
            year: mergedInfo.year,
            fileType: finalFileType, // Store the type on the file itself!
            sizeMB: sizeInMB.toFixed(2) // Put your size calculation to good use
        });
    });

    // 5. Cleaned up the counting loop
    for (const group of Object.values(franchiseGroups)) {
        group.episodeCount = group.files.length;
    }

    return franchiseGroups;
}

// ==========================================
// 1. THE BRAIN (Processing & API Mapping)
// ==========================================
async function openPicker(torrent) {
    const picker = document.getElementById('file-picker');
    const list = document.getElementById('picker-list');
    const title = document.getElementById('picker-title');

    picker.classList.remove('hidden');

    // Show the spinner immediately
    list.innerHTML = `
        <div class="col-span-full flex justify-center p-10">
            <svg class="animate-spin h-8 w-8 text-blue-500" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
        </div>
    `;


    const videoFiles = torrent.files.filter(f => f.name.match(/\.(mkv|mp4|avi|mov)$/i));
    const baseInfo = parseTorrentio(torrent.name);
    const cleanName = baseInfo.title;

    // 1. CHECK THE VAULT FIRST (Grab the ID renderList already found for us!)
    const vault = JSON.parse(localStorage.getItem('tmdb_vault') || '{}');
    const vaultData = vault[(torrent.hash || "").toLowerCase()];

    let tmdbId = vaultData ? vaultData.id : null;

    // 2. If it's STILL missing, then do the text fallback
    if (!tmdbId) {
        tmdbId = await getTmdbIdFallback(cleanName);
        console.log("Fetched TMDB id from fallback");
    }

    // 3. STOP THE CRASH: Only ask for Anime IDs if we actually have a TMDB ID!
    let animeIds = null;
    if (tmdbId) {
        try {
            animeIds = await fetchAnimeMapping(tmdbId);
        } catch (e) {
            console.error("API failed to find anime mappings:", e);
        }
    }

    let torrentType = "";
    if (animeIds) torrentType = "anime";

    const franchiseGroups = await preProcessTorrentData(videoFiles, cleanName);

    const titledEpisodes = Object.keys(franchiseGroups).filter(key => {
        const group = franchiseGroups[key];
        // Flag groups that have 1 or 2 files, AND are NOT movies
        return group.files.length <= 2 && group.files.some(f => f.fileType === "TV");
    });

    titledEpisodes.forEach(key => {
        const group = franchiseGroups[key];

        // 1. Grab the first file to inspect its path
        const sampleFile = group.files[0];
        const pathParts = sampleFile.originalFile.name.split('/');

        // 2. Find the parent folder (if it exists)
        const isFlatDirectory = pathParts.length === 1;

        let realTitle = cleanName; // Default to the main torrent title

        if (!isFlatDirectory) {
            // 3. Parse the folder name to get the REAL show title
            const parentFolder = pathParts[pathParts.length - 2];
            const folderData = parseTorrentio(parentFolder);
            realTitle = folderData.title || cleanName;
        }

        const realTitleKey = realTitle.toLowerCase().trim();

        // 4. If the real title is different from the fragmented episode title...
        if (realTitleKey !== key) {

            // Create the master group if it doesn't exist yet
            if (!franchiseGroups[realTitleKey]) {
                franchiseGroups[realTitleKey] = {
                    title: realTitle,
                    files: []
                };
            }

            // 5. Dump the files into the master group and delete the fragment
            franchiseGroups[realTitleKey].files.push(...group.files);
            delete franchiseGroups[key];
        }
    });

    // ==========================================
    // THE PREMIUM METADATA LOOP (AniList + AniZip)
    // ==========================================
    if (torrentType === "anime") {
        for (const groupKey in franchiseGroups) {
            const group = franchiseGroups[groupKey];
            group.seasonTitles = {};

            // 1. Find all unique seasons inside this specific group
            const searchableFiles = group.files.filter(f => f.fileType === 'TV' || f.fileType === 'Movie' || f.fileType === 'OVA');
            const uniqueSeasons = [...new Set(searchableFiles.map(f => f.season))].sort((a, b) => a - b);

            const coreSeasons = [...new Set(group.files
                .filter(f => f.fileType === 'TV' || f.fileType === 'Movie')
                .map(f => f.season)
            )].sort((a, b) => a - b);

            // 🛡️ THE FILTER: Exactly 1 core season exists, AND that season is Season 1
            const isSingleSeasonOne = coreSeasons.length === 1 && (coreSeasons[0] === 1 || coreSeasons[0] === '1');

            for (const season of uniqueSeasons) {
                const targetFile = searchableFiles.find(f => f.season === season);

                // 2. Construct the search string
                let searchString = group.title;
                if (season > 1 && targetFile.fileType === 'TV') {
                    searchString += ` Season ${season}`;
                }

                // 3. The Two-Step AniList Search
                let aniListMatch = await getAnilistIdFromText(searchString);
                let currentEpisodeCount = null;

                if (!aniListMatch) {
                    // Fallback: Strip movie numbers/junk
                    let polishedString = searchString.replace(/(Movie)\s*\d*\s*-?\s*/gi, '').trim();
                    aniListMatch = await getAnilistIdFromText(polishedString);
                    if (aniListMatch) console.log(`Animist polished id ${aniListMatch.title}`);
                }

                if (aniListMatch && aniListMatch.title) {
                    group.seasonTitles[season] = aniListMatch.title;
                    currentEpisodeCount = aniListMatch.officialEpisodeCount;
                }

                // If AniList completely fails, fallback to the Fribb Master ID (safest for Season 1/Movies)
                let finalAnilistId = aniListMatch?.id;
                let officialMoviePoster = aniListMatch?.coverImage || null;

                const seasonFiles = group.files.filter(f => f.season === season);

                // 2. SET UP LOCAL DEFAULTS INSTANTLY
                seasonFiles.forEach(file => {
                    file.displayTitle = null;
                    file.displayThumbnail = null;
                    file.displaySeason = file.season;
                    file.relativeEpisode = null;
                    file.metadataSource = "None";

                    // Instantly process Themes so APIs never touch them
                    if (file.fileType === 'Theme') {
                        file.displayTitle = file.originalFile.short_name;
                        file.metadataSource = "Local";
                    }
                });

                // 4. FETCH ANIZIP THUMBNAILS
                if (finalAnilistId) {
                    try {
                        const azRes = await fetch(`https://api.ani.zip/mappings?anilist_id=${finalAnilistId}`);
                        if (azRes.ok) {
                            const azData = await azRes.json();
                            const epDict = azData.episodes || {};

                            // 5. ATTACH THE DATA TO YOUR LOCAL FILES
                            seasonFiles.forEach(file => {
                                if (file.fileType === 'Theme') return;

                                if (file.episode) {
                                    const epInt = parseInt(file.episode, 10);
                                    const epArray = Object.values(epDict);

                                    //console.log(file);

                                    let matchedEp = null;

                                    if (isSingleSeasonOne && (file.season === 1)) {
                                        matchedEp = epDict[epInt];
                                    } else {
                                        matchedEp = epArray.find(ep => ep.episodeNumber === epInt) ||
                                            epArray.find(ep => ep.absoluteEpisodeNumber === epInt) ||
                                            epArray.find(ep => ep.episode === epInt.toString());
                                    }

                                    if (matchedEp) {
                                        if (matchedEp.seasonNumber == file.season) {

                                            file.displayTitle = matchedEp.title?.en || matchedEp.title?.xIdx;
                                            file.displayThumbnail = matchedEp.image;
                                            file.relativeEpisode = matchedEp.episodeNumber;

                                            console.log(
                                                `✅ MATCHED | Local: S${season} E${epInt} ➡️ AniZip: ` +
                                                `Relative E${matchedEp.episodeNumber || 'N/A'} ` +
                                                `| Absolute E${matchedEp.absoluteEpisodeNumber || 'N/A'} ` +
                                                `| Season ${matchedEp.seasonNumber || 'N/A'} ` +
                                                `| Title: "${file.aniZipTitle}"`
                                            );
                                        } else {
                                            console.log(`${file.episode} has no season`);
                                        }
                                    }
                                }
                            });

                            // THE SPLIT-COUR DETECTOR
                            const otherPart = seasonFiles.filter(f => {
                                if (f.fileType === 'Theme') return false;

                                if (f.displayTitle) return false;

                                // 2. THE FIX: If the file has NO episode number at all (like your Movies), catch it and send it to Part 2!
                                if (!f.episode) return true;

                                // 3. If it has an episode number, check if it mathematically overflows the season
                                if (f.fileType === 'TV') {
                                    const epInt = parseInt(f.episode, 10);
                                    return currentEpisodeCount && epInt > currentEpisodeCount;
                                }

                                return false;
                            });

                            if (otherPart.length > 0) {
                                const sequelData = await getDirectSequel(finalAnilistId);

                                if (sequelData) {
                                    try {
                                        const sequelAzRes = await fetch(`https://api.ani.zip/mappings?anilist_id=${sequelData.id}`);
                                        group.seasonTitles[`${season} (Part 2)`] = sequelData.title;
                                        if (sequelAzRes.ok) {
                                            const sequelAzData = await sequelAzRes.json();
                                            const sequelEpArray = Object.values(sequelAzData.episodes || {});

                                            otherPart.forEach(file => {
                                                if (file.episode) {
                                                    const localEpInt = parseInt(file.episode, 10);

                                                    // Map directly using the Absolute Episode Number
                                                    const matchedEp = sequelEpArray.find(ep => ep.absoluteEpisodeNumber === localEpInt || ep.episodeNumber === localEpInt);

                                                    if (matchedEp) {
                                                        file.displayTitle = matchedEp.title?.en || matchedEp.title?.xIdx;
                                                        file.displayThumbnail = matchedEp.image;

                                                        // 📺 TV SHOW: The Split UI Method (New Tab)
                                                        file.relativeEpisode = matchedEp.episodeNumber;
                                                        file.displaySeason = `${season} (Part 2)`;
                                                    }
                                                } else {
                                                    // If the file has no episode number, its Part 2
                                                    file.displaySeason = `${season} (Part 2)`;
                                                }
                                            });
                                        }
                                    } catch (e) {
                                        console.warn(`⚠️ AniZip Sequel fetch failed for ID: ${sequelData.id}`);
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.warn(`⚠️ AniZip fetch failed for ID: ${finalAnilistId}`);
                    }
                }
                // THE ULTIMATE KITSU FALLBACK DETECTOR
                const kitsuQueue = seasonFiles.filter(f => !finalAnilistId || !f.displayTitle || !f.displayThumbnail);

                if (kitsuQueue.length > 0) {
                    await processKitsuFallback(kitsuQueue, group.title, season, animeIds?.kitsuId);
                }
            }
        }
    }

    // Render the final UI
    renderPickerUI(torrent, franchiseGroups, title, list, cleanName);
}

// ==========================================
// 2. THE PAINTER (UI Rendering)
// ==========================================
function renderPickerUI(torrent, franchiseGroups, titleElement, listElement, cleanName) {

    const groupKeys = Object.keys(franchiseGroups);
    const mainShowKey = groupKeys[0];

    if (mainShowKey && groupKeys.length > 1) {
        for (const key of groupKeys) {
            // Updated to use strict fileType checks
            if (key !== mainShowKey && (
                franchiseGroups[key].files.every(f => f.fileType === 'OVA' || f.fileType === 'Special') ||
                franchiseGroups[key].files.every(f => f.fileType === 'Theme')
            )) {
                franchiseGroups[mainShowKey].files.push(...franchiseGroups[key].files);
                delete franchiseGroups[key];
            }
        }
    }

    const uniqueShows = Object.keys(franchiseGroups);
    let currentShowKey = uniqueShows[0];

    const displayTitle = cleanName;

    let showSelectorHTML = '';
    if (uniqueShows.length > 1) {
        showSelectorHTML = `
            <select id="library-show-select" class="bg-slate-800 text-sm font-bold text-blue-400 border border-slate-600 rounded-lg p-1.5 outline-none cursor-pointer shadow-lg">
                ${uniqueShows.map(key => `<option value="${key}">${franchiseGroups[key].title}</option>`).join('')}
            </select>
        `;
    }

    // 3. Update the innerHTML to cluster everything together on the left
    titleElement.innerHTML = `
        <div class="flex flex-wrap items-center w-full gap-3 overflow-hidden px-1">
            <span class="font-bold text-slate-200 text-lg truncate shrink-0 max-w-full md:max-w-[50%]">
                ${displayTitle}
            </span> 
            <div class="flex flex-wrap items-center gap-2">
                ${showSelectorHTML}
                <div id="season-dropdown-container"></div>
            </div>
        </div>
    `;

    const seasonContainer = document.getElementById('season-dropdown-container');

    const renderSeason = (showKey, seasonFilter) => {
        listElement.innerHTML = '';

        const showData = franchiseGroups[showKey];

        let filesToRender = [];
        if (seasonFilter === 'themes') {
            filesToRender = showData.files.filter(f => f.fileType === 'Theme');
        } else if (seasonFilter === 'ovas') {
            filesToRender = showData.files.filter(f => f.fileType === 'OVA' || f.fileType === 'Special');
        } else {
            // FIX: Filter using the new displaySeason string
            // Safely falls back to the original f.season if displaySeason was never initialized
            filesToRender = showData.files.filter(f =>
                String(f.displaySeason || f.season) === String(seasonFilter) &&
                (f.fileType === 'TV' || f.fileType === 'Movie')
            );
        }

        filesToRender.sort((a, b) => {
            const valA = parseInt(a.episode);
            const valB = parseInt(b.episode);

            // If neither have a valid number, sort alphabetically by filename
            if (isNaN(valA) && isNaN(valB)) {
                return a.originalFile.name.localeCompare(b.originalFile.name);
            }

            return (isNaN(valA) ? 9999 : valA) - (isNaN(valB) ? 9999 : valB);
        });

        if (filesToRender.length === 0) {
            listElement.innerHTML = `<div class="col-span-full text-center text-slate-400 py-10">No files found for this category.</div>`;
            return;
        }

        filesToRender.forEach((fileObj, index) => {
            // FIX: Destructure displayTitle and displayThumbnail instead of aniZip equivalents
            const { originalFile, episode, relativeEpisode, displayTitle, displayThumbnail, fileType } = fileObj;

            let isThemeFile = fileType === 'Theme';
            let isOvaFile = (fileType === 'OVA' || fileType === 'Special');

            // FIX: Read from displayTitle
            let finalCardTitle = displayTitle || originalFile.short_name;
            let badgeText = isThemeFile ? '🎵 Theme' : (isOvaFile ? '⭐ Special' : `Episode ${relativeEpisode ?? episode ?? (index + 1)}`);
            let badgeColor = isThemeFile ? 'bg-emerald-600' : (isOvaFile ? 'bg-amber-600' : 'bg-blue-600');

            const fileSize = (originalFile.size / 1073741824).toFixed(2) + ' GB';
            const fallbackImage = document.getElementById(`img-${torrent.id}`)?.src || '';

            // FIX: Read from displayThumbnail
            const cardImage = displayThumbnail || fallbackImage;

            const card = document.createElement('div');
            card.className = "relative flex flex-col w-full rounded-xl border-2 border-slate-700 bg-slate-800 overflow-hidden cursor-pointer hover:border-blue-500 transition-all group select-none";

            const safeFileName = originalFile.name.replace(/'/g, "\\'").replace(/"/g, "&quot;");

            card.innerHTML = `
                <div class="relative aspect-video bg-slate-900 border-b border-slate-700 overflow-hidden">
                    <img src="${cardImage}" class="w-full h-full object-cover opacity-60 group-hover:opacity-40 transition-opacity">
                    
                    <div class="absolute inset-0 flex items-center justify-center gap-4 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                        <button onclick="event.stopPropagation(); downloadToOPFS(${torrent.id}, ${originalFile.id}, '${showData.title}', '${fallbackImage}', '${cardImage}', this);" class="bg-slate-800/90 hover:bg-slate-700 text-white w-10 h-10 flex items-center justify-center rounded-full backdrop-blur-md transition-colors shadow-xl border border-slate-600" title="Download to Device">
                            ⬇️
                        </button>
                        <div class="bg-blue-600/90 text-white w-10 h-10 flex items-center justify-center rounded-full backdrop-blur-md shadow-xl border border-blue-500 pointer-events-none">
                            ▶️
                        </div>
                    </div>

                    <div class="absolute bottom-2 right-2 bg-black/80 px-2 py-1 rounded text-[11px] text-white font-bold pointer-events-none">${fileSize}</div>
                </div>
                <div class="p-3 flex flex-col gap-1 pointer-events-none">
                    <span class="text-[10px] font-bold text-white px-2 py-0.5 rounded w-max ${badgeColor}">${badgeText}</span>
                    <p class="text-xs text-slate-300 line-clamp-2 mt-1 group-hover:text-white">${finalCardTitle}</p>
                </div>
            `;

            card.onclick = (e) => {
                // CRITICAL: Ignore clicks that originated from our download button
                if (e.target.closest('button')) return;

                if (appState.clickCooldown) return;
                appState.clickCooldown = true; setTimeout(() => appState.clickCooldown = false, 2000);
                closePicker();
                requestLink(torrent.id, originalFile.id, torrent.name, originalFile.name);
            };

            listElement.appendChild(card);
        });
    };

    // 4. Update the Season Dropdown logic
    const updateSeasonDropdown = (showKey) => {
        const showData = franchiseGroups[showKey];

        const hasOvas = showData.files.some(f => f.fileType === 'OVA' || f.fileType === 'Special');
        const hasThemes = showData.files.some(f => f.fileType === 'Theme');

        const standardSeasons = [...new Set(showData.files.filter(f => f.fileType === 'TV' || f.fileType === 'Movie').map(f => f.displaySeason || f.season))].sort((a, b) => {
            const numA = parseFloat(a);
            const numB = parseFloat(b);
            if (numA === numB) {
                return a.toString().localeCompare(b.toString());
            }
            return numA - numB;
        });

        let defaultSelection = standardSeasons.length > 0 ? standardSeasons[0] : (hasOvas ? 'ovas' : 'themes');

        // THE FIX: Count the total number of tabs. 
        const totalTabs = standardSeasons.length + (hasOvas ? 1 : 0) + (hasThemes ? 1 : 0);

        if (totalTabs > 1) {
            // Only draw the dropdown if there is actually a choice to make
            seasonContainer.innerHTML = `
                <select id="library-season-select" class="bg-slate-800 text-sm font-bold text-slate-200 border border-slate-600 rounded-lg p-1.5 outline-none cursor-pointer shadow-lg max-w-[180px] md:max-w-xs truncate">
                    ${standardSeasons.map(s => {
                // 👈 THE FIX: Check for a custom title, otherwise fallback to "Season X"
                const customTitle = showData.seasonTitles?.[s];
                const displayLabel = customTitle ? customTitle : `Season ${s}`;

                return `<option value="${s}">${displayLabel}</option>`;
            }).join('')}
                    ${hasOvas ? `<option value="ovas">⭐ Specials / OVAs</option>` : ''}
                    ${hasThemes ? `<option value="themes">🎵 Themes & Extras</option>` : ''}
                </select>
            `;

            document.getElementById('library-season-select').addEventListener('change', (e) => {
                renderSeason(showKey, e.target.value);
            });
        }

        // Render the default UI immediately regardless of the dropdown
        renderSeason(showKey, defaultSelection);
    };

    // Event listener for Mega Batch top menu
    if (uniqueShows.length > 1) {
        document.getElementById('library-show-select').addEventListener('change', (e) => {
            currentShowKey = e.target.value;
            updateSeasonDropdown(currentShowKey);
        });
    }

    // Initialize the UI
    updateSeasonDropdown(currentShowKey);
}

function closePicker() {
    document.getElementById('file-picker').classList.add('hidden');
}

// --- DEVICE (GHOST) LIBRARY LOGIC ---
let expectedLocalFile = null;

window.triggerLocalFilePicker = function (expectedName = null, expectedSize = null) {
    if (expectedName) {
        expectedLocalFile = { name: expectedName, size: expectedSize };
        showToast(`Please re-select: ${expectedName}`, 'info');
    } else {
        expectedLocalFile = null;
    }
    document.getElementById('local-file-input').click();
};

window.processLocalFile = async function (event) {
    const file = event.target.files[0];
    if (!file) return;

    event.target.value = '';

    if (expectedLocalFile) {
        if (file.name !== expectedLocalFile.name || file.size !== expectedLocalFile.size) {
            showToast(`Incorrect file! Expected: ${expectedLocalFile.name}`, 'error');
            return;
        }
    }

    const localVault = JSON.parse(localStorage.getItem('local_ghost_vault') || '{}');

    if (!localVault[file.name]) {
        showToast("Adding to library...", "info");
        const parsedData = parseTorrentio(file.name);

        let posterUrl = '';
        try {
            const tmdbData = await getPosterForLibrary(parsedData.title, parsedData.year);
            posterUrl = typeof tmdbData === 'string' ? tmdbData : (tmdbData?.poster || '');
        } catch (e) { console.warn("Could not fetch poster for local file."); }

        localVault[file.name] = {
            name: file.name,
            size: file.size,
            cleanTitle: parsedData.title,
            poster: posterUrl,
            lastPlayed: Date.now()
        };
        localStorage.setItem('local_ghost_vault', JSON.stringify(localVault));
        renderLocalLibrary();
    } else {
        localVault[file.name].lastPlayed = Date.now();
        localStorage.setItem('local_ghost_vault', JSON.stringify(localVault));
    }

    const fileBlobUrl = URL.createObjectURL(file);

    startPlayer(fileBlobUrl, file.name);
};

window.renderLocalLibrary = function () {
    const localVault = JSON.parse(localStorage.getItem('local_ghost_vault') || '{}');
    const files = Object.values(localVault).sort((a, b) => b.lastPlayed - a.lastPlayed);

    const list = document.getElementById('local-file-list');
    const emptyState = document.getElementById('local-empty-state');

    if (!list || !emptyState) return;

    list.innerHTML = '';

    if (files.length === 0) {
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    files.forEach(fileData => {
        const card = document.createElement('div');
        card.className = "relative flex-col cursor-pointer transition-transform hover:scale-105 select-none group";

        const fallbackInitials = (fileData.cleanTitle || "Unknown").substring(0, 2).toUpperCase();

        card.innerHTML = `
            <div class="relative w-full aspect-[2/3] bg-slate-800 rounded-lg shadow-lg overflow-hidden border border-slate-700/50">
                ${fileData.poster
                ? `<img src="${fileData.poster}" class="absolute inset-0 w-full h-full object-cover">`
                : `<div class="absolute inset-0 flex items-center justify-center p-4 text-center text-slate-500 font-bold text-2xl bg-slate-800">${fallbackInitials}</div>`
            }
                
                <div class="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-center items-center pb-4">
                    <div class="w-12 h-12 bg-emerald-500/90 rounded-full flex items-center justify-center text-white shadow-lg backdrop-blur-sm transform scale-75 group-hover:scale-100 transition-all">
                        <svg class="w-6 h-6 ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                    <span class="text-white text-[10px] font-bold mt-2 uppercase tracking-widest text-center px-2">Tap to re-link<br>and play</span>
                </div>
                
                <button onclick="event.stopPropagation(); deleteLocalGhost(\`${fileData.name.replace(/`/g, '')}\`)" class="absolute top-2 right-2 text-white bg-black/60 hover:bg-red-600 p-1.5 rounded-full transition opacity-0 group-hover:opacity-100 backdrop-blur-sm">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <p class="text-xs text-slate-300 mt-2 truncate font-semibold pl-1">${fileData.cleanTitle}</p>
        `;

        card.onclick = () => window.triggerLocalFilePicker(fileData.name, fileData.size);
        list.appendChild(card);
    });
};

window.deleteLocalGhost = function (fileName) {
    if (!confirm("Remove this from your device library? (The actual file will NOT be deleted from your device).")) return;

    const localVault = JSON.parse(localStorage.getItem('local_ghost_vault') || '{}');
    delete localVault[fileName];
    localStorage.setItem('local_ghost_vault', JSON.stringify(localVault));
    renderLocalLibrary();
};

window.renderLocalLibrary();

export async function downloadToOPFS(torrentId, fileId, folderName, fileName, posterUrl, thumbUrl, epTitle, epNumber, buttonElement) {
    if (appState.clickCooldown) return;

    // 1. Lock the button and show a spinner
    buttonElement.disabled = true;
    buttonElement.innerHTML = `<span class="animate-spin inline-block">⏳</span>`;

    const downloadUrl = await getTorboxLink(torrentId, fileId);
    if (!downloadUrl) {
        buttonElement.innerHTML = `⬇️`;
        buttonElement.disabled = false;
        return;
    }

    let wakeLock = null;

    try {
        // ---------------------------------------------------------
        // WAKE LOCK: Keep the screen on so the OS doesn't kill our JS thread
        // ---------------------------------------------------------
        if ('wakeLock' in navigator) {
            try {
                wakeLock = await navigator.wakeLock.request('screen');
                console.log('💡 Wake Lock active: Screen will not turn off.');
            } catch (err) {
                console.warn(`Wake Lock failed: ${err.message}`);
            }
        }

        // ---------------------------------------------------------
        // SANITIZER: Clean illegal characters from the filename
        // ---------------------------------------------------------
        const pathParts = fileName.split('/');
        let safeName = pathParts[pathParts.length - 1].replace(/[\\/:*?"<>|]/g, '_').trim();
        if (!safeName) safeName = `video_${Date.now()}.mkv`;

        // ---------------------------------------------------------
        // OPFS FOLDER ROUTING
        // ---------------------------------------------------------
        if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
        const opfsRoot = await navigator.storage.getDirectory();
        
        let targetDirectory = opfsRoot; // Default to root (for Movies)
        
        // If it's a TV Show, grab/create the specific folder
        if (folderName) {
            targetDirectory = await opfsRoot.getDirectoryHandle(folderName, { create: true });
        }

        if (posterUrl) {
            savePosterToOPFS(folderName || fileName, posterUrl);
        }

        const fileHandle = await targetDirectory.getFileHandle(safeName, { create: true });
        const writable = await fileHandle.createWritable();

        console.log(`📡 Fetching from CDN: ${downloadUrl}`);

        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

        const contentLength = response.headers.get('content-length');
        const total = parseInt(contentLength, 10);
        let loaded = 0;

        const reader = response.body.getReader();
        const progressStream = new ReadableStream({
            async start(controller) {
                while (true) {
                    const { done, value } = await reader.read();

                    if (done) {
                        controller.close();
                        break;
                    }

                    loaded += value.byteLength;

                    if (total) {
                        const percent = Math.round((loaded / total) * 100);
                        buttonElement.innerText = `${percent}%`;
                    } else {
                        const mbLoaded = (loaded / (1024 * 1024)).toFixed(0);
                        buttonElement.innerText = `${mbLoaded}M`;
                    }

                    controller.enqueue(value);
                }
            }
        });

        // PIPE IT TO THE HARD DRIVE
        await progressStream.pipeTo(writable);

        // Success!
        console.log(`✅ File saved to OPFS: ${safeName} ${folderName ? `in ${folderName}` : '(Root)'}`);
        buttonElement.innerHTML = '✅';
        buttonElement.classList.replace('text-white', 'text-emerald-400');
        buttonElement.classList.replace('hover:bg-slate-700', 'hover:bg-emerald-900');
        showToast(`Downloaded for offline viewing!`, 'success');

    } catch (error) {
        console.error("OPFS Download failed:", error);
        showToast(`Download failed: ${error.message}`, 'error');
        buttonElement.innerHTML = '⬇️';
        buttonElement.disabled = false;
    } finally {
        // ALWAYS release the wake lock so we don't drain the user's battery forever
        if (wakeLock !== null) {
            wakeLock.release().then(() => console.log('💡 Wake Lock released.'));
        }
    }
}

export async function savePosterToOPFS(showName, posterUrl) {
    if (!posterUrl || !showName) return;

    // 1. THE DEDUPLICATOR: Check our Master Catalog
    let catalog = JSON.parse(localStorage.getItem('offline_catalog') || '{}');

    // If we already saved this poster, exit immediately!
    if (catalog[showName] && catalog[showName].posterSaved) {
        console.log(`🖼️ Poster for "${showName}" already exists in OPFS. Skipping.`);
        return;
    }

    try {
        console.log(`🖼️ Downloading poster for "${showName}"...`);
        
        // 2. Fetch the image as raw binary data (Blob)
        const response = await fetch(posterUrl);
        if (!response.ok) throw new Error("Image fetch failed");
        const imageBlob = await response.blob();

        // 3. Save to the OPFS Warehouse
        const opfsRoot = await navigator.storage.getDirectory();
        
        // Use the exact same folder name logic we used for the video!
        const safeFolderName = showName.replace(/[\\/:*?"<>|]/g, '').trim();
        const showFolder = await opfsRoot.getDirectoryHandle(safeFolderName, { create: true });
        
        // Create a simple "poster.jpg" file
        const fileHandle = await showFolder.getFileHandle('poster.jpg', { create: true });
        const writable = await fileHandle.createWritable();
        
        // Write the blob and close the pipe
        await writable.write(imageBlob);
        await writable.close();

        // 4. Update the Master Catalog so we never download it again
        if (!catalog[showName]) catalog[showName] = {};
        catalog[showName].posterSaved = true;
        localStorage.setItem('offline_catalog', JSON.stringify(catalog));

        console.log(`✅ Poster saved to OPFS: ${safeFolderName}/poster.jpg`);

    } catch (e) {
        console.error("❌ Failed to save poster:", e);
    }
}

export async function saveEpisodeDataToOPFS(showName, epNumber, epTitle, thumbUrl) {
    if (!showName || epNumber == null) return;

    let catalog = JSON.parse(localStorage.getItem('offline_catalog') || '{}');

    // 1. Ensure the show structure exists
    if (!catalog[showName]) catalog[showName] = { posterSaved: false, episodes: {} };
    if (!catalog[showName].episodes) catalog[showName].episodes = {};

    // 2. THE DEDUPLICATOR: Check if this specific episode is already saved
    const epKey = `E${epNumber}`; // e.g., "E1" or "E12"
    if (catalog[showName].episodes[epKey] && catalog[showName].episodes[epKey].thumbSaved) {
        console.log(`🖼️ Thumbnail & Data for ${showName} ${epKey} already exists. Skipping.`);
        return;
    }

    try {
        const safeFolderName = showName.replace(/[\\/:*?"<>|]/g, '').trim();
        let thumbFileName = `${epKey}_thumb.jpg`; // e.g., "E1_thumb.jpg"

        // 3. Download and save the thumbnail Blob (if it exists)
        if (thumbUrl) {
            console.log(`🖼️ Downloading thumbnail for ${showName} ${epKey}...`);
            const response = await fetch(thumbUrl);
            if (response.ok) {
                const imageBlob = await response.blob();
                const opfsRoot = await navigator.storage.getDirectory();
                const showFolder = await opfsRoot.getDirectoryHandle(safeFolderName, { create: true });
                
                const fileHandle = await showFolder.getFileHandle(thumbFileName, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(imageBlob);
                await writable.close();
            } else {
                thumbFileName = null; // Fetch failed
            }
        } else {
            thumbFileName = null; // No thumbnail provided by API
        }

        // 4. Save the text data & thumb pointer to your Database!
        catalog[showName].episodes[epKey] = {
            title: epTitle,
            episodeNumber: epNumber,
            thumbSaved: !!thumbFileName,
            thumbFileName: thumbFileName
        };
        
        localStorage.setItem('offline_catalog', JSON.stringify(catalog));
        console.log(`✅ Episode Data saved to catalog for ${epKey}`);

    } catch (e) {
        console.error("❌ Failed to save episode metadata:", e);
    }
}

// --- OPFS LOCAL STORAGE SCANNER ---
export async function scanLocalOPFSDirectory() {
    try {
        // 1. Safety check to make sure the browser supports OPFS
        if (!navigator.storage || !navigator.storage.getDirectory) {
            console.warn("OPFS is not supported in this environment.");
            return;
        }

        // 2. Open the root directory of your app's virtual hard drive
        const opfsRoot = await navigator.storage.getDirectory();
        console.log("🗄️ Scanning OPFS Local Storage...");

        let fileCount = 0;
        let totalBytes = 0;

        // 3. Loop through every file inside the OPFS root
        // OPFS uses async iterators, so we use a 'for await' loop
        for await (const [name, handle] of opfsRoot.entries()) {
            if (handle.kind === 'file') {
                // To get the size, we have to extract the actual File object from the Handle
                const file = await handle.getFile();
                const sizeMB = (file.size / (1024 * 1024)).toFixed(2);

                console.log(`🎬 Found: "${name}" | Size: ${sizeMB} MB`);

                fileCount++;
                totalBytes += file.size;
            }
        }

        // 4. Print a summary
        if (fileCount === 0) {
            console.log("📭 OPFS is currently empty.");
        } else {
            const totalGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(2);
            console.log(`📊 OPFS Summary: ${fileCount} files, using ${totalGB} GB total.`);
        }

    } catch (error) {
        console.error("❌ Failed to read OPFS directory:", error);
    }
}

//#region Search
let searchTimeout = null;

export function handleSearch() {
    const query = document.getElementById('search-input').value.toLowerCase().trim();

    if (query.startsWith('http') || query.startsWith('magnet:')) {
        document.getElementById('global-search-results').classList.add('hidden');
        return;
    }

    const filtered = allTorrents.filter(t => t.name.toLowerCase().includes(query));
    renderList(filtered);

    clearTimeout(searchTimeout);

    if (query.length >= 3) {
        searchTimeout = setTimeout(() => {
            // Auto-switch to the discover tab for the best viewing experience!
            showDiscoverTab();
            searchTMDB(query);
        }, 500);
    } else {
        document.getElementById('global-search-results').classList.add('hidden');
    }
}

function handleSearchSubmit() {
    const query = document.getElementById('search-input').value.trim();
    const inputField = document.getElementById('search-input');

    if (query.startsWith('http://') || query.startsWith('https://')) {
        inputField.blur();
        startPlayer(query, "Direct Stream");
        return;
    }

    if (query.startsWith('magnet:')) {
        inputField.blur();
        if (typeof addMagnetToTorBox === 'function') {
            addMagnetToTorBox(query, (err, res) => {
                if (!err) {
                    showToast(`Added: ${res.name}`, 'success');
                    inputField.value = "";
                    refreshLibrary();
                }
            });
        } else {
            showToast("Magnet adding function not implemented yet.");
        }
        return;
    }

    inputField.blur();
}

// --- DELETE TORRENT ---
async function deleteTorrent(torrentId, event) {
    if (event) event.stopPropagation();
    if (!confirm("Are you sure you want to delete this from TorBox?")) return;

    const key = localStorage.getItem('tb_api_key');
    const targetUrl = 'https://api.torbox.app/v1/api/torrents/controltorrent';

    try {
        const res = await smartFetch(targetUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                torrent_id: torrentId,
                operation: "delete"
            })
        });

        const data = await res.json();

        if (data.success) {
            showToast("Deleted successfully!", 'success');
            refreshLibrary();
        } else {
            showToast("Error: " + data.detail, 'error');
        }
    } catch (e) {
        console.error("Delete Error:", e);
        showToast("Failed to delete torrent.", 'error');
    }
}

// --- TAB NAVIGATION UI ---
export function showLibraryTab() {
    // 1. Swap the content
    document.getElementById('discover-tab').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');

    // 2. Light up the Library button (Blue)
    const libBtn = document.getElementById('tab-library');
    libBtn.className = "flex-1 py-2.5 rounded-lg bg-blue-600 text-white font-bold text-sm shadow transition-all";

    // 3. Dim the Discover button (Gray)
    const discBtn = document.getElementById('tab-discover');
    discBtn.className = "flex-1 py-2.5 rounded-lg text-slate-400 font-bold text-sm hover:text-white hover:bg-slate-700/50 transition-all";
}

export function showDiscoverTab() {
    // 1. Swap the content
    document.getElementById('dashboard').classList.add('hidden');
    document.getElementById('discover-tab').classList.remove('hidden');

    // 2. Light up the Discover button (Blue)
    const discBtn = document.getElementById('tab-discover');
    discBtn.className = "flex-1 py-2.5 rounded-lg bg-blue-600 text-white font-bold text-sm shadow transition-all";

    // 3. Dim the Library button (Gray)
    const libBtn = document.getElementById('tab-library');
    libBtn.className = "flex-1 py-2.5 rounded-lg text-slate-400 font-bold text-sm hover:text-white hover:bg-slate-700/50 transition-all";

    // Only fetch from the API if the grid is empty!
    if (document.getElementById('trending-row').innerHTML.trim() === '') {
        loadDiscover();
    }
}

// Attach to the window object so your HTML buttons can trigger them
window.showLibraryTab = showLibraryTab;
window.showDiscoverTab = showDiscoverTab;

// Close dropdown when clicking outside
window.onclick = function (event) {
    if (!event.target.closest('.w-10') && !event.target.closest('#profile-dropdown')) {
        document.getElementById('profile-dropdown').classList.add('hidden');
    }
}

// Global variable to hold the active stream URL
appState.currentStreamUrl = "";

function openExternalPlayer(player) {
    const videoUrl = appState.currentStreamUrl;

    if (!videoUrl) {
        showToast("No video stream selected yet.", "error");
        return;
    }

    if (videoUrl.startsWith('blob:')) {
        showToast("Local device files cannot be cast to external players. Please play them directly in the browser.", "error");
        document.getElementById('external-player-modal').classList.add('hidden');
        return;
    }

    const encodedUrl = encodeURIComponent(videoUrl);
    let deepLink = '';

    switch (player) {
        case 'vlc':
            deepLink = videoUrl.replace(/^https?:\/\//i, 'vlc://');
            break;

        case 'infuse':
            deepLink = `infuse://x-callback-url/play?url=${encodedUrl}`;
            break;

        case 'outplayer':
            deepLink = `outplayer://${encodedUrl}`;
            break;

        case 'mxplayer':
            deepLink = `intent:${videoUrl}#Intent;package=com.mxtech.videoplayer.ad;S.title=${encodeURIComponent("TorBox Stream")};end`;
            break;

        case 'iina':
            deepLink = `iina://weblink?url=${encodedUrl}`;
            break;
    }

    // Hide the modal
    document.getElementById('external-player-modal').classList.add('hidden');

    // Trigger the OS app
    window.location.href = deepLink;
}

// -------------------------------------------------------------
// --- GLOBAL EXPORTS  ---
// -------------------------------------------------------------
window.authenticateTorboxUser = authenticateTorboxUser;
window.playDirect = playDirect;
window.goHome = goHome;
window.handleSearch = handleSearch;
window.handleSearchSubmit = handleSearchSubmit;
window.toggleProfile = toggleProfile;
window.logoutTorBox = logoutTorBox;
window.closePicker = closePicker;
window.deleteTorrent = deleteTorrent;
window.openExternalPlayer = openExternalPlayer;
window.downloadToOPFS = downloadToOPFS;