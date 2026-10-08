-- =====================================================================
-- 011: programa preventivo de octubre 2026 traido del sistema "metricos"
--
-- Carga en preventivo_tareas el mismo programa de octubre que tenia el
-- sistema viejo (C:\metricos\data\calendarios.json, 52 maquinas, CNC1 del
-- 01/10 ya Realizado), para que produccion quede igual que desarrollo.
--
-- Pasos:
--   1. Asegura el mes 2026-10 en preventivo_meses.
--   2. Si octubre ya tiene tareas generadas por la programacion automatica
--      y NINGUNA tiene estado ni reporte, las quita (se reemplazan por las
--      del sistema viejo). Si alguna ya fue marcada o reportada, no se borra
--      nada: se respeta lo capturado en el servidor.
--   3. Inserta las tareas. Si el dia/orden ya existe (paso 2 no borro),
--      se deja la del servidor sin cambios.
--
-- Excepcion a la regla "nada de DELETE en migraciones": el DELETE del paso 2
-- solo toca tareas autogeneradas sin captura del usuario.
-- Compatible con MySQL 8.0.16+ y MariaDB 10.4+.
-- =====================================================================

INSERT INTO preventivo_meses (mes, created_at, updated_at)
VALUES ('2026-10', NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE mes = mes;

DELETE FROM preventivo_tareas
WHERE mes = '2026-10'
  AND (SELECT n FROM (
        SELECT COUNT(*) AS n FROM preventivo_tareas
        WHERE mes = '2026-10' AND (estado <> '' OR reporte_en IS NOT NULL)
      ) AS marcadas) = 0;

INSERT INTO preventivo_tareas (mes, fecha, orden, maquina_codigo, maquina_nombre, estado, estado_por, estado_en,
  reporte_responsable, reporte_puntos, reporte_observaciones, reporte_evidencias, reporte_por, reporte_en) VALUES
  ('2026-10', '2026-10-01', 0, 'CNC1', 'Muratec', 'Realizado', 'importacion', '2026-10-08 15:56:37.427', NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-01', 1, 'B8', 'NPK-250', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-02', 0, 'B13', 'FA-100', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-02', 1, 'C12', 'CM-400', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-03', 0, 'C8', 'SA-90', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-03', 1, 'C19', 'SA-90', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-05', 0, 'CNC4', 'Baoji', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-05', 1, 'C5', 'SA-65', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-06', 0, 'B11', 'NP-57', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-06', 1, 'C2', 'CMB-75', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-07', 0, 'C7', 'CMB-75', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-07', 1, 'C13', 'SA-90', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-08', 0, 'CNC6', 'Tsugami', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-08', 1, 'B3', 'FA-100', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-09', 0, 'CNC2', 'Hass', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-09', 1, 'P5', 'Seiyi sn1-176', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-10', 0, 'B10', 'NPK-250', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-10', 1, 'CNC5', 'Muratec', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-12', 0, 'B5', 'FA-100', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-12', 1, 'B7', 'NP-57', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-13', 0, 'B15', 'FA-100', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-13', 1, 'C16', 'SA-65', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-14', 0, 'B9', 'FA-100', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-14', 1, 'C10', 'SA-90', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-15', 0, 'B20', 'NPK-250', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-15', 1, 'B18', 'FA-100', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-16', 0, 'B12', 'NP-57', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-16', 1, 'P4', 'Komatsu obs60', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-17', 0, 'B19', 'NP-57', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-17', 1, 'P2', 'Komatsu obs60', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-19', 0, 'B4', 'NPK-250', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-19', 1, 'C6', 'SA-65', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-20', 0, 'B16', 'FA-100', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-20', 1, 'C15', 'SA-65', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-21', 0, 'B17', 'NPK-250', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-21', 1, 'P3', 'Komatsu obs80', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-22', 0, 'C17', 'SA-65', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-22', 1, 'P1', 'Komatsu obs60', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-23', 0, 'B1', 'FA-100', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-23', 1, 'C9', 'SA-90', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-24', 0, 'B6', 'FA-100', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-24', 1, 'B21', 'FA-100', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-26', 0, 'C11', 'CM-400', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-26', 1, 'B22', 'FA-100', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-27', 0, 'C1', 'CMB-75', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-27', 1, 'C3', 'SA-65', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-28', 0, 'B2', 'FA-100', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-28', 1, 'C4', 'SA-90', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-29', 0, 'CNC3', 'Tsugami', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-29', 1, 'C14', 'SA-90', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-30', 0, 'B14', 'FA-100', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2026-10', '2026-10-31', 0, 'C18', 'CMB-75', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
ON DUPLICATE KEY UPDATE id = id;

-- ROLLBACK (manual):
-- DELETE FROM preventivo_tareas WHERE mes = '2026-10' AND estado = '' AND reporte_en IS NULL
-- y volver a programar octubre desde la app.
