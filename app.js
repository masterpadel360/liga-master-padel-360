/**
 * MASTER PÁDEL 360 — app.js
 * =======================================================================
 * Cliente HTTP contra la Web App de Apps Script (fetch con respaldo
 * JSONP). Esta parte NO cambió respecto de la versión anterior que ya
 * comprobaste funcionando: mismo API_URL, mismo apiFetch, mismos nombres
 * de acción, mismo caché de 45s del lado del servidor.
 *
 * IMPORTANTE: reemplazá la constante API_URL de acá abajo por la URL de
 * TU deployment de Apps Script (la misma que ya tenías configurada).
 */
var RESERVAS_API_URL = 'https://script.google.com/macros/s/AKfycbzetv0LlHG-VUXO2HoPNkdXi3VOIlW05ElKFytwRSgSJHNpD5R7bPeTUbWm-eIYCID-5A/exec';


// ============================================================
// Cliente de API: intenta fetch() normal; si falla, cae a JSONP.
// ============================================================
function apiFetch(accion, params) {
  params = params || {};
  var qs = Object.keys(params).reduce(function (arr, k) {
    if (params[k] !== undefined && params[k] !== null) {
      arr.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
    return arr;
  }, ['accion=' + encodeURIComponent(accion)]).join('&');
  var url = API_URL + '?' + qs;

  return apiFetchJson_(url).catch(function () { return apiFetchJsonp_(url); });
}

function apiFetchJson_(url) {
  return fetch(url, { method: 'GET' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (payload) {
      if (!payload || !payload.ok) throw new Error((payload && payload.error) || 'Error desconocido');
      return payload.data;
    });
}
// API exclusiva de Reservas
function reservasFetch(action, params) {
  params = params || {};

  var qs = Object.keys(params).reduce(function (arr, k) {
    if (params[k] !== undefined && params[k] !== null) {
      arr.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
    return arr;
  }, []);

  qs.push('accion=' + encodeURIComponent(action));

  var url = URL_API_RESERVAS + '?' + qs.join('&');

  return apiFetchJson_(url).then(function (payload) {
    if (!payload || !payload.ok) {
      throw new Error(payload && payload.error ? payload.error : 'Error en Reservas API');
    }
    return payload.data;
  });
}
var jsonpContador_ = 0;
function apiFetchJsonp_(url) {
  return new Promise(function (resolve, reject) {
    var cb = 'mp360cb_' + (jsonpContador_++);
    var script = document.createElement('script');
    var resuelto = false;

    function limpiar() {
      delete window[cb];
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[cb] = function (payload) {
      resuelto = true;
      limpiar();
      if (payload && payload.ok) resolve(payload.data);
      else reject(new Error((payload && payload.error) || 'Error desconocido'));
    };
    script.src = url + '&callback=' + cb;
    script.onerror = function () { limpiar(); reject(new Error('No se pudo conectar con el servidor.')); };
    document.body.appendChild(script);

    setTimeout(function () {
      if (!resuelto) { limpiar(); reject(new Error('Tiempo de espera agotado.')); }
    }, 12000);
  });
}

// ============================================================
// Estado global de la SPA
// ============================================================
var CATEGORIAS = [];
var categoriaActual = null;
var pantallaActual = 'inicio';
var cache_ = {};
var fechaPorCategoria = {};
var fotosCache_ = [];
var filtroFotoActual = 'Todas';

// ============================================================
// Categoría guardada del jugador (localStorage)
// ============================================================
var LS_CATEGORIA_ = 'mp360_categoria';
function guardarCategoriaElegida_(cat) {
  try { localStorage.setItem(LS_CATEGORIA_, cat); } catch (e) { /* storage no disponible: no rompe la app */ }
}
function borrarCategoriaGuardada_() {
  try { localStorage.removeItem(LS_CATEGORIA_); } catch (e) { /* nada que borrar si no hay storage */ }
}
function leerCategoriaGuardada_() {
  try { return localStorage.getItem(LS_CATEGORIA_); } catch (e) { return null; }
}

// "premios", "sobre-liga" y "contacto" son pantallas nuevas de este
// rediseño; "sobre-liga" y "contacto" no piden nada al backend (son
// contenido fijo editable directo en index.html), por eso no tienen
// caso en cargarPantalla_ más abajo.
var NAV_GRUPO = {
  inicio: 'inicio', posiciones: 'posiciones', fixture: 'fixture', resultados: 'resultados',
  mas: 'mas', playoffs: 'mas', fotos: 'mas', reglamento: 'mas', premios: 'mas',
  sponsors: 'mas', 'sobre-liga': 'mas', contacto: 'mas',
};

function esc_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function iniciales_(nombre) {
  return String(nombre || '').split(' / ').map(function (p) { return p.trim().charAt(0); }).join('').toUpperCase().slice(0, 2);
}
function uniq_(arr) {
  var visto = {}, out = [];
  arr.forEach(function (v) { if (v && !visto[v]) { visto[v] = true; out.push(v); } });
  return out;
}
function parsearSet_(texto) {
  var m = /^(\d{1,2})[-/\s]+(\d{1,2})$/.exec(String(texto || '').trim());
  return m ? { a: parseInt(m[1], 10), b: parseInt(m[2], 10) } : null;
}

// Una fila por pareja, una columna por set: nunca una secuencia de
// números pegada a un solo nombre que se pueda leer al revés.
function renderScoreboard_(parejaA, parejaB, sets, ganador) {
  var parsed = sets.map(parsearSet_);
  var aGana = ganador === parejaA;
  function celdas(lado) {
    return parsed.map(function (s) {
      if (!s) return '<span class="scoreboard-set">–</span>';
      var v = lado === 'a' ? s.a : s.b, o = lado === 'a' ? s.b : s.a;
      return '<span class="scoreboard-set' + (v > o ? ' mayor' : '') + '">' + v + '</span>';
    }).join('');
  }
  return '<div class="scoreboard">' +
    '<div class="scoreboard-row ' + (aGana ? 'win' : 'lose') + '">' +
    '<span class="avatar">' + iniciales_(parejaA) + '</span>' +
    '<span class="scoreboard-nombre">' + esc_(parejaA) + '</span>' +
    '<span class="scoreboard-sets">' + celdas('a') + '</span></div>' +
    '<div class="scoreboard-row ' + (aGana ? 'lose' : 'win') + '">' +
    '<span class="avatar">' + iniciales_(parejaB) + '</span>' +
    '<span class="scoreboard-nombre">' + esc_(parejaB) + '</span>' +
    '<span class="scoreboard-sets">' + celdas('b') + '</span></div>' +
    '</div>';
}

// ============================================================
// Navegación
// ============================================================
function irA(pantalla) {
  document.getElementById('screen-' + pantallaActual).hidden = true;
  pantallaActual = pantalla;
  document.getElementById('screen-' + pantalla).hidden = false;
  document.querySelectorAll('.nav-item').forEach(function (el) {
    el.classList.toggle('active', el.getAttribute('data-nav') === NAV_GRUPO[pantalla]);
  });
  cargarPantalla_(pantalla);
  document.getElementById('body').scrollTop = 0;
}

document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-go]');
  if (el) irA(el.getAttribute('data-go'));
});

function cargarPantalla_(pantalla) {
  // Sin categoría elegida todavía no hay nada que filtrar en estas tres
  // pantallas: mandamos al jugador de vuelta a Inicio a elegirla.
  if (!categoriaActual && (pantalla === 'posiciones' || pantalla === 'fixture' || pantalla === 'resultados')) {
    irA('inicio');
    return;
  }
  if (pantalla === 'posiciones') cargarPosiciones_();
  else if (pantalla === 'fixture') cargarFixture_();
  else if (pantalla === 'resultados') cargarResultados_();
  else if (pantalla === 'playoffs' || pantalla === 'reglamento' || pantalla === 'premios') cargarMas_();
  else if (pantalla === 'fotos') cargarFotos_();
  else if (pantalla === 'sponsors') cargarSponsors_();
  // 'sobre-liga' y 'contacto' son contenido fijo del HTML: no piden nada.
}

// ============================================================
// Selector de categoría (chips, compartido entre 3 pantallas)
// ============================================================
function pintarChipsCategoria_(contId) {
  document.getElementById(contId).innerHTML = CATEGORIAS.map(function (cat) {
    return '<button class="chip' + (cat === categoriaActual ? ' active' : '') + '" data-cat="' + esc_(cat) + '">' + esc_(cat) + '</button>';
  }).join('');
}
function elegirCategoria_(cat) {
  categoriaActual = cat;
  document.querySelectorAll('.cat-chips .chip').forEach(function (c) {
    c.classList.toggle('active', c.getAttribute('data-cat') === categoriaActual);
  });
  guardarCategoriaElegida_(categoriaActual);
  // Elegido el chip, el selector se cierra/compacta (patrón tap-para-
  // desplegar: la próxima vez que haga falta elegir, arranca cerrado).
  actualizarSelectorInicio_(false);
  precargarPantallasCategoria_(categoriaActual);
  cargarPantalla_(pantallaActual);
}

// ============================================================
// Tap robusto sobre los chips de categoría (Pointer Events)
// ============================================================
// #inicioCats tiene scroll horizontal: el navegador suprime el click
// nativo apenas el dedo se mueve más de ~12-15px entre el touchstart y
// el touchend, algo muy común ahí (arrastre parcial para ver más
// categorías, inercia de scroll que no terminó de asentarse). Por eso
// medimos nosotros mismos el desplazamiento real del puntero: si fue
// chico, es un tap y elegimos la categoría; si fue grande, es un swipe
// real y no hacemos nada (nunca llamamos preventDefault, así que el
// scroll nativo de los chips sigue funcionando igual que siempre).
// El mouse sigue resuelto por el click de siempre, que ya es
// confiable, para no cambiar nada ahí.
var UMBRAL_TAP_PX_ = 10;
var tapPointerInicio_ = null;
var tapChipManejadoEl_ = null;
var tapChipManejadoTs_ = 0;

document.addEventListener('pointerdown', function (e) {
  if (tapPointerInicio_) return; // ya estamos siguiendo otro puntero
  var el = e.target.closest('#inicioCats [data-cat]');
  if (!el) return;
  tapPointerInicio_ = { x: e.clientX, y: e.clientY, el: el, id: e.pointerId, tipo: e.pointerType };
});
document.addEventListener('pointerup', function (e) {
  if (!tapPointerInicio_ || e.pointerId !== tapPointerInicio_.id) return;
  var inicio = tapPointerInicio_;
  tapPointerInicio_ = null;
  if (inicio.tipo === 'mouse') return;
  var dist = Math.hypot(e.clientX - inicio.x, e.clientY - inicio.y);
  if (dist > UMBRAL_TAP_PX_) return; // swipe real: se deja pasar, no es un tap
  elegirCategoria_(inicio.el.getAttribute('data-cat'));
  // Marca este chip como ya resuelto: el navegador todavía puede
  // disparar un click sintético después del touchend, y no queremos
  // procesar la selección dos veces.
  tapChipManejadoEl_ = inicio.el;
  tapChipManejadoTs_ = Date.now();
});
document.addEventListener('pointercancel', function () { tapPointerInicio_ = null; });

document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-cat]');
  if (!el) return;
  if (el === tapChipManejadoEl_ && (Date.now() - tapChipManejadoTs_) < 800) return;
  elegirCategoria_(el.getAttribute('data-cat'));
});

