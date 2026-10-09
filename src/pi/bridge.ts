// Plugin side of the kit's property inspector: the lists its <pi-select> fields ask for. The PI
// pages that still use sdpi-components keep talking to their actions' onSendToPlugin; both run
// side by side until every page has moved.
import { piBridge, trackActions } from "@rocklobster42195/streamdeck-kit/bridge";
import { mdiOptions } from "@rocklobster42195/streamdeck-kit/mdi";
import { panoramaRows, socActions } from "../effects/panorama";
import { deviceItems, groupItems } from "../actions/pi-options";
import { hasOtherPlayers, isRemote, playerItems, remoteItems } from "../actions/remote-player";
import { sonosFavoritesCache } from "../sonos/sonos-discovery";
import { piT } from "../utils/pi-i18n";

/** Call before streamDeck.connect(), so no willAppear is missed (the Panorama needs every dial's place). */
export function initPiBridge(): void {
    trackActions(socActions);
    piBridge.init();
    // The PI's Panorama section (<pi-panorama>): the row's effect, its dials and settings
    panoramaRows.attachPi(piBridge);
    // `deviceIp`/`groupIp`: the action's current choice, kept in the list while it is offline
    // <pi-icon-picker>: search all Material Design Icons
    piBridge.registerOptions("mdi-icons", mdiOptions);
    // The universal keys' player (Play/Pause): every room, then other plugins' players
    piBridge.registerOptions("players", () => playerItems());
    piBridge.registerOptions("sonos-devices", ({ deviceIp }) => deviceItems(deviceIp || undefined));
    // Transport keys: the Sonos speakers, then "Active player" and other plugins' players (deckbus)
    piBridge.registerOptions("sonos-players", async ({ deviceIp }) => [...(await deviceItems(isRemote(deviceIp) ? undefined : deviceIp || undefined)), ...remoteItems(deviceIp)]);
    // The transport keys' section title: "Device" once other plugins' players are in the list
    piBridge.addPusher(() => [{ event: "soc-other-players", any: hasOtherPlayers() }]);
    piBridge.registerOptions("sonos-groups", ({ groupIp }) => groupItems(groupIp || undefined));
    // Play Favorite: the value is the whole favorite as JSON (what the key always stored)
    piBridge.registerOptions("sonos-favorites", () =>
        (sonosFavoritesCache.getFavorites() ?? []).map((fav) => ({ value: JSON.stringify(fav), label: fav.Title })),
    );
    // Multi-Control: only what the speaker has (the key writes hasLineIn/hasBattery into its settings)
    piBridge.registerOptions("sonos-functions", ({ hasLineIn, hasBattery }) => [
        ...(hasLineIn === "true" ? [{ value: "line-in", label: piT("Line-In") }] : []),
        ...(hasBattery === "true" ? [{ value: "battery", label: piT("Battery") }] : []),
    ]);
}
