-- =====================================================================
-- 007: configuracion del sistema, programacion automatica de contramedidas
--      y auditoria
--
-- configuracion_sistema  parametros globales de ESTE sistema (clave/valor
--                        tipado), incluido el umbral de horas para recomendar
--                        una contramedida (20 h = comportamiento actual). Con
--                        CONTRAMEDIDAS_FUENTE=mes el umbral se lee/escribe en
--                        KOIDE MES (mtto_parametros) y esta fila no se usa.
--
-- contramedidas_propuestas  una fila por CICLO de recomendacion
--                        ("EQUIPO|categoria#<id contramedida previa o 0>").
--                        El ciclo cambia solo cuando se registra una
--                        contramedida (cobertura), asi que la UNIQUE evita que
--                        una misma acumulacion genere mas de una propuesta.
--                          PENDIENTE_APROBACION  propuesta automatica con fecha
--                          EN_APROBACION         transitorio mientras se registra
--                                                en el MES (evita doble aprobacion)
--                          CONFIRMADA            aprobada (automatica) o
--                                                programada a mano (MANUAL)
--                          RECHAZADA             descartada por un administrador
--
-- auditoria              bitacora de cambios importantes (quien, cuando,
--                        valor anterior/nuevo).
--
-- Solo crea tablas nuevas: no modifica datos existentes.
-- Compatible con MySQL 8.0.16+ y MariaDB 10.4+. Reversible: bloque al final.
-- =====================================================================

CREATE TABLE IF NOT EXISTS configuracion_sistema (
  clave            VARCHAR(80)  NOT NULL,
  valor            VARCHAR(500) NOT NULL,
  tipo             VARCHAR(20)  NOT NULL COMMENT 'numero | entero | booleano | dias_semana',
  descripcion      VARCHAR(255) NULL,
  actualizado_por  VARCHAR(100) NULL,
  updated_at       DATETIME(3)  NOT NULL,
  PRIMARY KEY (clave)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Parametros globales del sistema (configurables sin tocar codigo)';

INSERT IGNORE INTO configuracion_sistema (clave, valor, tipo, descripcion, actualizado_por, updated_at) VALUES
  ('contramedida_umbral_horas', '20', 'numero', 'Horas acumuladas de una misma categoria de falla en un equipo a partir de las cuales se recomienda una contramedida', NULL, NOW(3)),
  ('programacion_automatica_activa', '1', 'booleano', 'Buscar automaticamente una fecha para cada recomendacion de contramedida', NULL, NOW(3)),
  ('programacion_dias_permitidos', '1,2,3,4,5,6', 'dias_semana', 'Dias de la semana permitidos para programar contramedidas (1 = lunes ... 7 = domingo)', NULL, NOW(3)),
  ('programacion_horizonte_dias', '14', 'entero', 'Dias hacia adelante (desde manana) en los que se busca una fecha disponible', NULL, NOW(3)),
  ('programacion_max_por_dia', '1', 'entero', 'Maximo de contramedidas programadas por dia en la planta', NULL, NOW(3));

CREATE TABLE IF NOT EXISTS contramedidas_propuestas (
  id                      INT          NOT NULL AUTO_INCREMENT,
  ciclo                   VARCHAR(191) COLLATE utf8mb4_bin NOT NULL COMMENT 'EQUIPO|categoria#<contramedida previa MES o 0>',
  recomendacion_clave     VARCHAR(120) NOT NULL,
  equipo_codigo           VARCHAR(50)  NOT NULL,
  equipo_nombre           VARCHAR(255) NULL,
  proceso                 VARCHAR(100) NULL,
  categoria_codigo        VARCHAR(40)  NULL,
  categoria_nombre        VARCHAR(255) NULL,
  horas_acumuladas        DECIMAL(9,2) NULL,
  paros                   INT          NULL,
  umbral_horas            DECIMAL(9,2) NULL,
  contramedida_previa_id  VARCHAR(40)  NULL COMMENT 'Contramedida que cubrio la acumulacion anterior (id local o del MES)',
  detectada_en            DATETIME(3)  NOT NULL COMMENT 'Cuando este sistema vio la recomendacion por primera vez',
  origen                  VARCHAR(20)  NOT NULL,
  estado                  VARCHAR(30)  NOT NULL,
  fecha_propuesta         DATE         NULL,
  fecha_confirmada        DATE         NULL,
  reprogramaciones        INT          NOT NULL DEFAULT 0,
  motivo                  VARCHAR(500) NULL COMMENT 'Ultimo motivo de rechazo / reprogramacion',
  resuelta_por            VARCHAR(100) NULL,
  resuelta_en             DATETIME(3)  NULL,
  contramedida_id         VARCHAR(40)  COLLATE utf8mb4_bin NULL COMMENT 'contramedidas.id creada al confirmar',
  mes_id                  INT          NULL,
  creada_por              VARCHAR(100) NOT NULL COMMENT 'sistema | usuario',
  created_at              DATETIME(3)  NOT NULL,
  updated_at              DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_propuestas_ciclo (ciclo),
  KEY idx_propuestas_estado (estado),
  KEY idx_propuestas_fecha (fecha_propuesta),
  CONSTRAINT chk_propuestas_origen CHECK (origen IN ('AUTOMATICA', 'MANUAL')),
  CONSTRAINT chk_propuestas_estado CHECK (estado IN ('PENDIENTE_APROBACION', 'EN_APROBACION', 'CONFIRMADA', 'RECHAZADA'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Programacion (automatica o manual) de contramedidas por acumulacion y su aprobacion';

CREATE TABLE IF NOT EXISTS auditoria (
  id              BIGINT       NOT NULL AUTO_INCREMENT,
  en              DATETIME(3)  NOT NULL,
  usuario         VARCHAR(100) NOT NULL COMMENT 'username o "sistema"',
  rol             VARCHAR(40)  NULL,
  accion          VARCHAR(60)  NOT NULL,
  entidad         VARCHAR(60)  NOT NULL,
  entidad_id      VARCHAR(191) NULL,
  valor_anterior  TEXT         NULL,
  valor_nuevo     TEXT         NULL,
  detalle         TEXT         NULL,
  PRIMARY KEY (id),
  KEY idx_auditoria_entidad (entidad, entidad_id),
  KEY idx_auditoria_en (en)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Bitacora de cambios importantes (configuracion, programacion y aprobacion de contramedidas)';

-- ROLLBACK (manual; exportar antes auditoria y contramedidas_propuestas):
-- DROP TABLE IF EXISTS auditoria;
-- DROP TABLE IF EXISTS contramedidas_propuestas;
-- DROP TABLE IF EXISTS configuracion_sistema;
