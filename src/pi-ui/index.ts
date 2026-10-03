// Entry of the property inspector bundle (ui/pi.js), for the PI pages that use the kit's
// components. The same page runs as the short PI and, with "?window", as the settings window
// (the kit's window.ts): sections with class "pi-win" show only there.
import { definePiComponents, initConditionalVisibility, initSettingsWindow, sd, settingsWindowShown, translateDom } from "@rocklobster42195/streamdeck-kit/pi";

initSettingsWindow({ name: "SO-C" });

// Components render translated text, so wait until Stream Deck told us the language.
sd.onReady(() => {
    translateDom();
    definePiComponents();
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
