// Missing-extensions page: compares this browser with the lists shared by the user's other browsers.

const PERMISSION = { permissions: ['management'] };
const $ = id => document.getElementById(id);
let refreshing = false;

document.addEventListener('DOMContentLoaded', () => {
    $('turnOnBtn').addEventListener('click', turnOn);
    $('turnOffBtn').addEventListener('click', turnOff);
    $('refreshBtn').addEventListener('click', refresh);
    $('showIgnored').addEventListener('change', refresh);
    // Coming back from the store tab after installing: shorten the list.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    refresh();
});

function show(section) {
    for (const id of ['unconfigured', 'off', 'on']) $(id).hidden = id !== section;
}

function showError(message) {
    $('error').textContent = message || '';
    $('error').hidden = !message;
}

async function ask(action, extra = {}) {
    const result = await chrome.runtime.sendMessage({ action, ...extra });
    if (!result || !result.success) throw new Error(result?.error || 'No response from Sync Browsers');
    return result;
}

async function refresh() {
    if (refreshing) return;
    refreshing = true;
    $('refreshBtn').disabled = true;
    try {
        const settings = await chrome.storage.local.get(['syncId', 'passphrase', 'extensionsSync', 'ignoredExtensions']);
        if (!settings.syncId || !settings.passphrase) return show('unconfigured');
        const permitted = await chrome.permissions.contains(PERMISSION);
        if (!settings.extensionsSync || !permitted) return show('off');
        if (!canListExtensions()) {
            // This page was opened before the permission was granted: reload once.
            if (!sessionStorage.getItem('reloadedForPermission')) {
                sessionStorage.setItem('reloadedForPermission', '1');
                location.reload();
                return;
            }
            throw new Error('Permission to read your extensions is not active yet. Reload Sync Browsers in the extensions page, then open this page again.');
        }
        sessionStorage.removeItem('reloadedForPermission');
        show('on');
        const installed = await listInstalledExtensions();
        const { file } = await ask('extensions', { installed });
        const { browserId } = await chrome.storage.local.get('browserId');
        render(file, browserId, installed.map(e => e.id), settings.ignoredExtensions || []);
        showError('');
    } catch (error) {
        showError(error.message);
    } finally {
        refreshing = false;
        $('refreshBtn').disabled = false;
    }
}

function render(file, browserId, installed, ignored) {
    const others = (file?.browsers || []).filter(b => b.browserId !== browserId);
    const all = missingExtensions(file, browserId, installed, ignored);
    const showIgnored = $('showIgnored').checked;
    const visible = all.filter(e => showIgnored || !e.ignored);
    $('ignoredCount').textContent = all.filter(e => e.ignored).length;
    $('summary').textContent = others.length
        ? `Compared with ${others.length} other browser${others.length === 1 ? '' : 's'}.`
        : 'No other browsers are sharing their list yet.';

    $('list').replaceChildren(...visible.map(ext => {
        const li = document.createElement('li');
        if (ext.ignored) li.className = 'ignored';
        const info = document.createElement('div');
        info.className = 'info';
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = ext.name;
        const where = document.createElement('div');
        where.className = 'where';
        const url = storeUrl(ext);
        where.textContent = 'In ' + ext.browsers.join(', ') + (url ? '' : ' · loaded from a folder, no store page');
        info.append(name, where);
        li.append(info);
        if (url) {
            const install = document.createElement('a');
            install.className = 'btn primary';
            install.href = url;
            install.target = '_blank';
            install.rel = 'noopener';
            install.textContent = 'Install';
            li.append(install);
        }
        const toggle = document.createElement('button');
        toggle.className = 'btn light';
        toggle.textContent = ext.ignored ? 'Unignore' : 'Ignore';
        toggle.addEventListener('click', () => setIgnored(ext.id, !ext.ignored));
        li.append(toggle);
        return li;
    }));

    const empty = $('empty');
    empty.hidden = visible.length > 0;
    empty.textContent = !others.length
        ? 'Turn this on in your other browsers too, then refresh.'
        : all.length ? 'Only ignored extensions are missing.' : 'Nothing missing: this browser has every extension your other browsers have.';
}

async function setIgnored(id, ignore) {
    const { ignoredExtensions = [] } = await chrome.storage.local.get('ignoredExtensions');
    const next = ignoredExtensions.filter(x => x !== id);
    if (ignore) next.push(id);
    await chrome.storage.local.set({ ignoredExtensions: next });
    refresh();
}

async function turnOn() {
    showError('');
    try {
        if (!await chrome.permissions.request(PERMISSION)) {
            showError('Permission was not given, so the list stays off.');
            return;
        }
        await chrome.storage.local.set({ extensionsSync: true });
        location.reload();
    } catch (error) {
        showError(error.message);
    }
}

async function turnOff() {
    if (!confirm("Stop sharing this browser's extension list? Your other browsers will no longer see it.")) return;
    showError('');
    try {
        await ask('extensionsRemove');
        await chrome.storage.local.set({ extensionsSync: false });
        await chrome.permissions.remove(PERMISSION);
        show('off');
    } catch (error) {
        showError(error.message);
    }
}
