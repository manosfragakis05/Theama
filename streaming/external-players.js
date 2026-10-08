import { showToast } from '../services/config.js';

// State variables to track the current video and prevent duplicate listeners
let currentVideoUrl = "";
let currentVideoName = "";
let listenersAttached = false;
let onPlayerSelected = null;

const playerPlatforms = {
    vlc: ['ios', 'android'],
    potplayer: ['windows'],
    infuse: ['ios', 'macos'],
    outplayer: ['ios'],
    mxplayer: ['android'],
    iina: ['macos'],
};

function getOperatingSystem() {
    const userAgent = navigator.userAgent || '';
    const platform = navigator.userAgentData?.platform || navigator.platform || '';

    // iPadOS can identify itself as a Mac when using a desktop user agent.
    if (/iPad|iPhone|iPod/i.test(userAgent) ||
        (/Mac/i.test(platform) && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Android/i.test(userAgent)) return 'android';
    if (/Win/i.test(platform) || /Windows/i.test(userAgent)) return 'windows';
    if (/Mac/i.test(platform) || /Macintosh/i.test(userAgent)) return 'macos';
    if (/Linux/i.test(platform) || /Linux/i.test(userAgent)) return 'linux';
    return 'unknown';
}

function showPlayerModal(onSelect = null) {
    onPlayerSelected = onSelect;
    const modal = document.getElementById('external-player-modal');
    const operatingSystem = getOperatingSystem();
    const players = modal.querySelectorAll('.external-player-btn');
    modal.querySelector('h3').textContent = onSelect ? 'Default Player' : 'Open in App...';

    players.forEach(player => {
        const supported = player.dataset.player === 'Internal'
            ? Boolean(onSelect)
            : playerPlatforms[player.dataset.player]?.includes(operatingSystem) ?? false;
        player.classList.toggle('hidden', !supported);
    });

    if (!listenersAttached) {
        players.forEach(player => {
            player.addEventListener('click', (e) => {
                const button = e.currentTarget;
                const target = button.dataset.player;
                if (!target || button.classList.contains('hidden')) return;

                if (onPlayerSelected) {
                    const onSelect = onPlayerSelected;
                    onPlayerSelected = null;
                    modal.classList.add('hidden');
                    onSelect(target, button.querySelector('.font-bold').textContent.trim());
                } else {
                    urlExternalPlayer(target);
                }
            });
        });
        listenersAttached = true;
    }

    modal.classList.remove('hidden');
}

export function openPlayerSelection(onSelect) {
    showPlayerModal(onSelect);
}

export function openExternalPlayer(videoUrl, videoName, localFileObject = null, selectedPlayer = null) {
    if (!videoUrl) return;

    currentVideoUrl = videoUrl;
    currentVideoName = videoName;

    if (currentVideoUrl.startsWith("blob")) {
        showToast("Local file selected. Opening share menu...");

        if (localFileObject && navigator.canShare && navigator.canShare({ files: [localFileObject] })) {
            navigator.share({
                files: [localFileObject],
                title: currentVideoName || 'Local Video',
            }).catch(err => console.error('Share failed:', err));
        } else {
            showToast("Your browser does not support sharing local files to apps.", "error");
        }
        return;
    }

    if (currentVideoUrl.startsWith("http")) {
        if (selectedPlayer) {
            urlExternalPlayer(selectedPlayer);
            return;
        }
        showToast("URL selected.");
        showPlayerModal();
    }
}

export function urlExternalPlayer(player) {
    // Access the URL from the module state
    if (!currentVideoUrl) {
        showToast("No video stream selected yet.", "error");
        return;
    }

    const encodedUrl = encodeURIComponent(currentVideoUrl);
    let deepLink = '';

    switch (player) {
        case 'vlc':
            deepLink = currentVideoUrl.replace(/^https?:\/\//i, 'vlc://');
            break;

        case 'potplayer':
            deepLink = `potplayer://${currentVideoUrl}`;;
            break;

        case 'infuse':
            deepLink = `infuse://x-callback-url/play?url=${encodedUrl}`;
            break;

        case 'outplayer':
            deepLink = `outplayer://${currentVideoUrl}`;
            break;

        case 'mxplayer':
            deepLink = `intent:${currentVideoUrl}#Intent;package=com.mxtech.videoplayer.ad;S.title=${encodeURIComponent(currentVideoName || "TorBox Stream")};end`;
            break;

        case 'iina':
            deepLink = `iina://weblink?url=${encodedUrl}`;
            break;

        default:
            showToast("Unknown external player. Please select a default player in settings.", "error");
            return;
    }

    document.getElementById('external-player-modal').classList.add('hidden');

    window.location.href = deepLink;
}
