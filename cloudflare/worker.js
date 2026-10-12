/**
 * =======================================================================
 * LIGA MASTER PÁDEL 360 — API en Cloudflare Workers + D1
 * =======================================================================
 * Reemplaza a los tres proyectos de Apps Script (Web App pública,
 * Reservas API y el administrativo de la planilla). Un solo archivo, sin
 * dependencias: se puede pegar tal cual en el editor del panel de
 * Cloudflare o publicar con `wrangler deploy`.
 *
 * Mismo "contrato" que tenía Apps Script, para que la app no note la
 * diferencia:
 *   - Se llama con ?accion=NOMBRE (GET) o POST con cuerpo JSON.
 *   - Responde { ok: true, data: ... } o { ok: false, error: "..." }.
 *   - En GET acepta &callback=fn (JSONP), igual que antes.
 *
 * Por qué ahora anda rápido y sin errores con mucha gente a la vez:
 *   Apps Script bloqueaba la planilla entera en cada reserva (LockService)
 *   y leía hojas completas en cada pedido; con 3 personas reservando a la
 *   vez se hacía fila y cortaba por tiempo. Acá cada operación de reserva
 *   es UNA sola instrucción atómica de la base de datos (inserta solo si
 *   todavía hay lugar), así que dos personas nunca pueden quedarse con el
 *   mismo lugar y nadie espera a nadie.
 *
 * Variables de entorno (Settings → Variables and Secrets del Worker):
 *   CLAVE_ACCESO_LIGA      contraseña general de la liga   (def. 'padel360')
 *   ACCESO_LIGA_VERSION    cambiala para desloguear a todos (def. 'v1')
 *   CLAVE_ADMIN            contraseña del organizador     (def. 'admin360padel')
 * Base de datos: binding "DB" → liga-360-db
 * =======================================================================
 */

// ---------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------
const TZ_OFFSET_MS = -3 * 60 * 60 * 1000; // Córdoba: UTC-3 todo el año
const NOMBRES_DIA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const PENDIENTE = 'PENDIENTE';
const JUGADO = 'JUGADO';
const EST = {
  PENDIENTE_APROBACION: 'PENDIENTE_APROBACION',
  RESERVADO: 'RESERVADO',
  RECHAZADO: 'RECHAZADO',
  CANCELADO: 'CANCELADO',
  FINALIZADO: 'FINALIZADO',
};
const PAGO_COMPLETO = 'PAGO_COMPLETO';
const SALDO_PENDIENTE = 'SALDO_PENDIENTE';
const ALFABETO_CODIGO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_ARCHIVO_BYTES = 1900000; // D1 admite filas de hasta 2 MB
const MIMES_COMPROBANTE = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MIMES_PUBLICOS = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];
const ADMIN_TOKEN_DIAS = 30;
const CONFIG_EDITABLE = ['valor_turno', 'monto_sena', 'alias', 'ventana_dias', 'retencion_minutos', 'cantidad_canchas', 'fecha_inicio_liga', 'playoffs_mensaje'];

// ---------------------------------------------------------------------
// Errores de negocio (se muestran tal cual al usuario)
// ---------------------------------------------------------------------
class ErrorNegocio extends Error {}
function falla(msg) { throw new ErrorNegocio(msg); }

// ---------------------------------------------------------------------
// Utilidades de texto
// ---------------------------------------------------------------------
const txt = (v) => String(v === null || v === undefined ? '' : v).trim();
const mayus = (v) => txt(v).toUpperCase();
const soloDigitos = (v) => String(v === null || v === undefined ? '' : v).replace(/\D/g, '');
function nombrePareja(p) {
  if (!p) return '';
  const j1 = txt(p.jugador1), j2 = txt(p.jugador2);
  return j2 ? j1 + ' / ' + j2 : j1;
}
function idDeTxtPareja(t) {
  const m = /^([A-Za-z]+\d+)/.exec(txt(t));
  return m ? m[1].toUpperCase() : '';
}
function nombresDeTxtPareja(t) {
  const s = txt(t);
  const m = /^[A-Za-z]+\d+\s*·\s*(.+)$/.exec(s);
  return m ? m[1].trim() : s;
}
// Acepta "6-4", "6/4", "6 4" y también solo números (el teclado del celu no
// tiene guion): "64" = 6-4, "76" = 7-6, "108" = 10-8, "810" = 8-10, "1210" = 12-10.
function pareceSetValido(a, b) {
  const g = Math.max(a, b), p = Math.min(a, b);
  if (g === 6 && p <= 4) return true;
  if (g === 7 && (p === 5 || p === 6)) return true;
  return g >= 10 && g - p >= 2 && (g === 10 || g - p === 2);
}
function parsearSet(t) {
  const s = txt(t).replace(/\s+/g, '');
  if (/^\d{2,4}$/.test(s)) {
    for (let i = 1; i < s.length; i++) {
      const x = s.slice(0, i), y = s.slice(i);
      if (x.length > 2 || y.length > 2) continue;
      const a = parseInt(x, 10), b = parseInt(y, 10);
      if (pareceSetValido(a, b)) return { a, b };
    }
    return null;
  }
  const m = /^(\d{1,2})\s*[-\/\s.:]\s*(\d{1,2})$/.exec(txt(t));
  if (!m) return null;
  const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
  if (a === b) return null;
  return { a, b };
}
function esHora(h) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(h); }
function esFechaISO(f) { return /^\d{4}-\d{2}-\d{2}$/.test(f) && !isNaN(Date.parse(f + 'T00:00:00Z')); }
function normalizarHora(h) {
  const m = /^(\d{1,2}):(\d{2})/.exec(txt(h));
  return m ? String(m[1]).padStart(2, '0') + ':' + m[2] : txt(h);
}
function seSuperponen(i1, f1, i2, f2) { return i1 < f2 && i2 < f1; }

// ---------------------------------------------------------------------
// Fechas (siempre en hora de Córdoba)
// ---------------------------------------------------------------------
function isoDeMs(ms) { return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10); }
function hoyISO() { return isoDeMs(Date.now()); }
function horaActual() { return new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(11, 16); }
function diaSemana(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); }
function sumarDias(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function finReservaMs(fecha, hora) { return Date.parse(fecha + 'T' + hora + ':00-03:00'); }

// ---------------------------------------------------------------------
// Aleatorios / firmas
// ---------------------------------------------------------------------
function uuid() { return crypto.randomUUID(); }
function codigoReserva() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALFABETO_CODIGO[b % ALFABETO_CODIGO.length];
  return s;
}
const enc = new TextEncoder();
async function hmacB64WebSafe(clave, mensaje) {
  const k = await crypto.subtle.importKey('raw', enc.encode(clave), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(mensaje)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  // Igual que Utilities.base64EncodeWebSafe de Apps Script (con "=" al final),
  // así los accesos ya guardados en los celulares siguen valiendo.
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
}
function igualesSeguro(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function base64ABytes(b64) {
  const s = String(b64 || '');
  const i = s.indexOf('base64,');
  const limpio = (i === -1 ? s : s.substring(i + 7)).replace(/\s/g, '');
  const bin = atob(limpio);
  const out = new Uint8Array(bin.length);
  for (let j = 0; j < bin.length; j++) out[j] = bin.charCodeAt(j);
  return out;
}

// ---------------------------------------------------------------------
// Claves
// ---------------------------------------------------------------------
const claveAcceso = (env) => env.CLAVE_ACCESO_LIGA || 'padel360';
const versionAcceso = (env) => env.ACCESO_LIGA_VERSION || 'v1';
const claveAdmin = (env) => env.CLAVE_ADMIN || 'admin360padel';
function tokenAcceso(env) {
  return hmacB64WebSafe(claveAcceso(env) + '|' + versionAcceso(env), 'acceso-liga-master-padel-360');
}
async function crearTokenAdmin(env) {
  const exp = Date.now() + ADMIN_TOKEN_DIAS * 24 * 60 * 60 * 1000;
  return exp + '.' + (await hmacB64WebSafe(claveAdmin(env), 'admin|' + exp));
}
async function tokenAdminValido(env, token) {
  const partes = String(token || '').split('.');
  if (partes.length !== 2) return false;
  const exp = Number(partes[0]);
  if (!exp || exp < Date.now()) return false;
  return igualesSeguro(partes[1], await hmacB64WebSafe(claveAdmin(env), 'admin|' + exp));
}
async function exigirAdmin(c) {
  const d = c.datos;
  if (d.tokenAdmin && (await tokenAdminValido(c.env, d.tokenAdmin))) return;
  if (d.clave && igualesSeguro(txt(d.clave), claveAdmin(c.env))) return;
  if (d.tokenAdmin) falla('Tu sesión de organizador venció. Volvé a entrar con tu contraseña.');
  falla('Contraseña de administrador incorrecta.');
}

// ---------------------------------------------------------------------
// Acceso a la base
// ---------------------------------------------------------------------
async function todos(db, sql, ...params) { return (await db.prepare(sql).bind(...params).all()).results || []; }
async function uno(db, sql, ...params) { return db.prepare(sql).bind(...params).first(); }
async function ejecutar(db, sql, ...params) { return db.prepare(sql).bind(...params).run(); }

async function leerConfig(db) {
  const filas = await todos(db, 'SELECT clave, valor FROM config');
  const c = {};
  for (const f of filas) c[f.clave] = f.valor;
  return {
    valorTurno: Number(c.valor_turno) || 36000,
    montoSena: Number(c.monto_sena) || 9000,
    alias: c.alias || 'masterpadel.360',
    ventanaDias: Number(c.ventana_dias) || 14,
    retencionMinutos: Number(c.retencion_minutos) || 10,
    cantidadCanchas: Number(c.cantidad_canchas) || 3,
    fechaInicioLiga: esFechaISO(c.fecha_inicio_liga || '') ? c.fecha_inicio_liga : '2026-09-14',
    playoffsMensaje: c.playoffs_mensaje || '',
  };
}
async function leerGrilla(db) {
  const filas = await todos(db, 'SELECT id, dia, inicio, fin, canchas FROM grilla ORDER BY dia, inicio');
  const g = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const f of filas) (g[f.dia] = g[f.dia] || []).push({ id: f.id, inicio: f.inicio, fin: f.fin, canchas: f.canchas });
  return g;
}
// Clases fijas semanales (tuyas y de los profes). Ocupan canchas y por eso
// limitan cuántas quedan para la liga en cada turno.
async function leerClases(db) {
  const filas = await todos(db, 'SELECT * FROM clases ORDER BY dia, inicio');
  const porDia = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const f of filas) (porDia[f.dia] = porDia[f.dia] || []).push(f);
  return { lista: filas, porDia };
}
// Turnos especiales cargados para una fecha puntual (ej: "este sábado de 9 a 21").
async function leerTurnosFecha(db, desde, hasta) {
  const filas = await todos(db, 'SELECT * FROM turnos_fecha WHERE fecha BETWEEN ? AND ? ORDER BY fecha, inicio', desde, hasta);
  const t = {};
  for (const f of filas) (t[f.fecha] = t[f.fecha] || []).push(f);
  return t;
}
// Máximo de canchas ocupadas A LA VEZ por clases dentro de un horario
// (dos clases seguidas en la misma cancha, ej. 15-19 y 19-21, cuentan 1).
function clasesSimultaneas(clasesDia, ini, fin) {
  const rel = (clasesDia || []).filter((k) => seSuperponen(k.inicio, k.fin, ini, fin));
  let max = 0;
  const puntos = [ini].concat(rel.map((k) => (k.inicio > ini ? k.inicio : ini)));
  for (const p of puntos) {
    let n = 0;
    for (const k of rel) if (k.inicio <= p && p < k.fin) n += Number(k.canchas) || 1;
    if (n > max) max = n;
  }
  return max;
}
function libresSegunClases(cfg, clasesDia, ini, fin) {
  return Math.max(0, cfg.cantidadCanchas - clasesSimultaneas(clasesDia, ini, fin));
}
async function cargarBase(db, desde, hasta, cfg) {
  const [c, grilla, clases, turnos] = await Promise.all([cfg ? cfg : leerConfig(db), leerGrilla(db), leerClases(db), leerTurnosFecha(db, desde, hasta)]);
  return { cfg: c, grilla, clases, turnos };
}
// Turnos ofrecidos un día puntual = los de la semana + los especiales de esa
// fecha. "cap" = canchas para la liga: lo configurado, pero nunca más de lo
// que dejan libre las clases fijas de ese día.
function franjasDeFecha(base, fecha) {
  const dia = diaSemana(fecha);
  const clasesDia = base.clases.porDia[dia] || [];
  const out = [];
  for (const f of base.grilla[dia] || []) out.push({ inicio: f.inicio, fin: f.fin, canchas: f.canchas, especial: false });
  for (const f of base.turnos[fecha] || []) {
    const ya = out.find((x) => x.inicio === f.inicio && x.fin === f.fin);
    if (ya) { ya.canchas = Math.max(ya.canchas, f.canchas); ya.especial = true; ya.idEspecial = f.id; }
    else out.push({ inicio: f.inicio, fin: f.fin, canchas: f.canchas, especial: true, idEspecial: f.id });
  }
  out.sort((a, b) => a.inicio.localeCompare(b.inicio) || a.fin.localeCompare(b.fin));
  for (const f of out) {
    f.porClases = libresSegunClases(base.cfg, clasesDia, f.inicio, f.fin);
    f.cap = Math.min(f.canchas, f.porClases);
  }
  return out;
}
function franjaDe(base, fecha, inicio, fin) {
  return franjasDeFecha(base, fecha).find((f) => f.inicio === inicio && f.fin === fin) || null;
}
function ventanaReservable(cfg) {
  const hoy = hoyISO();
  const minimo = cfg.fechaInicioLiga > hoy ? cfg.fechaInicioLiga : hoy;
  return { minimo, maximo: sumarDias(hoy, cfg.ventanaDias) };
}
// Turno que ya empezó hoy: no se ofrece más.
function franjaYaEmpezo(fecha, inicio) {
  return fecha < hoyISO() || (fecha === hoyISO() && inicio <= horaActual());
}

