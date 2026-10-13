// Servidor local: la app (archivos estáticos) + el Worker en /api/ con base en memoria.
//   node --no-warnings cloudflare/test/servidor-local.mjs  →  http://localhost:8787
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker.js';
import { crearD1 } from './d1-local.mjs';
import { datosImport } from './datos-prueba.mjs';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.join(aqui, '..', '..');
const PUERTO = Number(process.env.PUERTO || 8787);
const env = { DB: crearD1(path.join(aqui, '..', 'schema.sql')), CLAVE_ACCESO_LIGA: 'padel360', CLAVE_ADMIN: 'clave-orga' };
const ctx = { waitUntil() {} };
const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf' };

async function llamarWorker(req, cuerpo) {
  const url = 'http://localhost:' + PUERTO + req.url;
  const r = await worker.fetch(new Request(url, { method: req.method, body: req.method === 'POST' ? cuerpo : undefined }), env, ctx);
  return r;
}
// Carga inicial de datos (como la importación desde la planilla)
const login = await (await llamarWorker({ url: '/api/?accion=adminLogin', method: 'POST' }, JSON.stringify({ clave: 'clave-orga' }))).json();
await llamarWorker({ url: '/api/?accion=importar', method: 'POST' }, JSON.stringify({ tokenAdmin: login.data.tokenAdmin, datos: datosImport }));

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    let cuerpo = '';
    req.on('data', (c) => (cuerpo += c));
    req.on('end', async () => {
      const r = await llamarWorker(req, cuerpo);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    });
    return;
  }
  let archivo = path.join(raiz, decodeURIComponent(req.url.split('?')[0]));
  if (archivo.endsWith(path.sep)) archivo = path.join(archivo, 'index.html');
  if (!existsSync(archivo)) { res.writeHead(404); res.end('no'); return; }
  let datos = readFileSync(archivo);
  if (archivo.endsWith('app.js')) datos = Buffer.from(datos.toString('utf8').replace(/var BACKEND_URL = '[^']*';/,"var BACKEND_URL = 'http://localhost:" + PUERTO + "/api/';"));
  res.writeHead(200, { 'Content-Type': tipos[path.extname(archivo)] || 'application/octet-stream' });
  res.end(datos);
}).listen(PUERTO, () => console.log('App local en http://localhost:' + PUERTO));
