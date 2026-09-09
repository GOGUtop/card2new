import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { rollup } from "rollup";
import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import esbuild from "rollup-plugin-esbuild";
import { parseSync, printSync, transform } from "@swc/core";

const external = (id) => id === "react" || id === "react-native" || id.startsWith("@vendetta/");
const bundle = await rollup({
    input: "src/index.tsx",
    external,
    onwarn(warning, warn) {
        // Bunny evaluates the anonymous IIFE directly to obtain its exports.
        if (warning.code !== "MISSING_NAME_OPTION_FOR_IIFE_EXPORT") warn(warning);
    },
    plugins: [nodeResolve(), commonjs(), esbuild({ minify: true, target: "es2020", jsxFactory: "React.createElement" })],
});

await mkdir("dist", { recursive: true });
await bundle.write({
    file: "dist/index.js",
    format: "iife",
    compact: true,
    exports: "named",
    plugins: [{
        name: "hermes-compatible-syntax",
        async renderChunk(code) {
            // Hermes in older Discord builds cannot compile ES class statements.
            // Transform the final bundle so helpers and dependencies are covered too.
            const result = await transform(code, {
                jsc: { parser: { syntax: "ecmascript" }, target: "es5", externalHelpers: false },
                minify: true,
                sourceMaps: false,
            });
            // Keep inserted helpers inside a single expression for Bunny's `return <plugin>` loader.
            const transformed = parseSync(result.code, { syntax: "ecmascript" });
            const last = transformed.body.pop();
            if (last?.type !== "ExpressionStatement") throw new Error("Expected a plugin IIFE expression");
            const wrapper = parseSync("(function(){})()", { syntax: "ecmascript" });
            wrapper.body[0].expression.callee.expression.body.stmts = [
                ...transformed.body,
                { type: "ReturnStatement", span: last.span, argument: last.expression },
            ];
            return printSync(wrapper, { minify: true });
        },
    }],
    globals(id) {
        if (id.startsWith("@vendetta/")) return id.substring(1).replaceAll("/", ".");
        if (id === "react") return "React";
        if (id === "react-native") return "ReactNative";
        return id;
    },
});
await bundle.close();

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
manifest.main = "index.js";
manifest.hash = createHash("sha256").update(await readFile("dist/index.js")).digest("hex");
await writeFile("dist/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
await cp("README.md", "dist/README.md");
await mkdir("docs", { recursive: true });
for (const file of ["index.js", "manifest.json", "README.md"]) await cp(`dist/${file}`, `docs/${file}`);
await writeFile("docs/.nojekyll", "");
console.log(`Built CardVault Upload ${manifest.version} for Bunny and GitHub Pages.`);
