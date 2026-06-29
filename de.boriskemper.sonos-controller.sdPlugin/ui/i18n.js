// Property Inspector i18n — applies translations based on Stream Deck's configured language.
// Keys match the "Localization" entries in en/de/es.json; values are the UI-specific strings
// not already covered by the manifest locale files.
(function () {
    // navigator.language reflects the OS/browser language (e.g. "de-DE" → "de").
    // This is what Stream Deck's webview inherits from the system language setting.
    var lang = (window.navigator.language || 'en').split('-')[0].toLowerCase();

    var dict = {
        de: {
            sonos_device:       'SONOS-Gerät',
            fetching_devices:   'Geräte werden geladen…',
            fetching_favorites: 'Favoriten werden geladen…',
            choose_device:      '-- Gerät wählen --',
            choose_favorite:    '-- Favorit wählen --',
            choose_command:     '-- Befehl wählen --',
            background:         'Hintergrund',
            bg_none_track:      'Keiner (nur Track-Info)',
            bg_eq:              'EQ-Effekt',
            bg_particles:       'Partikel',
            bg_none:            'Keiner',
            particle_count:     'Partikelanzahl',
            particle_speed:     'Partikel-Tempo',
            particle_color:     'Partikelfarbe',
            track_info:         'Track-Info',
            preset_volume:      'Lautstärke-Preset',
            alignment:          'Ausrichtung',
            align_left:         'Links',
            align_center:       'Mitte',
            align_right:        'Rechts',
            command:            'Befehl',
            cmd_mute_preset:    'Stumm / Preset',
            cmd_vol_up:         'Lauter',
            cmd_vol_down:       'Leiser',
            cmd_vol_preset:     'Lautstärke-Preset',
            cmd_next:           'Nächster Titel',
            cmd_previous:       'Vorheriger Titel',
            cmd_shuffle:        'Zufallswiedergabe',
            cmd_repeat:         'Wiederholen',
            show_preset:        'Preset anzeigen',
            show_volume:        'Lautstärke anzeigen',
            device_name:        'Gerätename',
            cover_art:          'Albumcover',
            title_artist:       'Titel (Interpret)',
            font_size:          'Schriftgröße',
            font_color:         'Schriftfarbe',
            favorite:           'Favorit',
            show_title:         'Titel anzeigen',
            browse_timeout:     'Rückkehr-Timeout',
            fav_hint:           'Drehen zum Blättern durch alle Sonos-Favoriten.<br>Drücken zum Abspielen. Tippen oder warten, um zur aktuellen Wiedergabe zurückzukehren.',
            show_text:          'Text anzeigen',
            show_text_yes:      'Lautstärke % und Gerätename',
            show_text_no:       'Nur Tortendiagramm',
        },
        es: {
            sonos_device:       'Dispositivo SONOS',
            fetching_devices:   'Cargando dispositivos…',
            fetching_favorites: 'Cargando favoritos…',
            choose_device:      '-- Elegir dispositivo --',
            choose_favorite:    '-- Elegir favorito --',
            choose_command:     '-- Seleccionar comando --',
            background:         'Fondo',
            bg_none_track:      'Ninguno (solo info de pista)',
            bg_eq:              'Efecto EQ',
            bg_particles:       'Partículas',
            bg_none:            'Ninguno',
            particle_count:     'Cantidad de partículas',
            particle_speed:     'Velocidad de partículas',
            particle_color:     'Color de partículas',
            track_info:         'Info de pista',
            preset_volume:      'Volumen preestablecido',
            alignment:          'Alineación',
            align_left:         'Izquierda',
            align_center:       'Centro',
            align_right:        'Derecha',
            command:            'Comando',
            cmd_mute_preset:    'Silenciar / Preset',
            cmd_vol_up:         'Subir volumen',
            cmd_vol_down:       'Bajar volumen',
            cmd_vol_preset:     'Preset de volumen',
            cmd_next:           'Siguiente pista',
            cmd_previous:       'Pista anterior',
            cmd_shuffle:        'Aleatorio',
            cmd_repeat:         'Repetir',
            show_preset:        'Mostrar preset',
            show_volume:        'Mostrar volumen',
            device_name:        'Nombre del dispositivo',
            cover_art:          'Portada',
            title_artist:       'Título (Artista)',
            font_size:          'Tamaño de fuente',
            font_color:         'Color de fuente',
            favorite:           'Favorito',
            show_title:         'Mostrar título',
            browse_timeout:     'Tiempo de retorno',
            fav_hint:           'Gira para explorar tus favoritos de Sonos.<br>Pulsa para reproducir. Toca o espera para volver a la reproducción actual.',
            show_text:          'Mostrar texto',
            show_text_yes:      'Volumen % y nombre del dispositivo',
            show_text_no:       'Solo gráfico circular',
        },
    };

    function applyAll() {
        var t = dict[lang];
        if (!t) return;

        document.querySelectorAll('sdpi-item[data-i18n]').forEach(function (el) {
            var v = t[el.dataset.i18n];
            if (v) el.setAttribute('label', v);
        });
        document.querySelectorAll('option[data-i18n]').forEach(function (el) {
            var v = t[el.dataset.i18n];
            if (v) el.textContent = v;
        });
        document.querySelectorAll('[data-i18n-loading]').forEach(function (el) {
            var v = t[el.dataset.i18nLoading];
            if (v) el.setAttribute('loading', v);
        });
        document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
            var v = t[el.dataset.i18nHtml];
            if (v) el.innerHTML = v;
        });
    }

    // Both scripts are defer — DOM is parsed and sdpi-components has NOT yet upgraded
    // the elements when this runs. Setting label attributes here means sdpi-item reads
    // the translated value in its connectedCallback.
    applyAll();

    // Re-apply once connected in case Stream Deck reports a different language than navigator.
    window.addEventListener('connected', function (ev) {
        var appLang = (
            ev.detail && ev.detail.info &&
            ev.detail.info.application &&
            ev.detail.info.application.language || ''
        ).split('-')[0].toLowerCase();

        var resolved = appLang || lang;
        if (resolved !== lang) { lang = resolved; applyAll(); }
    });
})();
