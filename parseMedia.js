// Alias the imports so PTT and Anitomy don't fight over the word "parse"
import { parse as pttParse } from './ptt.js';
import { parse as anitomyParse } from 'https://esm.sh/anitomy';

// ==========================================
// 1. THE TRAFFIC COP (Router) WITH DIAGNOSTICS
// ==========================================
export function parseMediaData(rawString, knownType = 'unknown') {
    let mediaType = knownType;

    if (mediaType === 'unknown') {
        const hasWesternSeason = /[sS]\d{1,2}[eE]\d{1,2}/.test(rawString);
        const hasWesternMovie = /\b(19|20)\d{2}\b[\.\s\[\-]*(1080p|720p|2160p|4k|bluray|web-dl)/i.test(rawString);

        const hasAnimeBrackets = /^\[.*?\]/.test(rawString.trim());
        const hasCrc32 = /\[[a-f0-9]{8}\]/i.test(rawString);
        const hasAnimeVocab = /\b(ova|oad|ncop|nced|dual audio|bdrip)\b/i.test(rawString);

        const hasAnimeEpisode = /\s-\s\d{2,4}(?:[\s\[\(]|$)/.test(rawString); 
        const hasLooseEpNumber = /\bepisode\s*\d+\b/i.test(rawString);

        if (hasWesternSeason || hasWesternMovie) {
            mediaType = 'western';
        } else if (hasAnimeBrackets || hasCrc32 || hasAnimeVocab || hasAnimeEpisode || hasLooseEpNumber) {
            mediaType = 'anime';
        } else {
            mediaType = 'western';
        }
    }

    if (mediaType === 'anime') {
        return parseAnime(rawString);
    } else {
        return parseWestern(rawString);
    }
}

// ==========================================
// 2. THE WESTERN PARSER (For TV & Movies)
// ==========================================
function parseWestern(rawString, fallbackTitle = null) {
    let cleanName = rawString;

    let yearMatch = cleanName.match(/[\(\[](\d{4})[\)\]]/);
    let year = yearMatch ? yearMatch[1] : null;

    cleanName = cleanName.replace(/([sS]\d{1,2}[eE]\d{1,2})\s*-\s*[eE]?(\d{1,2})/g, '$1-$2');

    const dateMatch = cleanName.match(/(\d{4})[\.\- ](\d{2})[\.\- ](\d{2})/);
    let airDate = null;
    if (dateMatch) {
        airDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
        cleanName = cleanName.replace(/(\d{4})[\.\- ](\d{2})[\.\- ](\d{2})/, '');
    }

    cleanName = cleanName.replace(/\bcomplete\s*(series|season)?\b/ig, '');
    cleanName = cleanName.replace(/seasons?\s*\d+\s*-\s*\d+/ig, '');
    cleanName = cleanName.replace(/[\._]/g, ' ').trim();

    // Uses PTT for Western shows
    const parsed = pttParse(cleanName);
    let finalTitle = parsed.title || fallbackTitle || cleanName;

    finalTitle = finalTitle.replace(/(^|\s)[sS]\d+[eE]\d+.*$/i, '');
    finalTitle = finalTitle.replace(/\s\d{4}$/, '');
    finalTitle = finalTitle.replace(/[\(\[].*?[\)\]]/g, '');
    finalTitle = finalTitle.replace(/[\s\-\.]+$/, '').trim();

    if (!finalTitle && fallbackTitle) finalTitle = fallbackTitle;

    return {
        ...parsed,
        title: finalTitle,
        year: parsed.year || year || '',
        airDate: airDate, 
        resolution: parsed.resolution || 'HD',
        isComplete: rawString.toLowerCase().includes('complete'),
        isSpecial: false,
        mediaType: 'western' 
    };
}

export function parseAnime(rawString, fallbackTitle = null) {
    const fileNameOnly = rawString.split(/[/\\]/).pop();
    const cleanString = fileNameOnly.replace(/\[\s*(www\.)?[a-zA-Z0-9-]+\.(com|si|net|org|to|ru)[^\]]*\]\s*/gi, "");

    const parsed = anitomyParse(cleanString);

    // 1. Map the nested title 
    let finalTitle = parsed.title || fallbackTitle || cleanString;

    const rawStringL = rawString.toLowerCase();

    const folderSeasonMatch = rawString.match(/[sS]eason\s*(\d+)/);
    const folderSeason = folderSeasonMatch ? parseInt(folderSeasonMatch[1], 10) : null;

    // 3. Map the nested properties using optional chaining (?.)
    const anitomyData = {
        title: finalTitle,
        year: parsed.year || '',
        season: parseInt(parsed.season, 10) || folderSeason || 1, 
        episode: parsed.episode?.number || parsed.episodeNumber || parsed.episode_number || null,
        resolution: parsed.video?.resolution || parsed.videoResolution || parsed.video_resolution || 'HD',
        fileType: parsed.type || "anime"
    };
    
    return anitomyData;
}