function isMissingAniListColumn(error) {
    return ['42703', 'PGRST204'].includes(error?.code) && /anilist_id/.test(error?.message || '');
}

function setupError() {
    const error = new Error('Public AniList sharing has not been set up yet. Your device connection still works.');
    error.code = 'ANILIST_SETUP_REQUIRED';
    return error;
}

export function createAniListProfileStore(client, currentUserId) {
    function assertOwner(userId) {
        if (!userId || currentUserId() !== userId) throw new Error('Your Theama account changed. Please try again.');
    }

    return {
        async read(userId) {
            const { data, error } = await client.from('profiles')
                .select('anilist_id').eq('id', userId).maybeSingle();
            if (isMissingAniListColumn(error)) throw setupError();
            if (error) throw new Error('Could not load this profile\'s AniList connection. Please try again.');
            const value = data?.anilist_id;
            const id = typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
            return Number.isSafeInteger(id) && id > 0 ? { id } : null;
        },
        async save(userId, viewer) {
            assertOwner(userId);
            if (!Number.isSafeInteger(viewer?.id) || viewer.id <= 0) {
                throw new Error('Could not verify your AniList account. Please reconnect.');
            }
            // Explicit allowlist: access tokens and private entries never go to Supabase.
            const { data, error } = await client.from('profiles').update({ anilist_id: viewer.id })
                .eq('id', userId).select('anilist_id').single();
            if (isMissingAniListColumn(error)) throw setupError();
            if (error || Number(data?.anilist_id) !== viewer.id) {
                throw new Error('Your AniList connection works, but could not be saved to your public profile. Try again later.');
            }
        },
        async remove(userId) {
            assertOwner(userId);
            const { data, error } = await client.from('profiles').update({ anilist_id: null })
                .eq('id', userId).select('anilist_id').single();
            if (isMissingAniListColumn(error)) return;
            if (error || data?.anilist_id !== null) {
                throw new Error('Could not remove AniList from your public profile. Please try disconnecting again.');
            }
        }
    };
}
