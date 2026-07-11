// Shared PI helper — shows/hides a battery-mode dropdown's wrapping <sdpi-item> based on a
// hidden <sdpi-checkbox setting="hasBattery">. The backend computes hasBattery (does the current
// deviceIp actually report battery data? see src/sonos/SonosBattery.ts) on every settings sync and
// writes it back via setSettings() — this file reacts to that value arriving through the same
// settings-sync channel every other bound field already uses (proven reliable throughout this
// plugin), via the same "listen for valuechange" pattern used elsewhere (e.g. vizSelect in
// sonos-dial-track.html). Confirmed working via console logging before wiring up the hide/show
// behavior below (checkbox correctly receives hasBattery:true for a Roam).
//
// Earlier versions of this file tried a live PI<->plugin message round trip instead (three
// attempts, escalating in risk — one opened a second raw WebSocket to the Stream Deck PI port and
// broke sdpi-components' OWN connection badly enough that the unrelated device-list datasource
// stopped populating entirely). Don't go back to that; this settings-sync approach needs no
// custom messaging at all.
(function () {
    window.wireBatteryCapability = function (hasBatteryCheckbox, batteryItem) {
        function refresh() {
            batteryItem.classList.toggle('hidden', !hasBatteryCheckbox.value);
        }
        hasBatteryCheckbox.addEventListener('valuechange', refresh);
        refresh();
    };
})();
