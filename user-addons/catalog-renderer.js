import { openMasterDetail } from "../api";
import { addonState, rowState, fetchNextBatch, getActiveState } from "./catalogs";

//#region Row Controllers
export let isDragging = false;
let isDown = false;
let activeSlider = null;
let startX;
let scrollLeft;
let isTicking = false;


let isDragInitialized = false;
export function initGlobalDrag() {
    if (isDragInitialized) return;
    isDragInitialized = true;

    document.addEventListener("mousedown", (e) => {
        const slider = e.target.closest(".draggable-row");
        if (!slider) return;

        isDown = true;
        isDragging = false;
        activeSlider = slider;

        slider.classList.add("cursor-grabbing");
        document.body.classList.add("select-none");

        startX = e.pageX - slider.offsetLeft;
        scrollLeft = slider.scrollLeft;
    });

    window.addEventListener("mousemove", (e) => {
        if (!isDown || !activeSlider) return;
        e.preventDefault();

        const x = e.pageX - activeSlider.offsetLeft;
        const walk = (x - startX) * 3;

        if (Math.abs(walk) > 5) {
            isDragging = true;
            activeSlider.classList.add("pointer-events-none");
            document.body.classList.add("cursor-grabbing");
        }

        if (!isTicking) {
            window.requestAnimationFrame(() => {
                activeSlider.scrollLeft = scrollLeft - walk;
                isTicking = false;
            });
            isTicking = true;
        }
    });

    // CONSOLIDATED STOP LOGIC
    const stopDrag = () => {
        if (!isDown || !activeSlider) return;

        isDown = false;

        activeSlider.classList.remove("cursor-grabbing", "pointer-events-none");
        document.body.classList.remove("select-none", "cursor-grabbing");

        setTimeout(() => {
            isDragging = false;
            activeSlider = null;
        }, 50);
    };

    // Bind both events to the single helper function
    window.addEventListener("mouseup", stopDrag);
    window.addEventListener("mouseleave", stopDrag);
}

// Row observers
const rowObservers = {};
function getObserverFor(containerId) {
    // Return cached observer if it already exists
    if (rowObservers[containerId]) return rowObservers[containerId];

    const rowElement = document.getElementById(containerId);
    if (!rowElement) return null;

    // Create the observer
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                // Unobserve the triggered sentinel
                observer.unobserve(entry.target);

                // Fetch and render the next batch
                fetchNextBatch(containerId);
            }
        });
    }, {
        root: rowElement,
        rootMargin: "0px 1000px 0px 0px",
        threshold: 0
    });

    rowObservers[containerId] = observer;
    return observer;
}

// Add this near your other observer logic
const viewportObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const containerId = entry.target.id;
            // Stop observing the row itself once the initial fetch triggers
            observer.unobserve(entry.target); 
            
            // Fetch the first batch of data
            fetchNextBatch(containerId);
        }
    });
}, {
    root: null, // Observes the browser viewport vertically
    rootMargin: "0px 0px 800px 0px", // Trigger 800px before the row scrolls into view
    threshold: 0
});

// Disconnect the observers
export function destroyObserver(containerId) {
    if (rowObservers[containerId]) {
        rowObservers[containerId].disconnect();
        delete rowObservers[containerId];
    }
}
//#endregion

//#region Renderers

export function renderSelectedCatalog() {
    const typeSelect = document.getElementById('discover-type-select');
    const catalogSelect = document.getElementById('discover-catalog-select');
    const container = document.getElementById('dynamic-catalogs-container');
    
    if (!catalogSelect || !container || !typeSelect) return;

    // Clear the screen completely
    container.replaceChildren();

    const selectedId = catalogSelect.value;
    const selectedType = typeSelect.value;

    // Route A: Render everything for the selected category
    if (selectedId === 'all') {
        // TMDB Rows
        if (rowState[selectedType]) {
            for (const catalogId in rowState[selectedType]) {
                const catalogObject = rowState[selectedType][catalogId];
                injectCatalogShell(catalogObject);
            }
        }
        // Add-on Rows
        if (addonState[selectedType]) {
            for (const catalogId in addonState[selectedType]) {
                const catalogObject = addonState[selectedType][catalogId];
                injectCatalogShell(catalogObject);
            }
        }
    } 
    // Route B: Render the single selected catalog
    else {
        const catalogObject = getActiveState(selectedId);
        if (catalogObject) {
            injectCatalogShell(catalogObject);
        }
    }
}

// Cache the template
let cachedTemplate = null;
// Create poster card
export function createCardElement(item) {
    // Cach if not cached
    if (!cachedTemplate) {
        cachedTemplate = document.getElementById("poster-card-template");
    }

    if (!cachedTemplate || !item) return null;

    const posterUrl = item.poster || (item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null);
    if (!posterUrl || item.type === "person" || item.media_type === "person") return null;

    const title = item.name || item.title || "Untitled";
    const year = item.releaseInfo || item.year || parseInt(item.release_date) || parseInt(item.first_air_date) || "";

    const type = item.type || item.media_type || "movie";
    const backdrop = item.background || item.backdrop_path || "";

    // Clone the cached template
    const clone = cachedTemplate.content.cloneNode(true);

    const card = clone.querySelector(".media-card");
    const img = clone.querySelector(".poster-img");
    const titleEl = clone.querySelector(".poster-title");
    const yearEl = clone.querySelector(".poster-year");

    // Populate dataset
    card.dataset.id = item.id;
    card.dataset.type = type;
    card.dataset.title = title;
    card.dataset.poster = posterUrl;
    card.dataset.backdrop = backdrop;

    // Populate text
    titleEl.textContent = title;
    if (year && year !== "N/A") {
        yearEl.textContent = year;
        yearEl.classList.remove("hidden");
    }

    img.alt = title;
    img.src = posterUrl;

    return card;
}

