import sharp from 'sharp';
import {
    mdiPlayCircle, mdiStarCircle, mdiPlaylistPlay,
    mdiVolumeHigh, mdiVolumeOff, mdiKnob, mdiHeartCircle,
    mdiCreation, mdiMusicCircle, mdiAccessPointNetwork,
    mdiPlaylistMusic, mdiHexagonMultiple,
} from '@mdi/js';
import fs from 'fs';
import path from 'path';

const COLOR = '#CCCCCC';
const IMGS = 'de.boriskemper.sonos-controller.sdPlugin/imgs';

function makeSvg(mdiPath, canvasSize = 72) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasSize}" height="${canvasSize}" viewBox="0 0 24 24">
    <path fill="${COLOR}" d="${mdiPath}"/>
</svg>`;
}

async function write(mdiPath, outDir, name) {
    fs.mkdirSync(outDir, { recursive: true });
    const svg1x = Buffer.from(makeSvg(mdiPath, 72));
    const svg2x = Buffer.from(makeSvg(mdiPath, 144));
    await sharp(svg1x).png().toFile(path.join(outDir, `${name}.png`));
    await sharp(svg2x).png().toFile(path.join(outDir, `${name}@2x.png`));
    console.log(`  ✓ ${path.join(outDir, name)}.png`);
}

await write(mdiPlayCircle,   `${IMGS}/actions/play-pause-key`,      'icon');
await write(mdiHeartCircle,  `${IMGS}/actions/play-favorite-key`,    'icon');
await write(mdiPlaylistPlay, `${IMGS}/actions/playback-control-key`, 'icon');
await write(mdiVolumeHigh,   `${IMGS}/actions/volume-control-key`,       'icon');
await write(mdiVolumeOff,    `${IMGS}/actions/volume-control-key`,       'icon-muted');
await write(mdiKnob,         `${IMGS}/actions/volume-dial`,      'icon');
await write(mdiHeartCircle,  `${IMGS}/actions/favorites-dial`,   'icon');
await write(mdiCreation,     `${IMGS}/actions/panorama-effects-dial`,   'icon');
await write(mdiMusicCircle,  `${IMGS}/actions/track-control-dial`,       'icon');
await write(mdiAccessPointNetwork, `${IMGS}/actions/diagnostics-dial`, 'icon');
await write(mdiPlaylistMusic, `${IMGS}/actions/queue-dial`,       'icon');
await write(mdiHexagonMultiple, `${IMGS}/actions/multi-control-key`, 'icon');

console.log('Done.');
