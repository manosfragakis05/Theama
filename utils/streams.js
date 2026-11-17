import { appState, smartFetch, showToast } from "../services/config";
import { getCurrentUserSettings } from "../user-data/user-settings";

export function getStreamHash(stream = {}) {
    if (!stream || typeof stream !== 'object') return '';

    const strings = [];
    const seen = new WeakSet();
    const collect = value => {
        if (typeof value === 'string') {
            strings.push(value);
            return '';
        }
        if (!value || typeof value !== 'object' || seen.has(value)) return '';
        seen.add(value);

        const entries = Object.entries(value);
        // Prefer validated infoHash fields over hashes embedded in other strings.
        for (const [key, candidate] of entries) {
            if (/^info_?hash$/i.test(key) && typeof candidate === 'string'
                && /^[a-f0-9]{40}$/i.test(candidate.trim())) {
                return candidate.trim().toLowerCase();
            }
        }
        for (const [key, candidate] of entries) {
            if (key === 'videoHash') continue; // OpenSubtitles hash, not a torrent hash.
            const hash = collect(candidate);
            if (hash) return hash;
        }
        return '';
    };

    const explicitHash = collect(stream);
    if (explicitHash) return explicitHash;

    for (let value of strings) {
        try { value = decodeURIComponent(value); } catch { /* Keep malformed URLs searchable. */ }
        const match = value.match(/(?:^|[^a-z0-9])([a-f0-9]{40})(?=$|[^a-z0-9])/i);
        if (match) return match[1].toLowerCase();
    }
    return '';
}

// Get a torrent object from a hash, NO KEY NEEDED
const libraryTorrentMetadata = new Map();
export async function resolveLibraryTorrents(sources, { refresh = false } = {}) {
    const normalizeHash = hash => typeof hash === 'string' ? hash.trim().toLowerCase() : '';
    
    const sourceOrder = new Map();
    sources.forEach((source, index) => {
        const hash = normalizeHash(source.hash);
        if (hash && !sourceOrder.has(hash)) sourceOrder.set(hash, {
            libraryAddedAt: source.addedAt || null,
            librarySourceOrder: sources.length - index
        });
    });
    if (sourceOrder.size === 0) throw new Error(NO_SOURCE_MESSAGE);
    const userId = appState.currentUser?.id;

    const results = await Promise.allSettled([...sourceOrder].map(async ([hash, order]) => {
        let torrent = !refresh && libraryTorrentMetadata.get(hash);
        if (!torrent) {
            const params = new URLSearchParams({ hash, timeout: '10', use_cache_lookup: String(!refresh) });
            const res = await smartFetch(`https://api.torbox.app/v1/api/torrents/torrentinfo?${params}`);
            const result = await res.json();
            const info = result.data;
            if (!res.ok || !result.success || !info || !Array.isArray(info.files)
                || (info.hash && normalizeHash(info.hash) !== hash)) {
                throw new Error(result.detail || 'Could not load this torrent\'s file list.');
            }
            const files = info.files.filter(file => typeof file?.name === 'string' && file.name.trim());
            if (!files.length) throw new Error('No files were returned for this torrent.');
            torrent = {
                ...info,
                // Public metadata has no account IDs. Resolve these only when playing/downloading.
                id: `library:${hash}`,
                hash,
                name: info.name || files[0].name,
                files: files.map(file => ({
                    ...file,
                    id: file.name,
                    short_name: file.name.split(/[\\/]/).at(-1)
                }))
            };
            libraryTorrentMetadata.set(hash, torrent);
        }
        return { ...torrent, ...order, files: torrent.files.map(file => ({ ...file })) };
    }));
    if (userId !== appState.currentUser?.id) throw new Error('Your account changed. Please open this item again.');
    const torrents = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    const failures = results.filter(result => result.status === 'rejected');
    if (!torrents.length) throw failures[0].reason;
    if (failures.length) showToast(`Could not load ${failures.length} source file list(s). Try opening this item again.`, 'info');
    return torrents;
}

// Public metadata IDs identify a hash and filename, not a TorBox account item.
export async function resolveLibraryTorrentFile(torrentId, fileName) {
    const hash = String(torrentId).slice('library:'.length).toLowerCase();
    const key = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!key) throw new Error('Link TorBox in settings to play or download this file.');
    const userId = appState.currentUser?.id;
    const isCurrent = () => userId === appState.currentUser?.id
        && key === getCurrentUserSettings().user_preferences.torboxApiKey;
    const normalizePath = name => String(name || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const path = normalizePath(fileName);
    const findFile = torrent => {
        if (!torrent?.download_finished || torrent.id == null) return null;
        const files = (torrent.files || []).filter(file => file.id != null);
        const exact = files.find(file => normalizePath(file.name) === path);
        const matches = exact ? [exact] : files.filter(file =>
            normalizePath(file.short_name || file.name).split('/').at(-1) === path.split('/').at(-1));
        return matches.length === 1 ? { torrentId: torrent.id, fileId: matches[0].id } : null;
    };
    const cached = appState.allTorrents.find(torrent => torrent.hash?.toLowerCase() === hash);
    const cachedFile = findFile(cached);
    if (cachedFile) return cachedFile;

    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
        const response = await smartFetch(
            `https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true&offset=${offset}&limit=${pageSize}`,
            { headers: { Authorization: `Bearer ${key}` } }
        );
        const result = await response.json();
        if (!isCurrent()) throw new Error('Your account changed. Please open this item again.');
        if (!response.ok || !result.success || !Array.isArray(result.data)) {
            throw new Error(result.detail || 'Could not load your TorBox files.');
        }
        const torrent = result.data.find(torrent => torrent.hash?.toLowerCase() === hash);
        if (torrent) {
            if (!torrent.download_finished) throw new Error('This torrent is not ready yet. Check its download in TorBox.');
            const file = findFile(torrent);
            if (!file) throw new Error('Could not match this file to your TorBox torrent.');
            appState.allTorrents = [...appState.allTorrents.filter(item => item.hash?.toLowerCase() !== hash), torrent];
            return file;
        }
        if (result.data.length < pageSize) break;
    }
    throw new Error('Add this torrent to your TorBox account to play or download it.');
}