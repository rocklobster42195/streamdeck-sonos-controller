// Publishes the version tools/bump-version.mjs just bumped: pushes the commit + tag, creates the
// GitHub release via the gh CLI (already authenticated in this environment — simpler than a raw
// token+fetch approach), and — stable releases only — packs the local .streamDeckPlugin for
// manual Elgato Marketplace upload. See the "Automated release pipeline" plan for full rationale.
//
// Usage:
//   node tools/release.mjs
//
// Prerequisites: tools/bump-version.mjs already ran (local commit + tag exist), gh CLI installed
// and authenticated (`gh auth status`).
//
// If only this step fails (e.g. network hiccup, gh not authenticated), fix the issue and just
// re-run `npm run release` — do NOT re-run `npm run ship:*`, that would bump the version again.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'de.boriskemper.sonos-controller.sdPlugin', 'manifest.json');
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
const pluginDir = 'de.boriskemper.sonos-controller.sdPlugin';

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const [a, b, c, d] = manifest.Version.split('.').map(Number);
const publicVersion = `${a}.${b}.${c}`;
const isBeta = d > 0;
const tag = isBeta ? `v${publicVersion}-beta.${d}` : `v${publicVersion}`;

console.log(`\n🚀 Releasing ${tag}${isBeta ? ' (beta → GitHub pre-release)' : ''}...\n`);

// --- 1. Verify the local tag exists ---
try {
    execSync(`git rev-parse ${tag}`, { stdio: 'pipe' });
    console.log(`  ✅ Git tag ${tag} found`);
} catch {
    console.error(`  ❌ Git tag ${tag} not found locally. Run "npm run version:<patch|minor|major|beta>" first.`);
    process.exit(1);
}

function findPreviousTag(excludeBeta) {
    const tags = execSync('git for-each-ref --sort=-creatordate --format=%(refname:short) refs/tags/v*', { stdio: 'pipe' })
        .toString().trim().split('\n').filter(Boolean);
    return tags.find((t) => t !== tag && (!excludeBeta || !t.includes('-beta.'))) || null;
}

// --- 2. Release notes: stable reads the CHANGELOG.md entry just written; beta always
// auto-collects commits since the previous tag (its own line's history, beta tags included, so
// consecutive beta builds each show just what changed since the last one) ---
let releaseNotes = '';
if (!isBeta) {
    const content = fs.readFileSync(changelogPath, 'utf8').replace(/\r\n/g, '\n');
    const m = content.match(new RegExp(`##\\s*\\[${publicVersion.replace(/\./g, '\\.')}\\][^\n]*\n([\\s\\S]*?)(?=\n---\n\n## |\\n## |$)`));
    if (m && m[1].trim()) {
        releaseNotes = m[1].trim();
        console.log('  ✅ CHANGELOG entry found');
    } else {
        console.warn(`  ⚠️  No CHANGELOG entry for ${publicVersion} — release notes will be empty`);
    }
}
if (!releaseNotes) {
    const prevTag = findPreviousTag(!isBeta);
    const log = prevTag
        ? execSync(`git log ${prevTag}..${tag} --oneline --no-decorate`, { stdio: 'pipe' }).toString().trim()
        : '';
    if (log) {
        const lines = log.split('\n')
            .map((l) => l.replace(/^[a-f0-9]+ /, ''))
            .filter((l) => !/^chore: bump version to [\d.]+/i.test(l))
            .map((l) => `- ${l}`);
        releaseNotes = lines.join('\n');
        console.log(`  ✅ Auto-collected ${lines.length} commit(s) from ${prevTag}..${tag}`);
    }
}

// --- 3. Push commit + this specific tag ---
console.log('  📤 Pushing to origin...');
execSync('git push', { stdio: 'inherit' });
execSync(`git push origin ${tag}`, { stdio: 'inherit' });

// --- 4. Create the GitHub release via gh CLI (notes via a temp file — avoids all shell-quoting
// issues with multi-line content across PowerShell/Git Bash) ---
const notesFile = path.join(os.tmpdir(), `release-notes-${Date.now()}.md`);
fs.writeFileSync(notesFile, releaseNotes || `Release ${tag}`);
try {
    console.log(`  🏷️  Creating GitHub ${isBeta ? 'pre-release' : 'release'} ${tag}...`);
    const prereleaseFlag = isBeta ? '--prerelease' : '';
    execSync(`gh release create ${tag} --title "${tag}" --notes-file "${notesFile}" ${prereleaseFlag}`, { stdio: 'inherit' });
} finally {
    fs.rmSync(notesFile, { force: true });
}

// --- 5. Local .streamDeckPlugin pack for manual Marketplace upload — stable only. The
// Marketplace has no beta channel; beta output is just the GitHub pre-release + CI-attached
// asset for manual side-loading. ---
if (!isBeta) {
    console.log('  📦 Packing local .streamDeckPlugin for Marketplace upload...');
    execSync(`npx streamdeck pack ${pluginDir} --force`, { stdio: 'inherit', cwd: repoRoot });
    // streamdeck pack always names the output after the plugin UUID, not the version — without
    // renaming, an older pack sitting in the repo root from a previous release would look
    // identical and risk being uploaded to the Marketplace by mistake.
    const packedPath = path.join(repoRoot, 'de.boriskemper.sonos-controller.streamDeckPlugin');
    const versionedPath = path.join(repoRoot, `de.boriskemper.sonos-controller-${tag}.streamDeckPlugin`);
    fs.renameSync(packedPath, versionedPath);
    console.log(`  ✅ Renamed → ${path.basename(versionedPath)}`);
}

console.log(`\n✔  ${tag} released. CI build has been triggered.\n`);
