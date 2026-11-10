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
// Turno de 22:30 a 00:00 (se guarda como 24:00) de lunes a viernes
const diaHab = dispTras.dias.find((d) => { const w = new Date(d.fecha + 'T12:00:00Z').getUTCDay(); return w >= 1 && w <= 5 && d.fecha > dia1.fecha; });
const fr2230 = diaHab && diaHab.franjas.find((f) => f.inicio === '22:30');
check(fr2230 && fr2230.fin === '24:00', 'turno 22:30 a 24:00 disponible de lunes a viernes', diaHab);
const ret2230 = await api('retenerTurno', { idPartido: cruces[2].idPartido, fecha: diaHab.fecha, horarioInicio: '22:30', horarioFin: '24:00' });
check(ret2230.ok && ret2230.data && ret2230.data.idRetencion || ret2230.idRetencion, 'se puede retener el turno de 22:30 a 24:00', ret2230);

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
check(g.dias.length === 7 && g.dias[0].nombre === 'Lunes' && g.dias[0].franjas.length === 4 && g.dias[0].franjas[3].inicio === '22:30' && g.dias[0].franjas[3].fin === '24:00', 'grilla inicial cargada (con el turno de 22:30 a 00:00)', g.dias[0]);
check((await api('adminGuardarGrilla', A({ franjas: [{ dia: 1, inicio: '20:00', fin: '19:00', canchas: 2 }] }))).ok === false, 'grilla con horario al revés se rechaza');
const todas = g.dias.flatMap((d) => d.franjas.map((f) => ({ dia: d.dia, ...f })));
todas.push({ dia: 0, inicio: '10:00', fin: '11:30', canchas: 3 });
await ok('adminGuardarGrilla', A({ franjas: todas }));
check((await ok('adminGrilla', A())).dias[6].franjas.length === 1, 'agregar turno de domingo');
// El celu manda la medianoche como "00:00": tiene que guardarse y quedar guardado.
const conMedianoche = todas.filter((f) => f.inicio !== '22:30').concat([1, 2, 3, 4, 5].map((dia) => ({ dia, inicio: '22:30', fin: '00:00', canchas: 3 })));
await ok('adminGuardarGrilla', A({ franjas: conMedianoche }));
const gMed = await ok('adminGrilla', A());
check([0, 1, 2, 3, 4].every((i) => gMed.dias[i].franjas.some((f) => f.inicio === '22:30' && f.fin === '24:00' && f.canchas === 3)), 'turno 22:30 a 00:00 de lunes a viernes queda guardado', gMed.dias[0]);
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

console.log('13) Parejas de baja no se pueden reservar');
{
  const cat = datosImport.categorias[0].nombre;
  await ok('adminFechaEnJuego', A({ categoria: cat, fecha: 99 }));
  const libres = await ok('partidosDisponibles', { categoria: cat }, 'GET');
  const x = libres[0];
  const pareja = (await ok('adminParejas', A({ categoria: cat }))).parejas.find((p) => p.categoria === cat && x.parejaA.includes(p.jugador1));
  check(!!pareja, 'encuentro la pareja del cruce', x);
  await ok('adminGuardarPareja', A({ ...pareja, estado: 'BAJA' }));
  check(!(await ok('partidosDisponibles', { categoria: cat }, 'GET')).some((y) => y.idPartido === x.idPartido), 'cruce con pareja de baja ya no se ofrece');
  await ok('adminGuardarPareja', A({ ...pareja, estado: 'ACTIVA' }));
  check((await ok('partidosDisponibles', { categoria: cat }, 'GET')).some((y) => y.idPartido === x.idPartido), 'al reactivarla vuelve a aparecer');
}

