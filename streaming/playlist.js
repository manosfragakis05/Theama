// streaming/playlist.js
import { getTorboxLink } from './player.js';

const STORAGE_KEY_QUEUE = 'pwa_active_queue_v1';
const STORAGE_KEY_PLAYLISTS = 'pwa_saved_playlists_v1';

// --- SINGLE UNIFIED STATE ---
let queueState = loadFromStorage(STORAGE_KEY_QUEUE, {
    seriesTitle: '',
    seasonLabel: '',
    current: null,          // Currently playing item
    priority: [],           // "Add to Queue" items (always play first)
    context: [],            // Active playlist or series episodes
    originalContext: [],    // Unshuffled backup of context
    history: [],            // Previously played items
    isShuffled: false,
    repeatMode: 'off'       // 'off' | 'all' | 'one'
});

let playlists = loadFromStorage(STORAGE_KEY_PLAYLISTS, []);

// --- HELPERS ---
function loadFromStorage(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        console.error('Storage load error:', e);
        return fallback;
    }
}

function getQueueEntries(useSaved = true) {
    if (useSaved && queueState.entries) return queueState.entries;

    // Keep any "Previous" items that were above the current item
    let previousEntries = [];
    if (Array.isArray(queueState.entries) && queueState.current) {
        const currentIdx = queueState.entries.findIndex(e => e.item.uid === queueState.current.uid);
        if (currentIdx > 0) {
            previousEntries = queueState.entries.slice(0, currentIdx);
        }
    }

    const originalIndices = new Map(queueState.originalContext.map((item, index) => [item.uid, index]));
    return [
        ...previousEntries,
        ...(queueState.current ? [{ item: queueState.current, listType: 'context', originalIndex: -1 }] : []),
        ...queueState.priority.map(item => ({ item, listType: 'priority' })),
        ...queueState.context.map(item => ({ item, listType: 'context', originalIndex: originalIndices.get(item.uid) }))
    ];
}

function saveQueue(preserveEntries = false) {
    if (!preserveEntries) {
        queueState.entries = getQueueEntries(false);
    }
    localStorage.setItem(STORAGE_KEY_QUEUE, JSON.stringify(queueState));
    window.dispatchEvent(new CustomEvent('queue:updated', { detail: getQueueState() }));
}

function savePlaylists() {
    localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(playlists));
    window.dispatchEvent(new CustomEvent('playlists:updated', { detail: playlists }));
}

function createQueueItem(data) {
    if (data.tid === undefined || data.fid === undefined) {
        throw new Error('Both tid (Torrent ID) and fid (File ID) are required.');
    }
    return {
        uid: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        tid: data.tid,
        fid: data.fid,
        seriesTitle: data.seriesTitle || '',
        season: data.season || '',
        episodeNumber: data.episodeNumber ?? null,
        badge: data.badge || '',
        title: data.title || data.fileName || `Torrent ${data.tid} - File ${data.fid}`,
        fileName: data.fileName || data.title || '',       // Used by player.js for .mkv check
        torrentName: data.torrentName || '',
        thumbnail: data.thumbnail || data.poster || '',
        size: data.size || '',
        meta: data.meta || {}
    };
}

let lastShuffledSignature = '';

function shuffleArray(array) {
    if (array.length <= 1) return [...array];

    let arr;
    let signature = '';
    let attempts = 0;

    // Re-roll if the random shuffle accidentally matches the previous shuffle or original order
    const originalSignature = array.map(i => i.uid).join(',');
    do {
        arr = [...array];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        signature = arr.map(i => i.uid).join(',');
        attempts++;
    } while (
        attempts < 10 &&
        array.length > 2 &&
        (signature === lastShuffledSignature || signature === originalSignature)
    );

    lastShuffledSignature = signature;
    return arr;
}

// ==========================================
// 1. PICKER INTEGRATION (Series Queue Setup)
// ==========================================

// Holds the pre-built multi-season list when the user opens a show in the picker
let stagedSeriesItems = [];

/**
 * Called when the user opens a show or switches the season dropdown in picker.js.
 * Stages the full multi-season list in memory (without wiping localStorage yet).
 */
export function buildSeriesQueue(seriesTitle, seasonLabel, episodeItems) {
    stagedSeriesItems = episodeItems.map(createQueueItem);

    return stagedSeriesItems;
}

/**
 * Called when the user clicks an episode card OR the "Play" button in picker.js.
 * Commits the staged multi-season queue to active state and returns the episode to play.
 */
export function startQueueFromEpisode(clickedIndex = 0) {
    if (stagedSeriesItems.length === 0) return null;

    if (queueState.current) {
        queueState.history.push(queueState.current);
    }

    const selectedEpisode = stagedSeriesItems[clickedIndex] || stagedSeriesItems[0];
    const remainingEpisodes = stagedSeriesItems.slice(clickedIndex + 1);

    queueState.seriesTitle = selectedEpisode.seriesTitle;
    queueState.seasonLabel = selectedEpisode.season;
    queueState.isShuffled = false;
    queueState.current = selectedEpisode;
    queueState.originalContext = [...remainingEpisodes];
    queueState.context = [...remainingEpisodes];

    console.log('▶️ [Now Playing]:', queueState.current);
    console.log(`⏭️ [Up Next Across Seasons] (${queueState.context.length} remaining):`, queueState.context);

    saveQueue();
    return selectedEpisode;
}

