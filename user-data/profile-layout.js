let personalSource = 'watchlists';
let initialized = false;
let onAniListSelected = () => {};

function selectSource(source, focus = false, load = true) {
    const page = document.getElementById('profile-page');
    if (!page || !['watchlists', 'anilist'].includes(source)) return;
    if (page.dataset.public !== 'true') personalSource = source;

    for (const button of page.querySelectorAll('[data-profile-source]')) {
        const selected = button.dataset.profileSource === source;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
        document.getElementById(button.getAttribute('aria-controls')).hidden = !selected;
        if (selected && focus) button.focus();
    }
    if (source === 'anilist' && load) onAniListSelected();
}

export function setProfileLayoutMode(personal, showPublicTabs = false) {
    const page = document.getElementById('profile-page');
    if (!page) return;
    page.dataset.public = String(!personal);
    document.getElementById('profile-source-tabs').hidden = !personal && !showPublicTabs;
    selectSource(personal ? personalSource : 'watchlists', false, false);
}

export function initializeProfileLayout({ onAniList = () => {} } = {}) {
    if (initialized) return;
    const tablist = document.getElementById('profile-source-tabs');
    if (!tablist) return;
    initialized = true;
    onAniListSelected = onAniList;
    const buttons = [...tablist.querySelectorAll('[data-profile-source]')];
    for (const button of buttons) {
        button.addEventListener('click', () => selectSource(button.dataset.profileSource));
        button.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const index = buttons.indexOf(button);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
            selectSource(buttons[next].dataset.profileSource, true);
        });
    }
}
