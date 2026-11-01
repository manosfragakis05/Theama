// AniList's browser OAuth flow uses a public client ID, never a client secret.
export const ANILIST_SESSION_KEY = 'theama_anilist_session';
export const ANILIST_PENDING_KEY = 'theama_anilist_oauth';
export const ANILIST_RESULT_KEY = 'theama_anilist_result';
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function createAuthorization({ clientId, redirectUri, origin, trustDevice, storage = sessionStorage, now = Date.now() }) {
    if (!/^\d+$/.test(clientId || '')) throw new Error('AniList connection is not available yet.');
    let redirect;
    try { redirect = new URL(redirectUri, origin); } catch {
        throw new Error('The AniList redirect URL is invalid.');
    }
    if (redirect.username || redirect.password || redirect.search || redirect.hash
        || !/^\/anilist-callback(?:\.html)?$/.test(redirect.pathname)) {
        throw new Error('The AniList redirect must end with /anilist-callback.html or /anilist-callback, without a query or fragment.');
    }
    if (redirect.origin !== origin) {
        throw new Error(`Theama is open at ${origin}, but AniList is configured to return to ${redirect.origin}. Open Theama at ${redirect.origin} to connect, or configure an AniList client for this address.`);
    }
    const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    storage.setItem(ANILIST_PENDING_KEY, JSON.stringify({ state, createdAt: now, redirectUri: redirect.href, trustDevice }));
    const authorize = new URL('https://anilist.co/api/v2/oauth/authorize');
    // AniList's implicit flow uses the callback saved in its developer settings.
    // Keep our expected callback locally for validation; do not send the
    // redirect_uri parameter used by its authorization-code flow.
    authorize.search = new URLSearchParams({ client_id: clientId, response_type: 'token', state });
    return authorize.href;
}

export function parseAuthorizationResponse(callbackUrl, pending, now = Date.now()) {
    const url = new URL(callbackUrl);
    const parameters = new URLSearchParams(url.hash.slice(1));
    const state = parameters.get('state') || url.searchParams.get('state');
    if (!pending || !pending.state || state !== pending.state
        || !Number.isFinite(pending.createdAt) || now < pending.createdAt
        || now - pending.createdAt > LOGIN_WINDOW_MS) {
        throw new Error('This AniList sign-in expired or could not be verified. Connect again from Theama in the same browser.');
    }
    const redirect = new URL(pending.redirectUri);
    // Cloudflare Pages canonicalizes .html URLs to extensionless URLs.
    if (url.origin !== redirect.origin
        || url.pathname.replace(/\.html$/, '') !== redirect.pathname.replace(/\.html$/, '')) {
        throw new Error('The AniList sign-in returned to an unexpected address. Please connect again.');
    }
    if (parameters.has('error') || url.searchParams.has('error')) {
        throw new Error('AniList sign-in was declined or cancelled. You can try again when ready.');
    }
    const accessToken = parameters.get('access_token');
    const lifetime = Number(parameters.get('expires_in'));
    if (!accessToken || accessToken.length > 8192 || /\s/.test(accessToken)
        || parameters.get('token_type')?.toLowerCase() !== 'bearer'
        || !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 366 * 24 * 60 * 60) {
        throw new Error('AniList did not return a valid connection. Please try again.');
    }
    return { accessToken, expiresAt: now + lifetime * 1000 };
}

export async function requestAniList(accessToken, query, variables = {}, { fetcher = fetch, signal } = {}) {
    let response;
    try {
        response = await fetcher('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({ query, variables }),
            cache: 'no-store',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
        });
    } catch {
        if (signal?.aborted) throw signal.reason;
        throw new Error('Could not reach AniList. Check your connection and try again.');
    }
    if (response.status === 401 || response.status === 403) {
        const error = new Error('Your AniList connection is no longer valid. Please reconnect.');
        error.unauthorized = true;
        throw error;
    }
    if (response.status === 429) throw new Error('AniList is busy. Wait a minute before trying again.');
    let data;
    try { data = await response.json(); } catch { /* Use the safe error below. */ }
    if (!response.ok || data?.errors?.length || !data?.data) {
        throw new Error('Could not verify your AniList account or load its data. Please try again.');
    }
    return data.data;
}

export async function fetchAniListViewer(accessToken, fetcher = fetch) {
    const data = await requestAniList(accessToken, 'query TheamaAniListViewer { Viewer { id name } }', {}, { fetcher });
    const viewer = data.Viewer;
    if (!Number.isSafeInteger(viewer?.id)
        || viewer.id <= 0 || typeof viewer.name !== 'string' || !viewer.name.trim()) {
        throw new Error('Could not verify your AniList account. Please try again.');
    }
    return { id: viewer.id, name: viewer.name };
}

export function clearAniListSession(stores = [sessionStorage, localStorage]) {
    for (const storage of stores) storage.removeItem(ANILIST_SESSION_KEY);
}

export function saveAniListSession(connection, trustDevice, stores = [sessionStorage, localStorage]) {
    const target = stores[trustDevice ? 1 : 0];
    target.setItem(ANILIST_SESSION_KEY, JSON.stringify(connection));
    stores[trustDevice ? 0 : 1].removeItem(ANILIST_SESSION_KEY);
}

export function readAniListSession(stores = [sessionStorage, localStorage], now = Date.now()) {
    for (const storage of stores) {
        const value = storage.getItem(ANILIST_SESSION_KEY);
        if (!value) continue;
        try {
            const connection = JSON.parse(value);
            if (typeof connection.accessToken === 'string' && connection.accessToken
                && Number.isFinite(connection.expiresAt) && connection.expiresAt > now
                && Number.isSafeInteger(connection.viewer?.id) && connection.viewer.id > 0
                && typeof connection.viewer.name === 'string' && connection.viewer.name.trim()) return connection;
        } catch { /* Discard malformed local data. */ }
        storage.removeItem(ANILIST_SESSION_KEY);
    }
    return null;
}
