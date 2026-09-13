import { openMasterDetail } from "../api";
import { addonState, rowState, fetchNextBatch, getActiveState } from "./catalogs";

export let isDragging = false;
let isDown = false;
let activeSlider = null;
let startX;
let scrollLeft;
let isTicking = false;
let activeGridCatalogId = null;
let previousScrollTop = 0; // Add this line

const ROW_DOM_CAP = 100;
const GRID_DOM_CAP = 500;

const FETCH_COOLDOWN_MS = 350;
const lastFetchTime = {};

//#region Row Controllers

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
        const walk = (x - startX) * 2;

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

        const finishedSlider = activeSlider;
        isDown = false;

        finishedSlider.classList.remove("cursor-grabbing", "pointer-events-none");
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
const rowSentinels = {}; // containerId -> current sentinel element
const rowMessages = {};  // containerId -> current message element, if one is shown

// Remove rowObservers object and replace getObserverFor with this global observer
const sentinelObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const containerId = entry.target.dataset.containerId;
            observer.unobserve(entry.target);
            triggerFetch(containerId);
        }
    });
}, {
    root: null,
    rootMargin: "0px 1000px 0px 0px",
    threshold: 0
});

function getObserverFor(containerId) {
    return sentinelObserver;
}

const rowScrollPositions = {}; // Tracks horizontal scroll states

const viewportObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        const row = entry.target;
        const containerId = row.dataset.catalogId || row.id;
        const catalogObject = getActiveState(containerId);

        if (!catalogObject) return;

        if (entry.isIntersecting) {
            // ROW IS ON SCREEN
            if (!catalogObject.items || catalogObject.items.length === 0) {
                // First time seeing this row, trigger data fetch
                triggerFetch(containerId);
            } else if (row.childElementCount === 0) {
                // Row was unloaded to save RAM -> Rehydrate it instantly
                renderCardsToRow(itemsForRehydration(catalogObject, ROW_DOM_CAP), containerId, catalogObject.hasMore);
                row.scrollLeft = rowScrollPositions[containerId] || 0; // Restore exact horizontal position
            }
        } else {
            // ROW IS OFF SCREEN
            if (row.childElementCount > 0) {
                // 1. Lock the height so the vertical scrollbar doesn't glitch
                row.style.minHeight = `${row.offsetHeight}px`;
                // 2. Save where the user was swiping
                rowScrollPositions[containerId] = row.scrollLeft;
                // 3. Nuke the cards from the DOM to free up CPU/RAM
                row.replaceChildren();
            }
        }
    });
}, {
    root: null,
    rootMargin: "800px 0px 800px 0px", // Keeps rows alive slightly above/below the screen
    threshold: 0
});

const gridTriggerObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const containerId = entry.target.dataset.containerId;
            observer.unobserve(entry.target);
            triggerFetch(containerId);
        }
    });
}, {
    root: null,
    rootMargin: "0px 0px 800px 0px",
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
const fetchTimeouts = {};

function triggerFetch(containerId) {
    const now = Date.now();
    const last = lastFetchTime[containerId] || 0;
    const elapsed = now - last;

    if (elapsed >= FETCH_COOLDOWN_MS) {
        lastFetchTime[containerId] = now;
        if (fetchTimeouts[containerId]) {
            clearTimeout(fetchTimeouts[containerId]);
            delete fetchTimeouts[containerId];
        }
        fetchNextBatch(containerId);
    } else if (!fetchTimeouts[containerId]) {
        fetchTimeouts[containerId] = setTimeout(() => {
            delete fetchTimeouts[containerId];
            triggerFetch(containerId);
        }, FETCH_COOLDOWN_MS - elapsed);
    }
}

const ROW_CARD_CLASSES = ["w-32", "md:w-48", "flex-none"];

function setCardLayout(card, isGrid) {
    if (isGrid) {
        card.classList.remove(...ROW_CARD_CLASSES);
    } else {
        card.classList.add(...ROW_CARD_CLASSES);
    }
}

function getOrCreateCard(item, catalogObject) {
    if (!catalogObject.cardEls) catalogObject.cardEls = new Map();

    const key = String(item.id);
    let card = catalogObject.cardEls.get(key);

    // Return cached card immediately, no need to observe
    if (card) return card;

    card = createCardElement(item);
    if (card) {
        catalogObject.cardEls.set(key, card);
    }
    return card;
}

function itemsForRehydration(catalogObject, cap) {
    const items = catalogObject.items || [];
    return items.length > cap ? items.slice(-cap) : items;
}

export function renderSelectedCatalog() {
    const typeSelect = document.getElementById('discover-type-select');
    const catalogSelect = document.getElementById('discover-catalog-select');
    const container = document.getElementById('dynamic-catalogs-container');

    if (!catalogSelect || !container || !typeSelect) return;

    // Tear down observers for every row currently on screen before removing
    container.querySelectorAll('.catalog-row, .search-row').forEach(rowEl => {
        teardownRow(rowEl.id);
    });

    // Clear the screen (Detached DOM nodes remain safe in our state objects)
    container.replaceChildren();

    const selectedId = catalogSelect.value;
    const selectedType = typeSelect.value;

    // Create a fragment for batch DOM insertions
    const fragment = document.createDocumentFragment();

    // Route A: Render everything
    if (selectedId === 'all') {
        if (rowState[selectedType]) {
            Object.values(rowState[selectedType]).forEach(catalogObject => {
                injectCatalogShell(catalogObject, fragment);
            });
        }
        if (addonState[selectedType]) {
            Object.values(addonState[selectedType]).forEach(catalogObject => {
                injectCatalogShell(catalogObject, fragment);
            });
        }
    }
    // Route B: Single catalog
    else {
        const catalogObject = getActiveState(selectedId);
        if (catalogObject) {
            injectCatalogShell(catalogObject, fragment);
        }
    }

    // Paint everything to the screen in a single operation
    container.appendChild(fragment);
}

// Cache the template
let cachedTemplate = null;
// Create poster card
function createCardElement(item) {
    // Cach if not cached
    if (!cachedTemplate) cachedTemplate = document.getElementById("poster-card-template");

    if (!cachedTemplate || !item) return null;

    // Clone the cached template
    const clone = cachedTemplate.content.cloneNode(true);

    const card = clone.querySelector(".poster-card");
    const img = clone.querySelector(".poster-img");
    const titleEl = clone.querySelector(".poster-title");
    const yearEl = clone.querySelector(".poster-year");

    // Populate dataset
    card.dataset.id = item.id;
    card.dataset.type = item.type;
    card.dataset.year = item.year;
    card.dataset.title = item.title;
    card.dataset.poster = item.poster;
    card.dataset.backdrop = item.backdrop;

    // Populate text
    titleEl.textContent = item.title;
    if (item.year && item.year !== "N/A") {
        yearEl.textContent = item.year;
        yearEl.classList.remove("hidden");
    }

    img.alt = item.title;
    img.loading = "lazy"
    img.decoding = "async"
    img.src = item.poster;

    return card;
}

export function renderRow(newItems, catalogObject) {
    const containerId = catalogObject.containerId;
    const row = document.getElementById(containerId);
    const paintingGrid = activeGridCatalogId === containerId;

    if (!row && !paintingGrid) return;

    if (row && rowMessages[containerId]) {
        rowMessages[containerId].remove();
        delete rowMessages[containerId];
    }

    if (!newItems || newItems.length === 0) {
        console.error("Received empty catalog");
        if (row) showRowMessage(containerId, "No items found");
        return;
    }

    if (paintingGrid) {
        renderCardsToGrid(newItems, catalogObject.hasMore, containerId);
    } else if (row) {
        renderCardsToRow(newItems, containerId, catalogObject.hasMore);
    }
}

export function renderCardsToRow(items, containerId, hasMore) {
    const row = document.getElementById(containerId);
    if (!row || !Array.isArray(items)) return;

    const catalogObject = getActiveState(containerId);
    if (!catalogObject) return;

    const oldSentinel = rowSentinels[containerId];
    if (oldSentinel) {
        const observer = getObserverFor(containerId);
        if (observer) observer.unobserve(oldSentinel);
        oldSentinel.remove();
        delete rowSentinels[containerId];
    }

    const fragment = document.createDocumentFragment();
    items.forEach(item => {
        const card = getOrCreateCard(item, catalogObject);
        if (card) {
            setCardLayout(card, false);
            fragment.appendChild(card); // re-parents it if it was in the grid
        }
    });
    row.appendChild(fragment);

    if (hasMore) {
        const sentinel = document.createElement("div");
        sentinel.className = "scroll-sentinel w-1 flex-none";
        sentinel.dataset.containerId = containerId; // Add this line
        row.appendChild(sentinel);

        const observer = getObserverFor(containerId);
        if (observer) observer.observe(sentinel);
        rowSentinels[containerId] = sentinel;
    }
}

function teardownRow(containerId) {
    const rowEl = document.getElementById(containerId);
    if (rowEl) viewportObserver.unobserve(rowEl);
    destroyObserver(containerId);
    delete rowSentinels[containerId];
    delete rowMessages[containerId];

    // 1. Clear pending timeouts to stop ghost fetches
    if (fetchTimeouts[containerId]) {
        clearTimeout(fetchTimeouts[containerId]);
        delete fetchTimeouts[containerId];
    }

    const catalogObject = getActiveState(containerId);
    if (catalogObject) {
        if (catalogObject.loading) catalogObject.abortController?.abort();
        // 2. Free detached DOM nodes from memory
        catalogObject.cardEls?.clear();
    }
}

let gridTriggerEl = null; // the one card currently armed to fetch the next page
function renderCardsToGrid(items, hasMore, containerId) {
    const gridContent = document.getElementById("catalog-grid-content");
    if (!gridContent || !Array.isArray(items)) return;

    const catalogObject = getActiveState(containerId);
    if (!catalogObject) return;

    if (gridTriggerEl) {
        gridTriggerObserver.unobserve(gridTriggerEl);
        gridTriggerEl.classList.remove("load-trigger");
        gridTriggerEl = null;
    }

    const fragment = document.createDocumentFragment();
    items.forEach(item => {
        const card = getOrCreateCard(item, catalogObject);
        if (card) {
            setCardLayout(card, true);
            fragment.appendChild(card); // re-parents it if it was in the row
        }
    });
    gridContent.appendChild(fragment);

    const triggerCard = gridContent.lastElementChild;
    if (hasMore && triggerCard) {
        triggerCard.classList.add("load-trigger");
        triggerCard.dataset.containerId = containerId;
        gridTriggerObserver.observe(triggerCard);
        gridTriggerEl = triggerCard;
    }
}

let isClickListenerAttached = false;

export function initGlobalClickListener() {
    if (isClickListenerAttached) return;

    const container = document.getElementById("app-main");
    if (!container) return;

    container.addEventListener("click", (e) => {
        // Prevent accidental clicks while dragging
        if (isDragging) {
            e.preventDefault();
            return;
        }

        // Poster Clicks
        const card = e.target.closest(".poster-card");
        if (card) {
            openMasterDetail(
                card.dataset.id,
                card.dataset.title,
                card.dataset.type,
                card.dataset.poster,
                card.dataset.backdrop
            );
            return;
        }

        // Grid catalog view
        const optionsBtn = e.target.closest(".catalog-show-options");
        if (optionsBtn) {
            const section = optionsBtn.closest(".catalog-section");
            if (!section) return;

            const rowEl = section.querySelector(".catalog-row");
            if (!rowEl) return;

            const catalogObject = getActiveState(rowEl.id);

            if (catalogObject) {
                console.log("User wants to see more of:", catalogObject.title);

                // Trigger your grid view function
                catalogGridView(catalogObject);
            }
            return;
        }
    });

    isClickListenerAttached = true;
}
//#endregion

// Inject the empty rows for the observer (catalogObject is addonState)
let cachedRowTemplate = null;
export function injectCatalogShell(catalogObject, targetContainer) {
    const container = targetContainer || document.getElementById("dynamic-catalogs-container");
    if (!container) return;

    if (!cachedRowTemplate) {
        cachedRowTemplate = document.getElementById("catalog-row-template");
    }

    const clone = cachedRowTemplate.content.cloneNode(true);
    const shellNode = clone.firstElementChild;

    const titleEl = shellNode.querySelector(".catalog-title");
    if (titleEl) titleEl.textContent = catalogObject.title;

    const optionsBtn = shellNode.querySelector(".catalog-show-options");
    if (optionsBtn) {
        const text = optionsBtn.querySelector(".btn-text");

        if (catalogObject.hasOptions) {
            text.textContent = "Explore Options";
        } else {
            text.textContent = "Browse";
        }
    }

    const rowEl = shellNode.querySelector(".catalog-row");
    if (rowEl) rowEl.id = catalogObject.containerId;

    container.appendChild(shellNode);

    setTimeout(() => {
        if (rowEl) viewportObserver.observe(rowEl);
    }, 0);
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

export function rearmObservers(containerId, hasMore) {
    renderCardsToRow([], containerId, hasMore);

    if (activeGridCatalogId === containerId) {
        renderCardsToGrid([], hasMore, containerId);
    }
}

// Full grid view
let activePage = null;
export function catalogGridView(catalogObject) {
    const gridView = document.getElementById("catalog-grid-view");
    const gridContent = document.getElementById("catalog-grid-content");
    const scrollContainer = document.getElementById("app-main");

    if (!gridView || !gridContent || !catalogObject || !scrollContainer) return;

    // Save position before scrolling to top
    previousScrollTop = scrollContainer.scrollTop;
    scrollContainer.scrollTo(0, 0);

    document.getElementById("app-main").scrollTo(0, 0);

    activePage = document.querySelector(".page-view:not(.hidden)");
    if (activePage) activePage.classList.add("hidden");

    document.getElementById("catalog-grid-title").textContent = catalogObject.title;

    const subtitle = document.getElementById("catalog-grid-subtitle");
    if (catalogObject.addonName) {
        subtitle.textContent = catalogObject.addonName;
        subtitle.classList.remove("hidden");
    } else {
        subtitle.classList.add("hidden");
    }

    gridView.classList.remove("hidden");

    if (gridTriggerEl) {
        gridTriggerObserver.unobserve(gridTriggerEl);
        gridTriggerEl.classList.remove("load-trigger"); // Added cleanup
        gridTriggerEl = null;
    }
    activeGridCatalogId = catalogObject.containerId;

    // Load options
    const dropDown = document.getElementById("grip-options-dropdown");
    console.log(catalogObject)

    if (catalogObject.hasOptions) {
        const optionDef = catalogObject.extra.find(param => Array.isArray(param.options) && param.options.length > 0);

        if (optionDef.options.length > 1) {
            dropDown.classList.remove("hidden");
            populateOptionsDropdown(catalogObject);
        } else {
            dropDown.classList.add("hidden");
        }
    } else {
        dropDown.classList.add("hidden");
    }

    if (catalogObject.items && catalogObject.items.length > 0) {
        renderCardsToGrid(itemsForRehydration(catalogObject, GRID_DOM_CAP), catalogObject.hasMore, catalogObject.containerId);
    } else if (catalogObject.hasMore) {
        fetchNextBatch(catalogObject.containerId);
    }
}

function populateOptionsDropdown(catalogObject) {
    const dropDown = document.getElementById("grid-options-select");
    if (!dropDown) return;

    dropDown.replaceChildren();

    const optionDef = catalogObject.extra.find(param => Array.isArray(param.options) && param.options.length > 0);

    if (optionDef) {
        optionDef.options.forEach(opt => {
            const optionEl = document.createElement("option");
            optionEl.value = opt;
            optionEl.textContent = opt;
            dropDown.appendChild(optionEl);
        });
        
        // Ensure the dropdown shows the currently active option if it exists
        if (catalogObject.selectedOption) {
            dropDown.value = catalogObject.selectedOption;
        }

        // Attach listener safely
        dropDown.removeEventListener("change", handleOptionChange);
        dropDown.addEventListener("change", handleOptionChange);
    }
}

function handleOptionChange(e) {
    if (!activeGridCatalogId) return;
    
    const catalogObject = getActiveState(activeGridCatalogId);
    if (!catalogObject) return;

    // 1. Save the newly selected option
    catalogObject.selectedOption = e.target.value;

    // 2. Wipe existing data and reset pagination
    catalogObject.items = [];
    catalogObject.idSet = new Set();
    catalogObject.skip = 0;
    catalogObject.page = 1;
    catalogObject.hasMore = true;
    catalogObject.cardEls?.clear();

    // 3. Clear the grid UI
    const gridContent = document.getElementById("catalog-grid-content");
    if (gridContent) gridContent.replaceChildren();

    // 4. Fetch the fresh batch
    fetchNextBatch(catalogObject.containerId);
}

export function closeGridView() {
    const gridView = document.getElementById("catalog-grid-view");
    if (gridView) gridView.classList.add("hidden");

    if (gridTriggerEl) {
        gridTriggerObserver.unobserve(gridTriggerEl);
        gridTriggerEl.classList.remove("load-trigger"); // Removes the lingering margin
        gridTriggerEl = null;
    }

    const containerId = activeGridCatalogId;
    const catalogObject = containerId ? getActiveState(containerId) : null;
    activeGridCatalogId = null;

    if (activePage) {
        activePage.classList.remove("hidden");
        activePage = null;
    }

    if (catalogObject) {
        renderCardsToRow(itemsForRehydration(catalogObject, ROW_DOM_CAP), containerId, catalogObject.hasMore);

        const gridContent = document.getElementById("catalog-grid-content");
        if (gridContent) {
            gridContent.querySelectorAll('.poster-card').forEach(card => {
                catalogObject.cardEls?.delete(card.dataset.id);
            });
            gridContent.replaceChildren();
        }
    }

    // Restore previous scroll position upon closing
    const scrollContainer = document.getElementById("app-main");
    if (scrollContainer) {
        scrollContainer.scrollTo(0, previousScrollTop);
    }
}

// Row message
export function showRowMessage(containerId, message = "No results found.") {
    const row = document.getElementById(containerId);
    if (!row) return;

    getActiveState(containerId)?.cardEls?.clear();
    row.innerHTML = `<p class="text-slate-500 pl-2 text-sm mt-4">${message}</p>`;
    rowMessages[containerId] = row.firstElementChild;
    delete rowSentinels[containerId]; // the old one just got wiped by innerHTML
}