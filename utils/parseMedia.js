import { parseTorrentTitle as parseMedia } from "@viren070/parse-torrent-title";

// Detect and parse full stream data
export function parseFormated(stream) {

    if (!stream) return;

    const streamName = (stream.name || "").toLowerCase();
    const streamDesc = stream.description || stream.title || stream.name || "";

    const isCached =
        streamName.includes('torbox+') ||
        streamName.includes('tb+') ||
        streamName.includes('torbox⚡') ||
        streamName.includes('tb⚡');


    const pttData = parseMedia(streamDesc);

    let finalResolution = "";

    if (streamName) {
        if (streamName.includes('4k hdr') || streamName.includes('4k hdr10') || streamName.includes('4k hdr10+') || streamName.includes('4khdr') || streamName.includes('4khdr10') || streamName.includes('4khdr10+')) {
            finalResolution = "4k HDR";
        } else if (streamName.includes('4k') || streamName.includes('2160p')) {
            finalResolution = "4K";
        } else if (streamName.includes('1080p')) {
            finalResolution = "1080p";
        } else if (streamName.includes('720p')) {
            finalResolution = "720p";
        } else if (streamName.includes('480p') || streamName.includes('sd')) {
            finalResolution = "SD";
        } else if (streamName.includes('unknown')) {
            finalResolution = "Unknown";
        }
    }

    const streamData = {
        isCached: isCached,
        seeders: 0,
        resolution: finalResolution,
        size: null,
        languages: [],
        multi: null
    };

    // Seeders
    const seederMatch = streamDesc.match(/👤[\s\-:|]*([\d,]+)/u);
    if (seederMatch) {
        streamData.seeders = parseInt(seederMatch[1].replace(/,/g, ''), 10) || 0;
    }

    // Size
    const sizeMatch = streamDesc.match(/💾[\s\-:|]*([\d.]+\s*[KMGT]i?B)/ui);
    if (sizeMatch) {
        streamData.size = sizeMatch[1].trim();
    } else {
        streamData.size = pttData.size || null;
    }

    // Languages
    const lineLanguages = extractLanguage(streamDesc);

    if (lineLanguages.languages) {
        streamData.languages = lineLanguages.languages;
    }

    if (lineLanguages.multi) {
        streamData.multi = lineLanguages.multi;
    }

    if (!streamData.languages || streamData.languages.length === 0) {
        streamData.languages = pttData.languages || null;
    }

    const fullData = { ...pttData, ...streamData };

    return fullData;
}

export function parseMediaData(rawString) {
    let cleanName = rawString.toLowerCase();

    const parsed = parseMedia(rawString);

    // Works for now
    return parsed;
}

// Preserve the library result and normalize the fields used by source badges.
export function customParser(rawString) {
    const input = typeof rawString === 'string' ? rawString : '';
    const parsed = parseMedia(input);
    const quality = extractVideoCodec(parsed.quality || input).source || parsed.quality || '';
    const codec = findMediaFormats(parsed.codec || input, videoCodecs)[0]?.label || parsed.codec?.toUpperCase() || '';
    const audio = new Set(findMediaFormats(input, audioCodecs, true).map(format => format.label));

    for (const value of parsed.audio || []) {
        // The library groups DTS variants together; retain the more specific raw-title match.
        if (/^DTS Loss(?:less|y)$/i.test(value) && [...audio].some(codec => codec.startsWith('DTS'))) continue;
        const normalized = findMediaFormats(value, audioCodecs)[0]?.label || value;
        if (normalized === 'Dolby Digital' && audio.has('Dolby Digital Plus') && !audio.has('Dolby Digital')) continue;
        audio.add(normalized);
    }

    const languageValues = [...(parsed.languages || []), ...(extractLanguage(input).languages || [])];
    const languageTags = [];
    const hasDualAudio = languageValues.includes('dual audio');
    const hasMultiAudio = languageValues.includes('multi audio');
    if (hasDualAudio) languageTags.push('Dual Audio');
    if (hasMultiAudio) languageTags.push('Multi Audio');
    if (parsed.dubbed && !hasDualAudio && !hasMultiAudio) languageTags.push('Dubbed');
    if (parsed.subbed || languageValues.includes('multi subs')) languageTags.push('Subbed');

    const languages = languageValues.filter(value => !['dual audio', 'multi audio', 'multi subs'].includes(value))
        .map(value => {
            if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value)) {
                return languageNames.of(value) || value;
            }
            return value;
        });

    return {
        ...parsed,
        resolution: { '4k': '2160p', '8k': '4320p' }[parsed.resolution?.toLowerCase()] || parsed.resolution || '',
        quality,
        codec,
        audio: [...audio],
        languages: [...new Set(languages)],
        languageTags
    };
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

