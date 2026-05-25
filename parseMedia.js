import { parse as pttParse } from './ptt.js';

export function parseTorrentio(fullTitle) {

    if (!fullTitle) return;

    const lines = fullTitle.split(/\r?\n/);

    const pttData = parseMediaData(lines[0]);

    const streamData = {
        seeders: 0,
        size: null,
        group: null,
        languages: [],
        multi: null
    };

    // Seeders
    const seederMatch = fullTitle.match(/👤[\s\-:|]*([\d,]+)/u);
    if (seederMatch) {
        streamData.seeders = parseInt(seederMatch[1].replace(/,/g, ''), 10);
    } else {
        streamData.seeders = pttData.seeders || 0;
    }

    // Size
    const sizeMatch = fullTitle.match(/💾[\s\-:|]*([\d.]+\s*[KMGT]i?B)/ui);
    if (sizeMatch) {
        streamData.size = sizeMatch[1].trim();
    } else {
        streamData.size = pttData.size || null;
    }

    // Group
    const groupMatch = fullTitle.match(/⚙️\s*([^\n]+)/);
    if (groupMatch) {
        streamData.group = groupMatch[1].trim();
    }

    // Languages
    const lastLine = lines[lines.length - 1];

    const isMetadataLine = lastLine.includes('👤') || lastLine.includes('💾') || lastLine.includes('⚙️');

    if (!isMetadataLine && lines.length > 1) {
        const lineLanguages = extractLanguage(lastLine);

        if (lineLanguages.languages) {
            streamData.languages = lineLanguages.languages;
        }

        if (lineLanguages.multi) {
            streamData.multi = lineLanguages.multi;
        }
    }

    if (!streamData.languages || streamData.languages.length === 0) {
        streamData.languages = pttData.languages || null;
    }

    const fullData = { ...pttData, ...streamData };

    return fullData;
}


function parseMediaData(rawString) {
    let cleanName = rawString.toLowerCase();

    let fallbackSeason = null;
    let fallbackEpisode = null;
    const seMatch = rawString.match(/[sS](\d{1,2})[\.\-\s]?[eE](\d{1,4})/);
    if (seMatch) {
        fallbackSeason = parseInt(seMatch[1], 10);
        fallbackEpisode = parseInt(seMatch[2], 10);
    }

    // Uses PTT for Western shows
    const parsed = pttParse(cleanName);

    let finalTitle = parsed.title || cleanName;

    // Season packs
    let seasonText = null;

    if (/\b(?:complete series|complete collection|the complete series)\b/i.test(cleanName)) {
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

    // Video codec
    const customVideo = extractVideoCodec(rawString);

    // Audio codec
    const customAudio = extractAudioCodec(rawString);

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
        season: parsed.season !== undefined ? parsed.season : fallbackSeason,
        episode: parsed.episode !== undefined ? parsed.episode : fallbackEpisode,
        seasonDetails: seasonText,
        audioType: customAudio || parsed.audio,
        languages: parsed.languages,
        videoType: parsed.codec || videoFormat,
        resolution: parsed.resolution,
        source: customVideo || parsed.source
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
function extractVideoCodec(rawString) {
    // Check for Remux first, as it's the ultimate quality modifier
    const isRemux = /\bremux\b/i.test(rawString);

    if (/\b(?:blu-?ray|blue-?ray|bdrip|brrip)\b/i.test(rawString)) {
        return isRemux ? "BluRay Remux" : "BluRay";
    }

    // 2. WEB-DL (Matches: web-dl, webdl, web.dl)
    if (/\b(?:web-?dl|web\.dl)\b/i.test(rawString)) {
        return "WEB-DL";
    }

    // 3. WEBRip (Matches: web-rip, webrip, web.rip)
    if (/\b(?:web-?rip|web\.rip)\b/i.test(rawString)) {
        return "WEBRip";
    }

    // 4. Fallback WEB (If it just says "WEB")
    if (/\b(?:web)\b/i.test(rawString)) {
        return "WEB";
    }

    // 5. HDTV / HDRip
    if (/\b(?:hdtv)\b/i.test(rawString)) return "HDTV";
    if (/\b(?:hdrip)\b/i.test(rawString)) return "HDRip";

    // If no source is found but it says Remux, label it Remux
    return isRemux ? "Remux" : null;
}

// Audio formats
const audioTypes = [
    'truehd', 'atmos', 'dts-hd', 'dts:x', 'flac',
    'dd+', 'e-ac3', 'eac3', 'ac3', 'dts',
    'dolby digital', 'aac'
];

function extractAudioCodec(rawString) {
    const foundAudio = new Set();

    audioTypes.forEach(audio => {
        // Escape special characters like + or . in the audio name
        const escapedAudio = audio.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

        // This regex ensures we match exactly the audio string and not partial words
        const audioRegex = new RegExp(`(?:^|\\W|_)${escapedAudio}(?:$|\\W|_)`, 'i');

        if (audioRegex.test(rawString)) {
            foundAudio.add(audio);
        }
    });

    return foundAudio.size > 0 ? Array.from(foundAudio) : null;
}