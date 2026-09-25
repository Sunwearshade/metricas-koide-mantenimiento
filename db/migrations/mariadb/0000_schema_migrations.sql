-- =====================================================================
-- 0000_schema_migrations  (MariaDB 10.4.32 - XAMPP)
--
-- Control de versiones del esquema. La crea scripts/db-migrate.js antes de
-- aplicar cualquier otra migracion. Cada migracion aplicada queda registrada
-- con su checksum SHA-256: si alguien edita una migracion ya aplicada, el
-- ejecutor lo detecta y se detiene. Nunca editar una migracion aplicada:
-- los cambios van en un archivo nuevo NNNN_descripcion.sql.
-- =====================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version          VARCHAR(20)  COLLATE utf8mb4_bin NOT NULL,
  nombre           VARCHAR(255) NOT NULL,
  checksum_sha256  CHAR(64)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  aplicada         DATETIME(3)  NOT NULL COMMENT 'UTC, la escribe el ejecutor',
  duracion_ms      INT          NULL,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci
  COMMENT='Control de versiones del esquema. Nunca editar una migracion ya aplicada.';
