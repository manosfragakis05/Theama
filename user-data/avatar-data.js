export const AVATAR_BYTES = 100 * 1024;
const TYPES = { 'image/webp': 'webp', 'image/jpeg': 'jpg' };

export function isAvatarPath(path, userId = null) {
    if (typeof path !== 'string' || path.length > 240) return false;
    const parts = path.split('/');
    return parts.length === 2 && /^[a-zA-Z0-9_-]+$/.test(parts[0])
        && /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:webp|jpg|jpeg|png)$/i.test(parts[1])
        && !parts[1].includes('..') && (!userId || parts[0] === userId);
}

export function avatarPublicUrl(client, path) {
    return isAvatarPath(path) ? client.storage.from('avatars').getPublicUrl(path).data.publicUrl : '';
}

export function isMissingAvatarColumn(error) {
    return ['42703', 'PGRST204'].includes(error?.code) && /avatar_path/.test(error?.message || '');
}

function storageError(error) {
    const status = String(error?.statusCode || error?.status || '');
    if (status === '413') return new Error('This picture is too large. Choose a smaller photo.');
    if (status === '401' || status === '403' || /row.level security|unauthorized/i.test(error?.message || '')) {
        return new Error('Your picture could not be saved. Sign in again and try once more.');
    }
    return new Error('Could not save your picture. Check your connection and try again.');
}

export function createAvatarStore(client, currentUserId, makeId = () => crypto.randomUUID()) {
    function assertCurrent(userId) {
        if (!userId || currentUserId() !== userId) throw new Error('Your account changed. Open your profile and try again.');
    }

    async function read(userId) {
        const { data, error } = await client.from('profiles').select('avatar_path').eq('id', userId).maybeSingle();
        if (error) {
            if (isMissingAvatarColumn(error)) throw new Error('Profile pictures are not available yet. Please try again later.');
            throw new Error('Could not load your profile picture. Check your connection and try again.');
        }
        return isAvatarPath(data?.avatar_path, userId) ? data.avatar_path : null;
    }

    async function update(userId, path) {
        assertCurrent(userId);
        const { data, error } = await client.from('profiles').update({ avatar_path: path })
            .eq('id', userId).select('avatar_path').single();
        if (error || !data || data.avatar_path !== path) {
            if (isMissingAvatarColumn(error)) throw new Error('Profile pictures are not available yet. Please try again later.');
            throw new Error('Could not update your profile picture. Please try again.');
        }
    }

    async function deleteFile(userId, path) {
        assertCurrent(userId);
        if (!isAvatarPath(path, userId)) return;
        const { error } = await client.storage.from('avatars').remove([path]);
        if (error) throw new Error('Could not delete your previous picture. Please try again.');
    }

    return {
        read,
        async save(userId, blob) {
            assertCurrent(userId);
            if (!(blob instanceof Blob) || !TYPES[blob.type] || !blob.size || blob.size > AVATAR_BYTES) {
                throw new Error('This picture could not be optimized. Choose another photo.');
            }
            const previous = await read(userId);
            assertCurrent(userId);
            const path = `${userId}/${makeId()}.${TYPES[blob.type]}`;
            const { error } = await client.storage.from('avatars').upload(path, blob, {
                contentType: blob.type, cacheControl: '31536000', upsert: false
            });
            if (error) throw storageError(error);
            try {
                await update(userId, path);
            } catch (error) {
                // The profile still points to its old image; discard the failed upload.
                if (currentUserId() === userId) {
                    try { await deleteFile(userId, path); } catch { /* Preserve the original save error. */ }
                }
                throw error;
            }
            let cleanupFailed = false;
            if (previous && currentUserId() === userId) {
                try { await deleteFile(userId, previous); } catch { cleanupFailed = true; }
            }
            return { path, cleanupFailed };
        },
        async remove(userId) {
            assertCurrent(userId);
            const previous = await read(userId);
            // Keep the reference on deletion failure, so the user can retry.
            if (previous) await deleteFile(userId, previous);
            await update(userId, null);
            return { path: null };
        }
    };
}
