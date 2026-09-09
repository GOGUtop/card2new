import test from "node:test";
import assert from "node:assert/strict";
import { CardVaultClient, MAX_FILE_SIZE, filenameFromUrl, originalUrl, supported } from "../src/client.ts";

const base = "https://vault.example";
const png = { filename: "card.png", url: "https://cdn.discordapp.com/attachments/1/2/card.png?ex=123&hm=abc" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const savedToken = token => ({ token, tokenScope: base + "|card2" });

test("fresh and concurrent requests share one login and persist the token", async () => {
    const saved = {};
    let count = 0;
    const client = new CardVaultClient(base, saved, async (url, options) => {
        count++;
        assert.equal(url, base + "/api/login");
        assert.deepEqual(JSON.parse(options.body), { username: "card2", password: "2" });
        assert.equal(options.credentials, "omit");
        await new Promise(resolve => setImmediate(resolve));
        return json({ token: "session", username: "card2" });
    });
    await Promise.all([client.ensureSession(), client.ensureSession(), client.ensureSession()]);
    assert.equal(count, 1);
    assert.equal(saved.token, "session");
});

test("restart reuses saved login; an expired token is refreshed", async () => {
    const saved = savedToken("expired");
    const paths = [];
    const client = new CardVaultClient(base, saved, async (url, options) => {
        paths.push(url);
        if (url.endsWith("/api/login")) return json({ token: "new", username: "card2" });
        return options.headers.Authorization === "Bearer expired" ? json({}, 401) : json({ username: "card2" });
    });
    await client.ensureSession();
    assert.deepEqual(paths, [base + "/api/me", base + "/api/login", base + "/api/me"]);
    assert.equal(saved.token, "new");
    paths.length = 0;
    await client.ensureSession();
    assert.deepEqual(paths, [base + "/api/me"]);
});

test("upload 401 retries the same blob, without redownloading or leaking vault auth to CDN", async () => {
    const saved = savedToken("expired");
    const payload = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 123]);
    let downloads = 0;
    const bodies = [];
    const client = new CardVaultClient(base, saved, async (url, options) => {
        if (url.startsWith("https://cdn.discordapp.com")) {
            downloads++;
            assert.equal(options.headers, undefined);
            return new Response(payload);
        }
        if (url.endsWith("/api/login")) return json({ token: "fresh" });
        assert.equal(options.headers["Content-Type"], "image/png");
        assert.equal(options.headers["X-File-Name"], "card.png");
        bodies.push(options.body);
        return options.headers.Authorization === "Bearer expired" ? json({}, 401) : json({ duplicate: true });
    });
    assert.deepEqual(await client.upload(png), { duplicate: true });
    assert.equal(downloads, 1);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.deepEqual(new Uint8Array(await bodies[1].arrayBuffer()), payload);
});

test("JSON filenames and binary body are preserved", async () => {
    const source = { filename: "my card.JSON", url: "https://cdn.discordapp.com/attachments/1/2/my%20card.JSON" };
    const content = JSON.stringify({ name: "example", description: "test card" });
    const client = new CardVaultClient(base, savedToken("ok"), async (url, options) => {
        if (url === source.url) return new Response(content);
        assert.equal(options.headers["Content-Type"], "application/json");
        assert.equal(options.headers["X-File-Name"], "my%20card.JSON");
        assert.equal(await options.body.text(), content);
        return json({ id: "test" });
    });
    assert.deepEqual(await client.upload(source), { id: "test" });
});

test("repeated 401 is bounded; 500 is not automatically re-uploaded", async () => {
    for (const status of [401, 500]) {
        let imports = 0;
        let logins = 0;
        const client = new CardVaultClient(base, savedToken("old"), async (url) => {
            if (url === png.url) return new Response("png bytes");
            if (url.endsWith("/api/login")) { logins++; return json({ token: "new" }); }
            imports++;
            return json({}, status);
        });
        await assert.rejects(client.upload(png), new RegExp(String(status)));
        assert.equal(imports, status === 401 ? 2 : 1);
        assert.equal(logins, status === 401 ? 1 : 0);
    }
});

test("changing vault invalidates the old token; mismatched account is not saved", async () => {
    const saved = { token: "private", tokenScope: "https://other.example|card2" };
    const client = new CardVaultClient(base, saved, async () => json({ token: "bad", username: "other" }));
    assert.equal(saved.token, "");
    await assert.rejects(client.login(), /mismatch/);
    assert.equal(saved.token, "");
});

test("disallowed extensions, invalid URLs and known oversized files make no network requests", async () => {
    const client = new CardVaultClient(base, savedToken("ok"), async () => { assert.fail("unexpected fetch"); });
    for (const source of [{ ...png, filename: "a.jpg" }, { ...png, url: "file:///a.png" }, { ...png, size: MAX_FILE_SIZE + 1 }]) {
        await assert.rejects(client.upload(source));
    }
    assert.equal(filenameFromUrl("bad URL"), "");
    assert.equal(supported({ url: "https://example.com/unknown", filename: "" }), false);
});

test("CDN signatures survive original PNG conversion", () => {
    const result = new URL(originalUrl("https://media.discordapp.net/attachments/1/2/card.png?ex=x&is=y&hm=z&format=webp&width=100&height=200&quality=lossless"));
    assert.equal(result.hostname, "cdn.discordapp.com");
    assert.equal(result.search, "?ex=x&is=y&hm=z");
    assert.equal(filenameFromUrl(result.href), "card.png");
});

test("unload cancels pending login and does not persist a late token", async () => {
    let respond;
    const saved = {};
    const client = new CardVaultClient(base, saved, () => new Promise(resolve => { respond = resolve; }));
    const pending = client.login();
    client.dispose();
    respond(json({ token: "late" }));
    await assert.rejects(pending, /stopped/);
    assert.equal(saved.token, "");
});

test("network errors allow a later login attempt; malformed successful JSON is not accepted", async () => {
    let count = 0;
    const client = new CardVaultClient(base, {}, async () => {
        count++;
        if (count === 1) throw new Error("offline");
        if (count === 2) return new Response("<html>error</html>");
        return json({ token: "online" });
    });
    await assert.rejects(client.login(), /offline/);
    await assert.rejects(client.login(), /invalid JSON/);
    assert.equal(await client.login(), "online");
});

test("hung requests time out", async () => {
    const client = new CardVaultClient(base, {}, (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }), 10);
    await assert.rejects(client.login(), /aborted/);
});