/**
 * Called when the user clicks the "Play Random / Shuffle" button in picker.js.
 * Picks a random episode across the staged seasons, shuffles the rest, and returns the first episode.
 */
export function startShuffledQueue() {
    if (stagedSeriesItems.length === 0) return null;

    if (queueState.current) {
        queueState.history.push(queueState.current);
    }

    const shuffled = shuffleArray(stagedSeriesItems);
    const firstEpisode = shuffled[0];
    const remainingEpisodes = shuffled.slice(1);

    queueState.seriesTitle = firstEpisode.seriesTitle;
    queueState.seasonLabel = firstEpisode.season;
    queueState.isShuffled = true;
    queueState.current = firstEpisode;
    queueState.originalContext = stagedSeriesItems.filter(i => i.uid !== firstEpisode.uid);
    queueState.context = remainingEpisodes;

    console.log('🔀▶️ [Now Playing Random]:', queueState.current);
    console.log(`🔀⏭️ [Shuffled Queue] (${queueState.context.length} remaining):`, queueState.context);

    saveQueue();
    return firstEpisode;
}

/**
 * Appends the currently staged series/season into the Priority Queue
 * without wiping the currently playing show.
 */
export function queueStagedSeries() {
    if (stagedSeriesItems.length === 0) return 0;

    const itemsToAdd = stagedSeriesItems.map(createQueueItem);
    const hasExistingQueue = Boolean(
        queueState.current || queueState.priority.length > 0 || queueState.context.length > 0
    );

    if (!hasExistingQueue) {
        queueState.seriesTitle = itemsToAdd[0].seriesTitle;
        queueState.seasonLabel = itemsToAdd[0].season;
        queueState.current = null;
        queueState.entries = null;
        queueState.originalContext = [...itemsToAdd];
        queueState.context = [...itemsToAdd];
    } else {
        queueState.priority.push(...itemsToAdd);
    }

    saveQueue();
    return itemsToAdd.length;
}

// ==========================================
// 2. SPOTIFY-STYLE ACTIVE QUEUE CONTROLS
// ==========================================

export function getQueueState() {
    return {
        seriesTitle: queueState.seriesTitle,
        seasonLabel: queueState.seasonLabel,
        current: queueState.current,
        entries: getQueueEntries().map(entry => ({ ...entry })),
        priority: [...queueState.priority],
        context: [...queueState.context],
        history: [...queueState.history],
        isShuffled: queueState.isShuffled,
        repeatMode: queueState.repeatMode
    };
}

// Select within the active queue without rebuilding it from the picker's staged series.
export function selectQueueItem(uid) {
    const entries = getQueueEntries();
    const index = entries.findIndex(entry => entry.item.uid === uid);
    if (index === -1) return null;

    const selected = entries[index].item;
    if (queueState.current?.uid === uid) return selected;

    if (queueState.current) queueState.history.push(queueState.current);
    const remaining = entries.slice(index + 1);
    queueState.entries = entries;
    queueState.current = selected;
    queueState.seriesTitle = selected.seriesTitle;
    queueState.seasonLabel = selected.season;
    queueState.priority = remaining.filter(entry => entry.listType === 'priority').map(entry => entry.item);
    queueState.context = remaining.filter(entry => entry.listType === 'context').map(entry => entry.item);
    queueState.originalContext = remaining.filter(entry => entry.listType === 'context')
        .sort((a, b) => a.originalIndex - b.originalIndex).map(entry => entry.item);
    saveQueue(true);
    return selected;
}

export function addToQueue(itemData) {
    const item = createQueueItem(itemData);
    queueState.priority.push(item);
    console.log('➕ [Added to Priority Queue]:', item);
    saveQueue();
    return item;
}

export function addPlayNext(itemData) {
    const item = createQueueItem(itemData);
    queueState.priority.unshift(item);
    console.log('⏭️ [Added to Play Next]:', item);
    saveQueue();
    return item;
}

export function removeFromQueue(uid) {
    queueState.entries = getQueueEntries().filter(entry => entry.item.uid !== uid);
    queueState.priority = queueState.priority.filter(i => i.uid !== uid);
    queueState.context = queueState.context.filter(i => i.uid !== uid);
    queueState.originalContext = queueState.originalContext.filter(i => i.uid !== uid);
    saveQueue(true);
}

export function moveQueueItem(listType, fromIndex, toIndex) {
    const list = listType === 'priority' ? queueState.priority : queueState.context;
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= list.length || toIndex >= list.length) return;

    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    saveQueue();
}

export function clearQueue(clearPriorityOnly = false) {
    queueState.priority = [];
    if (!clearPriorityOnly) {
        queueState.seriesTitle = '';
        queueState.seasonLabel = '';
        queueState.current = null;
        queueState.context = [];
        queueState.originalContext = [];
        queueState.history = [];
        queueState.entries = [];
        queueState.isShuffled = false;
    }
    saveQueue();
}

