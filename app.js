/**
 * MASTER PÁDEL 360 — app.js
 * =======================================================================
 * Reemplaza a google.script.run (que solo existe dentro de un HTML
 * servido por Apps Script) por un cliente HTTP normal contra la misma
 * Web App de Apps Script, ahora llamada con "?accion=...".
 *
 * IMPORTANTE: reemplazá la constante API_URL de acá abajo por la URL de
 * TU deployment de Apps Script (ver instrucciones de instalación). Sin
 * eso, la página no tiene de dónde traer datos.
 */
var API_URL = 'https://script.google.com/macros/s/AKfycbxebUf2uSFTtcyrySuK_budugkr4Ai5gV8R5gBgYabgO0relQ0jaC7ljvLX6wz_rU0t/exec';

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

var NAV_GRUPO = {
  inicio: 'inicio', posiciones: 'posiciones', fixture: 'fixture', resultados: 'resultados',
  mas: 'mas', playoffs: 'mas', fotos: 'mas', reglamento: 'mas', sponsors: 'mas',
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
  if (pantalla === 'posiciones') cargarPosiciones_();
  else if (pantalla === 'fixture') cargarFixture_();
  else if (pantalla === 'resultados') cargarResultados_();
  else if (pantalla === 'playoffs' || pantalla === 'reglamento') cargarMas_();
  else if (pantalla === 'fotos') cargarFotos_();
  else if (pantalla === 'sponsors') cargarSponsors_();
}

// ============================================================
// Selector de categoría (chips, compartido entre 3 pantallas)
// ============================================================
function pintarChipsCategoria_(contId) {
  document.getElementById(contId).innerHTML = CATEGORIAS.map(function (cat) {
    return '<button class="chip' + (cat === categoriaActual ? ' active' : '') + '" data-cat="' + esc_(cat) + '">' + esc_(cat) + '</button>';
  }).join('');
}
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-cat]');
  if (!el) return;
  categoriaActual = el.getAttribute('data-cat');
  document.querySelectorAll('.cat-chips .chip').forEach(function (c) {
    c.classList.toggle('active', c.getAttribute('data-cat') === categoriaActual);
  });
  cargarPantalla_(pantallaActual);
});

// ============================================================
// Inicio
// ============================================================
function renderInicio_(datos) {
  var elStatus = document.getElementById('hero-status');
  if (datos.banner && datos.banner.titulo) {
    elStatus.hidden = false;
    elStatus.textContent = datos.banner.titulo;
  } else {
    elStatus.hidden = true;
  }

  document.getElementById('novedades').innerHTML = datos.novedades.map(function (n) {
    return '<div class="news-card"><b>' + esc_(n.titulo) + '</b><span>' + esc_(n.texto) + '</span></div>';
  }).join('');

  var elSp = document.getElementById('ini-sponsors');
  if (datos.sponsors.length) {
    elSp.hidden = false;
    document.getElementById('ini-sponsors-logos').innerHTML = datos.sponsors.map(function (s) {
      return '<div class="sponsor-chip">' + esc_(s.nombre) + '</div>';
    }).join('');
  } else {
    elSp.hidden = true;
  }
}

// Fotos reales de la liga en Inicio: se piden aparte (no rompe el
// bootstrap si la galería tarda o falla) y se muestran las primeras 2.
function cargarFotosInicio_() {
  apiFetch('galeria').then(function (fotos) {
    var el = document.getElementById('hero-photos');
    var muestra = fotos.slice(0, 2);
    if (!muestra.length) return;
    el.hidden = false;
    el.className = 'hero-photos' + (muestra.length === 1 ? ' single' : '');
    el.innerHTML = muestra.map(function (f) {
      return '<div class="hero-photo"><img loading="lazy" src="' + esc_(f.url) + '" alt="' + esc_(f.titulo || 'Master Pádel 360') + '" onerror="this.closest(\'.hero-photo\').remove()"></div>';
    }).join('');
  }).catch(function () { /* sin fotos no rompe Inicio */ });
}

// ============================================================
// Posiciones
// ============================================================
function cargarPosiciones_() {
  var cat = categoriaActual; if (!cat) return;
  pintarChipsCategoria_('posCats');
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
  pintarChipsCategoria_('fixCats');
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
  pintarChipsCategoria_('resCats');
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
// Más: Playoffs + Reglamento
// ============================================================
function cargarMas_() {
  if (cache_.mas) { renderMas_(cache_.mas); return; }
  apiFetch('mas').then(function (datos) {
    cache_.mas = datos;
    renderMas_(datos);
  }).catch(function () {
    document.getElementById('reg-bloques').innerHTML = '<p class="state-empty">No se pudo cargar el reglamento.</p>';
  });
}
function renderMas_(datos) {
  document.getElementById('playoffs-mensaje').textContent = datos.playoffsMensaje;
  var bloques = datos.reglamento.map(function (b) {
    return '<div class="reg-block"><b>' + esc_(b.titulo) + '</b><p>' + esc_(b.texto) + '</p></div>';
  });
  datos.premios.forEach(function (p) {
    bloques.push('<div class="reg-block"><b>🏅 ' + esc_(p.titulo) + '</b><p>' + esc_(p.texto) + '</p></div>');
  });
  document.getElementById('reg-bloques').innerHTML = bloques.join('') || '<p class="state-empty">Todavía no se cargó el reglamento.</p>';
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
    var tag = s.link ? 'a href="' + esc_(s.link) + '" target="_blank" rel="noopener"' : 'div';
    var cierre = s.link ? 'a' : 'div';
    return '<' + tag + ' class="sponsor-chip">' + esc_(s.nombre) + '</' + cierre + '>';
  }).join('');
  document.getElementById('sponsors-empty').hidden = !!(datos.destacado || datos.resto.length);
}

// ============================================================
// Arranque
// ============================================================
window.addEventListener('DOMContentLoaded', function () {
  apiFetch('bootstrap').then(function (boot) {
    CATEGORIAS = boot.categorias || [];
    categoriaActual = CATEGORIAS[0] || null;
    renderInicio_(boot.inicio);
    cargarFotosInicio_();
    irA('inicio'); // fija el estado activo del nav sin reanimar la pantalla
  }).catch(function (err) {
    document.getElementById('screen-inicio').innerHTML =
      '<p class="state-empty">No se pudo conectar con el servidor. Si esto persiste, revisá API_URL en app.js.</p>';
    console.error(err);
  });
});
