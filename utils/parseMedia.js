/**
 * Dependency-free ES module for release-name metadata (not media inspection).
 *
 * parseTorrentTitle(string): packs, season lists/ranges and single releases.
 * parseFileTitle(string): basename only; explicit or absolute episode numbering.
 * parseMediaData / parseFileData are aliases for existing integrations.
 *
 * Unknown scalar values are null; collections are always arrays. `season` and
 * `episode` are populated only when unambiguous. Use `seasons`, `episodes` and
 * `episodePairs` for packs/multi-episode files. No season 1 is invented for anime.
 * Quality/tier describe filename tags, not measured encoding or audio quality.
 */

const unique = values => [...new Set(values)];
const numbers = values => unique(values).sort((a, b) => a - b);
const single = values => values.length === 1 ? values[0] : null;
const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const at = match => ({ start: match.index, end: match.index + match[0].length });
const SEP = '[ ._-]*';
const LEFT = '(?<![\\p{L}\\p{N}])';
const RIGHT = '(?![\\p{L}\\p{N}])';
const token = (body, flags = 'giu') => new RegExp(`${LEFT}(?:${body})${RIGHT}`, flags);
const numberToken = (body, nextLabel) => new RegExp(`${LEFT}(?:${body})(?=$|[^\\p{L}\\p{N}]|${nextLabel}\\d)`, 'giu');
const MAX_RANGE_SIZE = 1000;
const EXTENSION = /\.(mkv|mp4|m4v|avi|mov|wmv|webm|ts|m2ts|mts|mpg|mpeg|vob|ogm|ogv|flv|iso|srt|ass|ssa|vtt|sub|torrent)$/i;

