/**
 * ==========================================
 * picker.js
 * Handles the Season/Episode UI Modal and Metadata Merging
 * ==========================================
 */

import { appState, showToast } from '../services/config.js';
import { parseMediaData, customParser } from '../utils/parseMedia.js';

import { startQueue, addToQueue } from '../streaming/playlist.js';

import { fetchAnimeMapping } from '../api.js';
import {
    fetchMediaMetadata, formatMediaMetadata,
    getTmdbId,
    getTmdbSeasonEpisodes
} from './metadata.js';

import { fetchWatchProgress } from '../user-data/watch-history.js';

//#region Open Logic
let pickerGeneration = 0;

export async function openPicker(libraryData, tmdbId, title) {
    const generation = ++pickerGeneration;
    const userId = appState.currentUser?.id;

    const picker = document.getElementById('file-picker');
    const list = document.getElementById('picker-list');
    const sourceContainer = document.getElementById('library-torrent-select');
    sourceContainer.replaceChildren();
    sourceContainer.classList.add('hidden');
    renderPickerSourceBadges(null);

    const torrents = libraryData?.torrents || [];

    const cloudEpisodes = libraryData?.sourceEpisodes;
    const localEpisodes = libraryData?.savedEpisodes;

    picker.classList.remove('hidden');
    list.innerHTML = `<div class="col-span-full flex justify-center p-10">...Loading Spinner...</div>`;

    const id = libraryData.savedId || libraryData.tmdbId || tmdbId;
    if (!id) {
        renderPickerUI(buildRawPickerData(torrents, title || torrents[0]?.name || 'Files'), list, null);
        return;
    }

    const cleanName = title || (torrents[0]?.name ? parseMediaData(torrents[0].name).title : null) || 'Episodes';

    const watchProgress = await fetchWatchProgress(tmdbId, userId);

    // Basic Metadata
    const mediaMetadata = await fetchMediaMetadata(id, libraryData.baseUrl, libraryData.type);
    const formattedMetadata = formatMediaMetadata(mediaMetadata);

    let seasonData = {};
    if(!libraryData.baseUrl) {
        seasonData = formattedMetadata;
    } else {
        const tmdbMediaData = await fetchMediaMetadata(tmdbId, null, libraryData.type);
        seasonData = formatMediaMetadata(tmdbMediaData)
    }

    
    const torrentGroups = await buildTorrentGroups(torrents);
    
    const urlEpisodes = { ...cloudEpisodes, ...localEpisodes };
    const urlGroups = buildUrlGroups(urlEpisodes, libraryData.type, cleanName, formattedMetadata?.poster);

    let groups = await loadEpisodeGroups(mergePickerGroups(torrentGroups, urlGroups), seasonData);
    groups.savedId = id;

    if (generation !== pickerGeneration) return;
    if (userId !== appState.currentUser?.id) return;

    const normalizedGroups = normalizePickerGroups(groups);
    console.log(normalizedGroups);

    const fallbackImage = torrents.map(torrent => document.getElementById(`img-${torrent.id}`)?.src).find(Boolean) || '';
    const pickerData = preparePickerGroups(normalizedGroups, { title: cleanName, tmdbId, fallbackImage, watchProgress });

    renderPickerUI(pickerData, list, formattedMetadata);
}

export function closePicker() {
    pickerGeneration++;
    closeEpisodeMenus();
    pickerHeaderListeners?.abort();
    document.getElementById('file-picker').classList.add('hidden');
}
//#endregion

//#region Data Grouping
// Unidentified downloads use file identities and original names without metadata matching.
function buildRawPickerData(torrents, title) {
    const groups = torrents.map((torrent, index) => ({
        key: `files-${index}`,
        sourceKey: getTorrentKey(torrent),
        title: torrents.length > 1 ? torrent.name : 'Files',
        fileType: 'File',
        episodes: (torrent.files || [])
            .filter(file => /\.(mkv|mp4|avi|mov)$/i.test(file.name))
            .map(file => ({
                tid: torrent.id,
                fid: file.id,
                hash: torrent.hash,
                torboxType: torrent.torboxType === 'usenet' ? 'usenet' : 'torrent',
                sourceType: 'torrent',
                tmdbId: null,
                mediaType: null,
                seasonNumber: null,
                episodeNumber: null,
                watchEpisodeNumber: null,
                seriesTitle: title,
                season: 'Files',
                fileType: 'File',
                title: file.short_name || file.name,
                fileName: file.name,
                torrentName: torrent.name,
                thumbnail: '',
                size: Number.isFinite(file.size) ? (file.size / 1073741824).toFixed(2) + ' GB' : '',
                badge: '',
                badgeColor: 'bg-blue-600',
                isExtended: false,
                isWatched: false,
                progressInSeconds: 0,
                progressPercent: null,
                canDownload: true
            }))
    })).filter(group => group.episodes.length > 0);

    const episodes = groups.flatMap(group => group.episodes);
    const sources = new Map(torrents.map(torrent => [getTorrentKey(torrent), torrent]));
    const variants = { [MERGED_SOURCE]: { groups, episodes } };
    for (const group of groups) {
        if (!variants[group.sourceKey]) variants[group.sourceKey] = { groups: [], episodes: [] };
        variants[group.sourceKey].groups.push(group);
        variants[group.sourceKey].episodes.push(...group.episodes);
    }
    return {
        title,
        tmdbId: null,
        seasons: episodes.length ? [{
            key: 'files',
            label: 'Files',
            sourceSelector: createPickerSourceSelector(
                new Map([...sources].filter(([key]) => variants[key])), 'Source for files'),
            variants
        }] : []
    };
}

