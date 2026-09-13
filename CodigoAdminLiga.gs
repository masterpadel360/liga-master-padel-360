/**
 * MASTER PÁDEL 360 — Administración deportiva de la liga
 * =======================================================================
 * Sistema INDEPENDIENTE de cualquier otra planilla (no tiene ninguna
 * relación con MOTUS 360 / Academia de Pádel ni con ningún otro sheet).
 * Administra únicamente la parte DEPORTIVA de la liga: parejas,
 * cat
 egorías, fixture, resultados y tabla de posiciones.
 *
 * NO incluye pagos, cobros, inscripciones pagas ni nada financiero.
 *
 * Primera entrega: estructura de hojas + PAREJAS + generador de fixture
 * todos-contra-todos (cantidad variable de parejas) + PARTIDOS +
 * POSICIONES + menú. Vista pública y playoffs quedan para más adelante,
 * pero la arquitectura (hoja CATEGORIAS como fuente de verdad, ID por
 * pareja) está pensada para no tener que rehacer nada cuando se agreguen.
 */

// ============================================================
// Nombres de hoja
// ============================================================
var SHEET_CATEGORIAS = 'CATEGORIAS';
var SHEET_PAREJAS = 'PAREJAS';
var SHEET_PARTIDOS = 'PARTIDOS';
var SHEET_POSICIONES = 'POSICIONES';
var SHEET_PANEL = 'PANEL';

// Categorías iniciales -- SOLO se usan para poblar la hoja CATEGORIAS la
// primera vez que se crea (setupInicial). Después de eso, la hoja
// CATEGORIAS es la ÚNICA fuente de verdad: agregar o sacar una categoría
// es agregar o sacar una fila ahí. Nunca hace falta tocar este arreglo ni
// ninguna otra parte del código para eso.
var CATEGORIAS_INICIALES = [
  '6ta Masculino',
  '7ma Masculino',
  '7ma Femenino',
  '8va Masculino',
  '8va Femenino',
];

// ============================================================
// Columnas
// ============================================================
var COL_PAREJAS = { ID: 1, CATEGORIA: 2, JUGADOR1: 3, JUGADOR2: 4, ESTADO: 5 };
var COL_PARTIDOS = {
  ID: 1, CATEGORIA: 2, FECHA: 3, PAREJA_A: 4, PAREJA_B: 5,
  SET1: 6, SET2: 7, SET3: 8, GANADOR: 9, ESTADO: 10,
};

var PAREJAS_FIRST_ROW = 2;
var PARTIDOS_FIRST_ROW = 2;

var ESTADO_PAREJA_ACTIVA = 'ACTIVA';
var ESTADO_PAREJA_BAJA = 'BAJA';
var ESTADOS_PAREJA_VALIDOS = [ESTADO_PAREJA_ACTIVA, ESTADO_PAREJA_BAJA];

var ESTADO_PARTIDO_PENDIENTE = 'PENDIENTE';
var ESTADO_PARTIDO_JUGADO = 'JUGADO';

var PANEL_CELDA_CATEGORIA = 'C3';

// Cuadro "PAREJAS INSCRIPTAS" del PANEL: fila donde arranca (título) y
// cantidad de filas que se limpian antes de reconstruirlo. El margen de
// filas reservadas es a propósito bien holgado: así, si alguna vez hay
// menos categorías que antes, no queda ninguna fila vieja colgando debajo
// de la última categoría actual.
var PANEL_RESUMEN_FILA_INICIO = 8;
var PANEL_RESUMEN_FILAS_RESERVADAS = 60;

var POS_HEADERS = [
  'POS', 'PAREJA', 'PJ', 'PG', 'PP', 'PUNTOS',
  'SETS A FAVOR', 'SETS EN CONTRA', 'DIF SETS',
  'GAMES A FAVOR', 'GAMES EN CONTRA', 'DIF GAMES',
];

// Paleta neutra y profesional (independiente de cualquier otra planilla).
var COLOR_HEADER_BG = '#1f3a5f';
var COLOR_HEADER_FG = '#ffffff';
var COLOR_TITULO_BG = '#16283f';
var COLOR_JUGADO_BG = '#e2f0d9';
var COLOR_PENDIENTE_BG = '#fff2cc';

// ============================================================
// Utilidades chicas
// ============================================================
function normalizar_(v) {
  return String(v === null || v === undefined ? '' : v).trim();
}
function normalizarMayus_(v) {
  return normalizar_(v).toUpperCase();
}
function filasDeRango_(range) {
  var start = range.getRow();
  return { start: start, end: start + range.getNumRows() - 1 };
}

// ============================================================
// Avisos e interfaz: NUNCA deben cortar la ejecución
// ============================================================
// SpreadsheetApp.getUi() sólo funciona cuando el script corre con una
// sesión real de alguien con la hoja abierta en el navegador (un clic en
// el menú, o los triggers simples onOpen/onEdit mientras la hoja está
// abierta). Si una función se corre a mano desde el editor de Apps
// Script ("Ejecutar" ahí arriba) no existe esa sesión, y getUi() tira
// "Cannot call SpreadsheetApp.getUi() from this context" -- de entrada,
// antes de llegar siquiera a mostrar nada. Por eso ninguna función de
// este archivo llama a SpreadsheetApp.getUi() directamente: todas pasan
// por estos dos helpers, que si no hay interfaz disponible dejan el
// aviso en el toast (se ve si alguien tiene la hoja abierta en otra
// pestaña) y en el log de ejecución (se ve siempre, se corra desde donde
// se corra) y siguen -- nunca cortan la función que las llamó.
function mostrarAvisoSiSePuede_(mensaje) {
  try {
    SpreadsheetApp.getUi().alert(mensaje);
  } catch (e) {
    intentarToast_(mensaje);
    console.log('[MASTER PÁDEL 360] ' + mensaje);
  }
}
function intentarToast_(mensaje) {
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(mensaje, 'MASTER PÁDEL 360', 8);
  } catch (e2) {
    // Sin interfaz y sin toast (muy poco común) -- ya quedó en el log igual.
  }
}
// Confirmación Sí/No (p.ej. "¿regenerar el fixture?"): si no hay interfaz
// disponible para preguntar, se responde que NO por seguridad -- nunca se
// borra ni regenera nada destructivo sin que alguien lo confirme a
// propósito desde el menú real de la hoja.
function confirmarSiSePuede_(titulo, mensaje) {
  try {
    var ui = SpreadsheetApp.getUi();
    var resp = ui.alert(titulo, mensaje, ui.ButtonSet.YES_NO);
    return resp === ui.Button.YES;
  } catch (e) {
    console.log(
      '[MASTER PÁDEL 360] No se pudo pedir confirmación (sin interfaz disponible -- ' +
      '¿se corrió desde el editor de Apps Script en vez del menú de la hoja?): "' + titulo +
      '". Se canceló por seguridad, no se tocó nada.'
    );
    return false;
  }
}

// ============================================================
// Menú
// ============================================================
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('MASTER PÁDEL 360')
      .addItem('Generar fixture (categoría del PANEL)', 'generarFixtureDesdeMenu')
      .addItem('Recalcular posiciones', 'recalcularPosicionesDesdeMenu')
      .addSeparator()
      .addItem('Reprocesar resultados de PARTIDOS (reparación)', 'reprocesarResultados')
      .addSeparator()
      .addItem('Configurar planilla (primera vez / reparar)', 'setupInicial')
      .addSeparator()
      .addItem('Gestionar reservas pendientes', 'gestionarReservasDesdeMenu')
      .addToUi();
  } catch (e) {
    // Se debe haber corrido onOpen() a mano desde el editor de Apps
    // Script (sin la hoja abierta en el navegador) -- no hay menú que
    // crear en ese caso. Abrí la hoja de Google Sheets normalmente y el
    // menú va a aparecer solo, no hace falta correr esta función a mano.
    console.log('[MASTER PÁDEL 360] No se pudo crear el menú (sin interfaz disponible).');
  }
}

// ============================================================
// setupInicial: crea lo que falte, nunca toca lo que ya existe.
// Seguro de correr las veces que hagan falta (idempotente) Y seguro de
// que se corte por tiempo -- ver ETAPAS_INSTALACION más abajo.
// ============================================================

