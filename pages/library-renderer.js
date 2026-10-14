export function createLibraryCard( title, poster, mediaText = "Series", size ) {
    const card = document.getElementById('library-card-template').content.firstElementChild.cloneNode(true);
    const image = card.querySelector('.library-poster');
    const fallback = card.querySelector('.library-fallback');

    card.querySelector('.library-title').textContent = title;
    fallback.textContent = title;
    image.alt = title;

    card.querySelector('.library-type').textContent = mediaText;
    if(mediaText == "Movie" || mediaText == "Single Episode") {
        card.querySelector('[data-action="download"]').classList.remove('hidden');
    } else {
        card.querySelector('[data-action="download"]').classList.add('hidden');
    }

    image.addEventListener('error', () => {
        image.classList.add('hidden');
        fallback.classList.remove('hidden');
    });
    if (poster) {
        image.src = poster.startsWith('/') ? `https://image.tmdb.org/t/p/w300${poster}` : poster;
        image.classList.remove('hidden');
        fallback.classList.add('hidden');
    }

    if (Number.isFinite(size)) {
        const badge = card.querySelector('.library-size');
        badge.textContent = `${(size / 1073741824).toFixed(1)} GB`;
        badge.classList.remove('hidden');
    }
    return card;
}
