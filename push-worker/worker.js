/* Breed Manager push server (Cloudflare Worker, free plan).
   Each iPhone sends only its upcoming reminders (date + short text) and its push subscription; every hour the cron
   trigger sends one notification per device when its chosen hour has come and it has reminders for that day.
   The push carries no payload: the app's service worker fetches the text from /pending, so no message encryption
   is needed. VAPID keys are made on first use and kept in KV, so there is no secret to set up.

   Setup (Cloudflare dashboard): Workers → Create → paste this file → Settings → Bindings → KV namespace,
   variable name PUSH → Triggers → Cron "0 * * * *". */
const ORIGIN = "https://cdrettili-breed.github.io";
const SUBJECT = "https://cdrettili-breed.github.io/breed-manager/";
const CORS = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const te = new TextEncoder();
const b64u = buf => { const u = new Uint8Array(buf); let s = ""; for (const b of u) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const idOf = async endpoint => b64u(await crypto.subtle.digest("SHA-256", te.encode(endpoint))).slice(0, 32);
const okEndpoint = ep => { try { const u = new URL(ep); return u.protocol === "https:" && /(^|\.)(push\.apple\.com|googleapis\.com|mozilla\.com|windows\.com|mozaws\.net)$/.test(u.hostname); } catch { return false; } };

async function vapid(env) {
  let v = await env.PUSH.get("vapid", "json");
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    v = { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)) };
    await env.PUSH.put("vapid", JSON.stringify(v));
  }
  return v;
}
async function sendPush(env, endpoint) {
  const v = await vapid(env), enc = o => b64u(te.encode(JSON.stringify(o)));
  const unsigned = enc({ typ: "JWT", alg: "ES256" }) + "." + enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT });
  const key = await crypto.subtle.importKey("jwk", v.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(unsigned));
  const r = await fetch(endpoint, { method: "POST", headers: { Authorization: `vapid t=${unsigned}.${b64u(sig)}, k=${v.pub}`, TTL: "86400", Urgency: "normal", "Content-Length": "0" } });
  return r.status;
}
/* the device's local date and hour from the offset it reported (minutes, as Date#getTimezoneOffset) */
const localNow = offset => { const d = new Date(Date.now() - (offset || 0) * 60000); return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() }; };
const cleanItems = items => (Array.isArray(items) ? items : []).slice(0, 300).map(i => ({ d: String(i.d || "").slice(0, 10), k: String(i.k || "").slice(0, 80), title: String(i.title || "").slice(0, 80), body: String(i.body || "").slice(0, 200) })).filter(i => /^\d{4}-\d{2}-\d{2}$/.test(i.d) && i.k);
/* one notification per device and day: up to 3 reminders as they are, more become a summary */
function messagesFor(due) {
  if (due.length <= 3) return due.map(i => ({ title: i.title, body: i.body, tag: i.k }));
  return [{ title: "今日の予定（" + due.length + "件）", body: due.map(i => i.title).join("\n"), tag: "today" }];
}
async function deliver(env, id, rec, force) {
  const now = localNow(rec.offset);
  if (!force && now.hour < (rec.hour ?? 8)) return false;
  const sent = rec.sent || {}, due = rec.items.filter(i => i.d === now.date && !sent[i.k]);
  if (!due.length) return false;
  await env.PUSH.put("q:" + id, JSON.stringify(messagesFor(due)), { expirationTtl: 2 * 86400 });
  const st = await sendPush(env, rec.endpoint);
  if (st === 404 || st === 410) { await env.PUSH.delete("s:" + id); return false; }
  for (const i of due) sent[i.k] = i.d;
  /* forget what was sent more than a week ago */
  const old = localNow((rec.offset || 0) + 7 * 1440).date;
  for (const [k, d] of Object.entries(sent)) if (d < old) delete sent[k];
  rec.sent = sent;
  await env.PUSH.put("s:" + id, JSON.stringify(rec));
  return true;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      if (url.pathname === "/vapid") return json({ key: (await vapid(env)).pub });
      if (url.pathname === "/sync" && req.method === "POST") {
        const b = await req.json(), sub = b.subscription || {};
        if (!okEndpoint(sub.endpoint)) return json({ error: "bad subscription" }, 400);
        const id = await idOf(sub.endpoint), prev = await env.PUSH.get("s:" + id, "json");
        const items = cleanItems(b.items), keep = new Set(items.map(i => i.k)), sent = {};
        for (const [k, d] of Object.entries(prev?.sent || {})) if (keep.has(k)) sent[k] = d;
        await env.PUSH.put("s:" + id, JSON.stringify({ endpoint: sub.endpoint, offset: Number(b.offset) || 0, hour: Math.min(23, Math.max(0, Number(b.hour ?? 8))), items, sent, at: Date.now() }));
        return json({ ok: true, id, count: items.length });
      }
      if (url.pathname === "/unsubscribe" && req.method === "POST") {
        const b = await req.json(); if (b.endpoint) { const id = await idOf(b.endpoint); await env.PUSH.delete("s:" + id); await env.PUSH.delete("q:" + id); }
        return json({ ok: true });
      }
      if (url.pathname === "/test" && req.method === "POST") {
        const b = await req.json(); if (!okEndpoint(b.endpoint)) return json({ error: "bad subscription" }, 400);
        const id = await idOf(b.endpoint);
        await env.PUSH.put("q:" + id, JSON.stringify([{ title: "Breed Manager", body: "通知のテストです。毎朝、その日の予定をお知らせします。", tag: "test" }]), { expirationTtl: 86400 });
        return json({ ok: true, status: await sendPush(env, b.endpoint) });
      }
      if (url.pathname === "/pending") {
        const ep = url.searchParams.get("ep") || ""; if (!ep) return json({ messages: [] });
        const id = await idOf(ep), q = await env.PUSH.get("q:" + id, "json");
        if (q) await env.PUSH.delete("q:" + id);
        return json({ messages: q || [] });
      }
      return json({ error: "not found" }, 404);
    } catch (e) { return json({ error: String(e && e.message || e) }, 500); }
  },
  async scheduled(event, env, ctx) {
    let cursor;
    do {
      const page = await env.PUSH.list({ prefix: "s:", cursor });
      for (const k of page.keys) {
        const rec = await env.PUSH.get(k.name, "json"); if (!rec) continue;
        try { await deliver(env, k.name.slice(2), rec, false); } catch (e) { console.warn("deliver", k.name, e); }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  },
};
