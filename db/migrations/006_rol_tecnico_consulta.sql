-- =====================================================================
-- 006: rol de SOLO LECTURA `tecnico_consulta` y enlace de contramedidas
--      con KOIDE MES (contramedidas por acumulacion de fallas)
--
-- Roles (lib/auth.js):
--   mantenimiento_admin  administra y, con numero de empleado, atiende paros
--   mantenimiento_op     atiende paros (usuario + PIN)
--   tecnico_consulta     SOLO consulta: desempeno de tecnicos, tiempo muerto,
--                        MTTR / MTBF e historico de paros. Entra con
--                        contrasena. No acepta, no toma continuidad, no
--                        finaliza, no modifica formularios ni evidencias, no
--                        gestiona operadores/usuarios, agenda, configuracion
--                        ni contramedidas. El backend lo rechaza (403), no
--                        solo la interfaz.
--
-- contramedidas.mes_id            id de la contramedida en KOIDE MES
--                                 (mtto_contramedidas), cuando se registro a
--                                 partir de una recomendacion por acumulacion
-- contramedidas.recomendacion_clave  "EQUIPO|categoria" de la recomendacion
--                                 que la origino (trazabilidad)
--
-- Compatible con MySQL 8.0.16+ y MariaDB 10.4+. Reversible: bloque al final.
-- =====================================================================

ALTER TABLE usuarios DROP CONSTRAINT chk_usuarios_rol;
ALTER TABLE usuarios ADD CONSTRAINT chk_usuarios_rol CHECK (rol IN ('mantenimiento_admin', 'mantenimiento_op', 'tecnico_consulta'));

ALTER TABLE contramedidas
  ADD COLUMN IF NOT EXISTS mes_id INT NULL COMMENT 'mtto_contramedidas.id en KOIDE MES' AFTER trabajo_realizado,
  ADD COLUMN IF NOT EXISTS recomendacion_clave VARCHAR(120) NULL COMMENT 'EQUIPO|categoria de la recomendacion por acumulacion' AFTER mes_id;

-- ROLLBACK (manual):
-- ALTER TABLE contramedidas DROP COLUMN IF EXISTS recomendacion_clave, DROP COLUMN IF EXISTS mes_id;
-- UPDATE usuarios SET activo = 0 WHERE rol = 'tecnico_consulta';   -- (no se borran cuentas)
-- ALTER TABLE usuarios DROP CONSTRAINT chk_usuarios_rol;
-- ALTER TABLE usuarios ADD CONSTRAINT chk_usuarios_rol CHECK (rol IN ('mantenimiento_admin', 'mantenimiento_op'));