// Progreso de la instalación, guardado en PropertiesService (sobrevive a
// que la ejecución se corte y a que se vuelva a correr setupInicial()
// más tarde). HOJAS_BASE es la única etapa que efectivamente se SALTEA
// si ya está marcada (crear una hoja que no existe es lo único de acá
// que no hace falta repetir). VALIDACIONES y POSICIONES_CALC son rápidas
// ahora (ver recalcularPosiciones_) y se vuelven a correr SIEMPRE que se
// ejecuta setupInicial, a propósito: tienen que quedar al día si
// agregaste una categoría nueva o cargaste resultados, no alcanza con
// haberlas corrido una vez.
var PROP_ETAPA_INSTALACION = 'MP360_ETAPA_INSTALACION';
var ETAPAS_INSTALACION = ['HOJAS_BASE', 'VALIDACIONES', 'POSICIONES_CALC', 'COMPLETA'];
// Margen de seguridad bien por debajo del límite real de Apps Script para
// una ejecución manual (6 minutos): si en algún momento la instalación
// vuelve a ser lenta (por ejemplo, con una cantidad de categorías o
// parejas mucho más grande de la habitual), esto corta la ejecución de
// forma prolija ANTES de que Apps Script la mate, guarda hasta dónde
// llegó, y avisa que hay que volver a correr el menú.
var LIMITE_MS_INSTALACION = 4.5 * 60 * 1000;

function etapaInstalacionAlcanzada_(etapa) {
  var actual = PropertiesService.getDocumentProperties().getProperty(PROP_ETAPA_INSTALACION) || '';
  return ETAPAS_INSTALACION.indexOf(actual) >= ETAPAS_INSTALACION.indexOf(etapa);
}
function marcarEtapaInstalacion_(etapa) {
  PropertiesService.getDocumentProperties().setProperty(PROP_ETAPA_INSTALACION, etapa);
}

function setupInicial() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var inicio = new Date().getTime();
  function seQuedaSinTiempo_() {
    return (new Date().getTime() - inicio) > LIMITE_MS_INSTALACION;
  }
  function avisarInstalacionParcial_() {
    mostrarAvisoSiSePuede_(
      'Instalación en progreso: se guardó lo que se alcanzó a hacer. Volvé a correr ' +
      '"Configurar planilla" del menú para continuar -- no va a duplicar ni perder nada de lo ya hecho.'
    );
  }

  if (!etapaInstalacionAlcanzada_('HOJAS_BASE')) {
    crearHojaCategoriasSiHaceFalta_(ss);
    crearHojaParejasSiHaceFalta_(ss);
    crearHojaPartidosSiHaceFalta_(ss);
    crearHojaPosicionesSiHaceFalta_(ss);
    crearHojaPanelSiHaceFalta_(ss);
    marcarEtapaInstalacion_('HOJAS_BASE');
  }
  if (seQuedaSinTiempo_()) { avisarInstalacionParcial_(); return; }

  // Se corre SIEMPRE (no solo al crear la hoja de cero): arregla el
  // formato de una hoja PARTIDOS que ya existía de antes de este arreglo
  // -- ver asegurarFormatoTextoPlanoSets_ más abajo.
  var shPartidosExistente = ss.getSheetByName(SHEET_PARTIDOS);
  if (shPartidosExistente) asegurarFormatoTextoPlanoSets_(shPartidosExistente);

  aplicarValidacionesParejas_(ss);
  aplicarValidacionPanel_(ss);
  actualizarPanelResumenParejas_(ss);
  marcarEtapaInstalacion_('VALIDACIONES');
  if (seQuedaSinTiempo_()) { avisarInstalacionParcial_(); return; }

  recalcularPosiciones_(ss);
  marcarEtapaInstalacion_('POSICIONES_CALC');
  if (seQuedaSinTiempo_()) { avisarInstalacionParcial_(); return; }

  marcarEtapaInstalacion_('COMPLETA');
  mostrarAvisoSiSePuede_(
    'Instalación COMPLETA: CATEGORIAS, PAREJAS, PARTIDOS, POSICIONES y PANEL configurados. ' +
    'No se tocó ninguna hoja ni dato que ya existiera.'
  );
}

function crearHojaCategoriasSiHaceFalta_(ss) {
  var sh = ss.getSheetByName(SHEET_CATEGORIAS);
  if (sh) return sh;
  sh = ss.insertSheet(SHEET_CATEGORIAS);
  sh.getRange(1, 1).setValue('CATEGORIA')
    .setFontWeight('bold').setBackground(COLOR_HEADER_BG).setFontColor(COLOR_HEADER_FG);
  sh.setColumnWidth(1, 220);
  var filas = CATEGORIAS_INICIALES.map(function (c) { return [c]; });
  sh.getRange(2, 1, filas.length, 1).setValues(filas);
  sh.setFrozenRows(1);
  return sh;
}

function crearHojaParejasSiHaceFalta_(ss) {
  var sh = ss.getSheetByName(SHEET_PAREJAS);
  if (sh) return sh;
  sh = ss.insertSheet(SHEET_PAREJAS);
  var headers = ['ID PAREJA', 'CATEGORIA', 'JUGADOR 1', 'JUGADOR 2', 'ESTADO'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground(COLOR_HEADER_BG).setFontColor(COLOR_HEADER_FG);
  [90, 170, 200, 200, 100].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setFrozenRows(1);
  return sh;
}

function crearHojaPartidosSiHaceFalta_(ss) {
  var sh = ss.getSheetByName(SHEET_PARTIDOS);
  if (sh) return sh;
  sh = ss.insertSheet(SHEET_PARTIDOS);
  var headers = ['ID PARTIDO', 'CATEGORIA', 'FECHA', 'PAREJA A', 'PAREJA B', 'SET 1', 'SET 2', 'SET 3 / STB', 'GANADOR', 'ESTADO'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground(COLOR_HEADER_BG).setFontColor(COLOR_HEADER_FG);
  [95, 140, 55, 230, 230, 75, 75, 95, 230, 100].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setFrozenRows(1);
  asegurarFormatoTextoPlanoSets_(sh);
  return sh;
}

// Formatea las columnas SET 1 / SET 2 / SET 3 de PARTIDOS como TEXTO
// PLANO. Es la corrección de fondo del bug de resultados: sin esto,
// Google Sheets autoconvierte un puntaje tipeado como "6-4" en una FECHA
// (6 de abril) apenas lo cargás en una celda con formato automático --
// la celda deja de contener el texto "6-4" en ese mismo instante, antes
// de que ningún código la lea. Aplicarlo de nuevo sobre una hoja que ya
// lo tiene no rompe nada (es puramente formato), así que se puede llamar
// las veces que haga falta.
function asegurarFormatoTextoPlanoSets_(sh) {
  sh.getRange(PARTIDOS_FIRST_ROW, COL_PARTIDOS.SET1, 998, 3).setNumberFormat('@');
}

function crearHojaPosicionesSiHaceFalta_(ss) {
  var sh = ss.getSheetByName(SHEET_POSICIONES);
  if (sh) return sh;
  sh = ss.insertSheet(SHEET_POSICIONES);
  [45, 230, 50, 50, 50, 75, 95, 105, 80, 105, 115, 105].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  return sh;
}

function crearHojaPanelSiHaceFalta_(ss) {
  var sh = ss.getSheetByName(SHEET_PANEL);
  if (sh) return sh;
  sh = ss.insertSheet(SHEET_PANEL);
  sh.getRange('A1:D1').merge().setValue('MASTER PÁDEL 360 — PANEL DE CONTROL')
    .setFontWeight('bold').setFontSize(13).setFontColor('#ffffff').setBackground(COLOR_TITULO_BG)
    .setVerticalAlignment('middle');
  sh.setRowHeight(1, 30);
  sh.getRange('B3').setValue('Categoría para generar fixture:').setFontWeight('bold')
    .setVerticalAlignment('middle');
  sh.getRange('C3').setBackground('#fff2cc').setVerticalAlignment('middle');
  sh.getRange('B5').setValue(
    'Elegí la categoría de la celda de arriba y después usá el menú "MASTER PÁDEL 360 → Generar fixture (categoría del PANEL)".'
  ).setFontStyle('italic').setFontColor('#666666').setWrap(true);
  [30, 260, 220, 30].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  return sh;
}

function aplicarValidacionesParejas_(ss) {
  var sh = ss.getSheetByName(SHEET_PAREJAS);
  if (!sh) return;
  var categorias = listaCategorias_(ss);
  if (categorias.length) {
    var dvCat = SpreadsheetApp.newDataValidation()
      .requireValueInList(categorias, true).setAllowInvalid(false).build();
    sh.getRange(PAREJAS_FIRST_ROW, COL_PAREJAS.CATEGORIA, 500, 1).setDataValidation(dvCat);
  }
  var dvEstado = SpreadsheetApp.newDataValidation()
    .requireValueInList(ESTADOS_PAREJA_VALIDOS, true).setAllowInvalid(false).build();
  sh.getRange(PAREJAS_FIRST_ROW, COL_PAREJAS.ESTADO, 500, 1).setDataValidation(dvEstado);
}

function aplicarValidacionPanel_(ss) {
  var sh = ss.getSheetByName(SHEET_PANEL);
  if (!sh) return;
  var categorias = listaCategorias_(ss);
  if (!categorias.length) return;
  var dv = SpreadsheetApp.newDataValidation()
    .requireValueInList(categorias, true).setAllowInvalid(false).build();
  sh.getRange(PANEL_CELDA_CATEGORIA).setDataValidation(dv);
}

// ============================================================
// PANEL: cuadro "PAREJAS INSCRIPTAS" (resumen en vivo, sin números
// escritos a mano en el código)
// ============================================================
// Reconstruye el cuadro de abajo hacia arriba cada vez que se llama:
// título, headers, una fila por cada categoría de la hoja CATEGORIAS
// (en el orden en que estén ahí) y una fila de TOTAL. La cantidad de
// parejas ACTIVAS de cada categoría NO se calcula acá en código -- se
// deja como una fórmula COUNTIFS de Sheets, para que quede recalculada
// sola apenas cambie algo en PAREJAS (agregar una pareja, dar de baja
// una, etc.), sin depender de ningún trigger ni de correr nada a mano.
// Esta función sí hace falta llamarla de nuevo cuando cambia la LISTA de
// categorías (agregar/sacar una categoría cambia cuántas filas hacen
// falta) -- eso lo dispara automáticamente manejarEdicion_ al detectar un
// cambio en la hoja CATEGORIAS, y setupInicial() también la corre siempre
// como parte de "Configurar planilla" por si hace falta repararla.
function actualizarPanelResumenParejas_(ss) {
  var sh = ss.getSheetByName(SHEET_PANEL);
  if (!sh) return;

  // Limpia todo el bloque anterior (valores, formato y cualquier merge
  // que haya quedado) antes de reconstruirlo -- así, si antes había más
  // categorías que ahora, no queda ninguna fila vieja colgando.
  sh.getRange(PANEL_RESUMEN_FILA_INICIO, 2, PANEL_RESUMEN_FILAS_RESERVADAS, 2).clear();

  var categorias = listaCategorias_(ss);
  if (!categorias.length) return; // sin categorías todavía: nada que mostrar

  var filaTitulo = PANEL_RESUMEN_FILA_INICIO;
  var filaHeader = filaTitulo + 1;
  var filaPrimeraCategoria = filaHeader + 1;
  var filaTotal = filaPrimeraCategoria + categorias.length;

  var valores = [];
  valores.push(['PAREJAS INSCRIPTAS', '']);
  valores.push(['CATEGORÍA', 'PAREJAS ACTIVAS']);
  categorias.forEach(function (cat) { valores.push([cat, '']); });
  valores.push(['TOTAL DE PAREJAS ACTIVAS', '']);

  sh.getRange(filaTitulo, 2, valores.length, 2).setValues(valores);

  // Fórmulas en vivo -- columna C. Cada una cuenta, dentro de PAREJAS,
  // cuántas filas tienen esa categoría (columna B) en estado ACTIVA
  // (columna E). El rango "B2:B" / "E2:E" es abierto (sin última fila),
  // así que sigue funcionando sin tocar nada acá aunque se carguen
  // cientos de parejas más adelante.
  categorias.forEach(function (cat, i) {
    var fila = filaPrimeraCategoria + i;
    sh.getRange(fila, 3).setFormula(
      '=COUNTIFS(PAREJAS!$B$' + PAREJAS_FIRST_ROW + ':$B,B' + fila +
      ',PAREJAS!$E$' + PAREJAS_FIRST_ROW + ':$E,"' + ESTADO_PAREJA_ACTIVA + '")'
    );
  });
  sh.getRange(filaTotal, 3).setFormula(
    '=COUNTIF(PAREJAS!$E$' + PAREJAS_FIRST_ROW + ':$E,"' + ESTADO_PAREJA_ACTIVA + '")'
  );

  // Formato: prolijo, coherente con el resto del PANEL.
  sh.getRange(filaTitulo, 2, 1, 2).merge()
    .setFontWeight('bold').setFontSize(11).setFontColor(COLOR_HEADER_FG)
    .setBackground(COLOR_HEADER_BG).setVerticalAlignment('middle');
  sh.setRowHeight(filaTitulo, 26);
  sh.getRange(filaHeader, 2, 1, 2).setFontWeight('bold').setBackground('#e8edf3');
  sh.getRange(filaTotal, 2, 1, 2).setFontWeight('bold').setBackground('#e8edf3');
}

// ============================================================
// CATEGORIAS: fuente única de verdad
// ============================================================
function listaCategorias_(ss) {
  var sh = ss.getSheetByName(SHEET_CATEGORIAS);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, 1).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var v = normalizar_(vals[i][0]);
    if (v) out.push(v);
  }
  return out;
}