// The order matters: consume specific codecs before their shorter aliases.
const TECH_RULES = [
    ['resolution', '(?:4320|2160|1440|1080|720|576|540|480|360)[pi]', m => m[0].toLowerCase()],
    ['resolution', '(?:8|4)k', m => m[0][0] === '8' ? '4320p' : '2160p'],
    ['resolution', '(?:7680|3840|1920|1280|720)[x×](?:4320|2160|1080|720|576|480)', m => `${m[0].split(/[x×]/i)[1]}p`],
    ['videoCodec', `(?:[hx]${SEP}265|HEVC)`, 'H.265'],
    ['videoCodec', `(?:[hx]${SEP}264|AVC)`, 'H.264'],
    ['videoCodec', 'AV1', 'AV1'],
    ['videoCodec', `(?:[hx]${SEP}266|VVC)`, 'H.266'],
    ['videoCodec', `VP${SEP}9`, 'VP9'],
    ['videoCodec', 'XviD', 'XviD'],
    ['videoCodec', 'DivX', 'DivX'],
    ['videoCodec', `MPEG${SEP}2`, 'MPEG-2'],
    ['videoCodec', `VC${SEP}1`, 'VC-1'],
    ['quality', '(?:BD|UHD|4K)?REMUX', 'REMUX'],
    ['quality', `(?:Blu${SEP}Ray|BDMV|BDISO)`, 'BluRay'],
    ['quality', 'BDRip', 'BDRip'],
    ['quality', 'BRRip', 'BRRip'],
    ['quality', `WEB${SEP}DL`, 'WEB-DL'],
    ['quality', `WEB${SEP}Rip`, 'WEBRip'],
    ['quality', 'HDTV', 'HDTV'],
    ['quality', 'PDTV', 'PDTV'],
    ['quality', 'TVRip', 'TVRip'],
    ['quality', 'HDRip', 'HDRip'],
    ['quality', 'DVDRip', 'DVDRip'],
    ['quality', '(?:DVD|BD)SCR', 'Screener'],
    ['quality', 'DVD(?:5|9)?', 'DVD'],
    ['quality', '(?:HDCAM|CAMRip)', 'CAM'],
    ['quality', '(?:HDTS|TELESYNC)', 'TS'],
    ['quality', '(?:HDTC|TELECINE)', 'TC'],
    ['quality', 'WEB', 'WEB', true],
    ['quality', 'CAM', 'CAM', true],
    ['quality', 'TS', 'TS', true],
    ['quality', 'TC', 'TC', true],
    ['audioCodec', `DTS${SEP}HD${SEP}(?:MA|Master${SEP}Audio)`, 'DTS-HD MA'],
    ['audioCodec', `DTS${SEP}HD${SEP}(?:HRA|HR)`, 'DTS-HD HRA'],
    ['audioCodec', `DTS${SEP}HD`, 'DTS-HD'],
    ['audioCodec', 'DTS[ ._:-]*X', 'DTS:X'],
    ['audioCodec', `(?:True${SEP}HD|Dolby${SEP}TrueHD)`, 'TrueHD'],
    ['audioCodec', `(?:DDP|DD[+]|E${SEP}AC${SEP}3|Dolby${SEP}Digital${SEP}Plus)`, 'E-AC-3'],
    ['audioCodec', `(?:AC${SEP}3|Dolby${SEP}Digital)`, 'AC-3'],
    ['audioCodec', 'DD', 'AC-3', true],
    ['audioCodec', 'DTS', 'DTS'],
    ['audioCodec', `(?:HE${SEP}AAC|AAC(?:${SEP}LC)?)`, 'AAC'],
    ['audioCodec', 'FLAC', 'FLAC'],
    ['audioCodec', '(?:LPCM|PCM)', 'PCM'],
    ['audioCodec', 'ALAC', 'ALAC'],
    ['audioCodec', 'OPUS', 'Opus'],
    ['audioCodec', 'MP3', 'MP3'],
    ['audioFeature', `(?:Dolby${SEP})?Atmos`, 'Dolby Atmos'],
    ['dynamicRange', `(?:Dolby${SEP}Vision|DoVi)`, 'Dolby Vision'],
    ['dynamicRange', 'DV', 'Dolby Vision', true],
    ['dynamicRange', 'HDR10(?:[+]|Plus)', 'HDR10+'],
    ['dynamicRange', 'HDR10', 'HDR10'],
    ['dynamicRange', 'HDR', 'HDR'],
    ['dynamicRange', 'HLG', 'HLG'],
    ['dynamicRange', 'SDR', 'SDR', true],
    ['bitDepth', `(?:8|10|12)${SEP}bit|Hi10P`, m => /^Hi/i.test(m[0]) ? 10 : parseInt(m[0], 10)],
    ['other', 'UHD', 'UHD', true],
    ['other', '(?:REPACK|PROPER|RERIP|INTERNAL|READNFO|UNCUT|REMASTERED|EXTENDED|IMAX)', m => m[0].toUpperCase(), true],
    ['other', `(?:Director'?s|Theatrical|Extended)${SEP}(?:Cut|Edition)`, m => m[0], true],
    ['other', '(?:AMZN|NF|NETFLIX|ATVP|DSNP|HMAX|HULU|PCOK|PMTP|CR)', m => m[0].toUpperCase(), true],
];

const COMPILED_TECH_RULES = TECH_RULES.map(([kind, body, value, weak = false]) => {
    // Audio channels can be attached directly: DDP2.0, AAC5.1, TrueHD7.1.
    const right = kind === 'audioCodec'
        ? '(?=$|[^\\p{L}\\p{N}]|[1-8][ ._][01](?!\\d))' : RIGHT;
    return { kind, value, weak, regex: new RegExp(`${LEFT}(?:${body})${right}`, 'giu') };
});

function scanTechnical(text) {
    const tags = [];
    for (const { kind, value, weak, regex } of COMPILED_TECH_RULES) {
        for (const match of text.matchAll(regex)) {
            const span = at(match);
            if (tags.some(tag => overlaps(tag, span))) continue;
            const attachedChannels = kind === 'audioCodec' && /^[1-8][ ._][01](?!\d)/.test(text.slice(span.end));
            tags.push({ ...span, kind, value: typeof value === 'function' ? value(match) : value, weak: weak && !attachedChannels });
        }
    }
    return tags.sort((a, b) => a.start - b.start);
}

