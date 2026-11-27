import { getStorage } from '../user-data/user-settings.js';

const STORAGE_KEY_QUEUE = 'active_queue';
const copy = value => JSON.parse(JSON.stringify(value));
const hasId = value => ['string', 'number'].includes(typeof value) && String(value).trim() !== '';
const hasUrl = item => typeof item.sourceUrl === 'string' && item.sourceUrl.trim() !== '';

function emptyQueue() {
    return { version: 3, entries: [], currentUid: null, nextIndex: 0, isShuffled: false, playbackStatus: 'idle', error: null };
}

function createQueueItem(data, uid = crypto.randomUUID()) {
    if (!data || typeof data !== 'object') throw new Error('An episode is required.');
    const sourceType = data.sourceType || (hasUrl(data) ? 'url' : 'torrent');
    const valid = sourceType === 'url' ? hasUrl(data)
        : sourceType === 'addon' ? Boolean(hasUrl(data) || data.hash || data.sourceHashes?.length)
            && Boolean(data.id || data.savedId || data.imdbId || data.sourceMediaId || data.streamId || data.tmdbId)
            : hasId(data.fid) && (Boolean(data.hash) || hasId(data.tid));
    if (!valid) throw new Error('This episode is missing its playback source.');
    const item = copy(data);
    delete item.completionCounted;
    return {
        ...item, uid, sourceType,
        title: item.title || item.fileName || 'Untitled',
        thumbnail: item.thumbnail || item.poster || ''
    };
}

function itemKey(item) {
    if (item.sourceType === 'url') return `url:${item.sourceUrl}`;
    if (item.hash && hasId(item.fid)) return `hash:${item.hash.toLowerCase()}:${item.fid}`;
    if (item.sourceType === 'addon') {
        return JSON.stringify(['addon', item.hash || item.sourceHashes, item.streamId || item.id || item.savedId
            || item.imdbId || item.sourceMediaId || item.tmdbId, item.seasonNumber, item.episodeNumber]);
    }
    return `${item.torboxType || 'torrent'}:${item.tid}:${item.fid}`;
}

function loadQueue() {
    try {
        const saved = JSON.parse(getStorage().getItem(STORAGE_KEY_QUEUE));
        if (!saved || typeof saved !== 'object') return emptyQueue();
        const legacy = !Number.isInteger(saved.nextIndex);
        let entries = Array.isArray(saved.entries) ? saved.entries : [];
        if (legacy) {
            const currentIndex = entries.findIndex(entry => entry?.item?.uid === saved.current?.uid);
            entries = [
                ...(currentIndex >= 0 ? entries.slice(0, currentIndex) : []),
                ...(saved.current ? [{ item: saved.current, listType: 'context' }] : []),
                ...(Array.isArray(saved.priority) ? saved.priority : []).map(item => ({ item, listType: 'priority' })),
                ...(Array.isArray(saved.context) ? saved.context : []).map(item => ({ item, listType: 'context' }))
            ];
        }
        const seen = new Set();
        const restored = [];
        let restoredCursor = 0;
        entries.forEach((entry, index) => {
            try {
                if (typeof entry?.item?.uid !== 'string' || seen.has(entry.item.uid)) return;
                const item = createQueueItem(entry.item, entry.item.uid);
                seen.add(item.uid);
                restored.push({ item, listType: entry.listType === 'priority' ? 'priority' : 'context',
                    originalIndex: Number.isFinite(entry.originalIndex) ? entry.originalIndex : index,
                    ...(Number.isSafeInteger(entry.shuffleIndex) ? { shuffleIndex: entry.shuffleIndex } : {}) });
                if (index < saved.nextIndex) restoredCursor++;
            } catch { /* Ignore obsolete entries that cannot identify a source. */ }
        });
        const currentUid = legacy ? saved.current?.uid : saved.currentUid;
        const currentIndex = restored.findIndex(entry => entry.item.uid === currentUid);
        if (saved.isShuffled && saved.version !== 3) {
            const natural = [...restored.filter(entry => entry.listType === 'priority'),
                ...restored.filter(entry => entry.listType === 'context').sort((a, b) => a.originalIndex - b.originalIndex)];
            natural.forEach((entry, index) => { entry.shuffleIndex ??= index; });
        }
        return { ...emptyQueue(), entries: restored, currentUid: currentIndex >= 0 ? currentUid : null,
            nextIndex: currentIndex >= 0 ? currentIndex + 1 : restoredCursor,
            isShuffled: saved.isShuffled === true };
    } catch (error) {
        console.warn('Could not restore the playback queue:', error);
        return emptyQueue();
    }
}

let queueState = loadQueue();
let playbackRequest = 0;
let playbackAdapter = null;

// Wired once by main.js; queue policy stays here without importing the player.
export function initializePlaylist(adapter) {
    playbackAdapter = adapter;
}

