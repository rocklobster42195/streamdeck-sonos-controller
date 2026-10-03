// Entry of the property inspector bundle (ui/pi.js), for the PI pages that use the kit's
// components. The same page runs as the short PI and, with "?window", as the settings window
// (the kit's window.ts): sections with class "pi-win" show only there.
import { definePiComponents, initChoiceOptions, initConditionalVisibility, initSettingsWindow, registerSelectParams, sd, settingsWindowShown, translateDom } from "@rocklobster42195/streamdeck-kit/pi";
import { CHOICE_ICONS } from "./choice-icons";

initSettingsWindow({ name: "SO-C" });

// <pi-select with="device">/<… with="group">: the action's current choice, so the plugin keeps it
// in the list while that speaker is offline
registerSelectParams("device", () => ({ deviceIp: String(sd.settings.deviceIp ?? "") }));
registerSelectParams("group", () => ({ groupIp: String(sd.settings.groupIp ?? "") }));

// Components render translated text, so wait until Stream Deck told us the language.
sd.onReady(() => {
    translateDom();
    definePiComponents();
    initChoiceOptions(CHOICE_ICONS);
    initConditionalVisibility();
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
