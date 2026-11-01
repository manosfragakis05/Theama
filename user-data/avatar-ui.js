import { appState, showToast } from '../services/config.js';
import { supabase } from './db.js';
import { avatarPublicUrl, createAvatarStore } from './avatar-data.js';
import { avatarCrop, decodeAvatar, drawAvatar, compressAvatar } from './avatar-image.js';

const store = createAvatarStore(supabase, () => appState.currentUser?.id);
let ownProfile = null;
let headerVersion = 0;
let initialized = false;

export function renderUserAvatar(element, profile) {
    if (!element) return;
    element.dataset.avatarUserId = profile?.id || '';
    const initial = document.createElement('span');
    initial.textContent = (profile?.username || 'Guest').charAt(0).toUpperCase();
    element.replaceChildren(initial);
    const url = avatarPublicUrl(supabase, profile?.avatar_path);
    if (url) {
        const image = document.createElement('img');
        image.src = url;
        image.alt = '';
        image.draggable = false;
        image.addEventListener('error', () => image.remove(), { once: true });
        element.append(image);
    }
}

function renderHeader(profile, editable) {
    renderUserAvatar(document.getElementById('profile-avatar-initial'), profile);
    const hasPhoto = Boolean(profile?.avatar_path);
    const button = document.getElementById('profile-avatar-btn');
    button.disabled = !editable;
    button.setAttribute('aria-label', editable ? hasPhoto ? 'Change profile picture' : 'Add profile picture' : 'Profile picture');
    document.getElementById('profile-avatar-camera').hidden = !editable;
    const action = document.getElementById('profile-picture-action');
    action.hidden = !editable;
    action.textContent = hasPhoto ? 'Change picture' : 'Add picture';
}

export async function showPersonalAvatar(user, username) {
    const version = ++headerVersion;
    if (!user) {
        ownProfile = null;
        renderHeader({ username }, false);
        return;
    }
    ownProfile = { id: user.id, username, avatar_path: ownProfile?.id === user.id ? ownProfile.avatar_path : null };
    renderHeader(ownProfile, true);
    try {
        const path = await store.read(user.id);
        if (version !== headerVersion || user.id !== appState.currentUser?.id) return;
        ownProfile.avatar_path = path;
        renderHeader(ownProfile, true);
    } catch (error) {
        console.warn('Profile picture load:', error.message);
    }
}

export function showPublicAvatar(profile) {
    ++headerVersion;
    renderHeader(profile, false);
}

function applyPicture(userId, path) {
    ++headerVersion;
    if (ownProfile?.id === userId) ownProfile.avatar_path = path;
    for (const element of document.querySelectorAll('[data-avatar-user-id]')) {
        if (element.dataset.avatarUserId === userId) renderUserAvatar(element, { ...ownProfile, id: userId, avatar_path: path });
    }
    if (document.getElementById('profile-page').dataset.public !== 'true') renderHeader(ownProfile, true);
}

