/**
 * ==========================================
 * offline.js
 * Handles OPFS downloads, saving metadata, and the Local Ghost Library
 * ==========================================
 */

import { appState, showToast } from './config.js';
import { parseFormated } from '../utils/parseMedia.js';
import { getPosterForLibrary } from './metadata.js';
import { getTorboxLink, startPlayer } from '../streaming/player.js';

let expectedLocalFile = null;

export function triggerLocalFilePicker(expectedName = null, expectedSize = null) {
    if (expectedName) {
        expectedLocalFile = { name: expectedName, size: expectedSize };
        showToast(`Please re-select: ${expectedName}`, 'info');
    } else {
        expectedLocalFile = null;
    }
    document.getElementById('local-file-input').click();
}

export async function processLocalFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    event.target.value = '';

    if (expectedLocalFile) {
        if (file.name !== expectedLocalFile.name || file.size !== expectedLocalFile.size) {
            showToast(`Incorrect file! Expected: ${expectedLocalFile.name}`, 'error');
            return;
        }
    }

    const fileBlobUrl = URL.createObjectURL(file);
    startPlayer(fileBlobUrl, file.name, file);
}