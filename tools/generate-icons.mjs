import sharp from 'sharp';
import {
    mdiPlayCircle, mdiStarCircle, mdiPlaylistPlay,
    mdiVolumeHigh, mdiVolumeOff, mdiKnob, mdiHeartCircle,
    mdiCreation, mdiMusicCircle,
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

await write(mdiPlayCircle,   `${IMGS}/actions/sonos-toggle-play`,      'icon');
await write(mdiHeartCircle,  `${IMGS}/actions/sonos-play-favorite`,    'icon');
await write(mdiPlaylistPlay, `${IMGS}/actions/sonos-playback-control`, 'icon');
await write(mdiVolumeHigh,   `${IMGS}/actions/sonos-key-volume`,       'icon');
await write(mdiVolumeOff,    `${IMGS}/actions/sonos-key-volume`,       'icon-muted');
await write(mdiKnob,         `${IMGS}/actions/sonos-dial-volume`,      'icon');
await write(mdiHeartCircle,  `${IMGS}/actions/sonos-dial-favorites`,   'icon');
await write(mdiCreation,     `${IMGS}/actions/sonos-dial-particles`,   'icon');
await write(mdiMusicCircle,  `${IMGS}/actions/sonos-dial-track`,       'icon');

console.log('Done.');
