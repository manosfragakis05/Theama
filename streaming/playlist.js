import { getStorage } from "../user-data/user-settings";

const STORAGE_KEY_QUEUE = 'active_queue';

function emptyQueue() {
    return { entries: [], currentUid: null, nextIndex: 0, isShuffled: false, playbackStatus: 'idle' };
}

function validItem(item) {
    return item && typeof item.uid === 'string' && item.uid.length > 0 &&
        ['string', 'number'].includes(typeof item.tid) &&
        ['string', 'number'].includes(typeof item.fid);
}

function loadQueue() {
    try {
        const saved = JSON.parse(getStorage().getItem(STORAGE_KEY_QUEUE));
        if (!saved || typeof saved !== 'object') return emptyQueue();

        // Import the old split queue, including its visible previous entries.
        const legacy = !Number.isInteger(saved.nextIndex);
        const original = new Map((Array.isArray(saved.originalContext) ? saved.originalContext : [])
            .filter(validItem).map((item, index) => [item.uid, index]));
        let entries = Array.isArray(saved.entries) ? saved.entries : [];
        if (legacy) {
            const currentIndex = entries.findIndex(entry => entry?.item?.uid === saved.current?.uid);
            const previous = currentIndex >= 0 ? entries.slice(0, currentIndex) : [];
            entries = [
                ...previous,
                ...(validItem(saved.current) ? [currentIndex >= 0 ? entries[currentIndex]
                    : { item: saved.current, listType: 'context' }] : []),
                ...(Array.isArray(saved.priority) ? saved.priority : []).map(item => ({ item, listType: 'priority' })),
                ...(Array.isArray(saved.context) ? saved.context : []).map(item => ({ item, listType: 'context' }))
            ];
        }

        const seen = new Set();
        entries = entries.filter(entry => {
            if (!validItem(entry?.item) || seen.has(entry.item.uid)) return false;
            seen.add(entry.item.uid);
            return true;
        }).map((entry, index) => ({
            item: createQueueItem(entry.item, entry.item.uid),
            listType: entry.listType === 'priority' ? 'priority' : 'context',
            originalIndex: Number.isFinite(entry.originalIndex) && entry.originalIndex >= 0
                ? entry.originalIndex : (original.get(entry.item.uid) ?? index)
        }));
        const currentUid = legacy ? saved.current?.uid : saved.currentUid;
        const currentIndex = entries.findIndex(entry => entry.item.uid === currentUid);
        return {
            entries,
            currentUid: currentIndex >= 0 ? currentUid : null,
            nextIndex: currentIndex >= 0 ? currentIndex + 1
                : legacy ? 0 : Math.max(0, Math.min(saved.nextIndex, entries.length)),
            isShuffled: saved.isShuffled === true,
            playbackStatus: 'idle'
        };
    } catch (error) {
        console.warn('Could not restore the playback queue:', error);
        return emptyQueue();
    }
}

let queueState = loadQueue();
let stagedSeriesItems = [];

function saveQueue() {
    try {
        getStorage().setItem(STORAGE_KEY_QUEUE, JSON.stringify(queueState));
    } catch (error) {
        console.warn('Could not save the playback queue:', error);
    }
    window.dispatchEvent(new CustomEvent('queue:updated', { detail: getQueueState() }));
}

function createQueueItem(data, uid = crypto.randomUUID()) {
    if (!data || !['string', 'number'].includes(typeof data.tid) ||
        !['string', 'number'].includes(typeof data.fid)) {
        throw new Error('Both tid (Torrent ID) and fid (File ID) are required.');
    }
    const text = value => typeof value === 'string' ? value : '';
    return {
        uid,
        tid: data.tid,
        fid: data.fid,
        seriesTitle: text(data.seriesTitle),
        season: text(data.season),
        episodeNumber: Number.isFinite(Number(data.episodeNumber)) && data.episodeNumber != null
            ? Number(data.episodeNumber) : null,
        badge: text(data.badge),
        title: text(data.title) || text(data.fileName) || `Torrent ${data.tid} - File ${data.fid}`,
        fileName: text(data.fileName) || text(data.title),
        torrentName: text(data.torrentName),
        thumbnail: text(data.thumbnail) || text(data.poster)
    };
}

