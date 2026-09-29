-- =====================================================================
-- 005: acceso operativo de los operadores de mantenimiento (usuario + PIN)
--
-- Los operadores (rol mantenimiento_op) se autentican con usuario + PIN de 4
-- digitos. El PIN se guarda como el resto de secretos: hash scrypt en
-- password_hash (nunca en texto plano). Un PIN corto exige limite de intentos
-- POR CUENTA y persistente (el de memoria por usuario+IP se pierde al
-- reiniciar y no frena intentos desde varias IP):
--
--   intentos_fallidos  fallos consecutivos (se reinicia al entrar bien o
--                      cuando el administrador restablece el PIN)
--   bloqueado_hasta    bloqueo temporal tras 5 fallos
--   bloqueo_admin      bloqueo DEFINITIVO tras 10 fallos: solo el
--                      administrador lo libera (restableciendo el PIN)
--   pin_actualizado    ultimo cambio de PIN (auditoria)
-- =====================================================================

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS intentos_fallidos INT         NOT NULL DEFAULT 0 AFTER activo,
  ADD COLUMN IF NOT EXISTS bloqueado_hasta   DATETIME(3) NULL AFTER intentos_fallidos,
  ADD COLUMN IF NOT EXISTS bloqueo_admin     TINYINT(1)  NOT NULL DEFAULT 0 AFTER bloqueado_hasta,
  ADD COLUMN IF NOT EXISTS pin_actualizado   DATETIME(3) NULL AFTER bloqueo_admin;
