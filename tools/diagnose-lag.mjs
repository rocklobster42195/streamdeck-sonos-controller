// Analyzes the plugin's own log files for lag-causing anomalies — repeated/bursty log lines,
// error frequency, slow discovery, and suspiciously large gaps between consecutive lines.
//
// Every "feels slow" investigation in this project's history was eventually root-caused by
// reading these logs by hand (see feedback-volume-dial-animation-tuning memory: a cover-fetch
// retry storm, a leaked-controller slowdown, and a group-fade timeout gap were all found this
// way, never by guessing from the render/animation code first). This script automates that first
// pass so it takes seconds instead of several rounds of ad-hoc grep commands.
//
// Run: node tools/diagnose-lag.mjs [logfile]
//   - No argument: analyzes the newest log (de.boriskemper.sonos-controller.0.log).
//   - A number (0-9): analyzes that specific rotated log.
//   - A path: analyzes that file directly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const logsDir = path.join(repoRoot, 'de.boriskemper.sonos-controller.sdPlugin', 'logs');

// --- Argument handling ---

function resolveLogPath(arg) {
    if (!arg) return path.join(logsDir, 'de.boriskemper.sonos-controller.0.log');
    if (/^\d$/.test(arg)) return path.join(logsDir, `de.boriskemper.sonos-controller.${arg}.log`);
    return path.isAbsolute(arg) ? arg : path.join(repoRoot, arg);
}

const logPath = resolveLogPath(process.argv[2]);
if (!fs.existsSync(logPath)) {
    console.error(`Log not found: ${logPath}`);
    console.error(`Available logs in ${logsDir}:`);
    for (const f of fs.readdirSync(logsDir).sort()) console.error(`  ${f}`);
    process.exit(1);
}

// --- Parsing ---

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(INFO|WARN|ERROR|DEBUG)\s+(.*)$/;

const raw = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
const lines = [];
for (const l of raw) {
    const m = l.match(LINE_RE);
    if (m) {
        lines.push({ time: new Date(m[1]).getTime(), level: m[2], msg: m[3] });
    } else if (lines.length > 0) {
        // Stack trace / continuation line — fold into the previous entry's message for
        // normalization purposes, but don't count it as its own line.
        lines[lines.length - 1].msg += ' ' + l.trim();
    }
}

if (lines.length === 0) {
    console.log(`${path.basename(logPath)}: no parseable log lines.`);
    process.exit(0);
}

console.log(`Analyzing ${path.basename(logPath)} — ${lines.length} lines, ${new Date(lines[0].time).toISOString()} .. ${new Date(lines[lines.length - 1].time).toISOString()}\n`);

// --- 1. Discovery timing ---

const connectLine = lines.find(l => l.msg.includes('Discovery running in background'));
const completeLine = lines.find(l => l.msg.includes('discovery completed'));
const failLines = lines.filter(l => l.msg.includes('Sonos discovery failed'));

if (connectLine) {
    if (completeLine) {
        const ms = completeLine.time - connectLine.time;
        const flag = ms > 5000 ? '  <-- SLOW (>5s)' : '';
        console.log(`Discovery: ${ms}ms from plugin start to first success (${failLines.length} failed attempt(s) along the way)${flag}`);
    } else {
        console.log(`Discovery: never succeeded in this log (${failLines.length} failed attempt(s)) — devices/PI dropdowns had nothing to show for the whole log window.`);
    }
} else {
    console.log('Discovery: no startup marker in this log window (log rotated mid-session).');
}
console.log('');

// --- 2. Level counts ---

const levelCounts = {};
for (const l of lines) levelCounts[l.level] = (levelCounts[l.level] ?? 0) + 1;
console.log('Level counts:', Object.entries(levelCounts).map(([k, v]) => `${k}=${v}`).join(', '));
console.log('');

// --- 3. Normalize + group for repeated-message / burst detection ---

