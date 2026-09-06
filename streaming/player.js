import { MKVPlayer } from '../engine/mkv_lib.js';
import { smartFetch, appState, showToast } from '../services/config.js';

export let art = null;
export let currentStreamUrl = "";
let abortPlayback = false;

// --- THE ULTIMATE KILL SWITCH ---
export function stopPlayback() {
    abortPlayback = true;

    // 1. Nuke the WASM Engine Memory first
    if (art && art.mkvEngine) {
        console.log("🧨 Nuking MKV Engine Buffers...");
        try {
            if (typeof art.mkvEngine.destroy === 'function') {
                art.mkvEngine.destroy();
            }
        } catch (e) { }
        art.mkvEngine = null;
    }

    // 2. Force the browser to sever active TCP network streams
    document.querySelectorAll('video, audio').forEach(media => {
        try {
            media.pause();
            media.removeAttribute('src');
            media.load(); // This specifically tells the browser to drop the buffer!
            media.remove();
        } catch (e) { }
    });

    // 3. Destroy the Artplayer UI
    if (art) {
        try { art.destroy(true); } catch (e) { }
        art = null;
    }

    // 4. Hide the Theater
    const wrapper = document.getElementById('player-wrapper');
    if (wrapper) wrapper.classList.add('hidden');
}

// --- SECURE PURE LINK FETCHER ---
// 1. We detach the API call so it has ZERO side effects on the player or UI.
export async function getTorboxLink(tid, fid) {
    const key = localStorage.getItem('tb_api_key');
    const targetUrl = `https://api.torbox.app/v1/api/torrents/requestdl?token=${key}&torrent_id=${tid}&file_id=${fid}&zip=false`;

    try {
        const res = await smartFetch(targetUrl);
        const data = await res.json();

        if (!data.success) {
            throw new Error(data.detail || "Unknown API Error");
        }

        return data.data; // Returns just the raw CDN URL string

    } catch (e) {
        console.error("API Fetch Error:", e);
        showToast("Link Error: " + e.message, 'error');
        return null;
    }
}

// --- SECURE PLAYBACK ORCHESTRATOR ---
// 2. This function now uses the pure fetcher, then boots the player.
export async function requestLink(tid, fid, torrentName, fileName) {
    stopPlayback();

    await new Promise(r => setTimeout(r, 150));

    abortPlayback = false;

    const list = document.getElementById('file-list');
    if (list) list.style.opacity = '0.5';

    // Call our detached fetcher
    const streamUrl = await getTorboxLink(tid, fid);

    if (list) list.style.opacity = '1';

    // If the fetch failed, or the user clicked another movie while we were waiting, abort.
    if (!streamUrl || abortPlayback) {
        if (abortPlayback) console.log("Ghost playback prevented! User clicked something else.");
        return;
    }

    startPlayer(streamUrl, fileName || torrentName);
}

