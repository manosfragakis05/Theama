/**
 * ==================================================
 * Persist playback progress and completed episode counts.
 * ==================================================
 */

import { appState } from '../services/config.js';
import { getQueueState } from '../streaming/playlist.js';
import { supabase } from './db.js';

export async function upsertWatchProgress(positionSeconds, durationSeconds, {
    media = getQueueState().current,
    countCompletion = true,
    userId = appState.currentUser?.id
} = {}) {
    if (!userId || appState.currentUser?.id !== userId || !media) return null;
    const tmdbId = Number(media.tmdbId);
    const mediaType = media.mediaType;
    const season = media.seasonNumber;
    const episode = media.watchEpisodeNumber ?? media.episodeNumber;
    if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0 || !['movie', 'tv'].includes(mediaType)) return null;
    if (mediaType === 'tv' && (!Number.isInteger(season) || season < 0
        || !Number.isInteger(episode) || episode <= 0)) return null;
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0
        || !Number.isFinite(durationSeconds) || durationSeconds < 1) return null;

    const duration = Math.floor(durationSeconds);
    const position = Math.min(Math.floor(positionSeconds), duration);
    const episodeKey = mediaType === 'tv' ? `${season}:${episode}` : 'movie';
    const completed = positionSeconds >= durationSeconds * 0.9;
    const torrent = appState.allTorrents.find(item => String(item.id) === String(media.tid));
    const hash = media.hash || torrent?.hash;
    const fileId = media.sourceType !== 'addon' && media.fid != null ? Number(media.fid) : NaN;

    try {
        const payload = {
            user_id: userId,
            tmdb_id: tmdbId,
            media_type: mediaType,
            current_episode: mediaType === 'tv' ? episodeKey : null,
            current_hash: typeof hash === 'string' && hash.trim() ? hash.trim() : null,
            t_id: Number.isInteger(fileId) && fileId >= 0 && fileId <= 2_147_483_647 ? fileId : null,
            position_seconds: position,
            duration_seconds: duration,
            last_watched_at: new Date().toISOString()
        };
        if (completed && countCompletion) {
            // Only completion changes counts. Ordinary upserts omit this column,
            // preserving it on updates and using the table default on inserts.
            const { data, error: readError } = await supabase.from('watch_progress')
                .select('watched_counts')
                .eq('user_id', userId).eq('media_type', mediaType).eq('tmdb_id', tmdbId)
                .maybeSingle();
            if (readError) throw readError;
            if (appState.currentUser?.id !== userId) return null;

            payload.watched_counts = {
                ...data?.watched_counts,
                [episodeKey]: (data?.watched_counts?.[episodeKey] || 0) + 1
            };
        }
        // No select(): the write returns no row data.
        const { error } = await supabase.from('watch_progress').upsert(payload, {
            onConflict: 'user_id,media_type,tmdb_id'
        });
        if (error) throw error;
        window.dispatchEvent(new CustomEvent('watch-progress:saved', {
            detail: { userId, tmdbId, mediaType, positionSeconds: position }
        }));
        return { completed };
    } catch (error) {
        console.warn('Could not save watch progress:', error);
        return null;
    }
}

