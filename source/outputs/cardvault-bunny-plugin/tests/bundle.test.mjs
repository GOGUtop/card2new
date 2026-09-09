import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { parseSync } from "@swc/core";

const bundle = await readFile(new URL("../docs/index.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../docs/manifest.json", import.meta.url), "utf8"));
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
    const intervals = new Map();
    const mutations = [];
    const state = new Proxy({}, {
        set(target, key, value) { mutations.push(key); target[key] = value; return true; },
        deleteProperty(target, key) { mutations.push(key); return delete target[key]; },
    });
    const requests = [];
    const listeners = new Set();
    const FormRow = () => {};
    const make = (type, props, ...children) => Object.freeze({
        type, key: props?.key, props: Object.freeze({ ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) }),
    });
    const React = {
        useState: value => [value, () => {}],
        createElement: make,
        isValidElement: item => Boolean(item?.type && item?.props),
        cloneElement: (item, props, ...children) => make(item.type, { ...item.props, key: item.key, ...props }, ...children),
    };
    const actionSheet = { openLazy() {}, hideActionSheet() {} };
    const mediaActions = { useMediaShareActions: props => props.callbacks };
    const menus = { ContextMenu: props => props };
    const originalMediaHook = mediaActions.useMediaShareActions;
    const originalMenu = menus.ContextMenu;
    const originalOpen = actionSheet.openLazy;
    const patch = (after) => (key, target, callback) => {
        const original = target[key];
        target[key] = function (...args) {
            if (!after) callback(args);
            const result = original.apply(this, args);
            return after ? callback(args, result) ?? result : result;
        };
        return () => { target[key] = original; };
    };
    const vendetta = {
        metro: { common: { React, ReactNative: {
            AppState: { currentState: "active", addEventListener: (_key, cb) => {
                listeners.add(cb);
                return { remove: () => listeners.delete(cb) };
            } },
        } }, findByProps: (...props) => {
            if (props.includes("useMediaShareActions")) return mediaActions;
            if (props.includes("ContextMenu")) return menus;
            return actionSheet;
        } },
        patcher: { before: patch(false), after: patch(true) },
        ui: { components: { Forms: { FormRow } }, toasts: { showToast() {} }, assets: { getAssetIDByName: () => 42 } },
        plugin: { storage: state }, storage: { useProxy() {} },
    };
    const context = {
        vendetta, URL, AbortController, SyntaxError, setTimeout, clearTimeout,
        setInterval: cb => { const id = Symbol(); intervals.set(id, cb); return id; },
        clearInterval: id => intervals.delete(id),
        fetch: async (url, options) => {
            requests.push({ url, options });
            return new Response(JSON.stringify(url.endsWith("/api/login") ? { token: "mock-token", username: "card2" } : { username: "card2" }));
        },
    };
    // Exact evaluation shape used by Bunny's Vendetta plugin loader.
    const plugin = vm.runInNewContext(`(vendetta => { return ${bundle}\n})(vendetta)`, context);
    const tree = () => make("outer", {}, make("inner", {}, [make(FormRow, { label: "Save", onPress() {} })]));
    return { plugin, state, mutations, requests, listeners, intervals, actionSheet, originalOpen, tree,
        mediaActions, menus, originalMediaHook, originalMenu };
}

test("published manifest enables initial installation and hash-based updates", () => {
    assert.equal(manifest.main, "index.js");
    assert.equal(manifest.version, "1.1.3");
    assert.equal(manifest.hash, createHash("sha256").update(bundle).digest("hex"));
    assert.notEqual(undefined, manifest.hash);
});

test("published JavaScript contains no untransformed class or async syntax for Hermes", () => {
    const visit = node => {
        if (!node || typeof node !== "object") return;
        assert.notEqual(node.type, "ClassDeclaration", "Hermes cannot load class declarations");
        assert.notEqual(node.type, "ClassExpression", "Hermes cannot load class expressions");
        assert.notEqual(node.type, "AwaitExpression", "async functions must also be transformed");
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else visit(value);
        }
    };
    visit(parseSync(bundle, { syntax: "ecmascript" }));
});

test("built plugin logs in on startup, checks foreground and timer, releases all on unload", async () => {
    const h = harness();
    assert.equal(typeof h.plugin.settings, "function");
    h.plugin.onLoad();
    await tick();
    assert.equal(h.state.token, "mock-token");
    assert.equal(h.intervals.size, 1);
    assert.equal(h.listeners.size, 1);
    for (const cb of h.intervals.values()) cb();
    for (const cb of h.listeners) cb("active");
    await tick();
    assert.equal(h.requests.filter(r => r.url.endsWith("/api/login")).length, 1);
    assert.equal(h.requests.filter(r => r.url.endsWith("/api/me")).length, 2);
    h.plugin.onUnload();
    assert.equal(h.intervals.size, 0);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.actionSheet.openLazy, h.originalOpen);
    assert.equal(h.mediaActions.useMediaShareActions, h.originalMediaHook);
    assert.equal(h.menus.ContextMenu, h.originalMenu);
});

test("PNG menu patches frozen React trees without hooks, duplication or unload leaks", async () => {
    const h = harness();
    h.plugin.onLoad();
    const original = h.tree();
    const module = { default: () => original };
    const render = module.default;
    const props = { syncer: { index: { value: 0 }, sources: [{ sourceURI: "https://cdn.discordapp.com/attachments/1/2/card.png?ex=123" }] } };
    h.actionSheet.openLazy(Promise.resolve(module), "MediaShareActionSheet");
    await tick();
    const result = module.default(props);
    assert.equal(original.props.children.props.children.length, 1);
    assert.equal(result.props.children.props.children.length, 2);
    assert.equal(result.props.children.props.children[1].props.subLabel, "card.png");
    h.actionSheet.openLazy(Promise.resolve(module), "MediaShareActionSheet");
    await tick();
    assert.equal(module.default(props).props.children.props.children.length, 2);
    h.plugin.onUnload();
    assert.equal(module.default, render);
});

