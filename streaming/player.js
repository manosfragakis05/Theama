import { MKVPlayer } from '../engine/mkv_lib.js';
import { appState, smartFetch, showToast } from '../services/config.js';
import { getCurrentUserSettings } from '../user-data/user-settings.js';
import { upsertWatchProgress } from '../user-data/watch-history.js';

import { advanceToNextItem, retreatToPreviousItem, getQueueState, setQueuePlaybackStatus } from './playlist.js';
import { openExternalPlayer } from './external-players.js';

export let art = null;
let playbackGeneration = 0;
let queuePlaybackUid = null;
let watchProgressInterval = null;
let saveActiveProgress = null;
let progressSave = Promise.resolve();

window.addEventListener('queue:updated', ({ detail }) => {
    if (queuePlaybackUid && detail.current?.uid !== queuePlaybackUid) stopPlayback();
});

// LINK FETCHER
export async function getTorboxLink(tid, fid) {
    const key = getCurrentUserSettings().user_preferences.torboxApiKey; // CHANGE
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

export async function requestLink(tid, fid, torrentName, fileName, queueUid = null, resumePosition = 0) {
    if (queueUid && getQueueState().current?.uid !== queueUid) return;
    const generation = stopPlayback();
    queuePlaybackUid = queueUid;
    if (queueUid) setQueuePlaybackStatus(queueUid, 'loading');

    await new Promise(r => setTimeout(r, 150));
    if (generation !== playbackGeneration) return;

    const list = document.getElementById('file-list');
    while (generation === playbackGeneration) {
        if (list) list.style.opacity = '0.5';
        const streamUrl = await getTorboxLink(tid, fid);
        if (generation !== playbackGeneration) return;
        if (list) list.style.opacity = '1';
        if (streamUrl) {
            startPlayer(streamUrl, fileName || torrentName || 'Untitled', null, queueUid, resumePosition);
            return;
        }
        if (!queueUid) return;
        setQueuePlaybackStatus(queueUid, 'failed');
        const state = getQueueState();
        if (state.priority.length + state.context.length === 0) return;

        // Advancing intentionally changes the selected item within this request.
        queuePlaybackUid = null;
        const next = advanceToNextItem();
        ({ tid, fid, torrentName, fileName, uid: queueUid } = next);
        resumePosition = 0;
        queuePlaybackUid = queueUid;
        setQueuePlaybackStatus(queueUid, 'loading');
    }
}

//#region Player
export function startPlayer(url, name, localFileObject = null, queueUid = null, resumePosition = 0) {
    stopPlayback();
    queuePlaybackUid = queueUid;
    const defaultPlayer = getCurrentUserSettings().user_preferences.defaultPlayer || 'Internal';
    if (defaultPlayer !== 'Internal') {
        openExternalPlayer(url, name, localFileObject, defaultPlayer);
        return;
    }
    if (queueUid) setQueuePlaybackStatus(queueUid, 'loading');

    const generation = playbackGeneration;

    const wrapper = document.getElementById('player-wrapper');
    if (wrapper) wrapper.classList.remove('hidden');

    const isMkv = name.toLowerCase().endsWith('.mkv') || url.toLowerCase().split('?')[0].endsWith('.mkv');
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const videoType = isMkv ? 'wasm_mkv' : 'auto';

    // This app handles playback errors itself. Artplayer's retry would start
    // another MKV load after the current player has been torn down.
    Artplayer.RECONNECT_TIME_MAX = 0;

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
        autoPlayback: false,
        miniProgressBar: false,
        screenshot: false,
        subtitles: false,
        subtitleOffset: false,
        playbackRate: false,

        controls: [
            ...(queueUid ? [
                {
                    position: 'left',
                    index: 5,
                    html: '<svg style="width:24px;height:24px;" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>',
                    tooltip: 'Previous',
                    click: function () {
                        if (generation !== playbackGeneration || getQueueState().current?.uid !== queueUid) return;
                        const prev = retreatToPreviousItem();
                        if (prev) {
                            requestLink(prev.tid, prev.fid, prev.torrentName, prev.fileName, prev.uid);
                        } else {
                            showToast('No previous episode in queue', 'info');
                        }
                    },
                },
                {
                    position: 'left',
                    index: 15,
                    html: '<svg style="width:24px;height:24px;" fill="currentColor" viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>',
                    tooltip: 'Next in Queue',
                    click: function () {
                        if (generation !== playbackGeneration || getQueueState().current?.uid !== queueUid) return;
                        const next = advanceToNextItem();
                        if (next) {
                            requestLink(next.tid, next.fid, next.torrentName, next.fileName, next.uid);
                        } else {
                            showToast('End of queue reached', 'info');
                        }
                    },
                },
            ] : []),
            {
                position: 'right',
                html: '<svg style="width:22px;height:22px;margin-top:2px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>',
                tooltip: 'Open in External Player',
                click: function () {
                    if (art && generation === playbackGeneration) art.pause();
                    openExternalPlayer(url, name, localFileObject);
                },
            }
        ],

        customType: {
            wasm_mkv: async function (videoElement, artUrl, artInstance) {
                console.log("MKV Detected! Booting WebAssembly Engine...");
                artInstance.notice.show = "Booting Engine...";
                const player = new MKVPlayer(videoElement);
                artInstance.mkvEngine = player;
                artInstance.mkvLoading = true;
                const isCurrent = () => art === artInstance && generation === playbackGeneration;

                try {
                    if (!isCurrent()) return;

                    await player.load(artUrl);

                    // 🛑 RACE CONDITION CATCH: Check again after heavy memory load
                    if (!isCurrent()) return;

                    artInstance.notice.show = "Engine Ready!";

                    const playWhenReady = () => {
                        if (isCurrent()) artInstance.play();
                    };
                    if (videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) playWhenReady();
                    else videoElement.addEventListener('loadeddata', playWhenReady, { once: true });
                } catch (error) {
                    if (isCurrent()) {
                        console.error("Engine Crash:", error);
                        handlePlaybackFailure("Engine failed to decode this MKV.");
                    }
                } finally {
                    artInstance.mkvLoading = false;
                    if (!isCurrent()) {
                        try { await player.destroy(); }
                        catch (error) { console.warn("Engine cleanup failed:", error); }
                        artInstance.mkvEngine = null;
                    }
                }
            }
        },
    });

    const playerArt = art;
    const video = playerArt.video;
    const resumeTime = Number(resumePosition);
    let resumePending = Number.isFinite(resumeTime) && resumeTime > 0;
    const removeResumeListeners = () => {
        video.removeEventListener('loadedmetadata', restorePosition);
        video.removeEventListener('loadeddata', restorePosition);
    };
    const restorePosition = () => {
        if (!resumePending || art !== playerArt || generation !== playbackGeneration
            || video.readyState < 1 || !Number.isFinite(video.duration) || video.duration <= 0) return;
        try {
            // Native seeking also tells the MKV remuxer to load the matching clusters.
            video.currentTime = Math.min(resumeTime, video.duration);
            resumePending = false;
            removeResumeListeners();
        } catch (error) {
            console.warn('Could not restore playback position:', error);
        }
    };
    if (resumePending) {
        video.addEventListener('loadedmetadata', restorePosition);
        video.addEventListener('loadeddata', restorePosition);
        restorePosition();
    }

    const media = queueUid && getQueueState().current?.uid === queueUid
        ? getQueueState().current : null;

    const completedForUsers = new Set();
    let lastSavedSample = null;
    const saveProgress = () => {
        const userId = appState.currentUser?.id;
        if (!media || !userId || resumePending) return;
        if (!Number.isFinite(video.currentTime) || !Number.isFinite(video.duration)
            || video.currentTime < 0 || video.duration < 1) return;
        const duration = Math.floor(video.duration);
        const position = Math.min(Math.floor(video.currentTime), duration);
        // Each sample gets its own upsert; serialize writes so episode counts stay ordered.
        progressSave = progressSave.then(async () => {
            if (lastSavedSample?.userId === userId && lastSavedSample.position === position
                && lastSavedSample.duration === duration) return;
            const result = await upsertWatchProgress(position, duration, {
                media, userId, countCompletion: !completedForUsers.has(userId)
            });
            if (result) lastSavedSample = { userId, position, duration };
            if (result?.completed) completedForUsers.add(userId);
        });
    };
    saveActiveProgress = saveProgress;

    const progressInterval = media ? setInterval(() => {
        if (art === playerArt && generation === playbackGeneration && !video.paused && !video.ended) saveProgress();
    }, 60_000) : null;
    watchProgressInterval = progressInterval;
    const saveCurrentProgress = () => {
        if (art === playerArt && generation === playbackGeneration) saveProgress();
    };
    const onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') saveCurrentProgress();
    };
    if (media) document.addEventListener('visibilitychange', onVisibilityChange);
    playerArt.on('video:pause', saveCurrentProgress);
    playerArt.on('destroy', () => {
        removeResumeListeners();
        clearInterval(progressInterval);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        if (saveActiveProgress === saveProgress) saveActiveProgress = null;
    });
    const closePlayerButton = document.getElementById('close-player-btn');
    const syncCloseButton = () => {
        if (art !== playerArt || generation !== playbackGeneration) return;
        closePlayerButton?.classList.toggle('hidden', !playerArt.controls.show);
    };
    playerArt.on('control', syncCloseButton);
    syncCloseButton();

    // Auto skip when video ends
    playerArt.on('video:ended', () => {
        if (art !== playerArt || generation !== playbackGeneration) return;
        saveProgress();
        if (!queueUid || getQueueState().current?.uid !== queueUid) return;
        const next = advanceToNextItem();
        if (next) {
            showToast(`Playing Next: ${next.title}`, 'info');
            requestLink(next.tid, next.fid, next.torrentName, next.fileName, next.uid);
        }
    });

    playerArt.on('video:error', () => {
        if (art !== playerArt || generation !== playbackGeneration) return;
        console.log("❌ Player Error Detected!");
        handlePlaybackFailure("Format not supported or link is dead.");
    });

    // 1. HIDE THE NATIVE GEAR ICON IMMEDIATELY ON BOOT
    playerArt.on('ready', () => {
        syncCloseButton();
        // Target the actual gear button on the bottom control bar
        const gearBtn = playerArt.template.$bottom.querySelector('.art-control-setting');
        if (gearBtn) gearBtn.style.display = 'none';
    });

    // 2. THE SCOUT
    let scoutSent = false;
    playerArt.on('video:playing', async () => {
        if (art !== playerArt || generation !== playbackGeneration) return;
        if (queueUid) setQueuePlaybackStatus(queueUid, 'playing');
        if (isMkv && !scoutSent && playerArt.mkvEngine) {

            scoutSent = true;
            console.log("🕵️ Fetching tracks from existing engine...");

            try {
                const player = playerArt.mkvEngine;
                const audioTracks = player.getAudioTracks();

                // Fetch subtitle tracks from your custom engine
                const subtitleTracks = player.getSubtitleTracks();

                const gearBtn = playerArt.template.$bottom.querySelector('.art-control-setting');

                const hasAudioMenu = audioTracks && audioTracks.length > 1;
                const hasSubMenu = subtitleTracks && subtitleTracks.length > 0;

                if (hasAudioMenu || hasSubMenu) {
                    if (gearBtn) gearBtn.style.display = ''; // Unhide gear

                    const langMap = {
                        'und': 'Unknown',

                        // Common ISO 639-1 (2-letter) fallbacks
                        'en': 'English', 'es': 'Spanish', 'fr': 'French', 'de': 'German',
                        'it': 'Italian', 'ja': 'Japanese', 'ko': 'Korean', 'zh': 'Chinese',
                        'ru': 'Russian', 'pt': 'Portuguese', 'ar': 'Arabic', 'hi': 'Hindi',

                        // Complete ISO 639-2 (3-letter) MKV Standard
                        'aar': 'Afar', 'abk': 'Abkhazian', 'afr': 'Afrikaans', 'aka': 'Akan',
                        'alb': 'Albanian', 'sqi': 'Albanian', 'amh': 'Amharic', 'ara': 'Arabic',
                        'arg': 'Aragonese', 'arm': 'Armenian', 'hye': 'Armenian', 'asm': 'Assamese',
                        'ava': 'Avaric', 'ave': 'Avestan', 'aym': 'Aymara', 'aze': 'Azerbaijani',
                        'bak': 'Bashkir', 'bam': 'Bambara', 'baq': 'Basque', 'eus': 'Basque',
                        'bel': 'Belarusian', 'ben': 'Bengali', 'bih': 'Bihari', 'bis': 'Bislama',
                        'bos': 'Bosnian', 'bre': 'Breton', 'bul': 'Bulgarian', 'bur': 'Burmese',
                        'mya': 'Burmese', 'cat': 'Catalan', 'cha': 'Chamorro', 'che': 'Chechen',
                        'nya': 'Chichewa', 'chi': 'Chinese', 'zho': 'Chinese', 'chv': 'Chuvash',
                        'cor': 'Cornish', 'cos': 'Corsican', 'cre': 'Cree', 'hrv': 'Croatian',
                        'cze': 'Czech', 'ces': 'Czech', 'dan': 'Danish', 'div': 'Divehi',
                        'dut': 'Dutch', 'nld': 'Dutch', 'dzo': 'Dzongkha', 'eng': 'English',
                        'epo': 'Esperanto', 'est': 'Estonian', 'ewe': 'Ewe', 'fao': 'Faroese',
                        'fij': 'Fijian', 'fin': 'Finnish', 'fre': 'French', 'fra': 'French',
                        'ful': 'Fulah', 'gla': 'Gaelic', 'glg': 'Galician', 'lug': 'Ganda',
                        'geo': 'Georgian', 'kat': 'Georgian', 'ger': 'German', 'deu': 'German',
                        'gre': 'Greek', 'ell': 'Greek', 'grn': 'Guarani', 'guj': 'Gujarati',
                        'hat': 'Haitian', 'hau': 'Hausa', 'heb': 'Hebrew', 'her': 'Herero',
                        'hin': 'Hindi', 'hmo': 'Hiri Motu', 'hun': 'Hungarian', 'ice': 'Icelandic',
                        'isl': 'Icelandic', 'ido': 'Ido', 'ibo': 'Igbo', 'ind': 'Indonesian',
                        'ina': 'Interlingua', 'ile': 'Interlingue', 'iku': 'Inuktitut',
                        'ipk': 'Inupiaq', 'gle': 'Irish', 'ita': 'Italian', 'jpn': 'Japanese',
                        'jav': 'Javanese', 'kal': 'Kalaallisut', 'kan': 'Kannada', 'kau': 'Kanuri',
                        'kas': 'Kashmiri', 'kaz': 'Kazakh', 'khm': 'Khmer', 'kik': 'Kikuyu',
                        'kin': 'Kinyarwanda', 'kir': 'Kyrgyz', 'kom': 'Komi', 'kon': 'Kongo',
                        'kor': 'Korean', 'kua': 'Kuanyama', 'kur': 'Kurdish', 'lao': 'Lao',
                        'lat': 'Latin', 'lav': 'Latvian', 'lim': 'Limburgan', 'lin': 'Lingala',
                        'lit': 'Lithuanian', 'lub': 'Luba-Katanga', 'ltz': 'Luxembourgish',
                        'mac': 'Macedonian', 'mkd': 'Macedonian', 'mlg': 'Malagasy', 'may': 'Malay',
                        'msa': 'Malay', 'mal': 'Malayalam', 'mlt': 'Maltese', 'glv': 'Manx',
                        'mao': 'Maori', 'mri': 'Maori', 'mar': 'Marathi', 'mah': 'Marshallese',
                        'mon': 'Mongolian', 'nau': 'Nauru', 'nav': 'Navajo', 'nde': 'North Ndebele',
                        'nbl': 'South Ndebele', 'ndo': 'Ndonga', 'nep': 'Nepali', 'sme': 'Northern Sami',
                        'nor': 'Norwegian', 'nob': 'Norwegian Bokmål', 'nno': 'Norwegian Nynorsk',
                        'oci': 'Occitan', 'oji': 'Ojibwa', 'ori': 'Odia', 'orm': 'Oromo',
                        'oss': 'Ossetian', 'pli': 'Pali', 'per': 'Persian', 'fas': 'Persian',
                        'pol': 'Polish', 'por': 'Portuguese', 'pan': 'Punjabi', 'que': 'Quechua',
                        'rum': 'Romanian', 'ron': 'Romanian', 'roh': 'Romansh', 'run': 'Rundi',
                        'rus': 'Russian', 'sag': 'Sango', 'san': 'Sanskrit', 'srd': 'Sardinian',
                        'srp': 'Serbian', 'sna': 'Shona', 'iii': 'Sichuan Yi', 'snd': 'Sindhi',
                        'sin': 'Sinhala', 'slo': 'Slovak', 'slk': 'Slovak', 'slv': 'Slovenian',
                        'som': 'Somali', 'sot': 'Southern Sotho', 'spa': 'Spanish', 'sun': 'Sundanese',
                        'swa': 'Swahili', 'ssw': 'Swati', 'swe': 'Swedish', 'tgl': 'Tagalog',
                        'tah': 'Tahitian', 'tgk': 'Tajik', 'tam': 'Tamil', 'tat': 'Tatar',
                        'tel': 'Telugu', 'tha': 'Thai', 'tib': 'Tibetan', 'bod': 'Tibetan',
                        'tir': 'Tigrinya', 'ton': 'Tonga', 'tsn': 'Tswana', 'tso': 'Tsonga',
                        'tuk': 'Turkmen', 'tur': 'Turkish', 'twi': 'Twi', 'uig': 'Uighur',
                        'ukr': 'Ukrainian', 'urd': 'Urdu', 'uzb': 'Uzbek', 'ven': 'Venda',
                        'vie': 'Vietnamese', 'vol': 'Volapük', 'wln': 'Walloon', 'wel': 'Welsh',
                        'cym': 'Welsh', 'fry': 'Western Frisian', 'wol': 'Wolof', 'xho': 'Xhosa',
                        'yid': 'Yiddish', 'yor': 'Yoruba', 'zha': 'Zhuang', 'zul': 'Zulu'
                    };

                    // --- AUDIO TRACKS ---
                    if (hasAudioMenu) {
                        const trackOptions = audioTracks.map((t, index) => {

                            let langName = langMap[t.language] || (index === 0 ? 'Primary' : `Track ${t.track_number}`);
                            const codecName = t.codec_id ? ` (${t.codec_id})` : '';
                            return { html: `${langName}${codecName}`, trackNumber: t.track_number, default: index === 0 };
                        });

                        playerArt.setting.add({
                            html: 'Audio Track',
                            tooltip: trackOptions[0].html,
                            selector: trackOptions,
                            onSelect: async function (item) {
                                if (art !== playerArt || generation !== playbackGeneration) return item.html;

                                playerArt.notice.show = `Swapping audio...`;
                                const savedTime = playerArt.currentTime;
                                const wasPlaying = playerArt.playing;

                                player.setAudioTrack(item.trackNumber);

                                const restoreVideo = () => {

                                    if (art === playerArt && generation === playbackGeneration) {
                                        playerArt.currentTime = savedTime;
                                        if (wasPlaying) playerArt.play();
                                    }
                                    playerArt.video.removeEventListener('loadeddata', restoreVideo);
                                };
                                playerArt.video.addEventListener('loadeddata', restoreVideo);

                                return item.html;
                            }
                        });
                    }

                    // --- SUBTITLE TRACKS ---
                    if (hasSubMenu) {
                        const subOptions = subtitleTracks.map((t, index) => {
                            // If you added the MKV Name extraction earlier, use it here!
                            const customName = t.name ? `(${t.name}) ` : '';
                            let langName = langMap[t.language] || `Subtitle ${t.track_number}`;

                            // Match the engine: Set the first track (index 0) as the UI default
                            return { html: `${customName}${langName}`, trackNumber: t.track_number, default: index === 0 };
                        });

                        // Add "Off", but set default to FALSE
                        subOptions.unshift({ html: 'Off', trackNumber: -1, default: false });

                        // Find whichever option we flagged as default to set the initial tooltip text
                        const defaultSub = subOptions.find(opt => opt.default);

                        playerArt.setting.add({
                            html: 'Subtitles',
                            tooltip: defaultSub.html, // Dynamically display the default track name
                            selector: subOptions,
                            onSelect: function (item) {
                                if (art !== playerArt || generation !== playbackGeneration) return item.html;
                                playerArt.notice.show = `Subtitles: ${item.html}`;

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

export function stopPlayback() {
    const saveProgress = saveActiveProgress;
    saveActiveProgress = null;
    saveProgress?.();
    clearInterval(watchProgressInterval);
    watchProgressInterval = null;
    const generation = ++playbackGeneration;
    const instance = art;
    const stoppedQueueUid = queuePlaybackUid;
    queuePlaybackUid = null;
    art = null;
    if (stoppedQueueUid) setQueuePlaybackStatus(stoppedQueueUid, 'idle');

    if (instance) {
        // A load that is still in progress destroys itself when it settles.
        if (instance.mkvEngine && !instance.mkvLoading) {
            try {
                Promise.resolve(instance.mkvEngine.destroy()).catch(error => {
                    console.warn("Engine cleanup failed:", error);
                });
            } catch (error) {
                console.warn("Engine cleanup failed:", error);
            }
            instance.mkvEngine = null;
        }
        try { instance.destroy(true); }
        catch (error) { console.warn("Player cleanup failed:", error); }
    }

    const wrapper = document.getElementById('player-wrapper');
    if (wrapper) wrapper.classList.add('hidden');
    const list = document.getElementById('file-list');
    if (list) list.style.opacity = '1';
    return generation;
}

export function handlePlaybackFailure(reason) {
    if (!art) return;
    const failedQueueUid = queuePlaybackUid;
    stopPlayback();
    showToast(`Playback Failed: ${reason}`, 'error');
    if (failedQueueUid && getQueueState().current?.uid === failedQueueUid) {
        setQueuePlaybackStatus(failedQueueUid, 'failed');
        const state = getQueueState();
        if (state.priority.length + state.context.length > 0) {
            const next = advanceToNextItem();
            requestLink(next.tid, next.fid, next.torrentName, next.fileName, next.uid);
        }
    }
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
