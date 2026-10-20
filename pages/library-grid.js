// Keep only the visible rows and a small scroll buffer in the DOM.
export function createLibraryGrid(container, { items, createCard, onMount, onUnmount }) {
    const scroller = document.getElementById('app-main');
    const top = document.createElement('div');
    const bottom = document.createElement('div');
    for (const spacer of [top, bottom]) {
        spacer.setAttribute('aria-hidden', 'true');
        spacer.style.gridColumn = '1 / -1';
    }
    container.style.overflowAnchor = 'none';
    container.replaceChildren(top, bottom);

    const mounted = new Map();
    let frame = null;
    let destroyed = false;
    let measuredWidth = 0;
    let cardHeight = 0;
    let needsMeasurement = true;
    let previousRange = '';

    function unmount(index, card) {
        onUnmount?.(card, items[index]);
        card.remove();
        mounted.delete(index);
    }

    function schedule() {
        if (!destroyed && frame === null) frame = requestAnimationFrame(update);
    }

    function update() {
        frame = null;
        if (destroyed) return;
        const width = container.clientWidth;
        if (!width || !scroller.clientHeight || !items.length) {
            for (const [index, card] of mounted) unmount(index, card);
            top.style.display = bottom.style.display = 'none';
            previousRange = '';
            return;
        }

        // Read layout once per frame, never once per item.
        const style = getComputedStyle(container);
        const columns = Math.max(1, style.gridTemplateColumns.trim().split(/\s+/).length);
        const gap = parseFloat(style.rowGap) || 0;
        const columnGap = parseFloat(style.columnGap) || 0;
        if (width !== measuredWidth || needsMeasurement) {
            const sample = mounted.values().next().value;
            cardHeight = sample ? parseFloat(getComputedStyle(sample).height) : 0;
            if (!cardHeight) cardHeight = ((width - columnGap * (columns - 1)) / columns) * 1.5 + 24;
            measuredWidth = width;
            needsMeasurement = !sample;
        }
        const stride = cardHeight + gap;
        const rows = Math.ceil(items.length / columns);
        const viewportTop = scroller.getBoundingClientRect().top + scroller.clientTop;
        const scrollOffset = viewportTop - container.getBoundingClientRect().top;
        const firstRow = Math.max(0, Math.min(rows - 1, Math.floor(scrollOffset / stride)) - 2);
        const endRow = Math.min(rows, Math.max(firstRow + 1,
            Math.ceil((scrollOffset + scroller.clientHeight) / stride) + 2));
        const start = firstRow * columns;
        const end = Math.min(items.length, endRow * columns);
        const range = `${start}:${end}:${columns}:${stride}:${rows}`;
        if (range === previousRange) return;
        previousRange = range;

        for (const [index, card] of mounted) {
            if (index < start || index >= end) unmount(index, card);
        }
        top.style.display = firstRow ? '' : 'none';
        top.style.height = `${Math.max(0, firstRow * stride - gap)}px`;
        bottom.style.display = endRow < rows ? '' : 'none';
        bottom.style.height = `${Math.max(0, (rows - endRow) * stride - gap)}px`;

        // Retain overlapping cards rather than rebuilding them on every scroll.
        let next = bottom;
        const added = [];
        for (let index = end - 1; index >= start; index--) {
            let card = mounted.get(index);
            if (!card) {
                card = createCard(items[index]);
                mounted.set(index, card);
                added.push([card, items[index]]);
            }
            if (card.nextSibling !== next) container.insertBefore(card, next);
            next = card;
        }
        for (const [card, item] of added.reverse()) onMount?.(card, item);

        // Refine the initial estimate after the browser lays out the first cards.
        if (needsMeasurement && mounted.size) schedule();
    }

    const resizeObserver = new ResizeObserver(() => {
        measuredWidth = 0;
        schedule();
    });
    resizeObserver.observe(container);
    resizeObserver.observe(scroller);
    scroller.addEventListener('scroll', schedule, { passive: true });
    update();

    return {
        refresh: schedule,
        destroy() {
            destroyed = true;
            if (frame !== null) cancelAnimationFrame(frame);
            resizeObserver.disconnect();
            scroller.removeEventListener('scroll', schedule);
            for (const [index, card] of mounted) unmount(index, card);
            container.replaceChildren();
        }
    };
}
