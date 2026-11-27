import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Execute the real module with browser storage and playback replaced at its boundaries.
const source = readFileSync(new URL('../streaming/playlist.js', import.meta.url), 'utf8')
    .replace(/^\uFEFF/, '').replace(/^import .*;\r?\n/m, '').replace(/^export /gm, '');
const plain = value => JSON.parse(JSON.stringify(value));
const episode = (name, extra = {}) => ({ sourceType: 'torrent', hash: `hash-${name}`, fid: 0, title: name, ...extra });
const titles = items => Array.from(items, item => item.title);
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function setup({ saved = null, resolveSource, play } = {}) {
    const storage = new Map(saved ? [['active_queue', JSON.stringify(saved)]] : []);
    const calls = { played: [], stopped: 0, errors: [], events: [] };
    const context = vm.createContext({
        getStorage: () => ({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }),
        crypto: { randomUUID }, console,
        window: { dispatchEvent: event => calls.events.push(event.detail) },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }
    });
    vm.runInContext(source, context);
    context.initializePlaylist({
        resolveSource: resolveSource || (async item => `https://example.test/${item.title}`),
        play: play || (async (url, item, callbacks) => {
            calls.played.push({ url, item, callbacks });
            callbacks.onStatus('playing');
        }),
        stop: () => calls.stopped++, onError: error => calls.errors.push(error)
    });
    return { queue: context, calls, storage, state: () => context.getQueueState() };
}

test('complete source metadata survives snapshots, storage and restoration without autoplay', async () => {
    const { queue, state, storage } = setup();
    const item = episode('A', { id: 'kitsu:123:9', savedId: 'kitsu:123', imdbId: 'tt123', tmdbId: 123,
        sourceHashes: ['one', 'two'], streamId: 'kitsu:123:9', seasonNumber: 2, episodeNumber: 9,
        watchEpisodeNumber: 3, progressInSeconds: 120, torboxType: 'usenet', fileType: 'TV' });
    queue.addToQueue(item);
    item.sourceHashes.push('changed');
    assert.deepEqual(plain(state().priority[0].sourceHashes), ['one', 'two']);
    const snapshot = state();
    snapshot.priority[0].sourceHashes.push('also changed');
    assert.equal(state().priority[0].sourceHashes.length, 2);
    const restored = setup({ saved: JSON.parse(storage.get('active_queue')) });
    assert.equal(restored.state().priority[0].id, 'kitsu:123:9');
    assert.equal(restored.state().priority[0].progressInSeconds, 120);
    assert.equal(restored.calls.played.length, 0);
    assert.equal(restored.state().playbackStatus, 'idle');
});

test('source-specific validation accepts URL and addon items without invented torrent IDs', () => {
    const { queue, state, calls } = setup();
    queue.addToQueue([{ sourceType: 'url', sourceUrl: 'https://example.test/video', title: 'URL' },
        { sourceType: 'addon', hash: 'abc', id: 'tt123', mediaType: 'tv', title: 'Addon' }]);
    assert.equal(state().entries.length, 2);
    assert.equal(state().current, null);
    assert.equal(calls.played.length, 0);
    assert.throws(() => queue.addToQueue({ title: 'No source' }), /playback source/);
});

test('manual singles and rows use FIFO priority and promote exact upcoming files', async () => {
    const { queue, state } = setup();
    const [a1, a2, a3] = ['A1', 'A2', 'A3'].map(name => episode(name));
    await queue.startQueue([a1, a2, a3]);
    queue.addToQueue(episode('X'));
    queue.addToQueue([episode('B1'), episode('B2')]);
    assert.equal(queue.addToQueue(a2), 1);
    assert.equal(queue.addToQueue(a2), 0);
    assert.deepEqual(titles(state().priority), ['X', 'B1', 'B2', 'A2']);
    assert.deepEqual(titles(state().context), ['A3']);
    assert.equal(state().current.title, 'A1');
    queue.addToQueue(episode('A2 alternate', { episodeNumber: 2 }));
    assert.equal(state().priority.length, 5);
});

test('starting another collection preserves manual additions and removes overlapping automatic copies', async () => {
    const { queue, state } = setup();
    await queue.startQueue([episode('A1'), episode('A2')]);
    queue.addToQueue([episode('X'), episode('C2')]);
    await queue.startQueue([episode('C1'), episode('C2'), episode('C3')]);
    assert.deepEqual(titles(state().entries.map(entry => entry.item)), ['C1', 'X', 'C2', 'C3']);
    assert.equal(state().current.title, 'C1');
    assert.deepEqual(titles(state().priority), ['X', 'C2']);
});