export function renderRow(newItems, catalogObject) {
    const containerId = catalogObject.containerId; 
    const row = document.getElementById(containerId);

    if (!row) return; // Safety check in case the shell failed to inject

    // Clear out any previous loading/error text
    const messageEl = row.querySelector('.text-slate-500');
    if (messageEl) messageEl.remove();

    // Handle empty states
    if (!newItems || newItems.length === 0) {
        showRowMessage(containerId, "No items found");
        return;
    }

    // Pass the data, string ID, and pagination boolean to the card builder
    renderCardsToRow(newItems, containerId, catalogObject.hasMore); 
}

export function renderCardsToRow(items, containerId, hasMore) {
    const row = document.getElementById(containerId);
    if (!row || !Array.isArray(items)) return;

    // 1. Clean up the old observer sentinel to prevent duplicate fetch triggers
    const oldSentinel = row.querySelector(".scroll-sentinel");
    if (oldSentinel) {
        const observer = getObserverFor(containerId);
        if (observer) observer.unobserve(oldSentinel);
        oldSentinel.remove();
    }

    // 2. Build all new cards in memory first to prevent layout thrashing
    const fragment = document.createDocumentFragment();
    items.forEach(item => {
        const cardNode = createCardElement(item);
        if (cardNode) fragment.appendChild(cardNode);
    });
    
    // 3. Paint the batch to the screen in a single operation
    row.appendChild(fragment);

    // 4. Inject a new sentinel at the end of the row if pagination is supported
    if (hasMore) {
        const sentinel = document.createElement("div");
        sentinel.className = "scroll-sentinel w-1 flex-none";
        row.appendChild(sentinel);

        // Attach the observer to watch this specific sentinel for horizontal scrolling
        const observer = getObserverFor(containerId);
        if (observer) observer.observe(sentinel);
    }
}

function setupRowClickListener(catalogObject) {
    const row = document.getElementById(catalogObject.containerId);
    if (!row || row.dataset.listenerAttached) return;

    row.addEventListener("click", (e) => {
        if (isDragging) { e.preventDefault(); return; }

        const card = e.target.closest(".media-card");
        if (!card) return;

        // TMDB Route
        openMasterDetail(
            card.dataset.id,
            card.dataset.title,
            card.dataset.type,
            card.dataset.poster,
            card.dataset.backdrop,
            // Pass the addons prefix (tt, kitsu, mal...)
            catalogObject.idPrefixes
        );
    });

    row.dataset.listenerAttached = "true";
}
//#endregion

// Inject the empty rows for the observer
let cachedRowTemplate = null;
export function injectCatalogShell(catalogObject) {
    if (!cachedRowTemplate) {
        cachedRowTemplate = document.getElementById("catalog-row-template");
    }

    const container = document.getElementById("dynamic-catalogs-container");
    if (!cachedRowTemplate || !container) return;

    // Clone the template content
    const clone = cachedRowTemplate.content.cloneNode(true);

    // Catalog Title
    const titleEl = clone.querySelector(".catalog-title");
    if (titleEl) titleEl.textContent = catalogObject.title;

    // Addon name badge
    const badgeEl = clone.querySelector(".catalog-addon-badge");
    if (badgeEl) {
        badgeEl.textContent = catalogObject.addonName;
        badgeEl.classList.remove("hidden");
    }

    // Assign the unique ID to the row so the data go there later
    const rowEl = clone.querySelector(".catalog-row");
    if (rowEl) {
        rowEl.id = catalogObject.containerId;
    }

    container.appendChild(clone);
    console.log(`Created row ${rowEl}`)

    // Card click event listener
    setupRowClickListener(catalogObject);

    const observer = getObserverFor(catalogObject.containerId);
    if (observer && rowEl) {
        viewportObserver.observe(rowEl);
    }
}

export function populateTypeDropdown(typesList) {
    const select = document.getElementById('discover-type-select');
    if (!select) return;

    select.replaceChildren();

    typesList.forEach(type => {
        const option = document.createElement('option');
        option.value = type;
        option.textContent = type.charAt(0).toUpperCase() + type.slice(1);
        option.className = 'bg-slate-900 text-white';
        select.appendChild(option);
    });
}

export function populateCatalogDropdown(catalogsList) {
    const select = document.getElementById('discover-catalog-select');
    if (!select) return;
    
    select.replaceChildren();

    // 1. Inject the 'All' option first
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = 'All Catalogs';
    allOption.className = 'bg-slate-900 text-white font-bold';
    select.appendChild(allOption);

    // 2. Iterate the flattened list directly
    catalogsList.forEach(catalog => {
        const option = document.createElement('option');
        option.value = catalog.containerId;
        option.textContent = `${catalog.addonName} - ${catalog.title}`;
        option.className = 'bg-slate-900 text-white';
        select.appendChild(option);
    });
}

// Row message
export function showRowMessage(containerId, message = "No results found.") {
    const row = document.getElementById(containerId);
    if (row) row.innerHTML = `<p class="text-slate-500 pl-2 text-sm mt-4">${message}</p>`;
}