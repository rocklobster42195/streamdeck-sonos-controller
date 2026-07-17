// Builds src/effects/preview-server.ts and starts it, all in this one Node process.
//
// Deliberately uses Rollup's JS API instead of shelling out to the `rollup` CLI (e.g. via
// `rollup ... && node ...`). On some Windows setups, the rollup CLI process doesn't hand
// control back to cmd.exe's `&&` even after finishing its build — the outer command just hangs
// forever and the server never starts. Building in-process here sidesteps that entirely, and
// the freshly built bundle is imported directly afterward instead of spawning a second process.

import { rollup } from "rollup";
import config from "../rollup.preview.config.mjs";

const bundle = await rollup(config);
await bundle.write(config.output);
await bundle.close();

await import("./effects-preview-server.bundle.mjs");