// ============================================================
// Selector de categoría de Inicio (independiente del resto del
// contenido de Inicio: novedades/sponsors/galería rotos NUNCA deben
// impedir que esto se pinte).
//
// Patrón "tap para desplegar": sin categoría elegida, Inicio arranca
// mostrando solo el CTA "Seleccioná tu categoría" -- los chips de
// CATEGORIAS NO están desplegados todavía. Recién al tocar el CTA (o,
// con categoría ya elegida, la fila compacta) se despliegan.
// ============================================================
var selectorInicioAbierto_ = false;

// abrir: true/false para forzar el estado de los chips; se omite para
// dejar el estado tal cual está (usado al repintar por otros motivos,
// como al cambiar de pantalla).
function actualizarSelectorInicio_(abrir) {
  var cta = document.getElementById('cat-select-cta');
  var expandido = document.getElementById('cat-select-expanded');
  var bloque = document.getElementById('cat-select-block');
  var filaActiva = document.getElementById('cat-active-row');
  var valorActivo = document.getElementById('cat-active-value');

  if (typeof abrir === 'boolean') selectorInicioAbierto_ = abrir;

  pintarChipsCategoria_('inicioCats');

  var hayCategoria = !!categoriaActual;
  var mostrarChips = selectorInicioAbierto_;

  cta.hidden = hayCategoria || mostrarChips;
  expandido.hidden = !mostrarChips;
  filaActiva.hidden = !hayCategoria || mostrarChips;
  bloque.classList.toggle('is-compact', hayCategoria && !mostrarChips);
  bloque.classList.toggle('needs-choice', !hayCategoria);
  valorActivo.textContent = hayCategoria ? categoriaActual : '';
}
document.getElementById('cat-select-cta').addEventListener('click', function () {
  actualizarSelectorInicio_(true);
});
document.getElementById('cat-active-row').addEventListener('click', function () {
  actualizarSelectorInicio_(true);
});