function shuffleArray(array) {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

export function buildSeriesQueue(episodeItems) {
    stagedSeriesItems = episodeItems.map(item => createQueueItem(item));
}

function startStagedQueue(index, shuffled) {
    if (stagedSeriesItems.length === 0) return null;
    const context = stagedSeriesItems.map((item, originalIndex) => ({
        item, listType: 'context', originalIndex
    }));
    const pendingPriority = queueState.entries.slice(queueState.nextIndex)
        .filter(entry => entry.listType === 'priority');
    const ordered = shuffled ? shuffleArray(context) : context.slice(index);
    queueState = {
        entries: [ordered[0], ...pendingPriority, ...ordered.slice(1)],
        currentUid: ordered[0].item.uid,
        nextIndex: 1,
        isShuffled: shuffled,
        playbackStatus: 'idle'
    };
    saveQueue();
    return { ...ordered[0].item };
}

export function startQueueFromEpisode(clickedIndex = 0) {
    const index = Number.isInteger(clickedIndex) && clickedIndex >= 0 && clickedIndex < stagedSeriesItems.length
        ? clickedIndex : 0;
    return startStagedQueue(index, false);
}

export function startShuffledQueue() {
    return startStagedQueue(0, true);
}

export function queueStagedSeries() {
    if (stagedSeriesItems.length === 0) return 0;
    const items = stagedSeriesItems.map(item => createQueueItem(item));
    if (queueState.entries.slice(queueState.nextIndex).length === 0 && !queueState.currentUid) {
        queueState = emptyQueue();
        queueState.entries = items.map((item, originalIndex) => ({ item, listType: 'context', originalIndex }));
    } else {
        insertPriority(items);
    }
    saveQueue();
    return items.length;
}

function insertPriority(items) {
    const pending = queueState.entries.slice(queueState.nextIndex);
    const afterPriority = pending.reduce((index, entry, i) => entry.listType === 'priority' ? i + 1 : index, 0);
    queueState.entries.splice(queueState.nextIndex + afterPriority, 0,
        ...items.map(item => ({ item, listType: 'priority', originalIndex: -1 })));
}

export function getQueueState() {
    const currentIndex = queueState.currentUid ? queueState.nextIndex - 1 : -1;
    const upcoming = queueState.entries.slice(queueState.nextIndex);
    return {
        current: currentIndex >= 0 ? { ...queueState.entries[currentIndex].item } : null,
        entries: queueState.entries.map(entry => ({ ...entry, item: { ...entry.item } })),
        priority: upcoming.filter(entry => entry.listType === 'priority').map(entry => ({ ...entry.item })),
        context: upcoming.filter(entry => entry.listType === 'context').map(entry => ({ ...entry.item })),
        history: queueState.entries.slice(0, currentIndex >= 0 ? currentIndex : queueState.nextIndex)
            .map(entry => ({ ...entry.item })),
        isShuffled: queueState.isShuffled,
        playbackStatus: queueState.playbackStatus
    };
}

export function selectQueueItem(uid) {
    const index = queueState.entries.findIndex(entry => entry.item.uid === uid);
    if (index === -1) return null;
    queueState.currentUid = uid;
    queueState.nextIndex = index + 1;
    queueState.playbackStatus = 'idle';
    // Going back makes earlier context upcoming again; explicit queue additions still play first.
    const upcoming = queueState.entries.splice(queueState.nextIndex);
    queueState.entries.push(...upcoming.filter(entry => entry.listType === 'priority'),
        ...upcoming.filter(entry => entry.listType === 'context'));
    saveQueue();
    return { ...queueState.entries[index].item };
}

export function setQueuePlaybackStatus(uid, status) {
    if (queueState.currentUid !== uid || queueState.playbackStatus === status) return;
    queueState.playbackStatus = status;
    saveQueue();
}

export function addToQueue(itemData) {
    const item = createQueueItem(itemData);
    insertPriority([item]);
    saveQueue();
    return { ...item };
}

export function removeFromQueue(uid) {
    const index = queueState.entries.findIndex(entry => entry.item.uid === uid);
    if (index === -1) return;
    queueState.entries.splice(index, 1);
    if (index < queueState.nextIndex) queueState.nextIndex--;
    if (queueState.currentUid === uid) {
        queueState.currentUid = null;
        queueState.playbackStatus = 'idle';
    }
    saveQueue();
}

export function clearQueue() {
    queueState = emptyQueue();
    saveQueue();
}

export function toggleShuffle() {
    queueState.isShuffled = !queueState.isShuffled;
    const upcoming = queueState.entries.slice(queueState.nextIndex);
    const priority = upcoming.filter(entry => entry.listType === 'priority');
    const context = upcoming.filter(entry => entry.listType === 'context');
    const ordered = queueState.isShuffled ? shuffleArray(context)
        : context.sort((a, b) => a.originalIndex - b.originalIndex);
    queueState.entries.splice(queueState.nextIndex, upcoming.length, ...priority, ...ordered);
    saveQueue();
    return queueState.isShuffled;
}

export function advanceToNextItem() {
    const next = queueState.entries[queueState.nextIndex];
    if (next) return selectQueueItem(next.item.uid);
    queueState.currentUid = null;
    queueState.playbackStatus = 'idle';
    saveQueue();
    return null;
}

export function retreatToPreviousItem() {
    const previousIndex = queueState.nextIndex - (queueState.currentUid ? 2 : 1);
    const previous = queueState.entries[previousIndex];
    return previous ? selectQueueItem(previous.item.uid) : null;
}
