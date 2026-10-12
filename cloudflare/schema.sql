-- =====================================================================
-- LIGA MASTER PÁDEL 360 — Base de datos D1 (liga-360-db)
-- =====================================================================
-- Se puede correr más de una vez sin romper nada (IF NOT EXISTS).
-- Reemplaza a las hojas CATEGORIAS, PAREJAS, PARTIDOS, RESERVAS,
-- RETENCIONES y BLOQUEOS de la planilla de Google.

CREATE TABLE IF NOT EXISTS categorias (
  nombre          TEXT PRIMARY KEY,
  orden           INTEGER NOT NULL DEFAULT 0,
  fecha_en_juego  INTEGER            -- "FECHA EN JUEGO" (col. B de CATEGORIAS). NULL = no se puede reservar.
);

CREATE TABLE IF NOT EXISTS parejas (
  id         TEXT PRIMARY KEY,       -- P001, P002...
  categoria  TEXT NOT NULL,
  jugador1   TEXT NOT NULL,
  jugador2   TEXT NOT NULL DEFAULT '',
  estado     TEXT NOT NULL DEFAULT 'ACTIVA'   -- ACTIVA | BAJA
);
CREATE INDEX IF NOT EXISTS idx_parejas_cat ON parejas(categoria, estado);

CREATE TABLE IF NOT EXISTS partidos (
  id           TEXT PRIMARY KEY,     -- PT0001...
  categoria    TEXT NOT NULL,
  fecha        INTEGER NOT NULL,     -- número de fecha (ronda) del fixture
  pareja_a_id  TEXT NOT NULL,
  pareja_b_id  TEXT NOT NULL,
  pareja_a_txt TEXT NOT NULL DEFAULT '',   -- nombre de respaldo (por si la pareja ya no existe)
  pareja_b_txt TEXT NOT NULL DEFAULT '',
  set1         TEXT NOT NULL DEFAULT '',
  set2         TEXT NOT NULL DEFAULT '',
  set3         TEXT NOT NULL DEFAULT '',
  ganador_id   TEXT NOT NULL DEFAULT '',
  estado       TEXT NOT NULL DEFAULT 'PENDIENTE'  -- PENDIENTE | JUGADO
);
CREATE INDEX IF NOT EXISTS idx_partidos_cat ON partidos(categoria, fecha);

CREATE TABLE IF NOT EXISTS reservas (
  id                   TEXT PRIMARY KEY,   -- R0001...
  token                TEXT NOT NULL UNIQUE,
  codigo               TEXT NOT NULL UNIQUE,
  fecha                TEXT NOT NULL,      -- 'YYYY-MM-DD'
  hora_inicio          TEXT NOT NULL,      -- 'HH:MM'
  hora_fin             TEXT NOT NULL,
  cancha               INTEGER NOT NULL,
  categoria            TEXT NOT NULL,
  id_partido           TEXT NOT NULL,
  id_pareja_a          TEXT NOT NULL DEFAULT '',
  pareja_a             TEXT NOT NULL DEFAULT '',
  id_pareja_b          TEXT NOT NULL DEFAULT '',
  pareja_b             TEXT NOT NULL DEFAULT '',
  nombre               TEXT NOT NULL DEFAULT '',
  telefono             TEXT NOT NULL DEFAULT '',
  valor_total          INTEGER NOT NULL DEFAULT 0,
  monto_pagado         INTEGER NOT NULL DEFAULT 0,
  estado_pago          TEXT NOT NULL DEFAULT 'SALDO_PENDIENTE',
  comprobante_id       TEXT,               -- comprobante guardado en la tabla comprobantes
  comprobante_url      TEXT,               -- reservas viejas: link de Google Drive
  creada_ts            INTEGER NOT NULL,   -- milisegundos epoch
  aprobada_ts          INTEGER,
  rechazada_ts         INTEGER,
  cancelada_ts         INTEGER,
  id_retencion_origen  TEXT UNIQUE         -- idempotencia de confirmarReserva
);
CREATE INDEX IF NOT EXISTS idx_reservas_fecha ON reservas(fecha, hora_inicio);
CREATE INDEX IF NOT EXISTS idx_reservas_partido ON reservas(id_partido);

CREATE TABLE IF NOT EXISTS retenciones (
  id           TEXT PRIMARY KEY,
  fecha        TEXT NOT NULL,
  hora_inicio  TEXT NOT NULL,
  hora_fin     TEXT NOT NULL,
  id_partido   TEXT NOT NULL,
  creada_ts    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retenciones_fecha ON retenciones(fecha);

CREATE TABLE IF NOT EXISTS bloqueos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha        TEXT NOT NULL,
  hora_inicio  TEXT NOT NULL,
  hora_fin     TEXT NOT NULL,
  cancha       TEXT NOT NULL DEFAULT 'TODAS',   -- '1' | '2' | '3' | 'TODAS'
  motivo       TEXT NOT NULL DEFAULT '',
  creado_ts    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bloqueos_fecha ON bloqueos(fecha);

CREATE TABLE IF NOT EXISTS comprobantes (
  id         TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  nombre     TEXT NOT NULL DEFAULT '',
  datos      BLOB NOT NULL,
  creado_ts  INTEGER NOT NULL
);

-- Copia en caché del contenido que todavía vive en la planilla
-- (galería, sponsors, novedades, premios). La sirve el Worker al instante
-- y la refresca en segundo plano.
CREATE TABLE IF NOT EXISTS cache_contenido (
  clave  TEXT PRIMARY KEY,
  json   TEXT NOT NULL,
  ts     INTEGER NOT NULL
);
