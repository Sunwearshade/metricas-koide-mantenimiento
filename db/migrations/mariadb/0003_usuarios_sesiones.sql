-- =====================================================================
-- 0003_usuarios_sesiones  (MariaDB 10.4.32 - XAMPP)
--
-- Login de la aplicacion (lib/auth.js). No hay registro publico: los
-- usuarios se crean con scripts/crear-admin.js.
--
--   * usuarios.password_hash: scrypt de Node.js con sal aleatoria
--     (formato scrypt$N$r$p$sal$hash). Nunca la contrasena en texto plano.
--   * sesiones.token_sha256: SHA-256 del token de la cookie. El token en
--     claro solo existe en el navegador del usuario.
--   * Fechas en UTC, escritas por la aplicacion.
-- =====================================================================

CREATE TABLE IF NOT EXISTS usuarios (
  id              INT          NOT NULL AUTO_INCREMENT,
  usuario         VARCHAR(60)  NOT NULL,
  nombre          VARCHAR(150) NULL,
  password_hash   VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  rol             ENUM('admin','usuario') NOT NULL DEFAULT 'usuario',
  activo          TINYINT(1)   NOT NULL DEFAULT 1,
  creado          DATETIME(3)  NOT NULL COMMENT 'UTC',
  actualizado     DATETIME(3)  NULL COMMENT 'UTC',
  ultimo_acceso   DATETIME(3)  NULL COMMENT 'UTC',
  PRIMARY KEY (id),
  UNIQUE KEY uq_usuarios_usuario (usuario)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci
  COMMENT='Usuarios de la aplicacion (sin registro publico)';

CREATE TABLE IF NOT EXISTS sesiones (
  token_sha256  CHAR(64)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  usuario_id    INT          NOT NULL,
  creada        DATETIME(3)  NOT NULL COMMENT 'UTC',
  expira        DATETIME(3)  NOT NULL COMMENT 'UTC',
  ip            VARCHAR(45)  NULL,
  PRIMARY KEY (token_sha256),
  KEY idx_sesiones_usuario (usuario_id),
  KEY idx_sesiones_expira (expira),
  CONSTRAINT fk_sesiones_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci
  COMMENT='Sesiones activas del login';
