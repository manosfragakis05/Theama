import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const readModule = path => readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/^\uFEFF/, '').replace(/^import\s[\s\S]*?;\r?$/gm, '').replace(/^export /gm, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
const hash = 'a'.repeat(40);

function resolverSetup(key = 'test-key') {
    const calls = { torrents: [], addons: [] };
    const context = vm.createContext({ URLSearchParams, console,
        getCurrentUserSettings: () => ({ user_preferences: { torboxApiKey: key } }),
        getAddonStreams: async (...args) => { calls.addons.push(args.slice(0, 4)); args[4]([{ infoHash: hash, url: 'https://fresh.test/video' }]); }
    });
    vm.runInContext(readModule('../utils/streams.js'), context);
    context.getTorboxTorrentFromHash = async (...args) => {
        calls.torrents.push(args);
        return { id: 17, download_finished: true, files: [{ id: 99, name: 'Wrong.First.Episode.mkv' }] };
    };
    return { context, calls };
}

test('direct URL sources retain their selected URL even when a hash is present', async () => {
    const { context, calls } = resolverSetup();
    assert.equal(await context.getPlayableSource({ sourceType: 'url', sourceUrl: 'https://selected.test/video', hash }), 'https://selected.test/video');
    assert.equal(calls.torrents.length, 0);
});

test('TorBox playback resolves the account torrent while preserving exact file ID zero', async () => {
    const { context, calls } = resolverSetup();
    const url = new URL(await context.getPlayableSource({ sourceType: 'torrent', hash, fid: 0 }));
    assert.equal(url.searchParams.get('torrent_id'), '17');
    assert.equal(url.searchParams.get('file_id'), '0');
    assert.equal(calls.torrents[0][1], false);
    const usenet = new URL(await context.getPlayableSource({ sourceType: 'torrent', torboxType: 'usenet', tid: 9, fid: 3 }));
    assert.equal(usenet.pathname, '/v1/api/usenet/requestdl');
    assert.equal(usenet.searchParams.get('usenet_id'), '9');
});

test('addon episodes without file IDs use their provider ID and episode instead of the first pack file', async () => {
    const { context, calls } = resolverSetup();
    const result = await context.getPlayableSource({ sourceType: 'addon', id: 'kitsu:123:9', savedId: 'kitsu:123',
        mediaType: 'tv', hash, seasonNumber: 1, episodeNumber: 9 });
    assert.equal(result, 'https://fresh.test/video');
    assert.equal(calls.torrents.length, 0);
    assert.deepEqual(Array.from(calls.addons[0]), ['tv', 'kitsu:123:9', 1, 9]);
});

test('addon lookup preserves exact hash choice and reports unavailable sources without a TypeError', async () => {
    const { context } = resolverSetup('');
    context.getAddonStreams = async (type, id, season, episode, receive) => receive([{ infoHash: 'b'.repeat(40), url: 'https://wrong.test' }]);
    await assert.rejects(context.getPlayableSource({ hash, mediaType: 'tv', id: 'tt123', seasonNumber: 1, episodeNumber: 2 }), /no longer available/);
    context.getAddonStreams = async () => { throw new Error('Unavailable provider'); };
    assert.equal(await context.getPlayableSource({ sourceType: 'addon', hash, id: 'tt123', mediaType: 'tv', sourceUrl: 'https://original.test' }), 'https://original.test');
});

class Element {
    constructor() {
        this.style = {}; this.events = {}; this.children = []; this.dataset = {};
        this.classList = { add() {}, remove() {}, toggle() {} };
    }
    addEventListener(type, handler) { this.events[type] = handler; }
    removeEventListener() {}
    replaceChildren() { this.children = []; }
    querySelector() { return null; }
    scrollTo() {}
}

function playerSetup() {
    const storage = new Map();
    const elements = new Map();
    const getElement = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
    const instances = [];
    class Artplayer {
        constructor(options) {
            this.options = options; this.events = {}; this.controls = { show: true };
            this.video = Object.assign(new Element(), { currentTime: 0, duration: 100, readyState: 1, paused: false });
            instances.push(this);
        }
        on(type, callback) { (this.events[type] ??= []).push(callback); }
        emit(type) { this.events[type]?.forEach(callback => callback()); }
        destroy() { this.emit('destroy'); }
    }
    const context = vm.createContext({ crypto: { randomUUID }, console, Artplayer,
        setInterval: () => 1, clearInterval() {},
        appState: { currentUser: null }, navigator: { userAgent: '', platform: '' },
        document: { getElementById: getElement, addEventListener() {}, removeEventListener() {} },
        window: { dispatchEvent() {} }, CustomEvent: class { constructor(type, options) { this.detail = options.detail; } },
        getStorage: () => ({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }),
        getCurrentUserSettings: () => ({ user_preferences: { defaultPlayer: 'Internal' } }),
        detectContainer: async () => 'mp4', showToast() {}
    });
    vm.runInContext(readModule('../streaming/playlist.js'), context);
    vm.runInContext(readModule('../streaming/player.js'), context);
    context.initializePlaylist({
        resolveSource: async item => item.sourceUrl,
        play: (url, item, callbacks) => context.startPlayer(url, item.title, null, item, callbacks),
        stop: () => context.stopPlayback({ notify: false }), onError() {}
    });
    return { context, instances };
}

test('player controls and ended events use the playlist coordinator and stale players cannot advance', async () => {
    const { context, instances } = playerSetup();
    await context.startQueue([1, 2, 3].map(number => ({ sourceType: 'url', sourceUrl: `https://test/${number}`, title: `A${number}` })));
    assert.equal(instances[0].options.autoplay, true);
    assert.equal(context.getQueueState().playbackStatus, 'loading');
    instances[0].emit('video:playing');
    assert.equal(context.getQueueState().playbackStatus, 'playing');
    instances[0].emit('video:ended');
    await tick();
    assert.equal(context.getQueueState().current.title, 'A2');
    instances[0].emit('video:ended');
    assert.equal(context.getQueueState().current.title, 'A2');
    instances[1].options.controls.find(control => control.tooltip === 'Next in Queue').click();
    await tick();
    assert.equal(context.getQueueState().current.title, 'A3');
    instances[2].options.controls.find(control => control.tooltip === 'Previous').click();
    await tick();
    assert.equal(context.getQueueState().current.title, 'A2');
    instances.at(-1).emit('video:error');
    assert.equal(context.getQueueState().playbackStatus, 'failed');
});

test('closing or opening a direct player cancels queue work during container detection', async () => {
    const { context, instances } = playerSetup();
    let resolve;
    const detection = new Promise(done => { resolve = done; });
    context.detectContainer = () => detection;
    const pending = context.startQueue([{ sourceType: 'url', sourceUrl: 'https://queued.test', title: 'Queued' }]);
    await tick();
    context.stopPlayback();
    resolve('mp4');
    await pending;
    assert.equal(instances.length, 0);
    assert.equal(context.getQueueState().playbackStatus, 'idle');
    context.detectContainer = async () => 'mp4';
    await context.startPlayer('https://direct.test', 'Direct');
    assert.equal(instances.length, 1);
    assert.equal(instances[0].options.controls.some(control => control.tooltip === 'Next in Queue'), false);
});

test('picker forwards single episodes, exact row arrays, and header collections to the queue', async () => {
    const calls = [];
    const pickerElement = new Element();
    const context = vm.createContext({ console, document: { getElementById: () => pickerElement },
        startQueue: async (items, options) => calls.push({ action: 'play', items, options }),
        addToQueue: (items, options) => { calls.push({ action: 'queue', items, options }); return Array.isArray(items) ? items.length : 1; },
        showToast() {}
    });
    vm.runInContext(readModule('../metadata/picker.js'), context);
    context.closePicker = () => {};
    let view;
    context.renderPickerView = options => { view = options; view.getSeason('s1'); };
    const items = [1, 2, 3].map(fid => ({ hash, fid, sourceType: 'torrent', title: `E${fid}`, id: 'tt123' }));
    const group = { episodes: items };
    context.renderPickerUI({ title: 'Example', seasons: [{ key: 's1', variants: { merged: { episodes: items, groups: [group] } } }] }, new Element(), null);
    view.onEpisodeQueue(items[1]);
    assert.equal(calls.at(-1).items, items[1]);
    view.onGroupQueue(group);
    assert.equal(calls.at(-1).items, group.episodes);
    await view.onEpisodePlay(items[1], group);
    assert.equal(calls.at(-1).options.startItem, items[1]);
    assert.equal(calls.at(-1).options.includeThemes, true);
    await view.onShuffle();
    assert.equal(calls.at(-1).items, items);
    assert.equal(calls.at(-1).options.shuffled, true);
    view.onQueue();
    assert.equal(calls.at(-1).options.includeThemes, false);
});
