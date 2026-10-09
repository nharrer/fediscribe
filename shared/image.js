// SPDX-License-Identifier: GPL-3.0-or-later
// Image helpers: Base64 conversion and downscaling to sizes all providers accept.

import { FediscribeError } from './errors.js';

// Formats accepted by all four providers.
export const SUPPORTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Longest edge in pixels. Larger images do not improve descriptions, but cost
// tokens and upload time.
export const MAX_DIMENSION = 1568;

// Raw byte limit; the Base64 form (4/3 larger) stays below the 5 MB that the
// strictest provider accepts.
export const MAX_BYTES = 3.5 * 1024 * 1024;

export function bytesToBase64(bytes) {
    const chunkSize = 0x8000;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

export function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// Detects the image type from the first bytes, because servers do not always
// send a correct Content-Type.
export function sniffMimeType(bytes) {
    const startsWith = (...values) => values.every((value, index) => bytes[index] === value);
    if (startsWith(0xff, 0xd8, 0xff)) {
        return 'image/jpeg';
    }
    if (startsWith(0x89, 0x50, 0x4e, 0x47)) {
        return 'image/png';
    }
    if (startsWith(0x47, 0x49, 0x46, 0x38)) {
        return 'image/gif';
    }
    if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return 'image/webp';
    }
    return '';
}

// Target size for downscaling, keeping the aspect ratio.
export function scaledSize(width, height, maxDimension = MAX_DIMENSION) {
    const longest = Math.max(width, height);
    if (longest <= maxDimension) {
        return { width, height };
    }
    const factor = maxDimension / longest;
    return {
        width: Math.max(1, Math.round(width * factor)),
        height: Math.max(1, Math.round(height * factor)),
    };
}

// Returns { base64, mimeType } in a format and size every provider accepts.
// Images that already fit are passed through unchanged; everything else is
// re-encoded as JPEG (requires createImageBitmap and OffscreenCanvas).
export async function prepareImage(bytes, declaredMimeType = '') {
    const mimeType = sniffMimeType(bytes) || declaredMimeType.split(';')[0].trim().toLowerCase();
    if (!mimeType.startsWith('image/')) {
        throw new FediscribeError('imageUnsupported', `Not an image (type: ${mimeType || 'unknown'})`);
    }

    let bitmap;
    try {
        bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
    } catch (error) {
        throw new FediscribeError('imageUnsupported', `The image cannot be decoded (${mimeType}): ${error.message}`);
    }

    try {
        const fits = Math.max(bitmap.width, bitmap.height) <= MAX_DIMENSION && bytes.length <= MAX_BYTES;
        if (fits && SUPPORTED_MIME_TYPES.has(mimeType)) {
            return { base64: bytesToBase64(bytes), mimeType, width: bitmap.width, height: bitmap.height, converted: false };
        }

        let maxDimension = MAX_DIMENSION;
        for (let attempt = 0; attempt < 4; attempt++) {
            const size = scaledSize(bitmap.width, bitmap.height, maxDimension);
            const canvas = new OffscreenCanvas(size.width, size.height);
            const context = canvas.getContext('2d');
            // JPEG has no transparency; use a white background.
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, size.width, size.height);
            context.drawImage(bitmap, 0, 0, size.width, size.height);
            const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
            if (blob.size <= MAX_BYTES) {
                const converted = new Uint8Array(await blob.arrayBuffer());
                return { base64: bytesToBase64(converted), mimeType: 'image/jpeg', width: size.width, height: size.height, converted: true };
            }
            maxDimension = Math.round(maxDimension * 0.7);
        }
        throw new FediscribeError('imageUnsupported', 'The image is too large even after downscaling.');
    } finally {
        bitmap.close();
    }
}
