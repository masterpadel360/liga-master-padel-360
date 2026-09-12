/**
 * MASTER PÁDEL 360 — Reservas API
 * =======================================================================
 * Proyecto de Apps Script SEPARADO tanto de "MasterPadel360.gs" (el
 * administrativo, CodigoAdminLiga.gs en este repo local) como de la Web
 * App pública de solo lectura (CodigoWebApp.gs / API_URL). Va publicado
 * como su propia Web App, con su propia URL -- NUNCA se pega este código
 * dentro de ninguno de los otros dos proyectos.
 *
 * Por qué un tercer proyecto y no uno de los que ya existen:
 *   - CodigoWebApp.gs documenta, a propósito, que nunca debe tener NINGUNA
 *     función de escritura -- por eso separaron esa Web App del
 *     administrativo en su momento. Meter acá las funciones de reserva
 *     (que sí escriben) rompería exactamente esa garantía.
 *   - CodigoAdminLiga.gs administra la parte DEPORTIVA (parejas, fixture,
 *     posiciones) y no se toca en esta etapa.
 *   - Este proyecto nuevo tiene un único propósito: reservas de cancha.
 *     Nunca escribe en CATEGORIAS, PAREJAS, PARTIDOS ni POSICIONES -- solo
 *     las LEE, para validar contra datos reales del fixture. Escribe
 *     únicamente en las 4 hojas nuevas que crea él mismo (ver más abajo).
 *
 * La API_URL actual (CodigoWebApp.gs) NO se toca ni se reemplaza. Esta es
 * una URL nueva y aparte -- en app.js va a vivir como una constante
 * distinta (por ejemplo RESERVAS_API_URL), en un paso posterior.
 *
 * =======================================================================
 * ACCIONES PÚBLICAS (doGet / doPost, ?accion=...)
 * =======================================================================
 *   disponibilidad          (GET)  Sin parámetros. Devuelve, para cada día
 *                                  dentro de la ventana reservable, las
 *                                  franjas con lugar y cuántas canchas
 *                                  quedan libres en cada una.
 *   partidosDisponibles     (GET)  ?categoria=... Devuelve los cruces
 *                                  PENDIENTES de esa categoría que todavía
 *                                  no tienen reserva ni retención activa,
 *                                  y que además pertenecen a la FECHA EN
 *                                  JUEGO que el organizador cargó a mano
 *                                  en CATEGORIAS (columna B) para esa
 *                                  categoría -- ver
 *                                  leerFechaEnJuegoPorCategoria_. Si esa
 *                                  categoría todavía no tiene una fecha
 *                                  cargada, devuelve una lista vacía (no
 *                                  "todas las fechas").
 *   retenerTurno            (POST) {idPartido, fecha, horarioInicio,
 *                                  horarioFin} Bloquea el lugar por 10
 *                                  minutos. Devuelve {idRetencion, ...}.
 *   confirmarReserva        (POST) {idRetencion, nombre, telefono,
 *                                  comprobanteBase64, comprobanteNombreArchivo,
 *                                  comprobanteTipoMime} Sube el comprobante
 *                                  y crea la reserva en estado
 *                                  PENDIENTE_APROBACION (ver más abajo) --
 *                                  ya NO queda RESERVADO automáticamente.
 *                                  Asigna cancha (queda bloqueada ya
 *                                  mismo) y devuelve el link de gestión.
 *   consultarReserva        (GET)  ?token=... Devuelve SOLO los datos de
 *                                  esa reserva puntual. Nunca una lista.
 *   buscarReserva           (POST) {telefono, codigo} Recuperación sin el
 *                                  link privado -- para cuando el jugador
 *                                  no lo guardó. Requiere AMBOS datos
 *                                  (nunca alcanza con solo el teléfono) y
 *                                  devuelve lo mismo que consultarReserva
 *                                  más el propio tokenGestion, para que el
 *                                  frontend pueda mostrar la gestión igual
 *                                  que si hubiera entrado por el link.
 *   cancelarReserva         (POST) {token} Cancela esa reserva (pierde la
 *                                  seña) y libera el horario + el cruce.
 *                                  Solo funciona si está RESERVADO -- una
 *                                  PENDIENTE_APROBACION no se puede
 *                                  cancelar todavía (ver más abajo).
 *   verificarAcceso         (POST) {clave} Contraseña general de acceso a
 *                                  toda la web (no es específica de
 *                                  reservas -- ver ACCESO GENERAL abajo).
 *                                  Devuelve {token, version} para guardar
 *                                  en el navegador.
 *   validarTokenAcceso      (POST) {token, version} Revalida en segundo
 *                                  plano un acceso ya guardado -- si la
 *                                  contraseña general cambió desde
 *                                  entonces, devuelve {valido:false}.
 *   listarPendientes        (POST) {clave} SOLO ADMIN (contraseña
 *                                  separada de la general). Devuelve
 *                                  todas las reservas PENDIENTE_APROBACION
 *                                  con todos sus datos (acá sí, teléfono
 *                                  incluido).
 *   aprobarReserva          (POST) {clave, idReserva} SOLO ADMIN.
 *                                  PENDIENTE_APROBACION -> RESERVADO.
 *   rechazarReserva         (POST) {clave, idReserva} SOLO ADMIN.
 *                                  PENDIENTE_APROBACION -> RECHAZADO, y
 *                                  libera el horario + el cruce ya mismo.
 *
 * Ninguna acción de jugador devuelve el teléfono de nadie salvo a quien
 * ya tiene el propio token de esa reserva, y ninguna acción de jugador
 * permite listar todas las reservas -- eso es exclusivo de listarPendientes
 * (admin).
 *
 * CODIGO_RESERVA: además del token largo (para el link directo), cada
 * reserva confirmada recibe un código corto (8 caracteres, alfabeto sin
 * ambigüedades tipo O/0 o I/1/L) pensado para que el jugador lo anote a
 * mano. Por sí solo NO sirve para nada -- buscarReserva exige que
 * coincida además el teléfono exacto de esa misma fila, así que conocer
 * un teléfono (o un código) suelto no alcanza para entrar a una reserva
 * ajena.
 *
 * =======================================================================
 * ESTADOS DE RESERVA (ESTADO_RESERVA, columna fórmula -- nunca se escribe
 * a mano, se calcula sola a partir de 3 fechas: FECHA_RECHAZO,
 * FECHA_CANCELACION y FECHA_APROBACION, ver formulaEstadoReserva_)
 * =======================================================================
 *   PENDIENTE_APROBACION  Recién confirmada (comprobante ya subido), a la
 *                         espera de que el admin la revise. Ocupa cupo y
 *                         cancha EXACTAMENTE igual que RESERVADO -- ese
 *                         turno no vuelve a aparecer disponible mientras
 *                         siga así. No vence sola (la retención de 10
 *                         minutos ya terminó su trabajo en cuanto se
 *                         confirmó; de acá en más, solo el admin decide).
 *   RESERVADO             El admin la aprobó. Igual que antes: se puede
 *                         cancelar (pierde la seña), y pasa sola a
 *                         FINALIZADO cuando termina el horario.
 *   RECHAZADO             El admin la rechazó. Libera el horario y el
 *                         cruce de inmediato (deja de contar como
 *                         "activa" para disponibilidad).
 *   CANCELADO             El jugador canceló una que estaba RESERVADO.
 *   FINALIZADO             Ya pasó el horario de una que estaba RESERVADO.
 *
 * =======================================================================
 * ACCESO GENERAL A LA WEB (contraseña de la liga, NO la de admin)
 * =======================================================================
 * Toda la web (no solo reservas) pide una contraseña general antes de
 * mostrar nada -- ver verificarAcceso/validarTokenAcceso arriba. Vive acá
 * (y no en CodigoWebApp.gs) por el mismo motivo que todo lo demás: ese
 * proyecto no puede tener funciones nuevas. La contraseña vive en
 * PropertiesService (Propiedades del proyecto), NO hardcodeada de forma
 * fija en el código -- así se puede cambiar sin volver a pegar ni
 * redesplegar nada. Ver obtenerClaveAccesoLiga_/obtenerVersionAccesoLiga_
 * para el nombre exacto de las propiedades y el valor por defecto si no
 * se configuró ninguna.
 *
 * El frontend NUNCA guarda la contraseña en sí -- guarda un token
 * derivado (HMAC de la contraseña + una "versión"), así que cambiar la
 * propiedad ACCESO_LIGA_VERSION invalida de un saque todos los accesos
 * guardados en todos los navegadores, sin tener que saber ni borrar nada
 * de cada dispositivo.
 *
 * =======================================================================
 * ADMINISTRACIÓN DE RESERVAS PENDIENTES (listarPendientes/aprobarReserva/
 * rechazarReserva)
 * =======================================================================
 * Pensado para uso personal del organizador, no para jugadores: se entra
 * agregando ?admin=1 a la URL de la web (no aparece en ningún menú). Pide
 * una contraseña de administrador SEPARADA de la contraseña general --
 * ver obtenerClaveAdmin_ para el valor por defecto y cómo cambiarla
 * (misma idea: PropertiesService, sin redesplegar). aprobarReserva y
 * rechazarReserva revalidan el estado actual DENTRO del LockService antes
 * de escribir nada -- si dos pedidos llegan casi juntos (dos clics, dos
 * pestañas), el segundo encuentra que ya no está PENDIENTE_APROBACION y
 * se corta con un error, nunca se procesa dos veces.
 *
 * "Marcar pago completo" (el saldo de $27.000, aparte de la seña) sigue
 * siendo tan simple como editar 2 celdas a mano en la hoja RESERVAS,
 * igual que antes:
 *   1) MONTO_PAGADO: escribir 36000 (SALDO_PENDIENTE se recalcula solo,
 *      es una fórmula).
 *   2) ESTADO_PAGO: elegir "PAGO_COMPLETO" del desplegable (ya viene con
 *      validación de datos, ver aplicarValidacionesReservas_).
 *
 * BLOQUEOS y EXCEPCIONES_RESERVA también se cargan a mano, directo en sus
 * hojas -- no tienen ninguna acción pública para escribirlas.
 *
 * =======================================================================
 * PENDIENTE DESPUÉS DE PEGAR ESTE CÓDIGO
 * =======================================================================
 *   1) Correr configuracionInicial() una sola vez desde el editor de Apps
 *      Script (crea/actualiza las hojas, aplica validaciones, activa el
 *      trigger de limpieza, repara horarios y migra reservas viejas al
 *      nuevo esquema de aprobación -- ver repararHorariosTexto_,
 *      migrarCodigosReservaExistentes_ y migrarAprobacionExistente_).
 *   2) (Opcional pero recomendado) En el editor de Apps Script, abrir
 *      "Configuración del proyecto" → "Propiedades de secuencia de
 *      comandos" y agregar CLAVE_ACCESO_LIGA y CLAVE_ADMIN_RESERVAS con
 *      tus propias contraseñas. Si no se configuran, se usan los valores
 *      por defecto del código (ver obtenerClaveAccesoLiga_ /
 *      obtenerClaveAdmin_) -- funciona igual, pero es mejor cambiarlos.
 *   3) Publicar como Web App ("Implementar" → "Nueva implementación" →
 *      tipo "Aplicación web" → Ejecutar como: yo, Acceso: Cualquiera).
 *   4) La carpeta de Drive "Comprobantes - Liga Master Pádel 360" se crea
 *      SOLA la primera vez que alguien confirma una reserva (ver
 *      obtenerCarpetaComprobantes_) -- no hace falta crearla a mano.
 */

// ============================================================
// Configuración
// ============================================================
var ID_PLANILLA = '1MYPDiK8tUn_khbJsYnKotahhFehcM2N7i3JcTZi8Mhc';

// Hojas deportivas ya existentes -- SOLO LECTURA desde este proyecto,
// nunca se escribe nada acá.
var SHEET_CATEGORIAS = 'CATEGORIAS';
var SHEET_PAREJAS = 'PAREJAS';
var SHEET_PARTIDOS = 'PARTIDOS';

// Hojas nuevas de este proyecto (lectura + escritura).
var SHEET_RESERVAS = 'RESERVAS';
var SHEET_RETENCIONES = 'RETENCIONES';
var SHEET_BLOQUEOS = 'BLOQUEOS';
var SHEET_EXCEPCIONES = 'EXCEPCIONES_RESERVA';

// Mismo layout de columnas que CodigoAdminLiga.gs / CodigoWebApp.gs para
// las hojas deportivas -- no se toca, solo se lee.
var COL_PAREJAS = { ID: 1, CATEGORIA: 2, JUGADOR1: 3, JUGADOR2: 4, ESTADO: 5 };
var COL_PARTIDOS = {
  ID: 1, CATEGORIA: 2, FECHA: 3, PAREJA_A: 4, PAREJA_B: 5,
  SET1: 6, SET2: 7, SET3: 8, GANADOR: 9, ESTADO: 10,
};
// CATEGORIAS (columna A, ya existía) + FECHA_EN_JUEGO (columna B, NUEVA
// -- ver leerFechaEnJuegoPorCategoria_ más abajo). Es un valor 100%
// administrativo: lo carga a mano el organizador directo en la hoja de
// cálculo, columna B, una fila por categoría. Este proyecto SOLO LO LEE,
// nunca lo escribe -- ninguna acción pública lo modifica.
var COL_CATEGORIAS = { CATEGORIA: 1, FECHA_EN_JUEGO: 2 };
var PAREJAS_FIRST_ROW = 2;
var PARTIDOS_FIRST_ROW = 2;
var ESTADO_PAREJA_ACTIVA = 'ACTIVA';
var ESTADO_PARTIDO_PENDIENTE = 'PENDIENTE';

