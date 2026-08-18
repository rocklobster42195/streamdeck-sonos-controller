import commonjs from "@rollup/plugin-commonjs";
import json from '@rollup/plugin-json';
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import copy from "rollup-plugin-copy";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { generateEffectsRegistry } from "./tools/generate-effects-registry.mjs";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "de.boriskemper.sonos-controller.sdPlugin";

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
	input: "src/plugin.ts",
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		sourcemap: isWatching,
		sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
			return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
		}
	},
	plugins: [
        copy({
            targets: [
                // Only the font is actually needed at runtime (see TitleAnimator.ts) — copying
                // the whole assets/ folder used to also bundle README screenshots and Marketplace
                // store images into the shipped .streamDeckPlugin for no reason.
                { src: 'assets/OpenSans-Bold.ttf', dest: `${sdPlugin}/assets` }
            ]
        }),
		{
			name: "watch-externals",
			buildStart: function () {
				this.addWatchFile(`${sdPlugin}/manifest.json`);
			},
		},
		{
			name: "generate-effects-registry",
			buildStart: function () {
				generateEffectsRegistry();
				for (const dir of fs.readdirSync("src/effects", { withFileTypes: true })) {
					if (dir.isDirectory()) this.addWatchFile(path.join("src/effects", dir.name, "index.ts"));
				}
			},
		},
		typescript({
			mapRoot: isWatching ? "./" : undefined
		}),
		nodeResolve({
			browser: false,
			exportConditions: ["node"],
			preferBuiltins: true
		}),
		commonjs(),
		!isWatching && terser(),
		{
			name: "emit-module-package-file",
			generateBundle() {
				this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
			}
		},
		json()
	]
};

export default config;
