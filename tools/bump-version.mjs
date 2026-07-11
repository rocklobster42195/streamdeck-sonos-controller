// Bumps de.boriskemper.sonos-controller.sdPlugin/manifest.json's Version field, updates
// CHANGELOG.md via its <!-- NEXT --> gate (for stable bumps), and creates the commit + git tag.
// Ported from a sibling project's tools/update-version.js + tools/release.js split, adapted for
// this plugin's actual constraints — see the "Automated release pipeline" plan for the full
// rationale. Key differences from that reference:
//   - No package.json "version" field / npm version lifecycle hook here — manifest.json's
//     "Version" is this project's real source of truth, so this script edits it directly.
//   - manifest.json's Version is a strict 4-segment numeric string ("0.3.2.0"), not semver with a
//     suffix — the 4th segment doubles as a beta build counter (0 for every stable release).
//   - Beta bumps never touch CHANGELOG.md (mirrors the reference project's own rule that the
//     stable changelog + its release gate stay untouched during a beta cycle).
//
// Usage:
//   node tools/bump-version.mjs <patch|minor|major|beta> [--dry-run]
//
// Version scheme (A.B.C.D):
//   patch/minor/major from a stable base (D=0): normal semver bump on A.B.C, D stays 0.
//   patch/minor/major while mid-beta (D>0):     PROMOTES the active beta line — D drops to 0,
//                                                A.B.C unchanged, regardless of which bump was
//                                                requested (same as the reference project: "run
//                                                the normal stable release on the same code").
//   beta from a stable base (D=0):               bumps to the next PATCH target, D starts at 1.
//   beta while already mid-beta (D>0):            D increments, A.B.C unchanged.
// Tag / GitHub release name uses proper semver derived from A.B.C (+ "-beta.D" when D>0),
// independent of the manifest's own numeric format.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'de.boriskemper.sonos-controller.sdPlugin', 'manifest.json');
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');

const bumpType = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!['patch', 'minor', 'major', 'beta'].includes(bumpType)) {
    console.error('Usage: node tools/bump-version.mjs <patch|minor|major|beta> [--dry-run]');
    process.exit(1);
}

function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function findPreviousStableTag() {
    try {
        const tags = execSync('git for-each-ref --sort=-creatordate --format=%(refname:short) refs/tags/v*', { stdio: 'pipe' })
            .toString().trim().split('\n').filter(Boolean);
        return tags.find((t) => !t.includes('-beta.')) || null;
    } catch {
        return null;
    }
}

// --- 1. Compute the new version ---
const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestRaw);
const [a, b, c, d] = manifest.Version.split('.').map(Number);
const wasMidBeta = d > 0;

let newA = a, newB = b, newC = c, newD = d;
if (bumpType === 'beta') {
    if (wasMidBeta) newD = d + 1;
    else { newC = c + 1; newD = 1; }
} else if (wasMidBeta) {
    newD = 0; // promote the active beta line, ignore the requested bump type
} else {
    if (bumpType === 'patch') newC = c + 1;
    else if (bumpType === 'minor') { newB = b + 1; newC = 0; }
    else if (bumpType === 'major') { newA = a + 1; newB = 0; newC = 0; }
    newD = 0;
}

const newVersion4 = `${newA}.${newB}.${newC}.${newD}`;
const publicVersion = `${newA}.${newB}.${newC}`;
const isBeta = newD > 0;
const tag = isBeta ? `v${publicVersion}-beta.${newD}` : `v${publicVersion}`;

console.log(`\nBumping ${manifest.Version} → ${newVersion4} (tag ${tag})${isBeta ? ' [beta]' : ''}`);
if (bumpType !== 'beta' && wasMidBeta) {
    console.log(`  ↳ promoting active beta ${a}.${b}.${c}-beta.${d} to stable ${publicVersion}`);
}

if (dryRun) {
    console.log('  (dry run — nothing written)\n');
    process.exit(0);
}

// --- 2. manifest.json — targeted string replace to preserve existing formatting. Only the FIRST
// "Version" key matches (the plugin's own, at the top of the file) — manifest.json also has a
// nested Nodejs.Version ("20") further down that must NOT be touched, which is why this uses a
// non-global regex (replaces only the first match) rather than a JSON.stringify round-trip.
const newManifestRaw = manifestRaw.replace(/"Version":\s*"[^"]*"/, `"Version": "${newVersion4}"`);
if (newManifestRaw === manifestRaw) {
    console.error('  ❌ manifest.json Version field not found/replaced — aborting.');
    process.exit(1);
}
fs.writeFileSync(manifestPath, newManifestRaw);
console.log(`  ✅ manifest.json      → ${newVersion4}`);

// --- 3. CHANGELOG.md — only for a stable result (plain stable bump OR a beta-promotion) ---
const writeChangelog = !isBeta;
if (writeChangelog) {
    let content = fs.readFileSync(changelogPath, 'utf8').replace(/\r\n/g, '\n');
    const PLACEHOLDER = '<!-- NEXT -->';
    const SEP = '\n\n---\n';

    const pIdx = content.indexOf(PLACEHOLDER);
    if (pIdx === -1) {
        console.error('  ❌ CHANGELOG.md missing <!-- NEXT --> placeholder — aborting.');
        process.exit(1);
    }
    const sepIdx = content.indexOf(SEP, pIdx + PLACEHOLDER.length);
    let body = sepIdx !== -1
        ? content.slice(pIdx + PLACEHOLDER.length, sepIdx).trim()
        : content.slice(pIdx + PLACEHOLDER.length).trim();
    const rest = sepIdx !== -1 ? content.slice(sepIdx) : '';

    // Auto-collect commits since the last STABLE tag if no notes were pre-written under
    // <!-- NEXT --> — covers everything since the last stable release, beta tags excluded, same
    // as the reference project's "stable release covers everything since the last stable" rule.
    if (!body) {
        const prevTag = findPreviousStableTag();
        const log = prevTag
            ? execSync(`git log ${prevTag}..HEAD --oneline --no-decorate`, { stdio: 'pipe' }).toString().trim()
            : '';
        if (log) {
            const lines = log.split('\n')
                .map((l) => l.replace(/^[a-f0-9]+ /, ''))
                .filter((l) => !/^chore: bump version to [\d.]+/i.test(l))
                .map((l) => `- ${l}`);
            if (lines.length > 0) body = lines.join('\n');
        }
    }

    const newEntry = body ? `## [${publicVersion}] — ${today()}\n\n${body}` : `## [${publicVersion}] — ${today()}`;
    content = `${PLACEHOLDER}\n\n---\n\n${newEntry}${rest}`;
    fs.writeFileSync(changelogPath, content);
    console.log(`  ✅ CHANGELOG.md       → [${publicVersion}] - ${today()}${body ? ' (with notes)' : ' (auto: no commits found)'}`);
} else {
    console.log('  ⏭  CHANGELOG.md       → skipped (beta bump)');
}

// --- 4. Commit + tag ---
const filesToStage = [`"${manifestPath}"`];
if (writeChangelog) filesToStage.push(`"${changelogPath}"`);
execSync(`git add ${filesToStage.join(' ')}`, { stdio: 'inherit' });
execSync(`git commit -m "chore: bump version to ${newVersion4}"`, { stdio: 'inherit' });
execSync(`git tag ${tag}`, { stdio: 'inherit' });

console.log(`\n✔  ${newVersion4} (tag ${tag}) ready. Run "npm run release" to publish.\n`);
