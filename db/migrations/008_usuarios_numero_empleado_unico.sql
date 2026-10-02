-- =====================================================================
-- 008: numero de empleado UNICO por cuenta (usuarios.numero_empleado)
--
-- Contrato existente (auth.createUser / setNumeroEmpleado): un numero de
-- empleado identifica a UNA persona del catalogo de personal de mantenimiento
-- de KOIDE MES (mtto_personal) y solo UNA cuenta de este sistema actua con el.
-- Hasta ahora solo lo garantizaba la aplicacion (lectura + insercion, sin
-- bloqueo): dos altas simultaneas podian repetir el numero. El indice lo deja
-- garantizado por la base.
--
--   - NULL no cuenta (varias cuentas sin numero: administradores que no
--     atienden paros y usuarios de consulta).
--   - Una cadena vacia o solo espacios se normaliza a NULL (misma semantica
--     que la aplicacion: "sin numero") para que no choque en el indice.
--   - La cuenta sigue guardando SOLO el numero: nombre y estado del empleado
--     viven en KOIDE MES (no hay copia del catalogo aqui).
--
-- No borra filas. Si hubiera numeros repetidos (solo posible editando la base
-- a mano) el ALTER falla y no se aplica: resolverlos antes con
--   SELECT numero_empleado, GROUP_CONCAT(username) FROM usuarios
--   WHERE numero_empleado IS NOT NULL GROUP BY numero_empleado HAVING COUNT(*) > 1;
-- MariaDB 10.4+ (IF NOT EXISTS en el indice).
-- =====================================================================

UPDATE usuarios SET numero_empleado = NULL WHERE numero_empleado IS NOT NULL AND TRIM(numero_empleado) = '';

ALTER TABLE usuarios ADD UNIQUE KEY IF NOT EXISTS uq_usuarios_numero_empleado (numero_empleado);

-- ROLLBACK (manual):
-- ALTER TABLE usuarios DROP INDEX uq_usuarios_numero_empleado;
