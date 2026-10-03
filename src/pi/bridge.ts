// Plugin side of the kit's property inspector: the lists its <pi-select> fields ask for. The PI
// pages that still use sdpi-components keep talking to their actions' onSendToPlugin; both run
// side by side until every page has moved.
import { piBridge } from "@rocklobster42195/streamdeck-kit/bridge";
import { deviceItems, groupItems } from "../actions/pi-options";

export function initPiBridge(): void {
    piBridge.init();
    // `deviceIp`/`groupIp`: the action's current choice, kept in the list while it is offline
    piBridge.registerOptions("sonos-devices", ({ deviceIp }) => deviceItems(deviceIp || undefined));
    piBridge.registerOptions("sonos-groups", ({ groupIp }) => groupItems(groupIp || undefined));
}
