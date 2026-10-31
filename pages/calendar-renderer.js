const monthFormatter = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });
const dayFormatter = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

// TMDB dates are calendar dates, not UTC timestamps.
export function localDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function getCalendarDays(month) {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7;
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return Array.from({ length: Math.ceil((offset + count) / 7) * 7 }, (_, index) => {
        const date = new Date(first.getFullYear(), first.getMonth(), index - offset + 1);
        return { date, key: localDateKey(date), inMonth: date.getMonth() === first.getMonth() };
    });
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export function initializeCalendarView(root, { onMonthChange, onToday, onRefresh }) {
    root.innerHTML = `
        <header class="calendar-header">
            <div>
                <p class="calendar-eyebrow">YOUR LIBRARY, UP NEXT</p>
                <h1 id="calendar-title">Release calendar</h1>
                <p class="calendar-description">New episodes, season premieres and movies from your app library.</p>
            </div>
            <button type="button" class="calendar-button" data-calendar-refresh>Refresh dates</button>
        </header>
        <section class="calendar-panel" aria-labelledby="calendar-month">
            <div class="calendar-toolbar">
                <div class="calendar-month-heading">
                    <h2 id="calendar-month"></h2>
                    <span class="calendar-count" id="calendar-count"></span>
                </div>
                <div class="calendar-controls">
                    <button type="button" class="calendar-button calendar-arrow" data-calendar-previous aria-label="Previous month">
                        <svg class="h-5 w-5 rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" focusable="false"><use href="#icon-arrow"></use></svg>
                    </button>
                    <button type="button" class="calendar-button" data-calendar-today>This month</button>
                    <button type="button" class="calendar-button calendar-arrow" data-calendar-next aria-label="Next month">
                        <svg class="h-5 w-5 -rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" focusable="false"><use href="#icon-arrow"></use></svg>
                    </button>
                </div>
            </div>
            <p id="calendar-status" class="calendar-status" role="status" aria-live="polite"></p>
            <div class="calendar-scroll">
                <div class="calendar-board">
                    <div class="calendar-weekdays" aria-hidden="true">
                        <span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span>
                    </div>
                    <div id="calendar-grid" class="calendar-grid"></div>
                </div>
            </div>
        </section>
        <section class="calendar-agenda" aria-labelledby="calendar-agenda-title">
            <div class="calendar-agenda-heading">
                <h2 id="calendar-agenda-title">Drops this month</h2>
                <p>Just the days with something to watch.</p>
            </div>
            <div id="calendar-agenda-list"></div>
        </section>
        <p class="calendar-source">Dates supplied by TMDB and subject to change. Air dates do not confirm availability in your region.</p>`;
    root.querySelector('[data-calendar-previous]').addEventListener('click', () => onMonthChange(-1));
    root.querySelector('[data-calendar-next]').addEventListener('click', () => onMonthChange(1));
    root.querySelector('[data-calendar-today]').addEventListener('click', onToday);
    root.querySelector('[data-calendar-refresh]').addEventListener('click', onRefresh);
}

export function groupCalendarReleases(releases) {
    const days = new Map();
    for (const release of releases) {
        if (!days.has(release.date)) days.set(release.date, new Map());
        const titles = days.get(release.date);
        const key = `${release.type}:${release.tmdbId}`;
        if (!titles.has(key)) titles.set(key, []);
        titles.get(key).push(release);
    }
    return days;
}

function releaseLabel(release) {
    if (release.kind === 'movie') return 'Movie release';
    if (release.kind === 'season') return `Season ${release.season} premiere`;
    const code = `S${String(release.season).padStart(2, '0')} E${String(release.episode).padStart(2, '0')}`;
    return release.episode === 1 ? `${code} · Season premiere` : code;
}

function groupLabel(releases) {
    return releases.length > 1 ? `${releases.length} episodes` : releaseLabel(releases[0]);
}

function poster(release) {
    const frame = element('span', 'calendar-poster');
    frame.append(element('span', 'calendar-poster-fallback', release.title));
    const path = release.poster;
    const src = typeof path === 'string' && path.startsWith('/')
        ? `https://image.tmdb.org/t/p/w185${path}`
        : typeof path === 'string' && /^https?:\/\//i.test(path) ? path : null;
    if (src) {
        const image = document.createElement('img');
        image.src = src;
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.addEventListener('error', () => image.remove(), { once: true });
        frame.append(image);
    }
    return frame;
}

export function renderCalendar(root, { month, releases = [], loading = false, message = '', onOpen }) {
    const monthName = monthFormatter.format(month);
    const today = localDateKey(new Date());
    const grouped = groupCalendarReleases(releases);
    root.querySelector('#calendar-month').textContent = monthName;
    root.querySelector('#calendar-count').textContent = loading ? 'Updating…' : `${releases.length} ${releases.length === 1 ? 'drop' : 'drops'}`;
    root.querySelector('#calendar-status').textContent = message;
    root.querySelector('[data-calendar-refresh]').disabled = loading;
    const grid = root.querySelector('#calendar-grid');
    grid.setAttribute('aria-busy', String(loading));
    const cells = document.createDocumentFragment();
    for (const { date, key, inMonth } of getCalendarDays(month)) {
        const cell = element('section', `calendar-day${inMonth ? '' : ' calendar-day-outside'}${key < today ? ' calendar-day-past' : ''}`);
        cell.setAttribute('aria-label', dayFormatter.format(date));
        const heading = element('h3', 'calendar-day-heading');
        const number = element('time', key === today ? 'calendar-day-number calendar-today' : 'calendar-day-number', String(date.getDate()));
        number.dateTime = key;
        if (key === today) number.setAttribute('aria-current', 'date');
        heading.append(number);
        cell.append(heading);
        if (inMonth) {
            for (const sameTitle of grouped.get(key)?.values() || []) {
                const release = sameTitle[0];
                const button = element('button', 'calendar-drop');
                button.type = 'button';
                button.title = `${release.title} · ${sameTitle.map(releaseLabel).join(', ')}`;
                button.setAttribute('aria-label', `${release.title}, ${groupLabel(sameTitle)}, ${dayFormatter.format(date)}`);
                button.append(poster(release), element('span', 'calendar-drop-title', release.title), element('span', 'calendar-drop-label', groupLabel(sameTitle)));
                button.addEventListener('click', () => onOpen?.(release));
                cell.append(button);
            }
        }
        cells.append(cell);
    }
    grid.replaceChildren(cells);

    const agenda = root.querySelector('#calendar-agenda-list');
    const rows = document.createDocumentFragment();
    if (!releases.length) {
        rows.append(element('p', 'calendar-empty', loading ? 'Checking your library’s release dates…' : message || `No announced drops in ${monthName}. Try another month.`));
    }
    for (const [key, titles] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
        const [year, monthNumber, day] = key.split('-').map(Number);
        const date = new Date(year, monthNumber - 1, day);
        const row = element('section', `calendar-agenda-day${key === today ? ' calendar-agenda-today' : ''}`);
        const heading = element('h3', 'calendar-agenda-date');
        const time = element('time', '', dayFormatter.format(date));
        time.dateTime = key;
        heading.append(time);
        if (key === today) heading.append(element('span', 'calendar-agenda-today-label', 'Today'));
        row.append(heading);
        const items = element('div', 'calendar-agenda-items');
        for (const sameTitle of titles.values()) {
            const release = sameTitle[0];
            const button = element('button', 'calendar-agenda-item');
            button.type = 'button';
            const text = element('span', 'calendar-agenda-copy');
            text.append(element('span', 'calendar-agenda-name', release.title));
            for (const item of sameTitle) {
                text.append(element('span', 'calendar-agenda-episode', `${releaseLabel(item)}${item.name ? ` · ${item.name}` : ''}`));
            }
            button.append(poster(release), text);
            button.addEventListener('click', () => onOpen?.(release));
            items.append(button);
        }
        row.append(items);
        rows.append(row);
    }
    agenda.replaceChildren(rows);
}
