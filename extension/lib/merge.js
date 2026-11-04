// Three-way bookmark merge for Sync Browsers.
// A tree is flattened into entries: bookmarks keyed by URL (plus occurrence),
// folders by parent + title (plus occurrence). Root folders are keyed by position.

function flattenTree(tree) {
    const entries = {};
    const urlCounts = {};
    const roots = Array.isArray(tree) && tree[0] && Array.isArray(tree[0].children) ? tree[0].children : [];
    const walk = (children, parent) => {
        const titleCounts = {};
        (children || []).forEach((node, index) => {
            const title = typeof node.title === 'string' ? node.title : '';
            if (node.url) {
                const n = urlCounts[node.url] = (urlCounts[node.url] || 0) + 1;
                entries[`u${n}:${node.url}`] = { url: node.url, title, parent, index };
            } else {
                const n = titleCounts[title] = (titleCounts[title] || 0) + 1;
                const key = 'f' + JSON.stringify([parent, title, n]);
                entries[key] = { folder: true, title, parent, index };
                walk(node.children, key);
            }
        });
    };
    roots.forEach((root, r) => walk(root.children, 'r' + r));
    return { roots: roots.map(root => root.title || ''), entries };
}

function snapshotKey(snapshot) {
    const entries = (snapshot && snapshot.entries) || {};
    return JSON.stringify(Object.keys(entries).sort().map(key => {
        const e = entries[key];
        return [key, e.title, e.parent, e.index];
    }));
}

function sameSnapshot(a, b) {
    return snapshotKey(a) === snapshotKey(b);
}

// When both sides changed the same entry, the server copy wins.
// An edit (rename or move) beats a delete, so nothing edited is lost.
function mergeSnapshots(base, local, remote) {
    const b = (base && base.entries) || {};
    const l = local.entries;
    const r = remote.entries;
    const edited = (e, old) => !old || e.title !== old.title || e.parent !== old.parent;
    const changed = (e, old) => edited(e, old) || e.index !== old.index;
    const result = {};
    for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
        const be = b[key], le = l[key], re = r[key];
        let pick = null;
        if (le && re) pick = changed(re, be) ? re : le;
        else if (le) pick = !be || edited(le, be) ? le : null;
        else if (re) pick = !be || edited(re, be) ? re : null;
        if (pick) result[key] = pick;
    }
    // Recreate any folder that was deleted on one side but still holds kept entries.
    const ensureParent = key => {
        const parent = result[key].parent;
        if (parent[0] === 'r' || result[parent]) return;
        const folder = r[parent] || l[parent] || b[parent];
        if (!folder) {
            result[key] = { ...result[key], parent: 'r0' };
            return;
        }
        result[parent] = folder;
        ensureParent(parent);
    };
    Object.keys(result).forEach(ensureParent);
    return result;
}

function buildTree(rootTitles, entries) {
    const children = {};
    for (const [key, e] of Object.entries(entries)) {
        let parent = e.parent;
        if (parent[0] === 'r' && Number(parent.slice(1)) >= rootTitles.length) {
            parent = 'r' + Math.max(rootTitles.length - 1, 0);
        }
        (children[parent] = children[parent] || []).push([key, e]);
    }
    const make = parent => (children[parent] || [])
        .sort((x, y) => x[1].index - y[1].index || (x[0] < y[0] ? -1 : 1))
        .map(([key, e]) => e.folder
            ? { title: e.title, children: make(key) }
            : { title: e.title, url: e.url });
    return [{ children: rootTitles.map((title, r) => ({ title, children: make('r' + r) })) }];
}

function mergeTrees(base, localTree, remoteTree) {
    const local = flattenTree(localTree);
    const remote = flattenTree(remoteTree);
    const entries = mergeSnapshots(base, local, remote);
    const tree = buildTree(local.roots.length ? local.roots : remote.roots, entries);
    const snapshot = flattenTree(tree);
    return {
        tree,
        snapshot,
        localChanged: !sameSnapshot(snapshot, local),
        remoteChanged: !sameSnapshot(snapshot, remote)
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { flattenTree, sameSnapshot, mergeSnapshots, buildTree, mergeTrees };
}
