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

// ---------------------------------------------------------------- datos
const hoy = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const masDias = (n) => { const d = new Date(hoy + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const cats = ['6ta Masculino', '7ma Masculino', '7ma Femenino', '8va Masculino', '8va Femenino'];
const parejas = [];
let np = 0;
cats.forEach((cat, ci) => { for (let i = 0; i < (ci === 2 ? 5 : 6); i++) { np++; parejas.push({ id: 'P' + String(np).padStart(3, '0'), categoria: cat, jugador1: 'Jug' + np + 'a', jugador2: np % 7 === 0 ? 'A CONFIRMAR' : 'Jug' + np + 'b', estado: 'ACTIVA' }); } });
parejas.push({ id: 'P099', categoria: '7ma Femenino', jugador1: 'Baja1', jugador2: 'Baja2', estado: 'BAJA' });
const etiqueta = (p) => p.id + ' · ' + p.jugador1 + ' / ' + p.jugador2;
const partidos = [];
let npt = 90;
cats.forEach((cat) => {
  const ps = parejas.filter((p) => p.categoria === cat && p.estado === 'ACTIVA');
  const lista = ps.slice(); if (lista.length % 2) lista.push(null);
  const n = lista.length, arr = lista.slice();
  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i], b = arr[n - 1 - i];
      if (!a || !b) continue;
      npt++;
      const jugado = r < 2;
      partidos.push({ id: 'PT' + String(npt).padStart(4, '0'), categoria: cat, fecha: r + 1, parejaA: etiqueta(a), parejaB: etiqueta(b),
        set1: jugado ? '6-4' : '', set2: jugado ? (i % 2 ? '3-6' : '6-2') : '', set3: jugado && i % 2 ? '10-8' : '',
        ganador: jugado ? etiqueta(a) : '', estado: jugado ? 'JUGADO' : 'PENDIENTE' });
    }
    const ult = arr[n - 1]; for (let j = n - 1; j > 1; j--) arr[j] = arr[j - 1]; arr[1] = ult;
  }
});
const pend = partidos.filter((p) => p.estado === 'PENDIENTE');
const res = (id, extra) => ({ id, token: 'tok-' + id, codigo: 'COD' + id, fecha: masDias(-20), horaInicio: '19:30', horaFin: '21:00', cancha: 1,
  categoria: '8va Femenino', idPartido: 'PT0001', idParejaA: 'P001', parejaA: 'A / B', idParejaB: 'P002', parejaB: 'C / D', nombre: 'Lorena', telefono: '3513517178',
  valorTotal: 36000, montoPagado: 9000, estadoPago: 'SALDO_PENDIENTE', comprobanteUrl: 'https://drive.google.com/file/d/abc/view', creadaTs: Date.now() - 30 * 864e5,
  aprobadaTs: Date.now() - 29 * 864e5, rechazadaTs: '', canceladaTs: '', idRetencionOrigen: 'ret-' + id, ...extra });
const reservas = [
  res('R0001', { montoPagado: 36000, estadoPago: 'PAGO_COMPLETO' }),
  res('R0002', { rechazadaTs: Date.now() - 28 * 864e5, idPartido: pend[0].id, categoria: pend[0].categoria, fecha: masDias(1), horaInicio: '21:00', horaFin: '22:30' }),
  res('R0003', { idPartido: pend[1].id, categoria: pend[1].categoria, fecha: masDias(1), horaInicio: '21:00', horaFin: '22:30', cancha: 1, telefono: '351-555-1234', codigo: 'ABCD2345' }),
  res('R0004', { aprobadaTs: '', idPartido: pend[2].id, categoria: pend[2].categoria, fecha: masDias(1), horaInicio: '21:00', horaFin: '22:30', cancha: 2, comprobanteUrl: '' }),
];
const datosImport = {
  categorias: cats.map((c, i) => ({ nombre: c, orden: i + 1, fechaEnJuego: 4 })),
  parejas, partidos, reservas,
  bloqueos: [{ id: 'CLASE-1', fecha: masDias(2), horaInicio: '18:00', horaFin: '19:30', cancha: '1', motivo: 'Clase Gabriel', creadoTs: Date.now() }],
  contenido: [
    { tipo: 'NOVEDAD', titulo: '¡Bienvenidos!', texto: 'Consultá el fixture', orden: 1, activo: 'SI' },
    { tipo: 'PREMIOS', titulo: 'Campeones', texto: 'Trofeo + paleta', orden: 1, activo: 'SI' },
    { tipo: 'REGLAMENTO', titulo: 'Objetivos', texto: '...', orden: 1, activo: 'SI' },
    { tipo: 'NOVEDAD', titulo: 'Inactiva', texto: 'no se ve', orden: 2, activo: '' },
  ],
  sponsors: [{ nombre: 'EJEMPLO', logoUrl: '', link: '', orden: 99, activo: 'NO' }, { nombre: 'Club X', logoUrl: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing', link: 'https://x.com', orden: 1, activo: 'SI' }],
  galeria: [{ categoria: 'Fecha 4', titulo: 'ejemplo', url: '', activo: 'NO' }],
  playoffsMensaje: 'Los playoffs arrancan en diciembre.',
};

// ---------------------------------------------------------------- pruebas
console.log('1) Acceso de organizador e importación');
check((await api('adminResumen', { tokenAdmin: 'x.y' })).ok === false, 'adminResumen sin sesión debe fallar');
check((await api('adminLogin', { clave: 'mal' })).ok === false, 'login con clave mala debe fallar');
const { tokenAdmin } = await ok('adminLogin', { clave: 'clave-orga' });
const A = (d = {}) => ({ tokenAdmin, ...d });
const imp = await ok('importar', A({ datos: datosImport }));
check(imp && imp.parejas === parejas.length && imp.reservas === 4 && imp.sponsors === 1, 'importación cuenta filas', imp);
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

console.log('9) Protección al re-importar');
const reimp = await api('importar', A({ datos: datosImport }));
check(reimp.ok === false && reimp.error.includes('no están en la planilla'), 'no pisa reservas nuevas', reimp.error);

await Promise.all(pendientesWaitUntil);
console.log('\nResultado: ' + oks + ' OK, ' + fallas + ' con problemas');
process.exit(fallas ? 1 : 0);
