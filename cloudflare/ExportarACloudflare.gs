/**
 * =======================================================================
 * MASTER PÁDEL 360 — Mudanza de la planilla a Cloudflare
 * =======================================================================
 * Se pega como un ARCHIVO NUEVO dentro del proyecto de Apps Script de la
 * planilla "Organizacion LIGA OFICIAL" (Extensiones → Apps Script → "+"
 * → Secuencia de comandos → nombre: ExportarACloudflare).
 *
 * Qué hace: lee CATEGORIAS, PAREJAS, PARTIDOS, RESERVAS, BLOQUEOS,
 * CONTENIDO_APP, SPONSORS y GALERIA tal cual están, y los manda a la base
 * nueva. NO modifica nada de la planilla.
 *
 * Cómo se usa:
 *   1) Completá las dos constantes de abajo.
 *   2) Elegí la función "exportarACloudflare" arriba y tocá "Ejecutar".
 *   3) Mirá el "Registro de ejecución": dice cuántas filas se pasaron.
 * Se puede correr las veces que haga falta mientras la app siga usando la
 * planilla: cada vez reemplaza todo lo de Cloudflare por lo de la planilla.
 * Una vez que la app ya usa Cloudflare, se niega a correr para no borrar
 * reservas nuevas (salvo que pongas FORZAR = true a propósito).
 * =======================================================================
 */
var EXP360_URL_WORKER = 'https://liga-360-api.REEMPLAZAR.workers.dev';
var EXP360_CLAVE_ORGANIZADOR = 'REEMPLAZAR';
var EXP360_FORZAR = false;
// Web App pública vieja (solo se usa para copiar el texto de Playoffs).
var EXP360_API_VIEJA = 'https://script.google.com/macros/s/AKfycbxebUf2uSFTtcyrySuK_budugkr4Ai5gV8R5gBgYabgO0relQ0jaC7ljvLX6wz_rU0t/exec';
var EXP360_TZ = 'America/Argentina/Cordoba';

function exportarACloudflare() {
  var ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById('1MYPDiK8tUn_khbJsYnKotahhFehcM2N7i3JcTZi8Mhc');
  var datos = {
    categorias: exp360Categorias_(ss),
    parejas: exp360Parejas_(ss),
    partidos: exp360Partidos_(ss),
    reservas: exp360Reservas_(ss),
    bloqueos: exp360Bloqueos_(ss),
    contenido: exp360Tabla_(ss, 'CONTENIDO_APP', ['tipo', 'titulo', 'texto', 'imagen', 'link', 'orden', 'activo']),
    sponsors: exp360Tabla_(ss, 'SPONSORS', ['nombre', 'logoUrl', 'link', 'orden', 'activo']),
    galeria: exp360Tabla_(ss, 'GALERIA', ['id', 'categoria', 'titulo', 'url', 'fecha', 'activo']),
    playoffsMensaje: exp360PlayoffsViejo_(),
  };
  Logger.log('Leído de la planilla: ' + datos.categorias.length + ' categorías, ' + datos.parejas.length + ' parejas, ' +
    datos.partidos.length + ' partidos, ' + datos.reservas.length + ' reservas, ' + datos.bloqueos.length + ' bloqueos.');

  var resp = UrlFetchApp.fetch(EXP360_URL_WORKER.replace(/\/$/, '') + '/?accion=importar', {
    method: 'post',
    contentType: 'text/plain;charset=utf-8',
    payload: JSON.stringify({ clave: EXP360_CLAVE_ORGANIZADOR, forzar: EXP360_FORZAR, datos: datos }),
    muteHttpExceptions: true,
  });
  var cuerpo = resp.getContentText();
  var json;
  try { json = JSON.parse(cuerpo); } catch (e) { throw new Error('Respuesta inesperada de Cloudflare (HTTP ' + resp.getResponseCode() + '): ' + cuerpo.substring(0, 300)); }
  if (!json.ok) throw new Error('Cloudflare no aceptó la importación: ' + json.error);
  Logger.log('LISTO ✅ ' + JSON.stringify(json.data));
  try { SpreadsheetApp.getActive().toast('Mudanza a Cloudflare OK: ' + JSON.stringify(json.data), 'Master Pádel 360', 10); } catch (e) {}
  return json.data;
}

// ------------------------------------------------------------------ util
function exp360Txt_(v) { return String(v === null || v === undefined ? '' : v).trim(); }
function exp360Fecha_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return Utilities.formatDate(v, EXP360_TZ, 'yyyy-MM-dd');
  var t = exp360Txt_(v);
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '';
}
function exp360Hora_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, EXP360_TZ, 'HH:mm');
  var m = /^(\d{1,2}):(\d{2})/.exec(exp360Txt_(v));
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : exp360Txt_(v);
}
function exp360Ts_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v.getTime();
  return '';
}
function exp360Set_(v) {
  // Sets que Sheets haya convertido en fecha ("6-4" → 6/abr): se reconstruyen día-mes.
  if (v instanceof Date) return v.getDate() + '-' + (v.getMonth() + 1);
  return exp360Txt_(v);
}
function exp360Filas_(ss, hoja) {
  var sh = ss.getSheetByName(hoja);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
}
function exp360Tabla_(ss, hoja, nombres) {
  return exp360Filas_(ss, hoja).map(function (f) {
    var o = {};
    nombres.forEach(function (n, i) { o[n] = f[i] instanceof Date ? exp360Fecha_(f[i]) : f[i]; });
    return o;
  }).filter(function (o) { return exp360Txt_(o[nombres[0]]) !== ''; });
}