function normalize(msg) {
    return msg
        .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<ip>')
        .replace(/"[^"]*"/g, '"<val>"')
        .replace(/\[[a-f0-9]{16,}\]/gi, '[<ctx>]')
        .replace(/\b\d+ms\b/g, '<n>ms')
        .replace(/\b\d{2,}\b/g, '<n>')
        .trim()
        .slice(0, 140);
}

const groups = new Map(); // normalized -> { count, level, times: number[] }
for (const l of lines) {
    const key = `${l.level} ${normalize(l.msg)}`;
    let g = groups.get(key);
    if (!g) { g = { count: 0, times: [] }; groups.set(key, g); }
    g.count++;
    g.times.push(l.time);
}

// Top repeated messages overall (the "736 of 755 lines were the same error" class of finding).
const topRepeated = [...groups.entries()]
    .filter(([, g]) => g.count >= 5)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);

if (topRepeated.length > 0) {
    console.log('Most-repeated log lines (>=5 occurrences):');
    for (const [key, g] of topRepeated) {
        const spanMs = g.times[g.times.length - 1] - g.times[0];
        console.log(`  ${g.count}x  (span ${(spanMs / 1000).toFixed(1)}s)  ${key}`);
    }
    console.log('');
}

// Bursts: the same normalized message firing >=3 times within a 500ms window — this is what
// catches a render/event storm (e.g. one track-info fire fanning out to every grouped member
// repeatedly) that a plain total count could hide inside a long, otherwise-quiet session.
const BURST_WINDOW_MS = 500;
const BURST_MIN_COUNT = 3;
const bursts = [];
for (const [key, g] of groups) {
    if (g.count < BURST_MIN_COUNT) continue;
    let windowStart = 0;
    for (let i = 0; i < g.times.length; i++) {
        while (g.times[i] - g.times[windowStart] > BURST_WINDOW_MS) windowStart++;
        const countInWindow = i - windowStart + 1;
        if (countInWindow >= BURST_MIN_COUNT) {
            bursts.push({ key, count: countInWindow, at: g.times[i] });
        }
    }
}
if (bursts.length > 0) {
    // Collapse to one entry per key with the max burst size seen, plus how many separate bursts.
    const byKey = new Map();
    for (const b of bursts) {
        const cur = byKey.get(b.key) ?? { maxCount: 0, occurrences: 0 };
        cur.maxCount = Math.max(cur.maxCount, b.count);
        cur.occurrences++;
        byKey.set(b.key, cur);
    }
    console.log(`Bursts (>=${BURST_MIN_COUNT} identical lines within ${BURST_WINDOW_MS}ms):`);
    for (const [key, info] of [...byKey.entries()].sort((a, b) => b[1].maxCount - a[1].maxCount).slice(0, 10)) {
        console.log(`  up to ${info.maxCount} at once, seen ${info.occurrences}x total  ${key}`);
    }
    console.log('');
}

// --- 4. Largest gaps between consecutive lines ---
// A big gap during otherwise-active use can indicate the process was blocked on something
// (e.g. an unbounded network call) rather than genuinely idle — not proof by itself, but worth
// a look if it lines up with a reported lag.

const gaps = [];
for (let i = 1; i < lines.length; i++) {
    gaps.push({ ms: lines[i].time - lines[i - 1].time, before: lines[i - 1], after: lines[i] });
}
const bigGaps = gaps.filter(g => g.ms > 3000).sort((a, b) => b.ms - a.ms).slice(0, 5);
if (bigGaps.length > 0) {
    console.log('Largest gaps between consecutive log lines (>3s):');
    for (const g of bigGaps) {
        console.log(`  ${(g.ms / 1000).toFixed(1)}s at ${new Date(g.after.time).toISOString()}`);
        console.log(`    before: ${g.before.msg.slice(0, 100)}`);
        console.log(`    after:  ${g.after.msg.slice(0, 100)}`);
    }
    console.log('');
}

console.log('Done. For a specific reported lag, re-run against the log covering that moment');
console.log('(pass a rotation number, e.g. `node tools/diagnose-lag.mjs 1`) and look for bursts');
console.log('or gaps around the reported timestamp first.');
