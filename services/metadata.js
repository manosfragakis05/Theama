/**
 * ==========================================
 * metadata.js
 * Handles all TMDB, AniList, and Kitsu interactions for the library matching
 * ==========================================
 */

// We need your TMDB key from your existing api.js file
import { TMDB_KEY } from './config.js';

//#region TMDB Logic
export async function getPosterForLibrary(tmdbId, type) {
    try {
        const url = `https://api.themoviedb.org/3/${type}/${tmdbId}/images?api_key=${TMDB_KEY}&include_image_language=en,ja,null`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.posters && data.posters.length > 0) {
            return `https://image.tmdb.org/t/p/w500${data.posters[0].file_path}`;
        }
        return null;
    } catch (e) {
        console.warn(`Failed to fetch poster for ID: ${tmdbId}`, e);
        return null;
    }
}

// Fetch TMDB ID from a string
/**
 * @param {string} title
 * @param {number|string} year
 * @param {string} type
 * @returns {Promise<number|null>}
 */
export async function getTmdbId(title, year, type = 'tv') {
    if (!title) return null;
    console.log(title, year, type);

    // Replace with your actual TMDB API key or fetch from your config
    const apiKey = TMDB_KEY;
    const encodedTitle = encodeURIComponent(title.trim());

    let url = '';

    if (type.toLowerCase() === 'movie') {
        url = `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodedTitle}`;
        if (year) url += `&primary_release_year=${year}`;
    } else {
        url = `https://api.themoviedb.org/3/search/tv?api_key=${apiKey}&query=${encodedTitle}`;
        if (year) url += `&first_air_date_year=${year}`;
    }

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`TMDB API error: ${response.status}`);

        const data = await response.json();
        
        // Return the first result's ID
        if (data.results && data.results.length > 0) {
            if(data.results.length > 1 && (data.results[1]?.vote_count > data.results[0]?.vote_count)) {
                return { id: data.results[1].id, officialName: data.results[1].name || data.results[1].title };
            } else {
                return { id: data.results[0].id, officialName: data.results[0].name || data.results[0].title };
            }
        }

        return null; // No match found
    } catch (error) {
        console.error("Failed to fetch TMDB ID:", error);
        return null;
    }
}
//#endregion


//#region AniList Logic
// This queue prevents strict AniList Rate Limits (90/min) from blocking requests.
let anilistQueue = Promise.resolve();

export async function getAnilistIdFromText(searchText) {
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

        if (!res.ok) {
            const errText = await res.text();
            console.error(`🚨 AniList API Error (${res.status}):`, errText, "Search Sting:", searchText);
            return null;
        }

        const json = await res.json();

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
        console.error("🚨 AniList Network/Fetch Exception:", e);
        return null;
    }
}

export async function getDirectSequel(currentAnilistId) {
    await (anilistQueue = anilistQueue.then(() => new Promise(r => setTimeout(r, 150))).catch(() => { }));

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
//#endregion


//#region Kitsu Logic
export async function fetchAllKitsuEpisodes(kitsuId) {
    let allEpisodes = [];
    let offset = 0;
    const limit = 20;
    let keepFetching = true;

    while (keepFetching) {
        try {
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

            if (newEpisodes.length < limit) {
                keepFetching = false;
            } else {
                offset += limit;
                await new Promise(resolve => setTimeout(resolve, 150));
            }

        } catch (e) {
            console.warn(`⚠️ Kitsu pagination failed at offset ${offset}`, e);
            keepFetching = false;
        }
    }

    return allEpisodes;
}

export async function processKitsuFallback(kitsuQueue, cleanTitle, season, mappedKitsuId) {
    if (!kitsuQueue || kitsuQueue.length === 0) return;
    console.log(`🦊 Kitsu Fallback triggered for S${season} (${kitsuQueue.length} files)`);

    let targetKitsuId = mappedKitsuId;
    let fallbackPoster = null;
    let fallbackTitle = cleanTitle;

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

    if (!targetKitsuId) {
        console.warn(`❌ Kitsu Fallback failed: Could not find target ID for ${cleanTitle} S${season}.`);
        kitsuQueue.forEach(file => {
            file.displayTitle = file.episode ? `Episode ${file.episode}` : cleanTitle;
            file.displayThumbnail = fallbackPoster;
            file.relativeEpisode = file.episode;
        });
        return;
    }

    const fetchedEpisodes = await fetchAllKitsuEpisodes(targetKitsuId);
    console.log(`🦊 Kitsu found ${fetchedEpisodes.length} total episodes for ID ${targetKitsuId}`);

    for (const file of kitsuQueue) {
        if (!file.episode || file.fileType !== 'TV') {
            file.displayTitle = fallbackTitle;
            file.displayThumbnail = fallbackPoster;
            continue;
        }

        const fileEpInt = parseInt(file.episode, 10);

        const epMatch = fetchedEpisodes.find(ep =>
            ep.attributes?.relativeNumber === fileEpInt ||
            ep.attributes?.number === fileEpInt
        );

        if (epMatch) {
            file.displayTitle = epMatch.attributes?.canonicalTitle || `Episode ${file.episode}`;
            file.displayThumbnail = epMatch.attributes?.thumbnail?.original || fallbackPoster;
            file.relativeEpisode = epMatch.attributes?.number || epMatch.attributes?.relativeNumber || file.episode;
        } else {
            file.displayTitle = `Episode ${file.episode}`;
            file.displayThumbnail = fallbackPoster;
            file.relativeEpisode = file.episode;
        }
    }
}

export async function searchKitsuText(searchString) {
    try {
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
                poster: match.attributes?.posterImage?.large || match.attributes?.posterImage?.original
            };
        }
    } catch (e) {
        console.error("🦊 Kitsu search failed:", e);
    }
    return null;
}
//#endregion
