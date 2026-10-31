/**
 * ==========================================
 * picker.js
 * Handles the Season/Episode UI Modal and Metadata Merging
 * ==========================================
 */

import { appState, showToast } from '../services/config.js';
import { supabase } from '../user-data/db.js';
import { parseMediaData } from '../utils/parseMedia.js';

import { requestLink } from '../streaming/player.js';
import {
    buildSeriesQueue,
    startQueueFromEpisode,
    startShuffledQueue,
    addToQueue,
    queueStagedSeries
} from '../streaming/playlist.js';

import { fetchAnimeMapping } from '../api.js';
import { downloadFile } from '../pages/library.js';
import { getTmdbSeasonEpisodes, getTmdbShowDetails } from './metadata.js';

//#region Data Grouping
const SWITCH_WORDS_REGEX = /(?:^|[\s._\-\[\]()])(MOVIE|OVA|OAD|ODA|ONA|SPECIAL|RECAP|SP|OPENING|NCOP|OP|ENDING|NCED|ED|THEME|PROMO|TEASER|TRAILER|PV|CM)(?:S?\d*[a-z]?)?(?=$|[\s._\-\[\]()])/i;
const EXTENDED_WORDS_REGEX = /(?:^|[\s._\-\[\]()])(EXTEND(?:ED)?(?:[\s._\-]+(?:EDITION|CUT|VERSION|VER))?|DIRECTOR'?S[\s._\-]+(?:EDITION|CUT|VERSION|VER)|UNCUT|UNRATED)(?=$|[\s._\-\[\]()])/i;

function classifyFileType(fileName) {
    const match = fileName.match(SWITCH_WORDS_REGEX);
    const matchedWord = match ? match[1].toUpperCase() : 'TV';
    const fileTypeLabel = match
        ? match[0].replace(/^[\s._\-\[\]()]+|[\s._\-\[\]()]+$/g, '').toUpperCase()
        : null;

    const isExtended = EXTENDED_WORDS_REGEX.test(fileName);

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

function preProcessEpisodeTorrentData(videoFiles, fallbackShowName = 'Season 1', fallbackSeason = null) {
    const franchiseGroups = {};
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
        const { fileType, fileTypeLabel, isExtended } = classifyFileType(fileName);

        // Extract clean season/show name if no season number exists
        let candidateTitle = (parsedFile.title || fullParsed?.title || fallbackShowName).trim();
        if (!candidateTitle || /^\d+$/.test(candidateTitle)) {
            candidateTitle = fallbackShowName;
        }

        return {
            file,
            fileName,
            parsedFile,
            rawSeason,
            fileEpisode,
            fileType,
            fileTypeLabel,
            isExtended,
            candidateTitle,
            sizeInMB: file.size / (1024 * 1024)
        };
    });

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

        if (!franchiseGroups[groupKey]) {
            franchiseGroups[groupKey] = {
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

        franchiseGroups[groupKey].files.push({
            originalFile: entry.file,
            fileTitle: entry.parsedFile.title,
            year: entry.parsedFile.year,
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

    for (const group of Object.values(franchiseGroups)) {
        group.episodeCount = group.files.length;
    }

    return franchiseGroups;
}

function getTorrentKey(torrent) {
    return torrent.hash ? `hash:${String(torrent.hash).toLowerCase()}` : `id:${torrent.id}`;
}

function buildPickerGroups(torrents) {
    const franchiseGroups = {};
    const seenTorrents = new Set();

    for (const torrent of torrents) {
        const sourceKey = getTorrentKey(torrent);
        if (seenTorrents.has(sourceKey)) continue;
        seenTorrents.add(sourceKey);

        const videoFiles = (torrent.files || []).filter(file => /\.(mkv|mp4|avi|mov)$/i.test(file.name));
        const baseInfo = parseMediaData(torrent.name);
        const fallbackSeason = baseInfo.seasons?.length === 1 ? baseInfo.seasons[0] : null;
        const sourceGroups = preProcessEpisodeTorrentData(videoFiles, baseInfo.title, fallbackSeason);

        // Parse each source in its own context before combining matching seasons.
        for (const [key, group] of Object.entries(sourceGroups)) {
            if (!franchiseGroups[key]) franchiseGroups[key] = { ...group, files: [] };
            franchiseGroups[key].files.push(...group.files.map(file => ({
                ...file,
                sourceTorrent: torrent
            })));
            franchiseGroups[key].episodeCount = franchiseGroups[key].files.length;
        }
    }

    const seasons = [...new Map(Object.values(franchiseGroups).map(group => [group.seasonKey, group])).values()]
        .sort((a, b) => a.seasonNumber != null && b.seasonNumber != null
            ? a.seasonNumber - b.seasonNumber
            : a.seasonLabel.localeCompare(b.seasonLabel, undefined, { numeric: true }));
    const seasonOrder = new Map(seasons.map((group, index) => [group.seasonKey, index + 1]));
    for (const group of Object.values(franchiseGroups)) {
        group.seasonOrder = seasonOrder.get(group.seasonKey);
    }

    return franchiseGroups;
}
//#endregion

//#region Main Picker Logic
let pickerGeneration = 0;

async function fetchPickerWatchProgress(tmdbId, userId) {
    if (!tmdbId || !userId) return null;
    try {
        const { data, error } = await supabase.from('watch_progress')
            .select('watched_counts,current_episode,position_seconds,duration_seconds')
            .eq('user_id', userId)
            .eq('media_type', 'tv')
            .eq('tmdb_id', tmdbId)
            .maybeSingle();
        if (error) throw error;
        return data;
    } catch (error) {
        console.warn('Could not load watched episodes:', error);
        return null;
    }
}

async function loadEpisodeGroups(torrents, tmdbId) {
    const franchiseGroups = buildPickerGroups(torrents);

    // We only process TMDB metadata if we have a valid ID
    if (tmdbId) {
        const showDetails = await getTmdbShowDetails(tmdbId);

        if (showDetails && showDetails.seasons) {
            const showBackdrop = showDetails.backdrop_path
                ? `https://image.tmdb.org/t/p/w500${showDetails.backdrop_path}`
                : null;

            const seasonCache = {};
            const aniZipCache = {};
            let animeData = null; // Only fetched if a season is missing on TMDB

            for (const groupKey in franchiseGroups) {
                const group = franchiseGroups[groupKey];

                if (group.fileType !== 'TV') {
                    for (const file of group.files) {
                        file.displayThumbnail = showBackdrop;
                    }
                    continue;
                }

                const tmdbSeasonObj = showDetails.seasons.find(
                    s => s.season_number === group.tmdbSeason && s.episode_count > 0
                );
                const tmdbHasSeason = Boolean(tmdbSeasonObj);

                let aniZipData = null;

                // Only ask the proxy + AniZip if TMDB does not have this season
                if (!tmdbHasSeason) {
                    if (!animeData) {
                        animeData = await fetchAnimeMapping(tmdbId);
                    }

                    const matches = animeData?.data?.matches || animeData?.matches || [];
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

                    if (!tmdbHasSeason) {
                        // CASE 1: Packed Season — TMDB doesn't have this season, use AniZip only
                        const aniEp = aniZipData?.episodes?.[targetEp];
                        if (aniEp?.absoluteEpisodeNumber) {
                            const tmdbMapped = mapAbsoluteToTmdbRelative(
                                aniEp.absoluteEpisodeNumber,
                                showDetails.seasons
                            );

                            if (tmdbMapped) {
                                fetchSeason = tmdbMapped.targetSeason;
                                targetEp = tmdbMapped.relativeEp;
                                badgeEp = aniEp.episodeNumber ?? badgeEp;
                            }
                        }
                    } else if (tmdbSeasonObj && targetEp > tmdbSeasonObj.episode_count) {
                        // CASE 2: Split Season — TMDB has the season, but split it into later seasons (e.g., HxH)
                        const startsRelative = group.files.some(f =>
                            f.sourceTorrent === file.sourceTorrent && parseInt(f.episode) === 1);
                        const priorEpisodesOffset = startsRelative
                            ? showDetails.seasons
                                .filter(s => s.season_number > 0 && s.season_number < group.tmdbSeason)
                                .reduce((sum, s) => sum + s.episode_count, 0)
                            : 0;

                        const tmdbMapped = mapAbsoluteToTmdbRelative(
                            priorEpisodesOffset + targetEp,
                            showDetails.seasons
                        );

                        if (tmdbMapped) {
                            fetchSeason = tmdbMapped.targetSeason;
                            targetEp = tmdbMapped.relativeEp;
                            isSplitOverflow = true;
                        }
                    }

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

export async function openPicker(torrentOrTorrents, tmdbId, title) {
    const generation = ++pickerGeneration;
    const candidate = Number(tmdbId);
    tmdbId = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
    const userId = appState.currentUser?.id;
    const watchProgressPromise = fetchPickerWatchProgress(tmdbId, userId);
    const torrents = Array.isArray(torrentOrTorrents) ? torrentOrTorrents : [torrentOrTorrents];
    const torrent = torrents[0];
    const picker = document.getElementById('file-picker');
    const list = document.getElementById('picker-list');

    picker.classList.remove('hidden');
    list.innerHTML = `<div class="col-span-full flex justify-center p-10">...Loading Spinner...</div>`;

    const baseInfo = parseMediaData(torrent.name);
    const cleanName = title || baseInfo.title.replace(/(^\w|[\s-]\w)/g, m => m.toUpperCase());

    const franchiseGroups = await loadEpisodeGroups(torrents, tmdbId);

    const watchProgress = await watchProgressPromise;
    if (generation !== pickerGeneration) return;
    renderPickerUI(torrent, franchiseGroups, list, cleanName, tmdbId,
        appState.currentUser?.id === userId ? watchProgress : null);
}

// The existing picker can stage episode metadata when file listings are unavailable.
export async function openAddonPicker(media, sources, seasons) {
    const generation = ++pickerGeneration;
    const userId = appState.currentUser?.id;
    const picker = document.getElementById('file-picker');
    const list = document.getElementById('picker-list');
    picker.classList.remove('hidden');
    list.replaceChildren();
    const torrent = { id: `addon:${media.id}`, name: media.title,
        hash: sources[0]?.hash || '', addonMedia: media, addonSources: sources };
    const groups = {};
    seasons.forEach((season, index) => {
        const number = Number(season.seasonNumber);
        const key = `S_${number}_TV`;
        groups[key] = {
            title: season.name || `Season ${number}`, seasonLabel: season.name || `Season ${number}`,
            seasonKey: `S_${number}`, seasonNumber: number, seasonOrder: index + 1,
            tmdbSeason: number, fileType: 'TV',
            files: season.episodes.map(episode => ({
                originalFile: { id: `addon:${number}:${episode.episodeNumber}`, name: episode.title || `Episode ${episode.episodeNumber}`, size: 0 },
                episode: episode.episodeNumber, relativeEpisode: episode.episodeNumber,
                tmdbSeason: number, watchSeason: number, watchEpisode: episode.episodeNumber,
                displayTitle: episode.title, displayThumbnail: episode.thumbnail || media.poster,
                streamId: episode.streamId, fileType: 'TV', fileTypeLabel: 'TV', sourceTorrent: torrent
            }))
        };
    });
    const progress = await fetchPickerWatchProgress(media.tmdbId, userId);
    if (generation !== pickerGeneration || userId !== appState.currentUser?.id) return;
    renderPickerUI(torrent, groups, list, media.title, media.tmdbId, progress);
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

export function closePicker() {
    pickerGeneration++;
    closeEpisodeMenus();
    pickerHeaderListeners?.abort();
    document.getElementById('file-picker').classList.add('hidden');
}
//#endregion

//#region UI Rendering
let pickerHeaderListeners = null;

function closeEpisodeMenus() {
    document.querySelectorAll('#file-picker .picker-episode-menu:popover-open')
        .forEach(menu => menu.hidePopover());
}

function preparePickerQueue(torrent, franchiseGroups, cleanName, tmdbId, fallbackImage = '') {
    const typePriority = {
        'TV': 1,
        'Movie': 2,
        'OVA': 3,
        'Special': 4,
        'Theme': 5,
        'Trailer': 6
    };

    // Sort main seasons first, then secondary folders in matching season order
    const sortedGroupKeys = Object.keys(franchiseGroups).sort((keyA, keyB) => {
        const groupA = franchiseGroups[keyA];
        const groupB = franchiseGroups[keyB];
        const typeDiff = (typePriority[groupA.fileType] || 99) - (typePriority[groupB.fileType] || 99);
        if (typeDiff !== 0) return typeDiff;
        return (groupA.seasonOrder || 0) - (groupB.seasonOrder || 0);
    });

    // Keep alternate torrents separate, including their episode numbering.
    const preparedGroups = {};
    const seasonSources = new Map();
    const selectedSources = new Map();
    sortedGroupKeys.forEach(key => {
        const groupData = franchiseGroups[key];
        const variants = new Map();
        if (!seasonSources.has(groupData.seasonKey)) seasonSources.set(groupData.seasonKey, new Map());
        const sources = seasonSources.get(groupData.seasonKey);
        for (const file of groupData.files || []) {
            const sourceTorrent = file.sourceTorrent || torrent;
            const sourceKey = getTorrentKey(sourceTorrent);
            if (!variants.has(sourceKey)) variants.set(sourceKey, { sortedFiles: [], queueItems: [] });
            variants.get(sourceKey).sortedFiles.push(file);
            sources.set(sourceKey, sourceTorrent);
            if (!selectedSources.has(groupData.seasonKey)) selectedSources.set(groupData.seasonKey, sourceKey);
        }

        for (const variant of variants.values()) {
            const sortedFiles = variant.sortedFiles.sort((a, b) => {
                const valA = parseInt(a.episode);
                const valB = parseInt(b.episode);
                if (isNaN(valA) && isNaN(valB)) {
                    return a.originalFile.name.localeCompare(b.originalFile.name);
                }
                return (isNaN(valA) ? 9999 : valA) - (isNaN(valB) ? 9999 : valB);
            });

            const queueItems = sortedFiles.map((fileObj, index) => {
                const { originalFile, episode, relativeEpisode, displayTitle, displayThumbnail, fileType, fileTypeLabel, isExtra } = fileObj;
                const sourceTorrent = fileObj.sourceTorrent || torrent;
                const isThemeFile = fileType === 'Theme';
                const isOvaFile = fileType === 'OVA' || fileType === 'Special';
                const isMovieFile = fileType === 'Movie';

                const finalCardTitle = displayTitle || originalFile.short_name || originalFile.name.split(/[\\/]/).at(-1);
                const badgeText = isThemeFile
                    ? `🎵 ${fileTypeLabel || 'Theme'}`
                    : isExtra
                        ? `🎬 ${fileTypeLabel || 'Trailer'}`
                        : isOvaFile
                            ? `⭐ ${fileTypeLabel || fileType}`
                            : isMovieFile
                                ? `🎥 ${fileTypeLabel || 'Movie'}`
                                : `Episode ${relativeEpisode ?? episode ?? (index + 1)}`;

                const fileSize = sourceTorrent.addonMedia ? '' : (originalFile.size / 1073741824).toFixed(2) + ' GB';
                const cardImage = displayThumbnail || fallbackImage;

                return {
                    tid: sourceTorrent.id,
                    fid: originalFile.id,
                    hash: sourceTorrent.hash,
                    tmdbId: fileType === 'TV' ? tmdbId : null,
                    mediaType: 'tv',
                    seasonNumber: fileObj.watchSeason ?? fileObj.tmdbSeason,
                    watchEpisodeNumber: fileObj.watchEpisode ?? relativeEpisode ?? episode ?? (index + 1),
                    seriesTitle: cleanName,
                    season: groupData.title,
                    fileType: groupData.fileType,
                    episodeNumber: relativeEpisode ?? episode ?? (index + 1),
                    badge: badgeText,
                    title: finalCardTitle,
                    fileName: originalFile.name,
                    torrentName: sourceTorrent.name,
                    thumbnail: cardImage,
                    size: fileSize,
                    ...(sourceTorrent.addonMedia ? {
                        sourceType: 'addon', sourceMediaId: String(sourceTorrent.addonMedia.id),
                        sourceHashes: sourceTorrent.addonSources.map(source => source.hash).filter(Boolean),
                        streamId: fileObj.streamId || String(sourceTorrent.addonMedia.streamId)
                    } : {})
                };
            });

            variant.queueItems = queueItems;
        }
        preparedGroups[key] = { groupData, variants };
    });

    const getSelectedGroup = key => preparedGroups[key].variants.get(
        selectedSources.get(franchiseGroups[key].seasonKey));

    /**
     * Builds a continuous queue starting at `startGroupKey` and chaining
     * all subsequent seasons in `sortedGroupKeys` of the same fileType (e.g. all TV seasons).
     */
    const getChainedMultiSeasonQueue = (startGroupKey) => {
        const startGroupIdx = sortedGroupKeys.indexOf(startGroupKey);
        if (startGroupIdx === -1) return [];

        const startType = franchiseGroups[startGroupKey].fileType;
        const chainedQueue = [];

        for (let i = startGroupIdx; i < sortedGroupKeys.length; i++) {
            const key = sortedGroupKeys[i];
            const group = franchiseGroups[key];

            // If starting on a TV season, chain all following TV seasons (skip Themes/Trailers)
            if (group.fileType === startType) {
                const selected = getSelectedGroup(key);
                if (selected) chainedQueue.push(...selected.queueItems);
            }
        }
        return chainedQueue;
    };

    return { sortedGroupKeys, seasonSources, selectedSources, getSelectedGroup, getChainedMultiSeasonQueue };
}

// Resolve by file identity: TMDB numbering can differ from torrent episode numbering.
export async function buildRemainingTorrentQueue(torrent, tmdbId, fileId, title, thumbnail = '') {
    const franchiseGroups = await loadEpisodeGroups([torrent], tmdbId);
    const { sortedGroupKeys, getSelectedGroup, getChainedMultiSeasonQueue } =
        preparePickerQueue(torrent, franchiseGroups, title, tmdbId, thumbnail);
    const groupKey = sortedGroupKeys.find(key => getSelectedGroup(key)?.queueItems.some(
        item => String(item.fid) === String(fileId)));
    if (!groupKey) return [];
    const items = getChainedMultiSeasonQueue(groupKey);
    const index = items.findIndex(item => String(item.fid) === String(fileId));
    return items.slice(index);
}

// Match the selected detail-view episode using the same numbering as the picker.
export async function buildSelectedTorrentQueue(torrent, media) {
    const franchiseGroups = await loadEpisodeGroups([torrent], media.tmdbId);
    const { sortedGroupKeys, getSelectedGroup, getChainedMultiSeasonQueue } =
        preparePickerQueue(torrent, franchiseGroups, media.title, media.tmdbId, media.poster);
    const items = sortedGroupKeys.flatMap(key => getSelectedGroup(key)?.queueItems || []);
    const season = Number(media.seasonNumber ?? 1);
    const episode = Number(media.episodeNumber ?? 1);
    let selected = items.find(item => item.fileType === 'TV'
        && Number(item.seasonNumber) === season
        && Number(item.watchEpisodeNumber) === episode);

    // Kitsu providers can use absolute episode numbers instead of TMDB seasons.
    if (!selected && media.kitsuEpisode != null) {
        selected = items.find(item => item.fileType === 'TV'
            && Number(item.episodeNumber) === Number(media.kitsuEpisode));
    }
    // A single episode may have no episode number in its filename.
    if (!selected && items.length === 1 && items[0].fileType === 'TV') {
        const file = torrent.files.find(file => String(file.id) === String(items[0].fid));
        if (!parseMediaData(file.name).episodes?.length) selected = items[0];
    }
    if (!selected) return [];
    const groupKey = sortedGroupKeys.find(key => getSelectedGroup(key)?.queueItems.includes(selected));
    const queue = getChainedMultiSeasonQueue(groupKey);
    const index = queue.indexOf(selected);
    queue[index] = {
        ...selected, seasonNumber: season, episodeNumber: episode, watchEpisodeNumber: episode
    };
    return queue.slice(index);
}

function renderPickerUI(torrent, franchiseGroups, listElement, cleanName, tmdbId, watchProgress) {
    closeEpisodeMenus();
    pickerHeaderListeners?.abort();
    pickerHeaderListeners = new AbortController();
    listElement.addEventListener('scroll', closeEpisodeMenus, { passive: true, signal: pickerHeaderListeners.signal });
    window.addEventListener('resize', closeEpisodeMenus, { signal: pickerHeaderListeners.signal });
    const titleElement = document.getElementById('picker-title');
    const watchedCounts = watchProgress?.watched_counts || {};
    const position = Number(watchProgress?.position_seconds);
    const duration = Number(watchProgress?.duration_seconds);
    const progressPercent = Number.isFinite(position) && Number.isFinite(duration) && duration > 0
        ? Math.max(0, Math.min(position / duration * 100, 100)) : null;

    const fallbackImage = document.getElementById(`img-${torrent.id}`)?.src || '';
    const { sortedGroupKeys, seasonSources, selectedSources, getSelectedGroup, getChainedMultiSeasonQueue } =
        preparePickerQueue(torrent, franchiseGroups, cleanName, tmdbId, fallbackImage);

    titleElement.innerHTML = `
        <div class="flex w-full flex-wrap items-center gap-x-3 gap-y-2 md:flex-nowrap">
            <span id="picker-series-title" class="max-w-full font-bold text-slate-100 text-base [overflow-wrap:anywhere] md:min-w-0 md:flex-1 md:truncate md:text-xl"></span>
            <div class="flex min-w-0 max-w-full flex-auto items-center justify-end gap-2 md:flex-none md:gap-3">
                <div id="season-dropdown-container" class="relative inline-flex min-w-0 flex-1 items-center md:flex-none"></div>
                <div id="picker-actions" class="relative shrink-0">
                    <button id="picker-actions-toggle" type="button" aria-label="Playback and queue options" aria-expanded="false" aria-controls="picker-actions-menu"
                        class="group grid h-11 w-11 place-items-center rounded-lg text-slate-400 transition-colors hover:text-slate-200 aria-expanded:text-slate-200 md:hidden">
                        <span class="pointer-events-none grid h-8 w-7 place-items-center rounded-lg bg-slate-700/20 transition-colors group-hover:bg-slate-700/40 group-aria-expanded:bg-slate-700/40">
                            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
                                <circle cx="12" cy="5" r="1.75"></circle>
                                <circle cx="12" cy="12" r="1.75"></circle>
                                <circle cx="12" cy="19" r="1.75"></circle>
                            </svg>
                        </span>
                    </button>
                    <div id="picker-actions-menu" class="absolute right-0 top-full z-30 mt-2 hidden flex-col gap-1 w-48 max-w-[calc(100vw-6rem)] rounded-xl border border-slate-700 bg-slate-900 p-1.5 shadow-xl md:static md:mt-0 md:flex md:w-auto md:max-w-none md:flex-row md:gap-3 md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none">
                        <button id="picker-play-btn" type="button" class="flex min-h-11 shrink-0 items-center justify-start gap-2 rounded-xl bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-200 shadow-lg shadow-black/10 hover:bg-slate-700 cursor-pointer md:justify-center">
                            Play
                        </button>
                        <button id="picker-shuffle-btn" type="button" class="flex min-h-11 shrink-0 items-center justify-start gap-2 rounded-xl bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-200 shadow-lg shadow-black/10 hover:bg-slate-700 cursor-pointer md:justify-center">
                            <svg class="w-5 h-5 shrink-0" aria-hidden="true" focusable="false" fill="none" stroke="currentColor">
                                <use href="#icon-shuffle"></use>
                            </svg>
                            Play Shuffled
                        </button>
                        <button id="picker-queue-btn" type="button" title="Add Series to Queue" class="flex min-h-11 shrink-0 items-center justify-start gap-1.5 rounded-xl bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-200 shadow-lg shadow-black/10 hover:bg-slate-700 cursor-pointer md:justify-center">
                            <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                            </svg>
                            Queue
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.getElementById('picker-series-title').textContent = cleanName;

    const actions = document.getElementById('picker-actions');
    const actionsToggle = document.getElementById('picker-actions-toggle');
    const actionsMenu = document.getElementById('picker-actions-menu');
    const setActionsOpen = (open) => {
        actionsToggle.setAttribute('aria-expanded', String(open));
        actionsMenu.classList.toggle('hidden', !open);
        actionsMenu.classList.toggle('flex', open);
    };
    actionsToggle.addEventListener('click', () => {
        closeEpisodeMenus();
        setActionsOpen(actionsToggle.getAttribute('aria-expanded') !== 'true');
    });
    actionsMenu.addEventListener('click', event => {
        if (event.target.closest('button')) {
            setActionsOpen(false);
            if (actionsToggle.offsetParent) actionsToggle.focus();
        }
    });
    document.addEventListener('click', event => {
        if (!actions.contains(event.target)) setActionsOpen(false);
    }, { signal: pickerHeaderListeners.signal });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && actionsToggle.getAttribute('aria-expanded') === 'true') {
            event.preventDefault();
            setActionsOpen(false);
            actionsToggle.focus();
        }
    }, { signal: pickerHeaderListeners.signal });

    document.getElementById('picker-queue-btn')?.addEventListener('click', () => {
        const count = queueStagedSeries();
        if (count > 0) {
            showToast(`Added ${count} episodes to queue`, 'success');
        }
    });

    const seasonContainer = document.getElementById('season-dropdown-container');

    // Opening the picker can leave the library's click cooldown active.
    // Guard playback within this picker instead so the first episode click works.
    let playbackRequested = false;
    const playEpisode = (index = 0, shuffled = false) => {
        if (playbackRequested) return;
        const episode = shuffled ? startShuffledQueue() : startQueueFromEpisode(index);
        if (!episode) return;
        playbackRequested = true;
        closePicker();
        const episodeKey = `${episode.seasonNumber}:${episode.watchEpisodeNumber}`;
        const resumePosition = episode.tmdbId === tmdbId && watchProgress?.current_episode === episodeKey
            && progressPercent !== null ? Math.max(0, Math.min(position, duration)) : 0;
        requestLink(episode.tid, episode.fid, episode.torrentName, episode.fileName, episode.uid, resumePosition);
    };

    // Wire up Header "Play" Button (Starts from Episode 1 of current season + queues future seasons)
    document.getElementById('picker-play-btn')?.addEventListener('click', () => {
        playEpisode();
    });

    // Wire up Header "Shuffle" Button (Picks a random episode across chained seasons + shuffles the rest)
    document.getElementById('picker-shuffle-btn')?.addEventListener('click', () => {
        playEpisode(0, true);
    });

    let activeGroupKey;
    const stageGroup = (groupKey) => {
        activeGroupKey = groupKey;
        buildSeriesQueue(getChainedMultiSeasonQueue(groupKey));
    };

    const renderGroup = (groupKey) => {
        const prepared = getSelectedGroup(groupKey);

        prepared.sortedFiles.forEach((fileObj, index) => {
            const { fileType, isExtended, isExtra } = fileObj;
            const queueItem = prepared.queueItems[index];

            const isThemeFile = fileType === 'Theme';
            const isOvaFile = fileType === 'OVA' || fileType === 'Special';

            const badgeColor = isExtra
                ? 'bg-emerald-600'
                : isOvaFile
                    ? 'bg-amber-600'
                    : isThemeFile
                        ? 'bg-purple-600'
                        : 'bg-blue-600';

            const card = document.getElementById('picker-episode-card-template').content.firstElementChild.cloneNode(true);
            card.querySelector('.picker-episode-badge').classList.add(badgeColor);
            card.querySelector('.picker-episode-extended').classList.toggle('hidden', !isExtended);
            card.querySelector('.picker-episode-size').textContent = queueItem.size;
            card.querySelector('.picker-episode-badge').textContent = queueItem.badge;
            card.querySelector('.picker-episode-title').textContent = queueItem.title;
            const episodeKey = `${queueItem.seasonNumber}:${queueItem.watchEpisodeNumber}`;
            const isWatched = queueItem.tmdbId != null && Number(watchedCounts[episodeKey]) > 0;
            card.querySelector('.picker-episode-watched').classList.toggle('hidden', !isWatched);
            if (queueItem.tmdbId != null && watchProgress?.current_episode === episodeKey && progressPercent !== null) {
                const progressBar = card.querySelector('.picker-episode-progress');
                progressBar.classList.remove('hidden');
                progressBar.setAttribute('aria-valuenow', String(Math.round(progressPercent)));
                card.querySelector('.picker-episode-progress-fill').style.width = `${progressPercent}%`;
            }
            if (queueItem.thumbnail) card.querySelector('img').src = queueItem.thumbnail;

            const optionsToggle = card.querySelector('.picker-episode-options');
            const optionsMenu = card.querySelector('.picker-episode-menu');
            optionsMenu.id = `picker-episode-actions-${crypto.randomUUID()}`;
            optionsToggle.setAttribute('popovertarget', optionsMenu.id);
            optionsToggle.setAttribute('aria-controls', optionsMenu.id);
            optionsToggle.setAttribute('aria-label', `Options for ${queueItem.title}`);
            optionsMenu.addEventListener('beforetoggle', event => {
                const open = event.newState === 'open';
                optionsToggle.setAttribute('aria-expanded', String(open));
                if (open) setActionsOpen(false);
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
                        if (queueItem.sourceType === 'addon') {
                            import('../pages/addon-library.js').then(({ downloadAddonQueueItem }) => downloadAddonQueueItem(queueItem))
                                .catch(error => showToast(error.message || 'Could not download this episode.', 'error'));
                        } else downloadFile(queueItem.tid, queueItem.fid, queueItem.fileName);
                    } else {
                        addToQueue(queueItem);
                    }
                    return;
                }

                if (btn || e.target.closest('.picker-episode-menu')) return;

                // Start from the clicked episode; all remaining episodes in this season + next seasons are queued
                if (activeGroupKey !== groupKey) stageGroup(groupKey);
                playEpisode(index);
            };

            listElement.appendChild(card);
        });
    };

    const seasonGroups = new Map();
    for (const key of sortedGroupKeys) {
        const seasonKey = franchiseGroups[key].seasonKey;
        if (!seasonGroups.has(seasonKey)) seasonGroups.set(seasonKey, []);
        seasonGroups.get(seasonKey).push(key);
    }
    const sortedSeasonKeys = [...seasonGroups.keys()].sort((a, b) =>
        franchiseGroups[seasonGroups.get(a)[0]].seasonOrder - franchiseGroups[seasonGroups.get(b)[0]].seasonOrder);

    const renderSeason = (seasonKey) => {
        closeEpisodeMenus();
        listElement.replaceChildren();
        listElement.scrollTop = 0;
        const sources = seasonSources.get(seasonKey);
        const groupKeys = seasonGroups.get(seasonKey).filter(key => getSelectedGroup(key));
        if (sources.size > 1) {
            const sourceSelect = document.createElement('select');
            sourceSelect.id = 'library-torrent-select';
            sourceSelect.setAttribute('aria-label', `Torrent for ${franchiseGroups[groupKeys[0]].seasonLabel}`);
            sourceSelect.className = 'col-span-full min-h-11 w-full min-w-0 max-w-full rounded-xl bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-200 shadow-lg shadow-black/10 hover:bg-slate-700 cursor-pointer outline-none';
            sourceSelect.innerHTML = `
                <button type="button" class="flex w-full min-w-0 items-center justify-between gap-3 text-left">
                    <selectedcontent class="min-w-0 truncate"></selectedcontent>
                    <svg class="season-dropdown-icon w-4 h-4 shrink-0 text-slate-400 transition-transform duration-200" aria-hidden="true" focusable="false" fill="none" stroke="currentColor">
                        <use href="#icon-arrow"></use>
                    </svg>
                </button>
            `;
            const labels = [...sources.values()].map(source => {
                const size = Number.isFinite(source.size) ? ` · ${(source.size / 1073741824).toFixed(1)} GB` : '';
                return `${source.name || 'Torrent'}${size}`;
            });
            [...sources.keys()].forEach((sourceKey, index) => {
                const option = document.createElement('option');
                option.value = sourceKey;
                const label = labels[index];
                option.textContent = labels.indexOf(label) !== labels.lastIndexOf(label)
                    ? `${label} — Torrent ${index + 1}` : label;
                sourceSelect.appendChild(option);
            });
            sourceSelect.value = selectedSources.get(seasonKey);
            sourceSelect.addEventListener('change', event => {
                if (!sources.has(event.target.value)) return;
                selectedSources.set(seasonKey, event.target.value);
                renderSeason(seasonKey);
                document.getElementById('library-torrent-select')?.focus({ preventScroll: true });
            });
            listElement.appendChild(sourceSelect);
        }
        stageGroup(groupKeys[0]);
        for (const groupKey of groupKeys) {
            if (groupKeys.length > 1) {
                const heading = document.createElement('h4');
                heading.className = 'col-span-full font-semibold text-slate-300';
                heading.textContent = franchiseGroups[groupKey].title;
                listElement.appendChild(heading);
            }
            renderGroup(groupKey);
        }
    };

    if (sortedSeasonKeys.length > 1) {
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
        sortedSeasonKeys.forEach(key => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = franchiseGroups[seasonGroups.get(key)[0]].seasonLabel;
            seasonSelect.appendChild(option);
        });
        seasonSelect.addEventListener('change', (e) => {
            renderSeason(e.target.value);
        });
    } else {
        seasonContainer.innerHTML = '';
    }

    if (sortedSeasonKeys.length > 0) {
        renderSeason(sortedSeasonKeys[0]);
    } else {
        buildSeriesQueue([]);
        listElement.innerHTML = `<div class="col-span-full text-center text-slate-400 py-10">No video files found.</div>`;
    }
}
//#endregion