// ============================================================
// Inicio
// ============================================================
// Robusto frente a datos opcionales rotos (null/undefined/vacíos/
// elementos null/objetos incompletos): un problema acá jamás debe
// afectar el selector de categoría, que se pinta aparte.
function renderInicio_(datos) {
  datos = datos || {};
  var novedades = (Array.isArray(datos.novedades) ? datos.novedades : []).filter(Boolean);
  var sponsors = (Array.isArray(datos.sponsors) ? datos.sponsors : []).filter(Boolean);

  var elStatus = document.getElementById('hero-status');
  if (datos.banner && datos.banner.titulo) {
    elStatus.hidden = false;
    elStatus.textContent = datos.banner.titulo;
  } else {
    elStatus.hidden = true;
  }

  document.getElementById('novedades').innerHTML = novedades.map(function (n) {
    return '<div class="news-card"><b>' + esc_(n.titulo) + '</b><span>' + esc_(n.texto) + '</span></div>';
  }).join('');

  var elSp = document.getElementById('ini-sponsors');
  if (sponsors.length) {
    elSp.hidden = false;
    document.getElementById('ini-sponsors-logos').innerHTML = sponsors.map(sponsorChipHtml_).join('');
  } else {
    elSp.hidden = true;
  }
}

// Un sponsor-chip muestra el logo real (logoUrl de la hoja SPONSORS) si
// existe; si esa fila todavía no tiene logo cargado, muestra el nombre
// como texto -- nunca queda un chip vacío ni una imagen rota.
function sponsorChipHtml_(s) {
  s = s || {};
  if (s.logoUrl) {
    return '<div class="sponsor-chip has-img" style="background-image:url(\'' + esc_(s.logoUrl) + '\')" title="' + esc_(s.nombre) + '"></div>';
  }
  return '<div class="sponsor-chip">' + esc_(s.nombre) + '</div>';
}