console.log('14) Dar de baja con W.O.');
{
  const cat = datosImport.categorias[0].nombre;
  const { parejas } = await ok('adminParejas', A({ categoria: cat }));
  const activas = parejas.filter((p) => p.categoria === cat && p.estado === 'ACTIVA');
  const todosPt = (await ok('adminPartidos', A({ categoria: cat }))).partidos;
  // Elijo una pareja con al menos un partido pendiente.
  const baja = activas.find((p) => todosPt.some((x) => x.estado !== 'JUGADO' && (x.parejaAId === p.id || x.parejaBId === p.id)));
  check(!!baja, 'hay una pareja con partidos pendientes');
  let mios = todosPt.filter((x) => x.parejaAId === baja.id || x.parejaBId === baja.id);
  // Me aseguro de tener un partido ya jugado (que debe quedar igual): le cargo una derrota.
  const yaJugado = mios.find((x) => x.estado === 'JUGADO') || mios[0];
  if (yaJugado.estado !== 'JUGADO') await ok('adminGuardarResultado', A({ idPartido: yaJugado.idPartido, set1: yaJugado.parejaAId === baja.id ? '3-6' : '6-3', set2: yaJugado.parejaAId === baja.id ? '4-6' : '6-4' }));
  mios = (await ok('adminPartidos', A({ categoria: cat }))).partidos.filter((x) => x.parejaAId === baja.id || x.parejaBId === baja.id);
  const jugadoAntes = mios.find((x) => x.idPartido === yaJugado.idPartido);
  const pend = mios.filter((x) => x.estado !== 'JUGADO');
  check(pend.length > 0, 'quedan partidos pendientes para el W.O.');
  // Una reserva activa sobre un partido pendiente: se tiene que cancelar.
  await DB.prepare(`INSERT INTO reservas (id, token, codigo, fecha, hora_inicio, hora_fin, cancha, categoria, id_partido, creada_ts, aprobada_ts)
    VALUES ('R-WO', 'tok-wo', 'CODWO', '2099-01-01', '18:00', '19:30', 1, ?, ?, 1, 1)`).bind(cat, pend[0].idPartido).run();

  const posAntes = await ok('posiciones', { categoria: cat }, 'GET');
  const sim = await ok('adminDarDeBaja', A({ idPareja: baja.id, simular: true }));
  check(sim.simulado === true && sim.wo.length === pend.length, 'simular lista los W.O.', sim);
  check(sim.reservasCanceladas.some((x) => x.idReserva === 'R-WO'), 'simular lista la reserva a cancelar', sim.reservasCanceladas);
  check(JSON.stringify(await ok('posiciones', { categoria: cat }, 'GET')) === JSON.stringify(posAntes), 'simular no cambia nada');

  const r = await ok('adminDarDeBaja', A({ idPareja: baja.id }));
  check(r.simulado === false, 'baja hecha');
  const despues = (await ok('adminPartidos', A({ categoria: cat }))).partidos.filter((x) => x.parejaAId === baja.id || x.parejaBId === baja.id);
  for (const x of despues) {
    const antes = mios.find((y) => y.idPartido === x.idPartido);
    if (antes.estado === 'JUGADO') {
      check(x.set1 === antes.set1 && x.set2 === antes.set2 && x.ganadorId === antes.ganadorId && !x.wo, 'lo ya jugado queda igual', x);
    } else {
      const rival = x.parejaAId === baja.id ? x.parejaBId : x.parejaAId;
      const esperado = x.parejaAId === baja.id ? '0-6' : '6-0';
      check(x.estado === 'JUGADO' && x.wo && x.ganadorId === rival && x.set1 === esperado && x.set2 === esperado && x.set3 === '', 'W.O. 6-0 6-0 para el rival', x);
    }
  }
  check(!!(await DB.prepare("SELECT cancelada_ts FROM reservas WHERE id = 'R-WO'").first()).cancelada_ts, 'reserva cancelada');
  const pos = await ok('posiciones', { categoria: cat }, 'GET');
  check(!pos.some((f) => f.idPareja === baja.id), 'la pareja de baja no está en posiciones');
  const rival0 = pend[0].parejaAId === baja.id ? pend[0].parejaBId : pend[0].parejaAId;
  const fa = posAntes.find((f) => f.idPareja === rival0), fd = pos.find((f) => f.idPareja === rival0);
  check(fd.pts === fa.pts + 1 && fd.pg === fa.pg + 1 && fd.pj === fa.pj + 1 && fd.difSets === fa.difSets + 2 && fd.difGames === fa.difGames + 12, 'el rival suma 1 punto, 2 sets y 12 games', { fa, fd });
  const fix = await ok('fixture', { categoria: cat }, 'GET');
  const enFix = fix.fechas.flatMap((f) => f.partidos).find((x) => x.idPartido === pend[0].idPartido);
  check(enFix.wo === true && enFix.sets.length === 2, 'el fixture marca el W.O.', enFix);
  const res = await ok('resultados', { categoria: cat }, 'GET');
  check(res.find((x) => x.idPartido === pend[0].idPartido).wo === true, 'resultados marca el W.O.');
  check(res.find((x) => x.idPartido === jugadoAntes.idPartido).wo === false, 'resultado real sin marca');
  check((await api('adminDarDeBaja', A({ idPareja: baja.id }))).ok === false, 'no se puede dar de baja dos veces');

  // Si un W.O. se corrige a mano, deja de ser W.O.
  await ok('adminGuardarResultado', A({ idPartido: pend[0].idPartido, set1: '6-4', set2: '6-4' }));
  check((await ok('resultados', { categoria: cat }, 'GET')).find((x) => x.idPartido === pend[0].idPartido).wo === false, 'resultado cargado a mano saca la marca W.O.');

  // Reactivar: los W.O. que quedaban vuelven a pendientes.
  await ok('adminGuardarPareja', A({ ...baja, estado: 'ACTIVA' }));
  const re = (await ok('adminPartidos', A({ categoria: cat }))).partidos.filter((x) => x.parejaAId === baja.id || x.parejaBId === baja.id);
  check(re.filter((x) => x.estado !== 'JUGADO').length === pend.length - 1 && !re.some((x) => x.wo), 'al reactivar, los W.O. vuelven a pendientes', re);
  check(re.find((x) => x.idPartido === jugadoAntes.idPartido).estado === 'JUGADO', 'al reactivar, lo jugado queda');
}

