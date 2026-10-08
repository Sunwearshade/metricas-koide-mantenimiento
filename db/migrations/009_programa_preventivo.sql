-- =====================================================================
-- 009: programa de mantenimiento preventivo mensual y su reporte
--
-- Traido del sistema "metricos" (08/10/2026). Convive con el calendario de
-- mantenimiento en Excel (tabla calendarios), que no se modifica.
--
-- preventivo_meses   un renglon por mes calendarizado ('YYYY-MM').
-- preventivo_tareas  un preventivo por maquina y dia (lunes a sabado). La
--                    programacion automatica ordena las maquinas por el tiempo
--                    muerto del mes anterior. Cada tarea lleva su estado
--                    (Realizado / Reprogramado / Pendiente) y el reporte del
--                    mantenimiento: responsable, puntos revisados, observaciones
--                    y evidencias (archivos en DATA_DIR/preventivo-evidencias).
--
-- Solo crea tablas nuevas: no modifica datos existentes.
-- Compatible con MySQL 8.0.16+ y MariaDB 10.4+. Reversible: bloque al final.
-- =====================================================================

CREATE TABLE IF NOT EXISTS preventivo_meses (
  mes          CHAR(7)      NOT NULL COMMENT 'YYYY-MM',
  created_at   DATETIME(3)  NOT NULL,
  updated_at   DATETIME(3)  NOT NULL,
  PRIMARY KEY (mes),
  CONSTRAINT chk_prev_mes CHECK (mes REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Meses del programa de mantenimiento preventivo';

CREATE TABLE IF NOT EXISTS preventivo_tareas (
  id                     INT          NOT NULL AUTO_INCREMENT,
  mes                    CHAR(7)      NOT NULL,
  fecha                  DATE         NOT NULL,
  orden                  INT          NOT NULL COMMENT 'Posicion dentro del dia',
  maquina_codigo         VARCHAR(50)  NOT NULL,
  maquina_nombre         VARCHAR(255) NULL,
  estado                 VARCHAR(20)  NOT NULL DEFAULT '' COMMENT "'' = sin marcar",
  estado_por             VARCHAR(100) NULL,
  estado_en              DATETIME(3)  NULL,
  reporte_responsable    VARCHAR(255) NULL,
  reporte_puntos         LONGTEXT     NULL COMMENT '[{punto, ok}]',
  reporte_observaciones  TEXT         NULL,
  reporte_evidencias     LONGTEXT     NULL COMMENT '[{name}] relativos a preventivo-evidencias/',
  reporte_por            VARCHAR(100) NULL,
  reporte_en             DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_prev_tarea (mes, fecha, orden),
  KEY idx_prev_maquina (maquina_codigo),
  CONSTRAINT fk_prev_tarea_mes FOREIGN KEY (mes) REFERENCES preventivo_meses (mes) ON DELETE CASCADE,
  CONSTRAINT chk_prev_estado CHECK (estado IN ('', 'Realizado', 'Reprogramado', 'Pendiente')),
  CONSTRAINT chk_prev_puntos CHECK (reporte_puntos IS NULL OR JSON_VALID(reporte_puntos)),
  CONSTRAINT chk_prev_evidencias CHECK (reporte_evidencias IS NULL OR JSON_VALID(reporte_evidencias))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Preventivo mensual por maquina: dia agendado, estado y reporte';

-- ROLLBACK (manual; exportar antes las tablas y la carpeta preventivo-evidencias):
-- DROP TABLE IF EXISTS preventivo_tareas;
-- DROP TABLE IF EXISTS preventivo_meses;