// ============================================================
// onEdit
// ============================================================
function onEdit(e) {
  try {
    manejarEdicion_(e);
  } catch (err) {
    // Un error al procesar un edit nunca debe romper la edición del
    // usuario en la hoja -- se loguea y listo.
    console.error(err);
  }
}

function manejarEdicion_(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  var ss = sh.getParent();
  var nombreHoja = sh.getName();

  if (nombreHoja === SHEET_PAREJAS) {
    manejarEdicionParejas_(sh, e);
    return;
  }
  if (nombreHoja === SHEET_PARTIDOS) {
    manejarEdicionPartidos_(ss, sh, e);
    return;
  }
  if (nombreHoja === SHEET_CATEGORIAS) {
    // Agregar/sacar/renombrar una categoría cambia cuántas filas debe
    // tener el cuadro "PAREJAS INSCRIPTAS" del PANEL -- se reconstruye
    // solo, sin ejecutar nada a mano. Los NÚMEROS de cada fila (cuántas
    // parejas ACTIVAS hay) no dependen de esto: son fórmulas en vivo que
    // Sheets recalcula solo cuando cambia PAREJAS, no hace falta este
    // trigger para eso.
    actualizarPanelResumenParejas_(ss);
    return;
  }
}

// --- PAREJAS: autocompletar ID PAREJA y ESTADO por defecto ---
function manejarEdicionParejas_(sh, e) {
  var filas = filasDeRango_(e.range);
  for (var f = filas.start; f <= filas.end; f++) {
    if (f < PAREJAS_FIRST_ROW) continue;
    var jugador1 = normalizar_(sh.getRange(f, COL_PAREJAS.JUGADOR1).getValue());
    if (!jugador1) continue; // fila sin Jugador 1 todavía: no autocompletar nada
    var idActual = normalizar_(sh.getRange(f, COL_PAREJAS.ID).getValue());
    if (!idActual) {
      sh.getRange(f, COL_PAREJAS.ID).setValue(proximoIdPareja_(sh));
    }
    var estadoActual = normalizar_(sh.getRange(f, COL_PAREJAS.ESTADO).getValue());
    if (!estadoActual) {
      sh.getRange(f, COL_PAREJAS.ESTADO).setValue(ESTADO_PAREJA_ACTIVA);
    }
  }
}

function proximoIdPareja_(sh) {
  var last = sh.getLastRow();
  var max = 0;
  if (last >= PAREJAS_FIRST_ROW) {
    var vals = sh.getRange(PAREJAS_FIRST_ROW, COL_PAREJAS.ID, last - PAREJAS_FIRST_ROW + 1, 1).getValues();
    vals.forEach(function (row) {
      var m = /^P(\d+)$/.exec(normalizar_(row[0]));
      if (m) { var n = parseInt(m[1], 10); if (n > max) max = n; }
    });
  }
  return 'P' + String(max + 1).padStart(3, '0');
}

// --- PARTIDOS: calcular GANADOR/ESTADO a partir de los sets cargados ---
function manejarEdicionPartidos_(ss, sh, e) {
  var filas = filasDeRango_(e.range);
  var huboCambios = false;
  for (var f = filas.start; f <= filas.end; f++) {
    if (f < PARTIDOS_FIRST_ROW) continue;
    var parejaA = normalizar_(sh.getRange(f, COL_PARTIDOS.PAREJA_A).getValue());
    if (!parejaA) continue; // fila vacía (más allá del fixture cargado): nada que calcular
    recalcularResultadoPartido_(sh, f);
    huboCambios = true;
  }
  if (huboCambios) recalcularPosiciones_(ss);
}

// Acepta "6-4", "6/4" o "6 4" como formato de un set. Un set con games
// iguales (p.ej. "6-6" sin tie-break aclarado) se ignora por ambiguo: no
// suma juegos ni sets a ningún lado, no rompe el cálculo.
function parsearSet_(texto) {
  var t = normalizar_(texto);
  if (!t) return null;
  var m = t.match(/^(\d{1,2})\s*[-\/]\s*(\d{1,2})$/);
  if (!m) return null;
  var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
  if (a === b) return null;
  return { a: a, b: b };
}