const SWITCH_WORDS_REGEX = /(?:^|[\s._\-\[\]()])(MOVIE|OVA|OAD|ODA|ONA|SPECIAL|RECAP|SP|OPENING|NCOP|OP|ENDING|NCED|ED|THEME|PROMO|TEASER|TRAILER|PV|CM)(?:S?\d*[a-z]?)?(?=$|[\s._\-\[\]()])/i;
const EXTENDED_WORDS_REGEX = /(?:^|[\s._\-\[\]()])(EXTEND(?:ED)?(?:[\s._\-]+(?:EDITION|CUT|VERSION|VER))?|DIRECTOR'?S[\s._\-]+(?:EDITION|CUT|VERSION|VER)|UNCUT|UNRATED)(?=$|[\s._\-\[\]()])/i;
const MENU_WORDS_REGEX = /(?:^|[\s._\-\[\]()\\/])(?:BD|DVD|BLU[\s._-]*RAY|DISC|DISK)[\s._-]*MENUS?\d*(?=$|[\s._\-\[\]()\\/])/i;
const FILE_TYPE_LABELS = {
    MOVIE: 'Movie',
    OVA: 'Original Video Animation',
    OAD: 'Original Animation DVD',
    ODA: 'Original DVD Animation',
    ONA: 'Original Net Animation',
    SPECIAL: 'Special',
    RECAP: 'Recap',
    SP: 'Special',
    OPENING: 'Opening',
    NCOP: 'Opening',
    OP: 'Opening',
    ENDING: 'Ending',
    NCED: 'Ending',
    ED: 'Ending',
    THEME: 'Theme',
    PROMO: 'Promotional Video',
    TEASER: 'Teaser',
    TRAILER: 'Trailer',
    PV: 'Promotional Video',
    CM: 'Commercial'
};

function classifyFileType(fileName, episode, season) {
    const isExtended = EXTENDED_WORDS_REGEX.test(fileName);
    if (MENU_WORDS_REGEX.test(fileName)) {
        return { fileType: 'Trailer', fileTypeLabel: 'Menu', isExtended };
    }

    const match = fileName.match(SWITCH_WORDS_REGEX);
    const matchedWord = match ? match[1].toUpperCase()
        : episode == null && season == null ? 'MOVIE' : 'TV';
    const suffix = match
        ? match[0].replace(/^[\s._\-\[\]()]+|[\s._\-\[\]()]+$/g, '').toUpperCase()
            .slice(matchedWord.length).replace(/^S/, '')
        : '';
    const fileTypeLabel = match
        ? `${FILE_TYPE_LABELS[matchedWord] || matchedWord}${suffix ? ` ${suffix}` : ''}`
        : null;

    let fileType = 'TV';

    switch (matchedWord) {
        case 'MOVIE':
            fileType = 'Movie';
            break;
        case 'OVA':
        case 'OAD':
        case 'ODA':
        case 'ONA':
            fileType = 'OVA';
            break;
        case 'SPECIAL':
        case 'RECAP':
        case 'SP':
            fileType = 'Special';
            break;
        case 'OP':
        case 'OPENING':
        case 'NCOP':
        case 'ED':
        case 'ENDING':
        case 'NCED':
        case 'THEME':
            fileType = 'Theme';
            break;
        case 'PV':
        case 'PROMO':
        case 'TEASER':
        case 'CM':
        case 'TRAILER':
            fileType = 'Trailer';
            break;
        case 'TV':
        default:
            fileType = 'TV';
            break;
    }

    return { fileType, fileTypeLabel: fileTypeLabel || fileType, isExtended };
}

function mergePickerGroups(...groupSets) {
    const mergedGroups = {};
    for (const groups of groupSets) {
        for (const [key, group] of Object.entries(groups || {})) {
            if (!mergedGroups[key]) mergedGroups[key] = { ...group, files: [] };
            mergedGroups[key].files.push(...group.files.map(file => ({ ...file })));
            mergedGroups[key].episodeCount = mergedGroups[key].files.length;
        }
    }
    const seasons = [...new Map(Object.values(mergedGroups).map(group => [group.seasonKey, group])).values()]
        .sort((a, b) => a.seasonNumber != null && b.seasonNumber != null
            ? a.seasonNumber - b.seasonNumber
            : a.seasonLabel.localeCompare(b.seasonLabel, undefined, { numeric: true }));
    const seasonOrder = new Map(seasons.map((group, index) => [group.seasonKey, index + 1]));
    for (const group of Object.values(mergedGroups)) group.seasonOrder = seasonOrder.get(group.seasonKey);
    return mergedGroups;
}

// Give torrent and URL groups the same shape before preparePickerGroups.
// Preserve source references and metadata mappings without changing the input.
function normalizePickerGroups(groups = {}) {
    const normalized = {};
    if (groups?.savedId != null) normalized.savedId = groups.savedId;

    for (const [key, group] of Object.entries(groups || {})) {
        if (!group || !Array.isArray(group.files)) continue;

        const fileType = group.fileType ?? 'TV';
        const seasonLabel = group.seasonLabel ?? group.title ?? '';
        const tmdbSeason = group.tmdbSeason ?? group.seasonNumber ?? null;
        const files = group.files.map(file => {
            const sourceType = file.sourceType ?? (file.sourceUrl ? 'url'
                : file.sourceTorrent?.addonMedia ? 'addon' : 'torrent');
            const isUrl = sourceType === 'url';
            const itemFileType = file.fileType ?? fileType;

            return {
                originalFile: isUrl ? null : file.originalFile ?? null,
                sourceType,
                sourceUrl: isUrl ? file.sourceUrl ?? null : null,
                sourceTorrent: isUrl ? null : file.sourceTorrent ?? null,
                id: file.id ?? null,
                tmdbId: file.tmdbId ?? null,
                mediaType: file.mediaType ?? null,
                imdbId: file.imdbId ?? null,
                streamId: file.streamId ?? null,
                fileTitle: file.fileTitle ?? '',
                year: file.year ?? null,
                season: file.season ?? seasonLabel,
                tmdbSeason: file.tmdbSeason ?? tmdbSeason,
                episode: file.episode ?? null,
                relativeEpisode: file.relativeEpisode ?? null,
                watchSeason: file.watchSeason ?? null,
                watchEpisode: file.watchEpisode ?? null,
                displayTitle: file.displayTitle ?? null,
                displayThumbnail: file.displayThumbnail ?? null,
                fileType: itemFileType,
                fileTypeLabel: file.fileTypeLabel ?? itemFileType,
                isExtended: Boolean(file.isExtended),
                isExtra: Boolean(file.isExtra ?? (itemFileType === 'Trailer')),
                sizeMB: file.sizeMB ?? null
            };
        });

        normalized[key] = {
            title: group.title ?? seasonLabel,
            seasonLabel,
            seasonKey: group.seasonKey ?? key,
            seasonNumber: group.seasonNumber ?? null,
            seasonOrder: group.seasonOrder ?? 0,
            tmdbSeason,
            fileType,
            files,
            episodeCount: files.length
        };
    }

    return normalized;
}

//#region Process Groups
// Movie URL keys are TMDB IDs; series URL keys are "season:episode".
function buildUrlGroups(urlEpisodes = {}, mediaType = 'tv', title = '', poster = '') {
    const urlGroups = {};
    const isMovie = mediaType === 'movie';

    for (const [episodeKey, url] of Object.entries(urlEpisodes || {})) {
        if (typeof url !== 'string' || !url.trim()) continue;
        let tmdbId = null;
        let seasonNumber = null;
        let episodeNumber = null;
        if (isMovie) {
            if (!/^\d+$/.test(episodeKey)) continue;
            tmdbId = Number(episodeKey);
            if (!Number.isSafeInteger(tmdbId) || tmdbId < 1) continue;
        } else {
            if (!/^\d+:\d+$/.test(episodeKey)) continue;
            [seasonNumber, episodeNumber] = episodeKey.split(':').map(Number);
            if (!Number.isSafeInteger(seasonNumber) || !Number.isSafeInteger(episodeNumber) || episodeNumber < 1) continue;
        }

        const fileType = isMovie ? 'Movie' : 'TV';
        const seasonKey = isMovie ? 'MOVIES' : `S_${seasonNumber}`;
        const groupKey = `${seasonKey}_${fileType}`;
        const seasonLabel = isMovie ? 'Movies' : `Season ${seasonNumber}`;
        if (!urlGroups[groupKey]) {
            urlGroups[groupKey] = {
                title: seasonLabel,
                seasonLabel,
                seasonKey,
                seasonNumber,
                seasonOrder: 0,
                tmdbSeason: seasonNumber,
                fileType,
                files: []
            };
        }

        urlGroups[groupKey].files.push({
            originalFile: null,
            fileTitle: isMovie ? title || `Movie ${tmdbId}` : `Episode ${episodeNumber}`,
            displayThumbnail: isMovie ? poster : null,
            year: null,
            tmdbId,
            mediaType: isMovie ? 'movie' : 'tv',
            sourceType: 'url',
            sourceUrl: url,
            sourceTorrent: null,
            season: seasonLabel,
            tmdbSeason: seasonNumber,
            episode: episodeNumber,
            fileType,
            fileTypeLabel: fileType,
            isExtended: false,
            isExtra: false,
            sizeMB: null
        });
    }

    const sortedGroups = Object.entries(urlGroups)
        .sort(([, a], [, b]) => a.seasonNumber - b.seasonNumber);
    sortedGroups.forEach(([, group], index) => {
        group.seasonOrder = index + 1;
        group.files.sort((a, b) => a.episode - b.episode);
        group.episodeCount = group.files.length;
    });

    return Object.fromEntries(sortedGroups);
}

async function preProcessEpisodeTorrentData(videoFiles, fallbackShowName = 'Season 1', fallbackSeason = null, movieLookups = new Map()) {
    const torrentGroups = {};
    const baseSeasonsMap = new Map();

    const groupLabels = {
        'TV': (label) => `${label}`,
        'Movie': (label) => `🎥 ${label} - Movies`,
        'OVA': (label) => `⭐ ${label} - OVAs`,
        'Special': (label) => `⭐ ${label} - Specials`,
        'Theme': (label) => `🎵 ${label} - Openings & Endings`,
        'Trailer': (label) => `🎬 ${label} - Trailers & Extras`
    };

    // Parse all files once before grouping
    const parsedEntries = videoFiles.map(file => {
        const fileName = file.short_name || file.name;
        const parsedFile = parseMediaData(fileName);
        const fullParsed = file.name && file.name !== fileName ? parseMediaData(file.name) : null;

        const rawSeason = parsedFile.seasons?.[0] ?? fullParsed?.seasons?.[0] ?? fallbackSeason;
        const fileEpisode = parsedFile.episodes?.[0] ?? fullParsed?.episodes?.[0];
        const { fileType, fileTypeLabel, isExtended } = classifyFileType(fileName, fileEpisode, rawSeason);

        // Extract clean season/show name if no season number exists
        let candidateTitle = (parsedFile.title || fullParsed?.title || fallbackShowName).trim();
        if (!candidateTitle || /^\d+$/.test(candidateTitle)) {
            candidateTitle = fallbackShowName;
        }

        return {
            file,
            fileName,
            parsedFile,
            year: parsedFile.year ?? fullParsed?.year ?? null,
            rawSeason,
            fileEpisode,
            fileType,
            fileTypeLabel,
            isExtended,
            candidateTitle,
            sizeInMB: file.size / (1024 * 1024)
        };
    });

    // Resolve each distinct movie title/year once before assigning its group.
    await Promise.all(parsedEntries.filter(entry => entry.fileType === 'Movie').map(async entry => {
        const key = JSON.stringify([entry.candidateTitle.toLowerCase(), entry.year]);
        if (!movieLookups.has(key)) {
            movieLookups.set(key, getTmdbId(entry.candidateTitle, entry.year, 'movie').catch(() => null));
        }
        const match = await movieLookups.get(key);
        if (Number.isSafeInteger(match?.id) && match.id > 0) {
            entry.tmdbId = match.id;
            entry.displayTitle = match.officialName || null;
            entry.fullTMDB = match.full;
        }
    }));

    // Detect if the torrent uses season numbers; if so, default any untagged files to Season 1
    const torrentHasSeasons = parsedEntries.some(
        entry => entry.rawSeason !== undefined && entry.rawSeason !== null
    );

    if (torrentHasSeasons) {
        parsedEntries.forEach(entry => {
            if (entry.rawSeason === undefined || entry.rawSeason === null) {
                entry.rawSeason = 1;
            }
        });
    }

    // PASS 1: Only main episodes ('TV') can create base season folders
    parsedEntries.forEach(entry => {
        if (entry.fileType !== 'TV') return;

        if (entry.rawSeason !== undefined && entry.rawSeason !== null) {
            const seasonNum = Number(entry.rawSeason);
            const seasonKey = `S_${seasonNum}`;
            if (!baseSeasonsMap.has(seasonKey)) {
                baseSeasonsMap.set(seasonKey, {
                    key: seasonKey,
                    label: `Season ${seasonNum}`,
                    seasonNumber: seasonNum,
                    matchName: null
                });
            }
        } else {
            const normalizedName = entry.candidateTitle.toLowerCase();
            const seasonKey = `NAME_${normalizedName}`;
            if (!baseSeasonsMap.has(seasonKey)) {
                baseSeasonsMap.set(seasonKey, {
                    key: seasonKey,
                    label: entry.candidateTitle,
                    seasonNumber: null,
                    matchName: normalizedName
                });
            }
        }
    });

    // Fallback if the torrent has no 'TV' episodes at all
    if (baseSeasonsMap.size === 0) {
        const explicitSeasons = [...new Set(parsedEntries.map(entry => entry.rawSeason).filter(season => season != null))];
        if (explicitSeasons.length > 0) {
            for (const season of explicitSeasons) {
                const seasonNum = Number(season);
                const key = `S_${seasonNum}`;
                baseSeasonsMap.set(key, { key, label: `Season ${seasonNum}`, seasonNumber: seasonNum, matchName: null });
            }
        } else {
            const defaultKey = `NAME_${fallbackShowName.toLowerCase()}`;
            baseSeasonsMap.set(defaultKey, {
                key: defaultKey,
                label: fallbackShowName,
                seasonNumber: 1,
                matchName: fallbackShowName.toLowerCase()
            });
        }
    }

    // Assign sequential order and inferred TMDB season numbers for named seasons
    const baseSeasonsList = Array.from(baseSeasonsMap.values()).sort((a, b) => {
        if (a.seasonNumber !== null && b.seasonNumber !== null) {
            return a.seasonNumber - b.seasonNumber;
        }
        return a.label.localeCompare(b.label, undefined, { numeric: true });
    });

    baseSeasonsList.forEach((seasonObj, idx) => {
        seasonObj.order = idx + 1;
        seasonObj.tmdbSeasonNumber = seasonObj.seasonNumber ?? (idx + 1);
    });

    // Sort named seasons by longest label first so "Mob Psycho 100 III" matches before "Mob Psycho 100"
    const seasonsByLengthDesc = [...baseSeasonsList].sort((a, b) => b.label.length - a.label.length);

    // PASS 2: Assign every file to a registered base season and pack by (baseSeason + fileType)
    parsedEntries.forEach(entry => {
        let targetSeason = null;

        if (entry.fileType === 'TV') {
            const lookupKey = (entry.rawSeason !== undefined && entry.rawSeason !== null)
                ? `S_${Number(entry.rawSeason)}`
                : `NAME_${entry.candidateTitle.toLowerCase()}`;
            targetSeason = baseSeasonsMap.get(lookupKey);
        } else {
            if (entry.rawSeason !== undefined && entry.rawSeason !== null) {
                targetSeason = baseSeasonsMap.get(`S_${Number(entry.rawSeason)}`);
            }

            if (!targetSeason) {
                const searchSource = `${entry.candidateTitle} ${entry.fileName} ${entry.file.name}`.toLowerCase();
                targetSeason = seasonsByLengthDesc.find(
                    s => s.matchName && searchSource.includes(s.matchName)
                );
            }

            if (!targetSeason) {
                targetSeason = baseSeasonsList[0];
            }
        }

        const groupKey = `${targetSeason.key}_${entry.fileType}`;

        if (!torrentGroups[groupKey]) {
            torrentGroups[groupKey] = {
                title: groupLabels[entry.fileType]
                    ? groupLabels[entry.fileType](targetSeason.label)
                    : `${targetSeason.label} - ${entry.fileType}`,
                seasonLabel: targetSeason.label,
                seasonKey: targetSeason.key,
                seasonNumber: targetSeason.seasonNumber,
                seasonOrder: targetSeason.order,
                tmdbSeason: targetSeason.tmdbSeasonNumber,
                fileType: entry.fileType,
                files: []
            };
        }

        torrentGroups[groupKey].files.push({
            originalFile: entry.file,
            fileTitle: entry.parsedFile.title,
            year: entry.year,
            tmdbId: entry.tmdbId ?? null,
            mediaType: entry.fileType === 'Movie' ? 'movie' : null,
            displayTitle: entry.displayTitle ?? null,
            displayThumbnail: entry.fullTMDB?.poster_path
                ? `https://image.tmdb.org/t/p/w500${entry.fullTMDB.poster_path}` : null,
            season: targetSeason.label,
            tmdbSeason: targetSeason.tmdbSeasonNumber,
            episode: entry.fileEpisode,
            fileType: entry.fileType,
            fileTypeLabel: entry.fileTypeLabel,
            isExtended: entry.isExtended,
            isExtra: entry.fileType === 'Trailer',
            sizeMB: entry.sizeInMB.toFixed(2)
        });
    });

    for (const group of Object.values(torrentGroups)) {
        group.episodeCount = group.files.length;
    }

    return torrentGroups;
}

function getTorrentKey(torrent) {
    return `${torrent.hash ? `hash:${String(torrent.hash).toLowerCase()}` : `id:${torrent.id}`}`;
}

async function buildTorrentGroups(torrents = []) {
    const parsedTorrentGroups = {};
    const seenTorrents = new Set();
    const movieLookups = new Map();

    for (const torrent of torrents || []) {
        const sourceKey = getTorrentKey(torrent);
        if (seenTorrents.has(sourceKey)) continue;
        seenTorrents.add(sourceKey);

        const videoFiles = (torrent.files || []).filter(file => /\.(mkv|mp4|avi|mov)$/i.test(file.name));
        const baseInfo = parseMediaData(torrent.name);
        const fallbackSeason = baseInfo.seasons?.length === 1 ? baseInfo.seasons[0] : null;
        const sourceGroups = await preProcessEpisodeTorrentData(videoFiles, baseInfo.title, fallbackSeason, movieLookups);

        // Parse each source in its own context before combining matching seasons.
        for (const [key, group] of Object.entries(sourceGroups)) {
            if (!parsedTorrentGroups[key]) parsedTorrentGroups[key] = { ...group, files: [] };

            parsedTorrentGroups[key].files.push(...group.files.map(file => ({
                ...file,
                sourceType: torrent.addonMedia ? 'addon' : 'torrent',
                sourceUrl: null,
                sourceTorrent: torrent,
            })));
            parsedTorrentGroups[key].episodeCount = parsedTorrentGroups[key].files.length;
        }
    }

    const seasons = [...new Map(Object.values(parsedTorrentGroups).map(group => [group.seasonKey, group])).values()]
        .sort((a, b) => a.seasonNumber != null && b.seasonNumber != null
            ? a.seasonNumber - b.seasonNumber
            : a.seasonLabel.localeCompare(b.seasonLabel, undefined, { numeric: true }));
    const seasonOrder = new Map(seasons.map((group, index) => [group.seasonKey, index + 1]));
    for (const group of Object.values(parsedTorrentGroups)) {
        group.seasonOrder = seasonOrder.get(group.seasonKey);
    }

    return parsedTorrentGroups;
}
//#endregion

// Preserve every source when torrent and URL groups contain the same season.


const MERGED_SOURCE = 'merged';

function createPickerSourceSelector(sources, label) {
    if (!sources.size) return null;
    const labels = [...sources.values()].map(source => {
        const size = Number.isFinite(source.size) ? ` · ${(source.size / 1073741824).toFixed(1)} GB` : '';
        return `${source.name || 'Torrent'}${size}`;
    });

    const badges = {
        id: 'library-torrent-select',
        label,
        value: sources.size === 1 ? sources.keys().next().value : MERGED_SOURCE,
        options: [
            ...(sources.size > 1 ? [{ value: MERGED_SOURCE, label: 'All sources (merged)', sourceData: null }] : []),
            ...[...sources].map(([sourceKey, source], index) => ({
                value: sourceKey,
                label: labels.indexOf(labels[index]) !== labels.lastIndexOf(labels[index])
                    ? `${labels[index]} — Source ${index + 1}` : labels[index],
                sourceData: source.sourceType === 'url' || !source.name ? null : customParser(source.name)
            }))
        ]
    };
    console.log(badges);
    return badges;
}

function pickerEpisodeNumber(file) {
    const value = file.relativeEpisode ?? file.episode;
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

function comparePickerSources(a, b) {
    const libraryDateA = Date.parse(a?.libraryAddedAt);
    const libraryDateB = Date.parse(b?.libraryAddedAt);
    if (Number.isFinite(libraryDateA) && Number.isFinite(libraryDateB) && libraryDateA !== libraryDateB) {
        return libraryDateA - libraryDateB;
    }
    if (Number.isFinite(a?.librarySourceOrder) || Number.isFinite(b?.librarySourceOrder)) {
        return (a?.librarySourceOrder || 0) - (b?.librarySourceOrder || 0);
    }
    const dateA = Date.parse(a?.created_at);
    const dateB = Date.parse(b?.created_at);
    return (Number.isFinite(dateA) ? dateA : 0) - (Number.isFinite(dateB) ? dateB : 0);
}

function duplicateEpisodeNumber(file) {
    // Openings, endings, trailers and movies have their own labels, not episode badges.
    if (['Theme', 'Trailer', 'Movie'].includes(file.fileType)) return null;
    return pickerEpisodeNumber(file);
}

function uniquePickerFiles(files) {
    const unique = new Map();
    for (const file of files) {
        const source = file.sourceType === 'url' ? null : file.sourceTorrent;
        const episode = duplicateEpisodeNumber(file);
        const sourceKey = file.sourceType === 'url' ? 'url' : getTorrentKey(source);
        const key = episode == null
            ? `file:${sourceKey}:${file.originalFile?.id ?? file.originalFile?.name ?? file.sourceUrl}`
            : `episode:${episode}`;
        const previous = unique.get(key);
        if (!previous || comparePickerSources(source, previous.sourceTorrent) >= 0) unique.set(key, file);
    }
    return [...unique.values()].sort((a, b) => {
        const numberA = pickerEpisodeNumber(a);
        const numberB = pickerEpisodeNumber(b);
        if (numberA == null && numberB == null) {
            return (a.originalFile?.name || a.fileTitle || '').localeCompare(b.originalFile?.name || b.fileTitle || '');
        }
        if (numberA == null) return 1;
        if (numberB == null) return -1;
        return numberA - numberB;
    });
}

function preparePickerGroups(franchiseGroups, { title: cleanName = '', tmdbId = null, fallbackImage = '', watchProgress = null } = {}) {
    const typePriority = {
        'TV': 1,
        'Movie': 2,
        'OVA': 3,
        'Special': 4,
        'Theme': 5,
        'Trailer': 6
    };

    // In-Season groups not linked to the tab
    const sortedGroupKeys = Object.keys(franchiseGroups)
        .filter(key => key !== 'savedId')
        .sort((keyA, keyB) => {
            const groupA = franchiseGroups[keyA];
            const groupB = franchiseGroups[keyB];
            const typeDiff = (typePriority[groupA.fileType] || 99) - (typePriority[groupB.fileType] || 99);
            if (typeDiff !== 0) return typeDiff;
            return (groupA.seasonOrder || 0) - (groupB.seasonOrder || 0);
        });

    // Merge distinct episodes by default and retain each source as an alternative.
    const seasonsByKey = new Map();
    const seasonSources = new Map();
    const watchedCounts = watchProgress?.watched_counts || {};
    const position = Number(watchProgress?.position_seconds);
    const duration = Number(watchProgress?.duration_seconds);
    const progressPercent = Number.isFinite(position) && Number.isFinite(duration) && duration > 0
        ? Math.max(0, Math.min(position / duration * 100, 100)) : null;

    sortedGroupKeys.forEach(key => {
        const groupData = franchiseGroups[key];
        if (!seasonsByKey.has(groupData.seasonKey)) {
            seasonsByKey.set(groupData.seasonKey, {
                key: groupData.seasonKey,
                label: groupData.seasonLabel,
                seasonNumber: groupData.seasonNumber,
                order: groupData.seasonOrder,
                variants: {}
            });
        }

        const season = seasonsByKey.get(groupData.seasonKey);
        const variants = new Map();
        if (!seasonSources.has(groupData.seasonKey)) seasonSources.set(groupData.seasonKey, new Map());
        const sources = seasonSources.get(groupData.seasonKey);

        for (const file of groupData.files || []) {
            const source = file.sourceType === 'url' ? { sourceType: 'url', name: 'Saved URLs' }
                : file.sourceTorrent;



            const sourceKey = file.sourceType === 'url' ? 'url' : getTorrentKey(source);
            if (!variants.has(sourceKey)) variants.set(sourceKey, []);
            variants.get(sourceKey).push(file);
            sources.set(sourceKey, source);
        }
        variants.set(MERGED_SOURCE, groupData.files || []);

        for (const [sourceKey, files] of variants) {
            const sortedFiles = uniquePickerFiles(files);
            let nextEpisode = Math.max(0, ...sortedFiles.map(file => pickerEpisodeNumber(file) ?? 0)) + 1;

            const episodes = sortedFiles.map(fileObj => {
                const { originalFile, displayTitle, displayThumbnail, fileType, fileTypeLabel, isExtra, isExtended } = fileObj;
                const isUrl = fileObj.sourceType === 'url';
                const sourceTorrent = isUrl ? null : fileObj.sourceTorrent;

                const isThemeFile = fileType === 'Theme';
                const isOvaFile = fileType === 'OVA' || fileType === 'Special';
                const isMovieFile = fileType === 'Movie';
                const displayEpisode = pickerEpisodeNumber(fileObj) ?? nextEpisode++;

                const finalCardTitle = displayTitle || originalFile?.short_name || originalFile?.name.split(/[\\/]/).at(-1)
                    || fileObj.fileTitle || `Episode ${displayEpisode}`;
                const badgeText = isThemeFile
                    ? `🎵 ${fileTypeLabel || 'Theme'}`
                    : isExtra
                        ? `🎬 ${fileTypeLabel || 'Trailer'}`
                        : isOvaFile
                            ? `⭐ ${fileTypeLabel || fileType}`
                            : isMovieFile
                                ? `🎥 ${fileTypeLabel || 'Movie'}`
                                : `Episode ${displayEpisode}`;

                const fileSize = isUrl || sourceTorrent?.addonMedia || !Number.isFinite(originalFile?.size)
                    ? '' : (originalFile.size / 1073741824).toFixed(2) + ' GB';
                const cardImage = displayThumbnail || fallbackImage;
                const episodeTmdbId = fileObj.tmdbId ?? (fileType === 'TV' ? tmdbId : null);
                const seasonNumber = isMovieFile ? null : fileObj.watchSeason ?? fileObj.tmdbSeason;
                const watchEpisodeNumber = isMovieFile ? null : fileObj.watchEpisode ?? displayEpisode;
                const episodeKey = `${seasonNumber}:${watchEpisodeNumber}`;

                const episodeData = {
                    savedId: franchiseGroups.savedId,
                    id: fileObj.id ?? (isMovieFile && episodeTmdbId != null ? `tmdb:${episodeTmdbId}` : null),
                    tid: sourceTorrent?.id ?? null,
                    torboxType: sourceTorrent?.torboxType === 'usenet' ? 'usenet' : 'torrent',
                    fid: originalFile?.id ?? null,
                    hash: sourceTorrent?.hash ?? null,
                    tmdbId: episodeTmdbId,
                    imdbId: fileObj.imdbId ?? null,
                    mediaType: fileObj.mediaType ?? (isMovieFile ? 'movie' : 'tv'),
                    seasonNumber,
                    watchEpisodeNumber,
                    seriesTitle: cleanName,
                    season: groupData.title,
                    fileType: groupData.fileType,
                    isExtended,
                    isExtra,
                    episodeNumber: isMovieFile ? null : displayEpisode,
                    badge: badgeText,
                    badgeColor: isExtra ? 'bg-emerald-600'
                        : isOvaFile ? 'bg-amber-600' : isThemeFile ? 'bg-purple-600' : 'bg-blue-600',
                    title: finalCardTitle,
                    fileName: originalFile?.name || finalCardTitle,
                    torrentName: sourceTorrent?.name || cleanName,
                    thumbnail: cardImage,
                    size: fileSize,
                    progressInSeconds: episodeTmdbId != null && watchProgress?.current_episode === episodeKey
                        ? position : 0,
                    watchedCounts: Number(watchedCounts[episodeKey]) || 0,
                    isWatched: episodeTmdbId != null && Number(watchedCounts[episodeKey]) > 0,
                    progressPercent: episodeTmdbId != null && watchProgress?.current_episode === episodeKey
                        ? progressPercent : null,
                    canDownload: !isUrl,
                    sourceType: 'torrent',
                    ...(isUrl ? { sourceType: 'url', sourceUrl: fileObj.sourceUrl } : {}),
                    ...(sourceTorrent?.addonMedia ? {
                        sourceType: 'addon', sourceMediaId: String(sourceTorrent.addonMedia.id),
                        sourceHashes: sourceTorrent.addonSources.map(source => source.hash).filter(Boolean),
                        streamId: fileObj.streamId || String(sourceTorrent.addonMedia.streamId)
                    } : {})
                };

                return episodeData;
            });

            if (!season.variants[sourceKey]) season.variants[sourceKey] = { groups: [], episodes: [] };
            season.variants[sourceKey].groups.push({ key, title: groupData.title, fileType: groupData.fileType, episodes });
            season.variants[sourceKey].episodes.push(...episodes);
        }
    });

    const seasons = [...seasonsByKey.values()].sort((a, b) => a.order - b.order);
    for (const season of seasons) {
        const sources = seasonSources.get(season.key);
        season.sourceSelector = createPickerSourceSelector(sources, `Source for ${season.label}`);
        season.groups = season.variants[MERGED_SOURCE].groups;
        season.episodes = season.variants[MERGED_SOURCE].episodes;
    }

    return { title: cleanName, tmdbId, seasons };
}

async function loadEpisodeGroups(franchiseGroups, formattedMedia) {
    const tmdbId = formattedMedia?.tmdbId;

    if (tmdbId && formattedMedia.type === 'movie' && formattedMedia.imdbId) {
        for (const group of Object.values(franchiseGroups)) {
            if (group.fileType !== 'Movie') continue;
            for (const file of group.files) {
                if (String(file.tmdbId) === String(tmdbId)) {
                    file.imdbId ??= formattedMedia.imdbId;
                }
            }
        }
    }

    // We only process TMDB metadata if we have a valid ID
    if (tmdbId && Object.values(franchiseGroups).some(group => group.files?.length && group.fileType !== 'Movie')) {
        const tmdbSeasons = formattedMedia.raw?.seasons;

        if (Array.isArray(tmdbSeasons)) {
            const showBackdrop = formattedMedia.backdrop || null;

            const seasonCache = {};
            const aniZipCache = {};
            const animeData = await fetchAnimeMapping(tmdbId);
            const rawMatches = animeData?.data?.matches || animeData?.matches;
            const matches = Array.isArray(rawMatches) ? rawMatches : [];
            const imdbId = formattedMedia.imdbId || null;
            const getMediaId = (season, episode) => {
                const seasonMappings = matches
                    .filter(match => match.kitsu_id && (match.season?.tmdb ?? 1) === season)
                    .sort((a, b) => (b.episode_offset?.tmdb ?? 0) - (a.episode_offset?.tmdb ?? 0));
                const mapping = seasonMappings.find(match => episode > (match.episode_offset?.tmdb ?? 0))
                    || seasonMappings[seasonMappings.length - 1];
                return mapping ? `kitsu:${mapping.kitsu_id}` : imdbId;
            };

            for (const groupKey in franchiseGroups) {
                const group = franchiseGroups[groupKey];
                if (group.fileType === 'Movie') continue;
                if (group.fileType !== 'TV') {
                    for (const file of group.files) {
                        file.id = getMediaId(file.tmdbSeason ?? group.tmdbSeason, parseInt(file.episode));
                        file.displayThumbnail = showBackdrop;
                    }
                    continue;
                }

                const tmdbSeasonObj = tmdbSeasons.find(
                    s => s.season_number === group.tmdbSeason && s.episode_count > 0
                );
                const tmdbHasSeason = Boolean(tmdbSeasonObj);

                let aniZipData = null;

                // Test and fetch Anime data
                if (matches.length > 0) {
                    const matchedSeason = matches.find(
                        m => m.season?.tvdb === group.tmdbSeason || m.season?.tmdb === group.tmdbSeason
                    ) || matches[group.seasonOrder - 1];

                    const anilistId = matchedSeason?.anilist_id;
                    if (anilistId) {
                        if (!aniZipCache[anilistId]) {
                            const res = await fetch(`https://api.ani.zip/mappings?anilist_id=${anilistId}`);
                            aniZipCache[anilistId] = await res.json();
                        }
                        aniZipData = aniZipCache[anilistId];
                    }

                }

                for (const file of group.files) {
                    let fetchSeason = file.tmdbSeason;
                    let targetEp = parseInt(file.episode);
                    let badgeEp = targetEp;
                    let isSplitOverflow = false;

                    if (!tmdbHasSeason && file.sourceType !== 'url') {
                        // CASE 1: Packed Season — TMDB doesn't have this season, use AniZip only
                        const aniEp = aniZipData?.episodes?.[targetEp];
                        if (aniEp?.absoluteEpisodeNumber) {
                            const tmdbMapped = mapAbsoluteToTmdbRelative(
                                aniEp.absoluteEpisodeNumber,
                                tmdbSeasons
                            );

                            if (tmdbMapped) {
                                fetchSeason = tmdbMapped.targetSeason;
                                targetEp = tmdbMapped.relativeEp;
                                badgeEp = aniEp.episodeNumber ?? badgeEp;
                            }
                        }
                    } else if (file.sourceType !== 'url' && tmdbSeasonObj && targetEp > tmdbSeasonObj.episode_count) {
                        // CASE 2: Split Season — TMDB has the season, but split it into later seasons (e.g., HxH)
                        const startsRelative = group.files.some(f =>
                            f.sourceTorrent === file.sourceTorrent && parseInt(f.episode) === 1);
                        const priorEpisodesOffset = startsRelative
                            ? tmdbSeasons
                                .filter(s => s.season_number > 0 && s.season_number < group.tmdbSeason)
                                .reduce((sum, s) => sum + s.episode_count, 0)
                            : 0;

                        const tmdbMapped = mapAbsoluteToTmdbRelative(
                            priorEpisodesOffset + targetEp,
                            tmdbSeasons
                        );

                        if (tmdbMapped) {
                            fetchSeason = tmdbMapped.targetSeason;
                            targetEp = tmdbMapped.relativeEp;
                            isSplitOverflow = true;
                        }
                    }

                    file.id = getMediaId(fetchSeason, targetEp);

                    if (!seasonCache[fetchSeason]) {
                        seasonCache[fetchSeason] = (await getTmdbSeasonEpisodes(tmdbId, fetchSeason)) || [];
                    }

                    // Packed & normal seasons match strictly on `targetEp` (e.g. Ep 13);
                    // only split-season overflows fall back to `badgeEp` (e.g. Ep 63)
                    const tmdbEpData = seasonCache[fetchSeason].find(ep =>
                        isSplitOverflow
                            ? (ep.episode_number === targetEp || ep.episode_number === badgeEp)
                            : ep.episode_number === targetEp
                    );

                    if (tmdbEpData) {
                        file.watchSeason = fetchSeason;
                        file.watchEpisode = tmdbEpData.episode_number;
                        file.displayTitle = tmdbEpData.name;
                        file.displayThumbnail = tmdbEpData.still_path
                            ? `https://image.tmdb.org/t/p/w500${tmdbEpData.still_path}`
                            : showBackdrop;
                        file.relativeEpisode = badgeEp;
                    } else if (showBackdrop) {
                        file.displayThumbnail = showBackdrop;
                    }
                }
            }
        }
    }

    return franchiseGroups;
}

function mapAbsoluteToTmdbRelative(absoluteEp, tmdbSeasons) {
    const normalSeasons = tmdbSeasons
        .filter(s => s.season_number > 0)
        .sort((a, b) => a.season_number - b.season_number);

    let epCounter = 0;
    for (const season of normalSeasons) {
        if (absoluteEp <= epCounter + season.episode_count) {
            return {
                targetSeason: season.season_number,
                relativeEp: absoluteEp - epCounter
            };
        }
        epCounter += season.episode_count;
    }
    return null;
}
//#endregion

function closeEpisodeMenus() {
    document.querySelectorAll('#file-picker .picker-episode-menu:popover-open')
        .forEach(menu => menu.hidePopover());
}

//#region UI Rendering
function renderPickerSourceBadges(sourceData) {
    const container = document.getElementById('picker-source-details');
    const template = document.getElementById('picker-source-badge-template');
    container.replaceChildren();
    if (!sourceData) return;

    // Badge colors live here; each template exposes matching CSS variables.
    const fields = [
        ['resolution', '#93c5fd'],
        ['quality', '#67e8f9'],
        ['audio', '#6ee7b7'],
        ['codec', '#a5b4fc'],
        ['languages', '#f9a8d4']
    ];

    for (const [field, color] of fields) {
        const value = field === 'languages'
            ? (sourceData.languages?.length ? sourceData.languages : sourceData.languageTags)
            : sourceData[field];
        const values = Array.isArray(value) ? value : [value];
        for (const text of values) {
            if (typeof text !== 'string' || !text.trim()) continue;
            const badge = template.content.firstElementChild.cloneNode(true);
            badge.textContent = text;
            badge.dataset.field = field;
            badge.style.setProperty('--badge-color', color);
            badge.style.setProperty('--badge-bg', `${color}1a`);
            badge.style.setProperty('--badge-border', `${color}40`);
            container.appendChild(badge);
        }
    }
}

function renderPickerUI(pickerData, listElement, mediaMetadata) {
    const { title, seasons } = pickerData;
    const picker = document.getElementById('file-picker');
    const poster = picker.querySelector('#picker-poster');
    const backdrop = picker.querySelector('#picker-backdrop');
    const description = picker.querySelector('#picker-description');

    if (poster) {
        if (mediaMetadata?.poster) {
            poster.src = mediaMetadata.poster;
        } else {
            poster.removeAttribute('src');
        }
        poster.alt = `${mediaMetadata?.title || title || 'Media'} poster`;
    }
    if (backdrop) {
        if (mediaMetadata?.backdrop) {
            backdrop.src = mediaMetadata.backdrop;
        } else {
            backdrop.removeAttribute('src');
        }
    }
    if (description) {
        description.textContent = mediaMetadata?.description || 'No description available.';
    }

    const updateMetadataField = (selector, value) => {
        const element = picker.querySelector(selector);
        if (!element) return;
        element.textContent = value == null ? '' : String(value);
        element.classList.toggle('hidden', value == null || value === '');
    };
    updateMetadataField('#picker-rating', Number.isFinite(mediaMetadata?.rating)
        ? `${mediaMetadata.rating.toFixed(1)}` : '');
    updateMetadataField('#picker-year', mediaMetadata?.year);
    updateMetadataField('#picker-runtime', mediaMetadata?.runtime);
    updateMetadataField('#picker-cast', mediaMetadata?.cast?.length
        ? `Cast: ${mediaMetadata.cast.join(', ')}` : '');

    const selectedSources = new Map();

    let visibleEpisodes = [];
    // Guard playback within this picker so the library's click cooldown does not block it.
    let playbackRequested = false;
    const playEpisodes = async (episodes, options = {}) => {
        if (playbackRequested) return;
        playbackRequested = true;
        closePicker();
        try { await startQueue(episodes, options); }
        catch (error) { showToast(error.message || 'Could not start this collection.', 'error'); }
        finally { playbackRequested = false; }
    };
    const queueEpisodes = (episodes, options = {}) => {
        try {
            const count = addToQueue(episodes, options);
            showToast(count ? `Added ${count} item${count === 1 ? '' : 's'} to queue` : 'Already queued.', count ? 'success' : 'info');
        } catch (error) {
            showToast(error.message || 'Could not queue these files.', 'error');
        }
    };

    const getSeason = (seasonKey) => {
        const season = seasons.find(season => season.key === seasonKey);
        const sourceKey = selectedSources.get(seasonKey) ?? season.sourceSelector?.value ?? MERGED_SOURCE;
        const selected = season.variants[sourceKey];
        visibleEpisodes = selected.episodes;
        const sourceSelector = season.sourceSelector ? {
            ...season.sourceSelector,
            value: sourceKey,
            onChange: (sourceKey) => {
                if (season.variants[sourceKey]) selectedSources.set(seasonKey, sourceKey);
            }
        } : null;
        return { sourceSelector, groups: selected.groups };
    };

    renderPickerView({
        title: mediaMetadata?.title || title,
        seasons,
        getSeason,
        onPlay: () => playEpisodes(visibleEpisodes),
        onShuffle: () => playEpisodes(visibleEpisodes, { shuffled: true }),
        onEpisodePlay: (episode, group) => playEpisodes(group.episodes, { startItem: episode, includeThemes: true }),
        onEpisodeQueue: queueEpisodes,
        onGroupQueue: group => queueEpisodes(group.episodes),
        onEpisodeDownload: (episode) => {
            // FIX DOWNLOAD
        },
        onQueue: () => queueEpisodes(visibleEpisodes, { includeThemes: false })
    }, listElement);
}

let pickerHeaderListeners = null;
// Render prepared seasons and episode cards; the caller supplies all source actions.
function renderPickerView({ title, seasons, getSeason, onPlay, onShuffle, onQueue, onGroupQueue, onEpisodePlay, onEpisodeQueue, onEpisodeDownload }, listElement) {
    closeEpisodeMenus();
    pickerHeaderListeners?.abort();
    pickerHeaderListeners = new AbortController();
    const headerListenerOptions = { signal: pickerHeaderListeners.signal };

    listElement.addEventListener('scroll', closeEpisodeMenus, { passive: true, signal: pickerHeaderListeners.signal });
    window.addEventListener('resize', closeEpisodeMenus, { signal: pickerHeaderListeners.signal });

    document.getElementById('picker-series-title').textContent = title;

    document.getElementById('picker-queue-btn')?.addEventListener('click', onQueue, headerListenerOptions);
    document.getElementById('picker-play-btn')?.addEventListener('click', onPlay, headerListenerOptions);
    document.getElementById('picker-shuffle-btn')?.addEventListener('click', onShuffle, headerListenerOptions);

    const seasonContainer = document.getElementById('season-dropdown-container');
    const sourceContainer = document.getElementById('library-torrent-select');
    sourceContainer.replaceChildren();
    sourceContainer.classList.add('hidden');
    renderPickerSourceBadges(null);

    const renderGroup = (group) => {
        const groupElement = document.getElementById('picker-episode-card-template').content.firstElementChild.cloneNode(true);
        const row = groupElement.querySelector('.picker-episode-row');
        const cardTemplate = row.querySelector('.picker-episode-card');
        groupElement.querySelector('.picker-group-title').textContent = group.title;
        const queueGroupButton = groupElement.querySelector('.picker-group-queue');
        queueGroupButton.setAttribute('aria-label', `Queue ${group.title}`);
        queueGroupButton.addEventListener('click', () => onGroupQueue(group));
        groupElement.setAttribute('aria-label', group.title);
        row.setAttribute('aria-label', group.title);
        row.replaceChildren();
        row.addEventListener('scroll', closeEpisodeMenus, { passive: true });

        group.episodes.forEach(episode => {
            const card = cardTemplate.cloneNode(true);
            card.dataset.artwork = episode.fileType === 'Movie' ? 'poster' : 'thumbnail';
            const badge = card.querySelector('.picker-episode-badge');
            badge.classList.add(episode.badgeColor);
            const hideBadge = episode.fileType === 'Movie' || !episode.badge;
            badge.classList.toggle('hidden', hideBadge);
            badge.parentElement.classList.toggle('hidden', hideBadge && !episode.isExtended);
            card.querySelector('.picker-episode-extended').classList.toggle('hidden', !episode.isExtended);
            card.querySelector('.picker-episode-size').textContent = episode.size;
            badge.textContent = episode.badge;
            card.querySelector('.picker-episode-title').textContent = episode.title;
            card.querySelector('.picker-episode-watched').classList.toggle('hidden', !episode.isWatched);
            card.querySelectorAll('[data-action="download"]').forEach(button => {
                button.classList.toggle('hidden', !episode.canDownload);
            });
            if (episode.progressPercent !== null) {
                const progressBar = card.querySelector('.picker-episode-progress');
                progressBar.classList.remove('hidden');
                progressBar.setAttribute('aria-valuenow', String(Math.round(episode.progressPercent)));
                card.querySelector('.picker-episode-progress-fill').style.width = `${episode.progressPercent}%`;
            }
            if (episode.thumbnail) card.querySelector('img').src = episode.thumbnail;

            const optionsToggle = card.querySelector('.picker-episode-options');
            const optionsMenu = card.querySelector('.picker-episode-menu');
            optionsMenu.id = `picker-episode-actions-${crypto.randomUUID()}`;
            optionsToggle.setAttribute('popovertarget', optionsMenu.id);
            optionsToggle.setAttribute('aria-controls', optionsMenu.id);
            optionsToggle.setAttribute('aria-label', `Options for ${episode.title}`);
            optionsMenu.addEventListener('beforetoggle', event => {
                const open = event.newState === 'open';
                optionsToggle.setAttribute('aria-expanded', String(open));
            });
            optionsToggle.addEventListener('click', () => {
                // Native popovers escape the scrolling panel; position before the next paint.
                requestAnimationFrame(() => {
                    if (!optionsMenu.matches(':popover-open')) return;
                    const anchor = optionsToggle.getBoundingClientRect();
                    const menu = optionsMenu.getBoundingClientRect();
                    const left = Math.max(8, Math.min(anchor.right - menu.width,
                        document.documentElement.clientWidth - menu.width - 8));
                    const below = anchor.bottom + 6;
                    const top = below + menu.height <= window.innerHeight - 8
                        ? below : Math.max(8, anchor.top - menu.height - 6);
                    optionsMenu.style.left = `${left}px`;
                    optionsMenu.style.top = `${top}px`;
                });
            });

            card.onclick = (e) => {
                const btn = e.target.closest('button');

                if (btn?.dataset.action === 'download' || btn?.dataset.action === 'queue') {
                    e.stopPropagation();
                    if (optionsMenu.matches(':popover-open')) {
                        optionsMenu.hidePopover();
                        optionsToggle.focus({ preventScroll: true });
                    }
                    if (btn.dataset.action === 'download') {
                        onEpisodeDownload(episode);
                    } else {
                        onEpisodeQueue(episode);
                    }
                    return;
                }

                if (btn || e.target.closest('.picker-episode-menu')) return;

                onEpisodePlay(episode, group);
            };

            row.appendChild(card);
        });
        listElement.appendChild(groupElement);
    };

    const renderSeason = (seasonKey) => {
        closeEpisodeMenus();
        listElement.replaceChildren();
        const { sourceSelector, groups } = getSeason(seasonKey);
        const selectedSource = sourceSelector?.options.find(source => source.value === sourceSelector.value);
        renderPickerSourceBadges(selectedSource?.sourceData);
        sourceContainer.replaceChildren();
        sourceContainer.classList.toggle('hidden', !sourceSelector);
        if (sourceSelector) {
            sourceContainer.setAttribute('aria-label', sourceSelector.label);
            sourceSelector.options.forEach(source => {
                const button = document.createElement('button');
                button.type = 'button';
                button.value = source.value;
                button.textContent = source.label;
                button.title = source.label;
                button.setAttribute('aria-pressed', String(source.value === sourceSelector.value));
                button.className = 'min-h-11 max-w-[min(80vw,32rem)] shrink-0 truncate rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-300 transition-colors hover:border-slate-500 hover:text-white aria-pressed:border-blue-500 aria-pressed:bg-blue-500/15 aria-pressed:text-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400';
                button.addEventListener('click', () => {
                    if (source.value === sourceSelector.value) return;
                    const picker = document.getElementById('file-picker');
                    const scrollTop = picker.scrollTop;
                    sourceSelector.onChange(source.value);
                    renderSeason(seasonKey);
                    [...sourceContainer.children].find(item => item.value === source.value)?.focus({ preventScroll: true });
                    picker.scrollTop = scrollTop;
                });
                sourceContainer.appendChild(button);
            });
        }
        for (const group of groups) {
            renderGroup(group);
        }
    };

    if (seasons.length > 0) {
        seasonContainer.innerHTML = `
            <select id="library-season-select" aria-label="Season" class="min-h-11 min-w-0 max-w-full rounded-xl bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-200 shadow-lg shadow-black/10 hover:bg-slate-700 cursor-pointer outline-none">
                <button type="button" class="flex w-full items-center justify-between gap-3 text-left">
                    <selectedcontent class="min-w-0 truncate"></selectedcontent>
                    <svg class="season-dropdown-icon w-4 h-4 shrink-0 text-slate-400 transition-transform duration-200" aria-hidden="true" focusable="false" fill="none" stroke="currentColor">
                        <use href="#icon-arrow"></use>
                    </svg>
                </button>
            </select>
        `;

        const seasonSelect = document.getElementById('library-season-select');
        seasons.forEach(season => {
            const option = document.createElement('option');
            option.value = season.key;
            option.textContent = season.label;
            seasonSelect.appendChild(option);
        });
        seasonSelect.addEventListener('change', (e) => {
            renderSeason(e.target.value);
        });
    } else {
        seasonContainer.innerHTML = '';
    }

    if (seasons.length > 0) {
        renderSeason(seasons[0].key);
    } else {
        listElement.innerHTML = `<div class="col-span-full text-center text-slate-400 py-10">No video files found.</div>`;
    }
}
//#endregion
