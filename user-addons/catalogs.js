import { TMDB_KEY } from "../services/config";
import {
    initGlobalDrag,
    renderRow,
    renderSelectedCatalog,
    populateTypeDropdown,
    populateCatalogDropdown,
    showRowMessage,
    initGlobalClickListener,
    rearmObservers
} from "./catalog-renderer";

// APP BOOTER
function handleTypeChange(e) {
    populateCatalogDropdown(getCatalogsByType(e.target.value));
    renderSelectedCatalog();
}
function handleCatalogChange() {
    renderSelectedCatalog();
}

export async function loadDiscover() {
    initGlobalDrag();
    initCustomCatalogsState();
    initGlobalClickListener();

    const typeSelect = document.getElementById('discover-type-select');
    const catalogSelect = document.getElementById('discover-catalog-select');

    populateTypeDropdown(getAvailableTypes());
    if (typeSelect && typeSelect.value) {
        populateCatalogDropdown(getCatalogsByType(typeSelect.value));
    }

    typeSelect?.removeEventListener('change', handleTypeChange);
    typeSelect?.addEventListener('change', handleTypeChange);
    catalogSelect?.removeEventListener('change', handleCatalogChange);
    catalogSelect?.addEventListener('change', handleCatalogChange);

    if (catalogSelect && catalogSelect.value) {
        renderSelectedCatalog();
    }
}

// Get or change a catalogs state
export function getActiveState(targetId) {
    // Check TMDB dictionary
    for (const type in rowState) {
        if (rowState[type][targetId]) {
            return rowState[type][targetId];
        }
    }

    // Check Add-on dictionary
    for (const type in addonState) {
        if (addonState[type][targetId]) {
            return addonState[type][targetId];
        }
    }

    return null;
}

export function getAvailableTypes() {
    // Reusing your exact current logic
    const tmdbTypes = Object.keys(rowState).filter(type => type !== 'other');
    const addonTypes = Object.keys(addonState);
    return [...new Set([...tmdbTypes, ...addonTypes])];
}

export function getCatalogsByType(type) {
    // Flatten both state dictionaries into a single array of objects
    const tmdbCatalogs = rowState[type] ? Object.values(rowState[type]) : [];
    const addonCatalogs = addonState[type] ? Object.values(addonState[type]) : [];

    return [...tmdbCatalogs, ...addonCatalogs];
}

//#region TMDB Data
export const rowState = {
    movie: {
        'trending-movies-row': { containerId: 'trending-movies-row', title: 'Trending Movies', addonName: 'TMDB', type: 'movie', page: 1, endpoint: 'trending/movie/week', loading: false, hasOptions: false, hasMore: true },
        'top-row': { containerId: 'top-row', title: 'Top Rated Movies', addonName: 'TMDB', type: 'movie', page: 1, endpoint: 'movie/top_rated', loading: false, hasOptions: false, hasMore: true },
        'action-row': { containerId: 'action-row', title: 'Action Blockbusters', addonName: 'TMDB', type: 'movie', page: 1, endpoint: 'discover/movie?with_genres=28&sort_by=vote_count.desc&vote_average.gte=7&vote_count.gte=3000', loading: false, hasOptions: false, hasMore: true },
        'comedy-row': { containerId: 'comedy-row', title: 'Comedies', addonName: 'TMDB', type: 'movie', page: 1, endpoint: 'discover/movie?with_genres=35&sort_by=vote_count.desc&vote_average.gte=6.5&vote_count.gte=2000', loading: false, hasOptions: false, hasMore: true },
        'thriller-row': { containerId: 'thriller-row', title: 'Thrillers', addonName: 'TMDB', type: 'movie', page: 1, endpoint: 'discover/movie?with_genres=53&without_genres=27,28&sort_by=vote_count.desc&vote_average.gte=7.5&vote_count.gte=1500', loading: false, hasOptions: false, hasMore: true }
    },
    series: {
        'trending-shows-row': { containerId: 'trending-shows-row', title: 'Trending Series', addonName: 'TMDB', type: 'tv', page: 1, endpoint: 'trending/tv/week', loading: false, hasOptions: false, hasMore: true },
        'anime-row': { containerId: 'anime-row', title: 'Top Anime', addonName: 'TMDB', type: 'tv', page: 1, endpoint: 'discover/tv?with_genres=16&with_original_language=ja&sort_by=vote_count.desc&vote_count.gte=500', loading: false, hasOptions: false, hasMore: true }
    },
    other: {
        // Kept separate so the global search doesn't render as a standard row
        'global-search-grid': { containerId: 'global-search-grid', title: 'Search', addonName: 'TMDB', type: 'other', page: 1, endpoint: 'search/multi', query: '', loading: false, hasOptions: false, hasMore: true }
    }
};

// Fetch card data
export async function fetchTMDBEndpoint(endpoint, page = 1, signal) {
    const base = `https://api.themoviedb.org/3/`;
    const url = new URL(endpoint.startsWith('http') ? endpoint : base + endpoint);

    url.searchParams.append('api_key', TMDB_KEY);
    url.searchParams.append('language', 'en-US');
    url.searchParams.append('page', page.toString());

    const response = await fetch(url.toString(), { signal });
    if (!response.ok) throw new Error(`TMDB status: ${response.status}`);

    return await response.json();
}