// Estado de una reserva, calculado igual que la fórmula de la planilla.
function estadoReserva(r, ahora = Date.now()) {
  if (r.rechazada_ts) return EST.RECHAZADO;
  if (r.cancelada_ts) return EST.CANCELADO;
  if (!r.aprobada_ts) return EST.PENDIENTE_APROBACION;
  if (ahora > finReservaMs(r.fecha, r.hora_fin)) return EST.FINALIZADO;
  return EST.RESERVADO;
}
const ACTIVA_SQL = 'rechazada_ts IS NULL AND cancelada_ts IS NULL';

// URLs de archivos guardados en la base ("archivo:ID") → link real del Worker.
function urlPublica(c, valor) {
  const v = txt(valor);
  if (!v) return '';
  if (v.startsWith('archivo:')) return c.origen + '/?accion=archivo&id=' + encodeURIComponent(v.slice(8));
  // Link de "Compartir" de Google Drive → link de imagen directa.
  const m = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{10,})/.exec(v);
  if (m) return 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w1600';
  return v;
}

// ---------------------------------------------------------------------
// Parejas / partidos
// ---------------------------------------------------------------------
async function mapaParejas(db, categoria) {
  const filas = categoria
    ? await todos(db, 'SELECT * FROM parejas WHERE categoria = ?', categoria)
    : await todos(db, 'SELECT * FROM parejas');
  const m = {};
  for (const p of filas) m[p.id] = p;
  return { filas, mapa: m };
}
function nombreLado(mapa, id, respaldo) {
  return mapa[id] ? nombrePareja(mapa[id]) : nombresDeTxtPareja(respaldo);
}
async function categoriasOrdenadas(db) {
  return todos(db, 'SELECT nombre, orden, fecha_en_juego FROM categorias ORDER BY orden, nombre');
}

// Tabla de posiciones: misma lógica y mismos desempates que CodigoAdminLiga.gs
//   1) puntos  2) dif. sets  3) dif. games  4) enfrentamiento directo  5) ID
function calcularPosiciones(parejasActivas, partidosJugados) {
  const stats = {};
  for (const p of parejasActivas) {
    stats[p.id] = { id: p.id, pareja: nombrePareja(p), clave: p.id + ' · ' + nombrePareja(p), pj: 0, pg: 0, pp: 0, puntos: 0, setsFavor: 0, setsContra: 0, gamesFavor: 0, gamesContra: 0 };
  }
  const h2h = {};
  for (const pt of partidosJugados) {
    const idA = pt.pareja_a_id, idB = pt.pareja_b_id, g = pt.ganador_id;
    let sA = 0, sB = 0, gA = 0, gB = 0;
    for (const s of [pt.set1, pt.set2, pt.set3].map(parsearSet)) {
      if (!s) continue;
      gA += s.a; gB += s.b;
      if (s.a > s.b) sA++; else sB++;
    }
    const a = stats[idA], b = stats[idB];
    if (a) { a.pj++; a.setsFavor += sA; a.setsContra += sB; a.gamesFavor += gA; a.gamesContra += gB; if (g === idA) { a.pg++; a.puntos++; } else if (g === idB) a.pp++; }
    if (b) { b.pj++; b.setsFavor += sB; b.setsContra += sA; b.gamesFavor += gB; b.gamesContra += gA; if (g === idB) { b.pg++; b.puntos++; } else if (g === idA) b.pp++; }
    if (idA && idB && g) h2h[[idA, idB].sort().join('|')] = g;
  }
  const lista = Object.values(stats);
  lista.sort((a, b) => {
    if (b.puntos !== a.puntos) return b.puntos - a.puntos;
    const ds = (b.setsFavor - b.setsContra) - (a.setsFavor - a.setsContra);
    if (ds) return ds;
    const dg = (b.gamesFavor - b.gamesContra) - (a.gamesFavor - a.gamesContra);
    if (dg) return dg;
    const w = h2h[[a.id, b.id].sort().join('|')];
    if (w === a.id) return -1;
    if (w === b.id) return 1;
    return a.clave.localeCompare(b.clave);
  });
  return lista.map((s, i) => ({
    pos: i + 1, idPareja: s.id, pareja: s.pareja, pj: s.pj, pg: s.pg, pp: s.pp, pts: s.puntos,
    setsFavor: s.setsFavor, setsContra: s.setsContra, difSets: s.setsFavor - s.setsContra,
    gamesFavor: s.gamesFavor, gamesContra: s.gamesContra, difGames: s.gamesFavor - s.gamesContra,
  }));
}

// Resultado de un partido a partir de sus sets (al mejor de 3).
function resolverResultado(set1, set2, set3, idA, idB) {
  const limpios = [set1, set2, set3].map((s, i) => {
    const t = txt(s);
    if (!t) return '';
    const p = parsearSet(t);
    if (!p) falla('El set ' + (i + 1) + ' ("' + t + '") no es válido. Escribí los games, por ejemplo 64 (= 6-4) o 108 (= 10-8).');
    return p.a + '-' + p.b;
  });
  let sA = 0, sB = 0;
  for (const s of limpios.map(parsearSet)) { if (!s) continue; if (s.a > s.b) sA++; else sB++; }
  const jugado = sA >= 2 || sB >= 2;
  return { set1: limpios[0], set2: limpios[1], set3: limpios[2], estado: jugado ? JUGADO : PENDIENTE, ganadorId: jugado ? (sA > sB ? idA : idB) : '' };
}

// Todos contra todos, método del círculo (igual que generarRoundRobin_).
function roundRobin(parejas) {
  const lista = parejas.slice();
  if (lista.length % 2 !== 0) lista.push(null);
  const n = lista.length, arr = lista.slice(), rondas = [];
  for (let r = 0; r < n - 1; r++) {
    const ronda = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i], b = arr[n - 1 - i];
      if (a && b) ronda.push({ a, b });
    }
    rondas.push(ronda);
    const ultimo = arr[n - 1];
    for (let j = n - 1; j > 1; j--) arr[j] = arr[j - 1];
    arr[1] = ultimo;
  }
  return rondas;
}

// =====================================================================
// ACCIONES PÚBLICAS — lectura deportiva y contenido
// =====================================================================
async function aBootstrap(c) {
  const cats = await categoriasOrdenadas(c.db);
  const [novedades, sponsors] = await Promise.all([leerNovedades(c), leerSponsorsActivos(c)]);
  const fechasEnJuego = {};
  for (const x of cats) fechasEnJuego[x.nombre] = x.fecha_en_juego;
  return { categorias: cats.map((x) => x.nombre), fechasEnJuego, inicio: { novedades, sponsors } };
}
async function aCategorias(c) {
  return (await categoriasOrdenadas(c.db)).map((x) => x.nombre);
}
async function aPosiciones(c) {
  const cat = txt(c.datos.categoria);
  const [parejas, jugados] = await Promise.all([
    todos(c.db, "SELECT * FROM parejas WHERE categoria = ? AND estado = 'ACTIVA'", cat),
    todos(c.db, 'SELECT * FROM partidos WHERE categoria = ? AND estado = ?', cat, JUGADO),
  ]);
  return calcularPosiciones(parejas, jugados);
}
async function aFixture(c) {
  const cat = txt(c.datos.categoria);
  const [{ filas, mapa }, partidos] = await Promise.all([
    mapaParejas(c.db, cat),
    todos(c.db, 'SELECT * FROM partidos WHERE categoria = ? ORDER BY fecha, id', cat),
  ]);
  const activas = filas.filter((p) => p.estado === 'ACTIVA');
  const porFecha = new Map();
  for (const p of partidos) {
    if (!porFecha.has(p.fecha)) porFecha.set(p.fecha, []);
    porFecha.get(p.fecha).push(p);
  }
  const fechas = [];
  for (const [numero, lista] of porFecha) {
    const juegan = new Set();
    const items = lista.map((p) => {
      juegan.add(p.pareja_a_id); juegan.add(p.pareja_b_id);
      const parejaA = nombreLado(mapa, p.pareja_a_id, p.pareja_a_txt);
      const parejaB = nombreLado(mapa, p.pareja_b_id, p.pareja_b_txt);
      return {
        idPartido: p.id, parejaA, parejaB,
        sets: [p.set1, p.set2, p.set3].filter(Boolean),
        ganador: p.ganador_id === p.pareja_a_id ? parejaA : p.ganador_id === p.pareja_b_id ? parejaB : '',
        estado: p.estado,
      };
    });
    fechas.push({ numero, partidos: items, libres: activas.filter((p) => !juegan.has(p.id)).map(nombrePareja) });
  }
  return { fechas };
}
async function aResultados(c) {
  const cat = txt(c.datos.categoria);
  const [{ mapa }, jugados] = await Promise.all([
    mapaParejas(c.db, cat),
    todos(c.db, 'SELECT * FROM partidos WHERE categoria = ? AND estado = ? ORDER BY fecha DESC, id', cat, JUGADO),
  ]);
  return jugados.map((p) => {
    const parejaA = nombreLado(mapa, p.pareja_a_id, p.pareja_a_txt);
    const parejaB = nombreLado(mapa, p.pareja_b_id, p.pareja_b_txt);
    return {
      idPartido: p.id, fecha: p.fecha, parejaA, parejaB,
      sets: [p.set1, p.set2, p.set3].filter(Boolean),
      ganador: p.ganador_id === p.pareja_a_id ? parejaA : parejaB,
    };
  });
}
async function leerNovedades(c) {
  const filas = await todos(c.db, "SELECT titulo, texto, imagen, link FROM contenido WHERE tipo = 'NOVEDAD' AND activo = 1 ORDER BY orden, id");
  return filas.map((f) => ({ titulo: f.titulo, texto: f.texto, imagen: urlPublica(c, f.imagen), link: f.link }));
}
async function leerSponsorsActivos(c) {
  const filas = await todos(c.db, 'SELECT * FROM sponsors WHERE activo = 1 ORDER BY destacado DESC, orden, id');
  return filas.map((s) => ({ nombre: s.nombre, logoUrl: urlPublica(c, s.logo_url), link: s.link, destacado: !!s.destacado }));
}
async function aMas(c) {
  const [cfg, filas] = await Promise.all([
    leerConfig(c.db),
    todos(c.db, 'SELECT tipo, titulo, texto FROM contenido WHERE activo = 1 ORDER BY orden, id'),
  ]);
  return {
    playoffsMensaje: cfg.playoffsMensaje,
    premios: filas.filter((f) => f.tipo.startsWith('PREMIO')).map((f) => ({ titulo: f.titulo, texto: f.texto })),
    reglamento: filas.filter((f) => f.tipo === 'REGLAMENTO').map((f) => ({ titulo: f.titulo, texto: f.texto })),
  };
}
async function aGaleria(c) {
  const filas = await todos(c.db, 'SELECT * FROM fotos ORDER BY orden, creado_ts DESC');
  return filas.map((f) => ({ id: f.id, url: urlPublica(c, f.url), titulo: f.titulo, categoria: f.categoria }));
}
async function aSponsors(c) {
  const lista = await leerSponsorsActivos(c);
  const destacado = lista.find((s) => s.destacado) || null;
  return { destacado, resto: lista.filter((s) => s !== destacado) };
}

// =====================================================================
// ACCIONES PÚBLICAS — acceso general
// =====================================================================
async function aVerificarAcceso(c) {
  if (!igualesSeguro(txt(c.datos.clave), claveAcceso(c.env))) falla('Contraseña incorrecta.');
  return { token: await tokenAcceso(c.env), version: versionAcceso(c.env) };
}
async function aValidarTokenAcceso(c) {
  const token = txt(c.datos.token), version = txt(c.datos.version);
  const valido = !!token && version === versionAcceso(c.env) && igualesSeguro(token, await tokenAcceso(c.env));
  return { valido };
}

// =====================================================================
// ACCIONES PÚBLICAS — reservas
// =====================================================================
async function aDisponibilidad(c) {
  const cfg = await leerConfig(c.db);
  const { minimo, maximo } = ventanaReservable(cfg);
  const corte = Date.now() - cfg.retencionMinutos * 60000;
  const [base, reservas, retenciones, bloqueos] = await Promise.all([
    cargarBase(c.db, minimo, maximo, cfg),
    todos(c.db, `SELECT fecha, hora_inicio, hora_fin FROM reservas WHERE fecha BETWEEN ? AND ? AND ${ACTIVA_SQL}`, minimo, maximo),
    todos(c.db, 'SELECT fecha, hora_inicio, hora_fin FROM retenciones WHERE fecha BETWEEN ? AND ? AND creada_ts > ?', minimo, maximo, corte),
    todos(c.db, 'SELECT fecha, hora_inicio, hora_fin, cancha FROM bloqueos WHERE fecha BETWEEN ? AND ?', minimo, maximo),
  ]);
  const dias = [];
  for (let f = minimo; f <= maximo; f = sumarDias(f, 1)) {
    const franjas = [];
    for (const fr of franjasDeFecha(base, f)) {
      if (franjaYaEmpezo(f, fr.inicio)) continue;
      const ocupadas = contarOcupadas(cfg, reservas, retenciones, bloqueos, f, fr.inicio, fr.fin);
      const disponibles = Math.max(0, fr.cap - ocupadas);
      if (disponibles > 0) franjas.push({ inicio: fr.inicio, fin: fr.fin, disponibles });
    }
    if (franjas.length) dias.push({ fecha: f, diaSemana: NOMBRES_DIA[diaSemana(f)], franjas });
  }
  return { dias };
}
function contarOcupadas(cfg, reservas, retenciones, bloqueos, fecha, ini, fin) {
  let n = 0;
  for (const r of reservas) if (r.fecha === fecha && seSuperponen(r.hora_inicio, r.hora_fin, ini, fin)) n++;
  for (const r of retenciones) if (r.fecha === fecha && seSuperponen(r.hora_inicio, r.hora_fin, ini, fin)) n++;
  for (const b of bloqueos) if (b.fecha === fecha && seSuperponen(b.hora_inicio, b.hora_fin, ini, fin)) n += mayus(b.cancha) === 'TODAS' ? cfg.cantidadCanchas : 1;
  return n;
}