// Banner "Más que una liga": usa la primera foto real de GALERIA como
// fondo. Se pide aparte del bootstrap (no bloquea ni rompe Inicio si la
// galería tarda o todavía no tiene fotos cargadas).
function cargarFotosInicio_() {
  apiFetch('galeria').then(function (fotos) {
    if (!Array.isArray(fotos) || !fotos.length) return;
    var foto = fotos[0] || {};
    var banner = document.getElementById('community-banner');
    var bg = document.getElementById('community-bg');
    var img = new Image();
    img.onload = function () {
      bg.style.backgroundImage = "url('" + foto.url + "')";
      banner.hidden = false;
    };
    img.onerror = function () { /* la foto no cargó: el banner sigue oculto */ };
    img.src = foto.url;
  }).catch(function () { /* sin fotos no rompe Inicio */ });
}

// ============================================================
// Precarga en segundo plano de Posiciones/Fixture/Resultados para la
// categoría activa. Usa exactamente el mismo cache_ y las mismas
// claves ('pos|cat', 'fix|cat', 'res|cat') que ya consultan
// cargarPosiciones_/cargarFixture_/cargarResultados_ antes de pedir
// red -- por eso alcanza con completar cache_ acá: si el jugador
// después entra a esas pantallas y la precarga ya terminó, las va a
// ver instantáneas, sin tocar en nada su lógica de carga ni de
// render. Nunca renderiza nada ella misma (eso lo sigue haciendo cada
// pantalla la primera vez que se visita, cache_ mediante).
// Si una petición falla, el catch la ignora en silencio: no rompe
// Inicio ni muestra ningún error, y esa pantalla simplemente va a
// pedir sus datos de nuevo (como si no hubiese precarga) cuando el
// jugador la visite.
function precargarPantallasCategoria_(cat) {
  if (!cat) return;
  var claveP = 'pos|' + cat;
  if (!cache_[claveP]) {
    apiFetch('posiciones', { categoria: cat }).then(function (filas) {
      cache_[claveP] = filas;
    }).catch(function () { /* sin precarga, cargarPosiciones_ pide los datos igual */ });
  }
  var claveF = 'fix|' + cat;
  if (!cache_[claveF]) {
    apiFetch('fixture', { categoria: cat }).then(function (datos) {
      cache_[claveF] = datos;
    }).catch(function () { /* idem */ });
  }
  var claveR = 'res|' + cat;
  if (!cache_[claveR]) {
    apiFetch('resultados', { categoria: cat }).then(function (lista) {
      cache_[claveR] = lista;
    }).catch(function () { /* idem */ });
  }
}

