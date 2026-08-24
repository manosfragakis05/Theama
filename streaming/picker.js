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

// Import the "Brain" functions we built in metadata.js
import { 
    getTmdbId, 
    getAnilistIdFromText, 
    getDirectSequel, 
    processKitsuFallback 
} from '../services/metadata.js';


//#region Data Grouping
function preProcessEpisodeTorrentData(videoFiles, mainShowTitle) {
    const franchiseGroups = {};

    videoFiles.forEach(file => {
        const fileData = parseMediaData(file.name);

        let mergedInfo = {
            title: fileData.title || mainShowTitle || 'Unknown',
            episode: fileData.episode || null,
            season: fileData.season || 1,
            year: parseInt(fileData.year || fileData.airDate, 10) || null,
            fileType: fileData.fileType || ''
        };

        const sizeInMB = file.size / (1024 * 1024);
        const fileType = mergedInfo.fileType.toUpperCase();
        let finalFileType = "TV";

        switch (fileType) {
            case 'MOVIE': finalFileType = 'Movie'; break;
            case 'OVA':
            case 'OAD':
            case 'ODA':
            case 'ONA': finalFileType = 'OVA'; break;
            case 'SPECIAL':
            case 'SP': finalFileType = 'Special'; break;
            case 'OP':
            case 'OPENING':
            case 'NCOP':
            case 'ED':
            case 'ENDING':
            case 'NCED':
            case 'THEME': finalFileType = 'Theme'; break;
            case 'PV':
            case 'PROMO':
            case 'TRAILER': finalFileType = 'Trailer'; break;
            case 'TV':
            default: finalFileType = 'TV'; break;
        }

        const cleanTitle = mergedInfo.title.toLowerCase().trim();

        if (!franchiseGroups[cleanTitle]) {
            franchiseGroups[cleanTitle] = {
                title: mergedInfo.title,
                files: []
            };
        }

        franchiseGroups[cleanTitle].files.push({
            originalFile: file,
            season: mergedInfo.season,
            episode: mergedInfo.episode,
            year: mergedInfo.year,
            fileType: finalFileType,
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
export async function openPicker(torrent) {
    const picker = document.getElementById('file-picker');
    const list = document.getElementById('picker-list');
    const title = document.getElementById('picker-title');

    picker.classList.remove('hidden');

    list.innerHTML = `
        <div class="col-span-full flex justify-center p-10">
            <svg class="animate-spin h-8 w-8 text-blue-500" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
        </div>
    `;

    const videoFiles = torrent.files.filter(f => f.name.match(/\.(mkv|mp4|avi|mov)$/i));
    const baseInfo = parseMediaData(torrent.name);
    const cleanName = baseInfo.title.replace(/(^\w|[\s-]\w)/g, match => match.toUpperCase());

    const vault = JSON.parse(localStorage.getItem('tmdb_vault') || '{}');
    const vaultData = vault[(torrent.hash || "").toLowerCase()];

    let tmdbId = vaultData ? vaultData.id : null;

    if (!tmdbId) {
        tmdbId = await getTmdbId(cleanName);
        console.log("Fetched TMDB id from fallback");
    }

    let animeIds = null;
    if (tmdbId) {
        try {
            animeIds = await fetchAnimeMapping(tmdbId);
        } catch (e) {
            console.error("API failed to find anime mappings:", e);
        }
    }

    let torrentType = "";
    if (animeIds) torrentType = "anime";

    const franchiseGroups = await preProcessEpisodeTorrentData(videoFiles, cleanName);

    const titledEpisodes = Object.keys(franchiseGroups).filter(key => {
        const group = franchiseGroups[key];
        return group.files.length <= 2 && group.files.some(f => f.fileType === "TV");
    });

    titledEpisodes.forEach(key => {
        const group = franchiseGroups[key];
        const sampleFile = group.files[0];
        const pathParts = sampleFile.originalFile.name.split('/');
        const isFlatDirectory = pathParts.length === 1;

        let realTitle = cleanName;

        if (!isFlatDirectory) {
            const parentFolder = pathParts[pathParts.length - 2];
            const folderData = parseMediaData(parentFolder);
            realTitle = folderData.title || cleanName;
        }

        const realTitleKey = realTitle.toLowerCase().trim();

        if (realTitleKey !== key) {
            if (!franchiseGroups[realTitleKey]) {
                franchiseGroups[realTitleKey] = {
                    title: realTitle,
                    files: []
                };
            }
            franchiseGroups[realTitleKey].files.push(...group.files);
            delete franchiseGroups[key];
        }
    });

    if (torrentType === "anime") {
        for (const groupKey in franchiseGroups) {
            const group = franchiseGroups[groupKey];
            group.seasonTitles = {};

            const searchableFiles = group.files.filter(f => f.fileType === 'TV' || f.fileType === 'Movie' || f.fileType === 'OVA');
            const uniqueSeasons = [...new Set(searchableFiles.map(f => f.season))].sort((a, b) => a - b);
            const coreSeasons = [...new Set(group.files.filter(f => f.fileType === 'TV' || f.fileType === 'Movie').map(f => f.season))].sort((a, b) => a - b);
            const isSingleSeasonOne = coreSeasons.length === 1 && (coreSeasons[0] === 1 || coreSeasons[0] === '1');

            for (const season of uniqueSeasons) {
                const targetFile = searchableFiles.find(f => f.season === season);
                let searchString = group.title;
                
                if (season > 1 && targetFile.fileType === 'TV') {
                    searchString += ` Season ${season}`;
                }

                let aniListMatch = await getAnilistIdFromText(searchString);
                let currentEpisodeCount = null;

                if (!aniListMatch) {
                    let polishedString = searchString.replace(/(Movie)\s*\d*\s*-?\s*/gi, '').trim();
                    aniListMatch = await getAnilistIdFromText(polishedString);
                }

                if (aniListMatch && aniListMatch.title) {
                    group.seasonTitles[season] = aniListMatch.title;
                    currentEpisodeCount = aniListMatch.officialEpisodeCount;
                }

                let finalAnilistId = aniListMatch?.id;
                const seasonFiles = group.files.filter(f => f.season === season);

                seasonFiles.forEach(file => {
                    file.displayTitle = null;
                    file.displayThumbnail = null;
                    file.displaySeason = file.season;
                    file.relativeEpisode = null;
                    file.metadataSource = "None";

                    if (file.fileType === 'Theme') {
                        file.displayTitle = file.originalFile.short_name;
                        file.metadataSource = "Local";
                    }
                });

                if (finalAnilistId) {
                    try {
                        const azRes = await fetch(`https://api.ani.zip/mappings?anilist_id=${finalAnilistId}`);
                        if (azRes.ok) {
                            const azData = await azRes.json();
                            const epDict = azData.episodes || {};

                            seasonFiles.forEach(file => {
                                if (file.fileType === 'Theme') return;

                                if (file.episode) {
                                    const epInt = parseInt(file.episode, 10);
                                    const epArray = Object.values(epDict);
                                    let matchedEp = null;

                                    if (isSingleSeasonOne && (file.season === 1)) {
                                        matchedEp = epDict[epInt];
                                    } else {
                                        matchedEp = epArray.find(ep => ep.episodeNumber === epInt) ||
                                                    epArray.find(ep => ep.absoluteEpisodeNumber === epInt) ||
                                                    epArray.find(ep => ep.episode === epInt.toString());
                                    }

                                    if (matchedEp && matchedEp.seasonNumber == file.season) {
                                        file.displayTitle = matchedEp.title?.en || matchedEp.title?.xIdx;
                                        file.displayThumbnail = matchedEp.image;
                                        file.relativeEpisode = matchedEp.episodeNumber;
                                    }
                                }
                            });

                            const otherPart = seasonFiles.filter(f => {
                                if (f.fileType === 'Theme' || f.displayTitle) return false;
                                if (!f.episode) return true;
                                if (f.fileType === 'TV') {
                                    const epInt = parseInt(f.episode, 10);
                                    return currentEpisodeCount && epInt > currentEpisodeCount;
                                }
                                return false;
                            });

                            if (otherPart.length > 0) {
                                const sequelData = await getDirectSequel(finalAnilistId);
                                if (sequelData) {
                                    try {
                                        const sequelAzRes = await fetch(`https://api.ani.zip/mappings?anilist_id=${sequelData.id}`);
                                        group.seasonTitles[`${season} (Part 2)`] = sequelData.title;
                                        if (sequelAzRes.ok) {
                                            const sequelAzData = await sequelAzRes.json();
                                            const sequelEpArray = Object.values(sequelAzData.episodes || {});

                                            otherPart.forEach(file => {
                                                if (file.episode) {
                                                    const localEpInt = parseInt(file.episode, 10);
                                                    const matchedEp = sequelEpArray.find(ep => ep.absoluteEpisodeNumber === localEpInt || ep.episodeNumber === localEpInt);

                                                    if (matchedEp) {
                                                        file.displayTitle = matchedEp.title?.en || matchedEp.title?.xIdx;
                                                        file.displayThumbnail = matchedEp.image;
                                                        file.relativeEpisode = matchedEp.episodeNumber;
                                                        file.displaySeason = `${season} (Part 2)`;
                                                    }
                                                } else {
                                                    file.displaySeason = `${season} (Part 2)`;
                                                }
                                            });
                                        }
                                    } catch (e) {
                                        console.warn(`⚠️ AniZip Sequel fetch failed for ID: ${sequelData.id}`);
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.warn(`⚠️ AniZip fetch failed for ID: ${finalAnilistId}`);
                    }
                }

                const kitsuQueue = seasonFiles.filter(f => !finalAnilistId || !f.displayTitle || !f.displayThumbnail);
                if (kitsuQueue.length > 0) {
                    await processKitsuFallback(kitsuQueue, group.title, season, animeIds?.kitsuId);
                }
            }
        }
    }

    renderPickerUI(torrent, franchiseGroups, title, list, cleanName);
}

export function closePicker() {
    document.getElementById('file-picker').classList.add('hidden');
}
//#endregion

//#region UI Rendering
function renderPickerUI(torrent, franchiseGroups, titleElement, listElement, cleanName) {
    console.log(cleanName);
    const groupKeys = Object.keys(franchiseGroups);
    const mainShowKey = groupKeys[0];

    if (mainShowKey && groupKeys.length > 1) {
        for (const key of groupKeys) {
            if (key !== mainShowKey && (
                franchiseGroups[key].files.every(f => f.fileType === 'OVA' || f.fileType === 'Special') ||
                franchiseGroups[key].files.every(f => f.fileType === 'Theme')
            )) {
                franchiseGroups[mainShowKey].files.push(...franchiseGroups[key].files);
                delete franchiseGroups[key];
            }
        }
    }

    const uniqueShows = Object.keys(franchiseGroups);
    let currentShowKey = uniqueShows[0];

    let showSelectorHTML = '';
    if (uniqueShows.length > 1) {
        showSelectorHTML = `
            <select id="library-show-select" class="bg-slate-800 text-sm font-bold text-blue-400 border border-slate-600 rounded-lg p-1.5 outline-none cursor-pointer shadow-lg">
                ${uniqueShows.map(key => `<option value="${key}">${franchiseGroups[key].title}</option>`).join('')}
            </select>
        `;
    }

    titleElement.innerHTML = `
        <div class="flex flex-wrap items-center w-full gap-3 overflow-hidden px-1">
            <span class="font-bold text-slate-200 text-lg truncate"> 
                ${cleanName}
            </span> 
            <div class="flex flex-wrap items-center gap-2">
                ${showSelectorHTML}
                <div id="season-dropdown-container"></div>
            </div>
        </div>
    `;

    const seasonContainer = document.getElementById('season-dropdown-container');

    const renderSeason = (showKey, seasonFilter) => {
        listElement.innerHTML = '';
        const showData = franchiseGroups[showKey];
        let filesToRender = [];

        if (seasonFilter === 'themes') {
            filesToRender = showData.files.filter(f => f.fileType === 'Theme');
        } else if (seasonFilter === 'ovas') {
            filesToRender = showData.files.filter(f => f.fileType === 'OVA' || f.fileType === 'Special');
        } else {
            filesToRender = showData.files.filter(f =>
                String(f.displaySeason || f.season) === String(seasonFilter) &&
                (f.fileType === 'TV' || f.fileType === 'Movie')
            );
        }

        filesToRender.sort((a, b) => {
            const valA = parseInt(a.episode);
            const valB = parseInt(b.episode);
            if (isNaN(valA) && isNaN(valB)) {
                return a.originalFile.name.localeCompare(b.originalFile.name);
            }
            return (isNaN(valA) ? 9999 : valA) - (isNaN(valB) ? 9999 : valB);
        });

        if (filesToRender.length === 0) {
            listElement.innerHTML = `<div class="col-span-full text-center text-slate-400 py-10">No files found for this category.</div>`;
            return;
        }

        filesToRender.forEach((fileObj, index) => {
            const { originalFile, episode, relativeEpisode, displayTitle, displayThumbnail, fileType } = fileObj;

            let isThemeFile = fileType === 'Theme';
            let isOvaFile = (fileType === 'OVA' || fileType === 'Special');

            let finalCardTitle = displayTitle || originalFile.short_name;
            let badgeText = isThemeFile ? '🎵 Theme' : (isOvaFile ? '⭐ Special' : `Episode ${relativeEpisode ?? episode ?? (index + 1)}`);
            let badgeColor = isThemeFile ? 'bg-emerald-600' : (isOvaFile ? 'bg-amber-600' : 'bg-blue-600');

            const fileSize = (originalFile.size / 1073741824).toFixed(2) + ' GB';
            const fallbackImage = document.getElementById(`img-${torrent.id}`)?.src || '';
            const cardImage = displayThumbnail || fallbackImage;

            const card = document.createElement('div');
            card.className = "relative flex flex-col w-full rounded-xl border-2 border-slate-700 bg-slate-800 overflow-hidden cursor-pointer hover:border-blue-500 transition-all group select-none";

            card.innerHTML = `
                <div class="relative aspect-video bg-slate-900 border-b border-slate-700 overflow-hidden">
                    <img src="${cardImage}" class="w-full h-full object-cover opacity-60 group-hover:opacity-40 transition-opacity">
                    
                    <div class="absolute inset-0 flex items-center justify-center gap-4 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                        <button onclick="event.stopPropagation(); downloadToOPFS(${torrent.id}, ${originalFile.id}, '${showData.title.replace(/'/g, "\\'")}', '${fallbackImage}', '${cardImage}', this);" class="bg-slate-800/90 hover:bg-slate-700 text-white w-10 h-10 flex items-center justify-center rounded-full backdrop-blur-md transition-colors shadow-xl border border-slate-600" title="Download to Device">
                            ⬇️
                        </button>
                        <div class="bg-blue-600/90 text-white w-10 h-10 flex items-center justify-center rounded-full backdrop-blur-md shadow-xl border border-blue-500 pointer-events-none">
                            ▶️
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
                if (e.target.closest('button')) return;

                if (appState.clickCooldown) return;
                appState.clickCooldown = true; setTimeout(() => appState.clickCooldown = false, 2000);
                closePicker();
                requestLink(torrent.id, originalFile.id, torrent.name, originalFile.name);
            };

            listElement.appendChild(card);
        });
    };

    const updateSeasonDropdown = (showKey) => {
        const showData = franchiseGroups[showKey];
        const hasOvas = showData.files.some(f => f.fileType === 'OVA' || f.fileType === 'Special');
        const hasThemes = showData.files.some(f => f.fileType === 'Theme');

        const standardSeasons = [...new Set(showData.files.filter(f => f.fileType === 'TV' || f.fileType === 'Movie').map(f => f.displaySeason || f.season))].sort((a, b) => {
            const numA = parseFloat(a);
            const numB = parseFloat(b);
            if (numA === numB) {
                return a.toString().localeCompare(b.toString());
            }
            return numA - numB;
        });

        let defaultSelection = standardSeasons.length > 0 ? standardSeasons[0] : (hasOvas ? 'ovas' : 'themes');
        const totalTabs = standardSeasons.length + (hasOvas ? 1 : 0) + (hasThemes ? 1 : 0);

        if (totalTabs > 1) {
            seasonContainer.innerHTML = `
                <select id="library-season-select" class="bg-slate-800 text-sm font-bold text-slate-200 border border-slate-600 rounded-lg p-1.5 outline-none cursor-pointer shadow-lg max-w-[180px] md:max-w-xs truncate">
                    ${standardSeasons.map(s => {
                        const customTitle = showData.seasonTitles?.[s];
                        const displayLabel = customTitle ? customTitle : `Season ${s}`;
                        return `<option value="${s}">${displayLabel}</option>`;
                    }).join('')}
                    ${hasOvas ? `<option value="ovas">⭐ Specials / OVAs</option>` : ''}
                    ${hasThemes ? `<option value="themes">🎵 Themes & Extras</option>` : ''}
                </select>
            `;

            document.getElementById('library-season-select').addEventListener('change', (e) => {
                renderSeason(showKey, e.target.value);
            });
        } else {
            seasonContainer.innerHTML = '';
        }

        renderSeason(showKey, defaultSelection);
    };

    if (uniqueShows.length > 1) {
        document.getElementById('library-show-select').addEventListener('change', (e) => {
            currentShowKey = e.target.value;
            updateSeasonDropdown(currentShowKey);
        });
    }

    updateSeasonDropdown(currentShowKey);
}
//#endregion