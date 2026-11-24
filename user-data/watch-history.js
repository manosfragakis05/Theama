/**
 * ==================================================
 * Persist playback progress and completed episode counts.
 * ==================================================
 */

import { appState } from '../services/config.js';
import { supabase } from './db.js';

export async function upsertWatchProgress(positionSeconds, durationSeconds, {
    media,
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
    const shouldCountCompletion = completed && !media.completionCounted;

    const hash = media?.hash;
    const fileId = media?.fid;

    try {
        const payload = {
            user_id: userId,
            tmdb_id: tmdbId,
            media_type: mediaType,
            current_episode: mediaType === 'tv' ? episodeKey : null,
            position_seconds: position,
            duration_seconds: duration,
            current_hash: hash ? hash : null,
            t_id: fileId ?? null,
            last_watched_at: new Date().toISOString()
        };

        // Read the full map only when adding a watch, preserving other episodes.
        if (shouldCountCompletion) {
            const { data, error: readError } = await supabase.from('watch_progress')
                .select('watched_counts')
                .eq('user_id', userId).eq('media_type', mediaType).eq('tmdb_id', tmdbId)
                .maybeSingle();
            if (readError) throw readError;
            if (appState.currentUser?.id !== userId) return null;

            const allWatchedCounts = data?.watched_counts || {};
            payload.watched_counts = {
                ...allWatchedCounts,
                [episodeKey]: (Number(allWatchedCounts[episodeKey]) || 0) + 1
            };
        }

        const { error } = await supabase.from('watch_progress').upsert(payload, {
            onConflict: 'user_id,media_type,tmdb_id'
        });

        if (error) throw error;
        if (shouldCountCompletion) {
            media.completionCounted = true;
            media.watchedCounts = payload.watched_counts[episodeKey];
        }

        window.dispatchEvent(new CustomEvent('watch-progress:saved', {
            detail: { userId, tmdbId, mediaType, positionSeconds: position }
        }));
        return { completed };
    } catch (error) {
        console.warn('Could not save watch progress:', error);
        return null;
    }
}

export async function fetchWatchProgress(tmdbId, userId) {
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
