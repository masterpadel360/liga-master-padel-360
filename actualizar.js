/**
 * MASTER PÁDEL 360 — actualizar.js
 * =======================================================================
 * Hace que la app (también la agregada al inicio del celular, que no
 * tiene botón de recargar) se actualice sola cuando hay una versión nueva.
 *
 * Cómo funciona:
 *   - index.html define window.APP_VERSION (la versión que está corriendo).
 *   - version.json dice cuál es la última versión publicada.
 *   - Al abrir la app y cada vez que se vuelve a ella, se compara una con
 *     otra. Si hay una nueva, se recarga sola.
 *
 * Nunca recarga en mitad de algo: si la persona está reservando, subiendo
 * un comprobante, gestionando una reserva, en el panel de organizador o
 * escribiendo en un campo, espera a la próxima vez.
 *
 * AL PUBLICAR UN CAMBIO: subir la versión con  ./nueva-version.sh
 * (cambia APP_VERSION, los ?v= de index.html y version.json juntos).
 * =======================================================================
 */
(function () {
  var ACTUAL = String(window.APP_VERSION || '');
  var LS_RECARGA_ = 'mp360_recarga_version';
  var MIN_ENTRE_REVISIONES_MS_ = 60000;
  var ultimaRevision_ = 0;

  // Pantallas donde una recarga haría perder lo que la persona está haciendo.
  var PANTALLAS_OCUPADAS_ = { reservar: 1, 'buscar-reserva': 1, 'reserva-gestion': 1, 'admin-reservas': 1 };

  function versionPublicada_() {
    return fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return d && d.version ? String(d.version) : null; })
      .catch(function () { return null; });
  }

  function escribiendo_() {
    var a = document.activeElement;
    return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.value);
  }

  function urlNueva_(version, extra) {
    var u = new URL(location.href);
    u.searchParams.set('v', version);
    Object.keys(extra || {}).forEach(function (k) { u.searchParams.set(k, extra[k]); });
    return u.toString();
  }

  // Recarga automática: una sola vez por versión, para que nunca quede en
  // un bucle si algo no coincide.
  function recargarSola_(version) {
    try {
      if (sessionStorage.getItem(LS_RECARGA_) === version) return;
      sessionStorage.setItem(LS_RECARGA_, version);
    } catch (e) { /* sin storage: igual recarga */ }
    location.replace(urlNueva_(version));
  }

  function revisar_(alVolver) {
    if (!ACTUAL) return;
    var ahora = Date.now();
    if (alVolver && ahora - ultimaRevision_ < MIN_ENTRE_REVISIONES_MS_) return;
    ultimaRevision_ = ahora;
    versionPublicada_().then(function (v) {
      if (!v || v === ACTUAL) return;
      if (escribiendo_()) return;
      if (alVolver && PANTALLAS_OCUPADAS_[window.pantallaActual]) return;
      recargarSola_(v);
    });
  }

  // Botón "Actualizar" del panel: recarga siempre, haya o no versión nueva.
  window.mp360ActualizarApp = function (extra) {
    versionPublicada_().then(function (v) {
      var params = Object.assign({ t: String(Date.now()) }, extra || {});
      location.replace(urlNueva_(v || ACTUAL || 'x', params));
    });
  };

  // Al abrir la app.
  revisar_(false);
  // Al volver a la app (desde otra app, WhatsApp, la pantalla bloqueada…).
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') revisar_(true);
  });
  window.addEventListener('pageshow', function (e) { if (e && e.persisted) revisar_(true); });
})();
