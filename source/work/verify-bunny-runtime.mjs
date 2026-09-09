import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { parseSync } from "../outputs/cardvault-bunny-plugin/node_modules/@swc/core/index.js";
import { parse as parseICU } from "../outputs/cardvault-bunny-plugin/node_modules/@formatjs/icu-messageformat-parser/index.js";

const read = path => readFileSync(path, "utf8");
const original = parseSync(read("work/bunny-current.min.js"));
const repairedText = read("outputs/bunny-277-repair/github/bunny-runtime/bunny.js");
const repaired = parseSync(repairedText);
const english = JSON.parse(read("work/bunny-source/Bunny-main/src/core/i18n/default.json"));
const chinese = JSON.parse(read("outputs/cardvault-bunny-plugin/src/bunny-zh-CN.json"));
const ui = JSON.parse(read("outputs/cardvault-bunny-plugin/src/bunny-ui-zh-CN.json"));
let dictionaryChanges = 0, literalChanges = 0;
function canonical(node, isOriginal) {
    if (Array.isArray(node)) return node.map(value => canonical(value, isOriginal));
    if (!node || typeof node !== "object") return node;
    if (Object.keys(node).length === 2 && typeof node.start === "number" && typeof node.end === "number") return { sourcePosition: true };
    if (node.type === "ObjectExpression" && node.properties.some(p => p.key?.value === "ABOUT")) {
        const entries = Object.fromEntries(node.properties.map(p => [p.key.value, p.value.value]));
        if (isOriginal) {
            assert.deepEqual(entries, english); dictionaryChanges++;
        } else assert.deepEqual(entries, chinese);
        return { translatedDictionary: true };
    }
    if (isOriginal && node.type === "KeyValueProperty" && ["label", "subLabel", "title", "content", "text"].includes(node.key.value) &&
        node.value?.type === "StringLiteral" && Object.hasOwn(ui, node.value.value)) {
        node.value.value = ui[node.value.value]; literalChanges++;
    }
    return Object.fromEntries(Object.entries(node).filter(([key]) => !["span", "ctxt", "raw"].includes(key))
        .map(([key, value]) => [key, canonical(value, isOriginal)]));
}
const marker = repaired.body.pop();
assert.equal(marker.expression.type, "AssignmentExpression");
assert.equal(marker.expression.left.object.value, "globalThis");
assert.equal(marker.expression.left.property.value, "__CARDVAULT_BUNNY_REPAIR__");
assert.equal(marker.expression.right.value, "zh-CN-1");
assert.deepEqual(canonical(original, true), canonical(repaired, false));
assert.equal(dictionaryChanges, 1);
function params(nodes, result = new Set()) {
    for (const node of nodes) {
        if (node.type !== 0 && node.type !== 7) result.add(node.value);
        if (node.options) for (const option of Object.values(node.options)) params(option.value, result);
        if (node.children) params(node.children, result);
    }
    return [...result].sort();
}
for (const key of Object.keys(english)) {
    assert.deepEqual(params(parseICU(chinese[key])), params(parseICU(english[key])), key + " parameters");
}
const report = {
    complete_ast_comparison_passed: true,
    changes: "Only the default language dictionary, approved UI text properties, and a version marker differ.",
    icu_messages_validated: Object.keys(chinese).length,
    ui_literal_occurrences: literalChanges,
    output_sha256: createHash("sha256").update(repairedText).digest("hex"),
    device_tested: false,
};
writeFileSync("outputs/bunny-277-repair/github/bunny-runtime/tests.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