// Columnas de las hojas nuevas (ver headers exactos en cada
// crearHojaXSiHaceFalta_ más abajo -- este objeto tiene que reflejar
// exactamente ese mismo orden).
//
// Nota sobre nombres: se evita la "ñ" en identificadores de código (no en
// los headers de texto libre de las hojas, que sí pueden llevarla) para
// no depender de que el runtime de Apps Script acepte identificadores
// Unicode -- "SENA" en vez de "SEÑA" en todo lo que sea var/propiedad.
var COL_RESERVAS = {
  ID_RESERVA: 1, TOKEN_GESTION: 2, FECHA: 3, HORARIO_INICIO: 4, HORARIO_FIN: 5,
  CANCHA: 6, CATEGORIA: 7, ID_PARTIDO: 8, ID_PAREJA_A: 9, PAREJA_A: 10,
  ID_PAREJA_B: 11, PAREJA_B: 12, NOMBRE_SOLICITANTE: 13, TELEFONO_SOLICITANTE: 14,
  VALOR_TOTAL: 15, MONTO_PAGADO: 16, SALDO_PENDIENTE: 17, ESTADO_RESERVA: 18,
  ESTADO_PAGO: 19, COMPROBANTE_SENA_URL: 20, FECHA_CREACION: 21, FECHA_CANCELACION: 22,
  SENA_PERDIDA: 23,
  // Agregado después de la V1 -- a propósito al FINAL (columna 24) y
  // nunca insertado en medio, para que las reservas ya existentes (con
  // solo 23 columnas) sigan teniendo cada dato viejo en la misma
  // posición de siempre. migrarCodigosReservaExistentes_ rellena esta
  // columna para las filas que ya existían antes de este cambio.
  CODIGO_RESERVA: 24,
  // Igual criterio: agregadas al final (25/26), nunca insertadas en
  // medio. migrarAprobacionExistente_ rellena FECHA_APROBACION para las
  // reservas que ya existían antes del flujo de aprobación (quedan
  // RESERVADO, no PENDIENTE_APROBACION, que sería incorrecto para algo
  // que ya se había confirmado bajo las reglas viejas).
  FECHA_APROBACION: 25,
  FECHA_RECHAZO: 26,
  // Mismo criterio que las anteriores: agregada al final (columna 27),
  // nunca insertada en medio. Guarda el idRetencion que originó esta
  // reserva -- es la clave de idempotencia de confirmarReserva (ver
  // mp360ReservasConfirmar_ y buscarReservaPorIdRetencionOrigen_): permite
  // reconocer un reintento del mismo pedido (por ejemplo, tras un HTTP 404
  // o timeout del lado del cliente que en realidad sí llegó a procesarse)
  // y devolver la reserva ya creada en vez de crear una segunda. Las
  // reservas de antes de este cambio quedan con esta columna vacía -- no
  // hace falta migrarla ni rellenarla: su retención original ya no existe
  // hace rato, así que nunca podrían "reintentarse" de todos modos.
  ID_RETENCION_ORIGEN: 27,
};
var COL_RETENCIONES = {
  ID_RETENCION: 1, FECHA: 2, HORARIO_INICIO: 3, HORARIO_FIN: 4, ID_PARTIDO: 5, FECHA_CREACION: 6,
};
var COL_BLOQUEOS = {
  ID_BLOQUEO: 1, FECHA: 2, HORARIO_INICIO: 3, HORARIO_FIN: 4, CANCHA: 5, MOTIVO: 6, FECHA_CREACION: 7,
};
var COL_EXCEPCIONES = {
  ID_EXCEPCION: 1, ID_PARTIDO: 2, SEMANA: 3, MOTIVO: 4, CREADO_POR: 5, FECHA_CREACION: 6,
};

// Valores de estado.
var ESTADO_RESERVA_PENDIENTE_APROBACION = 'PENDIENTE_APROBACION';
var ESTADO_RESERVA_RESERVADO = 'RESERVADO';
var ESTADO_RESERVA_CANCELADO = 'CANCELADO';
var ESTADO_RESERVA_RECHAZADO = 'RECHAZADO';
var ESTADO_RESERVA_FINALIZADO = 'FINALIZADO';
var ESTADO_PAGO_SALDO_PENDIENTE = 'SALDO_PENDIENTE';
var ESTADO_PAGO_PAGO_COMPLETO = 'PAGO_COMPLETO';

// ============================================================
// Contraseñas (acceso general a la web + admin de reservas)
// ============================================================
// Viven en PropertiesService, NO fijas en el código -- así se cambian
// sin volver a pegar ni redesplegar nada (Apps Script: editor → ⚙️
// "Configuración del proyecto" → "Propiedades de secuencia de
// comandos"). Si no se configuró ninguna, se usa el valor por defecto de
// acá abajo -- la web funciona igual desde el primer momento, pero es
// buena idea cambiarlos por unos propios.
var CLAVE_ACCESO_LIGA_DEFECTO_ = 'padel360';
var ACCESO_LIGA_VERSION_DEFECTO_ = 'v1';
var CLAVE_ADMIN_RESERVAS_DEFECTO_ = 'admin360padel';

function obtenerClaveAccesoLiga_() {
  return PropertiesService.getScriptProperties().getProperty('CLAVE_ACCESO_LIGA') || CLAVE_ACCESO_LIGA_DEFECTO_;
}
// Cambiar esta propiedad (ACCESO_LIGA_VERSION) es lo que invalida TODOS
// los accesos ya guardados en todos los navegadores de un saque -- el
// token que cada uno guardó se calculó con la versión vieja, así que deja
// de coincidir apenas cambia, sin tener que tocar ni saber nada de cada
// dispositivo. Cambiar CLAVE_ACCESO_LIGA sola, sin tocar la versión, NO
// desloguea a nadie ya adentro -- solo afecta a quien todavía no entró.
function obtenerVersionAccesoLiga_() {
  return PropertiesService.getScriptProperties().getProperty('ACCESO_LIGA_VERSION') || ACCESO_LIGA_VERSION_DEFECTO_;
}
function obtenerClaveAdmin_() {
  return PropertiesService.getScriptProperties().getProperty('CLAVE_ADMIN_RESERVAS') || CLAVE_ADMIN_RESERVAS_DEFECTO_;
}
function verificarClaveAdmin_(clave) {
  var c = normalizar_(clave);
  return !!c && c === obtenerClaveAdmin_();
}

// Token de acceso general: HMAC-SHA256 de un payload fijo, firmado con
// "contraseña actual + versión actual" como clave. Nunca se guarda en
// ningún lado (ni acá ni en el navegador) -- se recalcula cada vez que
// hace falta verificar, y da el mismo resultado siempre que la
// contraseña/versión no hayan cambiado. Esto es lo que le permite al
// frontend guardar SOLO el token (nunca la contraseña real) y aun así
// poder revalidarlo más adelante sin que el servidor tenga que recordar
// nada de cada dispositivo.
function generarTokenAcceso_() {
  var secreto = obtenerClaveAccesoLiga_() + '|' + obtenerVersionAccesoLiga_();
  var firma = Utilities.computeHmacSha256Signature('acceso-liga-master-padel-360', secreto);
  return Utilities.base64EncodeWebSafe(firma);
}

// Montos y datos de pago (definidos acá una sola vez -- si el club cambia
// el precio del turno, este es el único lugar que hay que tocar).
var VALOR_TOTAL_TURNO = 36000;
var MONTO_SENA = 9000;
var ALIAS_TRANSFERENCIA = 'masterpadel.360';

// Reglas de negocio.
var DURACION_TURNO_MINUTOS = 90;
var CANTIDAD_CANCHAS = 3;
var RETENCION_MINUTOS = 10;
var VENTANA_RESERVA_DIAS = 14;
// 14 de septiembre de 2026 (mes 0-indexado en JS: 8 = septiembre). Define
// dónde arranca la "semana de competencia 1" -- ver numeroSemanaCompetencia_.
var FECHA_INICIO_LIGA = new Date(2026, 8, 14);

// Nombre de la carpeta de Drive donde se guardan los comprobantes. Se crea
// sola la primera vez que hace falta (ver obtenerCarpetaComprobantes_).
var CARPETA_COMPROBANTES = 'Comprobantes - Liga Master Pádel 360';

var NOMBRES_DIA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// ============================================================
// Grilla semanal acordada -- ver el análisis completo de disponibilidad
// de canchas hecho antes de programar esto. Son las franjas de 90 minutos
// ya descontando las clases fijas de los profesores (Gabriel/Pepi/Dani),
// distribuidas entre las 3 canchas de la forma que deja más lugar posible
// para la Liga. Si el horario de algún profesor cambia, ESTE es el único
// lugar del archivo que hay que volver a calcular y actualizar a mano --
// no hay ninguna otra parte del código que dependa de esos horarios.
//
// Clave = Date.getDay() (0=domingo ... 6=sábado).
// ============================================================
// Profesores (horarios exactos, fuente de verdad 2026-09-10):
//   Gabriel:  Martes 19-21 · Miércoles 19-21 · Jueves 19-21
//   Pepi:     Martes 15-19 · Jueves 15-19
//   Dani:     Lunes 19-20 · Martes 9-11 · Miércoles 8-9 y 15-19 ·
//             Jueves 15:30-16:30 (único cruce real con otro profesor,
//             con Pepi) · Viernes 8-9, 15-18 y 19-20
// De lunes a viernes se ofrece desde las 18:00 en vez de más tarde,
// usando SIEMPRE una franja única por bloque de 90' (nunca dos franjas
// que se superpongan en el reloj): contarOcupadasEnFranja_ cuenta
// cualquier reserva/retención que se solape con el horario pedido sin
// importar en qué cancha haya quedado, así que dos franjas del mismo
// día que se cruzan en el tiempo competirían por el mismo cupo aunque
// representen canchas físicas distintas -- eso se probó a fondo (ver
// registro de pruebas) y producía falsos "sin lugar" según el orden en
// que se reservaba. Por eso, aunque una cancha se libere de una clase a
// mitad de un bloque (p.ej. lunes/viernes: Dani libera su cancha a las
// 20:00, en medio del bloque 19:30-21:00), esa cancha se suma recién al
// bloque siguiente en el que las 3 canchas ya están libres a la vez.
var GRILLA_SEMANAL = {
  0: [], // Domingo: sin turnos.
  1: [ // Lunes (18:00 a 23:00) -- clase: Dani 19:00-20:00
    { inicio: '18:00', fin: '19:30', canchas: 2 },
    { inicio: '19:30', fin: '21:00', canchas: 2 },
    { inicio: '21:00', fin: '22:30', canchas: 3 },
  ],
  2: [ // Martes (10:00 a 23:30) -- clases: Dani 9-11, Pepi 15-19, Gabriel 19-21 (nunca se pisan entre sí)
    { inicio: '10:30', fin: '12:00', canchas: 2 }, // Dani hasta las 11:00
    { inicio: '18:00', fin: '19:30', canchas: 2 }, // Pepi hasta las 19:00, después Gabriel
    { inicio: '19:30', fin: '21:00', canchas: 2 }, // Gabriel hasta las 21:00
    { inicio: '21:00', fin: '22:30', canchas: 3 },
  ],
  3: [ // Miércoles (18:00 a 23:00) -- clases: Dani 15-19, Gabriel 19-21 (consecutivas)
    { inicio: '18:00', fin: '19:30', canchas: 2 }, // Dani hasta las 19:00, después Gabriel
    { inicio: '19:30', fin: '21:00', canchas: 2 }, // Gabriel hasta las 21:00
    { inicio: '21:00', fin: '22:30', canchas: 3 },
  ],
  4: [ // Jueves (10:00 a 23:30) -- clases: Pepi 15-19, Dani 15:30-16:30 (cruce real), Gabriel 19-21
    { inicio: '10:30', fin: '12:00', canchas: 3 }, // sin clases antes de las 15:00
    { inicio: '18:00', fin: '19:30', canchas: 2 }, // Pepi hasta las 19:00, después Gabriel
    { inicio: '19:30', fin: '21:00', canchas: 2 }, // Gabriel hasta las 21:00
    { inicio: '21:00', fin: '22:30', canchas: 3 },
  ],
  5: [ // Viernes (18:00 a 23:00) -- clase relevante: Dani 19:00-20:00 (15-18 termina antes de abrir)
    { inicio: '18:00', fin: '19:30', canchas: 2 },
    { inicio: '19:30', fin: '21:00', canchas: 2 },
    { inicio: '21:00', fin: '22:30', canchas: 3 },
  ],
  6: [ // Sábado (09:30 a 13:30) -- sin cambios
    { inicio: '09:30', fin: '11:00', canchas: 3 },
    { inicio: '11:00', fin: '12:30', canchas: 3 },
  ],
};

// ============================================================
// Utilidades chicas (mismo estilo que los otros 2 archivos)
// ============================================================
function normalizar_(v) {
  return String(v === null || v === undefined ? '' : v).trim();
}
function normalizarMayus_(v) {
  return normalizar_(v).toUpperCase();
}