export function initializeAvatarPicker() {
    if (initialized) return;
    initialized = true;
    const dialog = document.getElementById('profile-picture-dialog');
    const canvas = document.getElementById('profile-picture-canvas');
    const preview = document.getElementById('profile-picture-preview');
    const input = document.getElementById('profile-picture-file');
    const zoom = document.getElementById('profile-picture-zoom');
    const save = document.getElementById('profile-picture-save');
    const remove = document.getElementById('profile-picture-remove');
    const choose = document.getElementById('profile-picture-choose');
    const status = document.getElementById('profile-picture-status');
    const controls = document.getElementById('profile-picture-controls');
    let image = null;
    let owner = null;
    let version = 0;
    let busy = false;
    let crop = { zoom: 1, x: .5, y: .5 };
    let pointer = null;

    function setBusy(value) {
        busy = value;
        dialog.setAttribute('aria-busy', String(value));
        save.disabled = value || !image;
        remove.disabled = value;
        choose.disabled = value;
        zoom.disabled = value || !image;
        save.textContent = value ? 'Saving...' : 'Save picture';
    }
    function draw() {
        if (image) drawAvatar(canvas, image, crop);
    }
    function open() {
        if (busy || !appState.currentUser || document.getElementById('profile-page').dataset.public === 'true' || dialog.open) return;
        owner = appState.currentUser.id;
        status.textContent = '';
        image = null;
        input.value = '';
        controls.hidden = true;
        canvas.hidden = true;
        preview.hidden = false;
        renderUserAvatar(preview, ownProfile);
        remove.hidden = !ownProfile?.avatar_path;
        setBusy(false);
        dialog.showModal();
    }
    document.getElementById('profile-avatar-btn').addEventListener('click', open);
    document.getElementById('profile-picture-action').addEventListener('click', open);
    document.getElementById('profile-picture-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) {
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    } });
    dialog.addEventListener('close', () => { ++version; image = null; pointer = null; input.value = ''; });
    choose.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        const current = ++version;
        status.textContent = 'Opening photo...';
        save.disabled = true;
        choose.disabled = true;
        remove.disabled = true;
        zoom.disabled = true;
        try {
            const decoded = await decodeAvatar(file);
            if (current !== version || !dialog.open) return;
            image = decoded;
            crop = { zoom: 1, x: .5, y: .5 };
            zoom.value = '1';
            preview.hidden = true;
            canvas.hidden = false;
            controls.hidden = false;
            draw();
            status.textContent = '';
        } catch (error) {
            if (current === version) status.textContent = error.message;
        } finally {
            if (current === version) { choose.disabled = false; remove.disabled = false; save.disabled = !image; zoom.disabled = !image; }
        }
    });
    zoom.addEventListener('input', () => { crop.zoom = Number(zoom.value); draw(); });
    canvas.addEventListener('pointerdown', event => {
        if (!image || busy || !event.isPrimary || event.button !== 0) return;
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add('is-dragging');
    });
    canvas.addEventListener('pointermove', event => {
        if (!pointer || pointer.id !== event.pointerId || !image || busy) return;
        const { size } = avatarCrop(image.naturalWidth, image.naturalHeight, crop);
        const scale = size / canvas.getBoundingClientRect().width;
        if (image.naturalWidth > size) crop.x = Math.max(0, Math.min(1, crop.x - (event.clientX - pointer.x) * scale / (image.naturalWidth - size)));
        if (image.naturalHeight > size) crop.y = Math.max(0, Math.min(1, crop.y - (event.clientY - pointer.y) * scale / (image.naturalHeight - size)));
        pointer.x = event.clientX; pointer.y = event.clientY;
        draw();
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, () => {
        pointer = null; canvas.classList.remove('is-dragging');
    });
    canvas.addEventListener('keydown', event => {
        if (!image || busy || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const axis = ['ArrowLeft', 'ArrowRight'].includes(event.key) ? 'x' : 'y';
        crop[axis] = Math.max(0, Math.min(1, crop[axis] + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -.05 : .05)));
        draw();
    });

    async function persist(removing = false) {
        if (busy || !owner || owner !== appState.currentUser?.id || (!removing && !image)) return;
        const userId = owner;
        const current = version;
        setBusy(true);
        status.textContent = removing ? 'Removing picture...' : 'Optimizing picture...';
        try {
            const blob = removing ? null : await compressAvatar(canvas);
            if (current !== version || userId !== appState.currentUser?.id) return;
            status.textContent = removing ? 'Removing picture...' : 'Uploading picture...';
            const result = removing ? await store.remove(userId) : await store.save(userId, blob);
            if (userId !== appState.currentUser?.id) return;
            applyPicture(userId, result.path);
            if (dialog.open && current === version) dialog.close();
            showToast(result.cleanupFailed ? 'Picture saved, but the previous image could not be deleted.'
                : removing ? 'Profile picture removed.' : 'Profile picture saved.', result.cleanupFailed ? 'info' : 'success');
        } catch (error) {
            if (current === version && dialog.open) status.textContent = error.message;
        } finally {
            if (current === version || !dialog.open) setBusy(false);
        }
    }
    save.addEventListener('click', () => persist());
    remove.addEventListener('click', () => persist(true));
    window.addEventListener('auth-state-changed', () => {
        if (dialog.open && owner !== appState.currentUser?.id) dialog.close();
        if (ownProfile?.id !== appState.currentUser?.id) { ownProfile = null; ++headerVersion; }
    });
}
