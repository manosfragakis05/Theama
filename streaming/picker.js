/**
 * ==========================================
 * picker.js
 * Handles the Season/Episode UI Modal and Metadata Merging
 * ==========================================
 */

import { appState, showToast } from '../services/config.js';
import { parseMediaData } from '../utils/parseMedia.js';
import { requestLink } from './player.js';
import { fetchAnimeMapping } from '../api.js';
import { downloadFile } from '../pages/library.js';
import { getTmdbSeasonEpisodes, getTmdbShowDetails } from '../services/metadata.js';

//#region Data Grouping
const SWITCH_WORDS_REGEX = /(?:^|[\s._\-\[\]()])(MOVIE|OVA|OAD|ODA|ONA|SPECIAL|RECAP|SP|OPENING|NCOP|OP|ENDING|NCED|ED|THEME|PROMO|TEASER|TRAILER|PV|CM)(?:S?\d*[a-z]?)?(?=$|[\s._\-\[\]()])/i;

function preProcessEpisodeTorrentData(videoFiles) {
    const franchiseGroups = {};

    const groupLabels = {
        'TV': (s) => `Season ${s}`,
        'Movie': (s) => `🎥 Season ${s} - Movies`,
        'OVA': (s) => `⭐ Season ${s} - OVAs`,
        'Special': (s) => `⭐ Season ${s} - Specials`,
        'Theme': (s) => `🎵 Season ${s} - Openings & Endings`,
        'Trailer': (s) => `🎬 Season ${s} - Trailers & Extras`
    };

    videoFiles.forEach(file => {
        // Short name only has this episode's data
        const fileName = file.short_name || file.name;
        const parsedFile = parseMediaData(fileName);

        let fileSeason = parsedFile.seasons?.[0];
        if (fileSeason === undefined && file.name && file.name !== fileName) {
            fileSeason = parseMediaData(file.name)?.seasons?.[0];
        }
        if (fileSeason === undefined) {
            fileSeason = 1;
        }

        let fileEpisode = parsedFile.episodes?.[0];
        const sizeInMB = file.size / (1024 * 1024);

        // Look in fileName (fallback to full file.name) for any of the switch words
        const match = fileName.match(SWITCH_WORDS_REGEX) || file.name.match(SWITCH_WORDS_REGEX);
        const matchedWord = match ? match[1].toUpperCase() : 'TV';
        const fileTypeLabel = match
            ? match[0].replace(/^[\s._\-\[\]()]+|[\s._\-\[\]()]+$/g, '').toUpperCase()
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

        // Pack all files with the same season and main fileType together
        const groupKey = `S${fileSeason}_${fileType}`;

        if (!franchiseGroups[groupKey]) {
            franchiseGroups[groupKey] = {
                title: groupLabels[fileType] ? groupLabels[fileType](fileSeason) : `Season ${fileSeason} (${fileType})`,
                season: Number(fileSeason),
                fileType: fileType,
                files: []
            };
        }

        franchiseGroups[groupKey].files.push({
            originalFile: file,
            fileTitle: parsedFile.title,
            year: parsedFile.year,
            season: Number(fileSeason),
            episode: fileEpisode,
            fileType: fileType,
            fileTypeLabel: fileTypeLabel || fileType,
            isExtra: fileType === 'Trailer',
            sizeMB: sizeInMB.toFixed(2)
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
    const title = document.getElementById('picker-title');

    picker.classList.remove('hidden');
    list.innerHTML = `<div class="col-span-full flex justify-center p-10">...Loading Spinner...</div>`;

    const videoFiles = torrent.files.filter(f => f.name.match(/\.(mkv|mp4|avi|mov)$/i));
    const baseInfo = parseMediaData(torrent.name);
    const cleanName = baseInfo.title.replace(/(^\w|[\s-]\w)/g, m => m.toUpperCase());

    const franchiseGroups = preProcessEpisodeTorrentData(videoFiles);

    // Process TMDB metadata if we have a valid ID
    if (tmdbId) {
        const animeData = await fetchAnimeMapping(tmdbId);
        const showDetails = await getTmdbShowDetails(tmdbId);

        if (animeData) {
            const isAbsoluteAnime = Object.values(franchiseGroups).some(group =>
                group.fileType === 'TV' && group.files.some(f => f.season == 1 && parseInt(f.episode) > 30)
            );
        }

        if (showDetails && showDetails.seasons) {
            const showBackdrop = showDetails.backdrop_path
                ? `https://image.tmdb.org/t/p/w500${showDetails.backdrop_path}`
                : null;

            const seasonCache = {};

            for (const groupKey in franchiseGroups) {
                const group = franchiseGroups[groupKey];

                for (const file of group.files) {
                    if (file.fileType !== 'TV') {
                        file.displayThumbnail = showBackdrop;
                        continue;
                    }

                    let fetchSeason = file.season;
                    let targetEp = parseInt(file.episode);

                    if (!seasonCache[fetchSeason]) {
                        seasonCache[fetchSeason] = (await getTmdbSeasonEpisodes(tmdbId, fetchSeason)) || [];
                    }

                    const tmdbEpData = seasonCache[fetchSeason].find(ep => ep.episode_number === targetEp);

                    if (tmdbEpData) {
                        file.displayTitle = tmdbEpData.name;
                        file.displayThumbnail = tmdbEpData.still_path
                            ? `https://image.tmdb.org/t/p/w500${tmdbEpData.still_path}`
                            : showBackdrop;
                        file.relativeEpisode = targetEp;
                        file.displaySeason = fetchSeason;
                    } else if (showBackdrop) {
                        file.displayThumbnail = showBackdrop;
                    }
                }
            }
        }
    }

    renderPickerUI(torrent, franchiseGroups, title, list, cleanName);
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
function renderPickerUI(torrent, franchiseGroups, titleElement, listElement, cleanName) {
    const typePriority = {
        'TV': 1,
        'Movie': 2,
        'OVA': 3,
        'Special': 4,
        'Theme': 5,
        'Trailer': 6
    };

    // Sort groups so TV seasons appear first in ascending order, followed by Movies, OVAs, Specials, Themes, Trailers
    const sortedGroupKeys = Object.keys(franchiseGroups).sort((keyA, keyB) => {
        const groupA = franchiseGroups[keyA];
        const groupB = franchiseGroups[keyB];
        const typeDiff = (typePriority[groupA.fileType] || 99) - (typePriority[groupB.fileType] || 99);
        if (typeDiff !== 0) return typeDiff;
        return (groupA.season || 0) - (groupB.season || 0);
    });

    titleElement.innerHTML = `
        <div class="flex flex-wrap items-center w-full gap-3 overflow-hidden px-1">
            <span class="font-bold text-slate-200 text-lg truncate"> 
                ${cleanName}
            </span> 
            <div class="flex flex-wrap items-center gap-2">
                <div id="season-dropdown-container"></div>
            </div>
        </div>
    `;

    const seasonContainer = document.getElementById('season-dropdown-container');

    const renderGroup = (groupKey) => {
        listElement.replaceChildren();
        const groupData = franchiseGroups[groupKey];

        if (!groupData || groupData.files.length === 0) {
            listElement.innerHTML = `<div class="col-span-full text-center text-slate-400 py-10">No files found for this category.</div>`;
            return;
        }

        const filesToRender = [...groupData.files].sort((a, b) => {
            const valA = parseInt(a.episode);
            const valB = parseInt(b.episode);
            if (isNaN(valA) && isNaN(valB)) {
                return a.originalFile.name.localeCompare(b.originalFile.name);
            }
            return (isNaN(valA) ? 9999 : valA) - (isNaN(valB) ? 9999 : valB);
        });

        filesToRender.forEach((fileObj, index) => {
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

            const badgeColor = isExtra
                ? 'bg-emerald-600'
                : isOvaFile
                    ? 'bg-amber-600'
                    : isThemeFile
                        ? 'bg-purple-600'
                        : 'bg-blue-600';

            const fileSize = (originalFile.size / 1073741824).toFixed(2) + ' GB';
            const fallbackImage = document.getElementById(`img-${torrent.id}`)?.src || '';
            const cardImage = displayThumbnail || fallbackImage;

            const card = document.createElement('div');
            card.className = "relative flex flex-col w-full rounded-xl border-2 border-slate-700 bg-slate-800 overflow-hidden cursor-pointer hover:border-blue-500 transition-all group select-none";

            card.innerHTML = `
                <div class="relative aspect-video bg-slate-900 border-b border-slate-700 overflow-hidden">
                    <img src="${cardImage}" loading="lazy" class="w-full h-full object-cover opacity-60 group-hover:opacity-40 transition-opacity">
                    
                    <div class="absolute inset-0 flex items-center justify-center gap-4 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                        <button data-action="download" class="bg-slate-800/90 hover:bg-slate-700 text-white w-10 h-10 flex items-center justify-center rounded-full backdrop-blur-md transition-colors shadow-xl border border-slate-600" title="Download to Device">
                            <svg style="width:22px;height:22px;margin-top:2px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                        </button>
                        <div class="bg-blue-600/90 text-white w-10 h-10 flex items-center justify-center rounded-full backdrop-blur-md shadow-xl border border-blue-500 pointer-events-none">
                            <svg class="w-5 h-5 -rotate-90" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24">
                                <use href="#icon-arrow"></use>
                            </svg>
                        </div>
                    </div>

                    <div class="absolute bottom-2 right-2 bg-black/80 px-2 py-1 rounded text-[11px] text-white font-bold pointer-events-none">${fileSize}</div>
                </div>
                <div class="p-3 flex flex-col gap-1 pointer-events-none">
                    <span class="text-[10px] font-bold text-white px-2 py-0.5 rounded w-max ${badgeColor}">${badgeText}</span>
                    <p class="text-xs text-slate-300 line-clamp-2 mt-1 group-hover:text-white">${finalCardTitle}</p>
                </div>
            `;

            card.onclick = (e) => {
                const btn = e.target.closest('button');

                if (btn?.dataset.action === 'download') {
                    e.stopPropagation();
                    downloadFile(torrent.id, originalFile.id, torrent.name);
                    return;
                }

                if (btn) return;

                if (appState.clickCooldown) return;
                appState.clickCooldown = true;
                setTimeout(() => appState.clickCooldown = false, 2000);
                closePicker();
                requestLink(torrent.id, originalFile.id, torrent.name, originalFile.name);
            };

            listElement.appendChild(card);
        });
    };

    if (sortedGroupKeys.length > 1) {
        seasonContainer.innerHTML = `
            <select id="library-season-select" class="bg-slate-800 text-sm font-bold text-slate-200 border border-slate-600 rounded-lg p-1.5 outline-none cursor-pointer shadow-lg max-w-[220px] md:max-w-xs truncate">
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