test('queue shuffle includes manual entries, keeps the current item, and restores the previous order', async () => {
    const { queue, state } = setup();
    await queue.startQueue(['A1', 'A2', 'A3', 'A4'].map(name => episode(name)));
    queue.addToQueue([episode('X'), episode('Y')]);
    vm.runInContext('Math.random = () => 0;', queue);
    queue.toggleShuffle();
    assert.equal(state().current.title, 'A1');
    const upcoming = () => titles(state().entries.slice(state().nextIndex).map(entry => entry.item));
    assert.notDeepEqual(upcoming(), ['X', 'Y', 'A2', 'A3', 'A4']);
    queue.toggleShuffle();
    assert.deepEqual(upcoming(), ['X', 'Y', 'A2', 'A3', 'A4']);
});

test('shuffle works on an idle queue built entirely with Queue row or single Queue actions', () => {
    const { queue, state, calls } = setup();
    queue.addToQueue(['A1', 'A2', 'A3', 'A4'].map(name => episode(name)));
    vm.runInContext('Math.random = () => 0;', queue);
    queue.toggleShuffle();
    assert.deepEqual(titles(state().entries.map(entry => entry.item)), ['A2', 'A3', 'A4', 'A1']);
    assert.equal(state().current, null);
    assert.equal(calls.played.length, 0);
    queue.toggleShuffle();
    assert.deepEqual(titles(state().entries.map(entry => entry.item)), ['A1', 'A2', 'A3', 'A4']);
});

test('advancing a shuffled mixed queue keeps its shuffled remainder intact', async () => {
    const { queue, state } = setup();
    await queue.startQueue(['A1', 'A2', 'A3'].map(name => episode(name)));
    queue.addToQueue(episode('X'));
    vm.runInContext('Math.random = () => 0;', queue);
    queue.toggleShuffle();
    assert.deepEqual(titles(state().entries.slice(state().nextIndex).map(entry => entry.item)), ['A2', 'A3', 'X']);
    await queue.next();
    assert.equal(state().current.title, 'A2');
    assert.deepEqual(titles(state().entries.slice(state().nextIndex).map(entry => entry.item)), ['A3', 'X']);
    queue.toggleShuffle();
    assert.deepEqual(titles(state().entries.slice(state().nextIndex).map(entry => entry.item)), ['X', 'A3']);
});

test('new additions during shuffle stay FIFO ahead of the shuffled remainder and survive restoration', async () => {
    const { queue, state, storage } = setup();
    await queue.startQueue(['A1', 'A2', 'A3', 'A4'].map(name => episode(name)));
    queue.addToQueue(episode('X'));
    vm.runInContext('Math.random = () => 0;', queue);
    queue.toggleShuffle();
    const shuffled = titles(state().entries.slice(state().nextIndex).map(entry => entry.item));
    queue.addToQueue([episode('B1'), episode('B2')]);
    assert.deepEqual(titles(state().entries.slice(state().nextIndex).map(entry => entry.item)), ['B1', 'B2', ...shuffled]);
    const restored = setup({ saved: JSON.parse(storage.get('active_queue')) });
    restored.queue.toggleShuffle();
    assert.deepEqual(titles(restored.state().entries.slice(restored.state().nextIndex).map(entry => entry.item)), ['B1', 'B2', 'X', 'A2', 'A3', 'A4']);
});

test('disabling picker-started shuffle restores the natural order of the remaining collection', async () => {
    const { queue, state } = setup();
    vm.runInContext('Math.random = () => 0;', queue);
    await queue.startQueue(['A1', 'A2', 'A3', 'A4'].map(name => episode(name)), { shuffled: true });
    assert.equal(state().current.title, 'A2');
    queue.toggleShuffle();
    assert.deepEqual(titles(state().context), ['A1', 'A3', 'A4']);
});

test('enabling queue shuffle visibly changes a multi-item remainder even if the random permutation repeats it', () => {
    const { queue, state } = setup();
    queue.addToQueue([episode('A'), episode('B')]);
    vm.runInContext('Math.random = () => 0.999999;', queue);
    queue.toggleShuffle();
    assert.deepEqual(titles(state().priority), ['B', 'A']);
});

test('selected row playback starts at exact file identity and explicit Theme rows remain queueable', async () => {
    const { queue, state } = setup();
    const items = ['A1', 'A2', 'A3'].map(name => episode(name));
    await queue.startQueue(items, { startItem: { ...items[1] } });
    assert.deepEqual(titles(state().entries.map(entry => entry.item)), ['A2', 'A3']);
    await queue.startQueue([episode('Song', { fileType: 'Theme' }), episode('TV')]);
    assert.equal(state().current.title, 'TV');
    await queue.startQueue([episode('Song', { fileType: 'Theme' })], { includeThemes: true });
    assert.equal(state().current.title, 'Song');
    queue.addToQueue(episode('Other song', { fileType: 'Theme' }));
    assert.equal(state().priority[0].title, 'Other song');
});