console.log('15) Teléfonos de las parejas y avisos de atrasados (base vieja que se pone al día sola)');
{
  // Base como la de producción antes de esta versión: sin teléfonos ni tabla de avisos.
  const DB2 = crearD1(path.join(aqui, '..', 'schema.sql'));
  DB2._raw.exec('DROP TABLE avisos_atrasados; ALTER TABLE parejas DROP COLUMN telefono1; ALTER TABLE parejas DROP COLUMN telefono2;');
  const w2 = (await import('../worker.js?migracion')).default; // instancia nueva: vuelve a correr asegurarEsquema
  const env2 = { ...env, DB: DB2 };
  const api2 = async (accion, datos = {}) => {
    const r = await w2.fetch(new Request('https://api.test/?accion=' + accion, { method: 'POST', body: JSON.stringify(datos) }), env2, ctx);
    return r.json();
  };
  const ok2 = async (accion, datos) => { const r = await api2(accion, datos); if (!r.ok) { fallas++; console.log('  ✗ ' + accion + ' devolvió error: ' + r.error); return null; } oks++; return r.data; };
  const t2 = (await ok2('adminLogin', { clave: 'clave-orga' })).tokenAdmin;
  const B = (d = {}) => ({ tokenAdmin: t2, ...d });
  await ok2('importar', B({ datos: datosImport, forzar: true }));
  const cols = DB2._raw.prepare("SELECT name FROM pragma_table_info('parejas')").all().map((x) => x.name);
  check(cols.includes('telefono1') && cols.includes('telefono2'), 'migración: parejas tiene telefono1/telefono2', cols);
  check(!!DB2._raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'avisos_atrasados'").get(), 'migración: tabla avisos_atrasados creada');

  const idDe = (t) => String(t).split(' · ')[0];
  const deuda = pend[0]; // 6ta, fecha 3: tiene una reserva RECHAZADA → sigue debiéndose
  const X = idDe(deuda.parejaA), Xr = idDe(deuda.parejaB);
  const parejaDe = async (id) => (await ok2('adminParejas', B())).parejas.find((p) => p.id === id);
  const px = await parejaDe(X);
  check(px.telefono1 === '' && px.telefono2 === '' && Array.isArray(px.telefonosReservas), 'adminParejas devuelve teléfonos vacíos al principio', px);

  // Guardar con teléfonos (se normalizan a 10 dígitos)
  const g1 = await ok2('adminGuardarPareja', B({ id: X, categoria: px.categoria, jugador1: px.jugador1, jugador2: px.jugador2, estado: 'ACTIVA', telefono1: '+54 9 351 618-3879', telefono2: '0351 15 241-7105' }));
  check(g1.telefono1 === '3516183879' && g1.telefono2 === '3512417105' && g1.advertencias.length === 0, 'guardarPareja normaliza +54 9 y 0351 15', g1);
  // Guardar SIN teléfonos (pantalla vieja / corregir nombre) no los borra
  await ok2('adminGuardarPareja', B({ id: X, categoria: px.categoria, jugador1: px.jugador1 + ' Corregido', jugador2: px.jugador2, estado: 'ACTIVA' }));
  const px2 = await parejaDe(X);
  check(px2.jugador1.endsWith('Corregido') && px2.telefono1 === '3516183879' && px2.telefono2 === '3512417105', 'guardarPareja sin teléfonos conserva los que estaban', px2);
  // '' borra solo ese; null lo deja
  await ok2('adminGuardarPareja', B({ id: X, categoria: px.categoria, jugador1: px2.jugador1, jugador2: px.jugador2, estado: 'ACTIVA', telefono1: null, telefono2: '' }));
  const px3 = await parejaDe(X);
  check(px3.telefono1 === '3516183879' && px3.telefono2 === '', 'telefono2 vacío lo borra, telefono1 null lo deja', px3);
  // Validación suave: número corto se guarda con advertencia; texto sin números falla
  const gCorto = await ok2('adminGuardarPareja', B({ id: X, categoria: px.categoria, jugador1: px2.jugador1, jugador2: px.jugador2, estado: 'ACTIVA', telefono2: '12345' }));
  check(gCorto.telefono2 === '12345' && gCorto.advertencias.length === 1, 'número corto: se guarda con advertencia', gCorto);
  check((await api2('adminGuardarPareja', B({ id: X, categoria: px.categoria, jugador1: px2.jugador1, jugador2: px.jugador2, estado: 'ACTIVA', telefono2: 'no tiene' }))).ok === false, 'texto sin números no se acepta como teléfono');
  await ok2('adminGuardarPareja', B({ id: X, categoria: px.categoria, jugador1: px2.jugador1, jugador2: px.jugador2, estado: 'ACTIVA', telefono2: '351 241 7105' }));
  // Pareja nueva con teléfono
  const nueva = await ok2('adminGuardarPareja', B({ categoria: px.categoria, jugador1: 'Nuevo Tel', jugador2: 'Otro', telefono1: '3516000000' }));
  check(nueva.telefono1 === '3516000000' && nueva.telefono2 === '', 'pareja nueva con teléfono', nueva);
  await ok2('adminGuardarPareja', B({ id: nueva.id, categoria: px.categoria, jugador1: 'Nuevo Tel', jugador2: 'Otro', estado: 'BAJA' }));

  // Carga en bloque
  check((await api2('adminGuardarTelefonos', B({ telefonos: [] }))).ok === false, 'bloque vacío da error');
  const parejas6 = (await ok2('adminParejas', B())).parejas.filter((p) => p.categoria === px.categoria && p.estado === 'ACTIVA' && p.id !== X);
  const [Y, Z] = [parejas6[0].id, parejas6[1].id];
  const bl = await ok2('adminGuardarTelefonos', B({ telefonos: [
    { idPareja: Y, telefono1: '3543 15 123456', telefono2: '11 15 2345-6789' },
    { idPareja: Z, telefono1: '15 6183870' },
    { idPareja: 'P999', telefono1: '3511111111' },
    { idPareja: X, telefono2: null },
    { id: Xr, telefono1: '5493516180000', telefono2: '549351618' },
  ] }));
  const porId = Object.fromEntries((bl ? bl.parejas : []).map((p) => [p.idPareja, p]));
  check(bl.actualizadas === 3 && bl.noEncontradas.length === 1 && bl.noEncontradas[0] === 'P999', 'bloque: 3 actualizadas, P999 no encontrada', bl);
  check(porId[Y] && porId[Y].telefono1 === '3543123456' && porId[Y].telefono2 === '1123456789', 'bloque: saca el 15 (3543 y 11)', porId[Y]);
  check(porId[Z] && porId[Z].telefono1 === '3516183870' && porId[Z].telefono2 === '', 'bloque: 15 sin característica → Córdoba 351; telefono2 no tocado', porId[Z]);
  check(porId[Xr] && porId[Xr].telefono1 === '3516180000' && bl.advertencias.length === 1 && bl.advertencias[0].startsWith(Xr), 'bloque: 549… normalizado y advertencia por número corto', bl);
  check(!porId[X] && (await parejaDe(X)).telefono2 === '3512417105', 'bloque: fila sin cambios no toca nada');
  check((await api2('adminGuardarTelefonos', B({ telefonos: [{ idPareja: Y, telefono1: 'abc' }] }))).ok === false && (await parejaDe(Y)).telefono1 === '3543123456', 'bloque con un teléfono inválido no cambia nada');

  // Atrasados agrupados por pareja
  let at = await ok2('adminAtrasados', B());
  const cat6 = at.categorias.find((k) => k.categoria === deuda.categoria);
  check(cat6.fechaEnJuego === 4 && cat6.partidosSinReservar === 1, '6ta: 1 atrasado sin reservar (la reserva rechazada no cuenta)', cat6);
  check(cat6.parejas.length === 2 && cat6.parejas.every((p) => p.partidos.length === 1 && p.partidos[0].idPartido === deuda.id), '6ta: deben las 2 parejas de ese partido', cat6.parejas);
  check(cat6.enCamino.length === 2 && cat6.enCamino.some((x) => x.idPartido === pend[1].id && x.etapa === 'reservado') && cat6.enCamino.some((x) => x.idPartido === pend[2].id && x.etapa === 'aprobar'), '6ta: reservado y para aprobar van aparte', cat6.enCamino);
  const fx = cat6.parejas.find((p) => p.idPareja === X), fxr = cat6.parejas.find((p) => p.idPareja === Xr);
  check(fx.telefono1 === '3516183879' && fx.contactos.length === 2 && fx.avisos === 0 && fx.ultimoAviso === null && fx.tocaAvisar === true, 'ficha de pareja: teléfonos, contactos, nunca avisada', fx);
  check(fxr.partidos[0].rivalId === X && fxr.partidos[0].rivalContactos.map((c) => c.telefono).join(',') === '3516183879,3512417105', 'el rival trae los contactos de la otra pareja', fxr.partidos[0]);
  check(at.totales.partidosSinReservar === at.categorias.reduce((n, k) => n + k.partidosSinReservar, 0) && at.totales.enCamino === 2 && at.totales.faltaAprobar === 1 && at.totales.reservados === 1, 'totales', at.totales);
  check(at.totales.tocaAvisar === at.totales.parejasDeben, 'al principio todas están para avisar', at.totales);

  // Más de un partido debido y orden por cantidad
  await ok2('adminFechaEnJuego', B({ categoria: '8va Masculino', fecha: 5 }));
  const pts8 = (await ok2('adminPartidos', B({ categoria: '8va Masculino' }))).partidos;
  const f3 = pts8.find((p) => p.fecha === 3);
  await ok2('adminGuardarResultado', B({ idPartido: f3.idPartido, set1: '6-1', set2: '6-1' }));
  const cat8 = (await ok2('adminAtrasados', B())).categorias.find((k) => k.categoria === '8va Masculino');
  const cant = cat8.parejas.map((p) => p.partidos.length);
  check(cat8.parejas.length === 6 && cant.join(',') === '2,2,2,2,1,1', '8va M: ordenadas por partidos que deben', cant);
  check(cat8.parejas[0].partidos.every((x, i, a) => !i || a[i - 1].fecha <= x.fecha), 'partidos de la pareja en orden de fecha');

  // Pareja de baja: no aparece ni se le reclama a sus rivales
  const cat7 = at.categorias.find((k) => k.categoria === '7ma Masculino');
  const baja = cat7.parejas[0];
  await ok2('adminGuardarPareja', B({ id: baja.idPareja, categoria: '7ma Masculino', jugador1: baja.jugador1, jugador2: baja.jugador2, estado: 'BAJA' }));
  const cat7b = (await ok2('adminAtrasados', B())).categorias.find((k) => k.categoria === '7ma Masculino');
  check(!cat7b.parejas.some((p) => p.idPareja === baja.idPareja || p.partidos.some((x) => x.rivalId === baja.idPareja)), 'pareja de baja excluida (y sus partidos)', cat7b.parejas);
  check(cat7b.partidosSinReservar === cat7.partidosSinReservar - 1, 'baja: un atrasado menos', [cat7.partidosSinReservar, cat7b.partidosSinReservar]);
  check(!cat8.parejas.some((p) => p.idPareja === nueva.id), 'pareja nueva de baja no figura');

  // Teléfono sacado de las reservas cuando falta el de la pareja
  const cat7ma = at.categorias.find((k) => k.categoria === '7ma Masculino');
  const W = cat7ma.parejas.find((p) => p.idPareja !== baja.idPareja && !p.partidos.some((x) => x.rivalId === baja.idPareja));
  // Nombres reales (los de prueba 'JugNa' se parecen todos entre sí)
  await ok2('adminGuardarPareja', B({ id: W.idPareja, categoria: '7ma Masculino', jugador1: 'Martín Gómez', jugador2: 'Pablo Ríos', estado: 'ACTIVA' }));
  const jugW = (await ok2('adminPartidos', B({ categoria: '7ma Masculino' }))).partidos.find((p) => p.estado === 'JUGADO' && (p.parejaAId === W.idPareja || p.parejaBId === W.idPareja));
  await DB2.prepare(`INSERT INTO reservas (id, token, codigo, fecha, hora_inicio, hora_fin, cancha, categoria, id_partido, id_pareja_a, id_pareja_b, nombre, telefono, creada_ts, aprobada_ts)
    VALUES ('R-TEL', 'tok-tel', 'CODTEL', ?, '18:00', '19:30', 1, '7ma Masculino', ?, ?, ?, ?, '351-555-1234', 5, 5)`).bind(masDias(-30), jugW.idPartido, jugW.parejaAId, jugW.parejaBId, 'pablo rios').run();
  let fw = (await ok2('adminAtrasados', B())).categorias.find((k) => k.categoria === '7ma Masculino').parejas.find((p) => p.idPareja === W.idPareja);
  check(fw.telefono2 === '' && fw.telefonosReservas.length === 1 && fw.telefonosReservas[0].jugador === 2 && fw.telefonosReservas[0].telefono === '3515551234', 'teléfono de la reserva como respaldo (jugador 2)', fw);
  check(fw.contactos.some((c) => c.telefono === '3515551234' && c.origen === 'reserva'), 'el respaldo entra en los contactos para el mensaje', fw.contactos);
  check((await parejaDe(W.idPareja)).telefono2 === '', 'el teléfono de la reserva no se guarda solo en la pareja');
  await ok2('adminGuardarTelefonos', B({ telefonos: [{ idPareja: W.idPareja, telefono2: '3517777777' }] }));
  fw = (await ok2('adminAtrasados', B())).categorias.find((k) => k.categoria === '7ma Masculino').parejas.find((p) => p.idPareja === W.idPareja);
  check(fw.telefonosReservas.length === 0 && fw.contactos.length === 1 && fw.contactos[0].telefono === '3517777777', 'con teléfono cargado ya no usa el de la reserva', fw);

  // Registro de avisos
  check((await api2('adminRegistrarAviso', B({ idPareja: 'P999', telefono: '3511111111' }))).ok === false, 'aviso a pareja inexistente falla');
  const av1 = await ok2('adminRegistrarAviso', B({ idPareja: X, telefono: '3516183879', idsPartidos: [deuda.id] }));
  check(av1.registrado && av1.avisos === 1 && av1.mensajes === 1 && av1.ultimoAviso > 0, 'aviso registrado', av1);
  const av2 = await ok2('adminRegistrarAviso', B({ idPareja: X, telefono: '351 618 3879', idsPartidos: [deuda.id] }));
  check(!av2.registrado && av2.mensajes === 1, 'doble toque al mismo número no cuenta dos veces', av2);
  const av3 = await ok2('adminRegistrarAviso', B({ idPareja: X, telefono: '3512417105', idsPartidos: [deuda.id] }));
  check(av3.registrado && av3.mensajes === 2 && av3.avisos === 1, 'al otro jugador el mismo día: 2 mensajes, 1 aviso', av3);
  // Xr avisada hace 8 días: le vuelve a tocar
  DB2._raw.prepare('INSERT INTO avisos_atrasados (pareja_id, telefono, ts, partidos) VALUES (?, ?, ?, ?)').run(Xr, '3516180000', Date.now() - 8 * 864e5, '[]');
  at = await ok2('adminAtrasados', B());
  const c6 = at.categorias.find((k) => k.categoria === deuda.categoria);
  const ax = c6.parejas.find((p) => p.idPareja === X), axr = c6.parejas.find((p) => p.idPareja === Xr);
  check(ax.avisos === 1 && ax.mensajes === 2 && ax.ultimoAviso === av3.ultimoAviso && ax.tocaAvisar === false, 'recién avisada: no toca avisar', ax);
  check(axr.avisos === 1 && axr.tocaAvisar === true && Date.now() - axr.ultimoAviso > 7 * 864e5, 'avisada hace 8 días: toca avisar de nuevo', axr);
  check(at.totales.tocaAvisar === at.totales.parejasDeben - 1, 'totales: una menos para avisar', at.totales);
  const row = DB2._raw.prepare('SELECT * FROM avisos_atrasados WHERE pareja_id = ? ORDER BY id LIMIT 1').get(X);
  check(row.telefono === '3516183879' && JSON.parse(row.partidos)[0] === deuda.id, 'el aviso guarda teléfono y partidos', row);

  // Fixture público: marca de atrasado
  const fx6 = await w2.fetch(new Request('https://api.test/?accion=fixture&categoria=' + encodeURIComponent(deuda.categoria)), env2, ctx).then((r) => r.json());
  const f3p = fx6.data.fechas.find((f) => f.numero === 3).partidos;
  check(f3p.find((p) => p.idPartido === deuda.id).atrasado === true, 'fixture: atrasado sin reservar marcado');
  check(f3p.find((p) => p.idPartido === pend[1].id).atrasado === false && f3p.find((p) => p.idPartido === pend[2].id).atrasado === false, 'fixture: atrasado con reserva no se marca');
  check(fx6.data.fechas.find((f) => f.numero === 4).partidos.every((p) => p.atrasado === false) && fx6.data.fechas[0].partidos.every((p) => p.atrasado === false), 'fixture: fecha en juego y jugados no se marcan');

  // Reimportar la planilla no borra los teléfonos
  await ok2('importar', B({ datos: datosImport, forzar: true }));
  const tras = await parejaDe(X);
  check(tras.telefono1 === '3516183879' && tras.telefono2 === '3512417105', 'reimportar conserva los teléfonos', tras);
}

console.log('16) Salir del checkout libera la retención; la propia no bloquea');
{
  const cuenta = (sql, ...p) => DB.prepare(sql).bind(...p).first().then((r) => r.n);
  const dispL = await ok('disponibilidad', {}, 'GET');
  let diaL = null, frL = null, otraFr = null;
  for (const d of dispL.dias) {
    if (d.fecha <= masDias(1)) continue;
    const f = d.franjas.find((x) => x.disponibles >= 3);
    const o = f && d.franjas.find((x) => x !== f && x.disponibles >= 2 && !(x.inicio < f.fin && f.inicio < x.fin));
    if (f && o) { diaL = d; frL = f; otraFr = o; break; }
  }
  check(diaL && frL && otraFr, 'hay un día con dos franjas libres para probar', dispL.dias.map((d) => d.franjas.map((f) => f.disponibles)));
  const libresEn = async (fecha, ini) => { const dd = (await ok('disponibilidad', {}, 'GET')).dias.find((d) => d.fecha === fecha); const f = dd && dd.franjas.find((x) => x.inicio === ini); return f ? f.disponibles : 0; };
  const crucesL = [];
  for (const cat of cats) for (const x of await ok('partidosDisponibles', { categoria: cat }, 'GET')) crucesL.push({ ...x, cat });
  const X = crucesL[0].idPartido, Y = crucesL[1].idPartido;
  const tX = { idPartido: X, fecha: diaL.fecha, horarioInicio: frL.inicio, horarioFin: frL.fin };
  const tXotra = { ...tX, horarioInicio: otraFr.inicio, horarioFin: otraFr.fin };

  // Celular A retiene el cruce X
  const retA = await ok('retenerTurno', tX);
  check(retA && retA.idRetencion, 'A retiene el cruce X');
  check(await libresEn(diaL.fecha, frL.inicio) === frL.disponibles - 1, 'la retención ocupa un lugar');
  // Celular B (compañero) intenta el mismo cruce: mensaje claro con la hora en que se libera
  const bloq = await api('retenerTurno', tXotra);
  const filaA = await DB.prepare('SELECT creada_ts FROM retenciones WHERE id = ?').bind(retA.idRetencion).first();
  const horaEsperada = new Date(Math.ceil((filaA.creada_ts + retA.minutos * 60000) / 60000) * 60000 - 3 * 3600e3).toISOString().slice(11, 16);
  check(bloq.ok === false && bloq.error === 'Alguien de tu partido está reservando este cruce ahora. Si no termina, se libera a las ' + horaEsperada + '.', 'retenido por otro: avisa a qué hora se libera', bloq.error);
  check(/se libera a las/.test((await api('retenerTurno', { ...tXotra, reemplazar: 'id-inventado' })).error), 'reemplazar con un id que no es suyo no saltea la retención de otro');

  // A sale del checkout: libera y el cruce queda libre al instante
  const lib = await ok('liberarRetencion', { idRetencion: retA.idRetencion });
  check(lib && lib.liberada === true, 'liberar borra la retención', lib);
  check(await cuenta('SELECT COUNT(*) AS n FROM retenciones WHERE id = ?', retA.idRetencion) === 0, 'la retención ya no está en la base');
  check(await libresEn(diaL.fecha, frL.inicio) === frL.disponibles, 'el lugar vuelve a estar disponible al instante');
  check((await ok('partidosDisponibles', { categoria: crucesL[0].cat }, 'GET')).some((p) => p.idPartido === X), 'el cruce vuelve a aparecer para reservar');
  check((await ok('liberarRetencion', { idRetencion: retA.idRetencion })).liberada === false, 'liberar dos veces no hace nada (idempotente)');
  check((await ok('liberarRetencion', { idRetencion: 'no-existe-123' })).liberada === false, 'liberar un id desconocido no hace nada');
  check((await ok('liberarRetencion', {})).liberada === false, 'liberar sin id no hace nada');
  check((await ok('liberarRetencion', { idRetencion: 'otro-inexistente' }, 'GET')).liberada === false, 'liberar también anda por GET');
  // Lo que manda navigator.sendBeacon: POST con el JSON como text/plain
  const beacon = await worker.fetch(new Request('https://api.test/?accion=liberarRetencion', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ idRetencion: 'x' }) }), env, ctx);
  check((await beacon.json()).ok === true, 'liberar con el formato de sendBeacon (text/plain)');

  // B ahora sí puede retenerlo
  const retB = await ok('retenerTurno', tXotra);
  check(retB && retB.idRetencion, 'después de liberar, otro celular retiene el mismo cruce');

  // B sale sin liberar (se cerró la app) y vuelve a elegir: su retención no lo bloquea
  const catX = crucesL[0].cat;
  check(!(await ok('partidosDisponibles', { categoria: catX }, 'GET')).some((p) => p.idPartido === X), 'retenido: los demás no ven el cruce');
  check((await ok('partidosDisponibles', { categoria: catX, retencion: retB.idRetencion }, 'GET')).some((p) => p.idPartido === X), 'el celular que lo retiene sí lo sigue viendo');
  check(!(await ok('partidosDisponibles', { categoria: catX, retencion: 'id-inventado' }, 'GET')).some((p) => p.idPartido === X), 'con un id que no es el suyo, no lo ve');
  const retB2 = await api('retenerTurno', { ...tX, reemplazar: retB.idRetencion });
  check(retB2.ok && retB2.data.idRetencion !== retB.idRetencion, 'reemplazar la retención propia del mismo cruce funciona', retB2);
  check(await cuenta('SELECT COUNT(*) AS n FROM retenciones WHERE id = ?', retB.idRetencion) === 0, 'la retención anterior se borró');
  check(await cuenta('SELECT COUNT(*) AS n FROM retenciones WHERE id_partido = ?', X) === 1, 'queda una sola retención para el cruce');
  check(await libresEn(diaL.fecha, otraFr.inicio) === otraFr.disponibles, 'el lugar del horario anterior se liberó');

  // Reemplazar con el id de OTRO cruce no lo borra
  const retY = await ok('retenerTurno', { ...tX, idPartido: Y });
  await ok('liberarRetencion', { idRetencion: retB2.data.idRetencion });
  const retX3 = await api('retenerTurno', { ...tX, reemplazar: retY.idRetencion });
  check(retX3.ok, 'retener X con reemplazar = id de otro cruce igual retiene X', retX3);
  check(await cuenta('SELECT COUNT(*) AS n FROM retenciones WHERE id = ?', retY.idRetencion) === 1, 'la retención del otro cruce NO se borra');
  check(await libresEn(diaL.fecha, frL.inicio) === frL.disponibles - 2, 'X e Y ocupan sus dos lugares');

  // Franja llena: reemplazarse en la misma franja entra (su propio lugar no cuenta),
  // pero pasarse a una franja llena no entra y la retención anterior se conserva.
  const llenos = [];
  const extra = crucesL.slice(2);
  let k = 0;
  while (await libresEn(diaL.fecha, frL.inicio) > 0 && k < extra.length) {
    const r = await api('retenerTurno', { ...tX, idPartido: extra[k++].idPartido });
    if (r.ok) llenos.push(r.data.idRetencion);
  }
  check(await libresEn(diaL.fecha, frL.inicio) === 0, 'franja llena');
  const mismoLugar = await api('retenerTurno', { ...tX, reemplazar: retX3.data && retX3.data.idRetencion });
  check(mismoLugar.ok, 'reemplazarse en la misma franja llena entra', mismoLugar);
  const idX = mismoLugar.ok ? mismoLugar.data.idRetencion : retX3.data.idRetencion;
  const Z = extra[k].idPartido;
  const retZ = await ok('retenerTurno', { ...tXotra, idPartido: Z });
  const zLleno = await api('retenerTurno', { ...tX, idPartido: Z, reemplazar: retZ.idRetencion });
  check(zLleno.error === 'Ese horario ya no tiene lugar disponible.', 'franja llena: mensaje de lugar, no de cruce', zLleno);
  check(await cuenta('SELECT COUNT(*) AS n FROM retenciones WHERE id = ?', retZ.idRetencion) === 1, 'si no entra, la retención anterior se conserva');
  for (const id of [...llenos, retY.idRetencion, retZ.idRetencion]) await ok('liberarRetencion', { idRetencion: id });

  // Flujo normal: retener → confirmar crea exactamente una reserva; liberar después no la toca
  const conf16 = await ok('confirmarReserva', { idRetencion: idX, nombre: 'Lib', telefono: '3517778899', comprobanteBase64: png, comprobanteTipoMime: 'image/png' });
  check(conf16 && conf16.estadoReserva === 'PENDIENTE_APROBACION', 'confirmar después de reemplazar funciona', conf16);
  check(await cuenta('SELECT COUNT(*) AS n FROM reservas WHERE id_partido = ? AND rechazada_ts IS NULL AND cancelada_ts IS NULL', X) === 1, 'exactamente una reserva para el cruce');
  check((await ok('liberarRetencion', { idRetencion: idX })).liberada === false, 'liberar después de confirmar no hace nada');
  check((await ok('consultarReserva', { token: conf16.tokenGestion }, 'GET')).estadoReserva === 'PENDIENTE_APROBACION', 'la reserva sigue intacta');
  const conf16b = await ok('confirmarReserva', { idRetencion: idX, nombre: 'Lib', telefono: '3517778899', comprobanteBase64: png, comprobanteTipoMime: 'image/png' });
  check(conf16b && conf16b.idReserva === conf16.idReserva, 'reintento de confirmar sigue devolviendo la misma reserva');
  check(await cuenta('SELECT COUNT(*) AS n FROM reservas WHERE id_partido = ?', X) === 1, 'sigue habiendo una sola reserva');
  check((await api('retenerTurno', { ...tX, reemplazar: idX })).error === 'Ese cruce ya tiene una reserva en curso. Elegí otro.', 'cruce ya reservado: no se puede volver a retener');
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
