import { showToast } from '../services/config.js';

// State variables to track the current video and prevent duplicate listeners
let currentVideoUrl = "";
let currentVideoName = "";
let listenersAttached = false;

export function openExternalPlayer(videoUrl, videoName, localFileObject = null) {
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
        showToast("URL selected.");
        document.getElementById('external-player-modal').classList.remove('hidden');

        if (!listenersAttached) {
            const extPlayers = document.querySelectorAll('.external-player-btn');
            extPlayers.forEach(player => {
                player.addEventListener('click', (e) => {
                    const target = e.currentTarget.dataset.player;
                    if (target) {
                        urlExternalPlayer(target);
                    }
                });
            });
            listenersAttached = true;
        }
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
            showToast("Cant open VLC in pc.", "error");
            deepLink = currentVideoUrl.replace(/^https?:\/\//i, 'vlc://');
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
    }

    document.getElementById('external-player-modal').classList.add('hidden');

    window.location.href = deepLink;
}