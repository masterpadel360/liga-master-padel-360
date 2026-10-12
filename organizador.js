/**
 * =======================================================================
 * LIGA MASTER PÁDEL 360 — Panel de organizador
 * =======================================================================
 * Reemplaza a la planilla de Google: reservas (aprobar, rechazar, pagos,
 * WhatsApp), agenda de canchas, resultados, parejas y fixture, horarios
 * (bloqueos, grilla semanal, precios) y contenido de la app.
 *
 * Usa el Worker de Cloudflare (BACKEND_URL de app.js). Se entra con la
 * contraseña de organizador; la sesión queda guardada 30 días en este
 * dispositivo (botón "Salir" para cerrarla).
 * =======================================================================
 */
(function () {
  'use strict';

  var LS_TOKEN = 'mp360_org_token';
  var TABS = [
    { id: 'inicio', tx: 'Inicio' },
    { id: 'reservas', tx: 'Reservas' },
    { id: 'agenda', tx: 'Agenda' },
    { id: 'resultados', tx: 'Resultados' },
    { id: 'parejas', tx: 'Parejas' },
    { id: 'horarios', tx: 'Horarios' },
    { id: 'contenido', tx: 'Contenido' },
  ];
  var DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  var EST_TX = { PENDIENTE_APROBACION: 'Pendiente', RESERVADO: 'Confirmada', RECHAZADO: 'Rechazada', CANCELADO: 'Cancelada', FINALIZADO: 'Jugada' };

  var st = {
    tab: 'inicio',
    filtroReservas: 'pendientes',
    busqueda: '',
    agendaDesde: null,
    catResultados: null,
    fechaAbierta: {},
    catParejas: null,
    editPareja: null,
    resumen: null,
  };
  var root = null;

  // ------------------------------------------------------------ util
  function $(sel) { return root.querySelector(sel); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function token() { try { return localStorage.getItem(LS_TOKEN) || ''; } catch (e) { return ''; } }
  function guardarToken(t) { try { localStorage.setItem(LS_TOKEN, t); } catch (e) {} }
  function borrarToken() { try { localStorage.removeItem(LS_TOKEN); } catch (e) {} }
  function plata(n) { return '$' + Number(n || 0).toLocaleString('es-AR'); }
  function fechaCorta(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return String(iso || '');
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return DIAS_CORTOS[d.getDay()] + ' ' + m[3] + '/' + m[2];
  }
  function hoyISO() {
    var d = new Date(Date.now() - 3 * 3600e3);
    return d.toISOString().slice(0, 10);
  }
  function sumarDias(iso, n) {
    var d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function telWa(tel) {
    var d = String(tel || '').replace(/\D/g, '');
    if (d.indexOf('54') === 0 && d.length > 11) d = d.slice(2);
    if (d.charAt(0) === '9' && d.length === 11) d = d.slice(1);
    if (d.charAt(0) === '0') d = d.slice(1);
    return '549' + d;
  }
  function linkWa(tel, texto) { return 'https://wa.me/' + telWa(tel) + '?text=' + encodeURIComponent(texto); }

  function toast(msg, tipo) {
    document.querySelectorAll('.org-toast').forEach(function (v) { v.remove(); });
    var t = document.createElement('div');
    t.className = 'org-toast' + (tipo === 'error' ? ' is-error' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, tipo === 'error' ? 4500 : 2600);
  }

  // ------------------------------------------------------------ API
  function api(accion, datos) {
    var cuerpo = Object.assign({ tokenAdmin: token() }, datos || {});
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);
    return fetch(BACKEND_URL + '?accion=' + encodeURIComponent(accion), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(cuerpo),
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (r) {
      clearTimeout(timer);
      return r.json();
    }, function () {
      clearTimeout(timer);
      throw new Error('No hay conexión con el servidor. Revisá internet y probá de nuevo.');
    }).then(function (p) {
      if (!p || !p.ok) {
        var msg = (p && p.error) || 'Error desconocido';
        if (/sesión de organizador venció|Contraseña de administrador incorrecta/.test(msg) && accion !== 'adminLogin') {
          borrarToken();
          pintarLogin('Tu sesión venció. Entrá de nuevo.');
        }
        throw new Error(msg);
      }
      return p.data;
    });
  }
  // Ejecuta una acción mostrando "…" en el botón y un aviso al terminar.
  function conBoton(btn, promesa, okMsg) {
    var original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    return promesa.then(function (d) {
      if (okMsg) toast(okMsg);
      return d;
    }).catch(function (e) {
      toast(e.message, 'error');
      throw e;
    }).finally(function () {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = original; }
    });
  }

  // ------------------------------------------------------------ imágenes
  function comprimir(file, ladoMax, tipo) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var e = Math.min(1, ladoMax / Math.max(img.naturalWidth, img.naturalHeight));
        var cv = document.createElement('canvas');
        cv.width = Math.round(img.naturalWidth * e); cv.height = Math.round(img.naturalHeight * e);
        var cx = cv.getContext('2d');
        if (tipo === 'image/jpeg') { cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); }
        cx.drawImage(img, 0, 0, cv.width, cv.height);
        resolve({ base64: cv.toDataURL(tipo, 0.82), mime: tipo });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('No se pudo abrir esa imagen.')); };
      img.src = url;
    });
  }
  function subirImagen(file, esLogo) {
    return comprimir(file, esLogo ? 600 : 1600, esLogo ? 'image/png' : 'image/jpeg').then(function (r) {
      return api('adminSubirArchivo', { base64: r.base64, mime: r.mime, nombre: file.name });
    });
  }

  // ------------------------------------------------------------ armazón
  function abrir() {
    root = document.getElementById('org-root');
    if (!root) return;
    if (typeof BACKEND_URL === 'undefined' || !BACKEND_URL) {
      root.innerHTML = '<div class="org-card"><h3>Panel en preparación</h3><p class="org-muted">El panel de organizador funciona cuando la app está conectada al servidor nuevo (Cloudflare). Mientras tanto, seguí usando la planilla.</p><a class="back-row" href="./">‹ Volver a la app</a></div>';
      return;
    }
    if (!token()) { pintarLogin(); return; }
    pintarMarco();
  }

  function pintarLogin(aviso) {
    root.innerHTML =
      '<div class="org-login org-card">' +
        '<h2>Panel de organizador</h2>' +
        '<p class="org-muted">Entrá con tu contraseña de organizador.</p>' +
        (aviso ? '<p class="rsv-error">' + esc(aviso) + '</p>' : '') +
        '<div class="rsv-field"><label for="orgClave">Contraseña</label>' +
        '<input type="password" id="orgClave" autocomplete="current-password" placeholder="••••••••"></div>' +
        '<p class="rsv-error" id="orgLoginErr" hidden></p>' +
        '<button class="doc-card-btn org-btn-full" id="orgEntrar" type="button">Entrar</button>' +
        '<a class="back-row" href="./">‹ Volver a la app</a>' +
      '</div>';
    var input = $('#orgClave'), btn = $('#orgEntrar');
    function entrar() {
      var err = $('#orgLoginErr');
      err.hidden = true;
      if (!input.value) { err.hidden = false; err.textContent = 'Escribí la contraseña.'; return; }
      btn.disabled = true; btn.textContent = 'Entrando…';
      api('adminLogin', { clave: input.value }).then(function (d) {
        guardarToken(d.tokenAdmin);
        pintarMarco();
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = 'Entrar';
        err.hidden = false; err.textContent = e.message;
      });
    }
    btn.addEventListener('click', entrar);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') entrar(); });
    setTimeout(function () { input.focus(); }, 50);
  }

  function pintarMarco() {
    root.innerHTML =
      '<div class="org-top">' +
        '<a class="back-row" href="./">‹ Ir a la app</a>' +
        '<button class="org-link" data-org="salir" type="button">Salir</button>' +
      '</div>' +
      '<nav class="org-tabs" id="orgTabs">' + TABS.map(function (t) {
        return '<button class="chip" data-org-tab="' + t.id + '" type="button">' + t.tx + '<span class="org-badge" data-badge="' + t.id + '" hidden></span></button>';
      }).join('') + '</nav>' +
      '<div id="orgVista"></div>';
    root.onclick = manejarClick;
    root.onchange = manejarCambio;
    irTab(st.tab);
  }

  function irTab(tab) {
    st.tab = tab;
    root.querySelectorAll('[data-org-tab]').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-org-tab') === tab); });
    var activo = root.querySelector('[data-org-tab="' + tab + '"]');
    if (activo && activo.scrollIntoView) activo.scrollIntoView({ block: 'nearest', inline: 'center' });
    var v = $('#orgVista');
    v.innerHTML = '<div class="state-loading">Cargando…</div>';
    ({ inicio: vInicio, reservas: vReservas, agenda: vAgenda, resultados: vResultados, parejas: vParejas, horarios: vHorarios, contenido: vContenido })[tab]();
  }
  function vista() { return $('#orgVista'); }
  function errorVista(e) { vista().innerHTML = '<p class="state-empty">' + esc(e.message) + '</p><button class="rsv-copy-btn" data-org="recargar" type="button">Reintentar</button>'; }
  function actualizarBadge(n) {
    var b = root && root.querySelector('[data-badge="reservas"]');
    if (!b) return;
    b.hidden = !n;
    b.textContent = n;
  }

  // ============================================================ INICIO
  function vInicio() {
    api('adminResumen').then(function (d) {
      st.resumen = d;
      actualizarBadge(d.pendientes);
      var fechas = d.categorias.map(function (c) { return c.fechaEnJuego; }).filter(function (x) { return x; });
      var fechaComun = fechas.length && fechas.every(function (x) { return x === fechas[0]; }) ? fechas[0] : '';
      vista().innerHTML =
        '<div class="org-stats">' +
          '<button class="org-stat' + (d.pendientes ? ' is-alert' : '') + '" data-org="ir-pendientes" type="button"><b>' + d.pendientes + '</b><span>Reservas para aprobar</span></button>' +
          '<button class="org-stat" data-org="ir-proximas" type="button"><b>' + d.proximas + '</b><span>Turnos confirmados por jugar</span></button>' +
        '</div>' +
        '<div class="org-card">' +
          '<h3>Fecha en juego</h3>' +
          '<p class="org-muted">Hasta qué fecha del fixture pueden reservar los jugadores (incluye partidos atrasados).</p>' +
          '<div class="org-row"><input type="number" min="1" class="org-input org-num" id="orgFejTodas" value="' + esc(fechaComun) + '" placeholder="N°">' +
          '<button class="rsv-btn-aprobar" data-org="fej-todas" type="button">Aplicar a todas</button></div>' +
        '</div>' +
        '<div class="org-card"><h3>Categorías</h3>' +
          '<div class="org-table">' + d.categorias.map(function (c) {
            var pct = c.partidos ? Math.round(100 * c.jugados / c.partidos) : 0;
            return '<div class="org-cat-row">' +
              '<div><b>' + esc(c.nombre) + '</b><span class="org-muted">' + c.parejasActivas + ' parejas · ' + c.jugados + '/' + c.partidos + ' partidos jugados</span>' +
              '<div class="org-bar"><i style="width:' + pct + '%"></i></div></div>' +
              '<label class="org-fej">Fecha<input type="number" min="1" class="org-input org-num" data-fej-cat="' + esc(c.nombre) + '" value="' + esc(c.fechaEnJuego == null ? '' : c.fechaEnJuego) + '"></label>' +
            '</div>';
          }).join('') + '</div>' +
        '</div>';
    }).catch(errorVista);
  }

  // ============================================================ RESERVAS
  function vReservas() {
    var f = st.filtroReservas;
    var cab =
      '<div class="org-subtabs">' +
        [['pendientes', 'Para aprobar'], ['proximas', 'Confirmadas'], ['historial', 'Historial']].map(function (x) {
          return '<button class="chip' + (f === x[0] ? ' active' : '') + '" data-org-filtro="' + x[0] + '" type="button">' + x[1] + '</button>';
        }).join('') +
      '</div>' +
      (f === 'historial' ? '<div class="org-row"><input class="org-input" id="orgBuscar" placeholder="Buscar nombre, pareja, teléfono o código" value="' + esc(st.busqueda) + '"><button class="rsv-copy-btn" data-org="buscar" type="button">Buscar</button></div>' : '') +
      '<div id="orgListaRes"><div class="state-loading">Cargando…</div></div>';
    vista().innerHTML = cab;
    api('adminReservas', { filtro: f, q: st.busqueda }).then(function (lista) {
      if (f === 'pendientes') actualizarBadge(lista.length);
      var cont = $('#orgListaRes');
      if (!lista.length) {
        cont.innerHTML = '<p class="state-empty">' + ({ pendientes: 'No hay reservas para aprobar. 🙌', proximas: 'No hay turnos confirmados por jugar.', historial: 'No se encontraron reservas.' })[f] + '</p>';
        return;
      }
      cont.innerHTML = lista.map(tarjetaReserva).join('');
    }).catch(errorVista);
  }

  function mensajeWa(r, tipo) {
    var base = r.categoria + ': ' + r.parejaA + ' vs ' + r.parejaB + '\n📅 ' + fechaCorta(r.fecha) + ' · ' + r.horarioInicio + ' a ' + r.horarioFin + (r.cancha ? '\n🎾 Cancha ' + r.cancha : '');
    var nombre = (r.nombreSolicitante || '').split(' ')[0];
    if (tipo === 'aprobada') return '¡Hola ' + nombre + '! Tu reserva de la Liga Master Pádel 360 quedó CONFIRMADA ✅\n\n' + base + '\nCódigo: ' + r.codigoReserva + '\n\nSaldo a abonar en el club: ' + plata(r.saldoPendiente) + '. ¡Nos vemos en la cancha!';
    if (tipo === 'rechazada') return 'Hola ' + nombre + ', no pudimos confirmar tu solicitud de reserva de la Liga Master Pádel 360:\n\n' + base + '\n\nEl horario quedó libre otra vez. Escribime así lo resolvemos.';
    return 'Hola ' + nombre + '! Te recuerdo tu partido de la Liga Master Pádel 360 🎾\n\n' + base + (r.estadoPago !== 'PAGO_COMPLETO' ? '\nSaldo pendiente: ' + plata(r.saldoPendiente) : '') + '\n\n¡Éxitos!';
  }

  function tarjetaReserva(r) {
    var e = r.estadoReserva;
    var pagoTx = r.estadoPago === 'PAGO_COMPLETO' ? 'Pago completo' : 'Falta ' + plata(r.saldoPendiente);
    var acciones = '';
    if (e === 'PENDIENTE_APROBACION') {
      acciones =
        '<button class="rsv-btn-ghost" data-org="rechazar" data-id="' + esc(r.idReserva) + '" type="button">Rechazar</button>' +
        '<button class="rsv-btn-aprobar" data-org="aprobar" data-id="' + esc(r.idReserva) + '" type="button">Aprobar</button>';
    } else if (e === 'RESERVADO') {
      acciones =
        (r.estadoPago === 'PAGO_COMPLETO'
          ? '<button class="rsv-btn-ghost" data-org="pago" data-completo="0" data-id="' + esc(r.idReserva) + '" type="button">Deshacer pago</button>'
          : '<button class="rsv-btn-aprobar" data-org="pago" data-completo="1" data-id="' + esc(r.idReserva) + '" type="button">Saldo pagado</button>') +
        '<a class="rsv-btn-ghost org-wa" href="' + esc(linkWa(r.telefonoSolicitante, mensajeWa(r, 'recordatorio'))) + '" target="_blank" rel="noopener">WhatsApp</a>';
    }
    return '<div class="admin-card org-res org-est-' + e + '" data-res-card="' + esc(r.idReserva) + '" data-res=\'' + esc(JSON.stringify(r)) + '\'>' +
      '<div class="org-res-head"><span class="org-pill">' + esc(EST_TX[e] || e) + '</span><span class="org-muted">' + esc(r.idReserva) + ' · ' + esc(r.codigoReserva) + '</span></div>' +
      '<div class="org-res-cruce">' + esc(r.parejaA) + ' <span class="org-muted">vs</span> ' + esc(r.parejaB) + '</div>' +
      '<div class="org-res-meta"><span>' + esc(r.categoria) + '</span><span>📅 ' + esc(fechaCorta(r.fecha)) + ' ' + esc(r.horarioInicio) + '–' + esc(r.horarioFin) + '</span><span>Cancha ' + esc(r.cancha) + '</span></div>' +
      '<div class="org-res-meta"><span>👤 ' + esc(r.nombreSolicitante) + '</span><a href="tel:' + esc(r.telefonoSolicitante) + '">📞 ' + esc(r.telefonoSolicitante) + '</a>' +
        (e === 'RESERVADO' || e === 'FINALIZADO' ? '<span>' + esc(pagoTx) + '</span>' : '<span>Seña ' + plata(r.montoPagado) + '</span>') + '</div>' +
      (r.comprobanteUrl ? '<a class="admin-comprobante-link" href="' + esc(r.comprobanteUrl) + '" target="_blank" rel="noopener">Ver comprobante</a>' : '<span class="hint-line">Sin comprobante</span>') +
      (acciones ? '<div class="admin-card-actions">' + acciones + '</div>' : '') +
      (e === 'RESERVADO' ? '<button class="org-link org-danger" data-org="cancelar-res" data-id="' + esc(r.idReserva) + '" type="button">Cancelar turno</button>' : '') +
      '<div class="org-tras" hidden></div>' +
    '</div>';
  }

  function datosTarjeta(el) {
    var card = el.closest('[data-res-card]');
    try { return { card: card, r: JSON.parse(card.getAttribute('data-res')) }; } catch (e) { return { card: card, r: null }; }
  }

  function accionReserva(el, accion) {
    var x = datosTarjeta(el), id = el.getAttribute('data-id');
    if (accion === 'rechazar' && !confirm('¿Rechazar la reserva ' + id + '? El horario y el cruce quedan libres.')) return;
    var nombreAccion = accion === 'aprobar' ? 'aprobarReserva' : 'rechazarReserva';
    conBoton(el, api(nombreAccion, { idReserva: id }), accion === 'aprobar' ? 'Reserva aprobada ✅' : 'Reserva rechazada').then(function () {
      var r = x.r || {};
      var tras = x.card.querySelector('.org-tras');
      x.card.querySelectorAll('.admin-card-actions, .admin-comprobante-link').forEach(function (n) { n.remove(); });
      x.card.querySelector('.org-pill').textContent = accion === 'aprobar' ? 'Confirmada' : 'Rechazada';
      x.card.classList.add('is-hecha');
      tras.hidden = false;
      tras.innerHTML = '<a class="rsv-btn-aprobar org-wa org-btn-full" href="' + esc(linkWa(r.telefonoSolicitante, mensajeWa(r, accion === 'aprobar' ? 'aprobada' : 'rechazada'))) + '" target="_blank" rel="noopener">Avisar por WhatsApp a ' + esc((r.nombreSolicitante || '').split(' ')[0]) + '</a>';
      var b = root.querySelector('[data-badge="reservas"]');
      if (b && Number(b.textContent) > 0) actualizarBadge(Number(b.textContent) - 1);
    }).catch(function () {});
  }

  // ============================================================ AGENDA
  function vAgenda() {
    if (!st.agendaDesde) st.agendaDesde = hoyISO();
    api('adminAgenda', { desde: st.agendaDesde, dias: 7 }).then(function (d) {
      var html =
        '<div class="org-row org-nav-sem">' +
          '<button class="rsv-copy-btn" data-org="sem-prev" type="button">‹</button>' +
          '<b>' + esc(fechaCorta(d.desde)) + ' al ' + esc(fechaCorta(d.hasta)) + '</b>' +
          '<button class="rsv-copy-btn" data-org="sem-next" type="button">›</button>' +
          (d.desde !== hoyISO() ? '<button class="org-link" data-org="sem-hoy" type="button">Hoy</button>' : '') +
        '</div>';
      html += d.dias.map(function (dia) {
        var hayAlgo = dia.franjas.length || dia.otras.length || dia.bloqueos.length;
        if (!hayAlgo) return '<div class="org-dia is-vacio"><h3>' + esc(dia.diaSemana) + ' ' + esc(fechaCorta(dia.fecha).slice(4)) + '</h3><p class="org-muted">Sin turnos de liga.</p></div>';
        return '<div class="org-dia"><h3>' + esc(dia.diaSemana) + ' ' + esc(fechaCorta(dia.fecha).slice(4)) + '</h3>' +
          dia.franjas.map(function (fr) {
            return '<div class="org-franja">' +
              '<div class="org-franja-head"><b>' + fr.inicio + '–' + fr.fin + '</b><span class="org-libres' + (fr.libres ? '' : ' is-lleno') + '">' + (fr.libres ? fr.libres + ' libre' + (fr.libres > 1 ? 's' : '') : 'Completo') + ' / ' + fr.canchas + '</span>' +
              '<button class="org-link" data-org="bloquear-franja" data-fecha="' + dia.fecha + '" data-ini="' + fr.inicio + '" data-fin="' + fr.fin + '" type="button">Bloquear</button></div>' +
              fr.reservas.map(lineaAgenda).join('') +
              fr.bloqueos.map(lineaBloqueo).join('') +
            '</div>';
          }).join('') +
          (dia.otras.length ? '<div class="org-franja"><div class="org-franja-head"><b>Fuera de grilla</b></div>' + dia.otras.map(lineaAgenda).join('') + '</div>' : '') +
          dia.bloqueos.filter(function (b) { return !dia.franjas.some(function (fr) { return fr.bloqueos.some(function (x) { return x.id === b.id; }); }); }).map(lineaBloqueo).join('') +
        '</div>';
      }).join('');
      vista().innerHTML = html;
    }).catch(errorVista);
  }
  function lineaAgenda(r) {
    return '<div class="org-ag-linea org-est-' + r.estadoReserva + '">' +
      '<span class="org-cancha">C' + esc(r.cancha) + '</span>' +
      '<span class="org-ag-tx"><b>' + esc(r.parejaA) + ' vs ' + esc(r.parejaB) + '</b><span class="org-muted">' + esc(r.categoria) + ' · ' + esc(r.horarioInicio) + ' · ' + esc(EST_TX[r.estadoReserva]) + (r.estadoPago === 'PAGO_COMPLETO' ? ' · Pagado' : '') + '</span></span>' +
      '<a class="org-link" href="' + esc(linkWa(r.telefonoSolicitante, mensajeWa(r, 'recordatorio'))) + '" target="_blank" rel="noopener" title="WhatsApp">💬</a>' +
    '</div>';
  }
  function lineaBloqueo(b) {
    return '<div class="org-ag-linea is-bloqueo"><span class="org-cancha">' + (b.cancha === 'TODAS' ? 'Todas' : 'C' + esc(b.cancha)) + '</span>' +
      '<span class="org-ag-tx"><b>Bloqueado ' + esc(b.horaInicio) + '–' + esc(b.horaFin) + '</b><span class="org-muted">' + esc(b.motivo || 'Sin motivo') + '</span></span>' +
      '<button class="org-link org-danger" data-org="borrar-bloqueo" data-id="' + esc(b.id) + '" type="button">Quitar</button></div>';
  }

  // ============================================================ RESULTADOS
  function vResultados() {
    obtenerCategorias().then(function (cats) {
      if (!st.catResultados || cats.indexOf(st.catResultados) === -1) st.catResultados = cats[0];
      var cab = '<div class="org-subtabs">' + cats.map(function (c) {
        return '<button class="chip' + (c === st.catResultados ? ' active' : '') + '" data-org-catres="' + esc(c) + '" type="button">' + esc(c) + '</button>';
      }).join('') + '</div><div id="orgPartidos"><div class="state-loading">Cargando…</div></div>';
      vista().innerHTML = cab;
      return api('adminPartidos', { categoria: st.catResultados }).then(pintarPartidos);
    }).catch(errorVista);
  }
  function obtenerCategorias() {
    if (st.resumen) return Promise.resolve(st.resumen.categorias.map(function (c) { return c.nombre; }));
    return api('adminResumen').then(function (d) { st.resumen = d; return d.categorias.map(function (c) { return c.nombre; }); });
  }
  function pintarPartidos(d) {
    var porFecha = {};
    var orden = [];
    d.partidos.forEach(function (p) { if (!porFecha[p.fecha]) { porFecha[p.fecha] = []; orden.push(p.fecha); } porFecha[p.fecha].push(p); });
    var abierta = st.fechaAbierta[d.categoria] || d.fechaEnJuego || orden[orden.length - 1];
    var html =
      '<div class="org-card org-row">' +
        '<label class="org-fej">Fecha en juego<input type="number" min="1" class="org-input org-num" data-fej-cat="' + esc(d.categoria) + '" value="' + esc(d.fechaEnJuego == null ? '' : d.fechaEnJuego) + '"></label>' +
        '<span class="org-muted">Los jugadores pueden reservar partidos hasta esta fecha.</span>' +
      '</div>';
    if (!orden.length) {
      html += '<p class="state-empty">Esta categoría todavía no tiene fixture. Generalo desde la pestaña Parejas.</p>';
    }
    html += orden.map(function (n) {
      var lista = porFecha[n];
      var jugados = lista.filter(function (p) { return p.estado === 'JUGADO'; }).length;
      return '<details class="org-fecha"' + (Number(n) === Number(abierta) ? ' open' : '') + ' data-fecha-num="' + n + '">' +
        '<summary><b>Fecha ' + n + '</b><span class="org-muted">' + jugados + '/' + lista.length + ' jugados</span>' + (Number(n) === Number(d.fechaEnJuego) ? '<span class="org-pill">En juego</span>' : '') + '</summary>' +
        lista.map(filaPartido).join('') +
      '</details>';
    }).join('');
    $('#orgPartidos').innerHTML = html;
  }
  function filaPartido(p) {
    var gana = function (id) { return p.estado === 'JUGADO' && p.ganadorId === id ? ' is-ganador' : ''; };
    return '<div class="org-partido" data-partido="' + esc(p.idPartido) + '">' +
      '<div class="org-partido-parejas">' +
        '<span class="' + gana(p.parejaAId) + '">' + esc(p.parejaA) + '</span>' +
        '<span class="' + gana(p.parejaBId) + '">' + esc(p.parejaB) + '</span>' +
      '</div>' +
      '<div class="org-sets">' +
        [1, 2, 3].map(function (i) {
          return '<input class="org-input org-set" inputmode="numeric" data-set="' + i + '" value="' + esc(p['set' + i]) + '" placeholder="' + (i === 3 ? 'STB' : 'Set ' + i) + '" aria-label="Set ' + i + '">';
        }).join('') +
        '<button class="rsv-btn-aprobar org-guardar-set" data-org="guardar-resultado" type="button">Guardar</button>' +
      '</div>' +
      (p.reserva ? '<div class="org-muted org-mini">Reserva: ' + esc(fechaCorta(p.reserva.fecha)) + ' ' + esc(p.reserva.horarioInicio) + ' · Cancha ' + esc(p.reserva.cancha) + ' · ' + esc(EST_TX[p.reserva.estado]) + '</div>' : '') +
    '</div>';
  }

  // ============================================================ PAREJAS
  function vParejas() {
    api('adminParejas').then(function (d) {
      var cats = d.categorias;
      if (!st.catParejas || cats.indexOf(st.catParejas) === -1) st.catParejas = cats[0];
      var lista = d.parejas.filter(function (p) { return p.categoria === st.catParejas; });
      var activas = lista.filter(function (p) { return p.estado === 'ACTIVA'; }).length;
      var opciones = function (sel) { return cats.map(function (c) { return '<option' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join(''); };
      var ed = st.editPareja;
      vista().innerHTML =
        '<div class="org-subtabs">' + cats.map(function (c) {
          return '<button class="chip' + (c === st.catParejas ? ' active' : '') + '" data-org-catpar="' + esc(c) + '" type="button">' + esc(c) + '</button>';
        }).join('') + '</div>' +
        '<div class="org-card" id="orgFormPareja">' +
          '<h3>' + (ed ? 'Editar pareja ' + esc(ed.id) : 'Agregar pareja') + '</h3>' +
          '<div class="org-grid2">' +
            '<input class="org-input" id="pj1" placeholder="Jugador 1" value="' + esc(ed ? ed.jugador1 : '') + '">' +
            '<input class="org-input" id="pj2" placeholder="Jugador 2" value="' + esc(ed ? ed.jugador2 : '') + '">' +
            '<select class="org-input" id="pcat">' + opciones(ed ? ed.categoria : st.catParejas) + '</select>' +
            '<select class="org-input" id="pest"><option value="ACTIVA">Activa</option><option value="BAJA"' + (ed && ed.estado === 'BAJA' ? ' selected' : '') + '>De baja</option></select>' +
          '</div>' +
          '<div class="org-row">' +
            '<button class="rsv-btn-aprobar" data-org="guardar-pareja" type="button">' + (ed ? 'Guardar cambios' : 'Agregar') + '</button>' +
            (ed ? '<button class="rsv-btn-ghost" data-org="cancelar-edicion" type="button">Cancelar</button>' : '') +
          '</div>' +
        '</div>' +
        '<div class="org-card">' +
          '<div class="org-row org-spread"><h3>' + esc(st.catParejas) + ' · ' + activas + ' activas</h3>' +
          '<button class="rsv-copy-btn" data-org="generar-fixture" type="button">Generar fixture</button></div>' +
          (lista.length ? lista.map(function (p) {
            return '<div class="org-pareja' + (p.estado === 'BAJA' ? ' is-baja' : '') + '">' +
              '<span class="org-muted">' + esc(p.id) + '</span>' +
              '<span class="org-pareja-tx">' + esc(p.jugador1) + ' / ' + esc(p.jugador2) + (p.estado === 'BAJA' ? ' <em>(baja)</em>' : '') + '</span>' +
              '<button class="org-link" data-org="editar-pareja" data-pareja=\'' + esc(JSON.stringify(p)) + '\' type="button">Editar</button>' +
            '</div>';
          }).join('') : '<p class="state-empty">Sin parejas en esta categoría.</p>') +
        '</div>' +
        '<div class="org-card"><h3>Categorías</h3>' +
          '<div class="org-row"><input class="org-input" id="nuevaCat" placeholder="Nueva categoría (ej: 5ta Masculino)">' +
          '<button class="rsv-copy-btn" data-org="crear-cat" type="button">Crear</button></div>' +
          '<div class="org-row org-wrap">' + cats.map(function (c) {
            return '<span class="org-tag">' + esc(c) + ' <button class="org-link org-danger" data-org="borrar-cat" data-cat="' + esc(c) + '" type="button" title="Eliminar">✕</button></span>';
          }).join('') + '</div>' +
          '<p class="org-muted org-mini">Solo se puede eliminar una categoría vacía (sin parejas ni partidos).</p>' +
        '</div>';
    }).catch(errorVista);
  }

  // ============================================================ HORARIOS
  function vHorarios() {
    Promise.all([api('adminBloqueos'), api('adminGrilla'), api('adminResumen')]).then(function (r) {
      var bloqueos = r[0], grilla = r[1], cfg = r[2].config;
      st.resumen = r[2];
      var opcCancha = '<option value="TODAS">Todas las canchas</option>' + Array.from({ length: cfg.cantidadCanchas }, function (_, i) { return '<option value="' + (i + 1) + '">Cancha ' + (i + 1) + '</option>'; }).join('');
      vista().innerHTML =
        '<div class="org-card"><h3>Bloquear un horario</h3>' +
          '<p class="org-muted">Para clases, torneos o cualquier día que una cancha no esté para la liga.</p>' +
          '<div class="org-grid2">' +
            '<label>Día<input type="date" class="org-input" id="bFecha" value="' + hoyISO() + '"></label>' +
            '<label>Cancha<select class="org-input" id="bCancha">' + opcCancha + '</select></label>' +
            '<label>Desde<input type="time" class="org-input" id="bIni" value="18:00"></label>' +
            '<label>Hasta<input type="time" class="org-input" id="bFin" value="19:30"></label>' +
          '</div>' +
          '<input class="org-input" id="bMotivo" placeholder="Motivo (ej: Clase Gabriel)">' +
          '<button class="rsv-btn-aprobar" data-org="crear-bloqueo" type="button">Bloquear</button>' +
          '<h4>Próximos bloqueos</h4>' +
          (bloqueos.length ? bloqueos.map(function (b) {
            return '<div class="org-ag-linea is-bloqueo"><span class="org-cancha">' + (b.cancha === 'TODAS' ? 'Todas' : 'C' + esc(b.cancha)) + '</span>' +
              '<span class="org-ag-tx"><b>' + esc(fechaCorta(b.fecha)) + ' · ' + esc(b.horaInicio) + '–' + esc(b.horaFin) + '</b><span class="org-muted">' + esc(b.motivo) + '</span></span>' +
              '<button class="org-link org-danger" data-org="borrar-bloqueo" data-id="' + esc(b.id) + '" type="button">Quitar</button></div>';
          }).join('') : '<p class="org-muted">No hay bloqueos cargados.</p>') +
        '</div>' +
        '<div class="org-card"><h3>Turnos de cada día</h3>' +
          '<p class="org-muted">Los horarios que se ofrecen para reservar y cuántas canchas hay para la liga en cada uno. Si cambian las clases de los profes, ajustalo acá.</p>' +
          '<div id="orgGrilla">' + grilla.dias.map(function (dia) {
            return '<div class="org-gdia" data-gdia="' + dia.dia + '"><div class="org-row org-spread"><b>' + esc(dia.nombre) + '</b><button class="org-link" data-org="g-agregar" type="button">+ turno</button></div>' +
              dia.franjas.map(filaGrilla).join('') + '</div>';
          }).join('') + '</div>' +
          '<button class="rsv-btn-aprobar org-btn-full" data-org="guardar-grilla" type="button">Guardar turnos</button>' +
        '</div>' +
        '<div class="org-card"><h3>Precios y reglas</h3>' +
          '<div class="org-grid2">' +
            campoCfg('valor_turno', 'Valor del turno ($)', cfg.valorTurno, 'number') +
            campoCfg('monto_sena', 'Seña ($)', cfg.montoSena, 'number') +
            campoCfg('alias', 'Alias para transferir', cfg.alias, 'text') +
            campoCfg('cantidad_canchas', 'Canchas del club', cfg.cantidadCanchas, 'number') +
            campoCfg('ventana_dias', 'Se puede reservar hasta (días)', cfg.ventanaDias, 'number') +
            campoCfg('retencion_minutos', 'Minutos para subir comprobante', cfg.retencionMinutos, 'number') +
          '</div>' +
          '<button class="rsv-btn-aprobar" data-org="guardar-config" type="button">Guardar</button>' +
          '<p class="org-muted org-mini">El precio nuevo se aplica a las reservas que se hagan desde ahora.</p>' +
        '</div>';
    }).catch(errorVista);
  }
  function filaGrilla(f) {
    return '<div class="org-gfila"><input type="time" class="org-input" data-g="inicio" value="' + esc(f.inicio || '') + '">' +
      '<span>a</span><input type="time" class="org-input" data-g="fin" value="' + esc(f.fin || '') + '">' +
      '<input type="number" min="1" class="org-input org-num" data-g="canchas" value="' + esc(f.canchas || 2) + '" title="Canchas"><span class="org-muted">canchas</span>' +
      '<button class="org-link org-danger" data-org="g-quitar" type="button" title="Quitar">✕</button></div>';
  }
  function campoCfg(clave, etiqueta, valor, tipo) {
    return '<label>' + esc(etiqueta) + '<input class="org-input" type="' + tipo + '" data-cfg="' + clave + '" value="' + esc(valor) + '"></label>';
  }

  // ============================================================ CONTENIDO
  function vContenido() {
    api('adminContenido').then(function (d) {
      var novedades = d.contenido.filter(function (x) { return x.tipo === 'NOVEDAD'; });
      var premios = d.contenido.filter(function (x) { return x.tipo.indexOf('PREMIO') === 0; });
      vista().innerHTML =
        bloqueTextos('NOVEDAD', 'Novedades de Inicio', 'Los avisos que ven todos al entrar a la app.', novedades) +
        bloqueTextos('PREMIOS', 'Premios', 'Lo que se muestra en Más → Premios.', premios) +
        '<div class="org-card"><h3>Playoffs</h3><p class="org-muted">Mensaje de la pantalla Más → Playoffs.</p>' +
          '<textarea class="org-input" id="playoffsTx" rows="3">' + esc(d.playoffsMensaje) + '</textarea>' +
          '<button class="rsv-btn-aprobar" data-org="guardar-playoffs" type="button">Guardar</button></div>' +
        '<div class="org-card"><h3>Sponsors</h3>' +
          d.sponsors.map(function (s) {
            return '<div class="org-item" data-sponsor=\'' + esc(JSON.stringify(s)) + '\'>' +
              (s.logoUrlVista ? '<img class="org-logo" src="' + esc(s.logoUrlVista) + '" alt="">' : '<span class="org-logo org-logo-vacio">Sin logo</span>') +
              '<span class="org-item-tx"><b>' + esc(s.nombre) + '</b>' + (s.destacado ? '<span class="org-pill">Destacado</span>' : '') + (s.activo ? '' : '<span class="org-muted"> (oculto)</span>') + '</span>' +
              '<button class="org-link" data-org="editar-sponsor" type="button">Editar</button>' +
              '<button class="org-link org-danger" data-org="borrar-sponsor" data-id="' + s.id + '" type="button">✕</button>' +
            '</div>';
          }).join('') +
          '<div class="org-subform" id="formSponsor">' +
            '<h4 id="formSponsorTit">Agregar sponsor</h4>' +
            '<input type="hidden" id="spId">' +
            '<input class="org-input" id="spNombre" placeholder="Nombre">' +
            '<input class="org-input" id="spLink" placeholder="Link (Instagram o web)">' +
            '<label class="org-file">Logo<input type="file" accept="image/*" id="spLogoFile"></label>' +
            '<input type="hidden" id="spLogo">' +
            '<div class="org-row"><label class="org-check"><input type="checkbox" id="spDest"> Destacado</label>' +
            '<label class="org-check"><input type="checkbox" id="spActivo" checked> Visible</label>' +
            '<input type="number" class="org-input org-num" id="spOrden" placeholder="Orden"></div>' +
            '<button class="rsv-btn-aprobar" data-org="guardar-sponsor" type="button">Guardar sponsor</button>' +
          '</div>' +
        '</div>' +
        '<div class="org-card"><h3>Galería de fotos</h3>' +
          '<div class="org-grid2"><input class="org-input" id="fotoEtiqueta" placeholder="Etiqueta (ej: Fecha 5)"><input class="org-input" id="fotoTitulo" placeholder="Título (opcional)"></div>' +
          '<label class="org-file org-btn-full">Subir fotos<input type="file" accept="image/*" multiple id="fotoFiles"></label>' +
          '<div class="org-fotos">' + d.fotos.map(function (f) {
            return '<div class="org-foto"><img src="' + esc(f.urlVista) + '" alt="" loading="lazy"><span>' + esc(f.categoria || f.titulo) + '</span>' +
              '<button class="org-link org-danger" data-org="borrar-foto" data-id="' + f.id + '" type="button">✕</button></div>';
          }).join('') + '</div>' +
        '</div>';
    }).catch(errorVista);
  }
  function bloqueTextos(tipo, titulo, ayuda, items) {
    return '<div class="org-card" data-bloque-tipo="' + tipo + '"><h3>' + esc(titulo) + '</h3><p class="org-muted">' + esc(ayuda) + '</p>' +
      items.map(function (x) {
        return '<div class="org-texto" data-cont-id="' + x.id + '">' +
          '<input class="org-input" data-c="titulo" value="' + esc(x.titulo) + '" placeholder="Título">' +
          '<textarea class="org-input" data-c="texto" rows="2" placeholder="Texto">' + esc(x.texto) + '</textarea>' +
          '<div class="org-row"><label class="org-check"><input type="checkbox" data-c="activo"' + (x.activo ? ' checked' : '') + '> Visible</label>' +
          '<input type="number" class="org-input org-num" data-c="orden" value="' + esc(x.orden) + '" title="Orden">' +
          '<button class="rsv-btn-aprobar" data-org="guardar-texto" type="button">Guardar</button>' +
          '<button class="org-link org-danger" data-org="borrar-texto" type="button">Eliminar</button></div>' +
        '</div>';
      }).join('') +
      '<button class="rsv-copy-btn" data-org="nuevo-texto" type="button">+ Agregar</button>' +
    '</div>';
  }

  // ============================================================ EVENTOS
  function manejarClick(e) {
    var tab = e.target.closest('[data-org-tab]');
    if (tab) { irTab(tab.getAttribute('data-org-tab')); return; }
    var f = e.target.closest('[data-org-filtro]');
    if (f) { st.filtroReservas = f.getAttribute('data-org-filtro'); vReservas(); return; }
    var cr = e.target.closest('[data-org-catres]');
    if (cr) { st.catResultados = cr.getAttribute('data-org-catres'); vResultados(); return; }
    var cp = e.target.closest('[data-org-catpar]');
    if (cp) { st.catParejas = cp.getAttribute('data-org-catpar'); st.editPareja = null; vParejas(); return; }
    var el = e.target.closest('[data-org]');
    if (!el) return;
    var a = el.getAttribute('data-org');
    var H = HANDLERS[a];
    if (H) H(el, e);
  }

  var HANDLERS = {
    salir: function () { if (confirm('¿Cerrar la sesión de organizador en este dispositivo?')) { borrarToken(); pintarLogin(); } },
    recargar: function () { irTab(st.tab); },
    'ir-pendientes': function () { st.filtroReservas = 'pendientes'; irTab('reservas'); },
    'ir-proximas': function () { st.filtroReservas = 'proximas'; irTab('reservas'); },
    'fej-todas': function (el) {
      var v = $('#orgFejTodas').value;
      if (!v) { toast('Escribí el número de fecha.', 'error'); return; }
      conBoton(el, api('adminFechaEnJuegoTodas', { fecha: Number(v) }), 'Fecha ' + v + ' en juego para todas las categorías').then(function () { st.resumen = null; vInicio(); }).catch(function () {});
    },
    buscar: function () { st.busqueda = $('#orgBuscar').value.trim(); vReservas(); },
    aprobar: function (el) { accionReserva(el, 'aprobar'); },
    rechazar: function (el) { accionReserva(el, 'rechazar'); },
    pago: function (el) {
      var completo = el.getAttribute('data-completo') === '1';
      conBoton(el, api('adminMarcarPago', { idReserva: el.getAttribute('data-id'), completo: completo }), completo ? 'Saldo marcado como pagado 💰' : 'Pago desmarcado').then(vReservas).catch(function () {});
    },
    'cancelar-res': function (el) {
      if (!confirm('¿Cancelar este turno confirmado? El horario y el cruce vuelven a quedar libres.')) return;
      conBoton(el, api('adminCancelarReserva', { idReserva: el.getAttribute('data-id') }), 'Turno cancelado').then(vReservas).catch(function () {});
    },
    'sem-prev': function () { st.agendaDesde = sumarDias(st.agendaDesde, -7); vAgenda(); },
    'sem-next': function () { st.agendaDesde = sumarDias(st.agendaDesde, 7); vAgenda(); },
    'sem-hoy': function () { st.agendaDesde = hoyISO(); vAgenda(); },
    'bloquear-franja': function (el) {
      var cancha = prompt('¿Qué cancha bloqueás de ' + el.getAttribute('data-ini') + ' a ' + el.getAttribute('data-fin') + '?\nEscribí 1, 2, 3 o TODAS', 'TODAS');
      if (!cancha) return;
      var motivo = prompt('Motivo (opcional)', 'Clase') || '';
      conBoton(el, api('adminCrearBloqueo', { fecha: el.getAttribute('data-fecha'), horaInicio: el.getAttribute('data-ini'), horaFin: el.getAttribute('data-fin'), cancha: cancha.trim(), motivo: motivo }), 'Horario bloqueado').then(function () { irTab(st.tab); }).catch(function () {});
    },
    'borrar-bloqueo': function (el) {
      if (!confirm('¿Quitar este bloqueo? El horario vuelve a estar disponible para reservar.')) return;
      conBoton(el, api('adminEliminarBloqueo', { id: el.getAttribute('data-id') }), 'Bloqueo quitado').then(function () { irTab(st.tab); }).catch(function () {});
    },
    'crear-bloqueo': function (el) {
      conBoton(el, api('adminCrearBloqueo', { fecha: $('#bFecha').value, horaInicio: $('#bIni').value, horaFin: $('#bFin').value, cancha: $('#bCancha').value, motivo: $('#bMotivo').value }), 'Horario bloqueado').then(vHorarios).catch(function () {});
    },
    'guardar-resultado': function (el) {
      var fila = el.closest('[data-partido]');
      var sets = {};
      fila.querySelectorAll('[data-set]').forEach(function (i) { sets['set' + i.getAttribute('data-set')] = i.value.trim(); });
      var det = el.closest('details');
      if (det) st.fechaAbierta[st.catResultados] = det.getAttribute('data-fecha-num');
      conBoton(el, api('adminGuardarResultado', Object.assign({ idPartido: fila.getAttribute('data-partido') }, sets))).then(function (r) {
        toast(r.estado === 'JUGADO' ? 'Resultado guardado ✅ La tabla ya se actualizó.' : 'Guardado (el partido sigue pendiente).');
        return api('adminPartidos', { categoria: st.catResultados }).then(pintarPartidos);
      }).catch(function () {});
    },
    'editar-pareja': function (el) { st.editPareja = JSON.parse(el.getAttribute('data-pareja')); vParejas(); window.scrollTo(0, 0); },
    'cancelar-edicion': function () { st.editPareja = null; vParejas(); },
    'guardar-pareja': function (el) {
      var datos = { categoria: $('#pcat').value, jugador1: $('#pj1').value, jugador2: $('#pj2').value, estado: $('#pest').value };
      if (st.editPareja) datos.id = st.editPareja.id;
      conBoton(el, api('adminGuardarPareja', datos), st.editPareja ? 'Pareja actualizada' : 'Pareja agregada').then(function () { st.editPareja = null; st.resumen = null; vParejas(); }).catch(function () {});
    },
    'generar-fixture': function (el) {
      var cat = st.catParejas;
      conBoton(el, api('adminGenerarFixture', { categoria: cat })).then(function (r) {
        if (!r.requiereConfirmacion) { toast('Fixture generado: ' + r.fechas + ' fechas, ' + r.partidos + ' partidos'); st.resumen = null; return; }
        var msg = '"' + cat + '" ya tiene fixture (' + r.existentes + ' partidos, ' + r.jugados + ' ya jugados con resultado).\n\n' +
          'Generarlo de nuevo BORRA todos esos partidos y sus resultados y arma uno nuevo desde cero con las parejas activas.' +
          (r.reservasFuturas ? '\n\n⚠️ Hay ' + r.reservasFuturas + ' reserva(s) futuras de esta categoría que van a quedar apuntando a partidos viejos.' : '') +
          '\n\n¿Seguro que querés regenerarlo?';
        if (!confirm(msg)) return;
        return conBoton(el, api('adminGenerarFixture', { categoria: cat, confirmar: true })).then(function (r2) {
          toast('Fixture nuevo: ' + r2.fechas + ' fechas, ' + r2.partidos + ' partidos'); st.resumen = null;
        });
      }).catch(function () {});
    },
    'crear-cat': function (el) {
      var n = $('#nuevaCat').value.trim();
      if (!n) { toast('Escribí el nombre.', 'error'); return; }
      conBoton(el, api('adminCrearCategoria', { nombre: n }), 'Categoría creada').then(function () { st.resumen = null; st.catParejas = n; vParejas(); }).catch(function () {});
    },
    'borrar-cat': function (el) {
      var n = el.getAttribute('data-cat');
      if (!confirm('¿Eliminar la categoría "' + n + '"?')) return;
      conBoton(el, api('adminEliminarCategoria', { nombre: n }), 'Categoría eliminada').then(function () { st.resumen = null; st.catParejas = null; vParejas(); }).catch(function () {});
    },
    'g-agregar': function (el) {
      el.closest('[data-gdia]').insertAdjacentHTML('beforeend', filaGrilla({ inicio: '', fin: '', canchas: 2 }));
    },
    'g-quitar': function (el) { el.closest('.org-gfila').remove(); },
    'guardar-grilla': function (el) {
      var franjas = [];
      root.querySelectorAll('[data-gdia]').forEach(function (d) {
        var dia = Number(d.getAttribute('data-gdia'));
        d.querySelectorAll('.org-gfila').forEach(function (fila) {
          var ini = fila.querySelector('[data-g="inicio"]').value, fin = fila.querySelector('[data-g="fin"]').value;
          if (!ini && !fin) return;
          franjas.push({ dia: dia, inicio: ini, fin: fin, canchas: Number(fila.querySelector('[data-g="canchas"]').value) });
        });
      });
      if (!confirm('¿Guardar los turnos? Las reservas ya hechas no se tocan; el cambio afecta lo que se ofrece desde ahora.')) return;
      conBoton(el, api('adminGuardarGrilla', { franjas: franjas }), 'Turnos guardados').then(vHorarios).catch(function () {});
    },
    'guardar-config': function (el) {
      var valores = {};
      root.querySelectorAll('[data-cfg]').forEach(function (i) { valores[i.getAttribute('data-cfg')] = i.value; });
      conBoton(el, api('adminGuardarConfig', { valores: valores }), 'Guardado').catch(function () {});
    },
    'nuevo-texto': function (el) {
      var bloque = el.closest('[data-bloque-tipo]');
      conBoton(el, api('adminGuardarContenido', { tipo: bloque.getAttribute('data-bloque-tipo'), titulo: 'Nuevo', texto: '', orden: 99, activo: false })).then(vContenido).catch(function () {});
    },
    'guardar-texto': function (el) {
      var item = el.closest('[data-cont-id]'), bloque = el.closest('[data-bloque-tipo]');
      var g = function (c) { return item.querySelector('[data-c="' + c + '"]'); };
      conBoton(el, api('adminGuardarContenido', { id: item.getAttribute('data-cont-id'), tipo: bloque.getAttribute('data-bloque-tipo'), titulo: g('titulo').value, texto: g('texto').value, orden: g('orden').value, activo: g('activo').checked }), 'Guardado').catch(function () {});
    },
    'borrar-texto': function (el) {
      if (!confirm('¿Eliminar este texto?')) return;
      conBoton(el, api('adminEliminarContenido', { id: el.closest('[data-cont-id]').getAttribute('data-cont-id') }), 'Eliminado').then(vContenido).catch(function () {});
    },
    'guardar-playoffs': function (el) {
      conBoton(el, api('adminGuardarConfig', { valores: { playoffs_mensaje: $('#playoffsTx').value } }), 'Guardado').catch(function () {});
    },
    'editar-sponsor': function (el) {
      var s = JSON.parse(el.closest('[data-sponsor]').getAttribute('data-sponsor'));
      $('#formSponsorTit').textContent = 'Editar sponsor';
      $('#spId').value = s.id; $('#spNombre').value = s.nombre; $('#spLink').value = s.link || '';
      $('#spLogo').value = s.logo_url || ''; $('#spDest').checked = !!s.destacado; $('#spActivo').checked = !!s.activo; $('#spOrden').value = s.orden || '';
      $('#formSponsor').scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    'guardar-sponsor': function (el) {
      var datos = { id: $('#spId').value || undefined, nombre: $('#spNombre').value, link: $('#spLink').value, logoUrl: $('#spLogo').value, destacado: $('#spDest').checked, activo: $('#spActivo').checked, orden: $('#spOrden').value };
      var archivo = $('#spLogoFile').files[0];
      var paso = archivo ? subirImagen(archivo, true).then(function (r) { datos.logoUrl = r.valor; }) : Promise.resolve();
      conBoton(el, paso.then(function () { return api('adminGuardarSponsor', datos); }), 'Sponsor guardado').then(vContenido).catch(function () {});
    },
    'borrar-sponsor': function (el) {
      if (!confirm('¿Eliminar este sponsor?')) return;
      conBoton(el, api('adminEliminarSponsor', { id: el.getAttribute('data-id') }), 'Eliminado').then(vContenido).catch(function () {});
    },
    'borrar-foto': function (el) {
      if (!confirm('¿Eliminar esta foto de la galería?')) return;
      conBoton(el, api('adminEliminarFoto', { id: el.getAttribute('data-id') }), 'Foto eliminada').then(vContenido).catch(function () {});
    },
  };

  function manejarCambio(e) {
    var t = e.target;
    if (t.hasAttribute('data-fej-cat')) {
      var cat = t.getAttribute('data-fej-cat');
      api('adminFechaEnJuego', { categoria: cat, fecha: t.value === '' ? '' : Number(t.value) }).then(function () {
        toast(cat + ': fecha ' + (t.value || '—') + ' en juego');
        st.resumen = null;
      }).catch(function (err) { toast(err.message, 'error'); });
      return;
    }
    if (t.id === 'fotoFiles' && t.files.length) {
      var archivos = Array.prototype.slice.call(t.files);
      var etiqueta = $('#fotoEtiqueta').value, titulo = $('#fotoTitulo').value;
      toast('Subiendo ' + archivos.length + ' foto(s)…');
      archivos.reduce(function (p, f) {
        return p.then(function () {
          return subirImagen(f, false).then(function (r) { return api('adminGuardarFoto', { url: r.valor, categoria: etiqueta, titulo: titulo }); });
        });
      }, Promise.resolve()).then(function () { toast('Fotos subidas 📸'); vContenido(); }).catch(function (err) { toast(err.message, 'error'); });
    }
  }

  window.Organizador = { abrir: abrir };
})();
