/* Chargé dès le début de la page (avant les scripts de YouTube), dans le monde de l'extension.
 * Reçoit les morceaux de son copiés par page-hook.js et les met de côté jusqu'à ce que
 * refaudio.js soit prêt. Installé en premier, ce récepteur passe avant ceux de la page, qui
 * pourraient arrêter la propagation des messages. */
(function (root) {
  "use strict";
  if (root.__brvEarly) return;
  const early = root.__brvEarly = { queue: [], handler: null, bytes: 0 };
  root.addEventListener("message", (e) => {
    const m = e.data && e.data.__brv;
    // Firefox : le « global » d'un script de contenu n'est pas la fenêtre (e.source, elle, l'est)
    if (!m || (e.source !== root && e.source !== root.window)) return;
    if (early.handler) { early.handler(m); return; }
    early.queue.push(m);
    if (m.bytes) early.bytes += m.bytes.byteLength;
    while (early.bytes > 64e6 && early.queue.length) {       // garde-fou mémoire
      const d = early.queue.shift();
      if (d.bytes) early.bytes -= d.bytes.byteLength;
    }
  }, true);
})(typeof globalThis !== "undefined" ? globalThis : this);