// Lee una celda de set y, si Sheets la autoconvirtió en una FECHA (ver
// asegurarFormatoTextoPlanoSets_), la reconstruye a partir de DÍA y MES
// de esa fecha -- en ese orden, como corresponde al formato día-mes de
// Argentina -- y la reescribe en la celda como texto plano y VISIBLE
// (no es un cálculo escondido: la celda va a mostrar "6-4", no una
// fecha). Esto autorepara cualquier celda vieja apenas se la vuelve a
// procesar, sin que Gabriel tenga que borrarla y tipearla de nuevo.
function leerYNormalizarCeldaSet_(sh, fila, col) {
  var celda = sh.getRange(fila, col);
  var v = celda.getValue();
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var texto = v.getDate() + '-' + (v.getMonth() + 1);
    celda.setNumberFormat('@').setValue(texto);
    return texto;
  }
  return v;
}

function recalcularResultadoPartido_(sh, fila) {
  var sets = [
    parsearSet_(leerYNormalizarCeldaSet_(sh, fila, COL_PARTIDOS.SET1)),
    parsearSet_(leerYNormalizarCeldaSet_(sh, fila, COL_PARTIDOS.SET2)),
    parsearSet_(leerYNormalizarCeldaSet_(sh, fila, COL_PARTIDOS.SET3)),
  ];
  var setsA = 0, setsB = 0;
  sets.forEach(function (s) {
    if (!s) return;
    if (s.a > s.b) setsA++; else setsB++;
  });

  var ganador = '';
  var estado = ESTADO_PARTIDO_PENDIENTE;
  // Gana quien llega primero a 2 sets (partido al mejor de 3).
  if (setsA >= 2 || setsB >= 2) {
    var textoA = normalizar_(sh.getRange(fila, COL_PARTIDOS.PAREJA_A).getValue());
    var textoB = normalizar_(sh.getRange(fila, COL_PARTIDOS.PAREJA_B).getValue());
    ganador = (setsA > setsB) ? textoA : textoB;
    estado = ESTADO_PARTIDO_JUGADO;
  }
  sh.getRange(fila, COL_PARTIDOS.GANADOR).setValue(ganador);
  sh.getRange(fila, COL_PARTIDOS.ESTADO).setValue(estado)
    .setBackground(estado === ESTADO_PARTIDO_JUGADO ? COLOR_JUGADO_BG : COLOR_PENDIENTE_BG);
}

// ============================================================
// PAREJAS: lectura
// ============================================================
// Formato de celda para "Pareja A" / "Pareja B" en PARTIDOS: arranca con
// el ID de la pareja (p.ej. "P003") seguido de los nombres. Es a propósito
// -- el vínculo con PAREJAS (para la tabla de posiciones) se hace por ID,
// nunca por el texto completo, así que si más adelante corregís el nombre
// de un jugador en PAREJAS, la tabla de posiciones lo va a mostrar
// actualizado sin perder el historial de partidos ya jugados.
function nombrePareja_(p) {
  return p.id + ' · ' + normalizar_(p.jugador1) + ' / ' + normalizar_(p.jugador2);
}
function idDeCeldaPareja_(texto) {
  var m = /^([A-Za-z]+\d+)/.exec(normalizar_(texto));
  return m ? m[1] : '';
}

function parejasActivasDeCategoria_(shParejas, categoria) {
  var last = shParejas.getLastRow();
  var out = [];
  if (last < PAREJAS_FIRST_ROW) return out;
  var vals = shParejas.getRange(PAREJAS_FIRST_ROW, 1, last - PAREJAS_FIRST_ROW + 1, COL_PAREJAS.ESTADO).getValues();
  vals.forEach(function (row) {
    var cat = normalizar_(row[COL_PAREJAS.CATEGORIA - 1]);
    var estado = normalizarMayus_(row[COL_PAREJAS.ESTADO - 1]);
    var j1 = normalizar_(row[COL_PAREJAS.JUGADOR1 - 1]);
    var id = normalizar_(row[COL_PAREJAS.ID - 1]);
    if (cat === categoria && estado === ESTADO_PAREJA_ACTIVA && j1 && id) {
      out.push({
        id: id,
        categoria: cat,
        jugador1: j1,
        jugador2: normalizar_(row[COL_PAREJAS.JUGADOR2 - 1]),
      });
    }
  });
  return out;
}

// ============================================================
// Generación del fixture (round-robin, método del círculo)
// ============================================================
// Todos-contra-todos a una sola vuelta, genérico para cualquier cantidad
// de parejas. Si la cantidad es impar, agrega un BYE fantasma para que
// cada pareja descanse exactamente una vez. Devuelve un arreglo de
// rondas; cada ronda es un arreglo de partidos {parejaA, parejaB}
// (los partidos contra el BYE de esa ronda quedan afuera del resultado).
function generarRoundRobin_(parejas) {
  var lista = parejas.slice();
  if (lista.length % 2 !== 0) lista.push(null); // null = BYE
  var n = lista.length;
  var rondas = n - 1;
  var mitad = n / 2;
  var arr = lista.slice();
  var resultado = [];
  for (var r = 0; r < rondas; r++) {
    var partidosRonda = [];
    for (var i = 0; i < mitad; i++) {
      var a = arr[i];
      var b = arr[n - 1 - i];
      if (a && b) partidosRonda.push({ parejaA: a, parejaB: b });
    }
    resultado.push(partidosRonda);
    var last = arr[n - 1];
    for (var j = n - 1; j > 1; j--) arr[j] = arr[j - 1];
    arr[1] = last;
  }
  return resultado;
}

// ------------------------------------------------------------
// Excepción "ida y vuelta": ÚNICAMENTE para la categoría exacta
// CATEGORIA_IDA_Y_VUELTA (ver más abajo). El resto de las categorías
// nunca pasa por acá -- generarFixtureCategoria_ solo llama a esto
// cuando la categoría coincide exactamente con esa constante.
//
// No reimplementa el emparejamiento: toma las rondas de la "ida" que ya
// arma generarRoundRobin_ (probado y usado por todas las categorías) y
// les agrega, a continuación, las mismas rondas con Pareja A y Pareja B
// invertidas -- la "vuelta". Con 5 parejas activas, generarRoundRobin_
// ya devuelve exactamente 5 rondas de 2 partidos (agrega un BYE
// fantasma por ser impar, 1 pareja libre por ronda): esta función
// duplica eso a 10 rondas de 2 partidos = 20 partidos, preservando el
// mismo patrón de BYE en la vuelta que tuvo cada pareja en la ida.
function generarRoundRobinIdaYVuelta_(parejas) {
  var rondasIda = generarRoundRobin_(parejas);
  var rondasVuelta = rondasIda.map(function (partidosRonda) {
    return partidosRonda.map(function (p) {
      return { parejaA: p.parejaB, parejaB: p.parejaA };
    });
  });
  return rondasIda.concat(rondasVuelta);
}

// Categoría (comparación EXACTA, sin normalizar mayúsculas) que juega
// todos-contra-todos IDA Y VUELTA en vez de una sola vuelta. Vacía = sin
// excepción activa -- ninguna categoría coincide nunca con '', así que
// generarFixtureCategoria_ usa generarRoundRobin_ (una sola rueda) para
// todas. Para reactivar esta excepción más adelante, esta es la única
// línea que hace falta tocar -- ver el uso en generarFixtureCategoria_.
//
// "7ma Femenino" usó esta excepción mientras tuvo 5 parejas (todos-contra-
// todos ida y vuelta = 10 fechas). Al crecer a 7 parejas se decidió pasar
// a una sola rueda (7 fechas, 3 partidos por fecha, 21 partidos totales)
// -- generarRoundRobin_ ya arma exactamente eso solo, sin necesitar
// ningún cambio de algoritmo, así que alcanzó con vaciar esta constante.
var CATEGORIA_IDA_Y_VUELTA = '';

function generarFixtureDesdeMenu() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var categoria = categoriaSeleccionadaEnPanel_(ss);
  if (!categoria) {
    mostrarAvisoSiSePuede_('Elegí una categoría en la celda ' + PANEL_CELDA_CATEGORIA + ' de la hoja PANEL antes de generar el fixture.');
    return;
  }
  generarFixtureCategoria_(ss, categoria);
}

function categoriaSeleccionadaEnPanel_(ss) {
  var sh = ss.getSheetByName(SHEET_PANEL);
  if (!sh) return '';
  return normalizar_(sh.getRange(PANEL_CELDA_CATEGORIA).getValue());
}

