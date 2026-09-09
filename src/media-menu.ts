import { filenameFromUrl, supported } from "./client";
import type { MediaSource } from "./client";

type Item = { label?: string; action?: () => unknown; onPress?: () => unknown; [key: string]: any };
const ENTRY_ID = "cardvault-media-upload";

export function mediaSource(props: any): MediaSource | undefined {
    let raw = props?.source;
    if (!raw && props?.syncer) raw = props.syncer.sources?.[props.syncer.index?.value];
    if (Array.isArray(raw)) raw = raw[0];
    const url = raw?.sourceURI || raw?.uri || raw?.url;
    if (typeof url !== "string") return;
    const source = { url, filename: raw.filename || raw.name || filenameFromUrl(url), size: raw.size };
    return supported(source) ? source : undefined;
}

// Bind media callbacks to their source instead of keeping a global "last image".
export function createMediaMenuAdapter(save: (source: MediaSource) => void, iconSource?: number) {
    let sources = new WeakMap<Function, MediaSource | undefined>();

    function remember(value: any, source: MediaSource | undefined, depth = 0, seen = new Set<object>()) {
        if (typeof value === "function") { sources.set(value, source); return; }
        if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return;
        seen.add(value);
        for (const entry of Object.values(value)) remember(entry, source, depth + 1, seen);
    }

    function decorate(props: any) {
        if (!Array.isArray(props?.items)) return props;
        const flat: Item[] = props.items.flat().filter(item => item && typeof item === "object");
        if (flat.some(item => item.id === ENTRY_ID)) return props;
        const matches = flat.map(item => sources.get(item.action || item.onPress!)).filter(Boolean) as MediaSource[];
        if (!matches.length || matches.some(source => source.url !== matches[0].url)) return props;
        const source = matches[0];
        const item: Item = {
            id: ENTRY_ID,
            label: "保存到 CardVault",
            action: () => save(source),
            ...(iconSource === undefined ? {} : { iconSource }),
        };
        const saveLabel = /^(save|save image|save to photos|保存|保存图片|保存到相册)$/i;
        const anchor = flat.find(entry => saveLabel.test(entry.label || "")) ||
            flat.find(entry => sources.get(entry.action || entry.onPress!)?.url === source.url);
        const insert = (group: Item[]) => {
            const index = group.indexOf(anchor!);
            return index < 0 ? group : [...group.slice(0, index + 1), item, ...group.slice(index + 1)];
        };
        return {
            ...props,
            items: props.items.some(Array.isArray)
                ? props.items.map((group: Item | Item[]) => Array.isArray(group) ? insert(group) : group === anchor ? [group, item] : group)
                : insert(props.items),
        };
    }

    return {
        capture(props: any, result: any) {
            remember(result, mediaSource(props));
            // Some builds return the menu items directly; others return callbacks.
            if (Array.isArray(result)) return decorate({ items: result }).items;
            if (Array.isArray(result?.items)) return decorate(result);
            return result;
        },
        decorate,
        clear() { sources = new WeakMap(); },
    };
}
