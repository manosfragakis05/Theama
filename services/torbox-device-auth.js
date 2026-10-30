const DEVICE_AUTH_URL = 'https://api.torbox.app/v1/api/user/auth/device';
const EXPIRED_MESSAGE = 'Pairing code expired. Generate a new code to try again.';

// TorBox's device flow returns the account API key as access_token.
// https://api.torbox.app/openapi.json
export async function requestTorboxDeviceCode(request, signal) {
    const response = await request(`${DEVICE_AUTH_URL}/start?app=Theama`, {
        signal,
        cache: 'no-store'
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
        throw new Error('Could not generate a TorBox pairing code. Please try again.');
    }

    const data = result.data;
    const expiresAt = Date.parse(data?.expires_at);
    const interval = Number(data?.interval);
    const verificationUrl = new URL(data?.verification_url_complete || data?.verification_url);
    if (verificationUrl.protocol !== 'https:' || verificationUrl.hostname !== 'torbox.app') {
        throw new Error('TorBox returned an invalid pairing link. Please try again.');
    }
    if (!data?.device_code || !data?.code || !Number.isFinite(expiresAt)) {
        throw new Error('TorBox returned an incomplete pairing code. Please try again.');
    }
    if (expiresAt <= Date.now()) throw new Error(EXPIRED_MESSAGE);

    return {
        deviceCode: data.device_code,
        code: String(data.code),
        verificationUrl: verificationUrl.href,
        expiresAt,
        interval: Number.isFinite(interval) && interval > 0 ? interval * 1000 : 5000
    };
}

function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

export async function waitForTorboxDeviceToken(authorization, { request, signal, onStatus = () => {} }) {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal.throwIfAborted();
    signal.addEventListener('abort', cancel, { once: true });
    const expiryTimer = setTimeout(() => controller.abort(new Error(EXPIRED_MESSAGE)),
        Math.max(0, authorization.expiresAt - Date.now()));
    let interval = authorization.interval;

    try {
        while (true) {
            await wait(interval, controller.signal);
            if (Date.now() >= authorization.expiresAt) throw new Error(EXPIRED_MESSAGE);

            let response;
            let result;
            try {
                response = await request(`${DEVICE_AUTH_URL}/token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ device_code: authorization.deviceCode }),
                    signal: controller.signal,
                    cache: 'no-store'
                });
                result = await response.json();
            } catch (error) {
                controller.signal.throwIfAborted();
                // A suspended mobile tab or temporary outage should not lose the code.
                interval = Math.max(authorization.interval, Math.min(interval * 2, 30000));
                onStatus('Connection interrupted. Retrying automatically…');
                continue;
            }
            controller.signal.throwIfAborted();

            if (response.ok && result.success) {
                const token = result.data?.access_token;
                if (typeof token !== 'string' || !token.trim()) {
                    throw new Error('TorBox did not return an API key. Generate a new code to try again.');
                }
                return token.trim();
            }

            const error = String(result.error || '').toUpperCase();
            const detail = typeof result.detail === 'string' ? result.detail.toLowerCase() : '';
            if (response.status === 429 || error === 'SLOW_DOWN') {
                const retryAfter = Number(response.headers.get('Retry-After'));
                interval = Math.max(interval + 5000, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0);
                onStatus('Waiting for approval on TorBox…');
                continue;
            }
            if (error === 'DEVICE_CODE_NOT_USED' || error === 'AUTHORIZATION_PENDING'
                || detail.includes('device code has not been used')) {
                onStatus('TorBox is waiting for account approval. Finish signing in and approve access on the TorBox page.');
                continue;
            }
            if (response.status >= 500 || error === 'DATABASE_ERROR' || error === 'UNKNOWN_ERROR') {
                interval = Math.max(authorization.interval, Math.min(interval * 2, 30000));
                onStatus('TorBox is temporarily unavailable. Retrying…');
                continue;
            }
            if (error === 'ITEM_NOT_FOUND' || error === 'EXPIRED_TOKEN' || response.status === 410) {
                throw new Error(EXPIRED_MESSAGE);
            }
            if (error === 'ACCESS_DENIED' || error === 'AUTHORIZATION_DENIED') {
                throw new Error('Pairing was declined. Generate a new code to try again.');
            }
            if (error === 'DEVICE_CODE_USED') {
                throw new Error('This pairing code has already been used. Generate a new code.');
            }
            const errorCode = /^[A-Z0-9_]+$/.test(error) ? `, ${error}` : '';
            throw new Error(`TorBox pairing failed (HTTP ${response.status}${errorCode}). Generate a new code to try again.`);
        }
    } finally {
        clearTimeout(expiryTimer);
        signal.removeEventListener('abort', cancel);
    }
}
