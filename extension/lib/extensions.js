// Extension-list sharing for Sync Browsers (opt-in).
// Lists live in their own encrypted file at `<syncId>-ext`, never in the bookmarks copy,
// so older versions and browsers with this switched off cannot overwrite them.

const EXT_SUFFIX = '-ext';
const SERVER_ID_LIMIT = 64;
const EXT_STALE_DAYS = 90;
const EXT_REFRESH_MS = 24 * 60 * 60 * 1000;

function extensionsSyncId(syncId) {
    return syncId && syncId.length + EXT_SUFFIX.length <= SERVER_ID_LIMIT ? syncId + EXT_SUFFIX : null;
}

function browserLabel() {
    const ua = typeof navigator !== 'undefined' && navigator.userAgentData;
    if (!ua) return 'Chromium';
    const brands = (ua.brands || []).map(b => b.brand).filter(b => !/not.?a.?brand|^chromium$/i.test(b));
    const name = brands[0] || 'Chromium';
    return ua.platform ? `${name} (${ua.platform})` : name;
}

async function getBrowserId() {
    const { browserId } = await chrome.storage.local.get('browserId');
    if (browserId) return browserId;
    const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');
    await chrome.storage.local.set({ browserId: id });
    return id;
}

// chrome.management exists without the permission, but getAll only appears in pages
// and workers started after it was granted.
function canListExtensions() {
    return typeof chrome.management?.getAll === 'function';
}

async function listInstalledExtensions() {
    if (!canListExtensions()) throw new Error('Permission to read your extensions is not active yet. Reload this page.');
    const all = await chrome.management.getAll();
    return all
        .filter(e => e.type === 'extension' && e.id !== chrome.runtime.id)
        .map(e => ({ id: e.id, name: e.name, homepageUrl: e.homepageUrl || '', installType: e.installType }))
        .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

// Replace this browser's entry (or remove it when entry.extensions is null) and drop stale browsers.
function updateExtensionsFile(file, entry, now = Date.now()) {
    const cutoff = now - EXT_STALE_DAYS * 24 * 60 * 60 * 1000;
    const browsers = (file && Array.isArray(file.browsers) ? file.browsers : [])
        .filter(b => b && b.browserId !== entry.browserId && Date.parse(b.updated) >= cutoff);
    if (entry.extensions) browsers.push(entry);
    return { version: 1, type: 'extensions', browsers };
}

function ownEntryCurrent(file, entry, now = Date.now()) {
    const own = file && Array.isArray(file.browsers) && file.browsers.find(b => b.browserId === entry.browserId);
    return !!own && own.label === entry.label && now - Date.parse(own.updated) < EXT_REFRESH_MS &&
        JSON.stringify(own.extensions) === JSON.stringify(entry.extensions);
}

// Extensions other browsers have that this one doesn't.
function missingExtensions(file, browserId, installedIds, ignored = []) {
    const installed = new Set(installedIds);
    const found = new Map();
    for (const b of (file && Array.isArray(file.browsers) ? file.browsers : [])) {
        if (b.browserId === browserId) continue;
        for (const e of b.extensions || []) {
            if (installed.has(e.id)) continue;
            const item = found.get(e.id) || { ...e, browsers: [], ignored: ignored.includes(e.id) };
            item.browsers.push(b.label || 'Another browser');
            found.set(e.id, item);
        }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function storeUrl(ext) {
    return ['normal', 'admin'].includes(ext.installType) && /^[a-p]{32}$/.test(ext.id)
        ? `https://chromewebstore.google.com/detail/${ext.id}`
        : null;
}

async function syncExtensionList(settings, { remove = false, installed = null } = {}) {
    const extId = extensionsSyncId(settings.syncId);
    if (!extId) {
        throw new Error(`Your Sync ID is too long for the extensions list (max ${SERVER_ID_LIMIT - EXT_SUFFIX.length} characters).`);
    }
    const serverUrl = settings.serverUrl || 'https://sync.satoshihost.com';
    const entry = {
        browserId: await getBrowserId(),
        label: browserLabel(),
        updated: new Date().toISOString(),
        extensions: remove ? null : installed || await listInstalledExtensions()
    };
    for (let attempt = 0; ; attempt++) {
        const blob = await downloadBlob(serverUrl, extId);
        let file = null;
        if (blob) {
            file = JSON.parse(await decrypt(settings.passphrase, new Uint8Array(blob.data)));
            if (!file || file.type !== 'extensions' || !Array.isArray(file.browsers)) {
                throw new Error('Invalid extensions list from server');
            }
        }
        const hasOwn = !!file && file.browsers.some(b => b.browserId === entry.browserId);
        if (remove ? !hasOwn : ownEntryCurrent(file, entry)) return file;
        const next = updateExtensionsFile(file, entry);
        try {
            const data = await encrypt(settings.passphrase, JSON.stringify(next), settings.plaintextMode);
            await uploadBlob(serverUrl, extId, data, blob ? blob.rev : 0);
            return next;
        } catch (error) {
            // Another browser saved at the same moment: re-read and try again.
            if (attempt >= 2 || ![409, 429].includes(error.status)) throw error;
            await new Promise(resolve => setTimeout(resolve, 6000));
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        extensionsSyncId, updateExtensionsFile, ownEntryCurrent, missingExtensions, storeUrl, syncExtensionList
    };
}