// ============================================================
// Posiciones
// ============================================================
function cargarPosiciones_() {
  var cat = categoriaActual; if (!cat) return;
  var clave = 'pos|' + cat;
  if (cache_[clave]) { renderPosiciones_(cache_[clave]); return; }
  document.getElementById('posRows').innerHTML = '<div class="state-loading">Cargando…</div>';
  apiFetch('posiciones', { categoria: cat }).then(function (filas) {
    cache_[clave] = filas;
    if (categoriaActual === cat) renderPosiciones_(filas);
  }).catch(function () {
    if (categoriaActual === cat) document.getElementById('posRows').innerHTML =
      '<p class="state-empty">No se pudo cargar la tabla. Probá de nuevo en un momento.</p>';
  });
}
function renderPosiciones_(filas) {
  var cont = document.getElementById('posRows');
  if (!filas.length) { cont.innerHTML = '<p class="state-empty">Todavía no hay parejas activas en esta categoría.</p>'; return; }
  cont.innerHTML = filas.map(function (f, i) {
    var rankClass = i === 0 ? ' g1' : i === 1 ? ' g2' : i === 2 ? ' g3' : '';
    return '<div class="standing-row' + (i < 3 ? ' top' : '') + '">' +
      '<button class="standing-main" data-toggle-row>' +
        '<span class="standing-rank' + rankClass + '">' + f.pos + '</span>' +
        '<span class="standing-pareja">' + esc_(f.pareja) + '</span>' +
        '<span class="standing-num">' + f.pj + '</span><span class="standing-num">' + f.pg + '</span><span class="standing-num">' + f.pp + '</span>' +
        '<span class="standing-pts">' + f.pts + '</span>' +
      '</button>' +
      '<div class="standing-detail"><div class="standing-detail-inner">' +
        '<div><span class="v">' + f.setsFavor + '–' + f.setsContra + '</span><span class="l">Sets</span></div>' +
        '<div><span class="v">' + (f.difSets > 0 ? '+' : '') + f.difSets + '</span><span class="l">Dif. sets</span></div>' +
        '<div><span class="v">' + f.gamesFavor + '–' + f.gamesContra + '</span><span class="l">Games</span></div>' +
      '</div></div>' +
    '</div>';
  }).join('');
}
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-toggle-row]');
  if (btn) btn.closest('.standing-row').classList.toggle('open');
});