function generarFixtureCategoria_(ss, categoria) {
  var shParejas = ss.getSheetByName(SHEET_PAREJAS);
  var shPartidos = ss.getSheetByName(SHEET_PARTIDOS);
  var shCategorias = ss.getSheetByName(SHEET_CATEGORIAS);
  if (!shParejas || !shPartidos || !shCategorias) {
    mostrarAvisoSiSePuede_('Faltan hojas del sistema -- corré "Configurar planilla" del menú primero.');
    return;
  }
  var categoriasValidas = listaCategorias_(ss);
  if (categoriasValidas.indexOf(categoria) === -1) {
    mostrarAvisoSiSePuede_('"' + categoria + '" no es una categoría válida (revisá la hoja CATEGORIAS).');
    return;
  }

  var parejas = parejasActivasDeCategoria_(shParejas, categoria);
  if (parejas.length < 2) {
    mostrarAvisoSiSePuede_(
      '"' + categoria + '" tiene ' + parejas.length + ' pareja(s) ACTIVA(s) -- hacen falta al menos 2 para generar un fixture.'
    );
    return;
  }

  var existentes = partidosDeCategoria_(shPartidos, categoria);
  if (existentes.length > 0) {
    var confirmado = confirmarSiSePuede_(
      'Ya existe un fixture para "' + categoria + '"',
      'Ya hay ' + existentes.length + ' partido(s) cargados para "' + categoria + '" en PARTIDOS (con los resultados que hayas cargado). ' +
      'Generarlo de nuevo va a BORRAR esos partidos y sus resultados, y crear un fixture nuevo desde cero. ¿Confirmás?'
    );
    if (!confirmado) {
      intentarToast_('Cancelado -- no se tocó el fixture de "' + categoria + '".');
      return;
    }
    borrarPartidosDeCategoria_(shPartidos, categoria);
  }

  // Excepción ida y vuelta (ver CATEGORIA_IDA_Y_VUELTA / generarRoundRobinIdaYVuelta_
  // más arriba) -- hoy no hay ninguna categoría usándola (constante
  // vacía), todas juegan una sola vuelta con generarRoundRobin_.
  var rondas = (categoria === CATEGORIA_IDA_Y_VUELTA)
    ? generarRoundRobinIdaYVuelta_(parejas)
    : generarRoundRobin_(parejas);
  var filasNuevas = [];
  var siguienteId = siguienteNumeroIdPartido_(shPartidos);
  rondas.forEach(function (partidosRonda, idx) {
    var fecha = idx + 1;
    partidosRonda.forEach(function (p) {
      filasNuevas.push([
        'PT' + String(siguienteId).padStart(4, '0'),
        categoria,
        fecha,
        nombrePareja_(p.parejaA),
        nombrePareja_(p.parejaB),
        '', '', '', '', ESTADO_PARTIDO_PENDIENTE,
      ]);
      siguienteId++;
    });
  });

  var last = shPartidos.getLastRow();
  var filaDestino = Math.max(last + 1, PARTIDOS_FIRST_ROW);
  shPartidos.getRange(filaDestino, 1, filasNuevas.length, COL_PARTIDOS.ESTADO).setValues(filasNuevas);
  shPartidos.getRange(filaDestino, COL_PARTIDOS.ESTADO, filasNuevas.length, 1).setBackground(COLOR_PENDIENTE_BG);

  recalcularPosiciones_(ss);

  mostrarAvisoSiSePuede_(
    'Fixture generado: "' + categoria + '" — ' + parejas.length + ' parejas, ' +
    rondas.length + ' fecha(s), ' + filasNuevas.length + ' partido(s).'
  );
}

function partidosDeCategoria_(sh, categoria) {
  var last = sh.getLastRow();
  var out = [];
  if (last < PARTIDOS_FIRST_ROW) return out;
  var vals = sh.getRange(PARTIDOS_FIRST_ROW, 1, last - PARTIDOS_FIRST_ROW + 1, COL_PARTIDOS.ESTADO).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (normalizar_(vals[i][COL_PARTIDOS.CATEGORIA - 1]) === categoria) {
      out.push({ fila: PARTIDOS_FIRST_ROW + i, valores: vals[i] });
    }
  }
  return out;
}

function borrarPartidosDeCategoria_(sh, categoria) {
  var last = sh.getLastRow();
  if (last < PARTIDOS_FIRST_ROW) return;
  var numCols = COL_PARTIDOS.ESTADO;
  var vals = sh.getRange(PARTIDOS_FIRST_ROW, 1, last - PARTIDOS_FIRST_ROW + 1, numCols).getValues();
  var conservadas = vals.filter(function (row) {
    return normalizar_(row[COL_PARTIDOS.CATEGORIA - 1]) !== categoria;
  });
  sh.getRange(PARTIDOS_FIRST_ROW, 1, last - PARTIDOS_FIRST_ROW + 1, numCols).clearContent();
  if (conservadas.length) {
    sh.getRange(PARTIDOS_FIRST_ROW, 1, conservadas.length, numCols).setValues(conservadas);
  }
}

function siguienteNumeroIdPartido_(sh) {
  var last = sh.getLastRow();
  var max = 0;
  if (last >= PARTIDOS_FIRST_ROW) {
    var vals = sh.getRange(PARTIDOS_FIRST_ROW, COL_PARTIDOS.ID, last - PARTIDOS_FIRST_ROW + 1, 1).getValues();
    vals.forEach(function (row) {
      var m = /^PT(\d+)$/.exec(normalizar_(row[0]));
      if (m) { var n = parseInt(m[1], 10); if (n > max) max = n; }
    });
  }
  return max + 1;
}

// ============================================================
// POSICIONES
// ============================================================
function recalcularPosicionesDesdeMenu() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  recalcularPosiciones_(ss);
  mostrarAvisoSiSePuede_('Tabla de posiciones actualizada.');
}

// recalcularPosiciones_ arma TODO el contenido de la hoja (valores,
// fondos, colores de fuente, negrita, tamaño, estilo, alineación) en
// memoria -- sin llamar una sola vez a getRange()/setValue() por celda --
// y recién al final lo escribe en un puñado de llamadas en bloque (una
// por cada propiedad, para TODA la hoja de una sola vez), más un merge()
// por cada fila de título. Antes, cada categoría hacía ~15 llamadas
// sueltas al servicio de Sheets (una por cada .setValue/.setBackground/
// .setFontColor/... encadenado); con varias categorías esa cantidad de
// viajes de ida y vuelta al servidor -- no el cálculo en sí, que es
// puramente en memoria y tarda milisegundos -- era la parte más lenta,
// con diferencia, de toda la instalación. Ahora la cantidad de llamadas
// no depende de cuántas categorías o parejas haya.
function recalcularPosiciones_(ss) {
  var shPos = crearHojaPosicionesSiHaceFalta_(ss);
  var shPartidos = ss.getSheetByName(SHEET_PARTIDOS);
  var shParejas = ss.getSheetByName(SHEET_PAREJAS);
  var categorias = listaCategorias_(ss);
  var numCols = POS_HEADERS.length;

  var previo = shPos.getLastRow();
  if (previo >= 1) shPos.getRange(1, 1, previo, numCols).clear(); // 1 sola llamada: borra valores Y formato de la tabla anterior

  var buffer = { valores: [], fondos: [], fuentes: [], negritas: [], tamanios: [], estilos: [], alinH: [], merges: [] };
  categorias.forEach(function (categoria) {
    var tabla = calcularTablaPosiciones_(shPartidos, shParejas, categoria);
    agregarBloquePosicionesAlBuffer_(buffer, categoria, tabla, numCols);
  });

  if (!buffer.valores.length) return; // no hay ninguna categoría cargada todavía

  var rango = shPos.getRange(1, 1, buffer.valores.length, numCols);
  rango.setValues(buffer.valores);
  rango.setBackgrounds(buffer.fondos);
  rango.setFontColors(buffer.fuentes);
  rango.setFontWeights(buffer.negritas);
  rango.setFontSizes(buffer.tamanios);
  rango.setFontStyles(buffer.estilos);
  rango.setHorizontalAlignments(buffer.alinH);
  shPos.setRowHeights(1, buffer.valores.length, 24);

  buffer.merges.forEach(function (fila) {
    shPos.getRange(fila, 1, 1, numCols).merge();
  });
}

