import { getStreamHash } from './streams.js';

export function getResolutionBucket(resolution) {
    if (['2160p', '2160i', '4320p', '4320i', '4K', '4k HDR'].includes(resolution)) return 'bucket4K';
    if (['1080p', '1080i', '1440p'].includes(resolution)) return 'bucket1080p';
    return 'bucketOther';
}

export function parseDurationMinutes(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
    const text = String(value ?? '').trim().toLowerCase();
    if (/^\d+(?:\.\d+)?$/.test(text)) return parseDurationMinutes(Number(text));
    const hours = text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)/);
    const minutes = text.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)/);
    const total = Number(hours?.[1] || 0) * 60 + Number(minutes?.[1] || 0);
    return total > 0 ? total : null;
}

export function getMediaDurationMinutes(media) {
    if (['series', 'tv', 'anime'].includes(media.type)) {
        const season = media.seasons?.find(item => item.seasonNumber === media.activeSeason);
        const episode = season?.episodes?.find(item => item.episodeNumber === media.activeEpisode);
        return parseDurationMinutes(episode?.duration) ?? parseDurationMinutes(media.runtime);
    }
    return parseDurationMinutes(media.runtime);
}

export function getStreamSizeBytes(stream) {
    const raw = stream.rawStream;
    for (const value of [raw.behaviorHints?.videoSize, raw.size]) {
        if (value != null && Number.isFinite(Number(value)) && Number(value) > 0) return Number(value);
    }
    const size = stream.parsedData?.size || raw.size;
    if (typeof size === 'number') return size > 0 && Number.isFinite(size) ? size : null;
    const match = String(size ?? '').trim().match(/^(\d+(?:[.,]\d+)?)\s*([KMGT]?)(i?)B$/i)
        || String(raw.description || raw.title || '').match(/\b(\d+(?:[.,]\d+)?)\s*([KMGT])(i?)B\b/i);
    if (!match) return null;
    const power = match[2] ? 'KMGT'.indexOf(match[2].toUpperCase()) + 1 : 0;
    const bytes = Number(match[1].replace(',', '.')) * (match[3] ? 1024 : 1000) ** power;
    return bytes > 0 && Number.isFinite(bytes) ? bytes : null;
}

// Preserve add-on and source order, applying the same buckets as the picker.
export function selectFirstSource(addonResults, preferences, durationMinutes) {
    const bucket = { '4K': 'bucket4K', '1080p': 'bucket1080p', other: 'bucketOther' }[preferences.playFirstSourceResolution] || 'bucket1080p';
    const limitGB = Number(preferences.playFirstSourceMaxSizeGB);
    const hasLimit = Number.isFinite(limitGB) && limitGB > 0;
    if (hasLimit && !(Number.isFinite(durationMinutes) && durationMinutes > 0)) return null;
    const maxBytes = hasLimit ? limitGB * 1e9 * durationMinutes / 120 : Infinity;

    for (const result of addonResults) {
        for (const stream of result[bucket] || []) {
            const raw = stream.rawStream;
            const hasDirectUrl = /^https?:\/\//i.test(raw.url || '');
            if (!hasDirectUrl && !(preferences.torboxApiKey && getStreamHash(raw))) continue;
            const size = getStreamSizeBytes(stream);
            if (hasLimit && (size === null || size > maxBytes)) continue;
            return raw;
        }
    }
    return null;
}