async function aPartidosDisponibles(c) {
  const cat = txt(c.datos.categoria);
  const categoria = await uno(c.db, 'SELECT * FROM categorias WHERE nombre = ?', cat);
  if (!categoria || categoria.fecha_en_juego === null || categoria.fecha_en_juego === undefined) return [];
  const cfg = await leerConfig(c.db);
  const corte = Date.now() - cfg.retencionMinutos * 60000;
  const [{ mapa }, partidos] = await Promise.all([
    mapaParejas(c.db, cat),
    todos(c.db, `SELECT p.* FROM partidos p
      WHERE p.categoria = ? AND p.estado = ? AND p.fecha <= ?
        AND NOT EXISTS (SELECT 1 FROM reservas r WHERE r.id_partido = p.id AND r.rechazada_ts IS NULL AND r.cancelada_ts IS NULL)
        AND NOT EXISTS (SELECT 1 FROM retenciones t WHERE t.id_partido = p.id AND t.creada_ts > ?)
      ORDER BY p.fecha, p.id`, cat, PENDIENTE, categoria.fecha_en_juego, corte),
  ]);
  return partidos.map((p) => ({
    idPartido: p.id, fecha: p.fecha,
    parejaA: nombreLado(mapa, p.pareja_a_id, p.pareja_a_txt),
    parejaB: nombreLado(mapa, p.pareja_b_id, p.pareja_b_txt),
  }));
}

async function datosPartido(db, idPartido) {
  const p = await uno(db, 'SELECT * FROM partidos WHERE id = ?', idPartido);
  if (!p) return null;
  const parejas = await todos(db, 'SELECT * FROM parejas WHERE id IN (?, ?)', p.pareja_a_id, p.pareja_b_id);
  const mapa = {};
  for (const x of parejas) mapa[x.id] = x;
  return { ...p, parejaA: nombreLado(mapa, p.pareja_a_id, p.pareja_a_txt), parejaB: nombreLado(mapa, p.pareja_b_id, p.pareja_b_txt) };
}

async function aRetenerTurno(c) {
  const d = c.datos;
  const idPartido = txt(d.idPartido), fecha = txt(d.fecha);
  const inicio = normalizarHora(d.horarioInicio), fin = normalizarHora(d.horarioFin);
  if (!idPartido || !esFechaISO(fecha) || !esHora(inicio) || !esHora(fin)) falla('Faltan datos para retener el turno.');
  const cfg = await leerConfig(c.db);
  const { minimo, maximo } = ventanaReservable(cfg);
  if (fecha < minimo || fecha > maximo) falla('Esa fecha está fuera de la ventana de reserva permitida.');
  const franja = franjaDe(await cargarBase(c.db, fecha, fecha, cfg), fecha, inicio, fin);
  if (!franja || franja.cap < 1) falla('Ese horario no es un turno válido para ese día.');
  if (franjaYaEmpezo(fecha, inicio)) falla('Ese turno ya empezó. Elegí otro horario.');

  const partido = await datosPartido(c.db, idPartido);
  if (!partido) falla('No se encontró ese partido.');
  if (partido.estado !== PENDIENTE) falla('Ese partido ya no está pendiente de jugarse.');
  const categoria = await uno(c.db, 'SELECT fecha_en_juego FROM categorias WHERE nombre = ?', partido.categoria);
  if (!categoria || categoria.fecha_en_juego === null || partido.fecha > categoria.fecha_en_juego) falla('Ese partido todavía no está habilitado para reservar.');

  const ahora = Date.now();
  const corte = ahora - cfg.retencionMinutos * 60000;
  const idRetencion = uuid();
  // UNA sola instrucción: inserta la retención SOLO si el cruce sigue libre
  // y todavía queda lugar en la franja. La base ejecuta las escrituras de a
  // una, así que dos personas jamás pueden quedarse con el mismo lugar.
  const res = await ejecutar(c.db, `
    INSERT INTO retenciones (id, fecha, hora_inicio, hora_fin, id_partido, creada_ts)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6
    WHERE EXISTS (SELECT 1 FROM partidos WHERE id = ?5 AND estado = 'PENDIENTE')
      AND NOT EXISTS (SELECT 1 FROM reservas WHERE id_partido = ?5 AND ${ACTIVA_SQL})
      AND NOT EXISTS (SELECT 1 FROM retenciones WHERE id_partido = ?5 AND creada_ts > ?7)
      AND (
        (SELECT COUNT(*) FROM reservas WHERE fecha = ?2 AND hora_inicio < ?4 AND ?3 < hora_fin AND ${ACTIVA_SQL})
      + (SELECT COUNT(*) FROM retenciones WHERE fecha = ?2 AND hora_inicio < ?4 AND ?3 < hora_fin AND creada_ts > ?7)
      + (SELECT COALESCE(SUM(CASE WHEN UPPER(cancha) = 'TODAS' THEN ?9 ELSE 1 END), 0) FROM bloqueos WHERE fecha = ?2 AND hora_inicio < ?4 AND ?3 < hora_fin)
      ) < ?8`,
    idRetencion, fecha, inicio, fin, idPartido, ahora, corte, franja.cap, cfg.cantidadCanchas);

  if (!res.meta || res.meta.changes !== 1) {
    const ocupado = await uno(c.db, `SELECT
        (SELECT COUNT(*) FROM reservas WHERE id_partido = ?1 AND ${ACTIVA_SQL}) +
        (SELECT COUNT(*) FROM retenciones WHERE id_partido = ?1 AND creada_ts > ?2) AS n`, idPartido, corte);
    if (ocupado && ocupado.n > 0) falla('Ese cruce ya tiene una reserva en curso. Elegí otro.');
    falla('Ese horario ya no tiene lugar disponible.');
  }
  c.ctx.waitUntil(ejecutar(c.db, 'DELETE FROM retenciones WHERE creada_ts < ?', ahora - 24 * 60 * 60 * 1000).catch(() => {}));

  return {
    idRetencion, minutos: cfg.retencionMinutos, valorTotal: cfg.valorTurno, montoSena: cfg.montoSena, alias: cfg.alias,
    fecha, horarioInicio: inicio, horarioFin: fin, categoria: partido.categoria, parejaA: partido.parejaA, parejaB: partido.parejaB,
  };
}

function formatoReservaJugador(r) {
  return {
    idReserva: r.id, fecha: r.fecha, horarioInicio: r.hora_inicio, horarioFin: r.hora_fin, cancha: r.cancha,
    categoria: r.categoria, parejaA: r.pareja_a, parejaB: r.pareja_b,
    valorTotal: r.valor_total, montoPagado: r.monto_pagado, saldoPendiente: r.valor_total - r.monto_pagado,
    estadoReserva: estadoReserva(r), estadoPago: r.estado_pago,
  };
}
function formatoConfirmacion(r) {
  return { ...formatoReservaJugador(r), tokenGestion: r.token, codigoReserva: r.codigo };
}

async function aConfirmarReserva(c) {
  const d = c.datos;
  const idRetencion = txt(d.idRetencion);
  const nombre = txt(d.nombre).substring(0, 120);
  const telefono = txt(d.telefono).substring(0, 40);
  if (!idRetencion || !nombre || !telefono || !d.comprobanteBase64) {
    falla('Faltan datos para confirmar la reserva (nombre, teléfono y comprobante son obligatorios).');
  }

  // Idempotencia: si este mismo pedido ya se procesó (se cortó la respuesta
  // y el celular reintenta), se devuelve la reserva ya creada.
  const previa = await uno(c.db, 'SELECT * FROM reservas WHERE id_retencion_origen = ?', idRetencion);
  if (previa) return formatoConfirmacion(previa);

  const cfg = await leerConfig(c.db);
  const ret = await uno(c.db, 'SELECT * FROM retenciones WHERE id = ?', idRetencion);
  if (!ret) falla('Tu retención ya no existe. Elegí el turno de nuevo.');
  const corte = Date.now() - cfg.retencionMinutos * 60000;
  if (ret.creada_ts <= corte) {
    await ejecutar(c.db, 'DELETE FROM retenciones WHERE id = ?', idRetencion);
    falla('Se venció el tiempo de ' + cfg.retencionMinutos + ' minutos para completar la reserva. Elegí el turno de nuevo.');
  }
  const partido = await datosPartido(c.db, ret.id_partido);
  if (!partido) falla('No se encontró el partido asociado a esta retención.');

  const mime = txt(d.comprobanteTipoMime) || 'image/jpeg';
  if (!MIMES_COMPROBANTE.includes(mime)) falla('El comprobante tiene que ser una imagen (JPG o PNG) o un PDF.');
  let bytes;
  try { bytes = base64ABytes(d.comprobanteBase64); } catch (e) { falla('No se pudo leer el comprobante. Probá subirlo de nuevo.'); }
  if (!bytes.length) falla('El comprobante llegó vacío. Probá subirlo de nuevo.');
  if (bytes.length > MAX_ARCHIVO_BYTES) falla('El comprobante pesa demasiado. Subí una captura de pantalla.');

  const idArchivo = uuid();
  await ejecutar(c.db, 'INSERT INTO archivos (id, tipo, mime, nombre, datos, creado_ts) VALUES (?, ?, ?, ?, ?, ?)',
    idArchivo, 'comprobante', mime, (ret.id_partido + '_' + txt(d.comprobanteNombreArchivo || 'comprobante')).substring(0, 160), bytes.buffer, Date.now());

  try {
    for (let cancha = 1; cancha <= cfg.cantidadCanchas; cancha++) {
      for (let intento = 0; intento < 3; intento++) {
        let res;
        try {
          res = await c.db.batch([
            c.db.prepare(`
              INSERT INTO reservas (id, token, codigo, fecha, hora_inicio, hora_fin, cancha, categoria, id_partido,
                id_pareja_a, pareja_a, id_pareja_b, pareja_b, nombre, telefono, valor_total, monto_pagado,
                estado_pago, comprobante_id, creada_ts, id_retencion_origen)
              SELECT
                (SELECT 'R' || printf('%04d', COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) + 1) FROM reservas),
                ?2, ?3, t.fecha, t.hora_inicio, t.hora_fin, ?4, ?5, t.id_partido,
                ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'SALDO_PENDIENTE', ?14, ?15, t.id
              FROM retenciones t
              WHERE t.id = ?1 AND t.creada_ts > ?16
                AND EXISTS (SELECT 1 FROM partidos WHERE id = t.id_partido AND estado = 'PENDIENTE')
                AND NOT EXISTS (SELECT 1 FROM reservas r WHERE r.id_partido = t.id_partido AND r.rechazada_ts IS NULL AND r.cancelada_ts IS NULL)
                AND NOT EXISTS (SELECT 1 FROM retenciones o WHERE o.id_partido = t.id_partido AND o.id <> t.id AND o.creada_ts > ?16)
                AND NOT EXISTS (SELECT 1 FROM reservas r WHERE r.fecha = t.fecha AND r.cancha = ?4
                      AND r.hora_inicio < t.hora_fin AND t.hora_inicio < r.hora_fin AND r.rechazada_ts IS NULL AND r.cancelada_ts IS NULL)
                AND NOT EXISTS (SELECT 1 FROM bloqueos b WHERE b.fecha = t.fecha AND (UPPER(b.cancha) = 'TODAS' OR b.cancha = CAST(?4 AS TEXT))
                      AND b.hora_inicio < t.hora_fin AND t.hora_inicio < b.hora_fin)`)
              .bind(idRetencion, uuid(), codigoReserva(), cancha, partido.categoria,
                partido.pareja_a_id, partido.parejaA, partido.pareja_b_id, partido.parejaB,
                nombre, telefono, cfg.valorTurno, cfg.montoSena, idArchivo, Date.now(), corte),
            c.db.prepare('DELETE FROM retenciones WHERE id = ?1 AND EXISTS (SELECT 1 FROM reservas WHERE id_retencion_origen = ?1)').bind(idRetencion),
          ]);
        } catch (e) {
          // Choque de código/ID único (muy raro): se reintenta con otro.
          if (/UNIQUE/i.test(String(e && e.message))) {
            const ya = await uno(c.db, 'SELECT * FROM reservas WHERE id_retencion_origen = ?', idRetencion);
            if (ya) return formatoConfirmacion(ya);
            continue;
          }
          throw e;
        }
        if (res[0].meta && res[0].meta.changes === 1) {
          const nueva = await uno(c.db, 'SELECT * FROM reservas WHERE id_retencion_origen = ?', idRetencion);
          return formatoConfirmacion(nueva);
        }
        break; // no se insertó: averiguar por qué
      }
      // ¿Por qué no entró en esta cancha?
      const ya = await uno(c.db, 'SELECT * FROM reservas WHERE id_retencion_origen = ?', idRetencion);
      if (ya) { await borrarArchivo(c.db, idArchivo); return formatoConfirmacion(ya); }
      const t = await uno(c.db, 'SELECT * FROM retenciones WHERE id = ?', idRetencion);
      if (!t || t.creada_ts <= corte) falla('Se venció el tiempo de ' + cfg.retencionMinutos + ' minutos para completar la reserva. Elegí el turno de nuevo.');
      const p = await uno(c.db, 'SELECT estado FROM partidos WHERE id = ?', t.id_partido);
      if (!p || p.estado !== PENDIENTE) falla('Ese partido ya no está pendiente de jugarse. Tu retención quedó sin efecto.');
      const otro = await uno(c.db, `SELECT
          (SELECT COUNT(*) FROM reservas WHERE id_partido = ?1 AND ${ACTIVA_SQL}) +
          (SELECT COUNT(*) FROM retenciones WHERE id_partido = ?1 AND id <> ?2 AND creada_ts > ?3) AS n`, t.id_partido, idRetencion, corte);
      if (otro && otro.n > 0) falla('Ese cruce ya fue reservado por otra persona mientras completabas el formulario. Elegí otro turno.');
      // Si no, esta cancha puntual estaba ocupada: se prueba la siguiente.
    }
    falla('Ya no queda ninguna cancha libre para ese horario. Elegí otro turno.');
  } catch (e) {
    await borrarArchivo(c.db, idArchivo);
    throw e;
  }
}
async function borrarArchivo(db, id) {
  await ejecutar(db, 'DELETE FROM archivos WHERE id = ? AND NOT EXISTS (SELECT 1 FROM reservas WHERE comprobante_id = ?)', id, id).catch(() => {});
}