// Ensure these are defined at the top of your file
const emojiToLanguage = {
    '🇬🇧': 'English', '🇺🇸': 'English', 'EN': 'English',
    '🇫🇷': 'French',
    '🇪🇸': 'Spanish', '🇲🇽': 'Spanish',
    '🇮🇹': 'Italian',
    '🇷🇺': 'Russian',
    '🇩🇪': 'German',
    '🇵🇹': 'Portuguese', '🇧🇷': 'Portuguese',
    '🇯🇵': 'Japanese',
    '🇰🇷': 'Korean',
    '🇮🇳': 'Hindi',
    '🇨🇳': 'Chinese', '🇹🇼': 'Chinese', '🇭🇰': 'Chinese',
    '🇳🇱': 'Dutch',
    '🇵🇱': 'Polish',
    '🇷🇴': 'Romanian',
    '🇬🇷': 'Greek',
    '🇩🇰': 'Danish',
    '🇫🇮': 'Finnish',
    '🇸🇪': 'Swedish',
    '🇳🇴': 'Norwegian',
    '🇹🇷': 'Turkish',
    '🇸🇦': 'Arabic',
    '🇮🇱': 'Hebrew',
    '🇮🇩': 'Indonesian',
    '🇹🇭': 'Thai'
};

//#region Extractors
function extractLanguage(rawString) {
    const foundLanguages = new Set();

    let multiStatus = null;

    if (/\bmulti\b/i.test(rawString)) {
        multiStatus = "Multi";
    } else if (/\bdual\b/i.test(rawString)) {
        multiStatus = "Dual";
    } else if (/\bdubbed\b/i.test(rawString)) {
        multiStatus = "Dubbed";
    } else if (/\bsub\b/i.test(rawString)) {
        multiStatus = "Subbed";
    }

    // 2. Language Extraction
    Object.entries(emojiToLanguage).forEach(([key, langName]) => {
        const isText = /^[a-zA-Z]+$/.test(key);

        if (isText) {
            const langRegex = new RegExp(`\\b${key}\\b`, 'i');
            if (langRegex.test(rawString)) {
                foundLanguages.add(langName);
            }
        } else {
            if (rawString.includes(key)) {
                foundLanguages.add(langName);
            }
        }
    });

    return {
        languages: foundLanguages.size > 0 ? Array.from(foundLanguages) : null,
        multi: multiStatus
    };
}

// Video formats
const videoQualities = [
    // 1. Remux
    { source: "Remux", tier: "Premium", patterns: ['remux', 'bdremux', 'uhdremux', '4kremux'] },
    { source: "BluRay", tier: "Premium", patterns: ['bluray', 'blu-ray', 'bdrip', 'brrip', 'bdmv', 'bdr'] },
    { source: "WEB-DL", tier: "Premium", patterns: ['web-dl', 'webdl', 'web.dl', 'web dl'] },

    { source: "WEBRip", tier: "Standard", patterns: ['web-rip', 'webrip', 'web.rip', 'web rip'] },
    { source: "HDTV", tier: "Standard", patterns: ['hdtv', 'tvrip'] },
    { source: "HDRip", tier: "Standard", patterns: ['hdrip'] },
    { source: "WEB", tier: "Standard", patterns: ['web'] },
    { source: "DVD", tier: "Standard", patterns: ['dvdrip', 'dvd', 'dvdscr'] },
    { source: "CAM", tier: "Standard", patterns: ['cam', 'camrip', 'hdcam', 'ts', 'hdts', 'telesync', 'tc', 'telecine', 'scr', 'screener'] }
];

