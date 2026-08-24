import { renderAllWatchlists } from '../profile-renderer.js';
import { parse as pttParse } from './ptt.js';

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


    const pttData = parseMediaData(streamDesc);

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
            finalResolution = pttData.resolution || "Unknown";
        }
    } else {
        finalResolution = pttData.resolution;
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
        streamData.seeders = parseInt(seederMatch[1].replace(/,/g, ''), 10);
    } else {
        streamData.seeders = pttData.seeders || 0;
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

// Parse single strings
export function parseMediaData(rawString) {
    let cleanName = rawString.toLowerCase();

    let fallbackSeason = null;
    let fallbackEpisode = null;
    const seMatch = rawString.match(/[sS](\d{1,2})[\.\-\s]?[eE](\d{1,4})/);
    if (seMatch) {
        fallbackSeason = parseInt(seMatch[1], 10);
        fallbackEpisode = parseInt(seMatch[2], 10);
    }

    // Use PTT library
    const parsed = pttParse(rawString);

    let finalTitle = parsed.title || rawString;

    // Season packs
    let seasonText = null;

    if (/\b(?:complete series|complete collection|the complete series|full series)\b/i.test(cleanName)) {
        seasonText = "COMPLETE SERIES";
    }
    if (!seasonText) {
        const seasonRangeMatch = cleanName.match(/(?:s|season[s]?\s*)0*(\d{1,2})\s*(?:-|~)\s*(?:s|season[s]?\s*)?0*(\d{1,2})/i);
        if (seasonRangeMatch) {
            seasonText = `SEASONS ${seasonRangeMatch[1]}-${seasonRangeMatch[2]}`;
        }
    }
    if (!seasonText && Array.isArray(parsed.season) && parsed.season.length > 1) {
        const min = Math.min(...parsed.season);
        const max = Math.max(...parsed.season);
        seasonText = `SEASONS ${min}-${max}`;
    }
    if (!seasonText) {
        const epRangeMatch = rawString.match(/(?:^|\s|-\s)0*(\d{1,3})\s*(?:~|\s-\s)\s*0*(\d{1,3})(?:\s|$|\[|\()/);
        if (epRangeMatch) {
            seasonText = `EPISODES ${epRangeMatch[1]}-${epRangeMatch[2]}`;
        }
    }
    if (!seasonText) {
        const activeSeason = parsed.season !== undefined ? parsed.season : fallbackSeason;
        const activeEpisode = parsed.episode !== undefined ? parsed.episode : fallbackEpisode;

        if (activeSeason !== undefined && activeSeason !== null && !Array.isArray(activeSeason)) {
            const hasPackKeywords = /\b(?:season pack|complete season|season \d+ complete)\b/i.test(cleanName);
            if (hasPackKeywords || (activeEpisode === undefined || activeEpisode === null)) {
                seasonText = `FULL SEASON ${activeSeason}`;
            }
        }
    }
    if (!seasonText && /\bseason pack\b/i.test(cleanName)) {
        seasonText = "SEASON PACK";
    }

    // Video codec
    let videoFormat = "";
    if (parsed.codec) {
        videoFormat = (parsed.codec).toUpperCase();

        if (videoFormat === 'H264' || videoFormat === 'X264') {
            videoFormat = 'x264';
        } else if (videoFormat === 'H265' || videoFormat === 'X265' || videoFormat === 'HEVC') {
            videoFormat = 'HEVC/x265';
        }
    }

    // Video Source (Blueray/WebRip...)
    const customVideo = extractVideoCodec(cleanName);
    const finalVideoSource = customVideo.source || parsed.source || "Unknown";
    const finalVideoTier = customVideo.tier || "Standard";
    const videoData = { source: finalVideoSource, tier: finalVideoTier };

    // Audio Codec
    const customAudio = extractAudioCodec(cleanName);
    
    const finalAudioCodecs = customAudio.codecs || (parsed.audio ? [parsed.audio] : []);
    const finalAudioTier = customAudio.tier || "Standard";
    const audioData = { codecs: finalAudioCodecs, tier: finalAudioTier };

    finalTitle = finalTitle.replace(/^\[.*?\]\s*/, '');
    finalTitle = finalTitle.replace(/\s*\[.*?\]$/, '');

    finalTitle = finalTitle.replace(/[._]/g, ' ');
    finalTitle = finalTitle.split(/\(|\bseason\b|\bepisode\b/i)[0];
    finalTitle = finalTitle.replace(/\b[sS]\d{1,2}[eE]\d{1,4}\b/g, '');

    if (parsed.year) {
        const yearRegex = new RegExp(`\\s?\\[?${parsed.year}\\]?`, 'g');
        finalTitle = finalTitle.replace(yearRegex, '');
    } else {
        finalTitle = finalTitle.replace(/\s\d{4}$/, '');
    }

    // 7. Clean up emojis, leftover hyphens, and normalize multiple spaces
    finalTitle = finalTitle.replace(/[\p{Extended_Pictographic}]/gu, '');
    finalTitle = finalTitle.replace(/\s+/g, ' ').trim();
    finalTitle = finalTitle.replace(/^[-–—\s]+|[-–—\s]+$/g, '');

    const pttData = {
        title: finalTitle,
        year: parsed.year,
        season: parsed.season !== undefined ? parsed.season : fallbackSeason,
        episode: parsed.episode !== undefined ? parsed.episode : fallbackEpisode,
        seasonDetails: seasonText,
        audioType: audioData,
        languages: parsed.languages,
        videoType: parsed.codec || videoFormat,
        resolution: parsed.resolution,
        source: videoData
    };

    return pttData;
}

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

// Audio categorization
const losslessAudio = [
    'atmos', 'truehd', 'dts-hd', 'dts:x', 'lossless'
];

const premiumAudio = [
    'flac', 'aac', 'dts', 'dd5.1', 'ac3', 'eac3', 'e-ac3', 'dd+', 'dolby digital', '5.1', '7.1'
];

// Master list for the regex scanner
const allAudioTypes = [...losslessAudio, ...premiumAudio];

function extractAudioCodec(rawString) {
    const foundAudio = new Set();
    let highestTier = "Standard";

    allAudioTypes.forEach(audio => {
        // Escape special characters like + or . in the audio name
        const escapedAudio = audio.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

        // This regex ensures we match exactly the audio string and not partial words
        const audioRegex = new RegExp(`(?:^|\\W|_)${escapedAudio}(?:$|\\W|_)`, 'i');

        if (audioRegex.test(rawString)) {
            foundAudio.add(audio);
        }
    });

    const codecsArray = foundAudio.size > 0 ? Array.from(foundAudio) : null;

    // Evaluate the tier if codecs were found
    if (codecsArray) {
        if (codecsArray.some(c => losslessAudio.includes(c))) {
            highestTier = "Lossless";
        } else if (codecsArray.some(c => premiumAudio.includes(c))) {
            highestTier = "Premium";
        }
    }

    return {
        codecs: codecsArray,
        tier: highestTier
    };
}