function expandRange(first, last, warnings, kind) {
    if (last < first || last - first + 1 > MAX_RANGE_SIZE) {
        warnings.push(`${kind}-range-${last < first ? 'reversed' : 'too-large'}`);
        return numbers([first, last]);
    }
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

// A dash expands a range; commas, ampersands, + and repeated E/S markers are lists.
function readTail(text, end, first, kind, warnings) {
    const label = kind === 'season' ? '(?:seasons?|s)' : '(?:episodes?|eps?|e)';
    const digits = kind === 'season' ? 2 : 4;
    const delimiter = '(?:([-~–—]|to)|([,&+]|and))';
    const endNumber = `(?=$|[^\\p{L}\\p{N}]|${label}\\d)`;
    const next = new RegExp(`^[ ._]*${delimiter}[ ._]*(?:${label}[ ._-]*)?(\\d{1,${digits}})${endNumber}`, 'iu');
    const repeated = new RegExp(`^[ ._]*${label}[ ._-]*(\\d{1,${digits}})${endNumber}`, 'iu');
    const values = [first];
    let previous = first;
    let match;
    while ((match = next.exec(text.slice(end))) || (match = repeated.exec(text.slice(end)))) {
        const value = Number(match[3] ?? match[1]);
        if (match[3] !== undefined && match[1]) values.push(...expandRange(previous, value, warnings, kind));
        else values.push(value);
        previous = value;
        end += match[0].length;
    }
    return { values: numbers(values), end };
}

function extractNumbering(text, mode, technical) {
    const warnings = [];
    const spans = [];
    const pairs = [];
    const seasons = [];
    const episodes = [];
    let absolute = false;
    let version = null;
    let date = null;
    const addEpisodes = (match, season, first, end = at(match).end) => {
        const tail = readTail(text, end, first, 'episode', warnings);
        spans.push({ start: match.index, end: tail.end, kind: 'episode' });
        if (season !== null) seasons.push(season);
        episodes.push(...tail.values);
        for (const episode of tail.values) pairs.push({ season, episode });
    };

    // Explicit season/episode pairs have priority over every bare-number heuristic.
    const pairPatterns = [
        numberToken(`s(?:eason)?[ ._-]*(\\d{1,2})[ ._-]*e(?:pisodes?|ps?)?[ ._-]*(\\d{1,4})(?:v(\\d+))?`, 'e'),
        token('(\\d{1,2})x(\\d{1,4})(?:v(\\d+))?'),
    ];
    for (const pattern of pairPatterns) {
        for (const match of text.matchAll(pattern)) {
            if (spans.some(span => overlaps(span, at(match)))) continue;
            addEpisodes(match, Number(match[1]), Number(match[2]));
            if (match[3]) version = Number(match[3]);
        }
    }
    // Fully repeated endpoints: S01E01-S01E03. Cross-season endpoints are not expanded.
    const pairedSpans = [...spans].sort((a, b) => a.start - b.start);
    for (let i = 1; i < pairedSpans.length; i++) {
        const left = pairedSpans[i - 1], right = pairedSpans[i];
        if (!/^[ ._]*[-~–—][ ._]*$/.test(text.slice(left.end, right.start))) continue;
        const a = text.slice(left.start, left.end).match(/(?:s(?:eason)?[ ._-]*|^)(\d{1,2})(?:[ ._-]*e(?:pisodes?|ps?)?[ ._-]*|x)(\d{1,4})/i);
        const b = text.slice(right.start, right.end).match(/(?:s(?:eason)?[ ._-]*|^)(\d{1,2})(?:[ ._-]*e(?:pisodes?|ps?)?[ ._-]*|x)(\d{1,4})/i);
        if (a && b && Number(a[1]) === Number(b[1])) {
            for (const episode of expandRange(Number(a[2]), Number(b[2]), warnings, 'episode')) {
                episodes.push(episode);
                pairs.push({ season: Number(a[1]), episode });
            }
        } else warnings.push('cross-season-episode-range');
    }

    // Season collections belong to torrents. For files we detect the ambiguity
    // but never describe a filename as a complete season/series.
    for (const match of text.matchAll(numberToken('(?:seasons?|s)[ ._-]*(\\d{1,2})', 's'))) {
        if (spans.some(span => overlaps(span, at(match)))) continue;
        const tail = readTail(text, at(match).end, Number(match[1]), 'season', warnings);
        seasons.push(...tail.values);
        spans.push({ start: match.index, end: tail.end, kind: 'season' });
    }
    for (const match of text.matchAll(numberToken('(?:episodes?|eps?|e)[ ._-]*(\\d{1,4})(?:v(\\d+))?', 'e'))) {
        if (spans.some(span => overlaps(span, at(match)))) continue;
        addEpisodes(match, single(numbers(seasons)), Number(match[1]));
        if (match[2]) version = Number(match[2]);
    }

    if (!episodes.length) {
        const datePattern = token('(19\\d{2}|20\\d{2})[ ._-](\\d{2})[ ._-](\\d{2})');
        for (const match of text.matchAll(datePattern)) {
            const [year, month, day] = match.slice(1).map(Number);
            const value = new Date(Date.UTC(year, month - 1, day));
            if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) continue;
            date = `${match[1]}-${match[2]}-${match[3]}`;
            spans.push({ ...at(match), kind: 'date' });
            break;
        }
    }
    if (!episodes.length && !date) {
        // Fansub form: "Anime - 012v2 [1080p]". A naked "1917" remains a title.
        const anime = /(?:^|\s)[-–—]\s+(\d{1,4})(?:v(\d+))?(?=$|[\s[(_-])/iu;
        let match = anime.exec(text);
        if (match && spans.some(span => overlaps(span, at(match)))) match = null;
        if (!match && mode === 'file') {
            // Filename-only "03 - Episode name.mkv" / "001.mkv".
            match = /^(\d{1,3})(?:v(\d+))?(?=$|[ ._-])/iu.exec(text);
            if (match) {
                const after = text.slice(at(match).end);
                const nextTag = technical.find(tag => tag.start >= at(match).end);
                const gap = text.slice(at(match).end, nextTag?.start ?? text.length);
                // "300 (2006)" / "12 Monkeys" are movies, not episodes 300 / 12.
                if (after.trim() && !/^[ ._]*[-–—]\s*\D/u.test(after) && !(nextTag && /^[\s.\-_[\](){}]*$/.test(gap))) match = null;
            }
        }
        if (match && !technical.some(tag => overlaps(tag, at(match)))) {
            const after = text.slice(at(match).end);
            // Do not mistake a release year or bare trailing sequel number for an episode.
            const number = Number(match[1]);
            const evidence = mode === 'file' || technical.some(tag => tag.start >= at(match).end) || /^\s*[[(]/.test(after);
            if (evidence && !(number >= 1888 && number <= 2099)) {
                absolute = true;
                addEpisodes(match, single(numbers(seasons)), number);
                if (match[2]) version = Number(match[2]);
            }
        }
    }

    // "Anime 01-12 [1080p]" is a batch only at the end of the title portion.
    if (mode === 'torrent' && !episodes.length && !seasons.length && !date) {
        const batch = /(?<![\p{L}\p{N}])(\d{1,3})\s*[-~–—]\s*(\d{1,3})(?=$|[\s[(_])/giu;
        for (const match of text.matchAll(batch)) {
            if (technical.some(tag => overlaps(tag, at(match)))) continue;
            const nextTag = technical.find(tag => tag.start >= at(match).end);
            const gap = text.slice(at(match).end, nextTag?.start ?? text.length);
            if (!/^[\s.\-_[\](){}]*(?:END|COMPLETE|BATCH)?[\s.\-_[\](){}]*$/i.test(gap)) continue;
            absolute = true;
            episodes.push(...expandRange(Number(match[1]), Number(match[2]), warnings, 'episode'));
            spans.push({ ...at(match), kind: 'episode' });
            for (const episode of episodes) pairs.push({ season: null, episode });
            break;
        }
    }
    const seasonValues = numbers(seasons);
    if (mode === 'file' && seasonValues.length > 1) warnings.push('multiple-seasons-in-file');
    return {
        seasons: seasonValues, episodes: numbers(episodes), spans,
        episodePairs: [...new Map(pairs.map(pair => [`${pair.season}:${pair.episode}`, pair])).values()]
            .sort((a, b) => (a.season ?? -1) - (b.season ?? -1) || a.episode - b.episode),
        absolute, date, version, warnings,
    };
}

function findYear(text, numbering, technical) {
    const limit = Math.min(text.length, ...numbering.spans.map(s => s.start), ...technical.filter(t => !t.weak && t.start > 0).map(t => t.start));
    const yearBody = '(?:18[89]\\d|19\\d{2}|20\\d{2})';
    for (const match of text.matchAll(token(`(${yearBody})[ ._]*[-–—~][ ._]*(${yearBody})`))) {
        const first = Number(match[1]), last = Number(match[2]);
        const before = text.slice(0, match.index).replace(/[\s._([{-]+$/g, '');
        const after = text.slice(at(match).end, limit);
        if (before && last >= first && at(match).end <= limit && !/[\p{L}]/u.test(after)) {
            return { ...at(match), value: first, range: [first, last] };
        }
    }
    const candidates = [...text.matchAll(token('(?:18[89]\\d|19\\d{2}|20\\d{2})'))].filter(match => {
        if (match.index >= limit || numbering.spans.some(span => overlaps(span, at(match)))) return false;
        const before = text.slice(0, match.index).replace(/[\s._([{-]+$/g, '');
        if (!before) return false; // 1917, 1923, 2001: A Space Odyssey.
        if (/\b(?:of|in|since|from|to)\s*$/i.test(before)) return false;
        // Unbracketed numbers followed by title words are part of the title.
        const yearEnd = at(match).end;
        let after = text.slice(yearEnd, limit);
        const bracketed = /[[(]\s*$/.test(text.slice(0, match.index)) && /^\s*[)\]]/.test(after);
        for (const tag of technical.filter(tag => tag.start >= yearEnd && tag.end <= limit).sort((a, b) => b.start - a.start)) {
            after = after.slice(0, tag.start - yearEnd) + ' '.repeat(tag.end - tag.start) + after.slice(tag.end - yearEnd);
        }
        for (const [, body] of LANGUAGE_RULES) after = after.replace(token(body), '');
        after = after.replace(/\b(?:COMPLETE|SERIES|COLLECTION|FULL|BATCH|MULTI|DUAL|AUDIO|SUBS?|SUBBED|DUBBED|UNRATED)\b/gi, '');
        return bracketed || !/[\p{L}]/u.test(after);
    });
    const match = candidates.at(-1);
    return match ? { ...at(match), value: Number(match[0]) } : null;
}

function cleanTitle(text) {
    return text.replace(/[._]+/g, ' ')
        .replace(/\s*[[(]\s*$/g, '')
        .replace(/\(\s*\)|\[\s*\]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s\-–—|,;:]+|[\s\-–—|,;:]+$/g, '').trim();
}

function formatNumbers(values) {
    if (!values.length) return '';
    const parts = [];
    let start = values[0], end = start;
    for (let i = 1; i <= values.length; i++) {
        if (values[i] === end + 1) { end = values[i]; continue; }
        parts.push(start === end ? `${start}` : `${start}-${end}`);
        start = end = values[i];
    }
    return parts.join(', ');
}

const LANGUAGE_RULES = [
    ['English', 'English|ENG|EN', ['🇬🇧', '🇺🇸']],
    ['French', 'French|FRE|FRA|FR|VFF|VFQ|TRUEFRENCH', ['🇫🇷']],
    ['Spanish', 'Spanish|SPA|ESP|Castellano|Latino', ['🇪🇸', '🇲🇽']],
    ['Italian', 'Italian|ITA', ['🇮🇹']],
    ['Russian', 'Russian|RUS', ['🇷🇺']],
    ['German', 'German|GER|DEU', ['🇩🇪']],
    ['Portuguese', 'Portuguese|POR|PT[ ._-]?BR', ['🇵🇹', '🇧🇷']],
    ['Japanese', 'Japanese|JPN|JAP', ['🇯🇵']],
    ['Korean', 'Korean|KOR', ['🇰🇷']],
    ['Hindi', 'Hindi|HIN', ['🇮🇳']],
    ['Tamil', 'Tamil|TAM', []], ['Telugu', 'Telugu|TEL', []],
    ['Chinese', 'Chinese|CHI|ZHO|Mandarin|Cantonese', ['🇨🇳', '🇹🇼', '🇭🇰']],
    ['Dutch', 'Dutch|DUT|NLD', ['🇳🇱']], ['Polish', 'Polish|POL', ['🇵🇱']],
    ['Romanian', 'Romanian|RON|RUM', ['🇷🇴']], ['Greek', 'Greek|GRE|ELL', ['🇬🇷']],
    ['Danish', 'Danish|DAN', ['🇩🇰']], ['Finnish', 'Finnish|FIN', ['🇫🇮']],
    ['Swedish', 'Swedish|SWE', ['🇸🇪']], ['Norwegian', 'Norwegian|NOR', ['🇳🇴']],
    ['Turkish', 'Turkish|TUR', ['🇹🇷']], ['Arabic', 'Arabic|ARA', ['🇸🇦']],
    ['Hebrew', 'Hebrew|HEB', ['🇮🇱']], ['Indonesian', 'Indonesian|IND', ['🇮🇩']],
    ['Thai', 'Thai|THA', ['🇹🇭']], ['Ukrainian', 'Ukrainian|UKR', ['🇺🇦']],
];

function extractLanguages(text) {
    const languages = LANGUAGE_RULES.filter(([, body, flags]) =>
        token(body, 'iu').test(text) || flags.some(flag => text.includes(flag))).map(([name]) => name);
    const multiSubs = /\bmulti[ ._-]*subs?\b/i.test(text);
    const dualAudio = /\bdual(?:[ ._-]*audio)?\b/i.test(text);
    const multiAudio = /\bmulti[ ._-]*(?:audio|dub(?:bed)?)\b/i.test(text);
    const plainMulti = /\bmulti\b(?![ ._-]*subs?\b)/i.test(text);
    const multi = multiAudio || plainMulti ? 'Multi' : dualAudio ? 'Dual'
        : /\bdubbed\b/i.test(text) ? 'Dubbed' : /\b(?:subbed|subtitles|multi[ ._-]*subs?)\b/i.test(text) ? 'Subbed' : null;
    return { languages, multi, multiAudio, dualAudio, multiSubs };
}

function prepareInput(rawString, mode) {
    if (rawString == null) rawString = '';
    if (typeof rawString !== 'string') throw new TypeError('Expected a torrent title or filename string');
    let text = rawString.normalize('NFC').replace(/\u00a0/g, ' ').trim();
    text = text.split(/\r?\n/).find(line => line.trim())?.trim() ?? '';
    text = text.replace(/^[\s📁📂📄🎬🎞️]+/u, '');
    if (mode === 'file') text = text.split(/[\\/]/).at(-1);
    // Stream-description footer; never let seeders/size become part of the title.
    text = text.split(/[👤💾⚙️]/u)[0].trim();
    const extension = text.match(EXTENSION)?.[1].toLowerCase() ?? null;
    text = text.replace(EXTENSION, '').trim();
    let releaseGroup = null;
    const prefixMetadata = [];
    while (/^\[[^\]]+\]\s*\S/.test(text)) {
        const match = /^\[([^\]]+)\][ ._-]*/.exec(text);
        if (!match) break;
        // Move technical prefix brackets to the metadata tail, preserving their
        // values without letting "[1080p] Movie" produce an empty clean title.
        const language = extractLanguages(match[1]);
        if (scanTechnical(match[1]).length || language.multi || language.languages.length) prefixMetadata.push(match[1]);
        else if (!/^(?:REQ|REQUEST|www\.|https?:)/i.test(match[1])) releaseGroup ??= match[1].trim();
        text = text.slice(match[0].length);
    }
    if (prefixMetadata.length) text += ` [${prefixMetadata.join('] [')}]`;
    return { text, extension, releaseGroup };
}

function parseRelease(rawString, mode) {
    const input = prepareInput(rawString, mode);
    const { text } = input;
    const scanned = scanTechnical(text);
    const numbering = extractNumbering(text, mode, scanned);
    const yearMatch = findYear(text, numbering, scanned);
    const structuralStart = Math.min(text.length, yearMatch?.start ?? Infinity, ...numbering.spans.map(s => s.start));
    const strongStart = Math.min(text.length, ...scanned.filter(tag => !tag.weak && tag.start > 0).map(tag => tag.start));
    const boundary = Math.min(structuralStart, strongStart);
    const technical = scanned.filter(tag => {
        if (!tag.weak) return true;
        // Don't call "The French Connection" French or "CAM (2018)" a CAM rip.
        if (structuralStart < text.length) return tag.start >= structuralStart;
        const gap = text.slice(tag.end, boundary);
        return boundary < text.length && /^[\s.\-_[\](){}]*$/.test(gap);
    });
    const values = kind => unique(technical.filter(tag => tag.kind === kind).map(tag => tag.value));
    const seasons = numbering.seasons;
    const episodes = numbering.episodes;
    const season = single(seasons);
    const episode = single(episodes);
    const warnings = [...numbering.warnings];

    const completeSeriesMatch = /\b(?:the[ ._-]+)?(?:complete[ ._-]+(?:series|collection)|full[ ._-]+series)\b/i.exec(text);
    const packMatch = /\b(?:complete[ ._-]+season|season[ ._-]+pack|batch)\b/i.exec(text);
    const isCompleteSeries = mode === 'torrent' && Boolean(completeSeriesMatch);
    const isSeasonPack = mode === 'torrent' && (isCompleteSeries || Boolean(packMatch) || (seasons.length > 0 && episodes.length === 0));
    const isEpisodePack = mode === 'torrent' && episodes.length > 1;
    const complete = mode === 'torrent' && (isCompleteSeries || ((isSeasonPack || isEpisodePack) && /\bcomplete\b/i.test(text)));
    let seasonDetails = null;
    if (mode === 'torrent') {
        if (isCompleteSeries) seasonDetails = 'COMPLETE SERIES';
        else if (seasons.length > 1) seasonDetails = `SEASONS ${formatNumbers(seasons)}`;
        else if (isSeasonPack && season !== null) seasonDetails = `${complete ? 'FULL SEASON' : 'SEASON'} ${season}`;
        else if (isEpisodePack) seasonDetails = `EPISODES ${formatNumbers(episodes)}`;
        else if (isSeasonPack) seasonDetails = 'SEASON PACK';
    }

    const titleEnd = Math.min(text.length, yearMatch?.start ?? Infinity,
        ...numbering.spans.map(s => s.start), ...technical.map(tag => tag.start),
        ...(mode === 'torrent' ? [completeSeriesMatch?.index ?? Infinity, packMatch?.index ?? Infinity] : []));
    let title = cleanTitle(text.slice(0, titleEnd));
    // Bracketed suffixes after a recognized boundary are intentionally discarded;
    // parentheses within the actual title (e.g. "It (US)") are retained.
    title = title.replace(/\s*\[[a-f\d]{8}\]\s*$/i, '').trim();

    const metadataText = text.slice(titleEnd);
    const languageData = extractLanguages(metadataText);
    const resolutionValues = values('resolution');
    // Explicit heights override marketing aliases like 4K when they disagree.
    const heights = unique(technical.filter(t => t.kind === 'resolution' && /^\d+[pi]$/i.test(text.slice(t.start, t.end))).map(t => t.value));
    const resolutions = heights.length ? heights : resolutionValues;
    if (resolutionValues.some(value => !resolutions.includes(value))) warnings.push('conflicting-resolution-tags');
    const videoCodecs = values('videoCodec');
    const videoCodec = single(videoCodecs);
    const audioCodecs = values('audioCodec');
    const audioFeatures = values('audioFeature');
    if (audioCodecs.includes('DTS:X')) audioFeatures.push('DTS:X');
    const audioChannels = [];
    const channelRegex = /(?<!\d)([1-8])[ ._]([01])(?:[ ._]([2-6]))?(?![\p{L}\p{N}])/gu;
    for (const match of text.matchAll(channelRegex)) {
        if (match.index < titleEnd || numbering.spans.some(span => overlaps(span, at(match))) || technical.some(tag => tag.kind !== 'audioCodec' && overlaps(tag, at(match)))) continue;
        const nearby = technical.some(tag => ['audioCodec', 'audioFeature'].includes(tag.kind) && tag.end <= match.index && /^[\s.\-_[\](){}]*$/.test(text.slice(tag.end, match.index)));
        const dotted = match[0].includes('.') || match[0].includes('_');
        if (nearby || (dotted && !/[\p{L}\p{N}]/u.test(text[match.index - 1] ?? ''))) audioChannels.push(match.slice(1).filter(Boolean).join('.'));
    }
    let dynamicRange = values('dynamicRange');
    if (dynamicRange.includes('HDR10') || dynamicRange.includes('HDR10+')) dynamicRange = dynamicRange.filter(tag => tag !== 'HDR');
    const qualities = values('quality');
    const remux = qualities.includes('REMUX');
    const sources = qualities.filter(quality => quality !== 'REMUX');
    const sourceName = single(sources);
    const quality = remux ? `${sourceName ? `${sourceName} ` : ''}REMUX` : sourceName;
    if (sources.length > 1) warnings.push('multiple-source-tags');
    const sourceTier = remux || ['BluRay', 'WEB-DL'].includes(sourceName) ? 'Premium' : 'Standard';
    const lossless = ['TrueHD', 'DTS-HD MA', 'FLAC', 'PCM', 'ALAC'];
    const audioTier = audioCodecs.some(codec => lossless.includes(codec)) ? 'Lossless'
        : audioCodecs.length || audioFeatures.length ? 'Premium' : 'Standard';
    let releaseGroup = input.releaseGroup;
    const suffix = /-([\p{L}\d][\p{L}\d._]{1,39})(?:\s*\[[a-f\d]{8}\])?$/iu.exec(text);
    if (!releaseGroup && suffix && suffix.index >= titleEnd && !technical.some(tag => overlaps(tag, at(suffix)))) releaseGroup = suffix[1];
    if (videoCodecs.length > 1) warnings.push('multiple-video-codecs');
    if (resolutions.length > 1) warnings.push('multiple-resolutions');

    return {
        title, year: yearMatch?.value ?? null, yearRange: yearMatch?.range ?? null,
        season, seasons, episode, episodes, episodePairs: numbering.episodePairs,
        absoluteEpisode: numbering.absolute ? episode : null,
        absoluteEpisodes: numbering.absolute ? [...episodes] : [],
        date: numbering.date, episodeVersion: numbering.version,
        seasonDetails, isSeasonPack, isEpisodePack, isCompleteSeries, complete,
        resolution: single(resolutions), resolutions,
        quality, qualities, source: { source: remux ? 'Remux' : sourceName ?? 'Unknown', tier: sourceTier },
        videoCodec, videoCodecs,
        videoType: videoCodec === 'H.265' ? 'HEVC/x265' : videoCodec === 'H.264' ? 'x264' : videoCodec,
        audioType: { codecs: unique([...audioCodecs, ...audioFeatures]), tier: audioTier },
        audioCodecs, audioFeatures: unique(audioFeatures), audioChannels: unique(audioChannels),
        dynamicRange, bitDepth: single(values('bitDepth')),
        ...languageData, releaseGroup, extension: input.extension,
        warnings: unique(warnings),
    };
}

// Parse main folders name (including multi-season / episode packs).
export function parseTorrentTitle(rawString) {
    return parseRelease(rawString, 'torrent');
}

// Parse one file's name/path. Parent folders are never used as metadata.
export function parseFileTitle(rawString) {
    return parseRelease(rawString, 'file');
}

// Compatibility with existing imports; both still accept one string.
export const parseMediaData = parseTorrentTitle;
export const parseFileData = parseFileTitle;

/** Preserve the existing stream API, including its original misspelling. */
export function parseFormated(stream) {
    if (!stream) return;
    const streamName = typeof stream.name === 'string' ? stream.name : '';
    const streamDesc = stream.description || stream.title || streamName;
    const data = parseTorrentTitle(streamDesc);
    const nameTags = scanTechnical(streamName);
    const nameResolution = nameTags.find(tag => tag.kind === 'resolution')?.value;
    const isCached = /(?:torbox|tb)\s*(?:\+|⚡)/i.test(streamName);
    const seeders = /👤[\s\-:|]*([\d,]+)/u.exec(streamDesc);
    const size = /💾[\s\-:|]*([\d.,]+\s*[KMGT]i?B)/iu.exec(streamDesc);
    // Languages only from the release metadata/footer; never scan the clean title.
    const footerLanguages = extractLanguages(String(streamDesc).split(/\r?\n/).slice(1).join('\n'));
    const resolution = data.resolution ?? (data.resolutions.length === 0 ? nameResolution : null) ?? null;
    return {
        ...data, isCached,
        seeders: seeders ? Number(seeders[1].replace(/,/g, '')) : 0,
        size: size?.[1].trim() ?? null,
        resolution,
        resolutions: data.resolutions.length ? data.resolutions : resolution ? [resolution] : [],
        dynamicRange: data.dynamicRange.length ? data.dynamicRange : unique(nameTags.filter(tag => tag.kind === 'dynamicRange').map(tag => tag.value)),
        languages: unique([...data.languages, ...footerLanguages.languages]),
        multi: footerLanguages.multi ?? data.multi,
    };
}

export const parseFormatted = parseFormated;