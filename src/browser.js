/* Accès aux API d'extension, identique sous Chrome (chrome.*) et Firefox (browser.*).
 *
 * Quand l'extension est rechargée alors que l'onglet reste ouvert, l'ancienne copie des scripts
 * encore présente dans la page perd l'accès au navigateur (« Extension context invalidated ») :
 * tous les appels deviennent alors sans effet, et alive() renvoie false pour qu'elle s'arrête. */
(function (root) {
  "use strict";
  const ext = root.browser && root.browser.runtime ? root.browser : root.chrome;
  const hasPromises = !!(root.browser && root.browser.runtime);
  let dead = false;

  function alive() {
    if (dead) return false;
    try { if (!ext || !ext.runtime || !ext.runtime.id) dead = true; } catch (e) { dead = true; }
    return !dead;
  }

  function call(getFn, ...args) {
    if (!alive()) return Promise.reject(new Error("extension rechargée"));
    try {
      const fn = getFn();
      if (hasPromises) return Promise.resolve(fn(...args));
      return new Promise((res, rej) => {
        try {
          fn(...args, (v) => {
            let err = null;
            try { err = ext.runtime.lastError; } catch (e) { err = e; }
            if (err) rej(new Error(err.message)); else res(v);
          });
        } catch (e) { rej(e); }
      });
    } catch (e) {
      if (/invalidated/i.test(String(e && e.message))) dead = true;
      return Promise.reject(e);
    }
  }

  root.BRVBrowser = {
    ext,
    alive,
    url: (p) => { try { return ext.runtime.getURL(p); } catch (e) { dead = true; return ""; } },
    storageGet: (defaults) => call(() => ext.storage.local.get.bind(ext.storage.local), defaults).catch(() => defaults),
    storageSet: (obj) => call(() => ext.storage.local.set.bind(ext.storage.local), obj).catch(() => {}),
    onStorage: (fn) => {
      try { ext.storage.onChanged.addListener((changes, area) => { if (area === "local" && alive()) fn(changes); }); }
      catch (e) { /* rien */ }
    },
    onMessage: (fn) => {
      try {
        ext.runtime.onMessage.addListener((msg, sender, reply) => {
          const r = fn(msg);
          if (r && typeof r.then === "function") { r.then(reply); return true; }
          if (r !== undefined) reply(r);
          return false;
        });
      } catch (e) { /* rien */ }
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
