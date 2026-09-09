import { React, ReactNative as RN, clipboard } from "@vendetta/metro/common";
import { findByProps } from "@vendetta/metro";
import { before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { Forms } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

let active = false;
let bypass = false;
let unpatch: (() => void) | undefined;
let visible: { sheet: any; token: object } | undefined;
const timers = new Set<ReturnType<typeof setTimeout>>();

function icon(names: string[]) {
    for (const name of names) {
        try { const id = getAssetIDByName(name); if (id != null) return id; } catch {}
    }
}

function SelectionPanel({ text, sheet, originalArgs, token, Container }: any) {
    const { height } = RN.useWindowDimensions();
    const dark = RN.useColorScheme() !== "light";
    const color = dark ? "#f2f3f5" : "#202225";
    const close = () => { if (visible?.token === token) visible = undefined; sheet.hideActionSheet(); };
    React.useEffect(() => () => { if (visible?.token === token) visible = undefined; }, []);
    const openOriginal = () => {
        close();
        const timer = setTimeout(() => {
            timers.delete(timer);
            if (!active) return;
            bypass = true;
            try { sheet.openLazy(...originalArgs); } finally { bypass = false; }
        }, 250);
        timers.add(timer);
    };
    const button = (label: string, names: string[], fallback: string, onPress: () => void) => {
        const source = icon(names);
        return <RN.Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
            style={{ width: 44, height: 44, justifyContent: "center", alignItems: "center" }}>
            {source != null ? <RN.Image source={source} style={{ width: 22, height: 22, tintColor: color }} />
                : <RN.Text style={{ fontSize: 14, color }}>{fallback}</RN.Text>}
        </RN.Pressable>;
    };
    const header = <RN.View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8 }}>
        <RN.Text style={{ flex: 1, color, fontSize: 18 }}>选择文字</RN.Text>
        {button("复制全文", ["CopyIcon", "ic_copy_message"], "复制", () => {
            try { clipboard.setString(text); showToast("已复制全文"); } catch { showToast("复制失败"); }
        })}
        {button("原消息菜单", ["MoreHorizontalIcon", "ic_more_24px"], "...", openOriginal)}
        {button("关闭", ["XSmallIcon", "CloseIcon", "ic_close_24px"], "X", close)}
    </RN.View>;
    return <Container scrollable={false}>
        {header}
        <RN.ScrollView style={{ height: Math.max(160, height * 0.62) }} contentContainerStyle={{ padding: 18, paddingBottom: 32 }}>
            <RN.Text selectable selectionColor="#5865f2" style={{ fontSize: 17, lineHeight: 26, color }}>{text}</RN.Text>
        </RN.ScrollView>
    </Container>;
}

export function onLoad() {
    if (active) return;
    const sheet = findByProps("openLazy", "hideActionSheet");
    if (!sheet?.openLazy) throw new Error("未找到消息菜单接口");
    unpatch = before("openLazy", sheet, args => {
        if (!active || bypass || storage.direct === false) return;
        const [, key, props] = args;
        const text = props?.message?.content;
        if (!["MessageLongPressActionSheet", "MessageActionSheet"].includes(key) || typeof text !== "string" || !text.trim()) return;
        const Container = findByProps("ActionSheet")?.ActionSheet;
        if (!Container) return;
        const token = {};
        const originalArgs = args.slice();
        visible = { sheet, token };
        args.splice(0, args.length, Promise.resolve({ default: SelectionPanel }), "GogutopTextSelection", { text, sheet, originalArgs, token, Container });
    });
    active = true;
}

export function onUnload() {
    active = false;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    unpatch?.(); unpatch = undefined;
    if (visible) { const sheet = visible.sheet; visible = undefined; sheet.hideActionSheet(); }
}

export function settings() {
    useProxy(storage);
    const { FormSection, FormSwitchRow } = Forms;
    return <RN.ScrollView><FormSection title="消息文字选择">
        <FormSwitchRow label="长按直接选择文字" value={storage.direct !== false} onValueChange={value => { storage.direct = value; }} />
    </FormSection></RN.ScrollView>;
}