test('play-now retains the remainder and selecting an existing entry creates no new occurrence', async () => {
    const { queue, state } = setup();
    await queue.startQueue([episode('A1'), episode('A2')]);
    await queue.playNow(episode('X'), { resumePosition: 42 });
    assert.equal(state().current.title, 'X');
    assert.deepEqual(titles(state().context), ['A2']);
    const count = state().entries.length;
    await queue.playQueueItem(state().history[0].uid);
    assert.equal(state().entries.length, count);
    assert.equal(state().current.title, 'A1');
});

test('next/previous and end-of-queue preserve history; adding after exhaustion stays idle', async () => {
    const { queue, state, calls } = setup();
    await queue.startQueue([episode('A1'), episode('A2')]);
    await queue.next();
    assert.equal(state().current.title, 'A2');
    await queue.previous();
    assert.equal(state().current.title, 'A1');
    await queue.next();
    await queue.next();
    assert.equal(state().current, null);
    assert.deepEqual(titles(state().history), ['A1', 'A2']);
    const played = calls.played.length;
    queue.addToQueue(episode('X'));
    assert.equal(calls.played.length, played);
    await queue.next();
    assert.equal(state().current.title, 'X');
});

test('clear keeps active playback; removing active entry plays the following entry', async () => {
    const { queue, state, calls } = setup();
    await queue.startQueue([episode('A1'), episode('A2'), episode('A3')]);
    await queue.removeFromQueue(state().current.uid);
    assert.equal(state().current.title, 'A2');
    const stopped = calls.stopped;
    queue.clearQueue();
    assert.equal(state().entries.length, 1);
    assert.equal(state().current.title, 'A2');
    assert.equal(calls.stopped, stopped);
    queue.stopQueuePlayback();
    queue.clearQueue();
    assert.equal(state().entries.length, 0);
});

test('a failed entry remains selected and retryable without losing upcoming items', async () => {
    let fail = true;
    const { queue, state, calls } = setup({ resolveSource: async () => { if (fail) throw new Error('Expired'); return 'fresh'; } });
    await queue.startQueue([episode('A1'), episode('A2')]);
    assert.equal(state().playbackStatus, 'failed');
    assert.equal(state().error, 'Expired');
    assert.equal(state().current.title, 'A1');
    assert.deepEqual(titles(state().context), ['A2']);
    assert.equal(calls.errors.length, 1);
    fail = false;
    await queue.playQueueItem(state().current.uid);
    assert.equal(state().playbackStatus, 'playing');
    assert.equal(state().entries.length, 2);
});

test('slow resolution cannot play an older selection or restart after stop', async () => {
    const slow = deferred();
    const { queue, state, calls } = setup({ resolveSource: item => item.title === 'A1' ? slow.promise : Promise.resolve('B') });
    const first = queue.startQueue([episode('A1'), episode('A2')]);
    await queue.next();
    slow.resolve('old URL');
    await first;
    assert.deepEqual(calls.played.map(call => call.item.title), ['A2']);
    assert.equal(state().current.title, 'A2');
    const pending = deferred();
    const stopped = setup({ resolveSource: () => pending.promise });
    const request = stopped.queue.startQueue([episode('X')]);
    stopped.queue.stopQueuePlayback();
    pending.resolve('late');
    await request;
    assert.equal(stopped.calls.played.length, 0);
    assert.equal(stopped.state().playbackStatus, 'idle');
});

test('duplicate and stale ended/status events cannot advance or overwrite newer playback', async () => {
    const { queue, state, calls } = setup();
    await queue.startQueue([episode('A1'), episode('A2'), episode('A3')]);
    const oldCallbacks = calls.played[0].callbacks;
    const firstEnd = oldCallbacks.onEnded();
    const duplicateEnd = oldCallbacks.onEnded();
    await Promise.all([firstEnd, duplicateEnd]);
    assert.equal(state().current.title, 'A2');
    oldCallbacks.onStatus('failed', 'Old failure');
    assert.equal(state().playbackStatus, 'playing');
    assert.equal(calls.errors.length, 0);
    const callbacks = calls.played.at(-1).callbacks;
    await queue.playQueueItem(state().current.uid);
    await callbacks.onEnded();
    assert.equal(state().current.title, 'A2');
});

test('restores both existing flat queues and legacy split queues as idle', () => {
    const a = episode('A', { uid: 'a' }), b = episode('B', { uid: 'b' });
    const flat = setup({ saved: { entries: [{ item: a }, { item: b }], currentUid: 'a', nextIndex: 1, playbackStatus: 'playing' } });
    assert.equal(flat.state().current.uid, 'a');
    assert.equal(flat.state().playbackStatus, 'idle');
    assert.equal(flat.calls.played.length, 0);
    const legacy = setup({ saved: { current: a, context: [b], priority: [], originalContext: [a, b] } });
    assert.equal(legacy.state().current.uid, 'a');
    assert.equal(legacy.state().context[0].uid, 'b');
});
