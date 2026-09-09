import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseSync, printSync } from "../outputs/cardvault-bunny-plugin/node_modules/@swc/core/index.js";
import assert from "node:assert/strict";

const source = readFileSync("work/bunny-current.min.js", "utf8");
const english = JSON.parse(readFileSync("work/bunny-source/Bunny-main/src/core/i18n/default.json", "utf8"));
const chinese = JSON.parse(readFileSync("outputs/cardvault-bunny-plugin/src/bunny-zh-CN.json", "utf8"));
const ui = JSON.parse(readFileSync("outputs/cardvault-bunny-plugin/src/bunny-ui-zh-CN.json", "utf8"));
const uiChanges = {};
assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort());
const ast = parseSync(source);
const newObject = parseSync("(" + JSON.stringify(chinese) + ")").body[0].expression.expression;
let changes = 0;
function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "KeyValueProperty" && ["label", "subLabel", "title", "content", "text"].includes(node.key.value) &&
        node.value?.type === "StringLiteral" && Object.hasOwn(ui, node.value.value)) {
        const english = node.value.value;
        node.value.value = ui[english];
        node.value.raw = undefined;
        uiChanges[english] = (uiChanges[english] || 0) + 1;
    }
    if (node.type === "ObjectExpression" && node.properties.some(p => p.key?.value === "ABOUT" && p.value?.value === "About")) {
        const original = Object.fromEntries(node.properties.map(p => [p.key.value, p.value.value]));
        assert.deepEqual(original, english);
        node.properties = newObject.properties;
        changes++;
        return;
    }
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
    }
}
visit(ast);
assert.equal(changes, 1);
assert.deepEqual(Object.keys(uiChanges).sort(), Object.keys(ui).sort());
const code = printSync(ast, {minify: true}).code + '\nglobalThis.__CARDVAULT_BUNNY_REPAIR__="zh-CN-1";\n';
const output = "outputs/bunny-277-repair/github/bunny-runtime";
mkdirSync(output, {recursive: true});
writeFileSync(output + "/bunny.js", code);
writeFileSync(output + "/verification.json", JSON.stringify({
    upstream_url: "https://raw.githubusercontent.com/bunny-mod/builds/main/bunny.min.js",
    upstream_sha256: createHash("sha256").update(source).digest("hex"),
    output_sha256: createHash("sha256").update(code).digest("hex"),
    change: "Replace Bunny default UI dictionary and explicit UI text properties with Simplified Chinese; keep loader and plugin APIs unchanged.",
    translated_keys: Object.keys(chinese).length, ui_literal_changes: uiChanges, device_tested: false,
}, null, 2));
console.log("Bunny offline dictionary built: " + Object.keys(chinese).length + " keys");
