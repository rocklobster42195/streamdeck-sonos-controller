// Dumps a Sonos household's FV:2 (Sonos Favorites) two ways so we can see which favorites the
// plugin's dropdown silently loses:
//   1. RAW ContentDirectory Browse of FV:2 — every <item>/<container> exactly as the speaker
//      returns it (title, upnp:class, whether it has a <res>, its <r:resMD>).
//   2. The lib's GetFavorites() — the parsed list the plugin actually builds the "Play Favorite"
//      dropdown from (sonosFavoritesCache.getFavorites()).
// Then it diffs the two: any RAW favorite missing from the parsed list is a bug candidate.
//
// Motivated by issue #3 — "Sonos Radio" favorites never appear in the dropdown while Spotify /
// TIDAL / TuneIn ones do. Add a Sonos Radio station to Sonos Favorites first, then run this.
//
// Run: node tools/dump-favorites.mjs <speaker-ip>
//   A speaker IP is REQUIRED — this talks straight to one device (no SSDP, no SonosManager, no
//   GENA event listener) so it can run side-by-side with the plugin (npm run watch) without
//   fighting over the event-listener port.

import { SonosDevice } from '@svrooij/sonos';

const ip = process.argv[2];
if (!ip) {
    console.error('Usage: node tools/dump-favorites.mjs <speaker-ip>   (e.g. 192.168.7.210)');
    process.exit(1);
}

const device = new SonosDevice(ip);
console.log(`Using ${ip}\n`);

// --- 1. RAW Browse of FV:2 -------------------------------------------------------------------

const raw = await device.ContentDirectoryService.Browse({
    ObjectID: 'FV:2',
    BrowseFlag: 'BrowseDirectChildren',
    Filter: '*',
    StartingIndex: 0,
    RequestedCount: 0,
    SortCriteria: '',
});

const xml = typeof raw.Result === 'string' ? raw.Result : '';
console.log('=== RAW FV:2 Browse ===');
console.log(`NumberReturned=${raw.NumberReturned} TotalMatches=${raw.TotalMatches}\n`);

// Pull every top-level <item ...>...</item> and <container ...>...</container>.
const nodeRe = /<(item|container)\b[^>]*>[\s\S]*?<\/\1>/g;
const rawEntries = [];
let m;
while ((m = nodeRe.exec(xml)) !== null) {
    const node = m[0];
    const tag = m[1];
    const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    const title = decode((node.match(/<dc:title>([\s\S]*?)<\/dc:title>/) ?? [, '(no title)'])[1]);
    const upnpClass = (node.match(/<upnp:class>([\s\S]*?)<\/upnp:class>/) ?? [, '(no class)'])[1];
    const id = (node.match(/\bid="([^"]*)"/) ?? [, ''])[1];
    const hasRes = /<res\b[^>]*>[\s\S]*?<\/res>/.test(node);
    const resUri = hasRes ? decode((node.match(/<res\b[^>]*>([\s\S]*?)<\/res>/) ?? [, ''])[1]) : '';
    const resMd = (node.match(/<r:resMD>([\s\S]*?)<\/r:resMD>/) ?? [, ''])[1];
    rawEntries.push({ tag, title, upnpClass, id, hasRes, resUri, resMd: decode(resMd) });
}

console.log(`Parsed ${rawEntries.length} top-level node(s) from the raw XML:\n`);
for (const e of rawEntries) {
    console.log(`• [${e.tag}] "${e.title}"`);
    console.log(`    class : ${e.upnpClass}`);
    console.log(`    id    : ${e.id}`);
    console.log(`    <res> : ${e.hasRes ? e.resUri : '(none)'}`);
    console.log(`    resMD : ${e.resMd || '(none)'}`);
    console.log('');
}

// --- 2. Parsed GetFavorites() --------------------------------------------------------------

const favResp = await device.GetFavorites();
const parsed = Array.isArray(favResp.Result) ? favResp.Result : [];
console.log('=== Parsed GetFavorites() (what the dropdown uses) ===');
console.log(`${parsed.length} favorite(s):\n`);
for (const f of parsed) {
    console.log(`• "${f.Title}"  TrackUri=${f.TrackUri ?? '(undefined)'}  class=${f.UpnpClass ?? '(none)'}`);
}

// --- 3. Diff -----------------------------------------------------------------------------------

const parsedTitles = new Set(parsed.map((f) => (f.Title ?? '').trim()));
const missing = rawEntries.filter((e) => !parsedTitles.has(e.title.trim()));

console.log('\n=== MISSING from the parsed list (raw favorites the dropdown drops) ===');
if (missing.length === 0) {
    console.log('(none — every raw favorite made it through)');
} else {
    for (const e of missing) {
        console.log(`• [${e.tag}] "${e.title}"  class=${e.upnpClass}  hasRes=${e.hasRes}`);
    }
}

process.exit(0);
