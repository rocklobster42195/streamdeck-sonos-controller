// Shared PI helper — shows/hides a battery-mode dropdown's wrapping <sdpi-item> based on a
// hidden <sdpi-checkbox setting="hasBattery">. The backend computes hasBattery (does the current
// deviceIp actually report battery data? see src/sonos/SonosBattery.ts) on every settings sync and
// writes it back via setSettings() — this file reacts to that value arriving through the same
// settings-sync channel every other bound field already uses (proven reliable throughout this
// plugin), via the same "listen for valuechange" pattern used elsewhere (e.g. vizSelect in
// track-control-dial.html). Confirmed working via console logging before wiring up the hide/show
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

    // 2026-07-15: tried a wireBatteryCapabilityOption() here that hid/disabled a single <option>
    // inside a datasource-populated <sdpi-select> (MultiControlKey's function dropdown), reusing
    // the same hasBattery checkbox signal. Removed — confirmed not working on hardware (Battery
    // stayed selectable on a non-battery device). Most likely cause: sdpi-select's `datasource`
    // items probably aren't materialized as real light-DOM <option> elements at all (rendered
    // internally instead), so a plain querySelector('option[value=...]') from outside the
    // component silently finds nothing and no-ops forever. wireBatteryCapability above only ever
    // hides a whole <sdpi-item> wrapper (a plain layout element, not the select's own internals),
    // which is why THAT one is proven reliable. Don't retry per-option hiding inside a
    // datasource-driven select without confirming in a browser devtools inspector first that real
    // <option> children actually exist in the light DOM — use a separate warning-hint <sdpi-item>
    // instead (see multi-control-key.html) when a per-option gate is needed.
})();
