import { TMDB_KEY } from "../services/config";
import { initGlobalDrag,
    setupRowClickListener,
    renderRow,
    renderCardsToRow,
    injectCatalogShell,
    showRowMessage} from "./catalog-renderer";

// APP BOOTER
export async function loadDiscover() {
    initGlobalDrag();

    // 1. Fetch custom add-on catalogs into state
    await loadAllCustomCatalogs();

    // 2. Clear container
    const container = document.getElementById('dynamic-catalogs-container');
    if (container) container.innerHTML = '';

    // 3. Render all rows in rowState (TMDB + Addons)
    for (const [containerId, state] of Object.entries(rowState)) {
        if (containerId === 'global-search-grid') continue;

        // Skip add-on catalogs that returned 0 items so we don't leave blank headers
        if (state.baseUrl && (!state.results || state.results.length === 0)) {
            continue;
        }

        // Dynamically inject the row shell
        injectCatalogShell(containerId, state.title, state.addonName);

        // Fetch/Render the cards
        renderRow(containerId, true);
    }
}

//#region TMDB Data
export const rowState = {
    // TMDB Standard Rows (Now with titles & badge names)
    'trending-movies-row': { title: 'Trending Movies', addonName: 'TMDB', page: 1, endpoint: 'trending/movie/week', loading: false, hasMore: true },
    'trending-shows-row': { title: 'Trending Series', addonName: 'TMDB', page: 1, endpoint: 'trending/tv/week', loading: false, hasMore: true },
    'top-row': { title: 'Top Rated Movies', addonName: 'TMDB', page: 1, endpoint: 'movie/top_rated', loading: false, hasMore: true },
    'action-row': { title: 'Action Blockbusters', addonName: 'TMDB', page: 1, endpoint: 'discover/movie?with_genres=28&sort_by=vote_count.desc&vote_average.gte=7&vote_count.gte=3000', loading: false, hasMore: true },
    'comedy-row': { title: 'Comedies', addonName: 'TMDB', page: 1, endpoint: 'discover/movie?with_genres=35&sort_by=vote_count.desc&vote_average.gte=6.5&vote_count.gte=2000', loading: false, hasMore: true },
    'thriller-row': { title: 'Thrillers', addonName: 'TMDB', page: 1, endpoint: 'discover/movie?with_genres=53&without_genres=27,28&sort_by=vote_count.desc&vote_average.gte=7.5&vote_count.gte=1500', loading: false, hasMore: true },
    'anime-row': { title: 'Top Anime', addonName: 'TMDB', page: 1, endpoint: 'discover/tv?with_genres=16&with_original_language=ja&sort_by=vote_count.desc&vote_count.gte=500', loading: false, hasMore: true },

    // Dynamic search grid
    'global-search-grid': { page: 1, query: '', loading: false, hasMore: true }
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
//#endregion

//#region Custom Metadata
export function getCatalogProviders() {
    const userAddons = JSON.parse(localStorage.getItem('user_addons')) || [];

    return userAddons.filter(addon => addon.capabilities && addon.capabilities.catalogs === true && addon.catalogs.length > 0);
}

export async function loadAllCustomCatalogs() {
    const providers = getCatalogProviders();
    const fetchPromises = []; // Create an array to hold all our pending requests

    for (const provider of providers) {
        const baseUrl = provider.url.replace(/\/manifest\.json$/, '');

        for (const catalog of provider.catalogs) {
            // SKIP search-only catalogs or catalogs requiring unfulfilled params
            const hasRequiredExtra = catalog.extra?.some(e => e.isRequired && e.name !== 'skip') 
                || catalog.extraRequired?.some(name => name !== 'skip');

            if (hasRequiredExtra) continue;

            const containerId = `${provider.id}-${catalog.type}-${catalog.id}`.replace(/[^a-zA-Z0-9-]/g, '-');

            // 1. Initialize the state synchronously
            rowState[containerId] = { 
                title: catalog.name || catalog.id,
                addonName: provider.name,
                baseUrl: baseUrl, 
                catalogId: catalog.id, 
                type: catalog.type, 
                skip: 0, 
                loading: false, 
                hasMore: true,
                results: [] 
            };

            // 2. Wrap the fetch and state-update logic in a Promise (do NOT await it here)
            const fetchPromise = fetchAddonCatalog(baseUrl, catalog.type, catalog.id, 0)
                .then(items => {
                    rowState[containerId].results = items;
                    rowState[containerId].hasMore = items.length > 0;
                })
                .catch(() => {
                    rowState[containerId].hasMore = false;
                });

            // 3. Push the Promise to our array
            fetchPromises.push(fetchPromise);
        }
    }

    await Promise.all(fetchPromises);
}

// Fetch single catalog
export async function fetchAddonCatalog(baseUrl, type, catalogId, skip = 0) {
    const skipPath = skip > 0 ? `/skip=${skip}` : '';
    const url = `${baseUrl}/catalog/${type}/${catalogId}${skipPath}.json`;

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Status: ${response.status}`);
        const data = await response.json();
        
        console.log(data);
        console.log(data.metas);
        
        return data.metas || [];
    } catch (error) {
        console.error(`Failed fetching ${catalogId}:`, error);
        return [];
    }
}

// THE NEW UNIVERSAL DATA FETCHER
export async function fetchNextBatch(containerId, isInitial) {
    const state = rowState[containerId];
    let newItems = [];

    // BRANCH 1: TMDB Logic
    if (state.endpoint) {
        if (!isInitial) state.page += 1; // Increment TMDB page

        let fetchUrl = state.endpoint;
        // Handle global search override
        if (containerId === 'global-search-grid' && state.query) {
            fetchUrl = `search/multi?query=${encodeURIComponent(state.query)}`;
        }

        const data = await fetchTMDBEndpoint(fetchUrl, state.page);
        newItems = data.results || [];
        
        if (newItems.length === 0 || data.page >= data.total_pages) {
            state.hasMore = false;
        }
    } 
    // BRANCH 2: Stremio Add-on Logic
    else if (state.baseUrl) {
        // If this is the initial render and we already pre-loaded the data in memory
        if (isInitial && state.results && state.results.length > 0) {
            newItems = state.results;
            state.skip += newItems.length;
        } else {
            // Fetch dynamically based on current skip value
            const metas = await fetchAddonCatalog(state.baseUrl, state.type, state.catalogId, state.skip);
            newItems = metas || [];
            
            if (newItems.length === 0) {
                state.hasMore = false;
            } else {
                state.skip += newItems.length;
            }
        }
    }

    return newItems;
}
//#endregion