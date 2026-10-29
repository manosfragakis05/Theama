export let isDragging = false;
let activeSlider = null;
let startX;
let scrollLeft;
let pendingScrollLeft;
let frameId = null;
let clickResetTimer = null;
let draggedRow = null;
let isDragInitialized = false;

function resetClickSuppression() {
    clearTimeout(clickResetTimer);
    clickResetTimer = null;
    isDragging = false;
    draggedRow = null;
}

function stopDrag() {
    if (!activeSlider) return;
    const finishedSlider = activeSlider;
    // A released gesture must never leave a callback using shared state later.
    if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
        if (finishedSlider.isConnected) finishedSlider.scrollLeft = pendingScrollLeft;
    }
    activeSlider = null;
    finishedSlider.classList.remove('cursor-grabbing', 'pointer-events-none');
    document.body.classList.remove('select-none', 'cursor-grabbing');
    // Keep the release click from opening a card, without delaying drag cleanup.
    if (isDragging) {
        clearTimeout(clickResetTimer);
        clickResetTimer = setTimeout(resetClickSuppression, 50);
    }
}

function cancelDrag() {
    stopDrag();
    resetClickSuppression();
}

export function initGlobalDrag() {
    if (isDragInitialized) return;
    isDragInitialized = true;

    document.addEventListener('mousedown', e => {
        if (e.button !== 0 || e.ctrlKey) return;
        const slider = e.target.closest?.('.draggable-row');
        // Vertical queue layouts and rows that fit need only native scrolling.
        if (!slider || slider.scrollWidth <= slider.clientWidth + 1) return;
        if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        stopDrag();
        resetClickSuppression();
        activeSlider = slider;
        startX = e.clientX;
        scrollLeft = slider.scrollLeft;
    });

    window.addEventListener('mousemove', e => {
        if (!activeSlider) return;
        // Mouseup can be lost outside the window, during Alt-Tab or native UI.
        if (!(e.buttons & 1) || !activeSlider.isConnected) {
            cancelDrag();
            return;
        }
        const walk = (e.clientX - startX) * 2;
        if (!isDragging) {
            if (Math.abs(walk) <= 5) return;
            isDragging = true;
            draggedRow = activeSlider;
            activeSlider.classList.add('cursor-grabbing');
            document.body.classList.add('select-none', 'cursor-grabbing');
        }
        e.preventDefault();
        pendingScrollLeft = scrollLeft - walk;
        if (frameId === null) {
            const slider = activeSlider;
            frameId = window.requestAnimationFrame(() => {
                frameId = null;
                if (activeSlider !== slider) return;
                if (!slider.isConnected) {
                    cancelDrag();
                    return;
                }
                slider.scrollLeft = pendingScrollLeft;
            });
        }
    });

    // Suppress clicks before card/button handlers run, without disabling hit testing
    // on the whole row (which also blocks touch and trackpad interaction).
    document.addEventListener('click', e => {
        if (!isDragging || !draggedRow?.contains(e.target) || e.detail === 0) return;
        e.preventDefault();
        e.stopPropagation();
    }, true);
    document.addEventListener('dragstart', e => {
        if (activeSlider?.contains(e.target)) e.preventDefault();
    }, true);
    window.addEventListener('mouseup', stopDrag);
    document.addEventListener('mouseleave', cancelDrag);
    window.addEventListener('blur', cancelDrag);
    window.addEventListener('pagehide', cancelDrag);
    window.addEventListener('pointercancel', cancelDrag);
    window.addEventListener('dragend', cancelDrag);
    window.addEventListener('contextmenu', cancelDrag);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) cancelDrag();
    });
}
