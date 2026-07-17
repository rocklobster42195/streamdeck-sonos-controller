// Shared write-back for probed capability flags (hasBattery on Track Dial / Play-Pause Key,
// hasLineIn on Favorites Dial): the plugin probes the device, then persists the result into the
// action's settings so the PI can react through the settings-sync channel (hidden
// <sdpi-checkbox>, see battery-capability.js) and hide options the device can't support.
//
// The subtle part every call site used to re-implement: setSettings() re-enters
// onDidReceiveSettings once, which re-runs the probe — the recursion terminates on that second
// pass because the persisted value then matches and nothing is written. The `!==` guard here IS
// that termination condition; don't "optimize" it away.
//
// MultiControlKey deliberately does NOT use this: it bundles the flag write with a stale
// controlFunction reset into one setSettings call (two separate writes would re-enter twice).
export async function syncCapabilityFlag<T extends object, K extends keyof T>(
    action: { setSettings(settings: T): Promise<void> },
    settings: T,
    key: K,
    value: T[K],
): Promise<T> {
    if (settings[key] === value) return settings;
    const updated = { ...settings, [key]: value };
    await action.setSettings(updated);
    return updated;
}