function extractVideoCodec(rawString) {
    const cleanName = rawString.toLowerCase();

    for (const quality of videoQualities) {
        for (const pattern of quality.patterns) {
            // Escapes special characters and ensures we match the exact alias
            const escapedPattern = pattern.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const regex = new RegExp(`(?:^|\\W|_)${escapedPattern}(?:$|\\W|_)`, 'i');

            if (regex.test(cleanName)) {
                return {
                    source: quality.source,
                    tier: quality.tier
                };
            }
        }
    }

    // Default fallback if absolutely nothing is found
    return { source: null, tier: "Standard" };
}

// Aliases share one display label, regardless of spelling or release-name separators.
const videoCodecs = [
    { label: 'HEVC', patterns: ['hevc', 'h265', 'h.265', 'x265'] },
    { label: 'AVC', patterns: ['avc', 'h264', 'h.264', 'x264'] },
    { label: 'VVC', patterns: ['vvc', 'h266', 'h.266'] },
    { label: 'AV1', patterns: ['av1'] },
    { label: 'VP9', patterns: ['vp9'] },
    { label: 'VP8', patterns: ['vp8'] },
    { label: 'MPEG-2', patterns: ['mpeg2', 'mpeg-2'] },
    { label: 'DivX', patterns: ['divx', 'dvix'] },
    { label: 'Xvid', patterns: ['xvid'] }
];

const audioCodecs = [
    { label: 'Dolby Atmos', patterns: ['dolby atmos', 'atmos'] },
    { label: 'Dolby TrueHD', patterns: ['dolby truehd', 'truehd', 'true-hd'] },
    { label: 'Dolby Digital Plus', patterns: ['dolby digital plus', 'dd plus', 'e-ac-3', 'e-ac3', 'eac3', 'dd+', 'ddp'] },
    { label: 'Dolby Digital', patterns: ['dolby digital', 'dolbyd', 'ac3', 'ac-3', 'dd'] },
    { label: 'DTS-HD MA', patterns: ['dts-hd master audio', 'dts-hd master', 'dts-hd ma', 'dtshdma'] },
    { label: 'DTS-HD HRA', patterns: ['dts-hd hra', 'dts-hd hr', 'dtshdhr'] },
    { label: 'DTS:X', patterns: ['dts:x', 'dts-x'] },
    { label: 'DTS-HD', patterns: ['dts-hd'] },
    { label: 'DTS', patterns: ['dts', 'dts lossy'] },
    { label: 'DTS Lossless', patterns: ['dts lossless'] },
    { label: 'FLAC', patterns: ['flac'] },
    { label: 'AAC', patterns: ['he-aac', 'aac-lc', 'qaac', 'aac'] },
    { label: 'Opus', patterns: ['opus'] },
    { label: 'PCM', patterns: ['lpcm', 'pcm'] },
    { label: 'ALAC', patterns: ['alac'] },
    { label: 'MP3', patterns: ['mp3'] },
    { label: 'MP2', patterns: ['mp2'] }
];

function findMediaFormats(rawString, formats, allowChannelSuffix = false) {
    const aliases = formats.flatMap(format => format.patterns).sort((a, b) => b.length - a.length);
    const patterns = aliases.map(alias => alias.split(/[ ._-]+/)
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[ ._-]*'));
    const regex = new RegExp(`(?:^|[^a-z0-9])(${patterns.join('|')})(?=$|[^a-z0-9]${allowChannelSuffix ? '|\\d' : ''})`, 'gi');
    const aliasKey = value => value.toLowerCase().replace(/[ ._-]/g, '');
    const found = new Set();

    // Longest aliases consume the whole match, so DTS-HD MA doesn't also become DTS.
    for (const match of (rawString || '').matchAll(regex)) {
        const format = formats.find(format => format.patterns.some(alias => aliasKey(alias) === aliasKey(match[1])));
        if (format) found.add(format);
    }
    return [...found];
}