function calcularTablaPosiciones_(shPartidos, shParejas, categoria) {
  var parejas = shParejas ? parejasActivasDeCategoria_(shParejas, categoria) : [];
  var stats = {};
  parejas.forEach(function (p) {
    stats[p.id] = {
      id: p.id, pareja: nombrePareja_(p), pj: 0, pg: 0, pp: 0, puntos: 0,
      setsFavor: 0, setsContra: 0, gamesFavor: 0, gamesContra: 0,
    };
  });

  // Enfrentamientos directos (para el 4to criterio de desempate, ver
  // compararPosiciones_): mapa de "idA|idB" (los dos IDs de la pareja,
  // ordenados alfabéticamente para no depender de quién haya sido Pareja
  // A o Pareja B en PARTIDOS) al ID de la pareja que ganó ESE partido.
  // Se arma acá, en la misma lectura de PARTIDOS que ya hace esta
  // función para PJ/PG/PP/sets/games -- no hace falta leer la hoja de
  // nuevo. Si dos parejas llegaran a jugar más de una vez en la misma
  // categoría (no debería pasar con el fixture todos-contra-todos
  // actual), queda el resultado del último partido JUGADO entre ellas
  // que se encuentre.
  var headToHead = {};

  if (shPartidos) {
    var last = shPartidos.getLastRow();
    if (last >= PARTIDOS_FIRST_ROW) {
      var vals = shPartidos.getRange(PARTIDOS_FIRST_ROW, 1, last - PARTIDOS_FIRST_ROW + 1, COL_PARTIDOS.ESTADO).getValues();
      vals.forEach(function (row) {
        if (normalizar_(row[COL_PARTIDOS.CATEGORIA - 1]) !== categoria) return;
        if (normalizarMayus_(row[COL_PARTIDOS.ESTADO - 1]) !== ESTADO_PARTIDO_JUGADO) return;

        var idA = idDeCeldaPareja_(row[COL_PARTIDOS.PAREJA_A - 1]);
        var idB = idDeCeldaPareja_(row[COL_PARTIDOS.PAREJA_B - 1]);
        var idGanador = idDeCeldaPareja_(row[COL_PARTIDOS.GANADOR - 1]);

        var sets = [
          parsearSet_(row[COL_PARTIDOS.SET1 - 1]),
          parsearSet_(row[COL_PARTIDOS.SET2 - 1]),
          parsearSet_(row[COL_PARTIDOS.SET3 - 1]),
        ];
        var setsA = 0, setsB = 0, gamesA = 0, gamesB = 0;
        sets.forEach(function (s) {
          if (!s) return;
          gamesA += s.a; gamesB += s.b;
          if (s.a > s.b) setsA++; else setsB++;
        });

        var statsA = stats[idA];
        if (statsA) {
          statsA.pj++;
          statsA.setsFavor += setsA; statsA.setsContra += setsB;
          statsA.gamesFavor += gamesA; statsA.gamesContra += gamesB;
          if (idGanador === idA) { statsA.pg++; statsA.puntos += 1; }
          else if (idGanador === idB) { statsA.pp++; }
        }
        var statsB = stats[idB];
        if (statsB) {
          statsB.pj++;
          statsB.setsFavor += setsB; statsB.setsContra += setsA;
          statsB.gamesFavor += gamesB; statsB.gamesContra += gamesA;
          if (idGanador === idB) { statsB.pg++; statsB.puntos += 1; }
          else if (idGanador === idA) { statsB.pp++; }
        }

        if (idA && idB && idGanador) {
          headToHead[[idA, idB].sort().join('|')] = idGanador;
        }
      });
    }
  }

  var lista = Object.keys(stats).map(function (k) { return stats[k]; });
  lista.sort(function (a, b) { return compararPosiciones_(a, b, headToHead); });
  return lista;
}

// Criterios oficiales de desempate de la Liga MASTER PÁDEL 360, en este
// orden exacto:
//   1) PUNTOS (desc).
//   2) DIF SETS = SETS A FAVOR - SETS EN CONTRA (desc).
//   3) DIF GAMES = GAMES A FAVOR - GAMES EN CONTRA (desc).
//   4) Enfrentamiento directo (JUGADO) entre las dos parejas empatadas --
//      gana quien le ganó el partido a la otra. `headToHead` lo arma
//      calcularTablaPosiciones_ (ver ahí): es un mapa de "idA|idB" (los
//      dos IDs de pareja, ordenados alfabéticamente, para no depender de
//      quién haya sido Pareja A o Pareja B en PARTIDOS) al ID de la
//      pareja que ganó ESE partido. Si todavía no jugaron entre sí (la
//      clave no está en el mapa), este criterio no hace nada y se sigue
//      de largo al fallback.
//   5) Nombre de pareja (asc) -- fallback técnico únicamente, para
//      garantizar un orden siempre estable aunque los 4 criterios de
//      arriba sigan empatados.
// Los IDs (a.id / b.id) son SIEMPRE los que identifican a la pareja --
// nunca se compara por nombre salvo en el fallback final del punto 5.
function compararPosiciones_(a, b, headToHead) {
  if (b.puntos !== a.puntos) return b.puntos - a.puntos;

  var difSetsA = a.setsFavor - a.setsContra;
  var difSetsB = b.setsFavor - b.setsContra;
  if (difSetsB !== difSetsA) return difSetsB - difSetsA;

  var difGamesA = a.gamesFavor - a.gamesContra;
  var difGamesB = b.gamesFavor - b.gamesContra;
  if (difGamesB !== difGamesA) return difGamesB - difGamesA;

  if (headToHead) {
    var idGanadorH2H = headToHead[[a.id, b.id].sort().join('|')];
    if (idGanadorH2H === a.id) return -1;
    if (idGanadorH2H === b.id) return 1;
  }

  return a.pareja.localeCompare(b.pareja);
}

// Agrega al `buffer` (ver recalcularPosiciones_) todas las filas de UNA
// categoría -- título, header + datos (o el aviso de "sin parejas"), y
// una fila en blanco de separador -- sin tocar la hoja todavía. Reproduce
// EXACTAMENTE el mismo layout de filas que la versión anterior (misma
// cantidad de filas, mismo contenido, mismo orden); lo único que cambia
// es que la escritura real a la hoja pasa a ser en bloque, una sola vez,
// al final de recalcularPosiciones_.
function agregarBloquePosicionesAlBuffer_(buffer, categoria, tabla, numCols) {
  function filaDe_(valor) {
    var v = new Array(numCols);
    for (var c = 0; c < numCols; c++) v[c] = valor;
    return v;
  }
  function empujarFila_(valores, fondo, fuente, negrita, tamanio, estilo, alinH) {
    buffer.valores.push(valores);
    buffer.fondos.push(filaDe_(fondo));
    buffer.fuentes.push(filaDe_(fuente));
    buffer.negritas.push(filaDe_(negrita));
    buffer.tamanios.push(filaDe_(tamanio));
    buffer.estilos.push(filaDe_(estilo));
    buffer.alinH.push(filaDe_(alinH));
  }
  function filaTextoUnico_(valor) {
    var v = filaDe_('');
    v[0] = valor;
    return v;
  }
  function filaEnBlanco_() {
    empujarFila_(filaDe_(''), '#ffffff', '#000000', 'normal', 10, 'normal', 'left');
  }

  // --- título (mergeado) ---
  empujarFila_(filaTextoUnico_(categoria), COLOR_TITULO_BG, '#ffffff', 'bold', 13, 'normal', 'left');
  buffer.merges.push(buffer.valores.length);

  if (!tabla.length) {
    empujarFila_(filaTextoUnico_('Sin parejas ACTIVAS todavía en esta categoría.'), '#ffffff', '#888888', 'normal', 10, 'italic', 'left');
    buffer.merges.push(buffer.valores.length);
    filaEnBlanco_();
    return;
  }

  // --- headers ---
  empujarFila_(POS_HEADERS.slice(), COLOR_HEADER_BG, COLOR_HEADER_FG, 'bold', 10, 'normal', 'center');

  // --- datos ---
  tabla.forEach(function (t, i) {
    empujarFila_([
      i + 1, t.pareja, t.pj, t.pg, t.pp, t.puntos,
      t.setsFavor, t.setsContra, t.setsFavor - t.setsContra,
      t.gamesFavor, t.gamesContra, t.gamesFavor - t.gamesContra,
    ], '#ffffff', '#000000', 'normal', 10, 'normal', 'center');
  });

  filaEnBlanco_(); // separador antes de la próxima categoría
}

