import { smartFetch } from './config.js';

export function getTorboxDownloadRequest(itemId, fileId, key, torboxType = 'torrent') {
    const usenet = torboxType === 'usenet';
    const url = new URL(`https://api.torbox.app/v1/api/${usenet ? 'usenet' : 'torrents'}/requestdl`);
    url.searchParams.set('token', key);
    url.searchParams.set(usenet ? 'usenet_id' : 'torrent_id', itemId);
    url.searchParams.set('file_id', fileId);
    if (!usenet) url.searchParams.set('zip', 'false');
    return url.href;
}

export async function getTorboxCloudList(key, torboxType = 'torrent') {
    const section = torboxType === 'usenet' ? 'usenet' : 'torrents';
    const response = await smartFetch(`https://api.torbox.app/v1/api/${section}/mylist?bypass_cache=true`, {
        headers: { Authorization: `Bearer ${key}` }
    });
    const result = await response.json();
    if (!response.ok || !result.success || !Array.isArray(result.data)) {
        throw new Error(`Could not load your TorBox ${section} downloads.`);
    }
    return result.data.map(item => ({ ...item, torboxType }));
}

export function isReadyCloudDownload(item) {
    return Boolean(item.download_finished && (item.torboxType !== 'usenet'
        || (item.cached !== false && item.download_present !== false)));
}
