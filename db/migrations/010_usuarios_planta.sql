-- =====================================================================
-- 010: cuentas de administrador de mantenimiento de planta
--
-- Deja las mismas cuentas (y contrasenas) en produccion y en desarrollo:
--   - jonathan     (mantenimiento_admin)
--   - carlos.mant  (mantenimiento_admin)
--
-- password_hash es scrypt generado por auth.hashPassword (nunca texto plano).
-- Si la cuenta ya existe, se actualizan nombre, contrasena, rol y estado
-- para que coincida con este archivo; no se tocan sesiones ni numero de
-- empleado (los administradores no llevan numero).
-- Las cuentas de desarrollo (admin / operador) siguen en scripts/seed-dev.js.
-- =====================================================================

INSERT INTO usuarios (nombre, username, password_hash, rol, numero_empleado, activo, created_at, updated_at) VALUES
  ('Jonathan', 'jonathan', 'scrypt$16384$8$1$uFNAH24JThq02wz6vB8OWg==$EicaHDGu52N9+w5Z/FBqhoEeLRjbVhzG5K0rUNyx/fIKlOAd9z69CcWipESPRD8L46sOTaUNQnetJaQ5W/SwmA==', 'mantenimiento_admin', NULL, 1, '2026-09-28 22:28:59.206', NOW(3)),
  ('Carlos', 'carlos.mant', 'scrypt$16384$8$1$oYuDIatn8UADDA0hbTeE4Q==$A7tZ3IQ3mPY8tLSUVj26gAfJAFv1mQN2TBu1MSegJ+0tY9BVPgXEc2YGfPVk/76kdLZMCOUQCAaTQlsQlqipUA==', 'mantenimiento_admin', NULL, 1, '2026-10-08 14:12:17.395', NOW(3))
ON DUPLICATE KEY UPDATE
  -- updated_at va primero: MariaDB evalua las asignaciones en orden.
  updated_at = IF(password_hash <=> VALUES(password_hash) AND rol <=> VALUES(rol) AND activo <=> VALUES(activo), updated_at, NOW(3)),
  nombre = VALUES(nombre),
  password_hash = VALUES(password_hash),
  rol = VALUES(rol),
  activo = VALUES(activo);

-- ROLLBACK (manual):
-- DELETE FROM usuarios WHERE username IN ('jonathan', 'carlos.mant');
