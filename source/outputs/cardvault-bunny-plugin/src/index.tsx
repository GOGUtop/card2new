import { React, ReactNative as RN } from "@vendetta/metro/common";
import { findByProps } from "@vendetta/metro";
import { before, after } from "@vendetta/patcher";
import { Forms } from "@vendetta/ui/components";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { showToast } from "@vendetta/ui/toasts";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { ACCOUNT, DEFAULT_API_URL, CardVaultClient, filenameFromUrl, normalizeBase, supported } from "./client";
import type { MediaSource } from "./client";
import { createMediaMenuAdapter } from "./media-menu";

const { FormInput, FormRow, FormSection } = Forms;
const ActionSheet = findByProps("openLazy", "hideActionSheet");
let client: CardVaultClient | undefined;
let running = false;
let generation = 0;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let foreground: { remove(): void } | undefined;
const cleanups = new Set<() => void>();
let patchedModules = new WeakSet<object>();
const uploads = new Set<string>();

function installMediaMenu() {
    const mediaActions = findByProps("useMediaShareActions");
    const menus = findByProps("ContextMenu");
    if (!mediaActions?.useMediaShareActions) return;
    let icon: number | undefined;
    try { icon = getAssetIDByName("ic_upload"); } catch {}
    const adapter = createMediaMenuAdapter(source => { void save(source); }, icon);
    cleanups.add(() => adapter.clear());
    cleanups.add(after("useMediaShareActions", mediaActions, ([props], result) => {
        if (!running) return result;
        try { return adapter.capture(props, result); }
        catch { return result; }
    }));
    const patchMenu = (target: any, method: string) => {
        cleanups.add(before(method, target, args => {
            try { if (running) args[0] = adapter.decorate(args[0]); }
            catch { /* Preserve Discord's menu if its internal shape changes. */ }
        }));
    };
    if (typeof menus?.ContextMenu === "function") patchMenu(menus, "ContextMenu");
    else if (typeof menus?.ContextMenu?.render === "function") patchMenu(menus.ContextMenu, "render");
    else if (typeof menus?.ContextMenu?.type === "function") patchMenu(menus.ContextMenu, "type");
}

function config() {
    storage.apiUrl ??= DEFAULT_API_URL;
    storage.status ??= "等待连接";
    return storage;
}

function getClient() {
    if (!running) throw new Error("插件已停用");
    const base = normalizeBase(config().apiUrl);
    if (!client || client.base !== base) {
        client?.dispose();
        client = new CardVaultClient(base, storage);
    }
    return client;
}

async function reconnect(manual = false) {
    const currentGeneration = generation;
    let current: CardVaultClient | undefined;
    try {
        current = getClient();
        await current.ensureSession();
        if (!running || currentGeneration !== generation || current !== client) return;
        storage.status = "已登录：" + ACCOUNT;
        if (manual) showToast("CardVault 已连接");
    } catch (error) {
        if (!running || currentGeneration !== generation || (current && current !== client)) return;
        storage.status = "连接失败，将自动重试";
        if (manual) showToast("CardVault: " + (error?.message || String(error)));
    }
}

function sourceFromMediaSheet(props: any): MediaSource[] {
    let source = props?.syncer?.sources?.[props?.syncer?.index?.value];
    if (Array.isArray(source)) source = source[0];
    const url = source?.sourceURI || source?.uri || source?.url;
    if (!url) return [];
    return [{ url, filename: source.filename || source.name || filenameFromUrl(url), size: source.size }].filter(supported);
}

function sourcesFromMessageSheet(props: any): MediaSource[] {
    const attachments = props?.attachment ? [props.attachment]
        : Array.isArray(props?.message?.attachments) ? props.message.attachments : [];
    return attachments.map((attachment: any) => ({
        url: attachment.url,
        filename: attachment.filename || filenameFromUrl(attachment.url),
        size: attachment.size,
    })).filter(supported).filter((source: MediaSource) => /\.json$/i.test(source.filename));
}

async function save(source: MediaSource) {
    if (uploads.has(source.url)) return;
    uploads.add(source.url);
    const currentGeneration = generation;
    try {
        const current = getClient();
        showToast("正在上传：" + source.filename);
        const body = await current.upload(source);
        if (!running || currentGeneration !== generation || current !== client) return;
        storage.status = "已登录：" + ACCOUNT;
        showToast(body?.duplicate ? "卡库中已存在此文件" : "已保存到 CardVault");
    } catch (error) {
        if (running && currentGeneration === generation) showToast("CardVault: " + (error?.message || String(error)));
    } finally { uploads.delete(source.url); }
}