async function aConsultarReserva(c) {
  const token = txt(c.datos.token);
  if (!token) falla('Falta el token de gestión.');
  const r = await uno(c.db, 'SELECT * FROM reservas WHERE token = ?', token);
  if (!r) falla('No se encontró ninguna reserva con ese enlace.');
  return formatoReservaJugador(r);
}
async function aBuscarReserva(c) {
  const tel = soloDigitos(c.datos.telefono), cod = mayus(c.datos.codigo);
  if (!tel || !cod) falla('Ingresá el teléfono y el código de tu reserva.');
  const filas = await todos(c.db, 'SELECT * FROM reservas WHERE UPPER(codigo) = ?', cod);
  // Tolera +54 / 0 / 9 adelante: alcanza con que coincidan los últimos dígitos
  // (mínimo 8). El código de 8 caracteres sigue siendo obligatorio.
  const mismoTel = (a, b) => a === b || (Math.min(a.length, b.length) >= 8 && (a.endsWith(b) || b.endsWith(a)));
  const r = filas.find((x) => mismoTel(soloDigitos(x.telefono), tel));
  if (!r) falla('No encontramos ninguna reserva con esos datos. Revisá el teléfono y el código e intentá de nuevo.');
  return { ...formatoReservaJugador(r), tokenGestion: r.token };
}
async function aCancelarReserva(c) {
  const token = txt(c.datos.token);
  if (!token) falla('Falta el token de gestión.');
  const r = await uno(c.db, 'SELECT * FROM reservas WHERE token = ?', token);
  if (!r) falla('No se encontró ninguna reserva con ese enlace.');
  const e = estadoReserva(r);
  if (e !== EST.RESERVADO) {
    if (e === EST.PENDIENTE_APROBACION) falla('Tu reserva todavía está pendiente de aprobación. Todavía no se puede cancelar -- esperá a que el organizador la revise.');
    if (e === EST.CANCELADO) falla('Esta reserva ya estaba cancelada.');
    if (e === EST.RECHAZADO) falla('Esta solicitud ya fue rechazada -- no hay nada para cancelar.');
    if (e === EST.FINALIZADO) falla('Esta reserva ya se jugó, no se puede cancelar.');
    falla('Esta reserva no se puede cancelar en su estado actual.');
  }
  await ejecutar(c.db, 'UPDATE reservas SET cancelada_ts = ? WHERE id = ? AND cancelada_ts IS NULL AND rechazada_ts IS NULL AND aprobada_ts IS NOT NULL', Date.now(), r.id);
  return { ok: true };
}

// =====================================================================
// ACCIONES DE ORGANIZADOR
// =====================================================================
async function aAdminLogin(c) {
  if (!igualesSeguro(txt(c.datos.clave), claveAdmin(c.env))) falla('Contraseña de organizador incorrecta.');
  return { tokenAdmin: await crearTokenAdmin(c.env) };
}

