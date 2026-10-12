// Pruebas de punta a punta del Worker con una base local.
// Correr con:  node --no-warnings cloudflare/test/prueba.mjs
import worker from '../worker.js';
import { crearD1 } from './d1-local.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DB = crearD1(path.join(aqui, '..', 'schema.sql'));
const env = { DB, CLAVE_ACCESO_LIGA: 'padel360', ACCESO_LIGA_VERSION: 'v1', CLAVE_ADMIN: 'clave-orga' };
const pendientesWaitUntil = [];
const ctx = { waitUntil: (p) => pendientesWaitUntil.push(p) };

let fallas = 0, oks = 0;
function check(cond, msg, extra) {
  if (cond) { oks++; } else { fallas++; console.log('  ✗ ' + msg, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
}
async function api(accion, datos = {}, metodo = 'POST') {
  let url = 'https://api.test/?accion=' + accion;
  let init = { method: metodo };
  if (metodo === 'GET') url += Object.entries(datos).map(([k, v]) => '&' + k + '=' + encodeURIComponent(v)).join('');
  else init.body = JSON.stringify(datos);
  const r = await worker.fetch(new Request(url, init), env, ctx);
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return { raw: t, status: r.status }; }
}
async function ok(accion, datos, metodo) {
  const r = await api(accion, datos, metodo);
  if (!r.ok) { fallas++; console.log('  ✗ ' + accion + ' devolvió error: ' + r.error); return null; }
  oks++;
  return r.data;
}

import { datosImport, hoy, masDias, cats, pend } from './datos-prueba.mjs';

// ---------------------------------------------------------------- pruebas
console.log('1) Acceso de organizador e importación');
check((await api('adminResumen', { tokenAdmin: 'x.y' })).ok === false, 'adminResumen sin sesión debe fallar');
check((await api('adminLogin', { clave: 'mal' })).ok === false, 'login con clave mala debe fallar');
const { tokenAdmin } = await ok('adminLogin', { clave: 'clave-orga' });
const A = (d = {}) => ({ tokenAdmin, ...d });
const imp = await ok('importar', A({ datos: datosImport }));
check(imp && imp.parejas === datosImport.parejas.length && imp.reservas === 4 && imp.sponsors === 1, 'importación cuenta filas', imp);
const imp2 = await ok('importar', A({ datos: datosImport }));
check(imp2 && imp2.importado, 'importar 2 veces es seguro (idempotente)');

console.log('2) Lectura pública');
const boot = await ok('bootstrap', {}, 'GET');
check(boot.categorias.length === 5 && boot.categorias[0] === '6ta Masculino', 'bootstrap categorías en orden', boot.categorias);
check(boot.inicio.novedades.length === 1 && boot.inicio.sponsors[0].logoUrl.includes('thumbnail?id=1AbCdEfGhIjKlMnOp'), 'novedades activas + logo de Drive convertido', boot.inicio);
const pos = await ok('posiciones', { categoria: '6ta Masculino' }, 'GET');
check(pos.length === 6 && pos[0].pos === 1 && pos.every((f) => f.pj === 2), 'posiciones: 6 parejas, 2 PJ c/u', pos);
check(pos[0].pts === 2 && typeof pos[0].difSets === 'number' && pos[0].pareja.includes(' / '), 'posiciones: formato', pos[0]);
const fix = await ok('fixture', { categoria: '7ma Femenino' }, 'GET');
check(fix.fechas.length === 5 && fix.fechas[0].libres.length === 1 && fix.fechas[0].partidos[0].estado === 'JUGADO', 'fixture 7ma F: 5 fechas, 1 libre por fecha', fix.fechas[0]);
check(fix.fechas[0].partidos[0].ganador === fix.fechas[0].partidos[0].parejaA, 'fixture: ganador = nombre de pareja A');
const resu = await ok('resultados', { categoria: '6ta Masculino' }, 'GET');
check(resu.length === 6 && resu[0].fecha === 2, 'resultados: jugados, fecha más reciente primero', resu.map((r) => r.fecha));
const mas = await ok('mas', {}, 'GET');
check(mas.premios.length === 1 && mas.playoffsMensaje.includes('diciembre'), 'mas: premios + playoffs', mas);
const spon = await ok('sponsors', {}, 'GET');
check(spon.destacado && spon.destacado.nombre === 'Club X' && spon.resto.length === 0, 'sponsors destacado', spon);
check((await ok('galeria', {}, 'GET')).length === 0, 'galería vacía (fila EJEMPLO inactiva)');
const jsonp = await worker.fetch(new Request('https://api.test/?accion=categorias&callback=cb1'), env, ctx);
check((await jsonp.text()).startsWith('cb1({"ok":true'), 'JSONP sigue funcionando');

console.log('3) Acceso general (contraseña de la liga)');
check((await api('verificarAcceso', { clave: 'nop' }, 'GET')).ok === false, 'clave general mala falla');
const acc = await ok('verificarAcceso', { clave: 'padel360' }, 'GET');
check(acc.version === 'v1' && /=$/.test(acc.token), 'token estilo Apps Script (con = al final)', acc);
check((await ok('validarTokenAcceso', acc)).valido === true, 'token válido');
check((await ok('validarTokenAcceso', { token: acc.token, version: 'v0' })).valido === false, 'versión vieja invalida');

console.log('4) Reservas: flujo completo');
const disp = await ok('disponibilidad', {}, 'GET');
check(disp.dias.length > 5, 'disponibilidad con días', disp.dias.length);
const dia1 = disp.dias.find((d) => d.fecha === masDias(1));
const fr2130 = dia1 && dia1.franjas.find((f) => f.inicio === '21:00');
// grilla del día: 21:00-22:30 tiene 3 canchas; R0003 (aprobada) + R0004 (pendiente) ocupan 2; R0002 rechazada NO ocupa.
check(fr2130 && fr2130.disponibles === 1, 'rechazada libera lugar; pendiente y aprobada ocupan', dia1);
const cruces = await ok('partidosDisponibles', { categoria: pend[0].categoria }, 'GET');
check(cruces.some((x) => x.idPartido === pend[0].id), 'cruce de reserva rechazada vuelve a estar disponible');
check(!cruces.some((x) => x.idPartido === pend[1].id), 'cruce con reserva aprobada no aparece');
check(cruces.every((x) => x.fecha <= 4), 'solo fechas <= fecha en juego');

const elegido = cruces[0];
const turno = { idPartido: elegido.idPartido, fecha: dia1.fecha, horarioInicio: '21:00', horarioFin: '22:30' };
const ret = await ok('retenerTurno', turno);
check(ret && ret.idRetencion && ret.montoSena === 9000 && ret.valorTotal === 36000, 'retener turno', ret);
const dispTras = await ok('disponibilidad', {}, 'GET');
check(!dispTras.dias.find((d) => d.fecha === dia1.fecha).franjas.some((f) => f.inicio === '21:00'), 'la retención ocupa el último lugar');
check((await api('retenerTurno', { ...turno, idPartido: cruces[1].idPartido })).error === 'Ese horario ya no tiene lugar disponible.', 'sin lugar: mensaje correcto');

const png = 'data:image/png;base64,' + Buffer.from('fakepngdata').toString('base64');
const conf = await ok('confirmarReserva', { idRetencion: ret.idRetencion, nombre: 'Juan', telefono: '351 600-7788', comprobanteBase64: png, comprobanteNombreArchivo: 'c.png', comprobanteTipoMime: 'image/png' });
check(conf && conf.estadoReserva === 'PENDIENTE_APROBACION' && conf.cancha === 3 && /^R0005$/.test(conf.idReserva) && conf.codigoReserva.length === 8, 'confirmar: pendiente, cancha 3 (1 y 2 ocupadas), R0005', conf);
const conf2 = await ok('confirmarReserva', { idRetencion: ret.idRetencion, nombre: 'Juan', telefono: '351 600-7788', comprobanteBase64: png, comprobanteTipoMime: 'image/png' });
check(conf2 && conf2.idReserva === conf.idReserva, 'reintento de confirmar devuelve la misma reserva (no duplica)');
const cons = await ok('consultarReserva', { token: conf.tokenGestion }, 'GET');
check(cons.estadoReserva === 'PENDIENTE_APROBACION' && cons.saldoPendiente === 27000 && !('telefono' in cons), 'consultar (sin teléfono)', cons);
check((await api('buscarReserva', { telefono: '3516007788', codigo: 'XXXXXXXX' })).ok === false, 'buscar con código malo falla');
const busc = await ok('buscarReserva', { telefono: '+54 (351) 600 7788', codigo: conf.codigoReserva.toLowerCase() });
check(busc && busc.tokenGestion === conf.tokenGestion, 'buscar por teléfono (otro formato) + código');
check((await api('cancelarReserva', { token: conf.tokenGestion })).error.includes('pendiente de aprobación'), 'no se cancela una pendiente');

console.log('5) Organizador: reservas');
const resu1 = await ok('adminResumen', A());
check(resu1.pendientes === 2 && resu1.categorias.length === 5, 'resumen: 2 pendientes', resu1);
const pends = await ok('adminReservas', A({ filtro: 'pendientes' }));
check(pends.length === 2 && pends[0].idReserva === 'R0004', 'pendientes más viejas primero');
const nueva = pends.find((r) => r.idReserva === conf.idReserva);
check(nueva.comprobanteUrl.includes('accion=archivo') && nueva.telefonoSolicitante === '351 600-7788', 'admin ve teléfono y link de comprobante', nueva);
const archivo = await worker.fetch(new Request(nueva.comprobanteUrl), env, ctx);
check(archivo.status === 200 && (await archivo.text()) === 'fakepngdata', 'comprobante se puede ver con sesión');
const sinPermiso = await worker.fetch(new Request(nueva.comprobanteUrl.replace(/&t=.*/, '')), env, ctx);
check(sinPermiso.status === 403, 'comprobante privado sin sesión = 403');
const legado = await ok('listarPendientes', { clave: 'clave-orga' });
check(legado.length === 2, 'acción vieja listarPendientes con clave sigue andando');
await ok('aprobarReserva', A({ idReserva: conf.idReserva }));
const reap = await ok('aprobarReserva', A({ idReserva: conf.idReserva }));
check(reap.estadoReserva === 'RESERVADO', 'aprobar dos veces es seguro');
await ok('rechazarReserva', A({ idReserva: 'R0004' }));
check((await api('aprobarReserva', A({ idReserva: 'R0004' }))).ok === false, 'no se aprueba una rechazada');
const prox = await ok('adminReservas', A({ filtro: 'proximas' }));
check(prox.length === 2 && prox.every((r) => r.estadoReserva === 'RESERVADO'), 'próximas = aprobadas futuras', prox.map((r) => r.idReserva));
await ok('adminMarcarPago', A({ idReserva: conf.idReserva, completo: true }));
check((await ok('consultarReserva', { token: conf.tokenGestion }, 'GET')).estadoPago === 'PAGO_COMPLETO', 'pago completo registrado');
const hist = await ok('adminReservas', A({ filtro: 'historial', q: 'lorena' }));
check(hist.length >= 3, 'historial con búsqueda', hist.length);
const agenda = await ok('adminAgenda', A({ desde: dia1.fecha, dias: 2 }));
const fAg = agenda.dias[0].franjas.find((f) => f.inicio === '21:00');
check(fAg.reservas.length === 2 && fAg.libres === 1, 'agenda: rechazada libera, muestra 2 reservas', fAg);
check(agenda.dias[1].bloqueos.length === 1, 'agenda muestra bloqueos');
// cancelar por jugador ahora que está aprobada
await ok('cancelarReserva', { token: conf.tokenGestion });
check((await ok('consultarReserva', { token: conf.tokenGestion }, 'GET')).estadoReserva === 'CANCELADO', 'jugador cancela una aprobada');

console.log('6) Concurrencia: 12 personas a la vez sobre la misma franja');
const diaC = disp.dias.find((d) => d.franjas.some((f) => f.disponibles === 2));
const frC = diaC.franjas.find((f) => f.disponibles === 2);
const todosCruces = [];
for (const cat of cats) for (const x of await ok('partidosDisponibles', { categoria: cat }, 'GET')) todosCruces.push(x);
const intentos = await Promise.all(todosCruces.slice(0, 12).map((x) => api('retenerTurno', { idPartido: x.idPartido, fecha: diaC.fecha, horarioInicio: frC.inicio, horarioFin: frC.fin })));
check(intentos.filter((r) => r.ok).length === 2, 'solo 2 retenciones para 2 lugares', intentos.map((r) => r.ok ? 'OK' : r.error));
const mismos = await Promise.all([1, 2, 3, 4, 5, 6].map(() => api('retenerTurno', { idPartido: todosCruces[20].idPartido, fecha: masDias(3), horarioInicio: '21:00', horarioFin: '22:30' })));
check(mismos.filter((r) => r.ok).length === 1, 'mismo cruce: solo 1 gana', mismos.map((r) => r.ok ? 'OK' : r.error));
// Confirmaciones simultáneas sobre la misma franja: canchas distintas
const ganadoras = intentos.filter((r) => r.ok).map((r) => r.data.idRetencion);
const confs = await Promise.all(ganadoras.map((id, i) => api('confirmarReserva', { idRetencion: id, nombre: 'C' + i, telefono: '35100000' + i, comprobanteBase64: png, comprobanteTipoMime: 'image/png' })));
check(confs.every((r) => r.ok) && new Set(confs.map((r) => r.data.cancha)).size === 2, 'confirmaciones simultáneas: canchas distintas', confs.map((r) => r.ok ? r.data.cancha : r.error));
check(new Set(confs.map((r) => r.data.idReserva)).size === 2, 'IDs de reserva distintos');

console.log('7) Organizador: resultados, parejas, fixture');
const ap = await ok('adminPartidos', A({ categoria: '8va Masculino' }));
const ptP = ap.partidos.find((p) => p.estado === 'PENDIENTE');
check((await api('adminGuardarResultado', A({ idPartido: ptP.idPartido, set1: '6-4', set2: 'hola' }))).error.includes('set 2'), 'set inválido avisa');
const gr = await ok('adminGuardarResultado', A({ idPartido: ptP.idPartido, set1: '4/6', set2: '6 3', set3: '10-7' }));
check(gr.estado === 'JUGADO' && gr.ganadorId === ptP.parejaAId && gr.set1 === '4-6', 'resultado a 3 sets', gr);
const pos2 = await ok('posiciones', { categoria: '8va Masculino' }, 'GET');
check(pos2.find((f) => f.idPareja === ptP.parejaAId).pj === 3, 'posiciones se actualizan al instante');
const gr2 = await ok('adminGuardarResultado', A({ idPartido: ptP.idPartido, set1: '', set2: '', set3: '' }));
check(gr2.estado === 'PENDIENTE', 'borrar resultado vuelve a pendiente');
await ok('adminFechaEnJuego', A({ categoria: '8va Masculino', fecha: 5 }));
check((await ok('adminPartidos', A({ categoria: '8va Masculino' }))).fechaEnJuego === 5, 'fecha en juego actualizada');
const np1 = await ok('adminGuardarPareja', A({ categoria: '8va Masculino', jugador1: 'Nuevo', jugador2: 'Jugador' }));
check(np1.id === 'P100', 'nueva pareja con ID correlativo', np1);
await ok('adminGuardarPareja', A({ id: np1.id, categoria: '8va Masculino', jugador1: 'Nuevo', jugador2: 'Corregido', estado: 'ACTIVA' }));
const prs = await ok('adminParejas', A());
check(prs.parejas.find((p) => p.id === 'P100').jugador2 === 'Corregido', 'editar pareja');
const genSin = await ok('adminGenerarFixture', A({ categoria: '8va Masculino' }));
check(genSin.requiereConfirmacion && genSin.existentes > 0 && genSin.jugados > 0, 'regenerar fixture pide confirmación', genSin);
await ok('adminCrearCategoria', A({ nombre: 'Mixto' }));
await ok('adminGuardarPareja', A({ categoria: 'Mixto', jugador1: 'M1', jugador2: 'M2' }));
await ok('adminGuardarPareja', A({ categoria: 'Mixto', jugador1: 'M3', jugador2: 'M4' }));
await ok('adminGuardarPareja', A({ categoria: 'Mixto', jugador1: 'M5', jugador2: 'M6' }));
const gen = await ok('adminGenerarFixture', A({ categoria: 'Mixto' }));
check(gen.generado && gen.fechas === 3 && gen.partidos === 3, 'fixture nuevo 3 parejas = 3 fechas', gen);
const fixM = await ok('fixture', { categoria: 'Mixto' }, 'GET');
check(fixM.fechas.every((f) => f.libres.length === 1 && f.partidos.length === 1), 'fixture con libre por fecha');
check((await api('adminEliminarCategoria', A({ nombre: 'Mixto' }))).ok === false, 'no borra categoría con datos');

console.log('8) Organizador: horarios, ajustes y contenido');
const bl = await ok('adminCrearBloqueo', A({ fecha: masDias(4), horaInicio: '18:00', horaFin: '23:00', cancha: 'TODAS', motivo: 'Torneo' }));
const d4 = (await ok('disponibilidad', {}, 'GET')).dias.find((d) => d.fecha === masDias(4));
check(!d4 || d4.franjas.length === 0 || d4.franjas.every((f) => f.inicio < '18:00'), 'bloqueo TODAS saca los turnos', d4);
await ok('adminEliminarBloqueo', A({ id: bl.id }));
check((await ok('adminBloqueos', A())).length === 1, 'listar bloqueos futuros');
const g = await ok('adminGrilla', A());
check(g.dias.length === 7 && g.dias[0].nombre === 'Lunes' && g.dias[0].franjas.length === 3, 'grilla inicial cargada', g.dias[0]);
check((await api('adminGuardarGrilla', A({ franjas: [{ dia: 1, inicio: '20:00', fin: '19:00', canchas: 2 }] }))).ok === false, 'grilla con horario al revés se rechaza');
const todas = g.dias.flatMap((d) => d.franjas.map((f) => ({ dia: d.dia, ...f })));
todas.push({ dia: 0, inicio: '10:00', fin: '11:30', canchas: 3 });
await ok('adminGuardarGrilla', A({ franjas: todas }));
check((await ok('adminGrilla', A())).dias[6].franjas.length === 1, 'agregar turno de domingo');
const cfg = await ok('adminGuardarConfig', A({ valores: { valor_turno: 40000, monto_sena: '10000', hackeo: 'x' } }));
check(cfg.valorTurno === 40000 && cfg.montoSena === 10000, 'ajustes de precio', cfg);
await ok('adminGuardarContenido', A({ tipo: 'NOVEDAD', titulo: 'Fecha 5', texto: 'Arranca el lunes', orden: 0 }));
check((await ok('bootstrap', {}, 'GET')).inicio.novedades[0].titulo === 'Fecha 5', 'nueva novedad arriba de todo');
const sub = await ok('adminSubirArchivo', A({ base64: png, mime: 'image/png', nombre: 'foto.png' }));
await ok('adminGuardarFoto', A({ url: sub.valor, titulo: 'Final', categoria: 'Fecha 5' }));
const gal = await ok('galeria', {}, 'GET');
check(gal.length === 1 && gal[0].url.startsWith('https://api.test/?accion=archivo'), 'foto subida en galería', gal);
const fotoPub = await worker.fetch(new Request(gal[0].url), env, ctx);
check(fotoPub.status === 200 && fotoPub.headers.get('Cache-Control').includes('immutable'), 'foto pública sin sesión');
await ok('adminGuardarSponsor', A({ nombre: 'Nuevo Sponsor', destacado: true, orden: 1 }));
check((await ok('sponsors', {}, 'GET')).destacado.nombre === 'Nuevo Sponsor', 'cambiar sponsor destacado');

console.log('10) Clases fijas, turnos especiales, pagos por jugador y etapas');
const cls = await ok('adminClases', A());
check(cls.length === 13 && cls.some((k) => k.profe === 'Gabriel' && k.dia === 3), 'clases de los profes cargadas solas', cls.length);
const g0 = await ok('adminGrilla', A());
const mar = (gg) => gg.dias.find((d) => d.dia === 2);
check(mar(g0).franjas.find((f) => f.inicio === '18:00').porClases === 2, 'martes 18:00: Pepi 15-19 y Gabriel 19-21 seguidas = 1 cancha ocupada → 2 libres', mar(g0).franjas);
check(mar(g0).franjas.find((f) => f.inicio === '21:00').porClases === 3, 'martes 21:00: sin clases → 3 libres');
const nuevaClase = await ok('adminGuardarClase', A({ dia: 2, inicio: '21:00', fin: '22:00', canchas: 2, profe: 'Recupero' }));
check(mar(await ok('adminGrilla', A())).franjas.find((f) => f.inicio === '21:00').porClases === 1, 'agregar clase de 2 canchas deja 1 libre');
await ok('adminGuardarClase', A({ id: nuevaClase.id, dia: 2, inicio: '22:30', fin: '23:30', canchas: 2, profe: 'Recupero' }));
check(mar(await ok('adminGrilla', A())).franjas.find((f) => f.inicio === '21:00').porClases === 3, 'mover la clase libera el turno');
await ok('adminEliminarClase', A({ id: nuevaClase.id }));
check((await api('adminGuardarClase', A({ dia: 2, inicio: '22:00', fin: '21:00' }))).ok === false, 'clase con horario al revés se rechaza');
// sábado dentro de la ventana
let sab = hoy; while (new Date(sab + 'T12:00:00Z').getUTCDay() !== 6) sab = masDias(Math.round((Date.parse(sab) - Date.parse(hoy)) / 864e5) + 1);
const calc = await ok('adminCalcularTurnos', A({ fecha: sab, desde: '09:00', hasta: '21:00', duracion: 90 }));
check(calc.turnos.length === 8 && calc.turnos[0].inicio === '09:00' && calc.turnos[7].fin === '21:00', 'sábado 9 a 21 → 8 turnos de 90 minutos', calc.turnos.map((t) => t.inicio));
check(calc.turnos.find((t) => t.inicio === '09:00').choca === '09:30–11:00', 'avisa si se pisa con un turno de la semana', calc.turnos[0]);
const nuevos = calc.turnos.filter((t) => !t.choca).map((t) => ({ inicio: t.inicio, fin: t.fin, canchas: t.libres }));
await ok('adminCrearTurnosFecha', A({ fecha: sab, turnos: nuevos }));
const dSab = (await ok('disponibilidad', {}, 'GET')).dias.find((d) => d.fecha === sab);
check(dSab && dSab.franjas.some((f) => f.inicio === '18:00'), 'el sábado ya ofrece turnos a la tarde', dSab && dSab.franjas.map((f) => f.inicio));
const ge = await ok('adminGrilla', A());
check(ge.turnosEspeciales.length === nuevos.length, 'turnos especiales listados');
const retSab = await ok('retenerTurno', { idPartido: (await ok('partidosDisponibles', { categoria: '7ma Masculino' }, 'GET'))[0].idPartido, fecha: sab, horarioInicio: '18:00', horarioFin: '19:30' });
check(retSab && retSab.idRetencion, 'se puede reservar en un turno especial');
for (const t of ge.turnosEspeciales) await ok('adminEliminarTurnoFecha', A({ id: t.id }));
check((await ok('adminGrilla', A())).turnosEspeciales.length === 0, 'turnos especiales eliminados');
const bl2 = await ok('adminCrearBloqueo', A({ fecha: masDias(5), horaInicio: '21:00', horaFin: '22:00', cancha: '1', motivo: 'Recupero clase' }));
await ok('adminEditarBloqueo', A({ id: bl2.id, fecha: masDias(6), horaInicio: '20:00', horaFin: '21:00', cancha: '2', motivo: 'Movido' }));
const bls = await ok('adminBloqueos', A());
const movido = bls.find((b) => b.id === bl2.id);
check(movido && movido.fecha === masDias(6) && movido.horaInicio === '20:00' && movido.cancha === '2', 'mover un bloqueo', movido);
const boot2 = await ok('bootstrap', {}, 'GET');
check(boot2.fechasEnJuego && boot2.fechasEnJuego['8va Masculino'] === 5 && boot2.fechasEnJuego['6ta Masculino'] === 4, 'portada recibe la fecha en juego de cada categoría', boot2.fechasEnJuego);
// pagos por jugador sobre una confirmada
const conf3 = (await ok('adminReservas', A({ filtro: 'proximas' })))[0];
check(conf3 && conf3.jugadores.length === 4, 'reserva trae los 4 jugadores', conf3 && conf3.jugadores);
const p1 = await ok('adminPagoJugador', A({ idReserva: conf3.idReserva, indice: 2, esSena: true }));
check(p1.senaIndice === 2 && p1.pagados[2] === true, 'marcar quién pagó la seña');
await ok('adminPagoJugador', A({ idReserva: conf3.idReserva, indice: 0, pagado: true }));
await ok('adminPagoJugador', A({ idReserva: conf3.idReserva, indice: 1, pagado: true }));
const p4 = await ok('adminPagoJugador', A({ idReserva: conf3.idReserva, indice: 3, pagado: true }));
check(p4.completo === true, 'con los 4 pagos queda completo');
const tras = (await ok('adminReservas', A({ filtro: 'proximas' }))).find((r) => r.idReserva === conf3.idReserva);
check(tras.estadoPago === 'PAGO_COMPLETO' && tras.montoPagado === tras.valorTotal, 'monto y estado de pago se actualizan', tras);
await ok('adminPagoJugador', A({ idReserva: conf3.idReserva, indice: 3, pagado: false }));
check((await ok('consultarReserva', { token: (await api('buscarReserva', { telefono: tras.telefonoSolicitante, codigo: tras.codigoReserva })).data.tokenGestion }, 'GET')).saldoPendiente === 9000, 'destildar un pago vuelve a dejar saldo');
// etapas
const rech = await ok('adminReservas', A({ filtro: 'rechazadas' }));
check(rech.length >= 1 && rech.every((r) => r.estadoReserva === 'RECHAZADO' || r.estadoReserva === 'CANCELADO'), 'pestaña rechazadas y canceladas', rech.length);
const porCerrar = await ok('adminReservas', A({ filtro: 'porcerrar' }));
check(porCerrar.some((r) => r.idReserva === 'R0001'), 'jugada pero partido sin resultado → por cerrar', porCerrar.map((r) => r.idReserva));
// R0001: pago completo; si su partido tiene resultado pasa a completas
const pR1 = porCerrar.find((r) => r.idReserva === 'R0001');
check(pR1.pagados.every(Boolean), 'reserva vieja con pago completo = 4 tildados');
const resumen2 = await ok('adminResumen', A());
check(typeof resumen2.porCerrar === 'number' && resumen2.porCerrar >= 1, 'resumen cuenta las por cerrar', resumen2.porCerrar);
// partido suspendido (lluvia): se cancela una reserva ya jugada sin resultado y el cruce vuelve a estar libre
const libresAntes = await ok('partidosDisponibles', { categoria: pR1.categoria }, 'GET');
const cruceX = libresAntes[0];
await DB.prepare('UPDATE reservas SET id_partido = ? WHERE id = ?').bind(cruceX.idPartido, 'R0001').run();
check(!(await ok('partidosDisponibles', { categoria: pR1.categoria }, 'GET')).some((x) => x.idPartido === cruceX.idPartido), 'cruce con reserva jugada no está libre');
await ok('adminGuardarResultado', A({ idPartido: cruceX.idPartido, set1: '6-4', set2: '6-3', set3: '' }));
check((await api('adminCancelarReserva', A({ idReserva: 'R0001' }))).error.includes('resultado cargado'), 'no cancela si el partido tiene resultado');
await ok('adminGuardarResultado', A({ idPartido: cruceX.idPartido, set1: '', set2: '', set3: '' }));
await ok('adminCancelarReserva', A({ idReserva: 'R0001' }));
const r1Tras = (await ok('adminReservas', A({ filtro: 'rechazadas' }))).find((r) => r.idReserva === 'R0001');
check(r1Tras && r1Tras.estadoReserva === 'CANCELADO', 'reserva jugada cancelada aparece en rechazadas/canceladas');
check((await ok('partidosDisponibles', { categoria: pR1.categoria }, 'GET')).some((x) => x.idPartido === cruceX.idPartido), 'el cruce suspendido vuelve a estar disponible');
check((await api('adminCancelarReserva', A({ idReserva: 'R0001' }))).ok === false, 'no se cancela dos veces');

console.log('9) Protección al re-importar');
const reimp = await api('importar', A({ datos: datosImport }));
check(reimp.ok === false && reimp.error.includes('no están en la planilla'), 'no pisa reservas nuevas', reimp.error);

console.log('12) Sets sin guion, eliminar reserva');
{
  const cat = datosImport.categorias[0].nombre;
  const pp = (await ok('adminPartidos', A({ categoria: cat }))).partidos.find((x) => x.estado !== 'JUGADO');
  const g1 = await ok('adminGuardarResultado', A({ idPartido: pp.idPartido, set1: '63', set2: '46', set3: '108' }));
  check(g1 && g1.estado === 'JUGADO', 'sets escritos sin guion (63 46 108)', g1);
  const pp2 = (await ok('adminPartidos', A({ categoria: cat }))).partidos.find((x) => x.idPartido === pp.idPartido);
  check(pp2.set1 === '6-3' && pp2.set2 === '4-6' && pp2.set3 === '10-8', 'se guardan como 6-3 4-6 10-8', [pp2.set1, pp2.set2, pp2.set3]);
  const g2 = await ok('adminGuardarResultado', A({ idPartido: pp.idPartido, set1: '76', set2: '67', set3: '1210' }));
  const pp3 = (await ok('adminPartidos', A({ categoria: cat }))).partidos.find((x) => x.idPartido === pp.idPartido);
  check(pp3.set1 === '7-6' && pp3.set2 === '6-7' && pp3.set3 === '12-10', '76 67 1210', [pp3.set1, pp3.set2, pp3.set3]);
  check((await api('adminGuardarResultado', A({ idPartido: pp.idPartido, set1: '99', set2: '64' }))).ok === false, 'set imposible (99) avisa');
  await ok('adminGuardarResultado', A({ idPartido: pp.idPartido, set1: '', set2: '', set3: '' }));
  const hist = await ok('adminReservas', A({ filtro: 'historial' }));
  const victima = hist[hist.length - 1];
  await ok('adminEliminarReserva', A({ idReserva: victima.idReserva }));
  check(!(await ok('adminReservas', A({ filtro: 'historial' }))).some((r) => r.idReserva === victima.idReserva), 'reserva eliminada del sistema');
  check((await api('adminEliminarReserva', { idReserva: hist[0].idReserva })).ok === false, 'eliminar exige organizador');
}

console.log('11) Publicar: reiniciar todo como está en la planilla');
const antesG = await ok('adminGrilla', A());
check((await DB.prepare("SELECT valor FROM config WHERE clave = 'valor_turno'").first()).valor !== '36000' && (await DB.prepare('SELECT COUNT(*) AS n FROM archivos').first()).n > 0, 'antes: hay cambios de prueba (precio, archivos)', antesG.clases.length + ' clases, ' + antesG.turnosEspeciales.length + ' especiales');
const reini = await ok('importar', A({ datos: datosImport, forzar: true, reiniciarTodo: true }));
check(reini && reini.reiniciado === true, 'importar con reiniciarTodo');
const g2 = await ok('adminGrilla', A());
check(g2.clases.length === 13, 'clases fijas vuelven a las originales', g2.clases.length);
check(g2.turnosEspeciales.length === 0, 'turnos especiales de prueba borrados');
const bd = (sql) => DB.prepare(sql).first();
check((await bd('SELECT COUNT(*) AS n FROM grilla')).n === 19, 'grilla semanal original (19 turnos)');
check((await bd("SELECT valor FROM config WHERE clave = 'valor_turno'")).valor === '36000', 'precio original');
check((await bd('SELECT COUNT(*) AS n FROM archivos')).n === 0 && (await bd("SELECT COUNT(*) AS n FROM fotos WHERE url LIKE 'archivo:%'")).n === 0, 'fotos y comprobantes de prueba borrados');
check((await bd('SELECT COUNT(*) AS n FROM reservas')).n === datosImport.reservas.length, 'reservas = solo las de la planilla');
check((await bd('SELECT COUNT(*) AS n FROM fotos')).n === datosImport.galeria.filter((f) => String(f.activo).toUpperCase() === 'SI').length, 'galería = la de la planilla');
const pos11 = await ok('posiciones', { categoria: datosImport.categorias[0].nombre }, 'GET');
check(pos11 !== null, 'la app sigue respondiendo después de reiniciar');

await Promise.all(pendientesWaitUntil);
console.log('\nResultado: ' + oks + ' OK, ' + fallas + ' con problemas');
process.exit(fallas ? 1 : 0);
