// MDI paths for <pi-choice data-options='[{"icon":"alignLeft",…}]'> tiles (same icons as on the keys).
import { mdiAllInclusive, mdiCardTextOutline, mdiChartDonut, mdiCircleSlice3, mdiEqualizer, mdiFormatAlignCenter, mdiFormatAlignLeft, mdiFormatAlignRight, mdiGauge, mdiRepeat, mdiShuffleVariant, mdiSkipNext, mdiSkipPrevious, mdiTransition, mdiVolumeMedium, mdiVolumeMinus, mdiVolumeOff, mdiVolumePlus } from "@mdi/js";

export const CHOICE_ICONS: Record<string, string> = {
    alignLeft: mdiFormatAlignLeft,
    alignCenter: mdiFormatAlignCenter,
    alignRight: mdiFormatAlignRight,
    next: mdiSkipNext,
    previous: mdiSkipPrevious,
    shuffle: mdiShuffleVariant,
    repeat: mdiRepeat,
    crossfade: mdiTransition,
    dontStop: mdiAllInclusive,
    volumeUp: mdiVolumePlus,
    volumeDown: mdiVolumeMinus,
    volumeOff: mdiVolumeOff,
    volumeMedium: mdiVolumeMedium,
    trackInfo: mdiCardTextOutline,
    eq: mdiEqualizer,
    gaugeRing: mdiChartDonut,
    gaugePie: mdiCircleSlice3,
    gaugeOpen: mdiGauge,
};
