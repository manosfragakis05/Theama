import { appState, smartFetch } from "../services/config";
import { getAddonStreams } from "../user-addons/scrapers";
import { getCurrentUserSettings } from "../user-data/user-settings";

export async function getPlayableSource(episode) {
    const hasTorbox = getCurrentUserSettings().user_preferences.torboxApiKey != "";

    const hash = episode.hash;
    const url = episode.sourceUrl;
    if (!hash && !url) return;

    let file_id = episode?.fid;

    const type = episode.mediaType || episode.media_type;

    if (hasTorbox && hash) {
        let torrent = {};
        if (file_id == null) {
            torrent = await getTorboxTorrentFromHash(hash, true);

            file_id = getFirstVideoFile(torrent);
        } else {
            torrent = await getTorboxTorrentFromHash(hash, false);
        }
        if (!torrent?.download_finished) return;

        let torboxType = 'torrents';

        const isUsenet = torrent.torboxType === 'usenet';
        if (isUsenet) torboxType = 'usenet'

        const params = new URLSearchParams({
            token: getCurrentUserSettings().user_preferences.torboxApiKey,
            [isUsenet ? 'usenet_id' : 'torrent_id']: String(torrent.id),
            file_id: file_id,
            redirect: 'true'
        });

        return `https://api.torbox.app/v1/api/${torboxType}/requestdl?${params}`;
    }

    if (!hasTorbox && hash) {
        let targetStream;

        await getAddonStreams(
            type, episode.id, episode.seasonNumber, episode.episodeNumber,
            (streams) => {
                if (targetStream) return true;
                targetStream = getTargetStreamFromHash(hash, streams);
                if (!targetStream) return false;
                return true;
            }
        );
        console.log(targetStream);

        return targetStream.url;
    }

    return episode.url;
}

function getFirstVideoFile(torrent) {
    const hasTorbox = getCurrentUserSettings().user_preferences.torboxApiKey != "";
    if (hasTorbox && torrent) {
        const videoFiles = (torrent.files || []).filter(f => /\.(mkv|mp4|avi|mov)$/i.test(f.name));
        const file_id = videoFiles[0]?.id;

        return file_id;
    }
    return null;
}

function getTargetStreamFromHash(hash, streams) {
    for (const stream of streams) {
        stream.hash = getStreamHash(stream);
        if (stream.hash === hash) return stream;
    }
}

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

// Return the public API's torrent object without modifying it.
export async function getTorrentObjectFromHash(hash) {
    if (typeof hash !== 'string' || !hash.trim()) throw new Error('A torrent hash is required.');

    const params = new URLSearchParams({ hash: hash.trim(), timeout: '10', use_cache_lookup: 'true' });
    const response = await smartFetch(`https://api.torbox.app/v1/api/torrents/torrentinfo?${params}`);
    const result = await response.json();
    if (!response.ok || !result.success || !result.data
        || typeof result.data !== 'object' || Array.isArray(result.data)) {
        throw new Error(result.detail || 'Could not load torrent metadata.');
    }
    return result.data;
}

// Return the matching account torrent unchanged, without its file listing.
export async function getTorboxTorrentFromHash(hash, withFiles = false) {
    if (typeof hash !== 'string' || !hash.trim()) throw new Error('A torrent hash is required.');
    const key = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!key) throw new Error('Link TorBox in settings to look up this torrent.');

    const normalizedHash = hash.trim().toLowerCase();
    const { getCloudDownloads } = await import('../pages/library.js');
    const cached = getCloudDownloads().find(item => item.hash?.toLowerCase() === normalizedHash);
    if (cached) return cached;

    const pageSize = 1000;
    const lists = await Promise.all(['torrents', 'usenet'].map(async section => {
        const downloads = [];
        for (let offset = 0; ; offset += pageSize) {
            const params = new URLSearchParams({ files: withFiles, bypass_cache: 'true', offset: String(offset), limit: String(pageSize) });
            const response = await smartFetch(`https://api.torbox.app/v1/api/${section}/mylist?${params}`, {
                headers: { Authorization: `Bearer ${key}` }
            });
            const result = await response.json();
            if (!response.ok || !result.success || !Array.isArray(result.data)) {
                throw new Error(result.detail || `Could not load your TorBox ${section} downloads.`);
            }
            downloads.push(...result.data.map(item => ({
                ...item, torboxType: section === 'usenet' ? 'usenet' : 'torrent'
            })));
            if (result.data.length < pageSize) return downloads;
        }
    }));
    return lists.flat().find(item => item.hash?.toLowerCase() === normalizedHash) || null;
}

// Match a public filename or a saved numeric file ID to a TorBox account item.
export async function resolveLibraryTorrentFile(torrentId, fileName) {
    const hash = String(torrentId).slice('library:'.length).toLowerCase();
    const key = getCurrentUserSettings().user_preferences.torboxApiKey;
    if (!key) throw new Error('Link TorBox in settings to play or download this file.');

    const normalizePath = name => String(name || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const path = normalizePath(fileName);

    const findFile = torrent => {
        if (!torrent?.download_finished || torrent.id == null) return null;
        const files = (torrent.files || []).filter(file => file.id != null);
        const exact = files.find(file => typeof fileName === 'number'
            ? Number(file.id) === fileName : normalizePath(file.name) === path);
        const matches = exact ? [exact] : typeof fileName === 'number' ? [] : files.filter(file =>
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