// ---------- Pagos por jugador ----------
// Cada reserva la pagan 4 jugadores en partes iguales. La seña ya cubre la
// parte de quien reservó; el organizador va tildando a los otros 3.
function sinAcentos(t) { return txt(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function jugadoresDe(r) {
  const a = txt(r.pareja_a).split(' / '), b = txt(r.pareja_b).split(' / ');
  return [a[0], a[1], b[0], b[1]].map((x) => txt(x));
}
function adivinarSena(nombre, jugadores) {
  const palabras = sinAcentos(nombre).split(/\s+/).filter((w) => w.length >= 3);
  let mejor = null, puntos = 0;
  jugadores.forEach((j, i) => {
    const pj = sinAcentos(j).split(/\s+/);
    const n = palabras.filter((w) => pj.includes(w)).length;
    if (n > puntos) { puntos = n; mejor = i; }
  });
  return mejor;
}
function estadoPagos(r) {
  const jugadores = jugadoresDe(r);
  let p = null;
  try { p = r.pagos ? JSON.parse(r.pagos) : null; } catch (e) { p = null; }
  if (!p || !Array.isArray(p.j)) {
    const todos = r.estado_pago === PAGO_COMPLETO;
    p = { j: [todos, todos, todos, todos], sena: adivinarSena(r.nombre, jugadores) };
    if (p.sena !== null && p.sena !== undefined) p.j[p.sena] = true;
  }
  const pagados = [0, 1, 2, 3].map((i) => !!p.j[i]);
  return { jugadores, pagados, sena: p.sena === undefined ? null : p.sena };
}
function guardarPagosSql(db, r, pagos) {
  const n = pagos.pagados.filter(Boolean).length;
  const monto = Math.round((r.valor_total * n) / 4);
  return db.prepare('UPDATE reservas SET pagos = ?, monto_pagado = ?, estado_pago = ? WHERE id = ?')
    .bind(JSON.stringify({ j: pagos.pagados, sena: pagos.sena }), monto, n === 4 ? PAGO_COMPLETO : SALDO_PENDIENTE, r.id);
}
async function mapaPartidosDe(db, reservas) {
  const ids = [...new Set(reservas.map((r) => r.id_partido).filter(Boolean))];
  const m = {};
  for (let i = 0; i < ids.length; i += 90) {
    const lote = ids.slice(i, i + 90);
    const filas = await todos(db, 'SELECT * FROM partidos WHERE id IN (' + lote.map(() => '?').join(',') + ')', ...lote);
    for (const p of filas) m[p.id] = p;
  }
  return m;
}
function formatoReservaAdmin(c, r, tokenAdmin, partidos) {
  const pt = partidos && partidos[r.id_partido];
  const pagos = estadoPagos(r);
  return {
    ...formatoReservaJugador(r),
    codigoReserva: r.codigo, idPartido: r.id_partido,
    nombreSolicitante: r.nombre, telefonoSolicitante: r.telefono,
    comprobanteUrl: r.comprobante_id
      ? c.origen + '/?accion=archivo&id=' + encodeURIComponent(r.comprobante_id) + '&t=' + encodeURIComponent(tokenAdmin)
      : txt(r.comprobante_url),
    fechaCreacion: r.creada_ts ? new Date(r.creada_ts).toISOString() : '',
    aprobadaTs: r.aprobada_ts, rechazadaTs: r.rechazada_ts, canceladaTs: r.cancelada_ts,
    jugadores: pagos.jugadores, pagados: pagos.pagados, senaIndice: pagos.sena,
    partido: pt ? { estado: pt.estado, set1: pt.set1, set2: pt.set2, set3: pt.set3, ganadorId: pt.ganador_id, parejaAId: pt.pareja_a_id, parejaBId: pt.pareja_b_id } : null,
  };
}
async function tokenParaLinks(c) {
  if (c.datos.tokenAdmin && (await tokenAdminValido(c.env, c.datos.tokenAdmin))) return c.datos.tokenAdmin;
  return crearTokenAdmin(c.env);
}

async function aListarPendientes(c) {
  await exigirAdmin(c);
  const t = await tokenParaLinks(c);
  const filas = await todos(c.db, 'SELECT * FROM reservas WHERE aprobada_ts IS NULL AND rechazada_ts IS NULL AND cancelada_ts IS NULL ORDER BY creada_ts');
  return filas.map((r) => formatoReservaAdmin(c, r, t));
}

async function contarPorCerrar(db) {
  const filas = await todos(db, `SELECT * FROM reservas WHERE aprobada_ts IS NOT NULL AND ${ACTIVA_SQL} AND fecha <= ?`, hoyISO());
  const partidos = await mapaPartidosDe(db, filas);
  return filas.filter((r) => etapaReserva(r, partidos[r.id_partido]) === 'porcerrar').length;
}
async function aAdminResumen(c) {
  await exigirAdmin(c);
  const hoy = hoyISO();
  const [pend, prox, cats, cfg] = await Promise.all([
    uno(c.db, 'SELECT COUNT(*) AS n FROM reservas WHERE aprobada_ts IS NULL AND rechazada_ts IS NULL AND cancelada_ts IS NULL'),
    uno(c.db, 'SELECT COUNT(*) AS n FROM reservas WHERE aprobada_ts IS NOT NULL AND rechazada_ts IS NULL AND cancelada_ts IS NULL AND fecha >= ?', hoy),
    todos(c.db, `SELECT c.nombre, c.orden, c.fecha_en_juego,
        (SELECT COUNT(*) FROM parejas p WHERE p.categoria = c.nombre AND p.estado = 'ACTIVA') AS parejas_activas,
        (SELECT COUNT(*) FROM partidos t WHERE t.categoria = c.nombre) AS partidos,
        (SELECT COUNT(*) FROM partidos t WHERE t.categoria = c.nombre AND t.estado = 'JUGADO') AS jugados,
        (SELECT COALESCE(MAX(fecha), 0) FROM partidos t WHERE t.categoria = c.nombre) AS ultima_fecha
      FROM categorias c ORDER BY c.orden, c.nombre`),
    leerConfig(c.db),
  ]);
  return {
    hoy, pendientes: pend.n, proximas: prox.n, porCerrar: await contarPorCerrar(c.db), config: cfg,
    categorias: cats.map((x) => ({ nombre: x.nombre, fechaEnJuego: x.fecha_en_juego, parejasActivas: x.parejas_activas, partidos: x.partidos, jugados: x.jugados, ultimaFecha: x.ultima_fecha })),
  };
}

// Etapas de una reserva para el organizador:
//   pendientes  -> para aprobar
//   proximas    -> confirmadas que todavía no se jugaron
//   porcerrar   -> ya se jugaron pero falta algún pago o el resultado
//   completas   -> jugadas, pagadas al 100% y con resultado
//   rechazadas  -> las que rechazó el organizador
//   historial   -> todas
function etapaReserva(r, partido) {
  const e = estadoReserva(r);
  if (e === EST.PENDIENTE_APROBACION) return 'pendientes';
  if (e === EST.RESERVADO) return 'proximas';
  if (e === EST.RECHAZADO) return 'rechazadas';
  if (e === EST.CANCELADO) return 'canceladas';
  const pagado = estadoPagos(r).pagados.every(Boolean);
  return pagado && partido && partido.estado === JUGADO ? 'completas' : 'porcerrar';
}
async function aAdminReservas(c) {
  await exigirAdmin(c);
  const t = await tokenParaLinks(c);
  const filtro = txt(c.datos.filtro) || 'pendientes';
  let filas;
  if (filtro === 'pendientes') {
    filas = await todos(c.db, 'SELECT * FROM reservas WHERE aprobada_ts IS NULL AND rechazada_ts IS NULL AND cancelada_ts IS NULL ORDER BY creada_ts');
  } else if (filtro === 'rechazadas') {
    filas = await todos(c.db, 'SELECT * FROM reservas WHERE rechazada_ts IS NOT NULL OR cancelada_ts IS NOT NULL ORDER BY COALESCE(cancelada_ts, rechazada_ts) DESC LIMIT 400');
  } else if (filtro === 'proximas' || filtro === 'porcerrar' || filtro === 'completas') {
    filas = await todos(c.db, `SELECT * FROM reservas WHERE aprobada_ts IS NOT NULL AND ${ACTIVA_SQL} ORDER BY fecha, hora_inicio, cancha`);
  } else {
    const q = txt(c.datos.q).toLowerCase();
    filas = await todos(c.db, 'SELECT * FROM reservas ORDER BY fecha DESC, hora_inicio DESC LIMIT 400');
    if (q) {
      const qd = soloDigitos(q);
      filas = filas.filter((r) => [r.nombre, r.pareja_a, r.pareja_b, r.codigo, r.categoria, r.id].join(' ').toLowerCase().includes(q) || (qd.length >= 4 && soloDigitos(r.telefono).includes(qd)));
    }
  }
  const partidos = await mapaPartidosDe(c.db, filas);
  if (filtro === 'proximas' || filtro === 'porcerrar' || filtro === 'completas') {
    filas = filas.filter((r) => etapaReserva(r, partidos[r.id_partido]) === filtro);
    if (filtro !== 'proximas') filas.reverse(); // las más recientes primero
  }
  return filas.map((r) => ({ ...formatoReservaAdmin(c, r, t, partidos), etapa: etapaReserva(r, partidos[r.id_partido]) }));
}

async function cambiarEstadoReserva(c, campo, estadoObjetivo) {
  await exigirAdmin(c);
  const id = txt(c.datos.idReserva);
  if (!id) falla('Falta el ID de la reserva.');
  const res = await ejecutar(c.db, `UPDATE reservas SET ${campo} = ? WHERE id = ? AND aprobada_ts IS NULL AND rechazada_ts IS NULL AND cancelada_ts IS NULL`, Date.now(), id);
  const r = await uno(c.db, 'SELECT * FROM reservas WHERE id = ?', id);
  if (!r) falla('No se encontró esa reserva.');
  const e = estadoReserva(r);
  if (res.meta.changes !== 1) {
    const yaHecho = estadoObjetivo === EST.RESERVADO ? (e === EST.RESERVADO || e === EST.FINALIZADO) : e === estadoObjetivo;
    if (!yaHecho) falla('Esta reserva ya fue procesada (estado actual: ' + e + ').');
  }
  return { ok: true, idReserva: id, estadoReserva: e };
}
const aAprobarReserva = (c) => cambiarEstadoReserva(c, 'aprobada_ts', EST.RESERVADO);
const aRechazarReserva = (c) => cambiarEstadoReserva(c, 'rechazada_ts', EST.RECHAZADO);

// Borra una reserva del sistema para siempre (ej: la pareja se dio de baja).
// Si el partido tenía resultado cargado, el resultado queda; se borra aparte.
async function aAdminEliminarReserva(c) {
  await exigirAdmin(c);
  const id = txt(c.datos.idReserva);
  const r = await uno(c.db, 'SELECT * FROM reservas WHERE id = ?', id);
  if (!r) falla('No se encontró esa reserva.');
  const stmts = [c.db.prepare('DELETE FROM reservas WHERE id = ?').bind(id)];
  if (r.comprobante_id) stmts.push(c.db.prepare('DELETE FROM archivos WHERE id = ?').bind(r.comprobante_id));
  await c.db.batch(stmts);
  return { ok: true, eliminada: id };
}

async function aAdminCancelarReserva(c) {
  await exigirAdmin(c);
  const id = txt(c.datos.idReserva);
  const r = await uno(c.db, 'SELECT * FROM reservas WHERE id = ?', id);
  if (!r) falla('No se encontró esa reserva.');
  const e = estadoReserva(r);
  if (e === EST.PENDIENTE_APROBACION) falla('Esta reserva está pendiente: usá "Rechazar".');
  if (e !== EST.RESERVADO && e !== EST.FINALIZADO) falla('Esta reserva ya estaba ' + (e === EST.RECHAZADO ? 'rechazada.' : 'cancelada.'));
  if (e === EST.FINALIZADO && r.id_partido) {
    const pt = await uno(c.db, 'SELECT estado FROM partidos WHERE id = ?', r.id_partido);
    if (pt && pt.estado === JUGADO) falla('Este partido tiene resultado cargado. Si no se jugó, borrá primero los sets del resultado y después cancelá.');
  }
  await ejecutar(c.db, 'UPDATE reservas SET cancelada_ts = ? WHERE id = ? AND cancelada_ts IS NULL', Date.now(), id);
  return { ok: true };
}

async function aAdminMarcarPago(c) {
  await exigirAdmin(c);
  const id = txt(c.datos.idReserva);
  const r = await uno(c.db, 'SELECT * FROM reservas WHERE id = ?', id);
  if (!r) falla('No se encontró esa reserva.');
  const pagos = estadoPagos(r);
  pagos.pagados = pagos.pagados.map((v, i) => (c.datos.completo ? true : i === pagos.sena));
  await guardarPagosSql(c.db, r, pagos).run();
  return { ok: true, pagados: pagos.pagados };
}
// Tilda o destilda el pago de un jugador (0-1: pareja A, 2-3: pareja B).
// esSena = true marca a ese jugador como quien pagó la seña.
async function aAdminPagoJugador(c) {
  await exigirAdmin(c);
  const id = txt(c.datos.idReserva), i = Number(c.datos.indice);
  if (!(i >= 0 && i <= 3)) falla('Jugador inválido.');
  const r = await uno(c.db, 'SELECT * FROM reservas WHERE id = ?', id);
  if (!r) falla('No se encontró esa reserva.');
  const pagos = estadoPagos(r);
  if (c.datos.esSena) { pagos.sena = i; pagos.pagados[i] = true; }
  else pagos.pagados[i] = !!c.datos.pagado;
  await guardarPagosSql(c.db, r, pagos).run();
  return { ok: true, pagados: pagos.pagados, senaIndice: pagos.sena, completo: pagos.pagados.every(Boolean) };
}

// Agenda: día por día, cada franja con quién juega en qué cancha.
async function aAdminAgenda(c) {
  await exigirAdmin(c);
  const desde = esFechaISO(txt(c.datos.desde)) ? txt(c.datos.desde) : hoyISO();
  const dias = Math.min(Math.max(Number(c.datos.dias) || 7, 1), 31);
  const hasta = sumarDias(desde, dias - 1);
  const [base, reservas, bloqueos] = await Promise.all([
    cargarBase(c.db, desde, hasta),
    todos(c.db, `SELECT * FROM reservas WHERE fecha BETWEEN ? AND ? AND ${ACTIVA_SQL} ORDER BY fecha, hora_inicio, cancha`, desde, hasta),
    todos(c.db, 'SELECT * FROM bloqueos WHERE fecha BETWEEN ? AND ? ORDER BY fecha, hora_inicio', desde, hasta),
  ]);
  const cfg = base.cfg;
  const t = await tokenParaLinks(c);
  const partidos = await mapaPartidosDe(c.db, reservas);
  const fmtB = (b) => ({ id: b.id, fecha: b.fecha, horaInicio: b.hora_inicio, horaFin: b.hora_fin, cancha: b.cancha, motivo: b.motivo });
  const salida = [];
  for (let f = desde; f <= hasta; f = sumarDias(f, 1)) {
    const resDia = reservas.filter((r) => r.fecha === f);
    const bloqDia = bloqueos.filter((b) => b.fecha === f);
    const usadas = new Set();
    const franjas = franjasDeFecha(base, f).map((fr) => {
      const rs = resDia.filter((r) => seSuperponen(r.hora_inicio, r.hora_fin, fr.inicio, fr.fin));
      rs.forEach((r) => usadas.add(r.id));
      const bs = bloqDia.filter((b) => seSuperponen(b.hora_inicio, b.hora_fin, fr.inicio, fr.fin));
      const ocupadas = contarOcupadas(cfg, rs, [], bs, f, fr.inicio, fr.fin);
      return {
        inicio: fr.inicio, fin: fr.fin, canchas: fr.cap, especial: fr.especial, idEspecial: fr.idEspecial || null,
        libres: Math.max(0, fr.cap - ocupadas),
        reservas: rs.map((r) => formatoReservaAdmin(c, r, t, partidos)),
        bloqueos: bs.map(fmtB),
      };
    });
    salida.push({
      fecha: f, diaSemana: NOMBRES_DIA[diaSemana(f)], franjas,
      clases: (base.clases.porDia[diaSemana(f)] || []).map((k) => ({ id: k.id, inicio: k.inicio, fin: k.fin, canchas: k.canchas, profe: k.profe })),
      otras: resDia.filter((r) => !usadas.has(r.id)).map((r) => formatoReservaAdmin(c, r, t, partidos)),
      bloqueos: bloqDia.map(fmtB),
    });
  }
  return { desde, hasta, dias: salida, cantidadCanchas: cfg.cantidadCanchas };
}

// ---------- Deportivo ----------
async function aAdminPartidos(c) {
  await exigirAdmin(c);
  const cat = txt(c.datos.categoria);
  const categoria = await uno(c.db, 'SELECT * FROM categorias WHERE nombre = ?', cat);
  if (!categoria) falla('No existe la categoría "' + cat + '".');
  const [{ mapa }, partidos, reservas] = await Promise.all([
    mapaParejas(c.db, cat),
    todos(c.db, 'SELECT * FROM partidos WHERE categoria = ? ORDER BY fecha, id', cat),
    todos(c.db, `SELECT * FROM reservas WHERE categoria = ? AND ${ACTIVA_SQL} ORDER BY fecha DESC`, cat),
  ]);
  const resPorPartido = {};
  for (const r of reservas) if (!resPorPartido[r.id_partido]) resPorPartido[r.id_partido] = r;
  return {
    categoria: cat, fechaEnJuego: categoria.fecha_en_juego,
    partidos: partidos.map((p) => {
      const r = resPorPartido[p.id];
      return {
        idPartido: p.id, fecha: p.fecha, estado: p.estado,
        parejaAId: p.pareja_a_id, parejaA: nombreLado(mapa, p.pareja_a_id, p.pareja_a_txt),
        parejaBId: p.pareja_b_id, parejaB: nombreLado(mapa, p.pareja_b_id, p.pareja_b_txt),
        set1: p.set1, set2: p.set2, set3: p.set3, ganadorId: p.ganador_id,
        reserva: r ? { fecha: r.fecha, horarioInicio: r.hora_inicio, cancha: r.cancha, estado: estadoReserva(r) } : null,
      };
    }),
  };
}
async function aAdminGuardarResultado(c) {
  await exigirAdmin(c);
  const id = txt(c.datos.idPartido);
  const p = await uno(c.db, 'SELECT * FROM partidos WHERE id = ?', id);
  if (!p) falla('No se encontró ese partido.');
  const r = resolverResultado(c.datos.set1, c.datos.set2, c.datos.set3, p.pareja_a_id, p.pareja_b_id);
  await ejecutar(c.db, 'UPDATE partidos SET set1 = ?, set2 = ?, set3 = ?, ganador_id = ?, estado = ? WHERE id = ?', r.set1, r.set2, r.set3, r.ganadorId, r.estado, id);
  return { idPartido: id, ...r };
}
async function aAdminFechaEnJuego(c) {
  await exigirAdmin(c);
  const cat = txt(c.datos.categoria);
  const v = c.datos.fecha === '' || c.datos.fecha === null || c.datos.fecha === undefined ? null : Number(c.datos.fecha);
  if (v !== null && (!Number.isInteger(v) || v < 1)) falla('La fecha en juego tiene que ser un número (1, 2, 3...).');
  const res = await ejecutar(c.db, 'UPDATE categorias SET fecha_en_juego = ? WHERE nombre = ?', v, cat);
  if (res.meta.changes !== 1) falla('No existe la categoría "' + cat + '".');
  return { categoria: cat, fechaEnJuego: v };
}
async function aAdminFechaEnJuegoTodas(c) {
  await exigirAdmin(c);
  const v = Number(c.datos.fecha);
  if (!Number.isInteger(v) || v < 1) falla('La fecha en juego tiene que ser un número (1, 2, 3...).');
  await ejecutar(c.db, 'UPDATE categorias SET fecha_en_juego = ?', v);
  return { fechaEnJuego: v };
}
async function aAdminParejas(c) {
  await exigirAdmin(c);
  const [parejas, cats] = await Promise.all([
    todos(c.db, 'SELECT * FROM parejas ORDER BY categoria, id'),
    categoriasOrdenadas(c.db),
  ]);
  return {
    categorias: cats.map((x) => x.nombre),
    parejas: parejas.map((p) => ({ id: p.id, categoria: p.categoria, jugador1: p.jugador1, jugador2: p.jugador2, estado: p.estado })),
  };
}
async function aAdminGuardarPareja(c) {
  await exigirAdmin(c);
  const d = c.datos;
  const categoria = txt(d.categoria), j1 = txt(d.jugador1).substring(0, 80), j2 = txt(d.jugador2).substring(0, 80);
  const estado = mayus(d.estado) === 'BAJA' ? 'BAJA' : 'ACTIVA';
  if (!j1) falla('Falta el nombre del jugador 1.');
  if (!(await uno(c.db, 'SELECT 1 FROM categorias WHERE nombre = ?', categoria))) falla('Elegí una categoría válida.');
  const id = txt(d.id);
  if (id) {
    const res = await ejecutar(c.db, 'UPDATE parejas SET categoria = ?, jugador1 = ?, jugador2 = ?, estado = ? WHERE id = ?', categoria, j1, j2, estado, id);
    if (res.meta.changes !== 1) falla('No se encontró esa pareja.');
    return { id };
  }
  const fila = await uno(c.db, `INSERT INTO parejas (id, categoria, jugador1, jugador2, estado)
    SELECT 'P' || printf('%03d', COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) + 1), ?, ?, ?, ? FROM parejas
    RETURNING id`, categoria, j1, j2, estado);
  return { id: fila.id };
}
async function aAdminCrearCategoria(c) {
  await exigirAdmin(c);
  const nombre = txt(c.datos.nombre).substring(0, 60);
  if (!nombre) falla('Escribí el nombre de la categoría.');
  const max = await uno(c.db, 'SELECT COALESCE(MAX(orden), 0) AS m FROM categorias');
  try {
    await ejecutar(c.db, 'INSERT INTO categorias (nombre, orden, fecha_en_juego) VALUES (?, ?, NULL)', nombre, max.m + 1);
  } catch (e) { falla('Ya existe una categoría con ese nombre.'); }
  return { nombre };
}
async function aAdminEliminarCategoria(c) {
  await exigirAdmin(c);
  const nombre = txt(c.datos.nombre);
  const uso = await uno(c.db, 'SELECT (SELECT COUNT(*) FROM parejas WHERE categoria = ?1) + (SELECT COUNT(*) FROM partidos WHERE categoria = ?1) AS n', nombre);
  if (uso.n > 0) falla('No se puede eliminar: la categoría tiene parejas o partidos cargados.');
  await ejecutar(c.db, 'DELETE FROM categorias WHERE nombre = ?', nombre);
  return { ok: true };
}
async function aAdminGenerarFixture(c) {
  await exigirAdmin(c);
  const cat = txt(c.datos.categoria);
  if (!(await uno(c.db, 'SELECT 1 FROM categorias WHERE nombre = ?', cat))) falla('No existe la categoría "' + cat + '".');
  const parejas = await todos(c.db, "SELECT * FROM parejas WHERE categoria = ? AND estado = 'ACTIVA' ORDER BY id", cat);
  if (parejas.length < 2) falla('"' + cat + '" tiene ' + parejas.length + ' pareja(s) activa(s); hacen falta al menos 2.');
  const existentes = await uno(c.db, `SELECT COUNT(*) AS n, SUM(CASE WHEN estado = 'JUGADO' THEN 1 ELSE 0 END) AS jugados,
      (SELECT COUNT(*) FROM reservas r WHERE r.categoria = ?1 AND r.rechazada_ts IS NULL AND r.cancelada_ts IS NULL AND r.fecha >= ?2) AS reservas
    FROM partidos WHERE categoria = ?1`, cat, hoyISO());
  if (existentes.n > 0 && !c.datos.confirmar) {
    return { requiereConfirmacion: true, existentes: existentes.n, jugados: existentes.jugados || 0, reservasFuturas: existentes.reservas || 0 };
  }
  const rondas = roundRobin(parejas);
  const maxId = await uno(c.db, "SELECT COALESCE(MAX(CAST(SUBSTR(id, 3) AS INTEGER)), 0) AS m FROM partidos");
  let n = maxId.m;
  const filas = [];
  rondas.forEach((ronda, i) => ronda.forEach((pt) => {
    n++;
    filas.push({ id: 'PT' + String(n).padStart(4, '0'), fecha: i + 1, a: pt.a.id, b: pt.b.id, at: pt.a.id + ' · ' + nombrePareja(pt.a), bt: pt.b.id + ' · ' + nombrePareja(pt.b) });
  }));
  await c.db.batch([
    c.db.prepare('DELETE FROM partidos WHERE categoria = ?').bind(cat),
    c.db.prepare(`INSERT INTO partidos (id, categoria, fecha, pareja_a_id, pareja_b_id, pareja_a_txt, pareja_b_txt, estado)
      SELECT json_extract(value, '$.id'), ?2, json_extract(value, '$.fecha'), json_extract(value, '$.a'), json_extract(value, '$.b'),
             json_extract(value, '$.at'), json_extract(value, '$.bt'), 'PENDIENTE' FROM json_each(?1)`).bind(JSON.stringify(filas), cat),
  ]);
  return { generado: true, parejas: parejas.length, fechas: rondas.length, partidos: filas.length };
}

// ---------- Horarios ----------
async function aAdminBloqueos(c) {
  await exigirAdmin(c);
  const filas = await todos(c.db, 'SELECT * FROM bloqueos WHERE fecha >= ? ORDER BY fecha, hora_inicio', hoyISO());
  return filas.map((b) => ({ id: b.id, fecha: b.fecha, horaInicio: b.hora_inicio, horaFin: b.hora_fin, cancha: b.cancha, motivo: b.motivo }));
}
async function aAdminCrearBloqueo(c) {
  await exigirAdmin(c);
  const d = c.datos;
  const fecha = txt(d.fecha), ini = normalizarHora(d.horaInicio), fin = normalizarHora(d.horaFin);
  const cancha = mayus(d.cancha) || 'TODAS';
  const cfg = await leerConfig(c.db);
  if (!esFechaISO(fecha)) falla('Elegí una fecha válida.');
  if (!esHora(ini) || !esHora(fin) || fin <= ini) falla('Revisá el horario: "hasta" tiene que ser después de "desde".');
  if (cancha !== 'TODAS' && !(Number(cancha) >= 1 && Number(cancha) <= cfg.cantidadCanchas)) falla('Elegí una cancha válida.');
  const id = 'B-' + uuid().slice(0, 8);
  await ejecutar(c.db, 'INSERT INTO bloqueos (id, fecha, hora_inicio, hora_fin, cancha, motivo, creado_ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, fecha, ini, fin, cancha, txt(d.motivo).substring(0, 120), Date.now());
  return { id };
}
async function aAdminEliminarBloqueo(c) {
  await exigirAdmin(c);
  await ejecutar(c.db, 'DELETE FROM bloqueos WHERE id = ?', txt(c.datos.id));
  return { ok: true };
}
async function aAdminGrilla(c) {
  await exigirAdmin(c);
  const hoy = hoyISO();
  const base = await cargarBase(c.db, hoy, sumarDias(hoy, 120));
  const turnos = [];
  for (const f of Object.keys(base.turnos).sort()) for (const t of base.turnos[f]) turnos.push({ id: t.id, fecha: t.fecha, inicio: t.inicio, fin: t.fin, canchas: t.canchas });
  return {
    cantidadCanchas: base.cfg.cantidadCanchas,
    clases: base.clases.lista.map((k) => ({ id: k.id, dia: k.dia, inicio: k.inicio, fin: k.fin, canchas: k.canchas, profe: k.profe })),
    turnosEspeciales: turnos,
    dias: [1, 2, 3, 4, 5, 6, 0].map((dia) => ({
      dia, nombre: NOMBRES_DIA[dia],
      franjas: (base.grilla[dia] || []).map((f) => ({ ...f, porClases: libresSegunClases(base.cfg, base.clases.porDia[dia], f.inicio, f.fin) })),
    })),
  };
}
async function aAdminGuardarGrilla(c) {
  await exigirAdmin(c);
  const cfg = await leerConfig(c.db);
  const franjas = Array.isArray(c.datos.franjas) ? c.datos.franjas : falla('Faltan las franjas.');
  const limpias = franjas.map((f) => {
    const dia = Number(f.dia), ini = normalizarHora(f.inicio), fin = normalizarHora(f.fin), canchas = Number(f.canchas);
    if (!(dia >= 0 && dia <= 6)) falla('Día inválido.');
    if (!esHora(ini) || !esHora(fin) || fin <= ini) falla('Revisá los horarios del ' + NOMBRES_DIA[dia] + ' (' + ini + ' a ' + fin + ').');
    if (!(canchas >= 1 && canchas <= cfg.cantidadCanchas)) falla('Las canchas de cada turno van de 1 a ' + cfg.cantidadCanchas + '.');
    return { dia, inicio: ini, fin, canchas };
  });
  await c.db.batch([
    c.db.prepare('DELETE FROM grilla'),
    c.db.prepare(`INSERT INTO grilla (dia, inicio, fin, canchas) SELECT json_extract(value, '$.dia'), json_extract(value, '$.inicio'),
      json_extract(value, '$.fin'), json_extract(value, '$.canchas') FROM json_each(?)`).bind(JSON.stringify(limpias)),
  ]);
  return { ok: true, franjas: limpias.length };
}
async function aAdminGuardarConfig(c) {
  await exigirAdmin(c);
  const v = c.datos.valores || {};
  const stmts = [];
  for (const k of Object.keys(v)) {
    if (!CONFIG_EDITABLE.includes(k)) continue;
    let val = txt(v[k]);
    if (['valor_turno', 'monto_sena', 'ventana_dias', 'retencion_minutos', 'cantidad_canchas'].includes(k)) {
      const n = Number(val);
      if (!Number.isFinite(n) || n < 0) falla('Valor inválido para ' + k + '.');
      val = String(Math.round(n));
    }
    if (k === 'fecha_inicio_liga' && !esFechaISO(val)) falla('Fecha de inicio inválida.');
    stmts.push(c.db.prepare('INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor').bind(k, val));
  }
  if (stmts.length) await c.db.batch(stmts);
  return leerConfig(c.db);
}

// ---------- Clases fijas (tuyas y de los profes) ----------
function validarHorario(ini, fin, que) {
  if (!esHora(ini) || !esHora(fin) || fin <= ini) falla('Revisá el horario' + (que ? ' de ' + que : '') + ': "hasta" tiene que ser después de "desde".');
}
async function aAdminClases(c) {
  await exigirAdmin(c);
  return (await leerClases(c.db)).lista;
}
async function aAdminGuardarClase(c) {
  await exigirAdmin(c);
  const d = c.datos, cfg = await leerConfig(c.db);
  const dia = Number(d.dia), ini = normalizarHora(d.inicio), fin = normalizarHora(d.fin), canchas = Number(d.canchas) || 1;
  if (!(dia >= 0 && dia <= 6)) falla('Elegí el día.');
  validarHorario(ini, fin, 'la clase');
  if (!(canchas >= 1 && canchas <= cfg.cantidadCanchas)) falla('Las canchas van de 1 a ' + cfg.cantidadCanchas + '.');
  const profe = txt(d.profe).substring(0, 60);
  if (d.id) {
    await ejecutar(c.db, 'UPDATE clases SET dia = ?, inicio = ?, fin = ?, canchas = ?, profe = ? WHERE id = ?', dia, ini, fin, canchas, profe, Number(d.id));
    return { id: Number(d.id) };
  }
  const f = await uno(c.db, 'INSERT INTO clases (dia, inicio, fin, canchas, profe) VALUES (?, ?, ?, ?, ?) RETURNING id', dia, ini, fin, canchas, profe);
  return { id: f.id };
}
async function aAdminEliminarClase(c) {
  await exigirAdmin(c);
  await ejecutar(c.db, 'DELETE FROM clases WHERE id = ?', Number(c.datos.id));
  return { ok: true };
}

// ---------- Turnos especiales para una fecha ----------
// Arma los turnos de un día (ej. sábado de 9 a 21 cada 90') y calcula
// cuántas canchas quedan libres en cada uno según clases y bloqueos.
async function calcularTurnosDia(c, fecha, desde, hasta, duracion) {
  if (!esFechaISO(fecha)) falla('Elegí una fecha válida.');
  validarHorario(desde, hasta);
  const dur = Math.max(30, Math.min(180, Number(duracion) || 90));
  const [base, bloqueos] = await Promise.all([
    cargarBase(c.db, fecha, fecha),
    todos(c.db, 'SELECT * FROM bloqueos WHERE fecha = ?', fecha),
  ]);
  const clasesDia = base.clases.porDia[diaSemana(fecha)] || [];
  const existentes = franjasDeFecha(base, fecha);
  const aMin = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
  const aHora = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const out = [];
  for (let m = aMin(desde); m + dur <= aMin(hasta); m += dur) {
    const ini = aHora(m), fin = aHora(m + dur);
    let libres = libresSegunClases(base.cfg, clasesDia, ini, fin);
    for (const b of bloqueos) if (seSuperponen(b.hora_inicio, b.hora_fin, ini, fin)) libres -= mayus(b.cancha) === 'TODAS' ? base.cfg.cantidadCanchas : 1;
    const ya = existentes.find((f) => seSuperponen(f.inicio, f.fin, ini, fin));
    out.push({ inicio: ini, fin, libres: Math.max(0, libres), choca: ya ? ya.inicio + '–' + ya.fin : '' });
  }
  if (!out.length) falla('Entre esos horarios no entra ningún turno de ' + dur + ' minutos.');
  return { fecha, diaSemana: NOMBRES_DIA[diaSemana(fecha)], cantidadCanchas: base.cfg.cantidadCanchas, turnos: out };
}
async function aAdminCalcularTurnos(c) {
  await exigirAdmin(c);
  const d = c.datos;
  return calcularTurnosDia(c, txt(d.fecha), normalizarHora(d.desde), normalizarHora(d.hasta), d.duracion);
}
async function aAdminCrearTurnosFecha(c) {
  await exigirAdmin(c);
  const fecha = txt(c.datos.fecha);
  if (!esFechaISO(fecha)) falla('Elegí una fecha válida.');
  const cfg = await leerConfig(c.db);
  const turnos = (Array.isArray(c.datos.turnos) ? c.datos.turnos : []).map((t) => {
    const ini = normalizarHora(t.inicio), fin = normalizarHora(t.fin), canchas = Number(t.canchas);
    validarHorario(ini, fin);
    if (!(canchas >= 1 && canchas <= cfg.cantidadCanchas)) falla('Las canchas van de 1 a ' + cfg.cantidadCanchas + '.');
    return { fecha, inicio: ini, fin, canchas };
  });
  if (!turnos.length) falla('No hay turnos para agregar.');
  await ejecutar(c.db, `INSERT INTO turnos_fecha (fecha, inicio, fin, canchas) SELECT json_extract(value,'$.fecha'), json_extract(value,'$.inicio'),
    json_extract(value,'$.fin'), json_extract(value,'$.canchas') FROM json_each(?)`, JSON.stringify(turnos));
  return { agregados: turnos.length };
}
async function aAdminEliminarTurnoFecha(c) {
  await exigirAdmin(c);
  await ejecutar(c.db, 'DELETE FROM turnos_fecha WHERE id = ?', Number(c.datos.id));
  return { ok: true };
}

// ---------- Bloqueos: editar / mover ----------
async function aAdminEditarBloqueo(c) {
  await exigirAdmin(c);
  const d = c.datos, cfg = await leerConfig(c.db);
  const fecha = txt(d.fecha), ini = normalizarHora(d.horaInicio), fin = normalizarHora(d.horaFin), cancha = mayus(d.cancha) || 'TODAS';
  if (!esFechaISO(fecha)) falla('Elegí una fecha válida.');
  validarHorario(ini, fin);
  if (cancha !== 'TODAS' && !(Number(cancha) >= 1 && Number(cancha) <= cfg.cantidadCanchas)) falla('Elegí una cancha válida.');
  const res = await ejecutar(c.db, 'UPDATE bloqueos SET fecha = ?, hora_inicio = ?, hora_fin = ?, cancha = ?, motivo = ? WHERE id = ?', fecha, ini, fin, cancha, txt(d.motivo).substring(0, 120), txt(d.id));
  if (res.meta.changes !== 1) falla('No se encontró ese bloqueo.');
  return { ok: true };
}

// ---------- Contenido ----------
async function aAdminContenido(c) {
  await exigirAdmin(c);
  const [contenido, sponsors, fotos, cfg] = await Promise.all([
    todos(c.db, 'SELECT * FROM contenido ORDER BY tipo, orden, id'),
    todos(c.db, 'SELECT * FROM sponsors ORDER BY destacado DESC, orden, id'),
    todos(c.db, 'SELECT * FROM fotos ORDER BY orden, creado_ts DESC'),
    leerConfig(c.db),
  ]);
  return {
    playoffsMensaje: cfg.playoffsMensaje,
    contenido: contenido.map((x) => ({ ...x, activo: !!x.activo, imagenUrl: urlPublica(c, x.imagen) })),
    sponsors: sponsors.map((s) => ({ ...s, activo: !!s.activo, destacado: !!s.destacado, logoUrlVista: urlPublica(c, s.logo_url) })),
    fotos: fotos.map((f) => ({ ...f, urlVista: urlPublica(c, f.url) })),
  };
}
async function aAdminGuardarContenido(c) {
  await exigirAdmin(c);
  const d = c.datos;
  const tipo = mayus(d.tipo) || 'NOVEDAD';
  const campos = [tipo, txt(d.titulo).substring(0, 200), txt(d.texto).substring(0, 4000), txt(d.imagen), txt(d.link), Number(d.orden) || 0, d.activo === false ? 0 : 1];
  if (d.id) {
    await ejecutar(c.db, 'UPDATE contenido SET tipo = ?, titulo = ?, texto = ?, imagen = ?, link = ?, orden = ?, activo = ? WHERE id = ?', ...campos, Number(d.id));
    return { id: Number(d.id) };
  }
  const f = await uno(c.db, 'INSERT INTO contenido (tipo, titulo, texto, imagen, link, orden, activo) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id', ...campos);
  return { id: f.id };
}
async function aAdminEliminarContenido(c) {
  await exigirAdmin(c);
  await ejecutar(c.db, 'DELETE FROM contenido WHERE id = ?', Number(c.datos.id));
  return { ok: true };
}
async function aAdminGuardarSponsor(c) {
  await exigirAdmin(c);
  const d = c.datos;
  const nombre = txt(d.nombre).substring(0, 100);
  if (!nombre) falla('Falta el nombre del sponsor.');
  const campos = [nombre, txt(d.logoUrl), txt(d.link), Number(d.orden) || 0, d.destacado ? 1 : 0, d.activo === false ? 0 : 1];
  const stmts = [];
  if (d.destacado) stmts.push(c.db.prepare('UPDATE sponsors SET destacado = 0'));
  if (d.id) {
    stmts.push(c.db.prepare('UPDATE sponsors SET nombre = ?, logo_url = ?, link = ?, orden = ?, destacado = ?, activo = ? WHERE id = ?').bind(...campos, Number(d.id)));
  } else {
    stmts.push(c.db.prepare('INSERT INTO sponsors (nombre, logo_url, link, orden, destacado, activo) VALUES (?, ?, ?, ?, ?, ?)').bind(...campos));
  }
  await c.db.batch(stmts);
  return { ok: true };
}
async function aAdminEliminarSponsor(c) {
  await exigirAdmin(c);
  await ejecutar(c.db, 'DELETE FROM sponsors WHERE id = ?', Number(c.datos.id));
  return { ok: true };
}
async function aAdminGuardarFoto(c) {
  await exigirAdmin(c);
  const d = c.datos;
  const url = txt(d.url);
  if (!url) falla('Falta la foto.');
  if (d.id) {
    await ejecutar(c.db, 'UPDATE fotos SET categoria = ?, titulo = ?, url = ?, orden = ? WHERE id = ?', txt(d.categoria), txt(d.titulo), url, Number(d.orden) || 0, Number(d.id));
  } else {
    await ejecutar(c.db, 'INSERT INTO fotos (categoria, titulo, url, orden, creado_ts) VALUES (?, ?, ?, ?, ?)', txt(d.categoria), txt(d.titulo), url, Number(d.orden) || 0, Date.now());
  }
  return { ok: true };
}
async function aAdminEliminarFoto(c) {
  await exigirAdmin(c);
  const f = await uno(c.db, 'SELECT url FROM fotos WHERE id = ?', Number(c.datos.id));
  await ejecutar(c.db, 'DELETE FROM fotos WHERE id = ?', Number(c.datos.id));
  if (f && f.url.startsWith('archivo:')) await ejecutar(c.db, "DELETE FROM archivos WHERE id = ? AND tipo = 'publico'", f.url.slice(8));
  return { ok: true };
}
async function aAdminSubirArchivo(c) {
  await exigirAdmin(c);
  const mime = txt(c.datos.mime) || 'image/jpeg';
  if (!MIMES_PUBLICOS.includes(mime)) falla('Subí una imagen JPG, PNG o WEBP.');
  const bytes = base64ABytes(c.datos.base64);
  if (!bytes.length) falla('La imagen llegó vacía.');
  if (bytes.length > MAX_ARCHIVO_BYTES) falla('La imagen pesa demasiado.');
  const id = uuid();
  await ejecutar(c.db, 'INSERT INTO archivos (id, tipo, mime, nombre, datos, creado_ts) VALUES (?, ?, ?, ?, ?, ?)', id, 'publico', mime, txt(c.datos.nombre).substring(0, 160), bytes.buffer, Date.now());
  return { valor: 'archivo:' + id, url: urlPublica(c, 'archivo:' + id) };
}

// ---------- Migración desde la planilla ----------
async function aImportar(c) {
  await exigirAdmin(c);
  const d = c.datos.datos || {};
  const arr = (x) => (Array.isArray(x) ? x : []);
  const reservas = arr(d.reservas);
  if (!c.datos.forzar) {
    const idsNuevos = new Set(reservas.map((r) => txt(r.id)));
    const actuales = await todos(c.db, 'SELECT id FROM reservas');
    const perdidas = actuales.filter((r) => !idsNuevos.has(r.id));
    if (perdidas.length) {
      falla('La base nueva ya tiene ' + perdidas.length + ' reserva(s) que no están en la planilla (por ejemplo ' + perdidas[0].id + '). No importo para no borrarlas.');
    }
  }
  const categorias = arr(d.categorias).map((x, i) => ({ nombre: txt(x.nombre), orden: Number(x.orden) || i + 1, fej: x.fechaEnJuego === '' || x.fechaEnJuego === null || x.fechaEnJuego === undefined || isNaN(Number(x.fechaEnJuego)) ? null : Number(x.fechaEnJuego) })).filter((x) => x.nombre);
  const parejas = arr(d.parejas).map((p) => ({ id: txt(p.id), categoria: txt(p.categoria), j1: txt(p.jugador1), j2: txt(p.jugador2), estado: mayus(p.estado) === 'BAJA' ? 'BAJA' : 'ACTIVA' })).filter((p) => p.id && p.j1);
  const partidos = arr(d.partidos).map((p) => {
    const a = idDeTxtPareja(p.parejaA), b = idDeTxtPareja(p.parejaB);
    const sets = [p.set1, p.set2, p.set3].map((s) => { const x = parsearSet(s); return x ? x.a + '-' + x.b : ''; });
    let estado = mayus(p.estado) === JUGADO ? JUGADO : PENDIENTE;
    let ganador = idDeTxtPareja(p.ganador);
    if (estado === JUGADO && !ganador) { try { ganador = resolverResultado(sets[0], sets[1], sets[2], a, b).ganadorId; } catch (e) { ganador = ''; } }
    if (estado === JUGADO && !ganador) estado = PENDIENTE;
    return { id: txt(p.id), categoria: txt(p.categoria), fecha: Number(p.fecha) || 0, a, b, at: txt(p.parejaA), bt: txt(p.parejaB), s1: sets[0], s2: sets[1], s3: sets[2], g: estado === JUGADO ? ganador : '', estado };
  }).filter((p) => p.id && p.a && p.b);
  const codigosUsados = new Set();
  const res = reservas.map((r) => {
    let codigo = mayus(r.codigo);
    while (!codigo || codigosUsados.has(codigo)) codigo = codigoReserva();
    codigosUsados.add(codigo);
    const n = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v)) || Number(v) === 0 ? null : Number(v));
    return {
      id: txt(r.id), token: txt(r.token) || uuid(), codigo, fecha: txt(r.fecha), hi: normalizarHora(r.horaInicio), hf: normalizarHora(r.horaFin),
      cancha: Number(r.cancha) || 1, categoria: txt(r.categoria), idPartido: txt(r.idPartido),
      ida: txt(r.idParejaA), pa: txt(r.parejaA), idb: txt(r.idParejaB), pb: txt(r.parejaB),
      nombre: txt(r.nombre), tel: txt(r.telefono), vt: Number(r.valorTotal) || 0, mp: Number(r.montoPagado) || 0,
      ep: mayus(r.estadoPago) === PAGO_COMPLETO ? PAGO_COMPLETO : SALDO_PENDIENTE, url: txt(r.comprobanteUrl),
      cr: n(r.creadaTs) || Date.now(), ap: n(r.aprobadaTs), re: n(r.rechazadaTs), ca: n(r.canceladaTs), ori: txt(r.idRetencionOrigen) || null,
    };
  }).filter((r) => r.id && esFechaISO(r.fecha));
  const bloqueos = arr(d.bloqueos).map((b, i) => ({ id: txt(b.id) || 'B-imp-' + i, fecha: txt(b.fecha), hi: normalizarHora(b.horaInicio), hf: normalizarHora(b.horaFin), cancha: mayus(b.cancha) || 'TODAS', motivo: txt(b.motivo), cr: Number(b.creadoTs) || Date.now() })).filter((b) => esFechaISO(b.fecha));
  const contenido = arr(d.contenido).map((x) => ({ tipo: mayus(x.tipo), titulo: txt(x.titulo), texto: txt(x.texto), imagen: txt(x.imagen), link: txt(x.link), orden: Number(x.orden) || 0, activo: mayus(x.activo) === 'SI' || x.activo === true ? 1 : 0 })).filter((x) => x.tipo);
  const sponsors = arr(d.sponsors).filter((s) => mayus(s.activo) === 'SI' && txt(s.nombre)).map((s, i) => ({ nombre: txt(s.nombre), logo: txt(s.logoUrl), link: txt(s.link), orden: Number(s.orden) || 0, destacado: i === 0 ? 1 : 0 }));
  const fotos = arr(d.galeria).filter((f) => mayus(f.activo) === 'SI' && txt(f.url)).map((f, i) => ({ categoria: txt(f.categoria), titulo: txt(f.titulo), url: txt(f.url), orden: i }));

  const J = JSON.stringify;
  const db = c.db;
  const stmts = [
    db.prepare('DELETE FROM retenciones'),
    db.prepare('DELETE FROM reservas'), db.prepare('DELETE FROM partidos'), db.prepare('DELETE FROM parejas'),
    db.prepare('DELETE FROM categorias'), db.prepare('DELETE FROM bloqueos'),
    db.prepare('DELETE FROM contenido'), db.prepare('DELETE FROM sponsors'), db.prepare("DELETE FROM fotos WHERE url NOT LIKE 'archivo:%'"),
    db.prepare(`INSERT INTO categorias (nombre, orden, fecha_en_juego) SELECT json_extract(value,'$.nombre'), json_extract(value,'$.orden'), json_extract(value,'$.fej') FROM json_each(?)`).bind(J(categorias)),
    db.prepare(`INSERT INTO parejas (id, categoria, jugador1, jugador2, estado) SELECT json_extract(value,'$.id'), json_extract(value,'$.categoria'), json_extract(value,'$.j1'), json_extract(value,'$.j2'), json_extract(value,'$.estado') FROM json_each(?)`).bind(J(parejas)),
    db.prepare(`INSERT INTO partidos (id, categoria, fecha, pareja_a_id, pareja_b_id, pareja_a_txt, pareja_b_txt, set1, set2, set3, ganador_id, estado)
      SELECT json_extract(value,'$.id'), json_extract(value,'$.categoria'), json_extract(value,'$.fecha'), json_extract(value,'$.a'), json_extract(value,'$.b'),
        json_extract(value,'$.at'), json_extract(value,'$.bt'), json_extract(value,'$.s1'), json_extract(value,'$.s2'), json_extract(value,'$.s3'),
        json_extract(value,'$.g'), json_extract(value,'$.estado') FROM json_each(?)`).bind(J(partidos)),
    db.prepare(`INSERT INTO reservas (id, token, codigo, fecha, hora_inicio, hora_fin, cancha, categoria, id_partido, id_pareja_a, pareja_a, id_pareja_b, pareja_b,
        nombre, telefono, valor_total, monto_pagado, estado_pago, comprobante_url, creada_ts, aprobada_ts, rechazada_ts, cancelada_ts, id_retencion_origen)
      SELECT json_extract(value,'$.id'), json_extract(value,'$.token'), json_extract(value,'$.codigo'), json_extract(value,'$.fecha'), json_extract(value,'$.hi'),
        json_extract(value,'$.hf'), json_extract(value,'$.cancha'), json_extract(value,'$.categoria'), json_extract(value,'$.idPartido'),
        json_extract(value,'$.ida'), json_extract(value,'$.pa'), json_extract(value,'$.idb'), json_extract(value,'$.pb'),
        json_extract(value,'$.nombre'), json_extract(value,'$.tel'), json_extract(value,'$.vt'), json_extract(value,'$.mp'), json_extract(value,'$.ep'),
        json_extract(value,'$.url'), json_extract(value,'$.cr'), json_extract(value,'$.ap'), json_extract(value,'$.re'), json_extract(value,'$.ca'), json_extract(value,'$.ori')
      FROM json_each(?)`).bind(J(res)),
    db.prepare(`INSERT INTO bloqueos (id, fecha, hora_inicio, hora_fin, cancha, motivo, creado_ts) SELECT json_extract(value,'$.id'), json_extract(value,'$.fecha'), json_extract(value,'$.hi'), json_extract(value,'$.hf'), json_extract(value,'$.cancha'), json_extract(value,'$.motivo'), json_extract(value,'$.cr') FROM json_each(?)`).bind(J(bloqueos)),
    db.prepare(`INSERT INTO contenido (tipo, titulo, texto, imagen, link, orden, activo) SELECT json_extract(value,'$.tipo'), json_extract(value,'$.titulo'), json_extract(value,'$.texto'), json_extract(value,'$.imagen'), json_extract(value,'$.link'), json_extract(value,'$.orden'), json_extract(value,'$.activo') FROM json_each(?)`).bind(J(contenido)),
    db.prepare(`INSERT INTO sponsors (nombre, logo_url, link, orden, destacado, activo) SELECT json_extract(value,'$.nombre'), json_extract(value,'$.logo'), json_extract(value,'$.link'), json_extract(value,'$.orden'), json_extract(value,'$.destacado'), 1 FROM json_each(?)`).bind(J(sponsors)),
    db.prepare(`INSERT INTO fotos (categoria, titulo, url, orden, creado_ts) SELECT json_extract(value,'$.categoria'), json_extract(value,'$.titulo'), json_extract(value,'$.url'), json_extract(value,'$.orden'), ? FROM json_each(?)`).bind(Date.now(), J(fotos)),
  ];
  // reiniciarTodo: además deja horarios, clases, precios y archivos como al principio
  // (borra todo lo que se haya cargado durante las pruebas).
  if (c.datos.reiniciarTodo) {
    stmts.push(
      db.prepare('DELETE FROM turnos_fecha'),
      db.prepare('DELETE FROM clases'),
      db.prepare(`INSERT INTO clases (dia, inicio, fin, canchas, profe) SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'),
        json_extract(value,'$[2]'), 1, json_extract(value,'$[3]') FROM json_each(?)`).bind(J(CLASES_INICIALES)),
      db.prepare('DELETE FROM grilla'),
      db.prepare(`INSERT INTO grilla (dia, inicio, fin, canchas) SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'),
        json_extract(value,'$[2]'), json_extract(value,'$[3]') FROM json_each(?)`).bind(J(GRILLA_INICIAL)),
      db.prepare("DELETE FROM config WHERE clave <> 'clases_sembradas'"),
      db.prepare(`INSERT INTO config (clave, valor) SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(?)`).bind(J(CONFIG_INICIAL)),
      db.prepare("DELETE FROM fotos"),
      db.prepare("DELETE FROM archivos"),
      db.prepare(`INSERT INTO fotos (categoria, titulo, url, orden, creado_ts) SELECT json_extract(value,'$.categoria'), json_extract(value,'$.titulo'), json_extract(value,'$.url'), json_extract(value,'$.orden'), ? FROM json_each(?)`).bind(Date.now(), J(fotos)),
    );
  }
  if (typeof d.playoffsMensaje === 'string' && d.playoffsMensaje.trim()) {
    stmts.push(db.prepare("INSERT INTO config (clave, valor) VALUES ('playoffs_mensaje', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor").bind(d.playoffsMensaje.trim()));
  }
  await db.batch(stmts);
  return {
    importado: true, reiniciado: !!c.datos.reiniciarTodo,
    categorias: categorias.length, parejas: parejas.length, partidos: partidos.length, jugados: partidos.filter((p) => p.estado === JUGADO).length,
    reservas: res.length, bloqueos: bloqueos.length, contenido: contenido.length, sponsors: sponsors.length, fotos: fotos.length,
  };
}

