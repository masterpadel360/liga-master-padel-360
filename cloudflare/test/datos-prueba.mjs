// Datos de prueba con la misma forma que manda ExportarACloudflare.gs
// ---------------------------------------------------------------- datos
export const hoy = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
export const masDias = (n) => { const d = new Date(hoy + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const cats = ['6ta Masculino', '7ma Masculino', '7ma Femenino', '8va Masculino', '8va Femenino'];
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
export const pend = partidos.filter((p) => p.estado === 'PENDIENTE');
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
export const datosImport = {
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

