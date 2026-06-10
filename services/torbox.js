/**
 * ==========================================
 * torboxAuth.js
 * Handles TorBox API Key Verification & Session
 * ==========================================
 */

// 1. Import the utilities we made in config.js
import { getTbKey, smartFetch, showToast } from './config.js';

import { loadLibrary } from '../pages/library.js';

export async function authenticateTorboxUser() {
    const input = document.getElementById('api-input');
    const button = document.getElementById('loggin-btn');
    const key = input.value.trim();

    if (!key) return;

    button.innerText = "Verifying...";
    button.disabled = true;
    input.disabled = true;

    try {
        const targetUrl = 'https://api.torbox.app/v1/api/user/me';
        const res = await smartFetch(targetUrl, {
            headers: { 'Authorization': `Bearer ${key}` }
        });

        const data = await res.json();

        if (data.success && data.data) {
            localStorage.setItem('tb_api_key', key);

            button.innerText = "Connected!";
            button.classList.replace('bg-blue-600', 'bg-green-600');

            setTimeout(() => {
                checkAuth();
            }, 500);

        } else {
            throw new Error(data.detail || "Invalid API Key");
        }

    } catch (e) {
        showToast("Authentication Failed: " + e.message, 'error');
        button.innerText = "Log In";
        button.disabled = false;
        input.disabled = false;
        input.classList.add('border-red-500');
    }
}

export async function checkAuth() {
    const key = getTbKey();

    const connectedBadge = document.getElementById('tb-status-connected');
    const disconnectedBadge = document.getElementById('tb-status-disconnected');
    const authForm = document.getElementById('torbox-auth-form');
    const connectedActions = document.getElementById('torbox-connected-actions');

    if (key) {
        // User is authenticated
        await loadLibrary();
        
        connectedBadge.classList.replace('hidden', 'flex');
        disconnectedBadge.classList.replace('flex', 'hidden');
        authForm.classList.add('hidden');
        connectedActions.classList.remove('hidden');
    } else {
        // User is disconnected
        connectedBadge.classList.replace('flex', 'hidden');
        disconnectedBadge.classList.replace('hidden', 'flex');
        authForm.classList.remove('hidden');
        connectedActions.classList.add('hidden');
    }
}

export function logoutTorBox() {
    if (confirm("Disconnect TorBox API?")) {
        localStorage.removeItem('tb_api_key');
        location.reload();
    }
}