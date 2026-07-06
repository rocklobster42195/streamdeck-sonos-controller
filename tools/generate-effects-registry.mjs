// Scans src/effects/*/index.ts and generates:
//  - src/effects/registry.generated.ts          (static imports, for the Node plugin bundle)
//  - <sdPlugin>/ui/effects-manifest.generated.json (id/displayName/settingsSchema only, for the PI)
//
// Both outputs are build artifacts (gitignored) — never hand-edited or committed. Re-run
// automatically on every `npm run build` / `npm run watch` via rollup.config.mjs's buildStart hook.
//
// Metadata (id/displayName/settingsSchema) is read straight off each effect's source AST via the
// TypeScript compiler API, WITHOUT executing the module. This is deliberate: an effect's
// `createInstance` may import heavy runtime dependencies, and codegen must stay side-effect-free
// so a contributed effect can never do anything at build time beyond declaring its metadata.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const effectsDir = path.join(repoRoot, 'src', 'effects');
const registryOutFile = path.join(effectsDir, 'registry.generated.ts');
const manifestOutFile = path.join(repoRoot, 'de.boriskemper.sonos-controller.sdPlugin', 'ui', 'effects-manifest.generated.json');

function unwrap(expr) {
    while (
        ts.isAsExpression(expr) ||
        ts.isParenthesizedExpression(expr) ||
        (ts.isSatisfiesExpression && ts.isSatisfiesExpression(expr))
    ) {
        expr = expr.expression;
    }
    return expr;
}

/** Resolve an identifier to the initializer of its `const`/`let` declaration in the same file. */
function resolveExpr(sourceFile, expr) {
    expr = unwrap(expr);
    if (ts.isIdentifier(expr)) {
        let found = null;
        const visit = (node) => {
            if (found) return;
            if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === expr.text && node.initializer) {
                found = node.initializer;
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        return found ? resolveExpr(sourceFile, found) : null;
    }
    return expr;
}

/** Evaluate a literal AST node into a plain JS value. Returns `undefined` for anything that
 *  isn't a compile-time-constant literal (e.g. a function reference like `createInstance`). */
function evalLiteral(node) {
    if (!node) return undefined;
    node = unwrap(node);
    if (ts.isObjectLiteralExpression(node)) {
        const obj = {};
        for (const prop of node.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const key = prop.name.getText().replace(/^['"]|['"]$/g, '');
            obj[key] = evalLiteral(prop.initializer);
        }
        return obj;
    }
    if (ts.isArrayLiteralExpression(node)) {
        return node.elements.map(evalLiteral);
    }
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
        const inner = evalLiteral(node.operand);
        return typeof inner === 'number' ? -inner : undefined;
    }
    return undefined; // not a literal we understand — e.g. `createInstance` function reference
}

function findDefaultExportObject(sourceFile) {
    let exportExpr = null;
    ts.forEachChild(sourceFile, (node) => {
        if (ts.isExportAssignment(node) && !node.isExportEquals) {
            exportExpr = node.expression;
        }
    });
    if (!exportExpr) return null;
    const resolved = resolveExpr(sourceFile, exportExpr);
    return resolved && ts.isObjectLiteralExpression(unwrap(resolved)) ? unwrap(resolved) : null;
}

function readEffectMeta(effectDir, folderName) {
    const indexPath = path.join(effectDir, 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf8');
    const sourceFile = ts.createSourceFile(indexPath, source, ts.ScriptTarget.Latest, true);
    const objLiteral = findDefaultExportObject(sourceFile);
    if (!objLiteral) {
        throw new Error(`effects/${folderName}/index.ts: no "export default { ... }" (or exported const) found`);
    }
    const meta = evalLiteral(objLiteral);
    for (const field of ['id', 'displayName', 'settingsSchema']) {
        if (meta[field] === undefined) {
            throw new Error(`effects/${folderName}/index.ts: default export is missing literal field "${field}"`);
        }
    }
    return { id: meta.id, displayName: meta.displayName, settingsSchema: meta.settingsSchema };
}

// Writes only if the content actually changed. Without this, every build touches
// registry.generated.ts unconditionally — and since it's a real `import`ed module, Rollup's
// watch mode watches it as part of the bundle's own dependency graph like any other source file.
// An unconditional rewrite on every build re-triggers the watcher, which triggers another build,
// which rewrites the file again — an infinite rebuild loop that (via `onEnd` in
// rollup.config.mjs) restarts the Stream Deck plugin every few seconds forever.
function writeIfChanged(file, content) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
    fs.writeFileSync(file, content);
}

export function generateEffectsRegistry() {
    const folders = fs.existsSync(effectsDir)
        ? fs.readdirSync(effectsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .filter((d) => fs.existsSync(path.join(effectsDir, d.name, 'index.ts')))
            .map((d) => d.name)
            .sort()
        : [];

    const metas = folders.map((folder) => readEffectMeta(path.join(effectsDir, folder), folder));

    const registryLines = [
        '// AUTO-GENERATED by tools/generate-effects-registry.mjs — do not edit by hand, do not commit.',
        "import type { EffectDefinition } from './types';",
        ...folders.map((folder, i) => `import effect_${i} from './${folder}/index';`),
        '',
        'export const effectRegistry = new Map<string, EffectDefinition<any>>([',
        ...folders.map((_, i) => `    [effect_${i}.id, effect_${i}],`),
        ']);',
        '',
    ];
    writeIfChanged(registryOutFile, registryLines.join('\n'));

    fs.mkdirSync(path.dirname(manifestOutFile), { recursive: true });
    writeIfChanged(manifestOutFile, JSON.stringify({ effects: metas }, null, 2));

    return metas;
}

// Allow standalone invocation: `node tools/generate-effects-registry.mjs`.
if (process.argv[1] === url.fileURLToPath(import.meta.url)) {
    const metas = generateEffectsRegistry();
    console.log(`Generated effects registry: ${metas.map((m) => m.id).join(', ') || '(none)'}`);
}
