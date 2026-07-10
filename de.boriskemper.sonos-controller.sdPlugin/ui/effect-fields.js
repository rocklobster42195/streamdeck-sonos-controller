// Generic Property Inspector renderer for effect settingsSchema fields (color/range/checkbox/
// select) — shared by all 4 dial actions' PI HTML (sonos-dial-particles/track/volume/
// group-volume.html). Building this once here means a newly contributed effect's settingsSchema
// automatically gets PI controls on every dial that can host effects, with zero hand-wiring.
//
// See CONTRIBUTING_EFFECTS.md for the settingsSchema contract (EffectField union).
(function () {
    var manifestPromise = fetch('effects-manifest.generated.json').then(function (r) { return r.json(); });
    var renderGen = 0;

    function setAttrs(el, attrs) {
        Object.keys(attrs).forEach(function (k) {
            var v = attrs[k];
            if (v !== undefined && v !== null) el.setAttribute(k, String(v));
        });
    }

    // sdpi-color's native <input type="color"> binds via .defaultValue, not .value — the browser
    // only honors defaultValue before the input is "dirty" (i.e. on first render), so setting the
    // wrapper's .value alone persists the new setting fine but doesn't refresh an already-dirty
    // swatch. Reach into its shadow DOM so a reset visibly updates immediately (same technique
    // this file's predecessor markup used for the old hand-wired Boing Ball reset button).
    function setColorValue(sdpiColorEl, hex) {
        sdpiColorEl.value = hex;
        sdpiColorEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
        var nativeInput = sdpiColorEl.shadowRoot && sdpiColorEl.shadowRoot.querySelector('input[type="color"]');
        if (nativeInput) nativeInput.value = hex;
    }

    // `value` is deliberately set as a JS property, not an HTML attribute — sdpi-components'
    // shared setting-binding mixin declares `value` with `attribute: false`, so only a direct
    // property assignment actually seeds the control before its own settings sync runs.
    function buildFieldControl(field, currentValue) {
        var el;
        switch (field.type) {
            case 'color':
                el = document.createElement('sdpi-color');
                setAttrs(el, { setting: field.key });
                el.value = currentValue;
                return el;
            case 'range':
                el = document.createElement('sdpi-range');
                setAttrs(el, { setting: field.key, min: field.min, max: field.max, step: field.step || 1, showlabels: true });
                el.value = currentValue;
                return el;
            case 'checkbox':
                el = document.createElement('sdpi-checkbox');
                setAttrs(el, { setting: field.key });
                el.value = currentValue;
                return el;
            case 'select':
                el = document.createElement('sdpi-select');
                setAttrs(el, { setting: field.key });
                (field.options || []).forEach(function (opt) {
                    var o = document.createElement('option');
                    o.setAttribute('value', opt.value);
                    o.textContent = opt.label;
                    el.appendChild(o);
                });
                el.value = currentValue;
                return el;
            default:
                return null;
        }
    }

    function resetControl(el, field) {
        if (field.type === 'color') setColorValue(el, field.default);
        else el.value = field.default;
    }

    // Renders the PI controls for `effectId`'s settingsSchema into `container`, replacing
    // whatever was there before. Each control's `setting="<field.key>"` attribute is all that's
    // needed for sdpi-components' own mixin to load/save the real persisted value — exactly the
    // same mechanism the pre-existing static fields elsewhere in this codebase already rely on.
    // Seeded with the effect's schema default only as a same-tick fallback until that sync lands.
    //
    // Deliberately does NOT round-trip through window.SDPIComponents.streamDeckClient.getSettings()
    // / setSettings() to pre-seed or backfill values — found the hard way that doing so corrupts
    // the action's settings: getSettings() here returned an object shaped like the outer
    // didReceiveSettings payload (controller/coordinates/isInMultiAction/resources/settings), not
    // a flat settings blob, so writing it straight back via setSettings() wrapped the REAL settings
    // one level deeper in a `settings` key on every single render — progressively, permanently
    // nesting them (`settings.settings.settings...`) until fields like deviceIp became unreachable
    // at the top level the plugin backend reads. Missing-default backfill now happens on the
    // backend instead (in each dial action's TypeScript, against the real typed settings object).
    window.renderEffectFields = function (container, effectId) {
        var gen = ++renderGen;

        manifestPromise.then(function (manifest) {
            if (gen !== renderGen) return; // superseded by a later effect switch
            var def = (manifest.effects || []).find(function (e) { return e.id === effectId; });
            container.innerHTML = '';
            if (!def || !def.settingsSchema.length) return;

            var controls = [];
            def.settingsSchema.forEach(function (field) {
                var control = buildFieldControl(field, field.default);
                if (!control) return;
                controls.push([control, field]);
                var item = document.createElement('sdpi-item');
                item.setAttribute('label', field.label);
                item.appendChild(control);
                container.appendChild(item);
            });

            var resetItem = document.createElement('sdpi-item');
            var resetBtn = document.createElement('sdpi-button');
            resetBtn.textContent = 'Reset to defaults';
            resetBtn.addEventListener('click', function () {
                controls.forEach(function (pair) { resetControl(pair[0], pair[1]); });
            });
            resetItem.appendChild(resetBtn);
            container.appendChild(resetItem);
        });
    };
})();
