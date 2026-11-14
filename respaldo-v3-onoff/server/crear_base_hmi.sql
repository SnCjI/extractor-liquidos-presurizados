-- crear_base_hmi.sql — Base de datos del HMI del extractor de líquidos presurizados (H2O, 2 zonas)
-- Úsalo en MySQL Workbench: File → Open SQL Script… → este archivo → botón del rayo ⚡
-- (crear-base-de-datos.bat hace lo mismo automáticamente y además copia datos viejos.)

CREATE DATABASE IF NOT EXISTS hmi_extractor
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE hmi_extractor;

-- Lecturas que manda el ESP32 (cada 2 s)
CREATE TABLE IF NOT EXISTS readings (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ts          BIGINT NOT NULL,          -- momento de llegada (milisegundos)
  device_ts   BIGINT NULL,              -- millis() del ESP32
  device_id   VARCHAR(64) NOT NULL,
  temperature DOUBLE NULL,              -- columnas de la versión anterior (se conservan)
  pressure    DOUBLE NULL,
  humidity    DOUBLE NULL,
  t_z1        DOUBLE NULL,              -- °C zona 1 (superior)
  t_z2        DOUBLE NULL,              -- °C zona 2 (inferior)
  t_z3        DOUBLE NULL,              -- (no se usa: era la zona 3 de la versión anterior)
  ssr1        TINYINT NULL,             -- 1 = resistencia 1 encendida
  ssr2        TINYINT NULL,
  ssr3        TINYINT NULL,             -- (no se usa)
  presion     DOUBLE NULL,              -- bar (opcional, sin sensor por ahora)
  sistema_on  TINYINT NULL,             -- 1 = el ESP32 está controlando
  alarma      VARCHAR(160) NULL,
  INDEX idx_readings_ts (ts)
) ENGINE=InnoDB;

-- Bitácora: quién usó el equipo, cuándo y qué hizo (incluye los AJUSTES del HMI)
CREATE TABLE IF NOT EXISTS operator_log (
  id        INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ts        BIGINT NOT NULL,
  fecha     VARCHAR(10) NOT NULL,
  hora      VARCHAR(8)  NOT NULL,
  operador  VARCHAR(100) NOT NULL,
  nota      TEXT NULL,
  INDEX idx_operator_log_fecha (fecha)
) ENGINE=InnoDB;

-- Valores de ajuste que el ESP32 obedece (una sola fila)
CREATE TABLE IF NOT EXISTS setpoints (
  id               TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  sp_z1            DOUBLE NOT NULL,
  sp_z2            DOUBLE NOT NULL,
  sp_z3            DOUBLE NOT NULL,   -- (no se usa)
  sistema_on       TINYINT NOT NULL,
  actualizado_ts   BIGINT NOT NULL,
  actualizado_por  VARCHAR(100) NULL
) ENGINE=InnoDB;
INSERT IGNORE INTO setpoints VALUES (1, 60, 60, 60, 0, UNIX_TIMESTAMP()*1000, 'sistema');

-- Consultas útiles:
--   SELECT * FROM readings ORDER BY ts DESC LIMIT 50;
--   SELECT fecha, hora, operador, nota FROM operator_log ORDER BY ts DESC;
--   SELECT * FROM setpoints;
SHOW TABLES;
