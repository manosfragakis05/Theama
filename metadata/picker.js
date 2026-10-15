/**
 * ==========================================
 * picker.js
 * Handles the Season/Episode UI Modal and Metadata Merging
 * ==========================================
 */

import { showToast } from '../services/config.js';
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

function preProcessEpisodeTorrentData(videoFiles, fallbackShowName = 'Season 1') {
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

        const rawSeason = parsedFile.seasons?.[0] ?? fullParsed?.seasons?.[0];
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
        const defaultKey = `NAME_${fallbackShowName.toLowerCase()}`;
        baseSeasonsMap.set(defaultKey, {
            key: defaultKey,
            label: fallbackShowName,
            seasonNumber: 1,
            matchName: fallbackShowName.toLowerCase()
        });
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
//#endregion

//#region Main Picker Logic
export async function openPicker(torrent, tmdbId) {
    const picker = document.getElementById('file-picker');
    const list = document.getElementById('picker-list');

    picker.classList.remove('hidden');
    list.innerHTML = `<div class="col-span-full flex justify-center p-10">...Loading Spinner...</div>`;

    const videoFiles = torrent.files.filter(f => f.name.match(/\.(mkv|mp4|avi|mov)$/i));
    const baseInfo = parseMediaData(torrent.name);
    const cleanName = baseInfo.title.replace(/(^\w|[\s-]\w)/g, m => m.toUpperCase());

    const franchiseGroups = preProcessEpisodeTorrentData(videoFiles, cleanName);

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
                        const startsRelative = group.files.some(f => parseInt(f.episode) === 1);
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

    renderPickerUI(torrent, franchiseGroups, list, cleanName);
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
    document.getElementById('file-picker').classList.add('hidden');
}
//#endregion

//#region UI Rendering
function renderPickerUI(torrent, franchiseGroups, listElement, cleanName) {
    const titleElement = document.getElementById('picker-title');

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

    const fallbackImage = document.getElementById(`img-${torrent.id}`)?.src || '';

    // Pre-sort files and build queue items for EVERY season/group up front
    const preparedGroups = {};
    sortedGroupKeys.forEach(key => {
        const groupData = franchiseGroups[key];
        const sortedFiles = [...(groupData?.files || [])].sort((a, b) => {
            const valA = parseInt(a.episode);
            const valB = parseInt(b.episode);
            if (isNaN(valA) && isNaN(valB)) {
                return a.originalFile.name.localeCompare(b.originalFile.name);
            }
            return (isNaN(valA) ? 9999 : valA) - (isNaN(valB) ? 9999 : valB);
        });

        const queueItems = sortedFiles.map((fileObj, index) => {
            const { originalFile, episode, relativeEpisode, displayTitle, displayThumbnail, fileType, fileTypeLabel, isExtra } = fileObj;
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

            const fileSize = (originalFile.size / 1073741824).toFixed(2) + ' GB';
            const cardImage = displayThumbnail || fallbackImage;

            return {
                tid: torrent.id,
                fid: originalFile.id,
                seriesTitle: cleanName,
                season: groupData.title,
                fileType: groupData.fileType,
                episodeNumber: relativeEpisode ?? episode ?? (index + 1),
                badge: badgeText,
                title: finalCardTitle,
                fileName: originalFile.name,
                torrentName: torrent.name,
                thumbnail: cardImage,
                size: fileSize
            };
        });

        preparedGroups[key] = {
            groupData,
            sortedFiles,
            queueItems
        };
    });

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
                chainedQueue.push(...preparedGroups[key].queueItems);
            }
        }
        return chainedQueue;
    };

    titleElement.innerHTML = `
        <div class="flex items-center justify-between w-full gap-3 overflow-hidden">
        <span class="min-w-0 flex-1 font-bold text-slate-100 text-xl truncate"> 
            ${cleanName}
        </span> 
        <div class="flex items-center shrink-0 gap-3">
            <div id="season-dropdown-container" class="relative inline-flex items-center"></div>
                <button id="picker-play-btn" class="flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-200 shadow-lg shadow-black/10 hover:bg-slate-700 cursor-pointer">
                    Play
                </button>
                <button id="picker-shuffle-btn" class="flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-200 shadow-lg shadow-black/10 hover:bg-slate-700 cursor-pointer">
                    <svg class="w-5 h-5 shrink-0" aria-hidden="true" focusable="false" fill="none" stroke="currentColor">
                        <use href="#icon-shuffle"></use>
                    </svg>
                    Play Shuffled
                </button>
                <button id="picker-queue-btn" title="Add Series to Queue" class="flex min-h-12 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-200 shadow-lg shadow-black/10 hover:bg-slate-700 cursor-pointer">
                    <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                    </svg>
                    Queue
                </button>
            </div>
        </div>
    `;

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
        requestLink(episode.tid, episode.fid, episode.torrentName, episode.fileName);
    };

    // Wire up Header "Play" Button (Starts from Episode 1 of current season + queues future seasons)
    document.getElementById('picker-play-btn')?.addEventListener('click', () => {
        playEpisode();
    });

    // Wire up Header "Shuffle" Button (Picks a random episode across chained seasons + shuffles the rest)
    document.getElementById('picker-shuffle-btn')?.addEventListener('click', () => {
        playEpisode(0, true);
    });

    const renderGroup = (groupKey) => {
        listElement.replaceChildren();
        const prepared = preparedGroups[groupKey];

        if (!prepared || prepared.sortedFiles.length === 0) {
            listElement.innerHTML = `<div class="col-span-full text-center text-slate-400 py-10">No files found for this category.</div>`;
            return;
        }

        // Stage the multi-season queue starting from this season onward
        const multiSeasonQueue = getChainedMultiSeasonQueue(groupKey);
        buildSeriesQueue(cleanName, prepared.groupData.title, multiSeasonQueue);

        prepared.sortedFiles.forEach((fileObj, index) => {
            const { originalFile, fileType, isExtended, isExtra } = fileObj;
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

            const extendedBadgeHTML = isExtended
                ? `<span class="text-[10px] font-bold text-white px-2 py-0.5 rounded w-max bg-rose-600">Extended</span>`
                : '';

            const card = document.createElement('div');
            card.className = "relative flex flex-col w-full rounded-xl border-2 border-slate-700 bg-slate-800 overflow-hidden cursor-pointer hover:border-blue-500 transition-all group select-none";

            card.innerHTML = `
                <div class="relative aspect-video bg-slate-900 border-b border-slate-700 overflow-hidden">
                    <img src="${queueItem.thumbnail}" loading="lazy" class="w-full h-full object-cover opacity-60 group-hover:opacity-40 transition-opacity">
                    
                    <div class="absolute inset-0 flex items-center justify-center gap-3 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                        <button type="button" data-action="download" class="bg-slate-800/90 hover:bg-slate-700 text-white w-10 h-10 flex items-center justify-center rounded-full backdrop-blur-md transition-colors shadow-xl border border-slate-600" title="Download to Device">
                            <svg style="width:22px;height:22px;margin-top:2px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                        </button>
                        <button type="button" data-action="queue" class="bg-slate-800/90 hover:bg-slate-700 text-white w-10 h-10 flex items-center justify-center rounded-full backdrop-blur-md transition-colors shadow-xl border border-slate-600" title="Add to Queue">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
                        </button>
                    </div>

                    <div class="absolute bottom-2 right-2 bg-black/80 px-2 py-1 rounded text-[11px] text-white font-bold pointer-events-none">${queueItem.size}</div>
                </div>
                <div class="p-3 flex flex-col gap-1 pointer-events-none">
                    <div class="flex flex-wrap items-center gap-1.5">
                        <span class="text-[10px] font-bold text-white px-2 py-0.5 rounded w-max ${badgeColor}">${queueItem.badge}</span>
                        ${extendedBadgeHTML}
                    </div>
                    <p class="text-xs text-slate-300 line-clamp-2 mt-1 group-hover:text-white">${queueItem.title}</p>
                </div>
            `;

            card.onclick = (e) => {
                const btn = e.target.closest('button');

                if (btn?.dataset.action === 'download') {
                    e.stopPropagation();
                    downloadFile(torrent.id, originalFile.id, torrent.name);
                    return;
                }

                if (btn?.dataset.action === 'queue') {
                    e.stopPropagation();
                    addToQueue(queueItem);
                    showToast(`Queued: ${queueItem.title}`, 'success');
                    return;
                }

                if (btn) return;

                // Start from the clicked episode; all remaining episodes in this season + next seasons are queued!
                playEpisode(index);
            };

            listElement.appendChild(card);
        });
    };

    if (sortedGroupKeys.length > 1) {
        seasonContainer.innerHTML = `
            <select id="library-season-select" aria-label="Season" class="min-h-12 rounded-xl bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-200 shadow-lg shadow-black/10 hover:bg-slate-700 cursor-pointer outline-none">
                <button type="button" class="flex w-full items-center justify-between gap-3 text-left">
                    <selectedcontent class="min-w-0 truncate"></selectedcontent>
                    <svg class="season-dropdown-icon w-4 h-4 shrink-0 text-slate-400 transition-transform duration-200" aria-hidden="true" focusable="false" fill="none" stroke="currentColor">
                        <use href="#icon-arrow"></use>
                    </svg>
                </button>
                ${sortedGroupKeys.map(key => `<option value="${key}">${franchiseGroups[key].title}</option>`).join('')}
            </select>
        `;

        document.getElementById('library-season-select').addEventListener('change', (e) => {
            renderGroup(e.target.value);
        });
    } else {
        seasonContainer.innerHTML = '';
    }

    if (sortedGroupKeys.length > 0) {
        renderGroup(sortedGroupKeys[0]);
    } else {
        listElement.innerHTML = `<div class="col-span-full text-center text-slate-400 py-10">No video files found.</div>`;
    }
}
//#endregion
