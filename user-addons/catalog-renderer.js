import { openMasterDetail } from "../api";
import { rowState, fetchNextBatch } from "./catalogs";

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

const rowObservers = {};

function getObserverFor(containerId) {
    if (rowObservers[containerId]) return rowObservers[containerId];

    const rowElement = document.getElementById(containerId);

    rowObservers[containerId] = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const targetId = entry.target.dataset.targetRow;
                rowObservers[targetId].unobserve(entry.target);

                renderRow(targetId);
            }
        });
    }, {
        root: rowElement,
        rootMargin: "0px 1000px 0px 0px",
        threshold: 0
    });

    return rowObservers[containerId];
}
//#endregion

//#region Renderers
// 1. Create a variable outside the function to cache the template
let cachedTemplate = null;

export function createCardElement(item) {
    // Lazy-load the template cache on the very first run
    if (!cachedTemplate) {
        cachedTemplate = document.getElementById("poster-card-template");
    }
    
    if (!cachedTemplate || !item) return null;

    const posterUrl = item.poster || (item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null);
    if (!posterUrl || item.type === "person" || item.media_type === "person") return null;

    const title = item.name || item.title || "Untitled";
    const type = item.type || item.media_type || "movie";
    const backdrop = item.background || item.backdrop_path || "";
    
    const rawDate = item.releaseInfo || item.release_date || item.first_air_date || "N/A";
    const year = item.releaseInfo || "N/A";

    // 2. Clone the cached template
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

export function renderCardsToRow(items, containerId) {
    const row = document.getElementById(containerId);
    if (!row || !Array.isArray(items)) return;

    const oldSentinel = row.querySelector(".scroll-sentinel");
    if (oldSentinel) {
        getObserverFor(containerId).unobserve(oldSentinel);
        oldSentinel.remove();
    }

    const fragment = document.createDocumentFragment();
    items.forEach(item => {
        const cardNode = createCardElement(item);
        if (cardNode) fragment.appendChild(cardNode);
    });
    row.appendChild(fragment);

    if (rowState[containerId]?.hasMore) {
        const sentinel = document.createElement("div");
        sentinel.className = "scroll-sentinel w-1 flex-none";
        sentinel.dataset.targetRow = containerId;
        row.appendChild(sentinel);

        getObserverFor(containerId).observe(sentinel);
    }
}

export function setupRowClickListener(containerId) {
    const row = document.getElementById(containerId);
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
            card.dataset.backdrop
        );
    });

    row.dataset.listenerAttached = "true";
}

export async function renderRow(containerId, isInitial = false) {
    const state = rowState[containerId];
    if (!state || state.loading || !state.hasMore) return;

    state.loading = true;

    if (isInitial) {
        showRowMessage(containerId, "Loading");
        const row = document.getElementById(containerId);
        if (row) {
            const oldSentinel = row.querySelector(".scroll-sentinel");
            if (oldSentinel) getObserverFor(containerId).unobserve(oldSentinel);
            row.innerHTML = "";
        }
    }

    try {
        const newItems = await fetchNextBatch(containerId, isInitial);

        if (!newItems || newItems.length === 0) {
            if (isInitial) showRowMessage(containerId, "No items found");
        } else {
            renderCardsToRow(newItems, containerId);
        }

    } catch (e) {
        console.error(`Error on ${containerId}:`, e);
        if (isInitial) showRowMessage(containerId, "Error");
        state.hasMore = false;
    } finally {
        state.loading = false;
    }
}
//#endregion

// catalog-renderer.js

export function injectCatalogShell(containerId, catalogTitle, addonName) {
    const template = document.getElementById("catalog-row-template");
    const container = document.getElementById("dynamic-catalogs-container");
    
    if (!template || !container) return;

    // Clone the template content
    const clone = template.content.cloneNode(true);
    
    // Set the Catalog Title (e.g., "Popular Movies")
    const titleEl = clone.querySelector(".catalog-title");
    if (titleEl) titleEl.textContent = catalogTitle;
    
    // Set the Add-on Name Badge (e.g., "Cinemeta")
    const badgeEl = clone.querySelector(".catalog-addon-badge");
    if (badgeEl) {
        badgeEl.textContent = addonName;
        badgeEl.classList.remove("hidden"); // Ensure it displays
    }
    
    // Target the inner scrollable row and give it the unique ID
    const rowEl = clone.querySelector(".catalog-row");
    if (rowEl) {
        rowEl.id = containerId;
    }
    
    // Inject it into the DOM
    container.appendChild(clone);
    
    // Attach the click listener so cards can be opened later
    setupRowClickListener(containerId);
}

// Row message
export function showRowMessage(containerId, message = "No results found.") {
    const row = document.getElementById(containerId);
    if (row) row.innerHTML = `<p class="text-slate-500 pl-2 text-sm mt-4">${message}</p>`;
}