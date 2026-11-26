/**
 * ==========================================
 * metadata.js
 * Handles all TMDB, AniList, and Kitsu interactions for the library matching
 * ==========================================
 */

// We need your TMDB key from your existing api.js file
import { TMDB_KEY } from '../services/config.js';
import { smartFetch } from '../services/config.js';

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
                return { id: data.results[1].id, officialName: data.results[1].name || data.results[1].title, full: data.results[1] };
            } else {
                return { id: data.results[0].id, officialName: data.results[0].name || data.results[0].title, full: data.results[0] };
            }
        }

        return null; // No match found
    } catch (error) {
        console.error("Failed to fetch TMDB ID:", error);
        return null;
    }
}
//#endregion

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

export async function fetchMediaMetadata(id, baseUrl, type) {
    if (!id || !type) return null;

    try {
        const mediaType = baseUrl
            ? (type === 'tv' ? 'series' : type)
            : (type === 'series' ? 'tv' : type);
        const url = baseUrl
            ? `${baseUrl.replace(/\/+$/, '')}/meta/${mediaType}/${id}.json`
            : `https://api.themoviedb.org/3/${mediaType}/${id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits,external_ids`;
        const response = baseUrl ? await smartFetch(url) : await fetch(url);
        if (!response.ok) throw new Error(`Metadata fetch failed: ${response.status}`);

        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Failed to fetch media metadata:', error);
        return null;
    }
}

// Normalize common fields and retain all provider-specific data in raw.
export function formatMediaMetadata(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    const isAddon = Object.prototype.hasOwnProperty.call(result, 'meta');
    const data = isAddon ? result.meta : result;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

    const toArray = value => value == null || value === '' ? [] : Array.isArray(value) ? value : [value];
    const names = value => toArray(value).map(item => typeof item === 'string' ? item : item?.name).filter(Boolean);
    const imageUrl = (path, size) => typeof path !== 'string' || !path
        ? '' : path.startsWith('/') ? `https://image.tmdb.org/t/p/${size}${path}` : path;
    const releaseDate = data.release_date || data.first_air_date || data.released || null;
    const year = parseInt(data.year || data.releaseInfo || releaseDate, 10);
    const runtime = data.runtime ?? data.episode_run_time?.[0] ?? null;
    const rating = parseFloat(data.vote_average ?? data.imdbRating ?? data.rating);
    const tmdbId = data._tmdbId ?? data.tmdb_id ?? data.tmdbId ?? data.external_ids?.tmdb_id
        ?? (isAddon ? null : data.id ?? null);
    const imdbId = data.external_ids?.imdb_id || data._imdbId || data.imdb_id || data.imdbId
        || (/^tt\d+$/.test(String(data.id)) ? data.id : null);
    const type = data.type || data.media_type || (data.first_air_date ? 'tv' : data.release_date ? 'movie' : null);
    const genres = names(data.genres ?? data.genre);
    const crew = Array.isArray(data.credits?.crew) ? data.credits.crew : [];

    return {
        id: data.id ?? null,
        tmdbId,
        imdbId,
        externalIds: { ...data.external_ids, tmdb_id: tmdbId, imdb_id: imdbId },
        type: type === 'series' ? 'tv' : type,
        title: data.title || data.name || '',
        originalTitle: data.original_title || data.original_name || data.title || data.name || '',
        poster: imageUrl(data.poster || data.poster_path, 'w500'),
        backdrop: imageUrl(data.background || data.backdrop || data.backdrop_path, 'original'),
        logo: imageUrl(data.logo, 'original'),
        description: data.description || data.overview || '',
        tagline: data.tagline || '',
        year: Number.isFinite(year) ? year : null,
        releaseDate,
        releaseInfo: data.releaseInfo || '',
        runtime: typeof runtime === 'number' ? `${runtime}m` : runtime || '',
        rating: Number.isFinite(rating) ? rating : null,
        voteCount: data.vote_count ?? null,
        genres,
        cast: names(data.credits?.cast ?? data.app_extras?.cast ?? data.cast),
        directors: names(data.director ?? crew.filter(person => person.job === 'Director')),
        writers: names(data.writer ?? crew.filter(person => ['Writer', 'Screenplay', 'Story'].includes(person.job))),
        countries: names(data.country ?? data.production_countries),
        languages: toArray(data.spoken_languages).map(language => language?.english_name || language?.name).filter(Boolean),
        originalLanguage: data.original_language || '',
        status: data.status || '',
        homepage: data.homepage || '',
        trailers: data.trailers ?? data.videos?.results ?? [],
        raw: data
    };
}