// =====================================================================
// Archivos (comprobantes privados, fotos/logos públicos)
// =====================================================================
async function servirArchivo(c) {
  const id = txt(c.datos.id);
  const a = await uno(c.db, 'SELECT * FROM archivos WHERE id = ?', id);
  if (!a) return new Response('No encontrado', { status: 404, headers: CORS });
  if (a.tipo !== 'publico' && !(await tokenAdminValido(c.env, c.datos.t))) {
    return new Response('Necesitás entrar como organizador para ver este comprobante.', { status: 403, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const datos = a.datos instanceof ArrayBuffer ? a.datos : new Uint8Array(a.datos).buffer;
  return new Response(datos, {
    headers: {
      ...CORS, 'Content-Type': a.mime,
      'Cache-Control': a.tipo === 'publico' ? 'public, max-age=31536000, immutable' : 'private, no-store',
      'Content-Disposition': 'inline',
    },
  });
}

// =====================================================================
// Puesta al día automática de la base (tablas/columnas nuevas)
// =====================================================================
// Corre una sola vez por instancia del Worker; si ya está todo, no hace nada.
// Valores originales (los de la planilla / Apps Script). Se usan al reiniciar todo.
const GRILLA_INICIAL = [
  [1,'18:00','19:30',2],[1,'19:30','21:00',2],[1,'21:00','22:30',3],
  [2,'10:30','12:00',2],[2,'18:00','19:30',2],[2,'19:30','21:00',2],[2,'21:00','22:30',3],
  [3,'18:00','19:30',2],[3,'19:30','21:00',2],[3,'21:00','22:30',3],
  [4,'10:30','12:00',3],[4,'18:00','19:30',2],[4,'19:30','21:00',2],[4,'21:00','22:30',3],
  [5,'18:00','19:30',2],[5,'19:30','21:00',2],[5,'21:00','22:30',3],
  [6,'09:30','11:00',3],[6,'11:00','12:30',3],
];
const CONFIG_INICIAL = [
  ['valor_turno', '36000'], ['monto_sena', '9000'], ['alias', 'masterpadel.360'], ['ventana_dias', '14'],
  ['retencion_minutos', '10'], ['cantidad_canchas', '3'], ['fecha_inicio_liga', '2026-09-14'], ['playoffs_mensaje', ''],
];
const CLASES_INICIALES = [
  // Gabriel
  [2, '19:00', '21:00', 'Gabriel'], [3, '19:00', '21:00', 'Gabriel'], [4, '19:00', '21:00', 'Gabriel'],
  // Pepi
  [2, '15:00', '19:00', 'Pepi'], [4, '15:00', '19:00', 'Pepi'],
  // Dani
  [1, '19:00', '20:00', 'Dani'], [2, '09:00', '11:00', 'Dani'], [3, '08:00', '09:00', 'Dani'], [3, '15:00', '19:00', 'Dani'],
  [4, '15:30', '16:30', 'Dani'], [5, '08:00', '09:00', 'Dani'], [5, '15:00', '18:00', 'Dani'], [5, '19:00', '20:00', 'Dani'],
];
let ESQUEMA_AL_DIA = false;
async function asegurarEsquema(db) {
  if (ESQUEMA_AL_DIA) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS clases (id INTEGER PRIMARY KEY AUTOINCREMENT, dia INTEGER NOT NULL, inicio TEXT NOT NULL,
      fin TEXT NOT NULL, canchas INTEGER NOT NULL DEFAULT 1, profe TEXT NOT NULL DEFAULT '')`),
    db.prepare(`CREATE TABLE IF NOT EXISTS turnos_fecha (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL, inicio TEXT NOT NULL,
      fin TEXT NOT NULL, canchas INTEGER NOT NULL)`),
  ]);
  const col = await db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('reservas') WHERE name = 'pagos'").first();
  if (!col || !col.n) {
    try { await db.prepare("ALTER TABLE reservas ADD COLUMN pagos TEXT NOT NULL DEFAULT ''").run(); } catch (e) { /* ya existía */ }
  }
  const sembradas = await db.prepare("SELECT valor FROM config WHERE clave = 'clases_sembradas'").first();
  if (!sembradas) {
    await db.batch([
      db.prepare(`INSERT INTO clases (dia, inicio, fin, canchas, profe) SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'),
        json_extract(value,'$[2]'), 1, json_extract(value,'$[3]') FROM json_each(?) WHERE NOT EXISTS (SELECT 1 FROM clases)`).bind(JSON.stringify(CLASES_INICIALES)),
      db.prepare("INSERT OR IGNORE INTO config (clave, valor) VALUES ('clases_sembradas', '1')"),
    ]);
  }
  ESQUEMA_AL_DIA = true;
}

// =====================================================================
// Router
// =====================================================================
const ACCIONES = {
  // públicas
  bootstrap: aBootstrap, categorias: aCategorias, posiciones: aPosiciones, fixture: aFixture, resultados: aResultados,
  mas: aMas, galeria: aGaleria, sponsors: aSponsors,
  verificarAcceso: aVerificarAcceso, validarTokenAcceso: aValidarTokenAcceso,
  disponibilidad: aDisponibilidad, partidosDisponibles: aPartidosDisponibles, retenerTurno: aRetenerTurno,
  confirmarReserva: aConfirmarReserva, consultarReserva: aConsultarReserva, buscarReserva: aBuscarReserva, cancelarReserva: aCancelarReserva,
  // organizador
  adminLogin: aAdminLogin, adminResumen: aAdminResumen, adminReservas: aAdminReservas, listarPendientes: aListarPendientes,
  aprobarReserva: aAprobarReserva, rechazarReserva: aRechazarReserva, adminCancelarReserva: aAdminCancelarReserva, adminEliminarReserva: aAdminEliminarReserva, adminMarcarPago: aAdminMarcarPago,
  adminAgenda: aAdminAgenda, adminPartidos: aAdminPartidos, adminGuardarResultado: aAdminGuardarResultado,
  adminFechaEnJuego: aAdminFechaEnJuego, adminFechaEnJuegoTodas: aAdminFechaEnJuegoTodas,
  adminParejas: aAdminParejas, adminGuardarPareja: aAdminGuardarPareja, adminCrearCategoria: aAdminCrearCategoria,
  adminEliminarCategoria: aAdminEliminarCategoria, adminGenerarFixture: aAdminGenerarFixture,
  adminBloqueos: aAdminBloqueos, adminCrearBloqueo: aAdminCrearBloqueo, adminEliminarBloqueo: aAdminEliminarBloqueo, adminEditarBloqueo: aAdminEditarBloqueo,
  adminClases: aAdminClases, adminGuardarClase: aAdminGuardarClase, adminEliminarClase: aAdminEliminarClase,
  adminCalcularTurnos: aAdminCalcularTurnos, adminCrearTurnosFecha: aAdminCrearTurnosFecha, adminEliminarTurnoFecha: aAdminEliminarTurnoFecha,
  adminPagoJugador: aAdminPagoJugador,
  adminGrilla: aAdminGrilla, adminGuardarGrilla: aAdminGuardarGrilla, adminGuardarConfig: aAdminGuardarConfig,
  adminContenido: aAdminContenido, adminGuardarContenido: aAdminGuardarContenido, adminEliminarContenido: aAdminEliminarContenido,
  adminGuardarSponsor: aAdminGuardarSponsor, adminEliminarSponsor: aAdminEliminarSponsor,
  adminGuardarFoto: aAdminGuardarFoto, adminEliminarFoto: aAdminEliminarFoto, adminSubirArchivo: aAdminSubirArchivo,
  importar: aImportar,
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function responder(payload, callback) {
  const json = JSON.stringify(payload);
  if (callback && /^[a-zA-Z0-9_$.]+$/.test(callback)) {
    return new Response(callback + '(' + json + ');', { headers: { ...CORS, 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  return new Response(json, { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const params = Object.fromEntries(url.searchParams);
    let cuerpo = null;
    if (request.method === 'POST') {
      try { const t = await request.text(); cuerpo = t ? JSON.parse(t) : null; } catch (e) { cuerpo = null; }
    }
    const datos = cuerpo && typeof cuerpo === 'object' ? { ...params, ...cuerpo } : params;
    const accion = params.accion || (cuerpo && cuerpo.accion) || '';
    const c = { env, ctx, db: env.DB, datos, origen: url.origin };

    if (!env.DB) return responder({ ok: false, error: 'Falta conectar la base de datos (binding "DB").' }, params.callback);
    try { await asegurarEsquema(env.DB); } catch (e) { console.error('asegurarEsquema', e && e.stack ? e.stack : e); }
    if (accion === 'archivo') {
      try { return await servirArchivo(c); } catch (e) { return new Response('Error', { status: 500, headers: CORS }); }
    }
    if (!accion) return responder({ ok: true, data: { servicio: 'Liga Master Pádel 360 API', hora: new Date().toISOString() } }, params.callback);

    const fn = ACCIONES[accion];
    if (!fn) return responder({ ok: false, error: 'Acción desconocida: ' + accion }, params.callback);
    try {
      const data = await fn(c);
      return responder({ ok: true, data }, request.method === 'GET' ? params.callback : null);
    } catch (e) {
      const negocio = e instanceof ErrorNegocio;
      if (!negocio) console.error(accion, e && e.stack ? e.stack : e);
      return responder({ ok: false, error: negocio ? e.message : 'Error interno del servidor. Probá de nuevo en un momento.' }, request.method === 'GET' ? params.callback : null);
    }
  },

  // Limpieza periódica (opcional, si se configura un Cron Trigger).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(env.DB.prepare('DELETE FROM retenciones WHERE creada_ts < ?').bind(Date.now() - 24 * 60 * 60 * 1000).run());
  },
};
