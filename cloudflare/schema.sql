-- =====================================================================
-- LIGA MASTER PÁDEL 360 — Base de datos D1 (liga-360-db)
-- =====================================================================
-- Reemplaza por completo a la planilla "Organizacion LIGA OFICIAL".
-- Se puede correr más de una vez sin romper nada (IF NOT EXISTS / OR IGNORE).

-- ---------------------------------------------------------------------
-- Deportivo
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categorias (
  nombre          TEXT PRIMARY KEY,
  orden           INTEGER NOT NULL DEFAULT 0,
  fecha_en_juego  INTEGER            -- fechas habilitadas para reservar (hasta esta). NULL = ninguna.
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
  pareja_a_txt TEXT NOT NULL DEFAULT '',   -- nombre de respaldo
  pareja_b_txt TEXT NOT NULL DEFAULT '',
  set1         TEXT NOT NULL DEFAULT '',
  set2         TEXT NOT NULL DEFAULT '',
  set3         TEXT NOT NULL DEFAULT '',
  ganador_id   TEXT NOT NULL DEFAULT '',
  estado       TEXT NOT NULL DEFAULT 'PENDIENTE'  -- PENDIENTE | JUGADO
);
CREATE INDEX IF NOT EXISTS idx_partidos_cat ON partidos(categoria, fecha);

-- ---------------------------------------------------------------------
-- Reservas de cancha
-- ---------------------------------------------------------------------
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
  estado_pago          TEXT NOT NULL DEFAULT 'SALDO_PENDIENTE',  -- SALDO_PENDIENTE | PAGO_COMPLETO
  comprobante_id       TEXT,               -- archivo guardado en la tabla archivos
  comprobante_url      TEXT,               -- reservas viejas: link de Google Drive
  creada_ts            INTEGER NOT NULL,   -- milisegundos epoch
  aprobada_ts          INTEGER,
  rechazada_ts         INTEGER,
  cancelada_ts         INTEGER,
  id_retencion_origen  TEXT UNIQUE         -- idempotencia de confirmarReserva
);
CREATE INDEX IF NOT EXISTS idx_reservas_fecha ON reservas(fecha, hora_inicio);
CREATE INDEX IF NOT EXISTS idx_reservas_partido ON reservas(id_partido);

-- Lugar "apartado" por 10 minutos mientras el jugador sube el comprobante.
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
  id           TEXT PRIMARY KEY,
  fecha        TEXT NOT NULL,
  hora_inicio  TEXT NOT NULL,
  hora_fin     TEXT NOT NULL,
  cancha       TEXT NOT NULL DEFAULT 'TODAS',   -- '1' | '2' | '3' | 'TODAS'
  motivo       TEXT NOT NULL DEFAULT '',
  creado_ts    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bloqueos_fecha ON bloqueos(fecha);

-- Grilla semanal de turnos ofrecidos para la liga (editable desde el panel).
-- dia: 0=domingo ... 6=sábado
CREATE TABLE IF NOT EXISTS grilla (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  dia      INTEGER NOT NULL,
  inicio   TEXT NOT NULL,
  fin      TEXT NOT NULL,
  canchas  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grilla_dia ON grilla(dia);

-- ---------------------------------------------------------------------
-- Contenido de la app
-- ---------------------------------------------------------------------
-- tipo: NOVEDAD | PREMIO | REGLAMENTO | BANNER (y cualquier otro que venga de la planilla)
CREATE TABLE IF NOT EXISTS contenido (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo    TEXT NOT NULL,
  titulo  TEXT NOT NULL DEFAULT '',
  texto   TEXT NOT NULL DEFAULT '',
  imagen  TEXT NOT NULL DEFAULT '',
  link    TEXT NOT NULL DEFAULT '',
  orden   INTEGER NOT NULL DEFAULT 0,
  activo  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sponsors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre     TEXT NOT NULL,
  logo_url   TEXT NOT NULL DEFAULT '',
  link       TEXT NOT NULL DEFAULT '',
  orden      INTEGER NOT NULL DEFAULT 0,
  destacado  INTEGER NOT NULL DEFAULT 0,
  activo     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS fotos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  categoria  TEXT NOT NULL DEFAULT '',   -- etiqueta libre: "Fecha 4", "Final", etc.
  titulo     TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL,
  orden      INTEGER NOT NULL DEFAULT 0,
  creado_ts  INTEGER NOT NULL
);

-- Archivos subidos: comprobantes (privados) y fotos/logos (públicos).
CREATE TABLE IF NOT EXISTS archivos (
  id         TEXT PRIMARY KEY,
  tipo       TEXT NOT NULL,      -- comprobante | publico
  mime       TEXT NOT NULL,
  nombre     TEXT NOT NULL DEFAULT '',
  datos      BLOB NOT NULL,
  creado_ts  INTEGER NOT NULL
);

-- Ajustes generales (precio del turno, seña, alias, etc.).
CREATE TABLE IF NOT EXISTS config (
  clave  TEXT PRIMARY KEY,
  valor  TEXT NOT NULL
);

INSERT OR IGNORE INTO config (clave, valor) VALUES
  ('valor_turno', '36000'),
  ('monto_sena', '9000'),
  ('alias', 'masterpadel.360'),
  ('ventana_dias', '14'),
  ('retencion_minutos', '10'),
  ('cantidad_canchas', '3'),
  ('fecha_inicio_liga', '2026-09-14'),
  ('playoffs_mensaje', '');

-- Grilla inicial = la que estaba en CodigoReservasAPI.gs (solo si la tabla está vacía).
INSERT INTO grilla (dia, inicio, fin, canchas)
SELECT column1, column2, column3, column4 FROM (VALUES
  (1,'18:00','19:30',2),(1,'19:30','21:00',2),(1,'21:00','22:30',3),
  (2,'10:30','12:00',2),(2,'18:00','19:30',2),(2,'19:30','21:00',2),(2,'21:00','22:30',3),
  (3,'18:00','19:30',2),(3,'19:30','21:00',2),(3,'21:00','22:30',3),
  (4,'10:30','12:00',3),(4,'18:00','19:30',2),(4,'19:30','21:00',2),(4,'21:00','22:30',3),
  (5,'18:00','19:30',2),(5,'19:30','21:00',2),(5,'21:00','22:30',3),
  (6,'09:30','11:00',3),(6,'11:00','12:30',3)
) WHERE NOT EXISTS (SELECT 1 FROM grilla);
