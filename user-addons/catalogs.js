import { TMDB_KEY } from "../services/config";
import {
    initGlobalDrag,
    renderRow,
    renderSelectedCatalog,
    populateTypeDropdown,
    populateCatalogDropdown,
    showRowMessage,
    initGlobalClickListener
} from "./catalog-renderer";

// APP BOOTER
export async function loadDiscover() {
    initGlobalDrag();
    initCustomCatalogsState();
    initGlobalClickListener();

    const typeSelect = document.getElementById('discover-type-select');
    const catalogSelect = document.getElementById('discover-catalog-select');

    // 1. Populate the UI with combined TMDB and Add-on options
    populateTypeDropdown(getAvailableTypes());

    if (typeSelect && typeSelect.value) {
        populateCatalogDropdown(getCatalogsByType(typeSelect.value));
    }

    // 2. Attach Event Listeners to trigger UI updates
    typeSelect?.addEventListener('change', (e) => {
        populateCatalogDropdown(getCatalogsByType(e.target.value));
        renderSelectedCatalog(); // Update screen when type changes
    });

    catalogSelect?.addEventListener('change', () => {
        renderSelectedCatalog(); // Update screen when catalog changes
    });

    if(catalogSelect && catalogSelect.value)
    {
        renderSelectedCatalog();
    }
}

export const catalogRegistry = {};

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
        'trending-shows-row': { containerId: 'trending-shows-row', title: 'Trending Series', addonName: 'TMDB', type: 'series', page: 1, endpoint: 'trending/tv/week', loading: false, hasOptions: false, hasMore: true },
        'anime-row': { containerId: 'anime-row', title: 'Top Anime', addonName: 'TMDB', type: 'series', page: 1, endpoint: 'discover/tv?with_genres=16&with_original_language=ja&sort_by=vote_count.desc&vote_count.gte=500', loading: false, hasOptions: false, hasMore: true }
    },
    other: {
        // Kept separate so the global search doesn't render as a standard row
        'global-search-grid': { containerId: 'global-search-grid', title: 'Search', addonName: 'TMDB', type: 'other', page: 1, query: '', loading: false, hasOptions: false, hasMore: true }
    }
};

// Fetch card data
export async function fetchTMDBEndpoint(endpoint, page = 1) {
    const base = `https://api.themoviedb.org/3/`;
    const url = new URL(endpoint.startsWith('http') ? endpoint : base + endpoint);

    url.searchParams.append('api_key', TMDB_KEY);
    url.searchParams.append('language', 'en-US');
    url.searchParams.append('page', page.toString());

    const response = await fetch(url.toString());
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

    rowState[containerId].query = query;
    rowState[containerId].page = 1;
    rowState[containerId].hasMore = true;
    rowState[containerId].loading = true;

    try {
        const endpoint = `search/multi?query=${encodeURIComponent(query)}`;
        const data = await fetchTMDBEndpoint(endpoint, 1);

        row.replaceChildren();

        if (data.results.length === 0) {
            showRowMessage(containerId, "Empty");
            rowState[containerId].hasMore = false;
            return;
        }

        renderCardsToRow(data.results, containerId);

        if (data.page >= data.total_pages) {
            rowState[containerId].hasMore = false;
        }
    } catch (e) {
        console.error("Search failed:", e);
        showRowMessage(containerId, "Error");
        rowState[containerId].hasMore = false;
    } finally {
        rowState[containerId].loading = false;
    }
}
//#endregion

//#region Custom Metadata
export function getCatalogProviders() {
    const userAddons = JSON.parse(localStorage.getItem('user_addons')) || [];

    return userAddons.filter(addon => addon.capabilities && addon.capabilities.catalogs === true && addon.catalogs.length > 0);
}

// Initialise all addons
export const addonState = {};

