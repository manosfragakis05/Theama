import { AVATAR_BYTES } from './avatar-data.js';

export const AVATAR_SIZE = 256;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function avatarCrop(width, height, { zoom = 1, x = .5, y = .5 } = {}) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('This image has no readable dimensions.');
    }
    const size = Math.min(width, height) / clamp(Number(zoom) || 1, 1, 3);
    return { x: (width - size) * clamp(Number(x) || 0, 0, 1), y: (height - size) * clamp(Number(y) || 0, 0, 1), size };
}

export async function decodeAvatar(file) {
    if (!file?.size || file.size > 20 * 1024 * 1024) throw new Error('Choose a photo smaller than 20 MB.');
    if (/\.(?:raw|dng|cr2|cr3|nef|arw|orf|rw2)$/i.test(file.name || '') || file.type === 'image/svg+xml') {
        throw new Error('Choose a photo in JPEG, PNG, WebP, or another supported photo format.');
    }
    if (file.type && !file.type.startsWith('image/')) throw new Error('Choose an image file.');
    const url = URL.createObjectURL(file);
    try {
        const image = new Image();
        image.decoding = 'async';
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('This image took too long to open. Try a smaller photo.')), 15000);
            image.onload = () => { clearTimeout(timer); resolve(); };
            image.onerror = () => {
                clearTimeout(timer);
                reject(new Error('Your browser cannot open this photo. Try exporting it as JPEG, PNG, or WebP.'));
            };
            image.src = url;
        });
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 60000000) {
            throw new Error('This photo is too large to process. Choose a smaller copy.');
        }
        return image;
    } finally {
        URL.revokeObjectURL(url);
    }
}

export function drawAvatar(canvas, image, crop) {
    const region = avatarCrop(image.naturalWidth, image.naturalHeight, crop);
    const context = canvas.getContext('2d');
    context.fillStyle = '#1c212d';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, region.x, region.y, region.size, region.size, 0, 0, canvas.width, canvas.height);
}

export async function compressAvatar(canvas) {
    for (const type of ['image/webp', 'image/jpeg']) {
        for (const quality of [.85, .72, .58, .42]) {
            const blob = await new Promise(resolve => canvas.toBlob(resolve, type, quality));
            if (!blob || blob.type !== type) break;
            if (blob.size && blob.size <= AVATAR_BYTES) return blob;
        }
    }
    throw new Error('This photo could not be compressed. Please choose another image.');
}