// Global search
export async function searchTMDB(query) {
    const containerId = 'global-search-grid';
    const container = document.getElementById('global-search-results');
    const row = document.getElementById(containerId);

    if (!container || !row) return;

    container.classList.remove('hidden');

    const state = rowState.other[containerId];
    state.query = query;
    state.page = 1;
    state.hasMore = true;
    state.loading = true;
    state.items = [];
    state.idSet = new Set();
    state.cardEls?.clear();

    try {
        const endpoint = `search/multi?query=${encodeURIComponent(query)}&include_adult=false`;
        const data = await fetchTMDBEndpoint(endpoint, 1);

        row.replaceChildren();

        state.hasMore = data.page < data.total_pages;

        // Advance to next page so fetchNextBatch requests page 2
        if (state.hasMore) {
            state.page = 2;
        }

        const prunedItems = (data.results || [])
            .map(item => {
                const rawType = item.type || item.media_type || "movie";
                return {
                    id: item.id,
                    title: item.name || item.title || "Untitled",
                    year: item.releaseInfo || item.year || parseInt(item.release_date) || parseInt(item.first_air_date) || "N/A",
                    type: rawType,
                    poster: resolveImageUrl(item.poster || item.poster_path, 'w500'),
                    backdrop: resolveImageUrl(item.backdrop_path || item.backdrop || item.background_path || item.background, 'original')
                };
            })
            .filter(item => item.id != null && item.type !== 'person');

        prunedItems.forEach(item => state.idSet.add(item.id));
        state.items = prunedItems;

        renderRow(prunedItems, state);

    } catch (e) {
        console.error("Search failed:", e);
        showRowMessage(containerId, "Error");
        state.hasMore = false;
    } finally {
        state.loading = false;
    }
}
//#endregion

//#region Custom Metadata
export function getCatalogProviders() {
    let userAddons = [];
    try {
        userAddons = JSON.parse(localStorage.getItem('user_addons')) || [];
    } catch (err) {
        console.error("Corrupted user_addons in localStorage:", err);
    }
    return userAddons.filter(addon => addon.capabilities && addon.capabilities.catalogs === true && addon.catalogs.length > 0);
}

// Initialise all addons
export const addonState = {};

export function initCustomCatalogsState() {
    for (const type in addonState) delete addonState[type];

    const addons = getCatalogProviders();

    // Iterate every addon
    for (const addon of addons) {
        const baseUrl = addon.url.replace(/\/manifest\.json$/, '');
        const addonKey = baseUrl.replace(/[^a-zA-Z0-9]/g, '-');

        // Iterate every catalog per addon
        for (const catalog of addon.catalogs) {
            // Check if the type bucket already exists
            if (!addonState[catalog.type]) {
                addonState[catalog.type] = {};
            }

            // HTML needs a unique id per catalog
            let catalogId = `${addonKey}-${catalog.type}-${catalog.id}`.replace(/[^a-zA-Z0-9-]/g, '-');

            if (addonState[catalog.type][catalogId]) {
                let i = 2;
                while (addonState[catalog.type][`${catalogId}-${i}`]) i++;
                catalogId = `${catalogId}-${i}`;
            }

            // Options, skip, custom attributes like showInHome
            const extra = catalog.extra || [];

            // Check if it accepts parameters
            const supportsOption = extra.some(param => Array.isArray(param.options) && param.options.length > 0);

            // Check if it supports pages
            const supportsPagination = extra.some(param => param.name === 'skip');

            // Push the formatted catalog state in its type bucket
            addonState[catalog.type][catalogId] = {
                addonName: addon.name,
                containerId: catalogId,

                // Basic attributes
                title: catalog.name || catalog.id,
                baseUrl: baseUrl,
                urlId: catalog.id,
                type: catalog.type,

                extra: extra,  // Contains options
                skip: 0,
                loading: false,
                hasOptions: supportsOption,
                paginated: supportsPagination,  // static capability
                hasMore: true,

            };
        }
    }
}

