# Publicar la liga en Cloudflare (paso a paso)

Todo se hace desde el navegador, sin instalar nada. Mientras no se haga el
último paso (cambiar `BACKEND_URL` en la app), la gente sigue usando la app
vieja con la planilla, así que se puede hacer con calma.

## 1. Subir el servidor (Worker)
1. Abrí https://raw.githubusercontent.com/masterpadel360/liga-master-padel-360/migracion-cloudflare/cloudflare/worker.js
   → Ctrl+A → Ctrl+C (copiar todo).
2. Cloudflare → **Workers & Pages** → **liga-360-api** → botón **Edit code**.
3. Borrá todo lo que haya en el editor, pegá (Ctrl+V) y tocá **Deploy**.

## 2. Conectar la base de datos
En **liga-360-api** → **Settings** → **Bindings**: tiene que haber una
**D1 database** con *Variable name* = `DB` apuntando a `liga-360-db`.
Si existe con otro nombre, editala y poné `DB`. Si no existe: **Add** →
D1 database → Variable name `DB` → `liga-360-db` → Deploy.

## 3. Contraseñas
**Settings** → **Variables and Secrets** → **Add** (tipo *Secret*):
| Nombre | Valor |
|---|---|
| `CLAVE_ACCESO_LIGA` | la contraseña de la liga que ya usan los jugadores (la misma de hoy) |
| `CLAVE_ADMIN` | tu contraseña de organizador (la que quieras) |
| `ACCESO_LIGA_VERSION` | `v1` (o el valor que tenías en Apps Script, si lo cambiaste alguna vez) |

Con la misma contraseña y versión, los jugadores que ya entraron no tienen
que volver a escribirla.

## 4. Crear las tablas
1. Cloudflare → **Storage & Databases** → **D1** → **liga-360-db** → **Console**.
2. Primero mirá si ya hay tablas: `SELECT name FROM sqlite_master WHERE type='table';`
   - Si aparecen tablas de una prueba anterior (la base todavía no se usa
     en producción), borralas con `DROP TABLE nombre;` una por una.
3. Abrí https://raw.githubusercontent.com/masterpadel360/liga-master-padel-360/migracion-cloudflare/cloudflare/schema.sql,
   copiá todo, pegalo en la consola y **Execute**.

## 5. Pasar los datos de la planilla
1. Abrí la planilla **Organizacion LIGA OFICIAL** → **Extensiones** → **Apps Script**.
2. Al lado de "Archivos", **+** → **Secuencia de comandos** → nombre `ExportarACloudflare`.
3. Pegá el contenido de
   https://raw.githubusercontent.com/masterpadel360/liga-master-padel-360/migracion-cloudflare/cloudflare/ExportarACloudflare.gs
4. Arriba de todo completá `EXP360_URL_WORKER` (la dirección de tu Worker,
   por ejemplo `https://liga-360-api.tu-usuario.workers.dev`) y
   `EXP360_CLAVE_ORGANIZADOR` (la `CLAVE_ADMIN` del paso 3). Guardá (Ctrl+S).
5. Elegí la función **exportarACloudflare** → **Ejecutar** → aceptá los permisos.
6. En el registro tiene que decir **LISTO ✅** con la cantidad de reservas,
   partidos y parejas.

## 6. Cambiar la app al servidor nuevo
Se completa `BACKEND_URL` en `app.js` con la dirección del Worker y se
publica en GitHub. En 1-2 minutos todos los celulares pasan a usar
Cloudflare. Conviene hacerlo en un momento sin reservas (por ejemplo de
noche) y correr el paso 5 justo antes, para que se lleve hasta la última
reserva de la planilla.

**Volver atrás:** dejar `BACKEND_URL = ''` y publicar. La app vuelve a usar
la planilla como antes.

## Pruebas locales (para programadores)
- API: `node --no-warnings cloudflare/test/prueba.mjs`
- App + API en http://localhost:8787: `node --no-warnings cloudflare/test/servidor-local.mjs`
  (contraseña liga `padel360`, organizador `clave-orga`)
- Recorrido automático en navegador: `python3 cloudflare/test/navegador.py capturas/`