export function toggleShuffle() {
    queueState.isShuffled = !queueState.isShuffled;

    if (queueState.isShuffled) {
        // Always generate a fresh random order from the remaining original episodes
        const remainingUids = new Set(queueState.context.map(i => i.uid));
        const unplayedOriginal = queueState.originalContext.filter(i => remainingUids.has(i.uid));
        queueState.context = shuffleArray(unplayedOriginal);
    } else {
        // Restore exact original order for all remaining unplayed episodes
        const remainingUids = new Set(queueState.context.map(i => i.uid));
        queueState.context = queueState.originalContext.filter(i => remainingUids.has(i.uid));
    }

    console.log(`🔀 [Shuffle ${queueState.isShuffled ? 'ON' : 'OFF'}]:`, queueState.context);
    saveQueue();
    return queueState.isShuffled;
}

export function setRepeatMode(mode) {
    if (['off', 'all', 'one'].includes(mode)) {
        queueState.repeatMode = mode;
        saveQueue();
    }
}

// ==========================================
// 3. CUSTOM SAVED PLAYLISTS (User Created)
// ==========================================

export function getPlaylists() {
    return [...playlists];
}

export function createPlaylist(name) {
    const newPlaylist = {
        id: crypto.randomUUID ? crypto.randomUUID() : `pl-${Date.now()}`,
        name: name.trim() || 'Untitled Playlist',
        createdAt: Date.now(),
        items: []
    };
    playlists.push(newPlaylist);
    savePlaylists();
    return newPlaylist;
}

export function deletePlaylist(playlistId) {
    playlists = playlists.filter(pl => pl.id !== playlistId);
    savePlaylists();
}

export function addItemToPlaylist(playlistId, itemData) {
    const pl = playlists.find(p => p.id === playlistId);
    if (!pl) return false;

    pl.items.push(createQueueItem(itemData));
    savePlaylists();
    return true;
}

export function removeItemFromPlaylist(playlistId, itemUid) {
    const pl = playlists.find(p => p.id === playlistId);
    if (!pl) return false;

    pl.items = pl.items.filter(item => item.uid !== itemUid);
    savePlaylists();
    return true;
}

// ==========================================
// 4. PLAYBACK & TORBOX LINK RESOLUTION
// ==========================================

async function resolveItemStream(item) {
    if (!item) return null;
    const url = await getTorboxLink(item.tid, item.fid);
    if (!url) return null;
    return { item, url };
}

export async function playNext() {
    if (queueState.repeatMode === 'one' && queueState.current) {
        return await resolveItemStream(queueState.current);
    }

    if (queueState.current) {
        queueState.history.push(queueState.current);
    }

    let nextItem = null;

    if (queueState.priority.length > 0) {
        nextItem = queueState.priority.shift();
    } else if (queueState.context.length > 0) {
        nextItem = queueState.context.shift();
    } else if (queueState.repeatMode === 'all' && queueState.history.length > 0) {
        const fullLoop = [...queueState.history];
        queueState.history = [];
        queueState.originalContext = fullLoop;
        const rebuilt = queueState.isShuffled ? shuffleArray(fullLoop) : fullLoop;
        nextItem = rebuilt.shift();
        queueState.context = rebuilt;
    }

    queueState.current = nextItem;
    saveQueue();

    if (!nextItem) return null;

    const result = await resolveItemStream(nextItem);
    if (!result && (queueState.priority.length > 0 || queueState.context.length > 0)) {
        return await playNext();
    }

    return result;
}

export async function playPrevious() {
    if (queueState.history.length === 0) return null;

    const prevItem = queueState.history.pop();
    if (queueState.current) {
        queueState.context.unshift(queueState.current);
    }

    queueState.current = prevItem;
    saveQueue();

    return await resolveItemStream(prevItem);
}

export function advanceToNextItem() {
    if (queueState.repeatMode === 'one' && queueState.current) {
        return queueState.current;
    }

    if (queueState.current) {
        queueState.history.push(queueState.current);
    }

    let nextItem = null;

    if (queueState.priority.length > 0) {
        nextItem = queueState.priority.shift();
    } else if (queueState.context.length > 0) {
        nextItem = queueState.context.shift();
    } else if (queueState.repeatMode === 'all' && queueState.history.length > 0) {
        const fullLoop = [...queueState.history];
        queueState.history = [];
        queueState.originalContext = fullLoop;
        const rebuilt = queueState.isShuffled ? shuffleArray(fullLoop) : fullLoop;
        nextItem = rebuilt.shift();
        queueState.context = rebuilt;
    }

    queueState.current = nextItem;
    saveQueue();
    return nextItem;
}

export function retreatToPreviousItem() {
    if (queueState.history.length === 0) return null;

    const prevItem = queueState.history.pop();
    if (queueState.current) {
        queueState.context.unshift(queueState.current);
    }

    queueState.current = prevItem;
    saveQueue();
    return prevItem;
}