// Lee un campo de horario ("17:00") de forma segura aunque la celda haya
// quedado como una hora REAL (Date con fecha base 30/12/1899) por el
// auto-detectado de Sheets -- ver el comentario largo en
// crearHojaReservasSiHaceFalta_. getHours()/getMinutes() (nunca las
// variantes UTC) dan la hora de pared correcta acá porque tanto la
// escritura como esta lectura corren siempre en el mismo huso horario
// del proyecto de Apps Script. Si la celda ya es texto plano (el caso
// normal desde que se aplicó setNumberFormat('@')), se devuelve tal cual.
function normalizarHorario_(valor) {
  if (valor instanceof Date) {
    var hh = String(valor.getHours()).padStart(2, '0');
    var mm = String(valor.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }
  return normalizar_(valor);
}

function abrirPlanilla_() {
  return SpreadsheetApp.openById(ID_PLANILLA);
}

// Convierte un número de columna (1, 2, 3...) a su letra de columna en
// Sheets (A, B, C...). Se usa para armar, como texto, las fórmulas que se
// escriben en RESERVAS (ESTADO_RESERVA / SALDO_PENDIENTE / SENA_PERDIDA),
// que necesitan referenciar otras celdas de la misma fila por su
// dirección A1.
function columnaLetra_(numero) {
  var letra = '';
  while (numero > 0) {
    var resto = (numero - 1) % 26;
    letra = String.fromCharCode(65 + resto) + letra;
    numero = Math.floor((numero - 1) / 26);
  }
  return letra;
}

// ============================================================
// Fechas y horarios
// ============================================================
// Compara solo año/mes/día -- ignora la hora, así una fecha con hora
// 00:00:00 (como las que devuelve getValues() de una columna de fecha en
// Sheets) siempre matchea correctamente contra un Date armado a mano.
function mismaFecha_(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// "2026-09-16" -> Date. Devuelve null si el texto no tiene ese formato
// exacto -- nunca se confía en un formato de fecha ambiguo (tipo "16/09")
// que podría leerse distinto según la configuración regional.
function parsearFechaISO_(texto) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalizar_(texto));
  if (!m) return null;
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return null;
  return d;
}
function formatearFechaISO_(fecha) {
  var y = fecha.getFullYear();
  var m = String(fecha.getMonth() + 1).padStart(2, '0');
  var d = String(fecha.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

// Dos franjas "HH:MM"-"HH:MM" se superponen si empiezan antes de que
// termine la otra. La comparación de texto funciona bien acá porque las
// horas siempre vienen con cero adelante (p.ej. "09:00", nunca "9:00"),
// así que el orden alfabético coincide con el orden horario real.
function horariosSeSuperponen_(inicio1, fin1, inicio2, fin2) {
  return inicio1 < fin2 && inicio2 < fin1;
}

// Semana de competencia: bloques de 7 días arrancando en FECHA_INICIO_LIGA
// (semana 1 = esos primeros 7 días, semana 2 los siguientes 7, etc.). Es
// aritmética pura sobre fechas calendario reales -- a propósito NO tiene
// ninguna relación con el número de "Fecha" (ronda) del fixture, que es
// solo un contador interno del campeonato sin fecha calendario asociada.
// Lo que importa acá es en qué semana real el jugador eligió jugar.
function numeroSemanaCompetencia_(fecha) {
  var msPorDia = 24 * 60 * 60 * 1000;
  var inicio = new Date(FECHA_INICIO_LIGA.getFullYear(), FECHA_INICIO_LIGA.getMonth(), FECHA_INICIO_LIGA.getDate());
  var f = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
  var dias = Math.floor((f.getTime() - inicio.getTime()) / msPorDia);
  return Math.floor(dias / 7) + 1;
}

// Ventana reservable = desde hoy (o desde el inicio de la Liga, lo que
// sea más tarde -- no tiene sentido ofrecer turnos antes de que arranque
// el campeonato) hasta VENTANA_RESERVA_DIAS días después de hoy. Es
// corrediza: se recalcula en cada pedido a partir de "ahora", nunca queda
// fija a una fecha vieja.
function limitesVentanaReservable_() {
  var hoy = new Date();
  var hoyMedianoche = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  var inicioLiga = new Date(FECHA_INICIO_LIGA.getFullYear(), FECHA_INICIO_LIGA.getMonth(), FECHA_INICIO_LIGA.getDate());
  var minimo = inicioLiga > hoyMedianoche ? inicioLiga : hoyMedianoche;
  var maximo = new Date(hoyMedianoche.getTime() + VENTANA_RESERVA_DIAS * 24 * 60 * 60 * 1000);
  return { minimo: minimo, maximo: maximo };
}
function fechaDentroDeVentanaReservable_(fecha) {
  var limites = limitesVentanaReservable_();
  var f = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
  return f.getTime() >= limites.minimo.getTime() && f.getTime() <= limites.maximo.getTime();
}

function franjaValidaParaFecha_(fecha, horarioInicio, horarioFin) {
  var franjas = GRILLA_SEMANAL[fecha.getDay()] || [];
  for (var i = 0; i < franjas.length; i++) {
    if (franjas[i].inicio === horarioInicio && franjas[i].fin === horarioFin) return franjas[i];
  }
  return null;
}

// ============================================================
// Lectura de datos deportivos -- SOLO LECTURA, nunca se escribe nada acá.
// Mismas funciones/formato que ya usa CodigoWebApp.gs para no inventar un
// criterio nuevo de cómo se guardan los cruces en PARTIDOS.
// ============================================================
function leerCategorias_(ss) {
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

// Fecha (número de ronda) que el organizador habilitó para reservar en
// esta categoría -- columna B de CATEGORIAS ("FECHA EN JUEGO"), cargada
// a mano en la hoja de cálculo. Nunca se escribe desde acá. Si la celda
// está vacía o no es un número, se devuelve null a propósito -- NUNCA se
// asume "todas las fechas" ni "la fecha 1" como default: sin un valor
// administrativo explícito, mp360ReservasGetPartidosDisponibles no
// muestra ningún cruce para esa categoría (mejor no mostrar nada a que
// se mezclen fechas por accidente).
function leerFechaEnJuegoPorCategoria_(ss, categoria) {
  var sh = ss.getSheetByName(SHEET_CATEGORIAS);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2, 1, last - 1, COL_CATEGORIAS.FECHA_EN_JUEGO).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (normalizar_(vals[i][COL_CATEGORIAS.CATEGORIA - 1]) !== categoria) continue;
    var crudo = vals[i][COL_CATEGORIAS.FECHA_EN_JUEGO - 1];
    if (crudo === '' || crudo === null || crudo === undefined) return null;
    var n = Number(crudo);
    return isNaN(n) ? null : n;
  }
  return null;
}

// Celda de pareja en PARTIDOS: "P006 · Nombre1 / Nombre2".
function idDeCeldaPareja_(texto) {
  var m = /^([A-Za-z]+\d+)/.exec(normalizar_(texto));
  return m ? m[1] : '';
}
function nombresDeCeldaPareja_(texto) {
  var t = normalizar_(texto);
  var m = /^[A-Za-z]+\d+\s*·\s*(.+)$/.exec(t);
  return m ? m[1] : t;
}

// Cruces PENDIENTES (todavía sin jugar) de una categoría -- lo que el
// jugador puede elegir para reservar. Nunca se arma un cruce a mano: si
// no está en PARTIDOS con ese ID, no existe.
function leerPartidosPendientesDeCategoria_(ss, categoria) {
  var sh = ss.getSheetByName(SHEET_PARTIDOS);
  var out = [];
  if (!sh) return out;
  var last = sh.getLastRow();
  if (last < PARTIDOS_FIRST_ROW) return out;
  var vals = sh.getRange(PARTIDOS_FIRST_ROW, 1, last - PARTIDOS_FIRST_ROW + 1, COL_PARTIDOS.ESTADO).getValues();
  vals.forEach(function (row) {
    if (normalizar_(row[COL_PARTIDOS.CATEGORIA - 1]) !== categoria) return;
    if (normalizarMayus_(row[COL_PARTIDOS.ESTADO - 1]) !== ESTADO_PARTIDO_PENDIENTE) return;
    var idPartido = normalizar_(row[COL_PARTIDOS.ID - 1]);
    var parejaATexto = normalizar_(row[COL_PARTIDOS.PAREJA_A - 1]);
    var parejaBTexto = normalizar_(row[COL_PARTIDOS.PAREJA_B - 1]);
    if (!idPartido || !parejaATexto || !parejaBTexto) return;
    out.push({
      idPartido: idPartido,
      fecha: Number(row[COL_PARTIDOS.FECHA - 1]) || null,
      idParejaA: idDeCeldaPareja_(parejaATexto),
      parejaA: nombresDeCeldaPareja_(parejaATexto),
      idParejaB: idDeCeldaPareja_(parejaBTexto),
      parejaB: nombresDeCeldaPareja_(parejaBTexto),
    });
  });
  return out;
}

// Un partido puntual por su ID -- se usa para validar contra lo que el
// jugador dice que quiere reservar (nunca se confía en nombres/categoría
// que mande el navegador, se vuelve a leer todo desde PARTIDOS).
function buscarPartidoPorId_(ss, idPartido) {
  var sh = ss.getSheetByName(SHEET_PARTIDOS);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < PARTIDOS_FIRST_ROW) return null;
  var vals = sh.getRange(PARTIDOS_FIRST_ROW, 1, last - PARTIDOS_FIRST_ROW + 1, COL_PARTIDOS.ESTADO).getValues();
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    if (normalizar_(row[COL_PARTIDOS.ID - 1]) !== idPartido) continue;
    var parejaATexto = normalizar_(row[COL_PARTIDOS.PAREJA_A - 1]);
    var parejaBTexto = normalizar_(row[COL_PARTIDOS.PAREJA_B - 1]);
    return {
      idPartido: idPartido,
      categoria: normalizar_(row[COL_PARTIDOS.CATEGORIA - 1]),
      idParejaA: idDeCeldaPareja_(parejaATexto),
      parejaA: nombresDeCeldaPareja_(parejaATexto),
      idParejaB: idDeCeldaPareja_(parejaBTexto),
      parejaB: nombresDeCeldaPareja_(parejaBTexto),
      estado: normalizarMayus_(row[COL_PARTIDOS.ESTADO - 1]),
    };
  }
  return null;
}

// ============================================================
// Creación de hojas nuevas -- idempotente (si ya existe, no la toca),
// mismo patrón que crearHojaXSiHaceFalta_ de CodigoAdminLiga.gs.
// ============================================================
function crearHojaReservasSiHaceFalta_(ss) {
  var sh = ss.getSheetByName(SHEET_RESERVAS);
  if (sh) return sh;
  sh = ss.insertSheet(SHEET_RESERVAS);
  var headers = [
    'ID_RESERVA', 'TOKEN_GESTION', 'FECHA', 'HORARIO_INICIO', 'HORARIO_FIN',
    'CANCHA', 'CATEGORIA', 'ID_PARTIDO', 'ID_PAREJA_A', 'PAREJA_A',
    'ID_PAREJA_B', 'PAREJA_B', 'NOMBRE_SOLICITANTE', 'TELEFONO_SOLICITANTE',
    'VALOR_TOTAL', 'MONTO_PAGADO', 'SALDO_PENDIENTE', 'ESTADO_RESERVA',
    'ESTADO_PAGO', 'COMPROBANTE_SENA_URL', 'FECHA_CREACION', 'FECHA_CANCELACION',
    'SENA_PERDIDA', 'CODIGO_RESERVA', 'FECHA_APROBACION', 'FECHA_RECHAZO',
    'ID_RETENCION_ORIGEN',
  ];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(1, COL_RESERVAS.ESTADO_RESERVA).setNote(
    'No se escribe a mano: es una fórmula. PENDIENTE_APROBACION apenas se confirma -> RESERVADO cuando se completa FECHA_APROBACION (botón Aprobar) o RECHAZADO cuando se completa FECHA_RECHAZO (botón Rechazar) -> FINALIZADO solo si estaba RESERVADO y ya pasó el horario. CANCELADO si se completa FECHA_CANCELACION (el jugador canceló una ya RESERVADO).'
  );
  sh.getRange(1, COL_RESERVAS.SALDO_PENDIENTE).setNote('Fórmula: VALOR_TOTAL - MONTO_PAGADO.');
  sh.getRange(1, COL_RESERVAS.SENA_PERDIDA).setNote('Fórmula: se completa sola si ESTADO_RESERVA = CANCELADO.');
  sh.getRange(1, COL_RESERVAS.CODIGO_RESERVA).setNote(
    'Código corto para que el jugador recupere su reserva sin el link (ver acción buscarReserva). No es secuencial ni predecible -- no hace falta protegerlo especialmente, pero tampoco hace falta compartirlo con nadie.'
  );
  sh.getRange(1, COL_RESERVAS.FECHA_APROBACION).setNote(
    'No se escribe a mano: la completa aprobarReserva (panel de administración, ?admin=1) cuando el organizador aprueba una PENDIENTE_APROBACION.'
  );
  sh.getRange(1, COL_RESERVAS.FECHA_RECHAZO).setNote(
    'No se escribe a mano: la completa rechazarReserva (panel de administración, ?admin=1) cuando el organizador rechaza una PENDIENTE_APROBACION. Libera el horario y el cruce de inmediato.'
  );
  sh.getRange(1, COL_RESERVAS.ID_RETENCION_ORIGEN).setNote(
    'Clave de idempotencia de confirmarReserva: el idRetencion que creó esta fila. Un reintento del mismo pedido (mismo idRetencion) nunca crea una fila nueva -- devuelve esta misma reserva. No se usa para nada más, no hace falta compartirla ni protegerla especialmente.'
  );
  // Texto plano forzado en HORARIO_INICIO/HORARIO_FIN -- si no, Sheets
  // auto-detecta un valor como "17:00" y lo convierte solo a una hora
  // real (serial numérico con fecha base 30/12/1899), lo que rompe tanto
  // la fórmula de ESTADO_RESERVA (TIMEVALUE espera texto, no una hora ya
  // convertida -- por eso daba #VALUE!) como cualquier lectura de este
  // campo desde afuera (aparecía como "Sat Dec 30 1899 17:00:00 GMT...").
  // Se aplica a un rango amplio (no solo hasta la última fila) para que
  // también cubra las reservas que todavía no existen.
  sh.getRange(2, COL_RESERVAS.HORARIO_INICIO, 998, 1).setNumberFormat('@');
  sh.getRange(2, COL_RESERVAS.HORARIO_FIN, 998, 1).setNumberFormat('@');
  return sh;
}

