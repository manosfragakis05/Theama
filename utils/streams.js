export function getStreamHash(stream = {}, fallbackLink = '') {
    if (typeof stream.infoHash === 'string' && stream.infoHash.trim()) return stream.infoHash.trim().toLowerCase();
    for (const value of [stream.url, fallbackLink, stream.behaviorHints?.bingeGroup]) {
        if (typeof value !== 'string') continue;
        const match = value.match(/(?:btih:|[\/|=])([a-f0-9]{40})(?=[\/?&#|]|$)/i);
        if (match) return match[1].toLowerCase();
    }
    return '';
}

export function isUsenetStream(stream = {}) {
    return Boolean(stream.nzbUrl || stream.streamData?.type === 'usenet'
        || stream.behaviorHints?.bingeGroup?.split('|').includes('usenet')
        || /\b(?:Newznab|NZBHydra2?|Usenet)\b/i.test(stream.name || ''));
}