export function initCustomCatalogsState() {
    // 1. Get the addons from local storage
    const addons = getCatalogProviders();

    // Iterate every addon
    for (const addon of addons) {
        const baseUrl = addon.url.replace(/\/manifest\.json$/, '');

        // Iterate every catalog per addon
        for (const catalog of addon.catalogs) {
            // Check if the type bucket already exists
            if (!addonState[catalog.type]) {
                addonState[catalog.type] = {};
            }

            // HTML needs a unique id per catalog
            const catalogId = `${addon.id}-${catalog.type}-${catalog.id}`.replace(/[^a-zA-Z0-9-]/g, '-');

            const extra = catalog.extra || [];

            // Check if it supports pages
            const supportsPagination = extra.some(param => param.name === 'skip');

            // Check if it accepts parameters
            const supportsOption = extra.some(param => Array.isArray(param.options) && param.options.length > 0);

            // Push the formatted catalog state in its type bucket
            addonState[catalog.type][catalogId] = {
                containerId: catalogId,
                title: catalog.name || catalog.id,
                baseUrl: baseUrl,
                urlId: catalog.id,
                type: catalog.type,
                extra: catalog.extra || [],  // Contains options
                skip: 0,
                loading: false,
                hasOptions: supportsOption,
                hasMore: supportsPagination,

                addonName: addon.name,
                idPrefixes: addon.idPrefixes || []
            };
        }
    }
}

// THE NEW UNIVERSAL DATA FETCHER
export async function fetchNextBatch(catalogId) {
    const catalogObject = getActiveState(catalogId);

    // Safety checks: Invalid ID, already loading, or permanently out of data
    if (!catalogObject || catalogObject.loading || catalogObject.hasMore === false) return [];

    // Lock the state to prevent duplicate observer triggers
    catalogObject.loading = true;
    let newItems = [];

    // Route 1: TMDB Logic
    if (catalogObject.endpoint) {
        let fetchUrl = catalogObject.endpoint;

        if (catalogId === 'global-search-grid' && catalogObject.query) {
            fetchUrl = `search/multi?query=${encodeURIComponent(catalogObject.query)}`;
        }

        // Fetch using the current page state
        const data = await fetchTMDBEndpoint(fetchUrl, catalogObject.page || 1);
        newItems = data.results || [];
        
        // Increment page for the next horizontal scroll, or disable pagination
        if (newItems.length > 0) {
            catalogObject.page = (catalogObject.page || 1) + 1;
        } else {
            catalogObject.hasMore = false;
        }
    }
    // Route 2: Stremio Add-on Logic
    else {
        const metas = await fetchAddonCatalog(catalogObject);
        newItems = metas || [];
        
        // Increment skip by the exact amount of items returned
        if (newItems.length > 0) {
            catalogObject.skip = (catalogObject.skip || 0) + newItems.length;
        } else {
            catalogObject.hasMore = false;
        }
    }

    if (newItems.length > 0) {
        // Cache the raw data array in the object
        catalogObject.items = catalogObject.items || [];
        catalogObject.items.push(...newItems);
        
        renderRow(newItems, catalogObject);
    }

    console.log(catalogObject.title, catalogObject.addonName, newItems)
    catalogObject.loading = false;
    return newItems;
}

// Fetch single catalog
export async function fetchAddonCatalog(catalogObject) {
    // Destructure the object for cleaner variables
    const { baseUrl, type, urlId, extra, skip } = catalogObject;

    // We will build an array of Stremio key=value parameter strings
    let extraParams = [];

    // 1. Extract the default option dynamically
    if (catalogObject.hasOptions && Array.isArray(extra)) {
        // Find the specific extra property that contains an options array
        const optionDef = extra.find(param => Array.isArray(param.options) && param.options.length > 0);

        if (optionDef) {
            // Pick the first item in the array as the default (e.g., "Action")
            const defaultOption = optionDef.options[0];

            // Push it in the Stremio key=value format (e.g., "genre=Action")
            extraParams.push(`${optionDef.name}=${encodeURIComponent(defaultOption)}`);
        }
    }

    // 2. Add pagination if skip > 0
    if (skip > 0) {
        extraParams.push(`skip=${skip}`);
    }

    // 3. Construct the final Stremio URL
    // Joins the params with "&" and adds the leading slash if params exist
    const extraPath = extraParams.length > 0 ? `/${extraParams.join('&')}` : '';
    const url = `${baseUrl}/catalog/${type}/${urlId}${extraPath}.json`;

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Status: ${response.status}`);
        const data = await response.json();

        console.log(`${catalogObject.title}, ${catalogObject.addonName}  Data:`, data);

        return data.metas || [];
    } catch (error) {
        console.error(`Failed fetching ${urlId}:`, error);
        return [];
    }
}
//#endregion