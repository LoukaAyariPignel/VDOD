(function () {
  "use strict";
  const api = window.BRVBrowser;
  // chrome.* accepte les fonctions de rappel sous Chrome comme sous Firefox
  const ext = window.chrome && window.chrome.tabs ? window.chrome : api.ext;
  const $ = (id) => document.getElementById(id);

  api.storageGet({ enabled: true, manualKey: "" }).then((s) => {
    $("enabled").checked = s.enabled;
    $("key").value = s.manualKey || "";
  });
  $("enabled").addEventListener("change", (e) => api.storageSet({ enabled: e.target.checked }));
  $("key").addEventListener("input", (e) => {
    const v = e.target.value.trim().toUpperCase();
    const ok = v === "" || /^[A-Z0-9]{4,16}$/.test(v);
    e.target.classList.toggle("bad", !ok);
    if (ok) api.storageSet({ manualKey: v });
  });

  function row(dl, label, html, cls) {
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.innerHTML = html; if (cls) dd.className = cls;
    dl.append(dt, dd);
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function refresh() {
    const dl = $("info");
    let st = null;
    try {
      const tabs = await new Promise((r) => ext.tabs.query({ active: true, currentWindow: true }, r));
      if (tabs && tabs[0]) st = await new Promise((r) => ext.tabs.sendMessage(tabs[0].id, { type: "brv-status" }, (v) => {
        void ext.runtime.lastError; r(v);
      }));
    } catch (e) { st = null; }
    dl.innerHTML = "";
    if (!st || st.none) { row(dl, "État", "aucune vidéo sur cette page"); $("forget").hidden = true; return; }
    if (st.ad) row(dl, "État", "publicité : laissée intacte");
    else if (st.active) row(dl, "État", "décodage en cours", "ok");
    else if (st.key) row(dl, "État", "clé connue, décodage désactivé");
    else if (st.source === "aucune") row(dl, "État", "vidéo normale (pas de QR code BRV)");
    else row(dl, "État", "recherche du QR code…");
    if (st.key) row(dl, "Clé", `<code>${esc(st.key)}</code> (${esc(st.source)}, BRV${st.version})`);
    if (st.resolution) row(dl, "Image", `${esc(st.resolution)}${st.fps ? " — " + esc(st.fps) + " img/s" : ""}`);
    if (st.active || st.key) {
      row(dl, "Son", esc(st.audio), /débrouillé/.test(st.audio) ? "ok" : /BRV2|coupé|bloqu|cliquez|estimé/.test(st.audio) ? "warn" : "");
      const a = st.audioInfo || {};
      row(dl, "Détails", `${esc(a.path || "")} — contexte ${esc(a.context || "")} — ${esc(a.reference || "")}`);
      if (a.log && a.log.length) row(dl, "Journal", a.log.map(esc).join("<br>"));
    }
    if (st.previews) row(dl, "Aperçus", esc(st.previews));
    if (st.error) row(dl, "Problème", esc(st.error), "warn");
    $("forget").hidden = !(st.key && st.source !== "manuelle");
  }
  $("forget").addEventListener("click", async () => {
    const tabs = await new Promise((r) => ext.tabs.query({ active: true, currentWindow: true }, r));
    if (tabs[0]) ext.tabs.sendMessage(tabs[0].id, { type: "brv-forget" }, () => { void ext.runtime.lastError; setTimeout(refresh, 300); });
  });
  refresh();
  setInterval(refresh, 1000);
})();
