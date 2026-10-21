/* Breed Manager — on-device runtime.
   Provides the same window.claude.use(name) surface the ledger page was written against,
   backed by this iPhone instead of claude.ai:
     db        — IndexedDB document store (subset of the Firestore-like API the page uses)
     assets    — photos as blobs in IndexedDB, served to <img> as "_blob/<id>" by the service worker
     sample    — chat through the Claude API with the user's own key, with a monthly budget
     downloads — PDFs handed to the iOS share sheet (Print / printer apps)
   plus BM.settings / BM.budget / BM.backup used by the page's settings screen. */
"use strict";
(() => {
  const DB_NAME = "breed-manager", DB_VER = 1;
  const idbOpen = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => { const d = r.result; for (const s of ["docs", "blobs", "kv"]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  let idbP = null; const idb = () => (idbP ||= idbOpen());
  const tx = async (store, mode, fn) => { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction(store, mode), s = t.objectStore(store); const out = fn(s); t.oncomplete = () => res(out && "result" in out ? out.result : out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
  const kvGet = k => tx("kv", "readonly", s => s.get(k));
  const kvSet = (k, v) => tx("kv", "readwrite", s => { s.put(v, k); });
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const err = (code, message) => Object.assign(new Error(message || code), { code });

  /* ---------- db ---------- */
  const docs = new Map(); // "coll/id" -> data
  let ready = null;
  const loadAll = () => (ready ||= (async () => {
    const d = await idb();
    await new Promise((res, rej) => { const t = d.transaction("docs", "readonly"), s = t.objectStore("docs"); const c = s.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { docs.set(cur.key, cur.value); cur.continue(); } else res(); }; c.onerror = () => rej(c.error); });
  })());
  const listeners = new Set();
  let notifyQueued = false;
  const notify = () => { if (notifyQueued) return; notifyQueued = true; setTimeout(() => { notifyQueued = false; for (const l of [...listeners]) l(); }, 0); };
  const markUse = () => { const now = Date.now(); kvGet("backup").then(b => { b = b || {}; b.lastWriteAt = now; if (!b.dirtySince) b.dirtySince = now; kvSet("backup", b); }); };
  const persist = (path, data) => tx("docs", "readwrite", s => { if (data === undefined) s.delete(path); else s.put(data, path); });
  const segs = p => String(p).split("/").filter(Boolean);
  const parentOf = path => segs(path).slice(0, -1).join("/");
  const snapDoc = (path, data) => ({ id: segs(path).pop(), exists: data !== undefined, data: () => clone(data), metadata: { fromCache: false, hasPendingWrites: false } });
  const deepMerge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v; return o; };
  const cmp = { "==": (a, b) => a === b, "!=": (a, b) => a !== b, "<": (a, b) => a < b, "<=": (a, b) => a <= b, ">": (a, b) => a > b, ">=": (a, b) => a >= b,
    in: (a, b) => (b || []).includes(a), "not-in": (a, b) => !(b || []).includes(a), "array-contains": (a, b) => Array.isArray(a) && a.includes(b) };
  function docRef(path) {
    if (segs(path).length % 2) throw new TypeError("document path needs an even number of segments: " + path);
    return {
      id: segs(path).pop(), path,
      async get() { await loadAll(); return snapDoc(path, docs.get(path)); },
      async set(data) { await loadAll(); const v = clone(data); docs.set(path, v); await persist(path, v); markUse(); notify(); },
      async update(data) { await loadAll(); const cur = docs.get(path); if (cur === undefined) throw err("invalid_argument", "document does not exist: " + path); const v = deepMerge(cur, clone(data)); docs.set(path, v); await persist(path, v); markUse(); notify(); },
      async delete() { await loadAll(); docs.delete(path); await persist(path, undefined); markUse(); notify(); },
      onSnapshot(next) { const fire = () => next(snapDoc(path, docs.get(path))); const l = () => fire(); listeners.add(l); loadAll().then(fire); return () => listeners.delete(l); },
      collection(sub) { return collRef(path + "/" + sub); },
    };
  }
  function query(coll, filters = [], order = null, lim = 0) {
    const run = () => {
      let out = [];
      for (const [p, v] of docs) if (parentOf(p) === coll && filters.every(([f, op, val]) => (cmp[op] || (() => false))(v[f], val))) out.push([p, v]);
      if (order) out.sort((x, y) => { const a = x[1][order[0]], b = y[1][order[0]]; const c = a == null ? 1 : b == null ? -1 : a < b ? -1 : a > b ? 1 : 0; return order[1] === "desc" ? -c : c; });
      else out.sort((x, y) => x[0].localeCompare(y[0]));
      if (lim) out = out.slice(0, lim);
      const ds = out.map(([p, v]) => snapDoc(p, v));
      return { docs: ds, size: ds.length, empty: !ds.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
    };
    return {
      where: (f, op, v) => query(coll, [...filters, [f, op, v]], order, lim),
      orderBy: (f, dir = "asc") => query(coll, filters, [f, dir], lim),
      limit: n => query(coll, filters, order, n),
      async get() { await loadAll(); return run(); },
      onSnapshot(next) { const l = () => next(run()); listeners.add(l); loadAll().then(l); return () => listeners.delete(l); },
    };
  }
  function collRef(path) {
    if (!(segs(path).length % 2)) throw new TypeError("collection path needs an odd number of segments: " + path);
    const q = query(path);
    return { ...q, path, doc: id => docRef(path + "/" + (id || crypto.randomUUID().replace(/-/g, ""))), async add(data) { const r = docRef(path + "/" + crypto.randomUUID().replace(/-/g, "")); await r.set(data); return r; } };
  }
  const db = Object.freeze({ doc: docRef, collection: collRef });

  /* ---------- assets (photos) ---------- */
  const assets = Object.freeze({
    async upload(blob, opts = {}) {
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
      const type = opts.type || blob.type || "image/jpeg";
      await tx("blobs", "readwrite", s => { s.put(new Blob([blob], { type }), id); });
      markUse();
      return { id, url: "_blob/" + id, sizeBytes: blob.size, contentType: type };
    },
    async delete(id) { await tx("blobs", "readwrite", s => { s.delete(id); }); markUse(); return { deleted: true }; },
    async list() { const keys = await tx("blobs", "readonly", s => s.getAllKeys()); return { assets: keys.map(id => ({ id, url: "_blob/" + id })), usage: {} }; },
  });
  const getBlob = id => tx("blobs", "readonly", s => s.get(id));
  const putBlob = (id, blob) => tx("blobs", "readwrite", s => { s.put(blob, id); });

  /* ---------- settings ---------- */
  const settings = {
    async get() { return { apiKey: "", budgetYen: 1000, fxRate: 150, ...(await kvGet("settings") || {}) }; },
    async set(patch) { const cur = await settings.get(); const next = { ...cur, ...patch }; await kvSet("settings", next); window.dispatchEvent(new Event("bm:status")); return next; },
  };

  /* ---------- budget: cost of every Claude call, per calendar month ---------- */
  // USD per million tokens: [input, output, cache read, cache write]
  const PRICES = {
    "claude-haiku-5-5": [0.10, 0.50, 0.01, 0.125],
    "claude-sonnet-5-5": [2.00, 10.00, 0.20, 2.50],
    "claude-opus-5-5": [4.00, 20.00, 0.20, 5.00],
  };
  const monthKey = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };
  const costOf = (model, u = {}) => {
    const p = PRICES[model] || PRICES[Object.keys(PRICES).find(k => String(model).startsWith(k))] || PRICES["claude-sonnet-5-5"];
    return ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] + (u.cache_read_input_tokens || 0) * p[2] + (u.cache_creation_input_tokens || 0) * p[3]) / 1e6;
  };
  const budget = {
    async status() {
      const st = await settings.get(), use = await kvGet("usage") || {}, usd = use[monthKey()] || 0;
      const spentYen = usd * st.fxRate, budgetYen = Number(st.budgetYen) || 0;
      return { month: monthKey(), usd, spentYen, budgetYen, remainingYen: budgetYen - spentYen, ratio: budgetYen ? spentYen / budgetYen : 0, hasKey: !!st.apiKey };
    },
    async add(usd) { const use = await kvGet("usage") || {}, k = monthKey(); use[k] = (use[k] || 0) + usd; await kvSet("usage", use); window.dispatchEvent(new Event("bm:status")); },
    /* the yen rate follows the market: refreshed at most twice a day, the last rate is kept when offline */
    async refreshFx(force) {
      const st = await settings.get();
      if (!force && st.fxAt && Date.now() - Date.parse(st.fxAt) < 12 * 3600e3) return st.fxRate;
      const r = await fetch("https://open.er-api.com/v6/latest/USD", { cache: "no-store" });
      const j = r.ok ? await r.json() : null, jpy = Number(j && j.rates && j.rates.JPY);
      if (!(jpy > 50 && jpy < 500)) throw err("fx", "為替レートを取得できませんでした");
      await settings.set({ fxRate: Math.round(jpy * 100) / 100, fxAt: new Date().toISOString() });
      return jpy;
    },
  };

  /* ---------- sample: chat through the Claude API ---------- */
  const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.135.0/+esm";
  let sdkP = null;
  const loadSDK = () => (sdkP ||= import(SDK_URL).then(m => m.default || m.Anthropic));
  const MODELS = { quick: { model: "claude-haiku-5-5", effort: "low" }, default: { model: "claude-sonnet-5-5", effort: "medium" } };
  async function sample(input, opts = {}) {
    const st = await settings.get();
    if (!st.apiKey) throw err("no_key", "APIキーが未設定です");
    const b = await budget.status();
    if (b.budgetYen && b.remainingYen <= 0) throw err("budget", "今月の予算に達しました");
    let Anthropic;
    try { Anthropic = await loadSDK(); } catch { throw err("upstream_error", "Claudeの部品を読み込めませんでした"); }
    const client = new Anthropic({ apiKey: st.apiKey, dangerouslyAllowBrowser: true });
    const pick = MODELS[opts.modelTier] || MODELS.quick;
    const tools = (opts.tools || []).map((t, i, a) => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: "object", properties: {} }, ...(i === a.length - 1 ? { cache_control: { type: "ephemeral" } } : {}) }));
    const byName = new Map((opts.tools || []).map(t => [t.name, t]));
    const messages = (typeof input === "string" ? [{ role: "user", content: input }] : input).map(m => ({ role: m.role, content: m.content }));
    const sonnet = pick.model === "claude-sonnet-5-5";
    let finalText = "";
    for (let round = 0; round < 8; round++) {
      const params = { model: pick.model, max_tokens: 8000, messages, cache_control: { type: "ephemeral" }, output_config: { effort: pick.effort } };
      if (opts.system) params.system = opts.system;
      if (tools.length) params.tools = tools;
      let res;
      try {
        res = sonnet
          ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, { signal: opts.signal })
          : await client.messages.create(params, { signal: opts.signal });
      } catch (e) {
        if (opts.signal?.aborted) throw err("cancelled");
        if (e instanceof Anthropic.AuthenticationError) throw err("bad_key", "APIキーが正しくありません");
        if (e instanceof Anthropic.PermissionDeniedError) throw err("bad_key", "このAPIキーでは使えません");
        if (e instanceof Anthropic.RateLimitError) throw err("rate_limited", "混み合っています");
        if (e instanceof Anthropic.BadRequestError && /credit|balance|billing/i.test(String(e.message))) throw err("no_credit", "Anthropicのクレジットが不足しています");
        if (e instanceof Anthropic.APIError) throw err("upstream_error", e.message);
        throw err("upstream_error", String(e?.message || e));
      }
      await budget.add(costOf(res.model || pick.model, res.usage));
      if (res.stop_reason === "refusal") throw err("refused");
      const text = res.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
      if (text) finalText = text;
      if (res.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: res.content }); continue; }
      const uses = res.content.filter(c => c.type === "tool_use");
      if (res.stop_reason !== "tool_use" || !uses.length) break;
      messages.push({ role: "assistant", content: res.content });
      const results = await Promise.all(uses.map(async u => {
        const t = byName.get(u.name);
        try {
          if (!t) throw new Error("unknown tool " + u.name);
          const out = await t.execute(u.input || {}, { signal: opts.signal || new AbortController().signal });
          return { type: "tool_result", tool_use_id: u.id, content: typeof out === "string" ? out : JSON.stringify(out ?? null) };
        } catch (x) { return { type: "tool_result", tool_use_id: u.id, content: "Error: " + (x?.message || String(x)), is_error: true }; }
      }));
      messages.push({ role: "user", content: results });
      const b2 = await budget.status(); if (b2.budgetYen && b2.remainingYen <= 0) break;
    }
    if (!finalText) throw err("empty_completion");
    opts.onText?.({ text: finalText, delta: finalText });
    return { text: finalText, truncated: false, modelTierApplied: opts.modelTier || "quick" };
  }
  sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 64 } });

  /* ---------- downloads: iOS share sheet (Print / label printer apps) ---------- */
  const downloads = Object.freeze({
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const file = new File([blob], filename, { type: /\.pdf$/i.test(filename) ? "application/pdf" : /\.png$/i.test(filename) ? "image/png" : blob.type || "application/octet-stream" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file] }); return { status: "saved" }; }
        catch (e) { if (e && e.name === "AbortError") throw err("declined"); }
      }
      const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = filename; document.body.append(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      return { status: "saved" };
    },
  });

  /* ---------- backup to the user's own Dropbox (app folder) ---------- */
  const DROPBOX_APP_KEY = "niase0v78ostvxm"; // public value; PKCE needs no secret
  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const dbxState = async () => (await kvGet("dropbox")) || {};
  async function dbxToken() {
    const s = await dbxState(); if (!s.refreshToken) throw err("not_linked", "Dropboxがつながっていません");
    if (s.accessToken && s.expiresAt > Date.now() + 60000) return s.accessToken;
    const r = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.refreshToken, client_id: DROPBOX_APP_KEY }) });
    if (!r.ok) throw err("dbx_auth", "Dropboxにつなぎ直してください");
    const j = await r.json(); await kvSet("dropbox", { ...s, accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in || 14400) * 1000 });
    return j.access_token;
  }
  const dbxRpc = async (ep, body) => {
    const r = await fetch("https://api.dropboxapi.com/2/" + ep, { method: "POST", headers: { Authorization: "Bearer " + await dbxToken(), "Content-Type": "application/json" }, body: JSON.stringify(body ?? null) });
    if (!r.ok) { const t = await r.text(); throw err(r.status === 409 ? "dbx_conflict" : "dbx_error", t); }
    return r.json();
  };
  const dbxUpload = async (path, blob) => {
    const r = await fetch("https://content.dropboxapi.com/2/files/upload", { method: "POST", headers: { Authorization: "Bearer " + await dbxToken(), "Content-Type": "application/octet-stream", "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", mute: true }) }, body: blob });
    if (!r.ok) throw err(r.status === 409 ? "dbx_full" : "dbx_error", await r.text());
    return r.json();
  };
  const dbxDownload = async path => {
    const r = await fetch("https://content.dropboxapi.com/2/files/download", { method: "POST", headers: { Authorization: "Bearer " + await dbxToken(), "Dropbox-API-Arg": JSON.stringify({ path }) } });
    if (!r.ok) throw err("dbx_error", await r.text());
    return r.blob();
  };
  const dbxList = async path => {
    let j; try { j = await dbxRpc("files/list_folder", { path, limit: 2000 }); } catch (e) { if (e.code === "dbx_conflict") return []; throw e; }
    const out = [...j.entries]; while (j.has_more) { j = await dbxRpc("files/list_folder/continue", { cursor: j.cursor }); out.push(...j.entries); }
    return out;
  };
  const gzip = async text => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
  const gunzip = async blob => new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();
  const localDay = (t = Date.now()) => { const d = new Date(t); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const backup = {
    appKeySet: () => !!DROPBOX_APP_KEY,
    async state() { const s = await dbxState(), b = await kvGet("backup") || {}; return { linked: !!s.refreshToken, account: s.account || "", lastBackupAt: b.lastBackupAt || 0, dirtySince: b.dirtySince || 0, usage: b.usage || null, lastError: b.lastError || "" }; },
    /* PKCE without a redirect: Dropbox shows a code that the user pastes back, which also works from the home-screen app */
    /* the link URL is prepared ahead of the tap (iOS only opens a page straight from a tap) and kept,
       so the pasted code still matches after the app is reopened from the home screen */
    async startLink(fresh = false) {
      if (!DROPBOX_APP_KEY) throw err("no_app_key", "Dropboxアプリの登録がまだです");
      const cur = await kvGet("dropbox_pkce");
      if (!fresh && cur && cur.url && cur.verifier) return cur.url;
      const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
      const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
      const url = "https://www.dropbox.com/oauth2/authorize?" + new URLSearchParams({ client_id: DROPBOX_APP_KEY, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", token_access_type: "offline" });
      await kvSet("dropbox_pkce", { verifier, url });
      return url;
    },
    async finishLink(code) {
      const p = await kvGet("dropbox_pkce"), verifier = p && (p.verifier || (typeof p === "string" ? p : "")); if (!verifier) throw err("dbx_auth", "最初からやり直してください");
      const r = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", body: new URLSearchParams({ code: String(code).trim(), grant_type: "authorization_code", code_verifier: verifier, client_id: DROPBOX_APP_KEY }) });
      if (!r.ok) throw err("dbx_auth", "コードが正しくないか、期限が切れています");
      const j = await r.json();
      await kvSet("dropbox", { refreshToken: j.refresh_token, accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in || 14400) * 1000 });
      await kvSet("dropbox_pkce", null);
      try { const a = await dbxRpc("users/get_current_account"); const s = await dbxState(); await kvSet("dropbox", { ...s, account: a.email || a.name?.display_name || "" }); } catch {}
      window.dispatchEvent(new Event("bm:status"));
      await backup.refreshUsage().catch(() => {});
    },
    async unlink() { await kvSet("dropbox", {}); window.dispatchEvent(new Event("bm:status")); },
    async refreshUsage() {
      const u = await dbxRpc("users/get_space_usage");
      const allocated = u.allocation?.allocated || 0, b = await kvGet("backup") || {};
      b.usage = { used: u.used || 0, allocated, ratio: allocated ? (u.used || 0) / allocated : 0, at: Date.now() };
      await kvSet("backup", b); window.dispatchEvent(new Event("bm:status")); return b.usage;
    },
    /* due on the first open at or after 06:00 on the day after the ledger last changed */
    async isDue() {
      const st = await backup.state(); if (!st.linked || !st.dirtySince) return false;
      const d = new Date(st.dirtySince); const due = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 6, 0, 0).getTime();
      return Date.now() >= due && st.lastBackupAt < st.dirtySince;
    },
    async run({ removeSoldAfterDays = 365 } = {}) {
      await loadAll();
      const startedAt = Date.now();
      const snapshot = { app: "breed-manager", version: 1, exportedAt: new Date().toISOString(), docs: Object.fromEntries(docs) };
      await dbxUpload("/backups/" + localDay() + ".json.gz", await gzip(JSON.stringify(snapshot)));
      const b = await kvGet("backup") || {}; const uploaded = new Set(b.uploadedPhotos || []);
      // photos of geckos sold more than a year ago leave the backup (they stay on the iPhone)
      const cutoff = localDay(Date.now() - removeSoldAfterDays * 864e5), drop = new Set();
      for (const [p, v] of docs) if (p.startsWith("geckos/") && v.status === "販売済" && v.soldDate && v.soldDate < cutoff) for (const ph of v.photos || []) drop.add(ph.id);
      const blobIds = await tx("blobs", "readonly", s => s.getAllKeys());
      for (const id of blobIds) {
        if (drop.has(id) || uploaded.has(id)) continue;
        const blob = await getBlob(id); if (!blob) continue;
        await dbxUpload("/photos/" + id + ".jpg", blob); uploaded.add(id);
      }
      for (const id of drop) if (uploaded.has(id)) { try { await dbxRpc("files/delete_v2", { path: "/photos/" + id + ".jpg" }); } catch {} uploaded.delete(id); }
      // keep the last 30 daily snapshots plus the last snapshot of every month
      const files = (await dbxList("/backups")).filter(e => e[".tag"] === "file" && /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(e.name)).map(e => e.name).sort().reverse();
      const keep = new Set(files.slice(0, 30)), months = new Set();
      for (const n of files) { const m = n.slice(0, 7); if (!months.has(m)) { months.add(m); keep.add(n); } }
      for (const n of files) if (!keep.has(n)) { try { await dbxRpc("files/delete_v2", { path: "/backups/" + n }); } catch {} }
      const cur = await kvGet("backup") || {};
      const next = { ...cur, uploadedPhotos: [...uploaded], lastBackupAt: startedAt, lastError: "" };
      next.dirtySince = cur.lastWriteAt && cur.lastWriteAt > startedAt ? cur.lastWriteAt : 0;
      await kvSet("backup", next);
      await backup.refreshUsage().catch(() => {});
      window.dispatchEvent(new Event("bm:status"));
      return { at: startedAt, photos: uploaded.size };
    },
    async noteError(e) { const b = await kvGet("backup") || {}; b.lastError = String(e?.message || e); await kvSet("backup", b); window.dispatchEvent(new Event("bm:status")); },
    async listSnapshots() { return (await dbxList("/backups")).filter(e => e[".tag"] === "file" && /\.json\.gz$/.test(e.name)).map(e => e.name).sort().reverse(); },
    async restore(name, onProgress) {
      const snap = JSON.parse(await gunzip(await dbxDownload("/backups/" + name)));
      if (snap.app !== "breed-manager" || !snap.docs) throw err("bad_backup", "このファイルは台帳のバックアップではありません");
      await importDocs(snap.docs);
      const ids = new Set(); for (const v of Object.values(snap.docs)) for (const ph of (v && v.photos) || []) ids.add(ph.id);
      let n = 0; const uploaded = [];
      for (const id of ids) { try { await putBlob(id, await dbxDownload("/photos/" + id + ".jpg")); uploaded.push(id); } catch {} n++; onProgress?.(n, ids.size); }
      const b = await kvGet("backup") || {}; await kvSet("backup", { ...b, uploadedPhotos: uploaded, dirtySince: 0, lastBackupAt: Date.now() });
      return { docs: Object.keys(snap.docs).length, photos: uploaded.length };
    },
  };
  async function importDocs(obj) {
    await loadAll();
    const d = await idb();
    await new Promise((res, rej) => { const t = d.transaction("docs", "readwrite"), s = t.objectStore("docs"); s.clear(); for (const [p, v] of Object.entries(obj)) s.put(v, p); t.oncomplete = res; t.onerror = () => rej(t.error); });
    docs.clear(); for (const [p, v] of Object.entries(obj)) docs.set(p, v);
    notify();
  }
  /* plain JSON export / import (also used to bring data over from the claude.ai ledger) */
  const data = {
    async exportJSON() { await loadAll(); return JSON.stringify({ app: "breed-manager", version: 1, exportedAt: new Date().toISOString(), docs: Object.fromEntries(docs) }); },
    async importJSON(text) {
      const j = JSON.parse(text);
      const obj = j.docs && !Array.isArray(j.docs) ? j.docs : null; if (!obj) throw err("bad_backup", "台帳のデータではありません");
      await importDocs(obj); return Object.keys(obj).length;
    },
  };

  /* photos are referenced as "_blob/<id>"; swap them for in-memory URLs so they show even before the
     offline worker is active (first launch) or where service workers are unavailable */
  const blobUrls = new Map();
  const fixImg = img => {
    const m = (img.getAttribute("src") || "").match(/(?:^|\/)_blob\/([0-9a-f]{32})$/); if (!m) return;
    const id = m[1];
    if (blobUrls.has(id)) { img.src = blobUrls.get(id); return; }
    getBlob(id).then(b => { if (!b) return; if (!blobUrls.has(id)) blobUrls.set(id, URL.createObjectURL(b)); img.src = blobUrls.get(id); }).catch(() => {});
  };
  const scan = root => { if (root.tagName === "IMG") fixImg(root); root.querySelectorAll?.('img[src*="_blob/"]').forEach(fixImg); };
  new MutationObserver(ms => { for (const m of ms) { if (m.type === "attributes") fixImg(m.target); else m.addedNodes.forEach(n => n.nodeType === 1 && scan(n)); } })
    .observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });

  /* ---------- public wholesale catalog: published into this app's own GitHub Pages site ----------
     One commit per publish (Git Data API): new photos as blobs, removed photos deleted, catalog.json replaced.
     Needs a fine-grained token with Contents read/write on the repository, kept only on this iPhone. */
  const GH = { owner: "cdrettili-breed", repo: "breed-manager", branch: "main" };
  const SITE = "https://cdrettili-breed.github.io/breed-manager/";
  async function gh(path, opts = {}) {
    const st = await settings.get(); if (!st.ghToken) throw err("no_gh", "GitHubの鍵が未設定です。設定の「卸カタログの公開」で入れてください");
    const r = await fetch("https://api.github.com" + path, { ...opts, headers: { Authorization: "Bearer " + st.ghToken, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(opts.body ? { "Content-Type": "application/json" } : {}) } });
    if (!r.ok) {
      if (r.status === 401) throw err("gh_auth", "GitHubの鍵が正しくないか、期限が切れています");
      if (r.status === 403 || r.status === 404) throw err("gh_auth", "GitHubの鍵に、このリポジトリへの書き込み権限がありません");
      throw err("gh_error", "GitHubへの送信に失敗しました（" + r.status + "）");
    }
    return r.status === 204 ? null : r.json();
  }
  const toB64 = async blob => { const buf = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(s); };
  /* one publisher per public list: the wholesale catalog (docs/catalog) and the retail list (docs/shop) */
  const makePub = ({ dir, kv, title, what }) => ({
    url: SITE + dir + "/",
    async state() { return (await kvGet(kv)) || {}; },
    async publish(cat, onProgress) {
      const P = `/repos/${GH.owner}/${GH.repo}`;
      const ref = await gh(`${P}/git/ref/heads/${GH.branch}`), baseSha = ref.object.sha;
      const baseCommit = await gh(`${P}/git/commits/${baseSha}`);
      const pub = (await kvGet(kv)) || {}, have = new Set(pub.photos || []), want = new Set();
      const items = (cat.items || []).slice().sort((a, b) => (a.wno ?? 0) - (b.wno ?? 0)).map(x => {
        const ph = (x.photos || []).slice(0, 4); ph.forEach(id => want.add(id));
        return { id: "No." + x.wno, wno: x.wno, sex: x.sex || "", morph: x.morph || "", morphEn: x.morphEn || "", het: x.het || "", birthDate: x.birthDate || "", price: x.price ?? null, photos: ph.map(id => "photos/" + id + ".jpg") };
      });
      const tree = [], published = new Set([...have].filter(id => want.has(id)));
      let n = 0; const todo = [...want].filter(id => !have.has(id));
      for (const id of todo) {
        const b = await getBlob(id); if (!b) continue;
        const blob = await gh(`${P}/git/blobs`, { method: "POST", body: JSON.stringify({ content: await toB64(b), encoding: "base64" }) });
        tree.push({ path: `docs/${dir}/photos/${id}.jpg`, mode: "100644", type: "blob", sha: blob.sha }); published.add(id);
        onProgress?.(++n, todo.length);
      }
      for (const id of have) if (!want.has(id)) tree.push({ path: `docs/${dir}/photos/${id}.jpg`, mode: "100644", type: "blob", sha: null });
      tree.push({ path: `docs/${dir}/catalog.json`, mode: "100644", type: "blob", content: JSON.stringify({ title: cat.title || title, updatedAt: new Date().toISOString(), items }) });
      const newTree = await gh(`${P}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }) });
      const commit = await gh(`${P}/git/commits`, { method: "POST", body: JSON.stringify({ message: `${what}を更新（${items.length}頭）`, tree: newTree.sha, parents: [baseSha] }) });
      await gh(`${P}/git/refs/heads/${GH.branch}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
      await kvSet(kv, { photos: [...published], at: Date.now(), count: items.length });
      return { count: items.length, url: SITE + dir + "/" };
    },
  });
  const catalogPub = makePub({ dir: "catalog", kv: "catalog_pub", title: "卸リスト", what: "卸カタログ" });
  const shopPub = makePub({ dir: "shop", kv: "shop_pub", title: "販売リスト", what: "販売リスト" });

  window.BM = { settings, budget, backup, data, db, catalog: catalogPub, shop: shopPub };
  const caps = { db, assets, sample, downloads };
  window.claude = Object.freeze({ use: name => Promise.resolve(caps[name] || null) });
})();
