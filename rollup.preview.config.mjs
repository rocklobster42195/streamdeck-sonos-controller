import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { generateEffectsRegistry } from "./tools/generate-effects-registry.mjs";

// Separate, dev-only build for src/effects/preview-server.ts (see CONTRIBUTING_EFFECTS.md).
// Kept out of rollup.config.mjs so a normal `npm run build`/`npm run watch` of the actual plugin
// never has to build or ship this tool.

/** @type {import('rollup').RollupOptions} */
const config = {
    input: "src/effects/preview-server.ts",
    output: {
        file: "tools/effects-preview-server.bundle.mjs",
        format: "es",
    },
    external: ["sharp", "gif-encoder-2"],
    plugins: [
        {
            name: "generate-effects-registry",
            buildStart() {
                generateEffectsRegistry();
            },
        },
        typescript(),
        nodeResolve({
            browser: false,
            exportConditions: ["node"],
            preferBuiltins: true,
        }),
        commonjs(),
        json(),
    ],
};

export default config;
