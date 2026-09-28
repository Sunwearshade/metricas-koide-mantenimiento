-- =====================================================================
-- 003: atencion de paros por el operador de mantenimiento
--
-- El paro (reporte) pertenece al sistema externo (koide). Aqui NO se copia
-- como historial: solo se guarda la ATENCION de mantenimiento, con una foto
-- del reporte al momento de aceptarlo (reporte_snapshot) para trazabilidad,
-- porque el espejo tiempo_muerto se reemplaza en cada sincronizacion.
--
-- Campos capturados = los que ya existen en el modelo de paro de koide
-- (repair_start, repair_started_by_employee_number, action_taken, comments,
-- response_time_minutes, repair_time_minutes) + la evidencia que ya usan las
-- contramedidas (fotos antes/despues, max. 2, jpg/png, 5 MB).
--
-- Estados:
--   EN_ATENCION  aceptado por un operador de mantenimiento
--   FINALIZADA   trabajo capturado; codigo de cierre generado
--   CERRADA      la terminal de produccion valido el codigo de cierre
-- =====================================================================

CREATE TABLE IF NOT EXISTS paro_atenciones (
  id                            INT          NOT NULL AUTO_INCREMENT,
  fuente                        VARCHAR(20)  NOT NULL COMMENT 'Sistema dueno del reporte (koide)',
  reporte_ref                   VARCHAR(50)  COLLATE utf8mb4_bin NOT NULL COMMENT 'Id del reporte en la fuente',
  codigo_reporte                VARCHAR(50)  COLLATE utf8mb4_bin NOT NULL COMMENT 'Codigo tal como lo capturo el operador (normalizado)',
  estado                        VARCHAR(20)  NOT NULL,
  reporte_snapshot              LONGTEXT     NOT NULL COMMENT 'Registro del reporte al aceptarlo (JSON exacto de la fuente)',
  machine_code                  VARCHAR(50)  NULL,
  machine_name                  VARCHAR(255) NULL,
  downtime_start                DATETIME(3)  NULL,
  aceptado_por_usuario_id       INT          NOT NULL,
  aceptado_en                   DATETIME(3)  NOT NULL COMMENT 'Equivale a repair_start',
  tecnico_numero_empleado       VARCHAR(50)  NULL COMMENT 'Equivale a repair_started_by_employee_number / closed_by_employee_number',
  tecnico_nombre                VARCHAR(150) NULL,
  action_taken                  TEXT         NULL COMMENT 'Trabajo / accion realizada',
  comments                      TEXT         NULL,
  finalizado_por_usuario_id     INT          NULL,
  finalizado_en                 DATETIME(3)  NULL,
  response_time_minutes         INT          NULL COMMENT 'aceptado_en - downtime_start (misma definicion que koide)',
  repair_time_minutes           INT          NULL COMMENT 'finalizado_en - aceptado_en (misma definicion que koide)',
  codigo_cierre                 VARCHAR(20)  COLLATE utf8mb4_bin NULL COMMENT 'Normalizado, sin guiones',
  cierre_confirmado_en          DATETIME(3)  NULL,
  cierre_confirmado_por         VARCHAR(100) NULL COMMENT 'Identificador de la terminal que valido el codigo',
  created_at                    DATETIME(3)  NOT NULL,
  updated_at                    DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_atencion_reporte (fuente, reporte_ref),
  UNIQUE KEY uq_atencion_cierre (codigo_cierre),
  KEY idx_atencion_estado (estado),
  KEY idx_atencion_usuario (aceptado_por_usuario_id, estado),
  CONSTRAINT fk_atencion_aceptado FOREIGN KEY (aceptado_por_usuario_id) REFERENCES usuarios (id),
  CONSTRAINT fk_atencion_finalizado FOREIGN KEY (finalizado_por_usuario_id) REFERENCES usuarios (id),
  CONSTRAINT chk_atencion_estado CHECK (estado IN ('EN_ATENCION', 'FINALIZADA', 'CERRADA')),
  CONSTRAINT chk_atencion_snapshot CHECK (JSON_VALID(reporte_snapshot))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS paro_atencion_fotos (
  id            INT          NOT NULL AUTO_INCREMENT,
  atencion_id   INT          NOT NULL,
  tipo          VARCHAR(20)  NOT NULL COMMENT 'antes | despues',
  nombre        VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  ruta          VARCHAR(600) NOT NULL COMMENT 'Relativa a DATA_DIR',
  creada        DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_paf_nombre (atencion_id, nombre),
  CONSTRAINT fk_paf_atencion FOREIGN KEY (atencion_id) REFERENCES paro_atenciones (id),
  CONSTRAINT chk_paf_tipo CHECK (tipo IN ('antes', 'despues'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bitacora de trazabilidad (solo se agregan filas).
CREATE TABLE IF NOT EXISTS paro_atencion_eventos (
  id            INT          NOT NULL AUTO_INCREMENT,
  atencion_id   INT          NOT NULL,
  evento        VARCHAR(30)  NOT NULL COMMENT 'ACEPTADO | FINALIZADO | CIERRE_VALIDADO',
  usuario_id    INT          NULL,
  detalle       VARCHAR(255) NULL,
  creado        DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_pae_atencion (atencion_id, creado),
  CONSTRAINT fk_pae_atencion FOREIGN KEY (atencion_id) REFERENCES paro_atenciones (id),
  CONSTRAINT fk_pae_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