function crearHojaRetencionesSiHaceFalta_(ss) {
  var sh = ss.getSheetByName(SHEET_RETENCIONES);
  if (sh) return sh;
  sh = ss.insertSheet(SHEET_RETENCIONES);
  var headers = ['ID_RETENCION', 'FECHA', 'HORARIO_INICIO', 'HORARIO_FIN', 'ID_PARTIDO', 'FECHA_CREACION'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(1, 1).setNote(
    'Filas temporales (10 minutos). No hace falta borrarlas a mano: dejan de contar solas apenas vencen, y además se limpian cada 1 hora con un trigger automático.'
  );
  // Mismo motivo que en RESERVAS: texto plano forzado para que Sheets no
  // auto-convierta "17:00" a una hora real.
  sh.getRange(2, COL_RETENCIONES.HORARIO_INICIO, 998, 1).setNumberFormat('@');
  sh.getRange(2, COL_RETENCIONES.HORARIO_FIN, 998, 1).setNumberFormat('@');
  return sh;
}

function crearHojaBloqueosSiHaceFalta_(ss) {
  var sh = ss.getSheetByName(SHEET_BLOQUEOS);
  if (sh) return sh;
  sh = ss.insertSheet(SHEET_BLOQUEOS);
  var headers = ['ID_BLOQUEO', 'FECHA', 'HORARIO_INICIO', 'HORARIO_FIN', 'CANCHA', 'MOTIVO', 'FECHA_CREACION'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(1, COL_BLOQUEOS.CANCHA).setNote('Poné 1, 2 o 3 para bloquear una cancha puntual, o TODAS para bloquear las 3.');
  sh.getRange(1, COL_BLOQUEOS.HORARIO_INICIO).setNote('Formato HH:MM, ej. 19:00. No hace falta que coincida con una franja exacta de la grilla: cualquier solapamiento resta disponibilidad.');
  // Esta hoja se carga a mano -- mismo texto-plano forzado para que
  // tipear "19:00" en la hoja no se convierta solo en una hora real.
  sh.getRange(2, COL_BLOQUEOS.HORARIO_INICIO, 998, 1).setNumberFormat('@');
  sh.getRange(2, COL_BLOQUEOS.HORARIO_FIN, 998, 1).setNumberFormat('@');
  return sh;
}

function crearHojaExcepcionesSiHaceFalta_(ss) {
  var sh = ss.getSheetByName(SHEET_EXCEPCIONES);
  if (sh) return sh;
  sh = ss.insertSheet(SHEET_EXCEPCIONES);
  var headers = ['ID_EXCEPCION', 'ID_PARTIDO', 'SEMANA', 'MOTIVO', 'CREADO_POR', 'FECHA_CREACION'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(1, COL_EXCEPCIONES.ID_PARTIDO).setNote('El ID_PARTIDO exacto de PARTIDOS (ej. PT0001) al que se le permite jugarse aunque alguna de sus parejas ya tenga otra reserva esa semana.');
  sh.getRange(1, COL_EXCEPCIONES.SEMANA).setNote('Número de semana de competencia (1, 2, 3...) al que aplica la excepción -- no un rango de fechas.');
  return sh;
}

// Dropdown para ESTADO_PAGO (mismo patrón que aplicarValidacionesParejas_
// de CodigoAdminLiga.gs). ESTADO_RESERVA NO lleva validación de lista
// porque es una fórmula -- una validación ahí solo estorbaría.
function aplicarValidacionesReservas_(ss) {
  var sh = crearHojaReservasSiHaceFalta_(ss);
  var dvEstadoPago = SpreadsheetApp.newDataValidation()
    .requireValueInList([ESTADO_PAGO_SALDO_PENDIENTE, ESTADO_PAGO_PAGO_COMPLETO], true)
    .setAllowInvalid(false)
    .build();
  sh.getRange(2, COL_RESERVAS.ESTADO_PAGO, 998, 1).setDataValidation(dvEstadoPago);
}

// ============================================================
// Lectura de las hojas de reservas
// ============================================================
// Reservas activas = todo lo que ocupa cupo real: RESERVADO,
// PENDIENTE_APROBACION y FINALIZADO. CANCELADO y RECHAZADO quedan afuera
// a propósito -- las dos formas de terminar SIN ocupar el horario (una
// la elige el jugador cancelando algo ya aprobado, la otra el admin
// rechazando algo pendiente). Se lee el valor YA CALCULADO de
// ESTADO_RESERVA (es una fórmula, pero getValues() siempre devuelve el
// resultado, nunca el texto de la fórmula).
function leerReservasActivas_(ss) {
  var sh = crearHojaReservasSiHaceFalta_(ss);
  var last = sh.getLastRow();
  var out = [];
  if (last < 2) return out;
  var vals = sh.getRange(2, 1, last - 1, COL_RESERVAS.SENA_PERDIDA).getValues();
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    var estado = normalizar_(row[COL_RESERVAS.ESTADO_RESERVA - 1]);
    if (estado === ESTADO_RESERVA_CANCELADO || estado === ESTADO_RESERVA_RECHAZADO) continue;
    var fecha = row[COL_RESERVAS.FECHA - 1];
    if (!(fecha instanceof Date)) continue;
    out.push({
      fila: i + 2,
      idReserva: normalizar_(row[COL_RESERVAS.ID_RESERVA - 1]),
      fecha: fecha,
      horarioInicio: normalizarHorario_(row[COL_RESERVAS.HORARIO_INICIO - 1]),
      horarioFin: normalizarHorario_(row[COL_RESERVAS.HORARIO_FIN - 1]),
      cancha: Number(row[COL_RESERVAS.CANCHA - 1]) || 0,
      categoria: normalizar_(row[COL_RESERVAS.CATEGORIA - 1]),
      idPartido: normalizar_(row[COL_RESERVAS.ID_PARTIDO - 1]),
      idParejaA: normalizar_(row[COL_RESERVAS.ID_PAREJA_A - 1]),
      idParejaB: normalizar_(row[COL_RESERVAS.ID_PAREJA_B - 1]),
      estadoReserva: estado,
    });
  }
  return out;
}

// Retenciones vivas = creadas hace <= RETENCION_MINUTOS. Una retención
// vencida simplemente no entra en esta lista -- no hace falta borrarla
// para que "deje de contar", eso lo hace el trigger de limpieza aparte,
// por prolijidad, no por corrección.
function leerRetencionesVivas_(ss) {
  var sh = crearHojaRetencionesSiHaceFalta_(ss);
  var last = sh.getLastRow();
  var out = [];
  if (last < 2) return out;
  var vals = sh.getRange(2, 1, last - 1, COL_RETENCIONES.FECHA_CREACION).getValues();
  var ahora = new Date().getTime();
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    var fechaCreacion = row[COL_RETENCIONES.FECHA_CREACION - 1];
    if (!(fechaCreacion instanceof Date)) continue;
    var edadMinutos = (ahora - fechaCreacion.getTime()) / 60000;
    if (edadMinutos > RETENCION_MINUTOS) continue;
    var fecha = row[COL_RETENCIONES.FECHA - 1];
    if (!(fecha instanceof Date)) continue;
    out.push({
      fila: i + 2,
      idRetencion: normalizar_(row[COL_RETENCIONES.ID_RETENCION - 1]),
      fecha: fecha,
      horarioInicio: normalizarHorario_(row[COL_RETENCIONES.HORARIO_INICIO - 1]),
      horarioFin: normalizarHorario_(row[COL_RETENCIONES.HORARIO_FIN - 1]),
      idPartido: normalizar_(row[COL_RETENCIONES.ID_PARTIDO - 1]),
      fechaCreacion: fechaCreacion,
    });
  }
  return out;
}

function buscarRetencionPorId_(sh, idRetencion) {
  var last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2, 1, last - 1, COL_RETENCIONES.FECHA_CREACION).getValues();
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    if (normalizar_(row[COL_RETENCIONES.ID_RETENCION - 1]) !== idRetencion) continue;
    return {
      fila: i + 2,
      idRetencion: idRetencion,
      fecha: row[COL_RETENCIONES.FECHA - 1],
      horarioInicio: normalizarHorario_(row[COL_RETENCIONES.HORARIO_INICIO - 1]),
      horarioFin: normalizarHorario_(row[COL_RETENCIONES.HORARIO_FIN - 1]),
      idPartido: normalizar_(row[COL_RETENCIONES.ID_PARTIDO - 1]),
      fechaCreacion: row[COL_RETENCIONES.FECHA_CREACION - 1],
    };
  }
  return null;
}

function buscarReservaPorToken_(sh, token) {
  var last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2, 1, last - 1, COL_RESERVAS.SENA_PERDIDA).getValues();
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    if (normalizar_(row[COL_RESERVAS.TOKEN_GESTION - 1]) !== token) continue;
    return {
      fila: i + 2,
      idReserva: normalizar_(row[COL_RESERVAS.ID_RESERVA - 1]),
      fecha: row[COL_RESERVAS.FECHA - 1],
      horarioInicio: normalizarHorario_(row[COL_RESERVAS.HORARIO_INICIO - 1]),
      horarioFin: normalizarHorario_(row[COL_RESERVAS.HORARIO_FIN - 1]),
      categoria: normalizar_(row[COL_RESERVAS.CATEGORIA - 1]),
      idPartido: normalizar_(row[COL_RESERVAS.ID_PARTIDO - 1]),
      parejaA: normalizar_(row[COL_RESERVAS.PAREJA_A - 1]),
      parejaB: normalizar_(row[COL_RESERVAS.PAREJA_B - 1]),
      valorTotal: Number(row[COL_RESERVAS.VALOR_TOTAL - 1]) || 0,
      montoPagado: Number(row[COL_RESERVAS.MONTO_PAGADO - 1]) || 0,
      saldoPendiente: Number(row[COL_RESERVAS.SALDO_PENDIENTE - 1]) || 0,
      estadoReserva: normalizar_(row[COL_RESERVAS.ESTADO_RESERVA - 1]),
      estadoPago: normalizar_(row[COL_RESERVAS.ESTADO_PAGO - 1]),
    };
  }
  return null;
}

// Idempotencia de confirmarReserva: busca una reserva YA CREADA a partir
// de este idRetencion exacto. Si existe, un reintento del mismo pedido
// (por ejemplo tras un HTTP 404/timeout del lado del cliente que en
// realidad sí llegó a procesarse en el servidor) no debe crear una
// segunda fila -- debe devolver esta misma reserva como si fuera la
// primera vez. Devuelve la MISMA forma de datos que arma
// mp360ReservasConfirmar_ al confirmar con éxito (ver
// formatearRespuestaConfirmacion_), para que el frontend no note ninguna
// diferencia entre una confirmación nueva y una recuperada.
function buscarReservaPorIdRetencionOrigen_(sh, idRetencion) {
  var last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2, 1, last - 1, COL_RESERVAS.ID_RETENCION_ORIGEN).getValues();
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    if (normalizar_(row[COL_RESERVAS.ID_RETENCION_ORIGEN - 1]) !== idRetencion) continue;
    return {
      idReserva: normalizar_(row[COL_RESERVAS.ID_RESERVA - 1]),
      tokenGestion: normalizar_(row[COL_RESERVAS.TOKEN_GESTION - 1]),
      codigoReserva: normalizar_(row[COL_RESERVAS.CODIGO_RESERVA - 1]),
      estadoReserva: normalizar_(row[COL_RESERVAS.ESTADO_RESERVA - 1]),
      cancha: Number(row[COL_RESERVAS.CANCHA - 1]) || 0,
      fecha: formatearFechaISO_(row[COL_RESERVAS.FECHA - 1]),
      horarioInicio: normalizarHorario_(row[COL_RESERVAS.HORARIO_INICIO - 1]),
      horarioFin: normalizarHorario_(row[COL_RESERVAS.HORARIO_FIN - 1]),
      categoria: normalizar_(row[COL_RESERVAS.CATEGORIA - 1]),
      parejaA: normalizar_(row[COL_RESERVAS.PAREJA_A - 1]),
      parejaB: normalizar_(row[COL_RESERVAS.PAREJA_B - 1]),
      valorTotal: Number(row[COL_RESERVAS.VALOR_TOTAL - 1]) || 0,
      montoPagado: Number(row[COL_RESERVAS.MONTO_PAGADO - 1]) || 0,
      saldoPendiente: Number(row[COL_RESERVAS.SALDO_PENDIENTE - 1]) || 0,
    };
  }
  return null;
}

// Compara teléfonos ignorando espacios, guiones, paréntesis y el "+"
// inicial -- para que "351-123-4567", "(351) 123 4567" y "3511234567"
// escritos por la misma persona en momentos distintos comparen igual.
function soloDigitos_(texto) {
  return String(texto === null || texto === undefined ? '' : texto).replace(/\D/g, '');
}

// Recuperación sin el link privado: exige QUE COINCIDAN, en la MISMA
// fila, tanto el teléfono como el código corto -- nunca alcanza con uno
// solo de los dos (ver mp360ReservasBuscarPorTelefono_). Devuelve también
// el propio tokenGestion, a diferencia de buscarReservaPorToken_ (que no
// lo necesita porque el que llama ya lo tiene).
function buscarReservaPorTelefonoYCodigo_(sh, telefono, codigo) {
  var last = sh.getLastRow();
  if (last < 2) return null;
  var digitosBuscados = soloDigitos_(telefono);
  var codigoBuscado = normalizarMayus_(codigo);
  if (!digitosBuscados || !codigoBuscado) return null;
  var vals = sh.getRange(2, 1, last - 1, COL_RESERVAS.CODIGO_RESERVA).getValues();
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    if (soloDigitos_(row[COL_RESERVAS.TELEFONO_SOLICITANTE - 1]) !== digitosBuscados) continue;
    if (normalizarMayus_(row[COL_RESERVAS.CODIGO_RESERVA - 1]) !== codigoBuscado) continue;
    return {
      fila: i + 2,
      idReserva: normalizar_(row[COL_RESERVAS.ID_RESERVA - 1]),
      tokenGestion: normalizar_(row[COL_RESERVAS.TOKEN_GESTION - 1]),
      fecha: row[COL_RESERVAS.FECHA - 1],
      horarioInicio: normalizarHorario_(row[COL_RESERVAS.HORARIO_INICIO - 1]),
      horarioFin: normalizarHorario_(row[COL_RESERVAS.HORARIO_FIN - 1]),
      categoria: normalizar_(row[COL_RESERVAS.CATEGORIA - 1]),
      idPartido: normalizar_(row[COL_RESERVAS.ID_PARTIDO - 1]),
      parejaA: normalizar_(row[COL_RESERVAS.PAREJA_A - 1]),
      parejaB: normalizar_(row[COL_RESERVAS.PAREJA_B - 1]),
      valorTotal: Number(row[COL_RESERVAS.VALOR_TOTAL - 1]) || 0,
      montoPagado: Number(row[COL_RESERVAS.MONTO_PAGADO - 1]) || 0,
      saldoPendiente: Number(row[COL_RESERVAS.SALDO_PENDIENTE - 1]) || 0,
      estadoReserva: normalizar_(row[COL_RESERVAS.ESTADO_RESERVA - 1]),
      estadoPago: normalizar_(row[COL_RESERVAS.ESTADO_PAGO - 1]),
    };
  }
  return null;
}

// BLOQUEOS no se filtra por fecha al leerlo (se lee la hoja entera una
// sola vez y se filtra en memoria) para no releer la hoja una vez por
// cada uno de los 14 días de la ventana reservable.
function leerBloqueosTodos_(ss) {
  var sh = crearHojaBloqueosSiHaceFalta_(ss);
  var last = sh.getLastRow();
  var out = [];
  if (last < 2) return out;
  var vals = sh.getRange(2, 1, last - 1, COL_BLOQUEOS.MOTIVO).getValues();
  vals.forEach(function (row) {
    var f = row[COL_BLOQUEOS.FECHA - 1];
    if (!(f instanceof Date)) return;
    out.push({
      fecha: f,
      horarioInicio: normalizarHorario_(row[COL_BLOQUEOS.HORARIO_INICIO - 1]),
      horarioFin: normalizarHorario_(row[COL_BLOQUEOS.HORARIO_FIN - 1]),
      cancha: normalizar_(row[COL_BLOQUEOS.CANCHA - 1]),
    });
  });
  return out;
}
function leerBloqueosDeFecha_(ss, fecha) {
  return leerBloqueosTodos_(ss).filter(function (b) { return mismaFecha_(b.fecha, fecha); });
}