// --- PLAYER INITIALIZATION ---
export function startPlayer(url, name) {
    stopPlayback();
    abortPlayback = false;

    // Attach the URL to the global window object for the External Player modal
    appState.currentStreamUrl = url;
    currentStreamUrl = url;

    const wrapper = document.getElementById('player-wrapper');
    if (wrapper) wrapper.classList.remove('hidden');

    const isMkv = name.toLowerCase().endsWith('.mkv') || url.toLowerCase().split('?')[0].endsWith('.mkv');
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const videoType = isMkv ? 'wasm_mkv' : 'auto';

    art = new Artplayer({
        container: '.artplayer-app',
        url: url,
        title: name,
        type: videoType,
        autoSize: false,
        playsInline: true,
        fullscreen: true,
        fullscreenWeb: false,
        setting: true,
        lock: true,
        fastForward: true,
        theme: '#3b82f6',
        pip: !isIOS,
        autoPlayback: true,
        miniProgressBar: false,
        screenshot: false,
        subtitles: false,
        subtitleOffset: false,
        playbackRate: false,

        controls: [
            {
                position: 'right',
                html: '<svg style="width:22px;height:22px;margin-top:2px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>',
                tooltip: 'Download',
                click: function () {
                    art.notice.show = "Opening Downloader...";

                    // The "Ugly" 1-Click Escape Hatch
                    const a = document.createElement('a');
                    a.href = url;

                    // CRITICAL: We FORCE a new tab. In an iOS PWA, this forces the "mini-browser" overlay to open.
                    a.target = '_blank';

                    // We request a download. The TorBox API headers will do the rest of the heavy lifting.
                    a.download = name || 'movie.mkv';

                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                },
            },
            {
                position: 'right',
                html: '<svg style="width:22px;height:22px;margin-top:2px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>',
                tooltip: 'Open in External Player',
                click: function () {
                    if (art) art.pause();
                    document.getElementById('external-player-modal').classList.remove('hidden');
                },
            }
        ],

        customType: {
            wasm_mkv: async function (videoElement, artUrl, artInstance) {
                console.log("MKV Detected! Booting WebAssembly Engine...");
                artInstance.notice.show = "Booting Engine...";

                try {
                    const player = new MKVPlayer(videoElement);
                    artInstance.mkvEngine = player; // Attach IMMEDIATELY so stopPlayback can find it

                    if (abortPlayback) { player.destroy(); return; }

                    await player.load(artUrl);

                    // 🛑 RACE CONDITION CATCH: Check again after heavy memory load
                    if (abortPlayback) {
                        console.warn("WASM loaded but user clicked away. Self-destructing!");
                        player.destroy();
                        return;
                    }

                    artInstance.notice.show = "Engine Ready!";

                    videoElement.addEventListener('loadeddata', () => {
                        if (!abortPlayback) artInstance.play();
                    }, { once: true });
                } catch (error) {
                    console.error("Engine Crash:", error);
                    if (artInstance && artInstance.notice) {
                        artInstance.notice.show = "Error: Engine failed to decode this MKV.";
                    }
                }
            }
        },
    });

    art.on('video:error', () => {
        console.log("❌ Player Error Detected!");
        handlePlaybackFailure("Format not supported or link is dead.");
    });

    // 1. HIDE THE NATIVE GEAR ICON IMMEDIATELY ON BOOT
    art.on('ready', () => {
        // Target the actual gear button on the bottom control bar
        const gearBtn = art.template.$bottom.querySelector('.art-control-setting');
        if (gearBtn) gearBtn.style.display = 'none';
    });

    // 2. THE SCOUT
    let scoutSent = false;
    art.on('video:playing', async () => {
        if (isMkv && !scoutSent && art.mkvEngine) {

            scoutSent = true;
            console.log("🕵️ Fetching tracks from existing engine...");

            try {
                const player = art.mkvEngine;
                const audioTracks = player.getAudioTracks();

                // Fetch subtitle tracks from your custom engine
                const subtitleTracks = player.getSubtitleTracks();

                const gearBtn = art.template.$bottom.querySelector('.art-control-setting');

                const hasAudioMenu = audioTracks && audioTracks.length > 1;
                const hasSubMenu = subtitleTracks && subtitleTracks.length > 0;

                if (hasAudioMenu || hasSubMenu) {
                    if (gearBtn) gearBtn.style.display = ''; // Unhide gear

                    const langMap = {
                        'eng': 'English', 'gr': 'Greek', 'jpn': 'Japanese', 'spa': 'Spanish',
                        'fre': 'French', 'ger': 'German', 'ita': 'Italian', 'und': 'Unknown'
                    };

                    // --- AUDIO TRACKS ---
                    if (hasAudioMenu) {
                        const trackOptions = audioTracks.map((t, index) => {

                            let langName = langMap[t.language] || (index === 0 ? 'Primary' : `Track ${t.track_number}`);
                            const codecName = t.codec_string ? ` (${t.codec_string})` : '';
                            return { html: `${langName}${codecName}`, trackNumber: t.track_number, default: index === 0 };
                        });

                        art.setting.add({
                            html: 'Audio Track',
                            tooltip: trackOptions[0].html,
                            selector: trackOptions,
                            onSelect: async function (item) {

                                art.notice.show = `Swapping audio...`;
                                const savedTime = art.currentTime;
                                const wasPlaying = art.playing;

                                player.setAudioTrack(item.trackNumber);

                                const restoreVideo = () => {

                                    art.currentTime = savedTime;
                                    if (wasPlaying) art.play();
                                    art.video.removeEventListener('loadeddata', restoreVideo);
                                };
                                art.video.addEventListener('loadeddata', restoreVideo);

                                return item.html;
                            }
                        });
                    }

                    // --- SUBTITLE TRACKS ---
                    if (hasSubMenu) {
                        const subOptions = subtitleTracks.map((t, index) => {
                            let langName = langMap[t.language] || `Subtitle ${t.track_number}`;
                            const codecName = t.codec_string ? ` (${t.codec_string})` : '';
                            return { html: `${langName}`, trackNumber: t.track_number, default: false };
                        });

                        // Add an option to disable subtitles
                        subOptions.unshift({ html: 'Off', trackNumber: -1, default: true });

                        art.setting.add({
                            html: 'Subtitles',
                            tooltip: 'Off',
                            selector: subOptions,
                            onSelect: function (item) {
                                art.notice.show = `Subtitles: ${item.html}`;

                                // Assuming your engine handles subtitle rendering internally
                                player.setSubtitleTrack(item.trackNumber);

                                return item.html;
                            }
                        });
                    }
                } else {
                    if (gearBtn) gearBtn.style.display = 'none';
                }
            } catch (e) {
                console.warn("Scout failed to read tracks:", e);
            }
        }
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function handlePlaybackFailure(reason) {
    if (!art) return;
    art.destroy();
    clearPlayerInstance();
    document.getElementById('player-wrapper').classList.add('hidden');
    showToast(`Playback Failed: ${reason}`, 'error');
}

export function playDirect() {
    const url = document.getElementById('direct-input').value.trim();
    if (!url) return alert("Please paste a link first!");

    if (url.startsWith("magnet:")) {
        alert("❌ Error: You cannot play a Magnet link directly.\n\nMagnet links must be converted by TorBox/Real-Debrid first. Please log in to add this torrent.");
        return;
    }

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
        alert("❌ Error: Invalid Link.");
        return;
    }

    document.getElementById('auth-screen').classList.add('hidden');
    const cleanName = url.split('/').pop().split('?')[0] || "Direct Stream";
    startPlayer(url, decodeURIComponent(cleanName));
}

export function clearPlayerInstance() {
    art = null;
}