// ============================================================
// Carga inicial real de parejas (una sola vez, a mano desde el editor)
// ============================================================
// Esta sección es carga de DATOS puntuales de la primera temporada, no
// arquitectura del sistema -- ninguna otra función de este archivo la usa
// ni depende de ella. Trabaja únicamente sobre la hoja PAREJAS: no toca
// PARTIDOS, POSICIONES, CATEGORIAS ni PANEL, y no genera ningún fixture.
//
// Verificación manual antes de cargar esto (recuento por categoría sobre
// la lista de abajo): 6ta Masculino 9, 7ma Masculino 8, 7ma Femenino 5,
// 8va Masculino 8, 8va Femenino 9 -- total 39. Sin parejas duplicadas
// (mismos dos jugadores, en cualquier orden, en la misma categoría).
var PAREJAS_INICIALES_CARGA = [
  { categoria: '6ta Masculino', jugador1: 'German Gonzalez', jugador2: 'Nicolas Chaijale' },
  { categoria: '7ma Femenino', jugador1: 'Sofia Movsesian', jugador2: 'Rocio Perez' },
  { categoria: '8va Femenino', jugador1: 'Lorena Pereyra', jugador2: 'Ana Maria Zelarayan' },
  { categoria: '7ma Femenino', jugador1: 'Romina Franco', jugador2: 'Soledad Franco' },
  { categoria: '7ma Femenino', jugador1: 'Analia Chiatti', jugador2: 'Anahi Romero' },
  { categoria: '6ta Masculino', jugador1: 'Facundo Quiroga', jugador2: 'Alejandro Camaras' },
  { categoria: '7ma Femenino', jugador1: 'Sabrina Squire', jugador2: 'Lorena Santa Cruz' },
  { categoria: '8va Masculino', jugador1: 'Franco Alfredo Sanna', jugador2: 'Carlos Maximiliano Ibarra' },
  { categoria: '8va Masculino', jugador1: 'Franco Gonzalez', jugador2: 'Leonardo Oviedo' },
  { categoria: '8va Masculino', jugador1: 'Simón Aldorino', jugador2: 'Facundo Broggi' },
  { categoria: '8va Masculino', jugador1: 'Matías Agustin Marconetti', jugador2: 'Franco Maximiliano Squillari' },
  { categoria: '8va Femenino', jugador1: 'Ximena Arrieta', jugador2: 'Mariangeles Arrieta' },
  { categoria: '8va Femenino', jugador1: 'Constanza González', jugador2: 'Cecilia Rodriguez' },
  { categoria: '8va Masculino', jugador1: 'Francisco Rodriguez', jugador2: 'Ignacio Smith' },
  { categoria: '7ma Masculino', jugador1: 'Gonzalo Pereyra', jugador2: 'Javier Boiko' },
  { categoria: '6ta Masculino', jugador1: 'Marcos David Neme', jugador2: 'Matias Losso' },
  { categoria: '8va Femenino', jugador1: 'Carla Revello', jugador2: 'Gabriela Vitale' },
  { categoria: '6ta Masculino', jugador1: 'Leo Tejeda', jugador2: 'Guillermo Giliberti' },
  { categoria: '6ta Masculino', jugador1: 'Marcos Caceres', jugador2: 'A CONFIRMAR' },
  { categoria: '7ma Masculino', jugador1: 'Alexis Ezequiel Medina', jugador2: 'Jonathan Ezequiel Lencina' },
  { categoria: '8va Masculino', jugador1: 'Julio Florentin', jugador2: 'Cristian Menegozzi' },
  { categoria: '6ta Masculino', jugador1: 'Diego Acevedo', jugador2: 'Juan Carlos Mengini' },
  { categoria: '7ma Masculino', jugador1: 'Christian Allende', jugador2: 'Lautaro Dominguez' },
  { categoria: '7ma Masculino', jugador1: 'Nicolas Diaz', jugador2: 'Ricardo Cari' },
  { categoria: '8va Femenino', jugador1: 'Marcia Vasallo', jugador2: 'Florencia Sanchez' },
  { categoria: '8va Masculino', jugador1: 'Nicolas Carrizo', jugador2: 'Facundo Etchandy' },
  { categoria: '8va Femenino', jugador1: 'Dalit Belochercovsky', jugador2: 'Milena Turrin' },
  { categoria: '7ma Masculino', jugador1: 'Jorge Ibarlucea', jugador2: 'Agusto Cardozo' },
  { categoria: '7ma Masculino', jugador1: 'Santiago Ochoa', jugador2: 'Gabriel Marrama' },
  { categoria: '7ma Masculino', jugador1: 'Marcos Barseghian', jugador2: 'Lucas Angel Martinez' },
  { categoria: '8va Femenino', jugador1: 'Antonella Re', jugador2: 'Catalina Colombo' },
  { categoria: '8va Femenino', jugador1: 'Salome Capdevila', jugador2: 'A CONFIRMAR' },
  { categoria: '8va Masculino', jugador1: 'Leonel Vallejos', jugador2: 'Cesar Almada' },
  { categoria: '8va Femenino', jugador1: 'Anabel Maltaneri', jugador2: 'Marta Mansilla' },
  { categoria: '6ta Masculino', jugador1: 'Pedro Tisberger', jugador2: 'Ezequiel Lozano' },
  { categoria: '7ma Femenino', jugador1: 'Giulliana Supicciati', jugador2: 'Lucia Paset' },
  { categoria: '6ta Masculino', jugador1: 'Federico Rizzo', jugador2: 'Lautaro' },
  { categoria: '7ma Masculino', jugador1: 'Matias Romano', jugador2: 'Roberto Roldan' },
  { categoria: '6ta Masculino', jugador1: 'Pablo Ruiz', jugador2: 'A CONFIRMAR' },
];

// Clave de una pareja para detectar duplicados sin importar el orden de
// los jugadores dentro de la categoría (Jugador A / Jugador B es la misma
// pareja que Jugador B / Jugador A).
function clavePareja_(categoria, jugador1, jugador2) {
  var nombres = [normalizarMayus_(jugador1), normalizarMayus_(jugador2)].sort();
  return normalizarMayus_(categoria) + '|' + nombres[0] + '|' + nombres[1];
}

// Igual que proximoIdPareja_ (mismo sistema de IDs, "P" + correlativo de
// 3 dígitos) pero calculando el máximo UNA sola vez para poder asignar
// varios IDs seguidos dentro de una misma carga en bloque -- proximoIdPareja_
// vuelve a leer la hoja en cada llamada, así que llamarla repetidas veces
// ANTES de escribir devolvería siempre el mismo ID.
function maxNumeroIdParejaActual_(sh) {
  var last = sh.getLastRow();
  var max = 0;
  if (last >= PAREJAS_FIRST_ROW) {
    var vals = sh.getRange(PAREJAS_FIRST_ROW, COL_PAREJAS.ID, last - PAREJAS_FIRST_ROW + 1, 1).getValues();
    vals.forEach(function (row) {
      var m = /^P(\d+)$/.exec(normalizar_(row[0]));
      if (m) { var n = parseInt(m[1], 10); if (n > max) max = n; }
    });
  }
  return max;
}

function cargarParejasIniciales() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_PAREJAS);
  if (!sh) {
    mostrarAvisoSiSePuede_('Falta la hoja PAREJAS -- corré "Configurar planilla" del menú primero.');
    return;
  }

  // Parejas que YA están en la hoja (para no duplicar), sin importar el
  // orden de los jugadores.
  var last = sh.getLastRow();
  var clavesExistentes = {};
  if (last >= PAREJAS_FIRST_ROW) {
    var filasActuales = sh.getRange(PAREJAS_FIRST_ROW, 1, last - PAREJAS_FIRST_ROW + 1, COL_PAREJAS.ESTADO).getValues();
    filasActuales.forEach(function (row) {
      var j1 = normalizar_(row[COL_PAREJAS.JUGADOR1 - 1]);
      if (!j1) return;
      var cat = normalizar_(row[COL_PAREJAS.CATEGORIA - 1]);
      var j2 = normalizar_(row[COL_PAREJAS.JUGADOR2 - 1]);
      clavesExistentes[clavePareja_(cat, j1, j2)] = true;
    });
  }

  var aAgregar = [];
  var yaExistian = 0;
  PAREJAS_INICIALES_CARGA.forEach(function (p) {
    var clave = clavePareja_(p.categoria, p.jugador1, p.jugador2);
    if (clavesExistentes[clave]) { yaExistian++; return; }
    clavesExistentes[clave] = true; // por si la lista de carga tuviera un duplicado interno
    aAgregar.push(p);
  });

  if (aAgregar.length) {
    var proximoNumero = maxNumeroIdParejaActual_(sh) + 1;
    var filasNuevas = aAgregar.map(function (p) {
      var fila = [
        'P' + String(proximoNumero).padStart(3, '0'),
        p.categoria, p.jugador1, p.jugador2, ESTADO_PAREJA_ACTIVA,
      ];
      proximoNumero++;
      return fila;
    });
    var filaDestino = Math.max(last + 1, PAREJAS_FIRST_ROW);
    sh.getRange(filaDestino, 1, filasNuevas.length, 5).setValues(filasNuevas);
  }

  // Resumen final: cantidad de parejas ACTIVAS por categoría sobre TODA
  // la hoja (no solo lo recién cargado), usando la misma lectura que ya
  // usa el resto del sistema (parejasActivasDeCategoria_).
  var categorias = listaCategorias_(ss);
  var lineas = [];
  var totalFinal = 0;
  categorias.forEach(function (categoria) {
    var cantidad = parejasActivasDeCategoria_(sh, categoria).length;
    totalFinal += cantidad;
    lineas.push('  ' + categoria + ': ' + cantidad);
  });

  mostrarAvisoSiSePuede_(
    'Carga inicial de parejas terminada.\n\n' +
    'Nuevas cargadas: ' + aAgregar.length + '\n' +
    'Ya existían (omitidas): ' + yaExistian + '\n\n' +
    'Cantidad final de parejas ACTIVAS por categoría:\n' + lineas.join('\n') + '\n\n' +
    'Total: ' + totalFinal
  );
}

