-- =====================================================================
-- 002: usuarios, roles y sesiones de la aplicacion
--
-- Roles:
--   mantenimiento_admin  acceso completo al dashboard (todo lo que ya existia)
--   mantenimiento_op     solo la pantalla de operador de mantenimiento
--
-- Las contrasenas se guardan con scrypt (lib/auth.js), nunca en claro.
-- Las sesiones guardan solo el SHA-256 del token de la cookie.
-- =====================================================================

CREATE TABLE IF NOT EXISTS usuarios (
  id               INT          NOT NULL AUTO_INCREMENT,
  nombre           VARCHAR(150) NOT NULL,
  username         VARCHAR(60)  COLLATE utf8mb4_bin NOT NULL,
  password_hash    VARCHAR(255) NOT NULL,
  rol              VARCHAR(40)  NOT NULL,
  numero_empleado  VARCHAR(50)  NULL COMMENT 'Numero de empleado del tecnico (mismo que usa koide en repair_started_by / closed_by)',
  activo           TINYINT(1)   NOT NULL DEFAULT 1,
  created_at       DATETIME(3)  NOT NULL,
  updated_at       DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_usuarios_username (username),
  CONSTRAINT chk_usuarios_rol CHECK (rol IN ('mantenimiento_admin', 'mantenimiento_op'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sesiones (
  token_hash   CHAR(64)     NOT NULL COMMENT 'SHA-256 hex del token de la cookie',
  usuario_id   INT          NOT NULL,
  creada       DATETIME(3)  NOT NULL,
  expira       DATETIME(3)  NOT NULL,
  ultimo_uso   DATETIME(3)  NOT NULL,
  ip           VARCHAR(64)  NULL,
  user_agent   VARCHAR(255) NULL,
  PRIMARY KEY (token_hash),
  KEY idx_sesiones_usuario (usuario_id),
  KEY idx_sesiones_expira (expira),
  CONSTRAINT fk_sesiones_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