// ============================================================
// Fixture
// ============================================================
function cargarFixture_() {
  var cat = categoriaActual; if (!cat) return;
  var clave = 'fix|' + cat;
  if (cache_[clave]) { renderFixture_(cache_[clave]); return; }
  document.getElementById('fixMatches').innerHTML = '<div class="state-loading">Cargando…</div>';
  document.getElementById('fixFechas').innerHTML = '';
  apiFetch('fixture', { categoria: cat }).then(function (datos) {
    cache_[clave] = datos;
    if (categoriaActual === cat) renderFixture_(datos);
  }).catch(function () {
    if (categoriaActual === cat) document.getElementById('fixMatches').innerHTML =
      '<p class="state-empty">No se pudo cargar el fixture. Probá de nuevo en un momento.</p>';
  });
}
function renderFixture_(datos) {
  var contFechas = document.getElementById('fixFechas');
  var contM = document.getElementById('fixMatches');
  if (!datos.fechas.length) {
    contFechas.innerHTML = '';
    contM.innerHTML = '<p class="state-empty">Todavía no se generó el fixture de esta categoría.</p>';
    return;
  }
  if (!fechaPorCategoria[categoriaActual]) {
    fechaPorCategoria[categoriaActual] = datos.fechas[datos.fechas.length - 1].numero;
  }
  var sel = fechaPorCategoria[categoriaActual];
  contFechas.innerHTML = datos.fechas.map(function (f) {
    return '<button class="chip' + (f.numero === sel ? ' active' : '') + '" data-fecha="' + f.numero + '">Fecha ' + f.numero + '</button>';
  }).join('');
  var fecha = datos.fechas.filter(function (f) { return f.numero === sel; })[0] || datos.fechas[0];
  // Nota: acá NO se muestran horario ni cancha porque PARTIDOS no trae
  // esos datos hoy. Apenas existan en la planilla, se agregan sin tocar
  // el resto de la tarjeta.
  var html = fecha.partidos.map(function (p) {
    if (p.estado === 'JUGADO') return '<div class="match-card">' + renderScoreboard_(p.parejaA, p.parejaB, p.sets, p.ganador) + '</div>';
    return '<div class="match-card"><span class="match-pending-tag">Pendiente</span>' +
      '<div class="match-pair"><span class="avatar">' + iniciales_(p.parejaA) + '</span><span class="nm">' + esc_(p.parejaA) + '</span></div>' +
      '<div class="vs-div">VS</div>' +
      '<div class="match-pair"><span class="avatar">' + iniciales_(p.parejaB) + '</span><span class="nm">' + esc_(p.parejaB) + '</span></div>' +
    '</div>';
  }).join('');
  html += fecha.libres.map(function (nombre) {
    return '<div class="bye-card">Libre esta fecha: <b>' + esc_(nombre) + '</b></div>';
  }).join('');
  contM.innerHTML = html;
}
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-fecha]');
  if (!el) return;
  fechaPorCategoria[categoriaActual] = Number(el.getAttribute('data-fecha'));
  var datos = cache_['fix|' + categoriaActual];
  if (datos) renderFixture_(datos);
});

