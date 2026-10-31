export function getStreamHash(stream = {}, fallbackLink = '') {
    if (typeof stream.infoHash === 'string' && stream.infoHash.trim()) return stream.infoHash.trim().toLowerCase();
    for (const value of [stream.url, fallbackLink, stream.behaviorHints?.bingeGroup]) {
        if (typeof value !== 'string') continue;
        const match = value.match(/(?:btih:|[\/|=])([a-f0-9]{40})(?=[\/?&#|]|$)/i);
        if (match) return match[1].toLowerCase();
    }
    return '';
}