// ============================================================
// Reparación: reprocesar resultados ya cargados en PARTIDOS
// ============================================================
// Para partidos como PT0001, cargados ANTES de este arreglo: recorre
// TODOS los partidos de PARTIDOS (sin tocar fixture, parejas ni
// categorías) y para cada uno con Pareja A cargada vuelve a calcular
// GANADOR/ESTADO desde los sets -- autoreparando en el camino cualquier
// celda de set que haya quedado guardada como fecha en vez de texto (ver
// leerYNormalizarCeldaSet_). Es seguro correrla las veces que hagan
// falta: un partido que ya estaba bien calculado simplemente se vuelve a
// calcular igual.
function reprocesarResultados() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_PARTIDOS);
  if (!sh) {
    mostrarAvisoSiSePuede_('Falta la hoja PARTIDOS -- corré "Configurar planilla" del menú primero.');
    return;
  }

  asegurarFormatoTextoPlanoSets_(sh);

  var last = sh.getLastRow();
  if (last < PARTIDOS_FIRST_ROW) {
    mostrarAvisoSiSePuede_('PARTIDOS no tiene ningún partido cargado todavía.');
    return;
  }

  var procesados = 0;
  var pasaronAJugado = 0;
  for (var fila = PARTIDOS_FIRST_ROW; fila <= last; fila++) {
    var parejaA = normalizar_(sh.getRange(fila, COL_PARTIDOS.PAREJA_A).getValue());
    if (!parejaA) continue; // fila vacía (más allá del fixture cargado)
    var estadoAntes = normalizar_(sh.getRange(fila, COL_PARTIDOS.ESTADO).getValue());
    recalcularResultadoPartido_(sh, fila);
    var estadoDespues = normalizar_(sh.getRange(fila, COL_PARTIDOS.ESTADO).getValue());
    procesados++;
    if (estadoAntes !== ESTADO_PARTIDO_JUGADO && estadoDespues === ESTADO_PARTIDO_JUGADO) pasaronAJugado++;
  }

  recalcularPosiciones_(ss);

  mostrarAvisoSiSePuede_(
    'Reprocesamiento de resultados terminado.\n\n' +
    'Partidos revisados: ' + procesados + '\n' +
    'Partidos que pasaron a JUGADO recién ahora: ' + pasaronAJugado + '\n\n' +
    'Si algún set se había guardado como fecha en vez de texto (la causa real del bug), ' +
    'ya quedó reescrito como texto plano y visible en su celda ("6-4", no una fecha). ' +
    'Revisá esos partidos: la reconstrucción asume formato día-mes (como "6-4" -> día 6, mes 4). ' +
    'Si algún resultado quedó invertido, corregí esa celda a mano una sola vez -- la columna ya ' +
    'quedó en texto plano, así que no va a volver a pasar.'
  );
}

// ============================================================
// Gestión de reservas pendientes (panel dentro de la Sheet)
// ============================================================
// Este archivo (container-bound, atado a esta planilla) y CodigoReservasAPI.gs
// (el backend de reservas) son DOS proyectos de Apps Script separados --
// no comparten runtime ni pueden llamarse funciones directamente entre
// sí. Por eso este panel NO reimplementa nada de la lógica de reservas
// (nunca escribe en RESERVAS/RETENCIONES a mano, nunca reimplementa
// LockService ni revalidaciones): llama por HTTP (UrlFetchApp) a las
// MISMAS acciones que ya expone esa Web App (listarPendientes,
// aprobarReserva, rechazarReserva) -- las mismas que ya usa el panel
// admin del sitio público (?admin=1). Esto es solo una interfaz
// alternativa sobre el backend que ya existe, pensada para el
// organizador que ya está trabajando directo en la planilla.
//
// RESERVAS_API_URL_ tiene que ser la MISMA URL que RESERVAS_API_URL en
// app.js -- si esa URL cambia alguna vez (nunca debería, ver las
// advertencias de todo este proyecto al respecto), hay que actualizarla
// acá también.
var RESERVAS_API_URL_ = 'https://script.google.com/macros/s/AKfycbxWpBJOCBr8oNLYfoaPAGUbB4KDjDaLJ4ars9B6Zv_f3prrCC-Tz1j-xEELxvvZlaJICQ/exec';

// Mismo contrato que reservasApiPost_ de app.js: POST con el cuerpo como
// JSON plano (la Web App lo parsea desde e.postData.contents sin mirar
// el Content-Type declarado). muteHttpExceptions:true para poder leer el
// cuerpo del error nosotros mismos en vez de que UrlFetchApp tire una
// excepción genérica de HTTP.
function llamarReservasApi_(accion, datos) {
  var resp = UrlFetchApp.fetch(RESERVAS_API_URL_ + '?accion=' + encodeURIComponent(accion), {
    method: 'post',
    contentType: 'text/plain',
    payload: JSON.stringify(datos || {}),
    muteHttpExceptions: true,
  });
  var payload = null;
  try { payload = JSON.parse(resp.getContentText()); } catch (e) { /* payload queda null -- se maneja abajo */ }
  if (!payload || !payload.ok) {
    throw new Error((payload && payload.error) || ('El servidor de reservas no respondió correctamente (HTTP ' + resp.getResponseCode() + ').'));
  }
  return payload.data;
}

// La contraseña de administrador de RESERVAS vive en el PropertiesService
// de ESE OTRO proyecto (CodigoReservasAPI.gs) -- este script no tiene
// forma de leerla directamente. Se pide una sola vez acá (Ui.prompt) y se
// guarda en las Propiedades de ESTE script (una clave separada, propia
// de este proyecto) solo después de validarla con un pedido real -- así
// nunca queda cacheada una contraseña incorrecta, y no hace falta
// volver a tipearla en cada uso.
var CLAVE_ADMIN_RESERVAS_PROP_ = 'CLAVE_ADMIN_RESERVAS_CACHE';

function gestionarReservasDesdeMenu() {
  var ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (e) {
    console.log('[MASTER PÁDEL 360] Gestionar reservas requiere abrir la hoja desde el navegador (sin interfaz disponible).');
    return;
  }

  var props = PropertiesService.getScriptProperties();
  var clave = props.getProperty(CLAVE_ADMIN_RESERVAS_PROP_);

  if (!clave) {
    var resp = ui.prompt('Gestionar reservas', 'Ingresá la contraseña de administrador de reservas:', ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    clave = normalizar_(resp.getResponseText());
    if (!clave) { mostrarAvisoSiSePuede_('No ingresaste ninguna contraseña.'); return; }
  }

  // Esta llamada YA hace, de paso, el primer listarPendientes real -- se
  // usaba antes solo para validar la contraseña y se descartaba el
  // resultado. El endpoint de reservas es conocido por ser inestable
  // (medido en vivo: la misma llamada puede tardar 1s o 20s+ segundos
  // después, o devolver una respuesta rara) -- pedir la lista DE NUEVO
  // apenas se abre el diálogo (como se hacía antes, en cargar()) duplica
  // la exposición a esa inestabilidad justo en el momento más sensible.
  // Ahora se reusa este mismo resultado como dato inicial del diálogo --
  // ver pendientesIniciales más abajo -- así el panel abre ya con los
  // datos, sin ninguna llamada de red adicional al arrancar.
  var pendientesIniciales;
  try {
    pendientesIniciales = llamarReservasApi_('listarPendientes', { clave: clave });
  } catch (e) {
    props.deleteProperty(CLAVE_ADMIN_RESERVAS_PROP_);
    mostrarAvisoSiSePuede_('No se pudo entrar a "Gestionar reservas": ' + ((e && e.message) || 'contraseña incorrecta.'));
    return;
  }
  props.setProperty(CLAVE_ADMIN_RESERVAS_PROP_, clave);

  var template = HtmlService.createTemplateFromFile('GestionarReservas');
  template.clave = clave;
  template.pendientesIniciales = pendientesIniciales;
  var html = template.evaluate().setWidth(680).setHeight(620);
  ui.showModalDialog(html, 'Gestionar reservas pendientes');
}

// ---- Llamadas desde el diálogo (google.script.run) ----
// La contraseña viaja desde el propio HTML (se la pasó gestionarReservasDesdeMenu_
// al abrir el diálogo) -- nunca queda hardcodeada acá ni se vuelve a leer
// de PropertiesService en cada click, para no depender de que siga
// cacheada mientras el diálogo ya está abierto.
function reservasAdminListarPendientes(clave) {
  return llamarReservasApi_('listarPendientes', { clave: clave });
}
function reservasAdminAprobar(clave, idReserva) {
  return llamarReservasApi_('aprobarReserva', { clave: clave, idReserva: idReserva });
}
function reservasAdminRechazar(clave, idReserva) {
  return llamarReservasApi_('rechazarReserva', { clave: clave, idReserva: idReserva });
}