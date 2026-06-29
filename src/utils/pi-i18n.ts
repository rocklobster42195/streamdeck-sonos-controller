import streamDeck from "@elgato/streamdeck";
import enJson from '../../de.boriskemper.sonos-controller.sdPlugin/en.json';
import deJson from '../../de.boriskemper.sonos-controller.sdPlugin/de.json';
import esJson from '../../de.boriskemper.sonos-controller.sdPlugin/es.json';

type Locs = Record<string, string>;

const locs: Record<string, Locs> = {
    en: enJson.Localization as Locs,
    de: deJson.Localization as Locs,
    es: esJson.Localization as Locs,
};

export function piT(key: string): string {
    const lang = (streamDeck.info.application.language ?? 'en').split('-')[0].toLowerCase();
    return locs[lang]?.[key] ?? key;
}