// ============================================================
// Resultados
// ============================================================
function cargarResultados_() {
  var cat = categoriaActual; if (!cat) return;
  var clave = 'res|' + cat;
  if (cache_[clave]) { renderResultados_(cache_[clave]); return; }
  document.getElementById('resMatches').innerHTML = '<div class="state-loading">Cargando…</div>';
  apiFetch('resultados', { categoria: cat }).then(function (lista) {
    cache_[clave] = lista;
    if (categoriaActual === cat) renderResultados_(lista);
  }).catch(function () {
    if (categoriaActual === cat) document.getElementById('resMatches').innerHTML =
      '<p class="state-empty">No se pudo cargar los resultados. Probá de nuevo en un momento.</p>';
  });
}
function renderResultados_(lista) {
  var cont = document.getElementById('resMatches');
  if (!lista.length) { cont.innerHTML = '<p class="state-empty">Todavía no hay resultados cargados en esta categoría.</p>'; return; }
  var porFecha = {}, orden = [];
  lista.forEach(function (r) {
    if (!porFecha[r.fecha]) { porFecha[r.fecha] = []; orden.push(r.fecha); }
    porFecha[r.fecha].push(r);
  });
  cont.innerHTML = orden.map(function (fecha) {
    var tarjetas = porFecha[fecha].map(function (r) {
      return '<div class="match-card">' + renderScoreboard_(r.parejaA, r.parejaB, r.sets, r.ganador) + '</div>';
    }).join('');
    return '<div class="fecha-block-label">Fecha ' + fecha + '</div>' + tarjetas;
  }).join('');
}

// ============================================================
// Más: Playoffs + Reglamento + Premios
// (una sola llamada a mp360GetMas() alimenta las tres pantallas)
// ============================================================
function cargarMas_() {
  if (cache_.mas) { renderMas_(cache_.mas); return; }
  apiFetch('mas').then(function (datos) {
    cache_.mas = datos;
    renderMas_(datos);
  }).catch(function () {
    document.getElementById('premios-bloques').innerHTML = '<p class="state-empty">No se pudieron cargar los premios.</p>';
  });
}
// El reglamento ya no se arma con bloques de texto de la planilla: la
// pantalla de Reglamento ahora es el PDF oficial completo (ver
// index.html), así que datos.reglamento no se usa acá. Se sigue
// pidiendo igual porque esta misma llamada alimenta Playoffs y Premios.
function renderMas_(datos) {
  document.getElementById('playoffs-mensaje').textContent = datos.playoffsMensaje;

  var premios = datos.premios.map(function (p) {
    return '<div class="reg-block"><b>' + esc_(p.titulo) + '</b><p>' + esc_(p.texto) + '</p></div>';
  }).join('');
  document.getElementById('premios-bloques').innerHTML = premios || '<p class="state-empty">Todavía no se cargaron los premios.</p>';
}

// ============================================================
// Fotos
// ============================================================
function cargarFotos_() {
  if (cache_.fotos) { renderFotos_(cache_.fotos); return; }
  document.getElementById('fotosGrid').innerHTML = '<div class="state-loading">Cargando…</div>';
  apiFetch('galeria').then(function (datos) {
    cache_.fotos = datos;
    renderFotos_(datos);
  }).catch(function () {
    document.getElementById('fotosGrid').innerHTML = '<p class="state-empty">No se pudieron cargar las fotos.</p>';
  });
}
function renderFotos_(fotos) {
  fotosCache_ = fotos;
  var categorias = ['Todas'].concat(uniq_(fotos.map(function (f) { return f.categoria; })));
  document.getElementById('fotosFiltros').innerHTML = categorias.map(function (c) {
    return '<button class="chip' + (c === filtroFotoActual ? ' active' : '') + '" data-foto-cat="' + esc_(c) + '">' + esc_(c) + '</button>';
  }).join('');
  pintarGrillaFotos_();
}
function pintarGrillaFotos_() {
  var lista = filtroFotoActual === 'Todas' ? fotosCache_ : fotosCache_.filter(function (f) { return f.categoria === filtroFotoActual; });
  var cont = document.getElementById('fotosGrid');
  if (!lista.length) { cont.innerHTML = '<p class="state-empty">Todavía no hay fotos cargadas.</p>'; return; }
  cont.innerHTML = lista.map(function (f) {
    return '<div class="photo-swatch"><img loading="lazy" src="' + esc_(f.url) + '" alt="' + esc_(f.titulo) + '" onerror="this.parentElement.remove()"><span>' + esc_(f.titulo || f.categoria) + '</span></div>';
  }).join('');
}
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-foto-cat]');
  if (!el) return;
  filtroFotoActual = el.getAttribute('data-foto-cat');
  renderFotos_(fotosCache_);
});