function existeExcepcionParaPartidoYSemana_(ss, idPartido, semana) {
  var sh = crearHojaExcepcionesSiHaceFalta_(ss);
  var last = sh.getLastRow();
  if (last < 2) return false;
  var vals = sh.getRange(2, 1, last - 1, COL_EXCEPCIONES.SEMANA).getValues();
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    if (normalizar_(row[COL_EXCEPCIONES.ID_PARTIDO - 1]) === idPartido &&
        Number(row[COL_EXCEPCIONES.SEMANA - 1]) === semana) {
      return true;
    }
  }
  return false;
}

// ¿La pareja `idPareja` ya tiene otra reserva activa (RESERVADO o
// FINALIZADO, cualquiera menos CANCELADO) que caiga en esa misma semana
// de competencia? `idPartidoExcluir` es el propio cruce que se está
// evaluando, para no comparar un partido contra sí mismo si esta función
// se llama más de una vez sobre el mismo pedido.
function parejaTieneReservaEnSemana_(reservasActivas, idPareja, semana, idPartidoExcluir) {
  if (!idPareja) return false;
  for (var i = 0; i < reservasActivas.length; i++) {
    var r = reservasActivas[i];
    if (r.idPartido === idPartidoExcluir) continue;
    if (r.idParejaA !== idPareja && r.idParejaB !== idPareja) continue;
    if (numeroSemanaCompetencia_(r.fecha) === semana) return true;
  }
  return false;
}

// ============================================================
// Disponibilidad
// ============================================================
// Cuántas canchas de esa franja ya están ocupadas por reservas activas,
// retenciones vivas o bloqueos que se superpongan (aunque sea
// parcialmente) con el horario pedido.
function contarOcupadasEnFranja_(reservasActivas, retencionesVivas, bloqueosDelDia, fecha, horarioInicio, horarioFin) {
  var ocupadas = 0;
  reservasActivas.forEach(function (r) {
    if (mismaFecha_(r.fecha, fecha) && horariosSeSuperponen_(r.horarioInicio, r.horarioFin, horarioInicio, horarioFin)) ocupadas++;
  });
  retencionesVivas.forEach(function (r) {
    if (mismaFecha_(r.fecha, fecha) && horariosSeSuperponen_(r.horarioInicio, r.horarioFin, horarioInicio, horarioFin)) ocupadas++;
  });
  bloqueosDelDia.forEach(function (b) {
    if (!horariosSeSuperponen_(b.horarioInicio, b.horarioFin, horarioInicio, horarioFin)) return;
    ocupadas += (normalizarMayus_(b.cancha) === 'TODAS') ? CANTIDAD_CANCHAS : 1;
  });
  return ocupadas;
}

function calcularFranjasDia_(fecha, reservasActivas, retencionesVivas, bloqueosDelDia) {
  var franjasBase = GRILLA_SEMANAL[fecha.getDay()] || [];
  if (!franjasBase.length) return [];
  return franjasBase.map(function (franja) {
    var ocupadas = contarOcupadasEnFranja_(reservasActivas, retencionesVivas, bloqueosDelDia, fecha, franja.inicio, franja.fin);
    return { inicio: franja.inicio, fin: franja.fin, disponibles: Math.max(0, franja.canchas - ocupadas) };
  }).filter(function (f) { return f.disponibles > 0; }); // el jugador solo ve turnos con lugar real
}

// Primera cancha (1, 2 o 3) que no esté ocupada por una RESERVA
// confirmada ni un BLOQUEO en ese fecha+horario exacto. Las retenciones
// de otros jugadores no compiten por número de cancha (todavía no tienen
// ninguna asignada) -- solo restan del conteo de cupos disponibles, ver
// contarOcupadasEnFranja_.
function asignarCanchaLibre_(reservasActivas, bloqueosDelDia, fecha, horarioInicio, horarioFin) {
  for (var cancha = 1; cancha <= CANTIDAD_CANCHAS; cancha++) {
    var ocupadaPorReserva = reservasActivas.some(function (r) {
      return r.cancha === cancha && mismaFecha_(r.fecha, fecha) && horariosSeSuperponen_(r.horarioInicio, r.horarioFin, horarioInicio, horarioFin);
    });
    if (ocupadaPorReserva) continue;
    var bloqueada = bloqueosDelDia.some(function (b) {
      if (!horariosSeSuperponen_(b.horarioInicio, b.horarioFin, horarioInicio, horarioFin)) return false;
      return normalizarMayus_(b.cancha) === 'TODAS' || Number(b.cancha) === cancha;
    });
    if (bloqueada) continue;
    return cancha;
  }
  return null;
}

// ============================================================
// Comprobantes -- Google Drive privado
// ============================================================
// La carpeta se crea sola la primera vez (queda privada por default: solo
// la ve el dueño de esta cuenta de Google, nunca "cualquiera con el
// link"). No hace falta crearla a mano antes de desplegar.
function obtenerCarpetaComprobantes_() {
  var carpetas = DriveApp.getFoldersByName(CARPETA_COMPROBANTES);
  if (carpetas.hasNext()) return carpetas.next();
  return DriveApp.createFolder(CARPETA_COMPROBANTES);
}

// Acepta tanto un base64 "pelado" como uno con el prefijo
// "data:image/jpeg;base64," que arma FileReader.readAsDataURL() en el
// navegador -- así el frontend puede mandar cualquiera de los dos formatos
// sin que este código se rompa.
function limpiarBase64_(texto) {
  var idx = texto.indexOf('base64,');
  return idx === -1 ? texto : texto.substring(idx + 7);
}

function subirComprobanteADrive_(base64, nombreArchivo, tipoMime, idPartido) {
  var carpeta = obtenerCarpetaComprobantes_();
  var bytes = Utilities.base64Decode(limpiarBase64_(base64));
  var blob = Utilities.newBlob(bytes, tipoMime || 'image/jpeg', idPartido + '_' + (nombreArchivo || 'comprobante'));
  var archivo = carpeta.createFile(blob);
  return archivo.getUrl();
}

// ============================================================
// ID correlativo de reserva (mismo patrón que proximoIdPareja_ /
// siguienteNumeroIdPartido_ de CodigoAdminLiga.gs).
// ============================================================
function proximoIdReserva_(sh) {
  var last = sh.getLastRow();
  var max = 0;
  if (last >= 2) {
    var vals = sh.getRange(2, COL_RESERVAS.ID_RESERVA, last - 1, 1).getValues();
    vals.forEach(function (row) {
      var m = /^R(\d+)$/.exec(normalizar_(row[0]));
      if (m) { var n = parseInt(m[1], 10); if (n > max) max = n; }
    });
  }
  return 'R' + String(max + 1).padStart(4, '0');
}

// Fila (número real de la hoja) de una reserva por su ID_RESERVA, o null
// si no existe. Usada por aprobarReserva_/rechazarReserva_ para saber
// dónde escribir.
function buscarFilaReservaPorId_(sh, idReserva) {
  var last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2, COL_RESERVAS.ID_RESERVA, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (normalizar_(vals[i][0]) === idReserva) return i + 2;
  }
  return null;
}

// Fórmula de ESTADO_RESERVA para una fila dada -- un solo lugar que
// arma este texto, reusado tanto al crear una reserva nueva
// (mp360ReservasConfirmar_) como al migrar reservas viejas al esquema de
// aprobación (migrarAprobacionExistente_), para que nunca queden
// desincronizadas. Orden de precedencia (de afuera hacia adentro): un
// rechazo es más "definitivo" que una cancelación en el sentido de que
// una reserva rechazada NUNCA llegó a estar aprobada, pero en la
// práctica nunca deberían poder coexistir FECHA_RECHAZO y
// FECHA_CANCELACION en la misma fila (una empieza sin aprobar y nunca
// llega a poder cancelarse -- ver mp360ReservasCancelar_), así que el
// orden entre esas dos ramas es solo defensivo.
function formulaEstadoReserva_(fila) {
  var cFecha = columnaLetra_(COL_RESERVAS.FECHA);
  var cHorarioFin = columnaLetra_(COL_RESERVAS.HORARIO_FIN);
  var cFechaCancelacion = columnaLetra_(COL_RESERVAS.FECHA_CANCELACION);
  var cFechaAprobacion = columnaLetra_(COL_RESERVAS.FECHA_APROBACION);
  var cFechaRechazo = columnaLetra_(COL_RESERVAS.FECHA_RECHAZO);
  return '=IF(' + cFechaRechazo + fila + '<>"","' + ESTADO_RESERVA_RECHAZADO + '",' +
    'IF(' + cFechaCancelacion + fila + '<>"","' + ESTADO_RESERVA_CANCELADO + '",' +
    'IF(' + cFechaAprobacion + fila + '="","' + ESTADO_RESERVA_PENDIENTE_APROBACION + '",' +
    'IF(NOW()>(' + cFecha + fila + '+TIMEVALUE(' + cHorarioFin + fila + ')),"' +
    ESTADO_RESERVA_FINALIZADO + '","' + ESTADO_RESERVA_RESERVADO + '"))))';
}

// ============================================================
// Código corto de reserva (para recuperar sin el link privado)
// ============================================================
// Alfabeto sin O/0, I/1/L (se prestan a confusión al copiar a mano) --
// 8 caracteres sobre 32 posibles = 32^8 (~1,1 billón) combinaciones. A
// propósito NO es secuencial ni deriva del ID_RESERVA: adivinar uno junto
// con el teléfono exacto de esa misma reserva no es viable por fuerza
// bruta, y aunque lo fuera, buscarReserva exige que ambos coincidan en la
// MISMA fila (ver buscarReservaPorTelefonoYCodigo_).
var ALFABETO_CODIGO_RESERVA_ = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generarCodigoReserva_() {
  var codigo = '';
  for (var i = 0; i < 8; i++) {
    codigo += ALFABETO_CODIGO_RESERVA_.charAt(Math.floor(Math.random() * ALFABETO_CODIGO_RESERVA_.length));
  }
  return codigo;
}
// Regenera si por pura casualidad chocara con uno ya existente en la
// hoja (probabilidad prácticamente nula, pero la hoja es chica y el
// chequeo es barato -- mejor no confiar ciegamente en el azar).
function proximoCodigoReservaUnico_(sh) {
  var existentes = {};
  var last = sh.getLastRow();
  if (last >= 2) {
    var vals = sh.getRange(2, COL_RESERVAS.CODIGO_RESERVA, last - 1, 1).getValues();
    vals.forEach(function (row) {
      var v = normalizarMayus_(row[0]);
      if (v) existentes[v] = true;
    });
  }
  var codigo;
  do { codigo = generarCodigoReserva_(); } while (existentes[codigo]);
  return codigo;
}

