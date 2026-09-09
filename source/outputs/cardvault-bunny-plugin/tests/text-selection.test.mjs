import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import vm from "node:vm";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const bundle = await readFile(new URL("../docs/bunny-text-select/index.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../docs/bunny-text-select/manifest.json", import.meta.url), "utf8"));
const cardBundle = await readFile(new URL("../docs/index.js", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
    const calls = [], copied = [], toasts = [], timers = new Map(), patches = new Map();
    const storage = {};
    let hidden = 0;
    const sheet = { openLazy: (...args) => calls.push(args), hideActionSheet: () => hidden++ };
    const originalOpen = sheet.openLazy;
    // Model composable before/after hooks, including removal in either order.
    function patch(after) {
        return (key, target, callback) => {
            let entry = patches.get(target)?.get(key);
            if (!entry) {
                entry = { original: target[key], before: [], after: [] };
                if (!patches.has(target)) patches.set(target, new Map());
                patches.get(target).set(key, entry);
                target[key] = function (...args) {
                    entry.before.forEach(fn => fn(args));
                    let result = entry.original.apply(this, args);
                    entry.after.forEach(fn => { result = fn(args, result) ?? result; });
                    return result;
                };
            }
            const list = after ? entry.after : entry.before;
            list.push(callback);
            return () => {
                const index = list.indexOf(callback);
                if (index !== -1) list.splice(index, 1);
                if (!entry.before.length && !entry.after.length) {
                    target[key] = entry.original;
                    patches.get(target).delete(key);
                }
            };
        };
    }
    const RN = Object.fromEntries(["View", "Text", "Pressable", "Image", "ScrollView"].map(name => [name, name]));
    Object.assign(RN, {
        useWindowDimensions: () => ({ width: 390, height: 844 }), useColorScheme: () => "dark",
        AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
    });
    const forms = { FormRow: "FormRow", FormSection: "FormSection", FormSwitchRow: "FormSwitchRow" };
    const modules = [sheet, { ActionSheet: props => React.createElement("ActionSheet", props) },
        { useMediaShareActions: props => props.callbacks }, { ContextMenu: props => props }];
    const vendetta = {
        metro: { common: { React, ReactNative: RN, clipboard: { setString: text => copied.push(text) } },
            findByProps: (...props) => modules.find(m => props.every(p => p in m)) },
        patcher: { before: patch(false), after: patch(true) }, plugin: { storage }, storage: { useProxy() {} },
        ui: { components: { Forms: forms }, assets: { getAssetIDByName: () => 42 },
            toasts: { showToast: text => toasts.push(text) } },
    };
    const context = { vendetta, URL, AbortController, SyntaxError,
        setTimeout: cb => { const id = Symbol(); timers.set(id, cb); return id; }, clearTimeout: id => timers.delete(id),
        setInterval: () => 1, clearInterval() {},
        fetch: async () => new Response(JSON.stringify({ token: "test", username: "card2" })),
    };
    const evaluate = code => vm.runInNewContext(`(vendetta => {return ${code}\n})(vendetta)`, context);
    const plugin = evaluate(bundle);
    const runTimers = () => { for (const [id, cb] of [...timers]) { timers.delete(id); cb(); } };
    async function open(text, extra = {}) {
        const original = [Promise.resolve({ default: () => React.createElement("OriginalMenu") }),
            "MessageLongPressActionSheet", { message: { content: text, ...extra } }];
        sheet.openLazy(...original);
        const args = calls.at(-1), module = await args[0];
        let renderer;
        act(() => { renderer = TestRenderer.create(React.createElement(module.default, args[2])); });
        return { original, args, renderer };
    }
    return { plugin, sheet, originalOpen, calls, copied, toasts, timers, storage, open, evaluate, runTimers,
        get hidden() { return hidden; } };
}

test("text plugin manifest hash and Bunny loader exports are valid", () => {
    assert.equal(manifest.main, "index.js");
    assert.equal(manifest.hash, createHash("sha256").update(bundle).digest("hex"));
    const h = harness();
    for (const key of ["onLoad", "onUnload", "settings"]) assert.equal(typeof h.plugin[key], "function");
});

test("long press renders complete selectable text and all toolbar controls through real React", async () => {
    const h = harness(); h.plugin.onLoad(); h.plugin.onLoad();
    const text = "第一行 **原始格式**\n第二行 https://example.com\n" + "长消息".repeat(1000);
    const { args, renderer } = await h.open(text);
    assert.equal(args[1], "GogutopTextSelection");
    const selectable = renderer.root.findAllByType("Text").filter(node => node.props.selectable);
    assert.equal(selectable.length, 1);
    assert.equal(selectable[0].props.children, text);
    const buttons = renderer.root.findAllByType("Pressable");
    assert.deepEqual(buttons.map(b => b.props.accessibilityLabel), ["复制全文", "原消息菜单", "关闭"]);
    act(() => buttons[0].props.onPress());
    assert.deepEqual(h.copied, [text]);
    act(() => buttons[2].props.onPress());
    assert.equal(h.hidden, 1);
    act(() => renderer.unmount()); h.plugin.onUnload();
    assert.equal(h.sheet.openLazy, h.originalOpen);
});

test("original menu bypass opens once and later long presses still select", async () => {
    const h = harness(); h.plugin.onLoad();
    const { original, renderer } = await h.open("文字");
    act(() => renderer.root.findAllByType("Pressable")[1].props.onPress());
    act(() => renderer.unmount()); h.runTimers();
    assert.deepEqual(h.calls.at(-1), original);
    const next = await h.open("下一条");
    assert.equal(next.args[1], "GogutopTextSelection");
    act(() => next.renderer.unmount()); h.plugin.onUnload();
});

test("empty messages, attachment-only messages, unrelated sheets and disabled mode are untouched", () => {
    const h = harness(); h.plugin.onLoad();
    for (const [key, message] of [["MessageLongPressActionSheet", { attachments: [{ filename: "x.json" }] }],
        ["MessageActionSheet", { content: "  \n" }], ["MediaShareActionSheet", { content: "image" }]]) {
        const args = [Promise.resolve({}), key, { message }];
        h.sheet.openLazy(...args); assert.deepEqual(h.calls.at(-1), args);
    }
    let settings;
    act(() => { settings = TestRenderer.create(React.createElement(h.plugin.settings)); });
    act(() => settings.root.findByType("FormSwitchRow").props.onValueChange(false));
    assert.equal(h.storage.direct, false);
    const args = [Promise.resolve({}), "MessageActionSheet", { message: { content: "text" } }];
    h.sheet.openLazy(...args); assert.deepEqual(h.calls.at(-1), args);
    act(() => settings.unmount()); h.plugin.onUnload();
});

test("unload closes own panel and cancels any pending reopen", async () => {
    const h = harness(); h.plugin.onLoad();
    const first = await h.open("first");
    act(() => h.plugin.onUnload());
    assert.equal(h.hidden, 1); act(() => first.renderer.unmount());
    h.plugin.onLoad();
    const next = await h.open("next");
    act(() => next.renderer.root.findAllByType("Pressable")[1].props.onPress());
    assert.equal(h.timers.size, 1); h.plugin.onUnload();
    assert.equal(h.timers.size, 0);
    const count = h.calls.length; h.runTimers(); assert.equal(h.calls.length, count);
    act(() => next.renderer.unmount());
});

for (const cardFirst of [true, false]) {
    test(`CardVault JSON original-menu action survives text selection (CardVault first=${cardFirst})`, async () => {
        const h = harness(), card = h.evaluate(cardBundle);
        if (cardFirst) { card.onLoad(); h.plugin.onLoad(); } else { h.plugin.onLoad(); card.onLoad(); }
        const originalModule = { default: () => React.createElement("View", {}, [React.createElement("FormRow", { key: "reply", label: "Reply" })]) };
        h.sheet.openLazy(Promise.resolve(originalModule), "MessageLongPressActionSheet", {
            message: { content: "hello", attachments: [{ filename: "card.json", url: "https://cdn.discordapp.com/attachments/1/2/card.json" }] },
        });
        const args = h.calls.at(-1), panel = await args[0];
        let renderer;
        act(() => { renderer = TestRenderer.create(React.createElement(panel.default, args[2])); });
        act(() => renderer.root.findAllByType("Pressable")[1].props.onPress());
        act(() => renderer.unmount()); h.runTimers(); await tick();
        const originalArgs = h.calls.at(-1);
        assert.equal(originalArgs[1], "MessageLongPressActionSheet");
        act(() => { renderer = TestRenderer.create(React.createElement(originalModule.default, originalArgs[2])); });
        const rows = renderer.root.findAllByType("FormRow");
        assert.equal(rows.length, 2);
        assert.equal(rows[1].props.subLabel, "card.json");
        act(() => renderer.unmount()); h.plugin.onUnload(); card.onUnload();
        assert.equal(h.sheet.openLazy, h.originalOpen);
    });
}
