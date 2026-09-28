-- =====================================================================
-- 004: claves ya migradas desde los JSON historicos
--
-- scripts/migrate-json-to-mysql.js registra aqui cada registro que migra
-- (dataset + clave natural). Al volver a ejecutarse:
--   * no duplica (la clave ya esta registrada),
--   * no revive registros que despues se borraron desde la app,
--   * no pisa cambios hechos en la app despues de migrar.
-- =====================================================================

CREATE TABLE IF NOT EXISTS migracion_registros (
  dataset      VARCHAR(40)  NOT NULL,
  clave        VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  origen       VARCHAR(255) NOT NULL COMMENT 'Archivo JSON de origen',
  migrado_en   DATETIME(3)  NOT NULL,
  PRIMARY KEY (dataset, clave)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