// ------------------------------------------------------------------ hojas
function exp360Categorias_(ss) {
  return exp360Filas_(ss, 'CATEGORIAS').map(function (f, i) {
    return { nombre: exp360Txt_(f[0]), orden: i + 1, fechaEnJuego: f[1] === '' ? '' : Number(f[1]) };
  }).filter(function (c) { return c.nombre; });
}
function exp360Parejas_(ss) {
  return exp360Filas_(ss, 'PAREJAS').map(function (f) {
    return { id: exp360Txt_(f[0]), categoria: exp360Txt_(f[1]), jugador1: exp360Txt_(f[2]), jugador2: exp360Txt_(f[3]), estado: exp360Txt_(f[4]) };
  }).filter(function (p) { return p.id; });
}
function exp360Partidos_(ss) {
  return exp360Filas_(ss, 'PARTIDOS').map(function (f) {
    return {
      id: exp360Txt_(f[0]), categoria: exp360Txt_(f[1]), fecha: Number(f[2]) || 0,
      parejaA: exp360Txt_(f[3]), parejaB: exp360Txt_(f[4]),
      set1: exp360Set_(f[5]), set2: exp360Set_(f[6]), set3: exp360Set_(f[7]),
      ganador: exp360Txt_(f[8]), estado: exp360Txt_(f[9]),
    };
  }).filter(function (p) { return p.id && p.parejaA; });
}
function exp360Reservas_(ss) {
  var ahora = new Date().getTime();
  return exp360Filas_(ss, 'RESERVAS').map(function (f) {
    var estado = exp360Txt_(f[17]).toUpperCase();
    var creada = exp360Ts_(f[20]) || ahora;
    var aprobada = exp360Ts_(f[24]), rechazada = exp360Ts_(f[25]), cancelada = exp360Ts_(f[21]);
    // Las fechas mandan; si falta alguna, se completa según el estado que mostraba la planilla.
    if ((estado === 'RESERVADO' || estado === 'FINALIZADO') && !aprobada) aprobada = creada;
    if (estado === 'RECHAZADO' && !rechazada) rechazada = ahora;
    if (estado === 'CANCELADO' && !cancelada) { cancelada = ahora; if (!aprobada) aprobada = creada; }
    return {
      id: exp360Txt_(f[0]), token: exp360Txt_(f[1]), fecha: exp360Fecha_(f[2]),
      horaInicio: exp360Hora_(f[3]), horaFin: exp360Hora_(f[4]), cancha: Number(f[5]) || 1,
      categoria: exp360Txt_(f[6]), idPartido: exp360Txt_(f[7]),
      idParejaA: exp360Txt_(f[8]), parejaA: exp360Txt_(f[9]), idParejaB: exp360Txt_(f[10]), parejaB: exp360Txt_(f[11]),
      nombre: exp360Txt_(f[12]), telefono: exp360Txt_(f[13]),
      valorTotal: Number(f[14]) || 0, montoPagado: Number(f[15]) || 0, estadoPago: exp360Txt_(f[18]),
      comprobanteUrl: exp360Txt_(f[19]), creadaTs: creada, aprobadaTs: aprobada, rechazadaTs: rechazada, canceladaTs: cancelada,
      codigo: exp360Txt_(f[23]), idRetencionOrigen: exp360Txt_(f[26]),
    };
  }).filter(function (r) { return /^R\d+$/.test(r.id) && r.fecha; });
}
function exp360Bloqueos_(ss) {
  return exp360Filas_(ss, 'BLOQUEOS').map(function (f) {
    return { id: exp360Txt_(f[0]), fecha: exp360Fecha_(f[1]), horaInicio: exp360Hora_(f[2]), horaFin: exp360Hora_(f[3]), cancha: exp360Txt_(f[4]) || 'TODAS', motivo: exp360Txt_(f[5]), creadoTs: exp360Ts_(f[6]) };
  }).filter(function (b) { return b.fecha; });
}
function exp360PlayoffsViejo_() {
  try {
    var r = UrlFetchApp.fetch(EXP360_API_VIEJA + '?accion=mas', { muteHttpExceptions: true });
    var j = JSON.parse(r.getContentText());
    return (j && j.ok && j.data && j.data.playoffsMensaje) || '';
  } catch (e) { return ''; }
}
