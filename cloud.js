/* Conti — archivio dati su Supabase.
   Espone la stessa interfaccia "documenti" usata dall'app (doc/collection/where/orderBy/limit/get/onSnapshot/set/update/delete),
   con copia locale per l'uso offline, coda delle modifiche non ancora inviate e sincronizzazione in tempo reale tra dispositivi. */
(() => {
  "use strict";
  const SUPABASE_URL = "https://yvvzpoiizkminholxxrd.supabase.co";
  const SUPABASE_KEY = "sb_publishable_7bhFUBkalllu3J4bFCggGQ_SQWd-xio";
  const TABLE = "docs";

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "conti-auth" }
  });

  const clone = o => JSON.parse(JSON.stringify(o));
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };

  let uid = null;
  const docs = new Map();          // path -> data
  let queue = [];                  // [{op:"set"|"del", path, data}]
  const listeners = new Set();
  let flushing = false, channel = null, statusCb = () => {};

  const cacheKey = () => "conti-cache-" + uid, queueKey = () => "conti-queue-" + uid;
  let saveTimer = null;
  const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { ls.set(cacheKey(), Object.fromEntries(docs)); ls.set(queueKey(), queue); }, 150); };
  const notify = () => { for (const l of [...listeners]) { try { l(); } catch (e) { console.error(e); } } };
  const pending = () => queue.length > 0;
  const setStatus = () => statusCb(!navigator.onLine ? "offline" : pending() ? "busy" : "ok");

  /* ---------- sincronizzazione ---------- */
  async function flush() {
    if (flushing || !uid || !navigator.onLine) { setStatus(); return; }
    flushing = true; setStatus();
    try {
      while (queue.length) {
        // raggruppa le scritture consecutive dello stesso tipo
        const op = queue[0].op; const batch = [];
        while (queue.length && queue[0].op === op && batch.length < 400) batch.push(queue.shift());
        try {
          if (op === "set") {
            const rows = [...new Map(batch.map(b => [b.path, {user_id:uid, path:b.path, data:b.data, updated_at:new Date().toISOString()}])).values()];
            const { error } = await sb.from(TABLE).upsert(rows, { onConflict: "user_id,path" });
            if (error) throw error;
          } else {
            const { error } = await sb.from(TABLE).delete().eq("user_id", uid).in("path", batch.map(b => b.path));
            if (error) throw error;
          }
        } catch (e) { queue.unshift(...batch); throw e; }
        persist();
      }
    } catch (e) { console.warn("Sincronizzazione rimandata", e); setTimeout(flush, 15000); }
    finally { flushing = false; persist(); setStatus(); notify(); }
  }

  async function pullAll() {
    const all = new Map(); let from = 0;
    for (;;) {
      const { data, error } = await sb.from(TABLE).select("path,data").order("path").range(from, from + 999);
      if (error) throw error;
      data.forEach(r => all.set(r.path, r.data));
      if (data.length < 1000) break; from += 1000;
    }
    // le modifiche locali non ancora inviate hanno la precedenza
    for (const q of queue) { if (q.op === "set") all.set(q.path, q.data); else all.delete(q.path); }
    docs.clear(); all.forEach((v, k) => docs.set(k, v));
    persist(); notify();
  }

  function subscribe() {
    channel?.unsubscribe();
    channel = sb.channel("docs-" + uid)
      .on("postgres_changes", { event: "*", schema: "public", table: TABLE, filter: "user_id=eq." + uid }, p => {
        const path = p.new?.path || p.old?.path; if (!path) return;
        if (queue.some(q => q.path === path)) return; // la nostra versione locale vince finché non è inviata
        if (p.eventType === "DELETE") docs.delete(path); else docs.set(path, p.new.data);
        persist(); notify();
      })
      .subscribe(st => { if (st === "SUBSCRIBED") pullAll().catch(() => {}); });
  }

  /* ---------- interfaccia documenti ---------- */
  const colOf = p => p.split("/").slice(0, -1).join("/");
  const meta = () => ({ fromCache: !navigator.onLine, hasPendingWrites: pending() });
  const snapDoc = p => ({ id: p.split("/").pop(), exists: docs.has(p), data: () => docs.has(p) ? clone(docs.get(p)) : undefined, metadata: meta() });
  const cmp = (a, op, v) => op === "==" ? a === v : op === "!=" ? a !== v : op === "<" ? a < v : op === "<=" ? a <= v : op === ">" ? a > v : op === ">=" ? a >= v : op === "in" ? v.includes(a) : op === "array-contains" ? Array.isArray(a) && a.includes(v) : true;

  function write(op, path, data) {
    if (op === "set") docs.set(path, clone(data)); else docs.delete(path);
    queue = queue.filter(q => q.path !== path); queue.push({ op, path, data: op === "set" ? clone(data) : undefined });
    persist(); notify(); flush();
    return Promise.resolve();
  }
  function docRef(path) {
    return {
      id: path.split("/").pop(), path,
      get: async () => snapDoc(path),
      set: async d => write("set", path, d),
      update: async d => { if (!docs.has(path)) throw { code: "invalid_argument" }; return write("set", path, { ...docs.get(path), ...clone(d) }); },
      delete: async () => write("del", path),
      onSnapshot(next) { const l = () => next(snapDoc(path)); listeners.add(l); setTimeout(l, 0); return () => listeners.delete(l); },
      collection: c => query(path + "/" + c)
    };
  }
  function query(col, f = [], ob = null, lim = null) {
    const run = () => {
      let ps = [...docs.keys()].filter(p => colOf(p) === col && f.every(([k, op, v]) => cmp(docs.get(p)?.[k], op, v)));
      if (ob) ps.sort((a, b) => { const x = docs.get(a)[ob[0]], y = docs.get(b)[ob[0]]; return (x < y ? -1 : x > y ? 1 : 0) * (ob[1] === "desc" ? -1 : 1); });
      if (lim) ps = ps.slice(0, lim);
      const d = ps.map(snapDoc); return { docs: d, size: d.length, empty: !d.length, metadata: meta(), docChanges: () => [] };
    };
    return {
      where: (k, op, v) => query(col, [...f, [k, op, v]], ob, lim), orderBy: (k, d = "asc") => query(col, f, [k, d], lim), limit: n => query(col, f, ob, n),
      get: async () => run(),
      onSnapshot(next) { let last = null; const l = () => { const r = run(); const sig = r.docs.map(x => x.id + ":" + JSON.stringify(docs.get(col + "/" + x.id))).join("|") + r.metadata.hasPendingWrites; if (sig !== last) { last = sig; next(r); } }; listeners.add(l); setTimeout(l, 0); return () => listeners.delete(l); },
      doc: id => docRef(col + "/" + (id || (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 20) : Math.random().toString(36).slice(2, 14)))),
      add: async d => { const r = query(col).doc(); await r.set(d); return r; }
    };
  }
  const db = { doc: docRef, collection: c => query(c) };

  /* ---------- backup ---------- */
  async function importBackup(obj) {
    const entries = Object.entries(obj.docs || obj);
    for (const [path, data] of entries) { if (typeof path === "string" && path.includes("/") && data && typeof data === "object") { docs.set(path, data); queue = queue.filter(q => q.path !== path); queue.push({ op: "set", path, data }); } }
    persist(); notify(); await flush(); return entries.length;
  }
  const exportBackup = () => ({ app: "conti", exportedAt: new Date().toISOString(), docs: Object.fromEntries(docs) });

  /* ---------- accesso ---------- */
  async function start(user) {
    uid = user.id;
    const cached = ls.get(cacheKey(), {}); docs.clear(); Object.entries(cached).forEach(([k, v]) => docs.set(k, v));
    queue = ls.get(queueKey(), []);
    window.__db = db;
    window.__cloud = { importBackup, exportBackup, signOut, email: user.email, onStatus: cb => { statusCb = cb; setStatus(); }, flush };
    window.__bootApp?.();
    if (navigator.onLine) { pullAll().catch(e => console.warn(e)); flush(); }
    subscribe();
  }
  async function signOut() { channel?.unsubscribe(); await sb.auth.signOut(); location.reload(); }

  window.addEventListener("online", () => { if (uid) { pullAll().catch(() => {}); flush(); } setStatus(); });
  window.addEventListener("offline", setStatus);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && uid && navigator.onLine) { pullAll().catch(() => {}); flush(); } });

  window.__auth = {
    async init(show) {
      sb.auth.onAuthStateChange((ev, session) => {
        if (ev === "PASSWORD_RECOVERY") { window.__onRecovery?.(); if (session?.user && !uid) start(session.user); return; }
        if (session?.user && !uid) { window.__showApp?.(); start(session.user); }
      });
      const { data } = await sb.auth.getSession();
      if (data.session?.user) { if (!uid) { window.__showApp?.(); start(data.session.user); } return; }
      show();
    },
    signIn: (email, password) => sb.auth.signInWithPassword({ email, password }),
    signUp: (email, password) => sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }),
    updatePassword: password => sb.auth.updateUser({ password }),
    reset: email => sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname })
  };
})();