// React props may be frozen; clone the row container without injecting hooks.
function appendRows(node: any, rows: any[], depth = 0): any {
    if (!React.isValidElement(node) || depth > 12) return node;
    const children = node.props?.children;
    if (Array.isArray(children) && children.some(child => child?.type === FormRow ||
        (child?.props?.onPress && (child.props.label || child.props.title)))) {
        if (children.some(child => String(child?.key || "").startsWith("cardvault-upload-"))) return node;
        return React.cloneElement(node, {}, [...children, ...rows]);
    }
    if (Array.isArray(children)) {
        for (let index = 0; index < children.length; index++) {
            const updated = appendRows(children[index], rows, depth + 1);
            if (updated !== children[index]) {
                const next = children.slice();
                next[index] = updated;
                return React.cloneElement(node, {}, next);
            }
        }
    } else {
        const updated = appendRows(children, rows, depth + 1);
        if (updated !== children) return React.cloneElement(node, {}, updated);
    }
    return node;
}

function patchActionSheet(component: Promise<any>, extract: (props: any) => MediaSource[]) {
    const currentGeneration = generation;
    Promise.resolve(component).then(instance => {
        if (!running || currentGeneration !== generation || !instance || patchedModules.has(instance)) return;
        if (typeof instance.default !== "function") return;
        const cleanup = after("default", instance, ([props], result) => {
            if (!running) return result;
            try {
                const sources = extract(props);
                if (!sources.length) return result;
                const rows = sources.map((source, index) => (
                    <FormRow key={"cardvault-upload-" + index} label="保存到 CardVault"
                        subLabel={source.filename} onPress={() => { void save(source); }} />
                ));
                return appendRows(result, rows);
            } catch { return result; }
        });
        patchedModules.add(instance);
        cleanups.add(cleanup);
    }).catch(() => {});
}

export const onLoad = () => {
    if (running) return;
    running = true;
    generation++;
    // Migrate once on load, not during reactive settings renders.
    if ("password" in storage) delete storage.password;
    if ("username" in storage) delete storage.username;
    config();
    try { installMediaMenu(); }
    catch { showToast("图片菜单适配失败，请在插件设置使用链接上传"); }
    if (ActionSheet?.openLazy) {
        cleanups.add(before("openLazy", ActionSheet, ([component, key]) => {
            if (key === "MediaShareActionSheet") patchActionSheet(component, sourceFromMediaSheet);
            if (["MessageLongPressActionSheet", "MessageActionSheet", "AttachmentActionSheet"].includes(key)) {
                patchActionSheet(component, sourcesFromMessageSheet);
            }
        }));
    } else { showToast("当前版本未找到附件菜单，请在插件设置使用链接上传"); }
    void reconnect();
    heartbeat = setInterval(() => {
        if (!RN.AppState?.currentState || RN.AppState.currentState === "active") void reconnect();
    }, 5 * 60 * 1000);
    foreground = RN.AppState?.addEventListener("change", state => { if (state === "active") void reconnect(); });
};

export const onUnload = () => {
    running = false;
    generation++;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    foreground?.remove();
    foreground = undefined;
    client?.dispose();
    client = undefined;
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
    patchedModules = new WeakSet();
    uploads.clear();
};

export const settings = () => {
    useProxy(storage);
    const cfg = config();
    const [address, setAddress] = React.useState(cfg.apiUrl);
    const [link, setLink] = React.useState("");
    const inputText = (value: string | { text: string }) => typeof value === "string" ? value : value.text;
    return (
        <RN.ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 36 }}>
            <FormSection title="CardVault">
                <FormRow label={"账号：" + ACCOUNT} subLabel={cfg.status} />
                <FormInput placeholder="CardVault API 地址" value={address} autoCapitalize="none" autoCorrect={false}
                    onChange={value => setAddress(inputText(value))} showBorder={true} />
                <FormRow label="保存地址并连接" onPress={() => {
                    try { cfg.apiUrl = normalizeBase(address); void reconnect(true); }
                    catch (error) { showToast(error?.message || String(error)); }
                }} />
                <FormRow label="检查连接" onPress={() => { void reconnect(true); }} />
            </FormSection>
            <FormSection title="附件链接上传">
                <FormInput placeholder="PNG / JSON 附件链接" value={link} autoCapitalize="none" autoCorrect={false}
                    onChange={value => setLink(inputText(value))} showBorder={true} />
                <FormRow label="保存到 CardVault" onPress={() => {
                    const url = link.trim();
                    const source = { url, filename: filenameFromUrl(url) };
                    if (!supported(source)) { showToast("请输入 HTTPS PNG 或 JSON 附件链接"); return; }
                    void save(source);
                }} />
            </FormSection>
        </RN.ScrollView>
    );
};