// ============================================================
// ACCIÓN: disponibilidad
// ============================================================
// Sin caché a propósito (a diferencia de POSICIONES/FIXTURE en
// CodigoWebApp.gs): la disponibilidad cambia con cada retención/reserva,
// y mostrar un cupo "disponible" que ya no lo es sería peor que el costo
// de leer estas hojas (chicas) en cada pedido.
function mp360ReservasGetDisponibilidad() {
  var ss = abrirPlanilla_();
  var reservasActivas = leerReservasActivas_(ss);
  var retencionesVivas = leerRetencionesVivas_(ss);
  var bloqueosTodos = leerBloqueosTodos_(ss);
  var limites = limitesVentanaReservable_();

  var dias = [];
  var cursor = new Date(limites.minimo.getTime());
  while (cursor.getTime() <= limites.maximo.getTime()) {
    var bloqueosDelDia = bloqueosTodos.filter(function (b) { return mismaFecha_(b.fecha, cursor); });
    var franjas = calcularFranjasDia_(cursor, reservasActivas, retencionesVivas, bloqueosDelDia);
    if (franjas.length) {
      dias.push({ fecha: formatearFechaISO_(cursor), diaSemana: NOMBRES_DIA[cursor.getDay()], franjas: franjas });
    }
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return { dias: dias };
}

// ============================================================
// ACCIÓN: partidosDisponibles
// ============================================================
// Cruces PENDIENTES de una categoría que todavía se pueden reservar (no
// tienen ya una reserva ni una retención viva de otra persona). No filtra
// acá por la regla de "una vez por semana" -- esa depende de qué día
// elija el jugador DESPUÉS, así que se valida recién en retenerTurno_.
function mp360ReservasGetPartidosDisponibles(categoria) {
  var ss = abrirPlanilla_();
  categoria = normalizar_(categoria);
  if (leerCategorias_(ss).indexOf(categoria) === -1) return [];

  // La fecha en juego es 100% administrativa (columna B de CATEGORIAS,
  // ver leerFechaEnJuegoPorCategoria_) -- nunca se infiere de la última
  // fecha del fixture ni de ningún texto editorial. Sin un valor cargado
  // para esta categoría, no se ofrece ningún cruce (ver el comentario en
  // esa función: mejor nada que mezclar fechas por accidente).
  var fechaEnJuego = leerFechaEnJuegoPorCategoria_(ss, categoria);
  if (fechaEnJuego === null) return [];

  var pendientes = leerPartidosPendientesDeCategoria_(ss, categoria)
    .filter(function (p) { return p.fecha === fechaEnJuego; });
  var reservasActivas = leerReservasActivas_(ss);
  var retencionesVivas = leerRetencionesVivas_(ss);

  var idsOcupados = {};
  reservasActivas.forEach(function (r) { idsOcupados[r.idPartido] = true; });
  retencionesVivas.forEach(function (r) { idsOcupados[r.idPartido] = true; });

  return pendientes
    .filter(function (p) { return !idsOcupados[p.idPartido]; })
    .map(function (p) { return { idPartido: p.idPartido, parejaA: p.parejaA, parejaB: p.parejaB }; });
}

// ============================================================
// ACCIÓN: retenerTurno (escritura -- LockService)
// ============================================================
function mp360ReservasRetener_(datos) {
  datos = datos || {};
  var idPartido = normalizar_(datos.idPartido);
  var fecha = parsearFechaISO_(datos.fecha);
  var horarioInicio = normalizar_(datos.horarioInicio);
  var horarioFin = normalizar_(datos.horarioFin);

  if (!idPartido || !fecha || !horarioInicio || !horarioFin) {
    throw new Error('Faltan datos para retener el turno.');
  }
  if (!fechaDentroDeVentanaReservable_(fecha)) {
    throw new Error('Esa fecha está fuera de la ventana de reserva permitida.');
  }
  var franja = franjaValidaParaFecha_(fecha, horarioInicio, horarioFin);
  if (!franja) {
    throw new Error('Ese horario no es un turno válido para ese día.');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = abrirPlanilla_();

    var partido = buscarPartidoPorId_(ss, idPartido);
    if (!partido) throw new Error('No se encontró ese partido.');
    if (partido.estado !== ESTADO_PARTIDO_PENDIENTE) throw new Error('Ese partido ya no está pendiente de jugarse.');

    var reservasActivas = leerReservasActivas_(ss);
    var retencionesVivas = leerRetencionesVivas_(ss);

    var yaOcupado = reservasActivas.some(function (r) { return r.idPartido === idPartido; }) ||
      retencionesVivas.some(function (r) { return r.idPartido === idPartido; });
    if (yaOcupado) throw new Error('Ese cruce ya tiene una reserva en curso. Elegí otro.');

    var semana = numeroSemanaCompetencia_(fecha);
    var chocaA = parejaTieneReservaEnSemana_(reservasActivas, partido.idParejaA, semana, idPartido);
    var chocaB = parejaTieneReservaEnSemana_(reservasActivas, partido.idParejaB, semana, idPartido);
    if ((chocaA || chocaB) && !existeExcepcionParaPartidoYSemana_(ss, idPartido, semana)) {
      throw new Error('Una de las parejas de este cruce ya tiene otro partido reservado esa semana. Consultá con el administrador si necesitás jugar dos veces esa semana.');
    }

    var bloqueosDelDia = leerBloqueosDeFecha_(ss, fecha);
    var ocupadas = contarOcupadasEnFranja_(reservasActivas, retencionesVivas, bloqueosDelDia, fecha, horarioInicio, horarioFin);
    if (ocupadas >= franja.canchas) throw new Error('Ese horario ya no tiene lugar disponible.');

    var idRetencion = Utilities.getUuid();
    var shRetenciones = crearHojaRetencionesSiHaceFalta_(ss);
    shRetenciones.appendRow([idRetencion, fecha, horarioInicio, horarioFin, idPartido, new Date()]);

    return {
      idRetencion: idRetencion,
      minutos: RETENCION_MINUTOS,
      valorTotal: VALOR_TOTAL_TURNO,
      montoSena: MONTO_SENA,
      alias: ALIAS_TRANSFERENCIA,
      fecha: formatearFechaISO_(fecha),
      horarioInicio: horarioInicio,
      horarioFin: horarioFin,
      categoria: partido.categoria,
      parejaA: partido.parejaA,
      parejaB: partido.parejaB,
    };
  } finally {
    lock.releaseLock();
  }
}

// Busca la retención y valida que no esté vencida -- usado dos veces
// dentro de mp360ReservasConfirmar_ (antes y después de subir el
// comprobante, ver más abajo por qué). Factorizado acá para no duplicar
// la lógica de vencimiento en los dos lugares.
function buscarRetencionValidaOLanzar_(shRetenciones, idRetencion) {
  var retencion = buscarRetencionPorId_(shRetenciones, idRetencion);
  if (!retencion) throw new Error('Tu retención ya no existe. Elegí el turno de nuevo.');
  var edadMinutos = (new Date().getTime() - retencion.fechaCreacion.getTime()) / 60000;
  if (edadMinutos > RETENCION_MINUTOS) {
    shRetenciones.deleteRow(retencion.fila);
    throw new Error('Se venció el tiempo de ' + RETENCION_MINUTOS + ' minutos para completar la reserva. Elegí el turno de nuevo.');
  }
  return retencion;
}

// ============================================================
// ACCIÓN: confirmarReserva (escritura -- LockService, en dos fases)
// ============================================================
// IDEMPOTENCIA: antes que nada, en las dos fases, se busca si este
// idRetencion YA generó una reserva (buscarReservaPorIdRetencionOrigen_).
// Si la respuesta al primer intento se perdió en el camino (por ejemplo,
// el HTTP 404 del redirect de Apps Script confirmado en vivo esta misma
// investigación) pero el servidor sí llegó a procesarlo, un reintento con
// el mismo idRetencion NUNCA crea una segunda fila -- devuelve la reserva
// ya creada, tal cual, como si fuera la primera vez. Esto es seguro con
// concurrencia porque las dos verificaciones (fase 1 y fase 2) ocurren
// siempre bajo LockService: dos pedidos con el mismo idRetencion jamás se
// evalúan en simultáneo.
//
// DOS FASES (optimización de rendimiento, no solo de idempotencia): subir
// el comprobante a Drive es la parte más lenta y con tiempo más variable
// de toda la acción (red externa), y antes pasaba ENTERA adentro del
// único LockService del script -- mientras un comprobante tardaba en
// subir, CUALQUIER OTRA acción de escritura (retenerTurno, otra
// confirmación, cancelarReserva, aprobar/rechazar) de cualquier otro
// usuario quedaba esperando ese mismo lock. Ahora:
//   Fase 1 (lock breve): solo confirma que la retención existe y no
//   venció -- ninguna llamada a Drive todavía.
//   (sin lock): sube el comprobante.
//   Fase 2 (lock de nuevo): revalida TODO de nuevo desde cero -- durante
//   la subida, sin lock, pudo haber cambiado cualquier cosa (otra persona
//   se quedó con el cupo, el admin cargó una excepción, etc.) -- y recién
//   ahí escribe la reserva definitiva.
// El único costo de este diseño es que, en el caso raro de perder la
// carrera por el cupo justo durante la subida (fase 2 revalida y falla),
// el comprobante ya subido queda como archivo huérfano en Drive -- no
// afecta ninguna hoja ni crea ninguna reserva, es solo un archivo de
// más en la carpeta de comprobantes.
function mp360ReservasConfirmar_(datos) {
  datos = datos || {};
  var idRetencion = normalizar_(datos.idRetencion);
  var nombre = normalizar_(datos.nombre).substring(0, 120);
  var telefono = normalizar_(datos.telefono).substring(0, 40);
  var comprobanteBase64 = datos.comprobanteBase64;
  var comprobanteNombreArchivo = normalizar_(datos.comprobanteNombreArchivo) || 'comprobante';
  var comprobanteTipoMime = normalizar_(datos.comprobanteTipoMime) || 'image/jpeg';

  if (!idRetencion || !nombre || !telefono || !comprobanteBase64) {
    throw new Error('Faltan datos para confirmar la reserva (nombre, teléfono y comprobante son obligatorios).');
  }

  var ss = abrirPlanilla_();

  // ---------------- Fase 1: validar SIN tocar Drive todavía ----------------
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var idPartidoRetenido;
  try {
    var shReservasFase1 = crearHojaReservasSiHaceFalta_(ss);
    var reservaPrevia1 = buscarReservaPorIdRetencionOrigen_(shReservasFase1, idRetencion);
    if (reservaPrevia1) return reservaPrevia1;

    var shRetencionesFase1 = crearHojaRetencionesSiHaceFalta_(ss);
    var retencionFase1 = buscarRetencionValidaOLanzar_(shRetencionesFase1, idRetencion);
    idPartidoRetenido = retencionFase1.idPartido;
  } finally {
    lock.releaseLock();
  }

  // ---------------- Fuera del lock: subir el comprobante (lento) ----------------
  var comprobanteUrl = subirComprobanteADrive_(comprobanteBase64, comprobanteNombreArchivo, comprobanteTipoMime, idPartidoRetenido);

  // ---------------- Fase 2: revalidación completa + commit atómico ----------------
  lock.waitLock(30000);
  try {
    var shReservas = crearHojaReservasSiHaceFalta_(ss);

    // Por si otro pedido con el mismo idRetencion (un reintento en
    // paralelo del propio navegador, por ejemplo) ya terminó de commitear
    // mientras este subía el comprobante.
    var reservaPrevia2 = buscarReservaPorIdRetencionOrigen_(shReservas, idRetencion);
    if (reservaPrevia2) return reservaPrevia2;

    var shRetenciones = crearHojaRetencionesSiHaceFalta_(ss);
    var retencion = buscarRetencionValidaOLanzar_(shRetenciones, idRetencion);

    var partido = buscarPartidoPorId_(ss, retencion.idPartido);
    if (!partido) throw new Error('No se encontró el partido asociado a esta retención.');

    // -----------------------------------------------------------------
    // Revalidación completa, DE NUEVO, acá adentro del lock -- todo lo
    // que se chequeó en retenerTurno_ (y en la fase 1) pudo haber
    // cambiado durante los minutos que pasaron mientras el jugador
    // completaba el formulario Y durante la subida del comprobante sin
    // lock (otra reserva se confirmó, el admin cargó una excepción o
    // cambió el estado del partido, etc.). Nada de esto se da por
    // sentado solo porque la retención exista: si algo cambió, se corta
    // acá y no se crea la reserva (el comprobante ya subido queda
    // huérfano en Drive, ver comentario arriba de la función).
    // -----------------------------------------------------------------

    // 1) El cruce sigue pendiente de jugarse.
    if (partido.estado !== ESTADO_PARTIDO_PENDIENTE) {
      throw new Error('Ese partido ya no está pendiente de jugarse. Tu retención quedó sin efecto.');
    }

    var reservasActivas = leerReservasActivas_(ss);
    var retencionesVivas = leerRetencionesVivas_(ss);

    // 2) El propio ID_PARTIDO sigue libre (ninguna reserva ya creada, y
    // ninguna OTRA retención viva de otra persona sobre el mismo cruce --
    // la propia retención de este pedido no cuenta contra sí misma).
    var partidoYaReservado = reservasActivas.some(function (r) { return r.idPartido === retencion.idPartido; });
    var partidoConOtraRetencion = retencionesVivas.some(function (r) {
      return r.idPartido === retencion.idPartido && r.idRetencion !== idRetencion;
    });
    if (partidoYaReservado || partidoConOtraRetencion) {
      throw new Error('Ese cruce ya fue reservado por otra persona mientras completabas el formulario. Elegí otro turno.');
    }

    // 3) Ninguna de las dos parejas juega ya otro partido esa misma
    // semana de competencia, salvo excepción cargada por el admin.
    var semana = numeroSemanaCompetencia_(retencion.fecha);
    var chocaA = parejaTieneReservaEnSemana_(reservasActivas, partido.idParejaA, semana, retencion.idPartido);
    var chocaB = parejaTieneReservaEnSemana_(reservasActivas, partido.idParejaB, semana, retencion.idPartido);
    if ((chocaA || chocaB) && !existeExcepcionParaPartidoYSemana_(ss, retencion.idPartido, semana)) {
      throw new Error('Una de las parejas de este cruce ya quedó con otro partido reservado esa semana mientras completabas el formulario. Consultá con el administrador si necesitás jugar dos veces esa semana.');
    }

    // 4) Todavía hay una cancha físicamente libre en esa fecha+franja.
    var bloqueosDelDia = leerBloqueosDeFecha_(ss, retencion.fecha);
    var cancha = asignarCanchaLibre_(reservasActivas, bloqueosDelDia, retencion.fecha, retencion.horarioInicio, retencion.horarioFin);
    if (!cancha) {
      throw new Error('Ya no queda ninguna cancha libre para ese horario. Elegí otro turno.');
    }

    // Recién ahora, con las 4 condiciones confirmadas DE NUEVO en este
    // mismo instante (todavía dentro del lock), se escribe la reserva
    // definitiva (el comprobante ya se subió antes, sin lock, ver arriba).
    var idReserva = proximoIdReserva_(shReservas);
    var tokenGestion = Utilities.getUuid();
    var codigoReserva = proximoCodigoReservaUnico_(shReservas);
    var ahora = new Date();

    // ESTADO_RESERVA (col 18), SALDO_PENDIENTE (col 17) y SENA_PERDIDA
    // (col 23) quedan vacíos acá a propósito -- se completan como
    // FÓRMULA inmediatamente después, para que se recalculen solas.
    // FECHA_APROBACION y FECHA_RECHAZO quedan vacías: es justamente esa
    // ausencia la que hace que la fórmula de ESTADO_RESERVA arranque en
    // PENDIENTE_APROBACION -- ya NO queda RESERVADO automáticamente acá.
    // La retención de 10 minutos ya cumplió su función (se borra abajo):
    // de acá en adelante la cancha queda bloqueada SIN vencimiento, hasta
    // que el admin apruebe o rechace (ver aprobarReserva_/rechazarReserva_).
    // ID_RETENCION_ORIGEN (col 27, al final) queda con este idRetencion --
    // es la clave que permite reconocer un reintento de este mismo pedido.
    shReservas.appendRow([
      idReserva, tokenGestion, retencion.fecha, retencion.horarioInicio, retencion.horarioFin,
      cancha, partido.categoria, partido.idPartido, partido.idParejaA, partido.parejaA,
      partido.idParejaB, partido.parejaB, nombre, telefono,
      VALOR_TOTAL_TURNO, MONTO_SENA, '',
      '', ESTADO_PAGO_SALDO_PENDIENTE, comprobanteUrl, ahora, '', '',
      codigoReserva, '', '',
      idRetencion,
    ]);
    var filaNueva = shReservas.getLastRow();
    var cValorTotal = columnaLetra_(COL_RESERVAS.VALOR_TOTAL);
    var cMontoPagado = columnaLetra_(COL_RESERVAS.MONTO_PAGADO);
    var cEstadoReserva = columnaLetra_(COL_RESERVAS.ESTADO_RESERVA);

    shReservas.getRange(filaNueva, COL_RESERVAS.SALDO_PENDIENTE).setFormula(
      '=' + cValorTotal + filaNueva + '-' + cMontoPagado + filaNueva
    );
    shReservas.getRange(filaNueva, COL_RESERVAS.ESTADO_RESERVA).setFormula(formulaEstadoReserva_(filaNueva));
    shReservas.getRange(filaNueva, COL_RESERVAS.SENA_PERDIDA).setFormula(
      '=IF(' + cEstadoReserva + filaNueva + '="' + ESTADO_RESERVA_CANCELADO + '","SI - $' + MONTO_SENA + ' no reembolsados","")'
    );

    // La retención ya cumplió su propósito -- se borra (no queda como
    // basura hasta el próximo trigger de limpieza).
    shRetenciones.deleteRow(retencion.fila);

    return {
      idReserva: idReserva,
      tokenGestion: tokenGestion,
      codigoReserva: codigoReserva,
      estadoReserva: ESTADO_RESERVA_PENDIENTE_APROBACION,
      cancha: cancha,
      fecha: formatearFechaISO_(retencion.fecha),
      horarioInicio: retencion.horarioInicio,
      horarioFin: retencion.horarioFin,
      categoria: partido.categoria,
      parejaA: partido.parejaA,
      parejaB: partido.parejaB,
      valorTotal: VALOR_TOTAL_TURNO,
      montoPagado: MONTO_SENA,
      saldoPendiente: VALOR_TOTAL_TURNO - MONTO_SENA,
    };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// ACCIÓN: consultarReserva
// ============================================================
// Nunca devuelve el teléfono ni ningún otro dato más allá de lo que el
// propio jugador necesita ver de SU reserva. Nunca devuelve una lista --
// solo la reserva exacta de ese token.
function mp360ReservasConsultar_(token) {
  token = normalizar_(token);
  if (!token) throw new Error('Falta el token de gestión.');
  var ss = abrirPlanilla_();
  var sh = crearHojaReservasSiHaceFalta_(ss);
  var reserva = buscarReservaPorToken_(sh, token);
  if (!reserva) throw new Error('No se encontró ninguna reserva con ese enlace.');

  return {
    idReserva: reserva.idReserva,
    fecha: formatearFechaISO_(reserva.fecha),
    horarioInicio: reserva.horarioInicio,
    horarioFin: reserva.horarioFin,
    categoria: reserva.categoria,
    parejaA: reserva.parejaA,
    parejaB: reserva.parejaB,
    valorTotal: reserva.valorTotal,
    montoPagado: reserva.montoPagado,
    saldoPendiente: reserva.saldoPendiente,
    estadoReserva: reserva.estadoReserva,
    estadoPago: reserva.estadoPago,
  };
}

// ============================================================
// ACCIÓN: buscarReserva (recuperación sin el link privado)
// ============================================================
// Exige teléfono Y código, y los dos tienen que coincidir en la MISMA
// fila (ver buscarReservaPorTelefonoYCodigo_) -- nunca alcanza con
// conocer solo un teléfono. Es de solo lectura, no necesita LockService.
// Si no coincide, el mensaje es genérico a propósito: no dice cuál de
// los dos datos falló, para no ayudar a adivinar por partes.
function mp360ReservasBuscarPorTelefono_(datos) {
  datos = datos || {};
  var telefono = normalizar_(datos.telefono);
  var codigo = normalizar_(datos.codigo);
  if (!telefono || !codigo) {
    throw new Error('Ingresá el teléfono y el código de tu reserva.');
  }
  var ss = abrirPlanilla_();
  var sh = crearHojaReservasSiHaceFalta_(ss);
  var reserva = buscarReservaPorTelefonoYCodigo_(sh, telefono, codigo);
  if (!reserva) {
    throw new Error('No encontramos ninguna reserva con esos datos. Revisá el teléfono y el código e intentá de nuevo.');
  }

  return {
    tokenGestion: reserva.tokenGestion,
    idReserva: reserva.idReserva,
    fecha: formatearFechaISO_(reserva.fecha),
    horarioInicio: reserva.horarioInicio,
    horarioFin: reserva.horarioFin,
    categoria: reserva.categoria,
    parejaA: reserva.parejaA,
    parejaB: reserva.parejaB,
    valorTotal: reserva.valorTotal,
    montoPagado: reserva.montoPagado,
    saldoPendiente: reserva.saldoPendiente,
    estadoReserva: reserva.estadoReserva,
    estadoPago: reserva.estadoPago,
  };
}

// ============================================================
// ACCIÓN: cancelarReserva (escritura -- LockService)
// ============================================================
// Recibe ÚNICAMENTE el token -- nunca idReserva, nunca teléfono. Cancelar
// es literalmente escribir UNA fecha: ESTADO_RESERVA y SENA_PERDIDA son
// fórmulas que reaccionan solas apenas FECHA_CANCELACION deja de estar
// vacía, así que el horario y el cruce quedan libres de inmediato (la
// próxima vez que se calcule disponibilidad, esta fila ya no cuenta).
function mp360ReservasCancelar_(datos) {
  datos = datos || {};
  var token = normalizar_(datos.token);
  if (!token) throw new Error('Falta el token de gestión.');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = abrirPlanilla_();
    var sh = crearHojaReservasSiHaceFalta_(ss);
    var reserva = buscarReservaPorToken_(sh, token);
    if (!reserva) throw new Error('No se encontró ninguna reserva con ese enlace.');
    // Lista blanca a propósito (no lista negra): solo se puede cancelar
    // un RESERVADO. Así, si en el futuro se agrega un estado nuevo, por
    // defecto NO se puede cancelar (hay que decidirlo a propósito) en vez
    // de quedar cancelable "por accidente" hasta que alguien se acuerde
    // de agregarlo a una lista de exclusiones.
    if (reserva.estadoReserva !== ESTADO_RESERVA_RESERVADO) {
      if (reserva.estadoReserva === ESTADO_RESERVA_PENDIENTE_APROBACION) {
        throw new Error('Tu reserva todavía está pendiente de aprobación. Todavía no se puede cancelar -- esperá a que el organizador la revise.');
      }
      if (reserva.estadoReserva === ESTADO_RESERVA_CANCELADO) {
        throw new Error('Esta reserva ya estaba cancelada.');
      }
      if (reserva.estadoReserva === ESTADO_RESERVA_RECHAZADO) {
        throw new Error('Esta solicitud ya fue rechazada -- no hay nada para cancelar.');
      }
      if (reserva.estadoReserva === ESTADO_RESERVA_FINALIZADO) {
        throw new Error('Esta reserva ya se jugó, no se puede cancelar.');
      }
      throw new Error('Esta reserva no se puede cancelar en su estado actual.');
    }
    sh.getRange(reserva.fila, COL_RESERVAS.FECHA_CANCELACION).setValue(new Date());
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// ACCIÓN: listarPendientes (SOLO ADMIN)
// ============================================================
// Devuelve TODAS las reservas PENDIENTE_APROBACION con todos sus datos
// (acá sí, teléfono incluido -- a diferencia de las acciones de jugador,
// esto es exclusivamente para el organizador, protegido por
// verificarClaveAdmin_). Es de solo lectura, no necesita LockService.
//
// Optimizado en dos pasadas: la hoja RESERVAS crece indefinidamente (cada
// reserva de la historia queda ahí, aprobada/rechazada/cancelada
// incluida), pero las PENDIENTE_APROBACION son casi siempre una porción
// chica y reciente del total. Antes se traían las 26 columnas de TODAS
// las filas para después filtrar en memoria -- con la hoja ya grande, eso
// se midió tardando más de 25s (timeout) contra el backend real. Ahora:
// primera pasada lee UNA sola columna (ESTADO_RESERVA) de todas las
// filas -- mucho menos dato transferido -- y recién en la segunda pasada
// se leen las columnas completas, pero SOLO de las filas que realmente
// son PENDIENTE_APROBACION. Mismo resultado exacto, muchos menos datos
// leídos en el caso normal.
function mp360ReservasListarPendientes_(datos) {
  datos = datos || {};
  if (!verificarClaveAdmin_(datos.clave)) throw new Error('Contraseña de administrador incorrecta.');

  var ss = abrirPlanilla_();
  var sh = crearHojaReservasSiHaceFalta_(ss);
  var last = sh.getLastRow();
  var out = [];
  if (last < 2) return out;

  var estados = sh.getRange(2, COL_RESERVAS.ESTADO_RESERVA, last - 1, 1).getValues();
  var filasPendientes = [];
  for (var i = 0; i < estados.length; i++) {
    if (normalizar_(estados[i][0]) === ESTADO_RESERVA_PENDIENTE_APROBACION) filasPendientes.push(i + 2);
  }
  if (!filasPendientes.length) return out;

  // Agrupa filas consecutivas en un solo rango -- si las pendientes están
  // encadenadas (lo más común: son las últimas reservas cargadas), esto
  // reduce varias llamadas a Sheets a una sola.
  var rangos = [];
  filasPendientes.forEach(function (fila) {
    var ultimo = rangos[rangos.length - 1];
    if (ultimo && fila === ultimo.hasta + 1) { ultimo.hasta = fila; return; }
    rangos.push({ desde: fila, hasta: fila });
  });

  rangos.forEach(function (r) {
    var vals = sh.getRange(r.desde, 1, r.hasta - r.desde + 1, COL_RESERVAS.FECHA_RECHAZO).getValues();
    vals.forEach(function (row) {
      var fechaCreacion = row[COL_RESERVAS.FECHA_CREACION - 1];
      out.push({
        idReserva: normalizar_(row[COL_RESERVAS.ID_RESERVA - 1]),
        categoria: normalizar_(row[COL_RESERVAS.CATEGORIA - 1]),
        parejaA: normalizar_(row[COL_RESERVAS.PAREJA_A - 1]),
        parejaB: normalizar_(row[COL_RESERVAS.PAREJA_B - 1]),
        fecha: formatearFechaISO_(row[COL_RESERVAS.FECHA - 1]),
        horarioInicio: normalizarHorario_(row[COL_RESERVAS.HORARIO_INICIO - 1]),
        horarioFin: normalizarHorario_(row[COL_RESERVAS.HORARIO_FIN - 1]),
        cancha: Number(row[COL_RESERVAS.CANCHA - 1]) || 0,
        nombreSolicitante: normalizar_(row[COL_RESERVAS.NOMBRE_SOLICITANTE - 1]),
        telefonoSolicitante: normalizar_(row[COL_RESERVAS.TELEFONO_SOLICITANTE - 1]),
        montoPagado: Number(row[COL_RESERVAS.MONTO_PAGADO - 1]) || 0,
        comprobanteUrl: normalizar_(row[COL_RESERVAS.COMPROBANTE_SENA_URL - 1]),
        codigoReserva: normalizar_(row[COL_RESERVAS.CODIGO_RESERVA - 1]),
        fechaCreacion: fechaCreacion instanceof Date ? fechaCreacion.toISOString() : '',
      });
    });
  });

  // Más antiguas primero -- son las que esperan hace más tiempo.
  out.sort(function (a, b) { return (a.fechaCreacion || '').localeCompare(b.fechaCreacion || ''); });
  return out;
}

// ============================================================
// ACCIÓN: aprobarReserva / rechazarReserva (SOLO ADMIN, LockService)
// ============================================================
// Las dos revalidan el ESTADO_RESERVA actual DE NUEVO, ya adentro del
// lock, antes de escribir nada -- si dos pedidos llegan casi juntos (dos
// clics seguidos, dos pestañas del panel abiertas), el segundo encuentra
// que ya no está PENDIENTE_APROBACION y se corta con un error claro, en
// vez de procesar la misma reserva dos veces.
function mp360ReservasAprobar_(datos) {
  datos = datos || {};
  if (!verificarClaveAdmin_(datos.clave)) throw new Error('Contraseña de administrador incorrecta.');
  var idReserva = normalizar_(datos.idReserva);
  if (!idReserva) throw new Error('Falta el ID de la reserva.');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = abrirPlanilla_();
    var sh = crearHojaReservasSiHaceFalta_(ss);
    var fila = buscarFilaReservaPorId_(sh, idReserva);
    if (!fila) throw new Error('No se encontró esa reserva.');
    var estadoActual = normalizar_(sh.getRange(fila, COL_RESERVAS.ESTADO_RESERVA).getValue());
    if (estadoActual !== ESTADO_RESERVA_PENDIENTE_APROBACION) {
      throw new Error('Esta reserva ya fue procesada (estado actual: ' + estadoActual + ').');
    }
    sh.getRange(fila, COL_RESERVAS.FECHA_APROBACION).setValue(new Date());
    return { ok: true, idReserva: idReserva, estadoReserva: ESTADO_RESERVA_RESERVADO };
  } finally {
    lock.releaseLock();
  }
}
function mp360ReservasRechazar_(datos) {
  datos = datos || {};
  if (!verificarClaveAdmin_(datos.clave)) throw new Error('Contraseña de administrador incorrecta.');
  var idReserva = normalizar_(datos.idReserva);
  if (!idReserva) throw new Error('Falta el ID de la reserva.');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = abrirPlanilla_();
    var sh = crearHojaReservasSiHaceFalta_(ss);
    var fila = buscarFilaReservaPorId_(sh, idReserva);
    if (!fila) throw new Error('No se encontró esa reserva.');
    var estadoActual = normalizar_(sh.getRange(fila, COL_RESERVAS.ESTADO_RESERVA).getValue());
    if (estadoActual !== ESTADO_RESERVA_PENDIENTE_APROBACION) {
      throw new Error('Esta reserva ya fue procesada (estado actual: ' + estadoActual + ').');
    }
    // Completar FECHA_RECHAZO alcanza: ESTADO_RESERVA (fórmula) pasa a
    // RECHAZADO solo, y leerReservasActivas_ deja de contarla como
    // "activa" -- el horario y el cruce quedan libres de inmediato, sin
    // ningún paso extra.
    sh.getRange(fila, COL_RESERVAS.FECHA_RECHAZO).setValue(new Date());
    return { ok: true, idReserva: idReserva, estadoReserva: ESTADO_RESERVA_RECHAZADO };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// ACCIÓN: verificarAcceso / validarTokenAcceso (acceso general, NO admin)
// ============================================================
function mp360VerificarAcceso_(datos) {
  datos = datos || {};
  var clave = normalizar_(datos.clave);
  if (!clave || clave !== obtenerClaveAccesoLiga_()) {
    throw new Error('Contraseña incorrecta.');
  }
  return { token: generarTokenAcceso_(), version: obtenerVersionAccesoLiga_() };
}
function mp360ValidarTokenAcceso_(datos) {
  datos = datos || {};
  var token = normalizar_(datos.token);
  var version = normalizar_(datos.version);
  var valido = !!token && !!version && version === obtenerVersionAccesoLiga_() && token === generarTokenAcceso_();
  return { valido: valido };
}

// ============================================================
// Punto de entrada de la Web App -- mismo patrón que CodigoWebApp.gs
// (JSON o JSONP si viene "&callback=..."), pero acepta tanto GET como
// POST porque las acciones de escritura necesitan mandar un cuerpo
// (comprobante en base64) que no entra cómodo en una URL de GET.
// ============================================================
function doGet(e) {
  return responderApi_(e);
}
function doPost(e) {
  return responderApi_(e);
}

function responderApi_(e) {
  var accion = e && e.parameter && e.parameter.accion;
  var resultado, error = null;
  try {
    resultado = ejecutarAccion_(accion, e);
  } catch (err) {
    error = String(err && err.message ? err.message : err);
  }
  var payload = error ? { ok: false, error: error } : { ok: true, data: resultado };
  var json = JSON.stringify(payload);

  var callback = e && e.parameter && e.parameter.callback ? normalizar_(e.parameter.callback) : '';
  if (callback && /^[a-zA-Z0-9_$.]+$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + json + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// Allowlist cerrada a 12 nombres de acción -- igual que CodigoWebApp.gs,
// cualquier otro valor cae en el "default" y responde un error sin
// ejecutar nada. El cuerpo POST (si vino) se intenta parsear como JSON;
// si el cliente mandó los datos como parámetros normales de formulario,
// se usan esos como respaldo.
function ejecutarAccion_(accion, e) {
  var params = (e && e.parameter) || {};
  var cuerpo = null;
  if (e && e.postData && e.postData.contents) {
    try { cuerpo = JSON.parse(e.postData.contents); } catch (err) { cuerpo = null; }
  }
  switch (accion) {
    case 'disponibilidad': return mp360ReservasGetDisponibilidad();
    case 'partidosDisponibles': return mp360ReservasGetPartidosDisponibles(params.categoria);
    case 'retenerTurno': return mp360ReservasRetener_(cuerpo || params);
    case 'confirmarReserva': return mp360ReservasConfirmar_(cuerpo || params);
    case 'consultarReserva': return mp360ReservasConsultar_(params.token);
    case 'buscarReserva': return mp360ReservasBuscarPorTelefono_(cuerpo || params);
    case 'cancelarReserva': return mp360ReservasCancelar_(cuerpo || params);
    case 'verificarAcceso': return mp360VerificarAcceso_(cuerpo || params);
    case 'validarTokenAcceso': return mp360ValidarTokenAcceso_(cuerpo || params);
    case 'listarPendientes': return mp360ReservasListarPendientes_(cuerpo || params);
    case 'aprobarReserva': return mp360ReservasAprobar_(cuerpo || params);
    case 'rechazarReserva': return mp360ReservasRechazar_(cuerpo || params);
    default: throw new Error('Acción desconocida: ' + accion);
  }
}

// ============================================================
// Limpieza automática de retenciones vencidas (cada 1 hora)
// ============================================================
// Es prolijidad, no corrección: una retención vencida ya deja de "contar"
// sola (ver leerRetencionesVivas_) apenas pasan los 10 minutos, esté o no
// esté físicamente borrada todavía. Esto solo evita que la hoja crezca
// sin límite con filas de gente que abrió el flujo y nunca lo terminó.
function limpiarRetencionesVencidas() {
  var ss = abrirPlanilla_();
  var sh = crearHojaRetencionesSiHaceFalta_(ss);
  var last = sh.getLastRow();
  if (last < 2) return;
  var vals = sh.getRange(2, 1, last - 1, COL_RETENCIONES.FECHA_CREACION).getValues();
  var ahora = new Date().getTime();
  var filasABorrar = [];
  for (var i = 0; i < vals.length; i++) {
    var fechaCreacion = vals[i][COL_RETENCIONES.FECHA_CREACION - 1];
    if (!(fechaCreacion instanceof Date)) continue;
    var edadMinutos = (ahora - fechaCreacion.getTime()) / 60000;
    if (edadMinutos > RETENCION_MINUTOS) filasABorrar.push(i + 2);
  }
  // Se borra de abajo hacia arriba para no correr los índices de las
  // filas que todavía faltan borrar.
  for (var j = filasABorrar.length - 1; j >= 0; j--) {
    sh.deleteRow(filasABorrar[j]);
  }
}

function configurarTriggerLimpieza_() {
  // Evita duplicar el trigger si esta función se corre más de una vez.
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'limpiarRetencionesVencidas') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // Apps Script no acepta "cada 60 minutos" vía everyMinutes() (solo 1,
  // 5, 10, 15 o 30) -- everyHours(1) es la forma correcta de pedir "cada
  // 60 minutos" exactos.
  ScriptApp.newTrigger('limpiarRetencionesVencidas')
    .timeBased()
    .everyHours(1)
    .create();
}

// ============================================================
// Reparación: HORARIO_INICIO/HORARIO_FIN convertidos a hora real
// ============================================================
// Corrige reservas/retenciones que ya existían ANTES de este arreglo:
// si Sheets ya había auto-detectado "17:00" como una hora real (Date con
// fecha base 30/12/1899), se reescribe como texto plano -- recién ahí
// ESTADO_RESERVA (que hace TIMEVALUE sobre HORARIO_FIN) deja de dar
// #VALUE!, y cualquier lectura de ese campo deja de mostrar
// "Sat Dec 30 1899 17:00:00 GMT...". También fuerza el formato de texto
// plano en un rango amplio (no solo hasta la última fila) para que
// Sheets no vuelva a auto-convertir filas futuras. Idempotente: si ya
// está todo en texto, no cambia nada.
function repararHorariosTexto_(ss) {
  [
    { sh: crearHojaReservasSiHaceFalta_(ss), colInicio: COL_RESERVAS.HORARIO_INICIO, colFin: COL_RESERVAS.HORARIO_FIN },
    { sh: crearHojaRetencionesSiHaceFalta_(ss), colInicio: COL_RETENCIONES.HORARIO_INICIO, colFin: COL_RETENCIONES.HORARIO_FIN },
  ].forEach(function (hoja) {
    [hoja.colInicio, hoja.colFin].forEach(function (col) {
      hoja.sh.getRange(2, col, 998, 1).setNumberFormat('@');
    });
    var last = hoja.sh.getLastRow();
    if (last < 2) return;
    [hoja.colInicio, hoja.colFin].forEach(function (col) {
      var rango = hoja.sh.getRange(2, col, last - 1, 1);
      var vals = rango.getValues();
      var cambiado = false;
      var nuevos = vals.map(function (row) {
        if (row[0] instanceof Date) { cambiado = true; return [normalizarHorario_(row[0])]; }
        return row;
      });
      if (cambiado) rango.setValues(nuevos);
    });
  });
}

// ============================================================
// Migración: CODIGO_RESERVA para reservas que ya existían
// ============================================================
// Agrega el header si la hoja RESERVAS es de antes de este cambio (tenía
// 23 columnas) y rellena un código único para cada fila que todavía no
// tenga uno -- así "Buscar mi reserva" también funciona para reservas
// creadas antes de que existiera esta función. Idempotente: una fila que
// ya tiene código nunca se toca.
function migrarCodigosReservaExistentes_(ss) {
  var sh = crearHojaReservasSiHaceFalta_(ss);
  var headerActual = normalizar_(sh.getRange(1, COL_RESERVAS.CODIGO_RESERVA).getValue());
  if (headerActual !== 'CODIGO_RESERVA') {
    sh.getRange(1, COL_RESERVAS.CODIGO_RESERVA).setValue('CODIGO_RESERVA').setFontWeight('bold');
  }
  var last = sh.getLastRow();
  if (last < 2) return;
  var vals = sh.getRange(2, COL_RESERVAS.CODIGO_RESERVA, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (normalizar_(vals[i][0])) continue; // ya tiene código -- no se toca
    var fila = i + 2;
    sh.getRange(fila, COL_RESERVAS.CODIGO_RESERVA).setValue(proximoCodigoReservaUnico_(sh));
  }
}

// ============================================================
// Migración: reservas de antes del flujo de aprobación
// ============================================================
// Agrega los headers FECHA_APROBACION/FECHA_RECHAZO si la hoja es de
// antes de este cambio (esto sí es seguro correrlo siempre: si el header
// ya está puesto, no hace nada). El backfill de abajo -- tratar cada fila
// con FECHA_APROBACION y FECHA_RECHAZO vacías como "reserva vieja de
// antes del flujo de aprobación" y aprobarla sola -- en cambio, SOLO
// tiene sentido la primera vez que se corre esta migración, justo en el
// momento en que el flujo de aprobación se introdujo. Después de esa
// primera vez, una fila con las dos fechas vacías ya NO significa "es
// vieja": significa, la inmensa mayoría de las veces, que es una reserva
// NUEVA genuinamente esperando revisión del organizador -- así es
// exactamente como mp360ReservasConfirmar_ crea cada reserva
// PENDIENTE_APROBACION a propósito (ver ese comentario ahí).
//
// BUG REAL encontrado y corregido acá: antes, este backfill no distinguía
// esos dos casos y corría de nuevo cada vez que se ejecutaba
// configuracionInicial() (por ejemplo, al desplegar cualquier otro
// cambio futuro) -- así fue como R0007 (código 8MHS7FXC), una reserva
// legítimamente PENDIENTE_APROBACION, quedó aprobada sola al correr
// configuracionInicial() para desplegar la Versión 8 de idempotencia,
// sin que nadie tocara el panel de admin.
//
// La corrección: un marcador en PropertiesService (MIGRACION_APROBACION_
// APLICADA) que se setea la primera vez que este backfill corre de
// verdad (haya o no filas para migrar en ese momento) y hace que todas
// las corridas siguientes de esta función sean un no-op total para el
// backfill -- se sigue pudiendo llamar sin miedo desde configuracionInicial()
// las veces que haga falta, para siempre, sin volver a tocar ninguna
// fila. Sigue siendo idempotente (para cualquier corrida después de la
// primera, el resultado es "no cambia nada", siempre el mismo resultado)
// y no dejó de migrar ninguna reserva legacy real: si en el momento en
// que se despliegue este arreglo todavía existiera alguna fila vieja
// genuina con las dos fechas vacías, esa migración corre exactamente una
// vez más (la primera corrida tras este cambio) y la backfillea
// correctamente, antes de bloquearse para siempre.
function migrarAprobacionExistente_(ss) {
  var sh = crearHojaReservasSiHaceFalta_(ss);
  [COL_RESERVAS.FECHA_APROBACION, COL_RESERVAS.FECHA_RECHAZO].forEach(function (col) {
    var headerEsperado = col === COL_RESERVAS.FECHA_APROBACION ? 'FECHA_APROBACION' : 'FECHA_RECHAZO';
    if (normalizar_(sh.getRange(1, col).getValue()) !== headerEsperado) {
      sh.getRange(1, col).setValue(headerEsperado).setFontWeight('bold');
    }
  });

  var YA_MIGRO_APROBACION_KEY_ = 'MIGRACION_APROBACION_APLICADA';
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(YA_MIGRO_APROBACION_KEY_) === 'true') return;

  var last = sh.getLastRow();
  if (last < 2) { props.setProperty(YA_MIGRO_APROBACION_KEY_, 'true'); return; }
  var rango = sh.getRange(2, 1, last - 1, COL_RESERVAS.FECHA_RECHAZO);
  var vals = rango.getValues();
  for (var i = 0; i < vals.length; i++) {
    var fila = i + 2;
    var row = vals[i];
    var aprobacion = row[COL_RESERVAS.FECHA_APROBACION - 1];
    var rechazo = row[COL_RESERVAS.FECHA_RECHAZO - 1];
    if (!aprobacion && !rechazo) {
      var creacion = row[COL_RESERVAS.FECHA_CREACION - 1];
      sh.getRange(fila, COL_RESERVAS.FECHA_APROBACION).setValue(creacion instanceof Date ? creacion : new Date());
    }
    sh.getRange(fila, COL_RESERVAS.ESTADO_RESERVA).setFormula(formulaEstadoReserva_(fila));
  }
  props.setProperty(YA_MIGRO_APROBACION_KEY_, 'true');
}

// ============================================================
// Migración: columna ID_RETENCION_ORIGEN (idempotencia de confirmarReserva)
// ============================================================
// Agrega el header si la hoja RESERVAS es de antes de este cambio.
// A propósito NO rellena nada en las filas ya existentes -- su retención
// original ya no existe hace rato (se borró al confirmarse, si no
// directamente venció), así que no hay ningún idRetencion real para
// completar ahí, y dejarla vacía es exactamente lo correcto: esas filas
// viejas simplemente nunca van a matchear contra un reintento (no pueden,
// el reintento llegaría con OTRO idRetencion, de otra retención nueva).
function migrarIdRetencionOrigenExistente_(ss) {
  var sh = crearHojaReservasSiHaceFalta_(ss);
  var headerActual = normalizar_(sh.getRange(1, COL_RESERVAS.ID_RETENCION_ORIGEN).getValue());
  if (headerActual !== 'ID_RETENCION_ORIGEN') {
    sh.getRange(1, COL_RESERVAS.ID_RETENCION_ORIGEN).setValue('ID_RETENCION_ORIGEN').setFontWeight('bold');
    sh.getRange(1, COL_RESERVAS.ID_RETENCION_ORIGEN).setNote(
      'Clave de idempotencia de confirmarReserva: el idRetencion que creó esta fila. Un reintento del mismo pedido (mismo idRetencion) nunca crea una fila nueva -- devuelve esta misma reserva. No se usa para nada más, no hace falta compartirla ni protegerla especialmente.'
    );
  }
}

// ============================================================
// Configuración inicial -- correr UNA SOLA VEZ a mano desde el editor de
// Apps Script (seleccionar "configuracionInicial" en el desplegable de
// funciones de arriba y tocar "Ejecutar"). Es idempotente: correrla de
// nuevo más adelante no duplica hojas ni rompe nada, así que sirve
// también como reparación si hiciera falta -- por ejemplo, después de
// pegar una actualización de este archivo, para aplicar migraciones
// sobre datos que ya existían (horarios, código de reserva, y ahora el
// esquema de aprobación).
// ============================================================
function configuracionInicial() {
  var ss = abrirPlanilla_();
  crearHojaReservasSiHaceFalta_(ss);
  crearHojaRetencionesSiHaceFalta_(ss);
  crearHojaBloqueosSiHaceFalta_(ss);
  crearHojaExcepcionesSiHaceFalta_(ss);
  aplicarValidacionesReservas_(ss);
  configurarTriggerLimpieza_();
  repararHorariosTexto_(ss);
  migrarCodigosReservaExistentes_(ss);
  migrarAprobacionExistente_(ss);
  migrarIdRetencionOrigenExistente_(ss);
  Logger.log('Configuración inicial de Reservas completa: hojas listas, validaciones aplicadas, trigger de limpieza activo, horarios reparados, códigos de reserva completos, esquema de aprobación migrado y columna de idempotencia de confirmarReserva lista.');
}