// UNIVERSAL DATA FETCHER - THE CONTAINER CALLS FOR THE DATA
export async function fetchNextBatch(containerId) {
    const catalogObject = getActiveState(containerId);

    // Safety checks: Invalid ID, already loading, or permanently out of data
    if (!catalogObject || catalogObject.loading || catalogObject.hasMore === false) return [];

    // Lock the state to prevent duplicate observer triggers
    catalogObject.loading = true;
    const controller = new AbortController();
    catalogObject.abortController = controller;

    try {
        let newItems = [];

        // TMDB Logic
        if (catalogObject.endpoint) {
            let fetchUrl = catalogObject.endpoint;

            if (containerId === 'global-search-grid' && catalogObject.query) {
                fetchUrl = `search/multi?query=${encodeURIComponent(catalogObject.query)}&include_adult=false`;
            }

            // Fetch using the current page state
            const data = await fetchTMDBEndpoint(fetchUrl, catalogObject.page || 1, controller.signal)
            newItems = data.results || [];

            // Increment page for the next horizontal scroll, or disable pagination
            if (newItems.length > 0 && catalogObject.page < data.total_pages) {
                catalogObject.page = (catalogObject.page || 1) + 1;
            } else {
                catalogObject.hasMore = false;
            }
        }
        // Route 2: Stremio Add-on Logic
        else {
            const metas = await fetchAddonCatalog(catalogObject, controller.signal);
            if (metas === null) {
                catalogObject.loading = false;
                return [];
            }
            newItems = metas;

            // Increment skip by the exact amount of items returned
            if (newItems.length > 0 && catalogObject.paginated) {
                catalogObject.skip = (catalogObject.skip || 0) + newItems.length;
            } else {
                catalogObject.hasMore = false;
            }
        }

        if (newItems.length > 0) {
            if (!catalogObject.idSet) {
                catalogObject.idSet = new Set((catalogObject.items || []).map(i => i.id));
            }

            // FINISHED BASIC CARD DETAILS
            const prunedItems = newItems
                .map(item => {
                    const rawType = item.type || item.media_type || catalogObject.type || "movie";

                    const rawCast = item.app_extras?.cast || item.cast;
                    const formattedCast = Array.isArray(rawCast)
                        ? rawCast.slice(0, 5).map(c => c.name || c).join(', ')
                        : '';

                    return {
                        id: item.id,
                        title: item.name || item.title || "Untitled",
                        year: item.releaseInfo || item.year || parseInt(item.release_date) || parseInt(item.first_air_date) || "N/A",
                        type: rawType,

                        poster: resolveImageUrl(item.poster || item.poster_path, 'w500'),
                        backdrop: resolveImageUrl(item.backdrop_path || item.backdrop || item.background_path || item.background, 'original'),

                        overview: item.description || item.overview || '',
                        runtime: item.runtime || '',
                        rating: (item.vote_average || item.imdbRating) ? parseFloat(item.vote_average || item.imdbRating).toFixed(1) : '',
                        genre: item.genre || (item.genres?.length > 0 ? item.genres[0] : ''),
                        cast: formattedCast
                    };
                })
                .filter(item => item.id != null && item.type !== 'person' && !catalogObject.idSet.has(item.id));

            if (prunedItems.length > 0) {
                prunedItems.forEach(item => catalogObject.idSet.add(item.id));

                catalogObject.items = catalogObject.items || [];
                catalogObject.items.push(...prunedItems);
                catalogObject.duplicateStreak = 0;

                renderRow(prunedItems, catalogObject);
            } else {
                catalogObject.duplicateStreak = (catalogObject.duplicateStreak || 0) + 1;

                if (catalogObject.duplicateStreak >= 2) {
                    catalogObject.hasMore = false;
                } else {
                    rearmObservers(containerId, catalogObject.hasMore);
                }
            }
        } else if (!catalogObject.items || catalogObject.items.length === 0) {
            showRowMessage(containerId, "Failed to fetch items");
        }

        catalogObject.loading = false;
        return newItems;
    } catch (err) {
        if (err.name === 'AbortError') return []; // cancelled on purpose, not a failure
        console.error(`fetchNextBatch failed for ${containerId}:`, err);
        showRowMessage(containerId, "Something went wrong");
        return [];
    } finally {
        catalogObject.loading = false;
    }
}

// Helper for images
function resolveImageUrl(path, size = 'w500') {
    if (!path) return null;

    // If the add-on already provided a full URL, return it immediately
    if (path.startsWith('http://') || path.startsWith('https://')) {
        return path;
    }

    // Ensure TMDB relative paths have a leading slash before appending
    const safePath = path.startsWith('/') ? path : `/${path}`;
    return `https://image.tmdb.org/t/p/${size}${safePath}`;
}

// Fetch single catalog
export async function fetchAddonCatalog(catalogObject, signal) {
    // Destructure the object
    const { baseUrl, type, urlId, extra, skip } = catalogObject;

    let extraParams = [];

    if (catalogObject.hasOptions) {
        const optionDef = extra.find(param => Array.isArray(param.options) && param.options.length > 0);

        if (optionDef) {
            const activeOption = catalogObject.selectedOption || optionDef.options[0];

            extraParams.push(`${optionDef.name}=${encodeURIComponent(activeOption)}`);
        }
    }

    // Add pagination if skip > 0
    if (skip > 0) {
        extraParams.push(`skip=${skip}`);
    }

    const extraPath = extraParams.length > 0 ? `/${extraParams.join('&')}` : '';
    const url = `${baseUrl}/catalog/${type}/${urlId}${extraPath}.json`;

    try {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`Status: ${response.status}`);
        const data = await response.json();


        return data.metas || [];
    } catch (error) {
        if (error.name !== 'AbortError') console.error(`Failed fetching ${urlId}:`, error);
        return null;
    }
}
//#endregion