import { appState } from '../services/config.js';
import { supabase } from './db.js';

export async function updatePublicProfile() {
    const user = appState.currentUser;
    if (!user) return;

    const { error } = await supabase.from('profiles').upsert({
        id: user.id,
        username: user.user_metadata?.username
    }, { onConflict: 'id' });
    if (error) console.error('Failed to sync public profile:', error.message);
}

export async function fetchPublicProfile(userId) {
    const { data: profile, error: profileError } = await supabase
        .from('profiles').select('username').eq('id', userId).maybeSingle();
    if (profileError) throw profileError;
    if (!profile) return null;

    // Fetch lists with nested global_media
    const { data: listsData, error: listsError } = await supabase
        .from('lists')
        .select(`
            id, name, is_private, created_at, 
            list_items ( 
                global_media ( media_id, media_type, title, poster_path, base_url ) 
            )
        `)
        .eq('user_id', userId).eq('is_private', false)
        .order('created_at', { ascending: true });

    if (listsError) throw listsError;

    // Map the nested bridge data back into a flat 'media' array for the UI
    const lists = (listsData || []).map(list => ({
        ...list,
        media: list.list_items.map(item => item.global_media)
    }));

    let isFollowing = false;
    if (appState.currentUser) {
        const { data, error } = await supabase.from('follows').select('following_id')
            .eq('follower_id', appState.currentUser.id)
            .eq('following_id', userId).maybeSingle();
        if (error) throw error;
        isFollowing = Boolean(data);
    }

    return { username: profile.username, lists: lists || [], isFollowing };
}

export async function fetchFriendsList() {
    const user = appState.currentUser;
    if (!user) return [];

    const { data: follows, error: followError } = await supabase
        .from('follows').select('following_id').eq('follower_id', user.id);
    if (followError) throw followError;
    if (!follows?.length) return [];

    const { data: profiles, error: profileError } = await supabase
        .from('profiles').select('id, username')
        .in('id', follows.map(follow => follow.following_id))
        .order('username', { ascending: true });
    if (profileError) throw profileError;
    return profiles || [];
}

export async function handleFollowToggle(friendId, isFollowing) {
    const user = appState.currentUser;
    if (!user) throw new Error('Please log in to follow users.');

    let query = supabase.from('follows');
    if (isFollowing) {
        query = query.delete().eq('follower_id', user.id).eq('following_id', friendId);
    } else {
        query = query.insert({ follower_id: user.id, following_id: friendId });
    }
    const { error } = await query;
    if (error) throw error;
}
