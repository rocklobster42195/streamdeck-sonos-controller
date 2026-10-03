import streamDeck from "@elgato/streamdeck";
import enJson from '../../de.boriskemper.sonos-controller.sdPlugin/en.json';
import deJson from '../../de.boriskemper.sonos-controller.sdPlugin/de.json';
import esJson from '../../de.boriskemper.sonos-controller.sdPlugin/es.json';

// Flat plugin texts; the nested "pi" group belongs to the property inspectors (the kit reads it).
type Locs = Record<string, unknown>;

const locs: Record<string, Locs> = {
    en: enJson.Localization as Locs,
    de: deJson.Localization as Locs,
    es: esJson.Localization as Locs,
};

export function piT(key: string): string {
    const lang = (streamDeck.info.application.language ?? 'en').split('-')[0].toLowerCase();
    const v = locs[lang]?.[key];
    return typeof v === 'string' ? v : key;
}
