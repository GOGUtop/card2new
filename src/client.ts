export const DEFAULT_API_URL = "http://aaa.xixisillytavern.top:8788";
export const ACCOUNT = "card2";
const PASSWORD = "2";
export const MAX_FILE_SIZE = 25 * 1024 * 1024;

export type MediaSource = { url: string; filename: string; size?: number };
type SavedState = { token?: string; tokenScope?: string };

export function normalizeBase(value: string) {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error("Invalid CardVault API URL");
    }
    return url.href.replace(/\/+$/, "");
}

export function filenameFromUrl(value: string) {
    try { return decodeURIComponent(new URL(value).pathname.split("/").pop() || ""); }
    catch { return ""; }
}

export function supported(source?: MediaSource): source is MediaSource {
    if (!source?.url || !/\.(png|json)$/i.test(source.filename)) return false;
    try { return new URL(source.url).protocol === "https:"; }
    catch { return false; }
}

// Retain CDN signatures while requesting PNG originals rather than resized previews.
export function originalUrl(value: string) {
    const url = new URL(value);
    if (url.hostname === "media.discordapp.net" && url.pathname.startsWith("/attachments/")) url.hostname = "cdn.discordapp.com";
    if (url.hostname === "cdn.discordapp.com" && url.pathname.startsWith("/attachments/")) {
        for (const key of ["width", "height", "format", "quality"]) url.searchParams.delete(key);
    }
    return url.href;
}

export class CardVaultClient {
    private pendingLogin: Promise<string> | undefined;
    private controllers = new Set<AbortController>();
    private disposed = false;
    readonly base: string;
    private saved: SavedState;
    private fetcher: typeof fetch;
    private timeoutMs: number;

    constructor(base: string, saved: SavedState, fetcher: typeof fetch = fetch, timeoutMs = 120000) {
        this.base = normalizeBase(base);
        this.saved = saved;
        this.fetcher = fetcher;
        this.timeoutMs = timeoutMs;
        if (saved.tokenScope !== this.base + "|" + ACCOUNT) {
            saved.token = "";
            saved.tokenScope = this.base + "|" + ACCOUNT;
        }
    }

    dispose() {
        this.disposed = true;
        for (const controller of this.controllers) controller.abort();
        this.controllers.clear();
    }

    private async request<T>(url: string, init: RequestInit, read: (response: Response) => Promise<T>) {
        if (this.disposed) throw new Error("CardVault stopped");
        const controller = new AbortController();
        this.controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetcher(url, { ...init, signal: controller.signal, credentials: "omit" });
            const result = await read(response);
            if (this.disposed) throw new Error("CardVault stopped");
            return result;
        } finally {
            clearTimeout(timer);
            this.controllers.delete(controller);
        }
    }

    private json(path: string, init: RequestInit) {
        return this.request(this.base + path, init, async response => {
            let body: any = {};
            try { body = await response.json(); }
            catch (error) {
                if (!(error instanceof SyntaxError)) throw error;
                if (response.ok) throw new Error("CardVault returned invalid JSON");
            }
            return { ok: response.ok, status: response.status, body };
        });
    }

    private failure(result: { status: number; body: any }) {
        const message = result.body?.message || result.body?.error;
        return new Error(typeof message === "string" ? message.slice(0, 200) : `CardVault HTTP ${result.status}`);
    }

    async login(): Promise<string> {
        if (this.pendingLogin) return this.pendingLogin;
        this.pendingLogin = (async () => {
            const result = await this.json("/api/login", {
                method: "POST",
                headers: { Accept: "application/json", "Content-Type": "application/json" },
                body: JSON.stringify({ username: ACCOUNT, password: PASSWORD }),
            });
            if (!result.ok || typeof result.body?.token !== "string" || !result.body.token) throw this.failure(result);
            if (result.body.username && result.body.username !== ACCOUNT) throw new Error("CardVault account mismatch");
            this.saved.token = result.body.token;
            return result.body.token;
        })();
        try { return await this.pendingLogin; }
        finally { this.pendingLogin = undefined; }
    }

    private async authorized(path: string, init: RequestInit = {}) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = this.saved.token || await this.login();
            const result = await this.json(path, {
                ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` },
            });
            if (result.status === 401) {
                if (this.saved.token === token) this.saved.token = "";
                if (attempt === 0) continue;
            }
            if (!result.ok) throw this.failure(result);
            return result.body;
        }
    }

    async ensureSession() {
        if (!this.saved.token) { await this.login(); return; }
        const me = await this.authorized("/api/me", { method: "GET" });
        if (me?.username !== ACCOUNT) {
            this.saved.token = "";
            await this.login();
        }
    }

    async upload(source: MediaSource) {
        if (!supported(source)) throw new Error("Only HTTPS PNG and JSON attachments are supported");
        if (source.size && source.size > MAX_FILE_SIZE) throw new Error("Attachment exceeds 25 MB");
        if (!this.saved.token) await this.login();
        const blob = await this.request(originalUrl(source.url), {}, async response => {
            if (!response.ok) throw new Error(`Attachment download failed: HTTP ${response.status}`);
            if (Number(response.headers.get("content-length")) > MAX_FILE_SIZE) throw new Error("Attachment exceeds 25 MB");
            const data = await response.blob();
            if (!data.size || data.size > MAX_FILE_SIZE) throw new Error("Attachment is empty or exceeds 25 MB");
            return data;
        });
        return this.authorized("/api/cards/import", {
            method: "POST",
            headers: {
                "Content-Type": /\.png$/i.test(source.filename) ? "image/png" : "application/json",
                "X-File-Name": encodeURIComponent(source.filename),
            },
            body: blob,
        });
    }
}