function saveQueue() {
    try { getStorage().setItem(STORAGE_KEY_QUEUE, JSON.stringify(queueState)); }
    catch (error) { console.warn('Could not save the playback queue:', error); }
    window.dispatchEvent(new CustomEvent('queue:updated', { detail: getQueueState() }));
}

export function getQueueState() {
    const currentIndex = queueState.currentUid ? queueState.nextIndex - 1 : -1;
    const upcoming = queueState.entries.slice(queueState.nextIndex);
    return copy({
        ...queueState,
        current: queueState.entries[currentIndex]?.item || null,
        history: queueState.entries.slice(0, currentIndex >= 0 ? currentIndex : queueState.nextIndex).map(entry => entry.item),
        priority: upcoming.filter(entry => entry.listType === 'priority').map(entry => entry.item),
        context: upcoming.filter(entry => entry.listType === 'context').map(entry => entry.item),
        hasNext: upcoming.length > 0,
        hasPrevious: queueState.nextIndex - (queueState.currentUid ? 2 : 1) >= 0
    });
}

function prepareItems(input, includeThemes = true) {
    const seen = new Set();
    return (Array.isArray(input) ? input : [input])
        .filter(item => includeThemes || item?.fileType !== 'Theme')
        .map(item => createQueueItem(item)).filter(item => {
            const key = itemKey(item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function shuffleArray(array) {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

export async function startQueue(input, { startItem = null, shuffled = false, includeThemes = false } = {}) {
    let items = prepareItems(input, includeThemes);
    if (startItem) {
        const index = items.findIndex(item => itemKey(item) === itemKey(startItem));
        if (index < 0) throw new Error('The selected episode is not in this collection.');
        items = items.slice(index);
    }
    if (!items.length) return null;
    const context = items.map((item, originalIndex) => ({ item, listType: 'context', originalIndex }));
    const ordered = shuffled ? (startItem ? [context[0], ...shuffleArray(context.slice(1))] : shuffleArray(context)) : context;
    const first = ordered[0];
    const pendingPriority = queueState.entries.slice(queueState.nextIndex)
        .filter(entry => entry.listType === 'priority' && itemKey(entry.item) !== itemKey(first.item));
    const manualKeys = new Set(pendingPriority.map(entry => itemKey(entry.item)));
    queueState = { ...emptyQueue(), isShuffled: shuffled,
        entries: [first, ...pendingPriority, ...ordered.slice(1).filter(entry => !manualKeys.has(itemKey(entry.item)))] };
    if (shuffled) {
        const natural = [first, ...pendingPriority,
            ...context.filter(entry => entry !== first && !manualKeys.has(itemKey(entry.item)))];
        natural.forEach((entry, index) => { entry.shuffleIndex = index; });
    } else {
        queueState.entries.forEach(entry => { delete entry.shuffleIndex; });
    }
    return playQueueItem(first.item.uid);
}

// Manual additions keep FIFO order ahead of the automatic remainder, without starting playback.
export function addToQueue(input, { includeThemes = true } = {}) {
    const items = prepareItems(input, includeThemes);
    const manual = queueState.entries.slice(queueState.nextIndex)
        .filter(entry => entry.listType === 'priority' && (!queueState.isShuffled || entry.shuffleIndex == null));
    let count = 0;
    for (const item of items) {
        const key = itemKey(item);
        if (manual.some(entry => itemKey(entry.item) === key)) continue;
        const index = queueState.entries.findIndex((entry, index) => index >= queueState.nextIndex && itemKey(entry.item) === key);
        const entry = index >= 0 ? queueState.entries.splice(index, 1)[0]
            : { item, listType: 'priority', originalIndex: -1 };
        entry.listType = 'priority';
        delete entry.shuffleIndex;
        manual.push(entry);
        count++;
    }
    const remainder = queueState.entries.slice(queueState.nextIndex).filter(entry => !manual.includes(entry));
    queueState.entries.splice(queueState.nextIndex, Infinity, ...manual, ...remainder);
    saveQueue();
    return count;
}

export async function playNow(data, { resumePosition } = {}) {
    const item = createQueueItem(data);
    const key = itemKey(item);
    const existing = queueState.entries.findIndex((entry, index) => index >= queueState.nextIndex && itemKey(entry.item) === key);
    if (existing >= 0) queueState.entries.splice(existing, 1);
    queueState.entries.splice(queueState.nextIndex, 0, { item, listType: 'priority', originalIndex: -1 });
    return playQueueItem(item.uid, { resumePosition });
}

function isCurrentRequest(uid, request) {
    return queueState.currentUid === uid && playbackRequest === request;
}

export async function playQueueItem(uid, { resumePosition } = {}) {
    if (!playbackAdapter) throw new Error('Queue playback has not been initialized.');
    const index = queueState.entries.findIndex(entry => entry.item.uid === uid);
    if (index < 0) return null;
    const request = ++playbackRequest;
    queueState.currentUid = uid;
    queueState.nextIndex = index + 1;
    queueState.playbackStatus = 'loading';
    queueState.error = null;
    if (!queueState.isShuffled) {
        const upcoming = queueState.entries.splice(queueState.nextIndex);
        queueState.entries.push(...upcoming.filter(entry => entry.listType === 'priority'),
            ...upcoming.filter(entry => entry.listType === 'context'));
    }
    playbackAdapter.stop();
    saveQueue();
    const entry = queueState.entries[index];
    const item = copy(entry.item);
    if (Number.isFinite(resumePosition)) item.progressInSeconds = Math.max(0, resumePosition);
    const isCurrent = () => isCurrentRequest(uid, request);
    const onStatus = (status, error = null) => {
        if (!isCurrent()) return;
        queueState.playbackStatus = status;
        queueState.error = error;
        if (status === 'playing') entry.item.progressInSeconds = 0;
        if (status === 'failed') {
            playbackRequest++;
            playbackAdapter.onError?.(error || 'Could not play this episode.');
        }
        saveQueue();
    };
    try {
        const url = await playbackAdapter.resolveSource(item);
        if (!isCurrent()) return null;
        if (typeof url !== 'string' || !url.trim()) throw new Error('No playable source is available for this episode.');
        await playbackAdapter.play(url, item, {
            isCurrent, onStatus,
            onEnded: () => next({ uid, request }),
            onNext: () => next({ uid, request }),
            onPrevious: () => previous({ uid, request })
        });
        return isCurrent() ? copy(item) : null;
    } catch (error) {
        if (isCurrent()) {
            playbackAdapter.stop();
            onStatus('failed', error.message || 'Could not play this episode.');
        }
        return null;
    }
}

export function stopQueuePlayback({ stopPlayer = true } = {}) {
    playbackRequest++;
    queueState.playbackStatus = 'idle';
    queueState.error = null;
    if (stopPlayer) playbackAdapter?.stop();
    saveQueue();
}

export async function next({ uid, request } = {}) {
    if (uid && !isCurrentRequest(uid, request)) return null;
    const entry = queueState.entries[queueState.nextIndex];
    if (entry) return playQueueItem(entry.item.uid);
    stopQueuePlayback();
    queueState.currentUid = null;
    saveQueue();
    return null;
}

export async function previous({ uid, request } = {}) {
    if (uid && !isCurrentRequest(uid, request)) return null;
    const index = queueState.nextIndex - (queueState.currentUid ? 2 : 1);
    const entry = queueState.entries[index];
    return entry ? playQueueItem(entry.item.uid) : null;
}

export function toggleShuffle() {
    queueState.isShuffled = !queueState.isShuffled;
    const upcoming = queueState.entries.slice(queueState.nextIndex);
    let ordered;
    if (queueState.isShuffled) {
        queueState.entries.forEach((entry, index) => { entry.shuffleIndex = index; });
        ordered = shuffleArray(upcoming);
        if (ordered.length > 1 && ordered.every((entry, index) => entry === upcoming[index])) {
            ordered.push(ordered.shift());
        }
    } else {
        const newlyQueued = upcoming.filter(entry => entry.shuffleIndex == null);
        const original = upcoming.filter(entry => entry.shuffleIndex != null).sort((a, b) => a.shuffleIndex - b.shuffleIndex);
        ordered = [...newlyQueued, ...original];
        queueState.entries.forEach(entry => { delete entry.shuffleIndex; });
    }
    queueState.entries.splice(queueState.nextIndex, Infinity, ...ordered);
    saveQueue();
    return queueState.isShuffled;
}

export async function removeFromQueue(uid) {
    const index = queueState.entries.findIndex(entry => entry.item.uid === uid);
    if (index < 0) return;
    const wasCurrent = queueState.currentUid === uid;
    queueState.entries.splice(index, 1);
    if (index < queueState.nextIndex) queueState.nextIndex--;
    if (wasCurrent) {
        queueState.currentUid = null;
        stopQueuePlayback();
        const nextEntry = queueState.entries[queueState.nextIndex];
        if (nextEntry) return playQueueItem(nextEntry.item.uid);
    }
    saveQueue();
}

export function clearQueue() {
    const current = ['loading', 'playing'].includes(queueState.playbackStatus)
        ? queueState.entries.find(entry => entry.item.uid === queueState.currentUid) : null;
    if (current) {
        queueState.entries = [current];
        queueState.nextIndex = 1;
        queueState.isShuffled = false;
    } else {
        stopQueuePlayback();
        queueState = emptyQueue();
    }
    saveQueue();
}
