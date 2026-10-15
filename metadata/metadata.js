/**
 * ==========================================
 * metadata.js
 * Handles all TMDB, AniList, and Kitsu interactions for the library matching
 * ==========================================
 */

// We need your TMDB key from your existing api.js file
import { TMDB_KEY } from '../services/config.js';

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


export async function getTmdbShowDetails(tmdbId) {
    try {
        const url = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_KEY}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('TMDB Fetch Failed');
        return await res.json();
    } catch (e) {
        console.error(e);
        return null;
    }
}

// 2. Fetch a specific season to get high-quality thumbnails and titles
export async function getTmdbSeasonEpisodes(tmdbId, seasonNumber) {
    try {
        const url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}?api_key=${TMDB_KEY}`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const data = await res.json();
        return data.episodes || [];
    } catch (e) {
        console.error(e);
        return [];
    }
}