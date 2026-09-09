import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { rollup } from "rollup";
import esbuild from "rollup-plugin-esbuild";
import { parseSync, printSync, transform } from "@swc/core";

for (const [entry, manifestPath, folder] of [["src/text-selection.tsx", "manifest.text-select.json", "bunny-text-select"]]) {
    const bundle = await rollup({ input: entry, external: id => id.startsWith("@vendetta/"),
        onwarn(warning, warn) { if (warning.code !== "MISSING_NAME_OPTION_FOR_IIFE_EXPORT") warn(warning); },
        plugins: [esbuild({ target: "es2020", jsxFactory: "React.createElement" })] });
    const { output } = await bundle.generate({ format: "iife", exports: "named", globals: id => id.substring(1).replaceAll("/", ".") });
    await bundle.close();
    const result = await transform(output[0].code, { jsc: { parser: { syntax: "ecmascript" }, target: "es5" }, minify: true });
    const ast = parseSync(result.code), last = ast.body.pop();
    if (last?.type !== "ExpressionStatement") throw Error("Expected IIFE expression");
    const wrapper = parseSync("(function(){})()");
    wrapper.body[0].expression.callee.expression.body.stmts = [...ast.body, { type: "ReturnStatement", span: last.span, argument: last.expression }];
    const code = printSync(wrapper, { minify: true }).code;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.hash = createHash("sha256").update(code).digest("hex");
    for (const root of ["docs", "dist"]) {
        await mkdir(`${root}/${folder}`, { recursive: true });
        await writeFile(`${root}/${folder}/index.js`, code);
        await writeFile(`${root}/${folder}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
    }
    console.log(`Built ${folder} ${manifest.version}`);
}