test("message menu keeps JSON but does not show the PNG entry in screenshot 1", async () => {
    const h = harness();
    h.plugin.onLoad();
    const module = { default: h.tree };
    h.actionSheet.openLazy(Promise.resolve(module), "MessageLongPressActionSheet");
    await tick();
    const attachments = ["a.png", "b.json", "c.jpg"].map(filename => ({ filename, url: "https://cdn.discordapp.com/attachments/1/2/" + filename }));
    const result = module.default({ message: { attachments } });
    const rows = result.props.children.props.children;
    assert.equal(rows.length, 2);
    assert.equal(rows[1].props.subLabel, "b.json");
    h.plugin.onUnload();
});

test("viewer overflow menu inserts CardVault after Save and preserves existing actions", async () => {
    const h = harness();
    h.plugin.onLoad();
    await tick();
    let ordinarySaves = 0;
    const callbacks = h.mediaActions.useMediaShareActions({
        source: { sourceURI: "https://cdn.discordapp.com/attachments/1/2/visible.png?hm=signed" },
        callbacks: { save: () => ordinarySaves++, share: () => {}, open: () => {}, jump: () => {} },
    });
    const items = Object.freeze([
        Object.freeze({ label: "Save", action: callbacks.save }),
        Object.freeze({ label: "Share", action: callbacks.share }),
        Object.freeze({ label: "Open in Browser", action: callbacks.open }),
        Object.freeze({ label: "Jump to Message", action: callbacks.jump }),
    ]);
    const result = h.menus.ContextMenu(Object.freeze({ items }));
    assert.deepEqual(Array.from(result.items, item => item.label), ["Save", "保存到 CardVault", "Share", "Open in Browser", "Jump to Message"]);
    assert.equal(items.length, 4);
    assert.equal(result.items[1].iconSource, 42);
    assert.equal(h.requests.length, 1);
    result.items[0].action();
    assert.equal(ordinarySaves, 1);
    assert.equal(h.requests.length, 1);
    result.items[1].action();
    await tick();
    assert.equal(h.requests.filter(r => r.url.includes("/attachments/")).length, 1);
    assert.equal(h.requests.find(r => r.url.includes("/attachments/")).url, "https://cdn.discordapp.com/attachments/1/2/visible.png?hm=signed");
    assert.equal(h.requests.filter(r => r.url.endsWith("/api/cards/import")).length, 1);
    assert.equal(h.menus.ContextMenu(result).items.length, 5);
    h.plugin.onUnload();
});

test("switching images rebinds callbacks without leaking the entry to JPEG or unrelated menus", async () => {
    const h = harness();
    h.plugin.onLoad();
    await tick();
    const save = () => {};
    const items = [{ label: "Save", action: save }];
    for (const name of ["first.png", "second.png"]) {
        h.mediaActions.useMediaShareActions({ source: { uri: "https://cdn.discordapp.com/attachments/1/2/" + name }, callbacks: { save } });
    }
    const result = h.menus.ContextMenu({ items });
    result.items[1].action();
    await tick();
    assert.equal(h.requests.find(r => r.url.includes("/attachments/")).url, "https://cdn.discordapp.com/attachments/1/2/second.png");
    h.mediaActions.useMediaShareActions({ source: { uri: "https://cdn.discordapp.com/attachments/1/2/third.jpg" }, callbacks: { save } });
    assert.equal(h.menus.ContextMenu({ items }).items.length, 1);
    const unrelated = { items: [{ label: "Save", action: () => {} }, { label: "Share", action: () => {} }] };
    assert.equal(h.menus.ContextMenu(unrelated), unrelated);
    h.plugin.onUnload();
});

test("grouped menus and direct item-returning media hooks retain native menu structure", async () => {
    const h = harness();
    h.plugin.onLoad();
    const callbacks = [{ label: "Save", action: () => {} }, { label: "Share", action: () => {} }];
    const items = h.mediaActions.useMediaShareActions({ source: { uri: "https://cdn.discordapp.com/attachments/1/2/card.png" }, callbacks });
    assert.equal(items.length, 3);
    assert.equal(h.menus.ContextMenu({ items }).items.length, 3);
    const grouped = h.menus.ContextMenu({ items: [[callbacks[0]], [callbacks[1]]] });
    assert.equal(grouped.items.length, 2);
    assert.equal(grouped.items[0].length, 2);
    assert.equal(grouped.items[1].length, 1);
    h.plugin.onUnload();
});

test("lazy sheet resolving after unload is not patched", async () => {
    const h = harness();
    h.plugin.onLoad();
    let resolve;
    const delayed = new Promise(done => { resolve = done; });
    h.actionSheet.openLazy(delayed, "MediaShareActionSheet");
    h.plugin.onUnload();
    const render = h.tree;
    const module = { default: render };
    resolve(module);
    await tick();
    assert.equal(module.default, render);
});

test("settings render does not mutate reactive storage and trigger a render loop", async () => {
    const h = harness();
    h.plugin.onLoad();
    await tick();
    h.mutations.length = 0;
    h.plugin.settings();
    h.plugin.settings();
    assert.equal(h.mutations.length, 0);
    h.plugin.onUnload();
});