// ============================================================
// Sponsors
// ============================================================
function cargarSponsors_() {
  if (cache_.sponsors) { renderSponsors_(cache_.sponsors); return; }
  apiFetch('sponsors').then(function (datos) {
    cache_.sponsors = datos;
    renderSponsors_(datos);
  }).catch(function () {
    var el = document.getElementById('sponsors-empty');
    el.hidden = false;
    el.textContent = 'No se pudo cargar esta sección.';
  });
}
function renderSponsors_(datos) {
  var elDest = document.getElementById('sponsor-destacado');
  if (datos.destacado) {
    elDest.hidden = false;
    document.getElementById('sponsor-destacado-nombre').textContent = datos.destacado.nombre;
    var logo = document.getElementById('sponsor-destacado-logo');
    if (datos.destacado.logoUrl) {
      logo.classList.add('has-img');
      logo.style.backgroundImage = "url('" + datos.destacado.logoUrl + "')";
      logo.textContent = '';
    }
  } else {
    elDest.hidden = true;
  }
  document.getElementById('sponsor-resto').innerHTML = datos.resto.map(function (s) {
    var chip = sponsorChipHtml_(s);
    if (!s.link) return chip;
    // Envolvemos el mismo chip en un link cuando la fila tiene LINK cargado.
    return chip.replace('<div class="sponsor-chip', '<a href="' + esc_(s.link) + '" target="_blank" rel="noopener" class="sponsor-chip').replace(/<\/div>$/, '</a>');
  }).join('');
  document.getElementById('sponsors-empty').hidden = !!(datos.destacado || datos.resto.length);
}

// ============================================================
// Arranque
// ============================================================
window.addEventListener('DOMContentLoaded', function () {
  apiFetch('bootstrap').then(function (boot) {
  boot = boot || {};
  CATEGORIAS = Array.isArray(boot.categorias) ? boot.categorias.filter(Boolean) : [];

  // Categoría guardada de una visita anterior: solo se respeta si sigue
  // existiendo en CATEGORIAS (la fuente de verdad real del backend).
  var guardada = leerCategoriaGuardada_();
  if (guardada && CATEGORIAS.indexOf(guardada) !== -1) {
    categoriaActual = guardada;
  } else {
    if (guardada) borrarCategoriaGuardada_();
    categoriaActual = null;
  }

  // El selector de categoría se pinta siempre, sin importar si el resto
  // del contenido de Inicio (novedades, sponsors, banner) falla.
  actualizarSelectorInicio_();

  // Si ya había una categoría válida guardada, arrancamos a precargar
  // Posiciones/Fixture/Resultados en segundo plano (no-op si no hay
  // categoría: precargarPantallasCategoria_ corta sola).
  precargarPantallasCategoria_(categoriaActual);

  try {
    renderInicio_(boot.inicio || {});
  } catch (e) {
    console.error('No se pudo pintar el contenido dinámico de Inicio:', e);
  }
  cargarFotosInicio_();
  irA('inicio');
  }).catch(function (err) {
    document.getElementById('screen-inicio').innerHTML =
      '<p class="state-empty">No se pudo conectar con el servidor. Si esto persiste, revisá API_URL en app.js.</p>';
    console.error(err);
  });
});
