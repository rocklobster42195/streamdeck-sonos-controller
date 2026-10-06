// Entry of the property inspector bundle (ui/pi.js), for the PI pages that use the kit's
// components. The same page runs as the short PI and, with "?window", as the settings window
// (the kit's window.ts): sections with class "pi-win" show only there.
import { definePiComponents, initChoiceOptions, initConditionalVisibility, initSettingsWindow, registerSelectParams, sd, settingsWindowShown, t, translateDom } from "@rocklobster42195/streamdeck-kit/pi";
import { CHOICE_ICONS } from "./choice-icons";

initSettingsWindow({ name: "SO-C" });

// <pi-select with="device">/<… with="group">: the action's current choice, so the plugin keeps it
// in the list while that speaker is offline
registerSelectParams("device", () => ({ deviceIp: String(sd.settings.deviceIp ?? "") }));
registerSelectParams("group", () => ({ groupIp: String(sd.settings.groupIp ?? "") }));
// What the speaker has (written into the settings by the key), for the Multi-Control functions
registerSelectParams("caps", () => ({ hasLineIn: String(sd.settings.hasLineIn ?? ""), hasBattery: String(sd.settings.hasBattery ?? "") }));

// The transport keys' player section: "Sonos device" while only Sonos speakers are there, "Device"
// once other plugins' players (Music Assistant, music on the computer …) are in the list
let otherPlayers = false;
const titleDeviceSection = () => {
    const title = document.querySelector<HTMLElement>("pi-section[data-player-section] .pi-section-title");
    if (title) title.textContent = t(otherPlayers ? "pi.device_any" : "pi.sonos_device");
};
sd.onMessage((msg: { event?: string; any?: boolean }) => {
    if (msg?.event !== "soc-other-players") return;
    otherPlayers = msg.any === true;
    titleDeviceSection();
});

// Components render translated text, so wait until Stream Deck told us the language.
sd.onReady(() => {
    translateDom();
    definePiComponents();
    initChoiceOptions(CHOICE_ICONS);
    initConditionalVisibility();
    titleDeviceSection();
    const version = document.querySelector<HTMLElement>("[data-plugin-version]");
    if (version) version.textContent = `SO-C ${sd.info?.plugin.version ?? ""}`.trim();
    document.querySelectorAll<HTMLAnchorElement>("a[href^='http']").forEach((a) =>
        a.addEventListener("click", (e) => {
            e.preventDefault();
            sd.openUrl(a.href);
        }),
    );
    document.body.hidden = false;
    settingsWindowShown();
});
