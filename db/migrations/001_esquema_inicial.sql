-- =====================================================================
-- Metricos de Mantenimiento - 001: esquema inicial (datos de la app)
--
-- Compatible con MySQL 8.0.16+ y MariaDB 10.4+ (XAMPP).
-- Se aplica con:  node scripts/db-setup.js   (idempotente; ver db/README.md)
--
-- Convenciones:
--   * Fechas/horas en UTC (DATETIME(3)). La app convierte a ISO-8601 "...Z".
--   * Las columnas "payload" / documentos JSON son LONGTEXT + CHECK JSON_VALID
--     en lugar del tipo JSON: el tipo JSON de MySQL reordena las claves de los
--     objetos y la app debe devolver exactamente el mismo JSON que guardaba en
--     los archivos (el frontend recorre celdas de Excel en orden de claves).
--   * Tablas espejo (tiempo_muerto, maquinas, gastos, entregas): "payload" es
--     el registro exacto que sirve la API; las demas columnas son copias
--     tipadas para consultas/reportes en SQL.
--   * Tablas propias de la app (contramedidas, bonos, calendarios): columnas
--     tipadas + "extra" (JSON) con campos desconocidos o valores que no caben
--     en la columna tipada, para no perder informacion.
--   * "orden" conserva el orden original de los arreglos JSON.
--   * Archivos (fotos, Excel, documentos) viven en disco; aqui solo se guarda
--     su ruta relativa a DATA_DIR con "/" como separador.
-- =====================================================================

CREATE TABLE IF NOT EXISTS fuentes_sync (
  fuente        VARCHAR(40)  NOT NULL,
  area          VARCHAR(100) NULL,
  actualizado   DATETIME(3)  NOT NULL,
  registros     INT          NOT NULL DEFAULT 0,
  detalle       VARCHAR(255) NULL,
  PRIMARY KEY (fuente)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Ultima actualizacion de cada fuente externa (koide, Excel gastos, Excel entregas)';

-- ---------------------------------------------------------------------
-- Tiempo muerto (espejo de la API koide /api/downtime-records)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS maquinas (
  id                       INT          NOT NULL,
  orden                    INT          NOT NULL,
  code                     VARCHAR(50)  NULL,
  name                     VARCHAR(255) NULL,
  process                  VARCHAR(100) NULL,
  active                   TINYINT      NULL,
  target_pcs_per_hour      INT          NULL,
  effective_hours_per_day  DOUBLE       NULL,
  created_at               DATETIME(3)  NULL,
  updated_at               DATETIME(3)  NULL,
  payload                  LONGTEXT     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_maquinas_orden (orden),
  KEY idx_maquinas_code (code),
  CONSTRAINT chk_maquinas_payload CHECK (JSON_VALID(payload))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tiempo_muerto (
  id                        INT          NOT NULL,
  orden                     INT          NOT NULL,
  record_date               DATE         NULL,
  shift                     VARCHAR(20)  NULL,
  group_name                VARCHAR(20)  NULL,
  machine_id                INT          NULL,
  machine_code              VARCHAR(50)  NULL,
  operator_employee_number  VARCHAR(50)  NULL,
  operator_name             VARCHAR(255) NULL,
  downtime_start            DATETIME(3)  NULL,
  downtime_end              DATETIME(3)  NULL,
  downtime_minutes          INT          NULL,
  responsible_area          VARCHAR(100) NULL,
  downtime_category         VARCHAR(100) NULL,
  problem_description       TEXT         NULL,
  responsible_person        VARCHAR(255) NULL,
  action_taken              TEXT         NULL,
  status                    VARCHAR(50)  NULL,
  response_time_minutes     INT          NULL,
  repair_time_minutes       INT          NULL,
  external_minutes          INT          NULL,
  created_at                DATETIME(3)  NULL,
  updated_at                DATETIME(3)  NULL,
  payload                   LONGTEXT     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_tm_orden (orden),
  KEY idx_tm_fecha (record_date),
  KEY idx_tm_maquina (machine_id),
  CONSTRAINT chk_tm_payload CHECK (JSON_VALID(payload))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Gastos (extraido por scripts/extract_v4.py del Excel de requisiciones)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gastos (
  id                 INT           NOT NULL AUTO_INCREMENT,
  orden              INT           NOT NULL,
  sheet              VARCHAR(100)  NULL,
  cotizacion         VARCHAR(50)   NULL,
  proveedor          TEXT          NULL,
  producto           TEXT          NULL,
  observaciones      TEXT          NULL,
  cantidad           DOUBLE        NULL,
  unidad             VARCHAR(50)   NULL,
  precio_unitario    DOUBLE        NULL,
  importe            DECIMAL(16,2) NULL,
  iva                DECIMAL(16,2) NULL,
  total_partida      DECIMAL(16,2) NULL,
  po                 VARCHAR(50)   NULL,
  tiene_po           TINYINT(1)    NULL,
  entregado          TINYINT(1)    NULL,
  fecha_elaboracion  DATE          NULL,
  fecha_entrega      DATE          NULL,
  mes_entrega        TINYINT       NULL,
  moneda             VARCHAR(20)   NULL,
  proyecto           VARCHAR(255)  NULL,
  termino_pago       VARCHAR(100)  NULL,
  comentario         TEXT          NULL,
  payload            LONGTEXT      NOT NULL,
  PRIMARY KEY (id),
  KEY idx_gastos_orden (orden),
  KEY idx_gastos_po (po),
  CONSTRAINT chk_gastos_payload CHECK (JSON_VALID(payload))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Tiempos de entrega (extraido por scripts/extract_entregas.py)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entregas (
  id              INT          NOT NULL AUTO_INCREMENT,
  orden           INT          NOT NULL,
  proveedor       TEXT         NULL,
  material        TEXT         NULL,
  cantidad        DOUBLE       NULL,
  depto           VARCHAR(100) NULL,
  serie           VARCHAR(50)  NULL,
  po              VARCHAR(50)  NULL,
  fecha_envio     DATE         NULL,
  fecha_estimada  DATE         NULL,
  dias            INT          NULL,
  estatus         VARCHAR(50)  NULL,
  observaciones   TEXT         NULL,
  mes             TINYINT      NULL,
  payload         LONGTEXT     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_entregas_orden (orden),
  KEY idx_entregas_po (po),
  CONSTRAINT chk_entregas_payload CHECK (JSON_VALID(payload))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Contramedidas
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contramedidas (
  id                  VARCHAR(40)  COLLATE utf8mb4_bin NOT NULL,
  orden               BIGINT       NOT NULL AUTO_INCREMENT,
  tipo                VARCHAR(255) NULL,
  maquina             VARCHAR(255) NULL,
  maquina_nombre      VARCHAR(255) NULL,
  falla_comun         TEXT         NULL,
  referencia          VARCHAR(255) NULL,
  categoria           VARCHAR(255) NULL,
  descripcion         TEXT         NULL,
  responsable         VARCHAR(255) NULL,
  fecha_limite        DATE         NULL,
  estado              VARCHAR(100) NULL,
  creada              DATETIME(3)  NULL,
  trabajo_realizado   TEXT         NULL,
  extra               LONGTEXT     NULL COMMENT 'Campos adicionales o valores no representables en las columnas tipadas',
  PRIMARY KEY (id),
  UNIQUE KEY uq_cm_orden (orden),
  KEY idx_cm_maquina (maquina),
  KEY idx_cm_estado (estado),
  CONSTRAINT chk_cm_extra CHECK (extra IS NULL OR JSON_VALID(extra))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contramedida_fotos (
  id                INT          NOT NULL AUTO_INCREMENT,
  contramedida_id   VARCHAR(40)  COLLATE utf8mb4_bin NOT NULL,
  orden             INT          NOT NULL,
  nombre            VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  ruta              VARCHAR(600) NOT NULL COMMENT 'Relativa a DATA_DIR',
  creada            DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_cmf_cm (contramedida_id, orden),
  CONSTRAINT fk_cmf_cm FOREIGN KEY (contramedida_id)
    REFERENCES contramedidas (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Bonos (plantilla Excel + captura semanal)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bonos_plantilla (
  id            TINYINT      NOT NULL,
  hoja          VARCHAR(255) NULL,
  archivo_ruta  VARCHAR(600) NULL COMMENT 'Relativa a DATA_DIR',
  plantilla     LONGTEXT     NULL COMMENT 'Hoja parseada (celdas, merges, cols) tal como la usa el frontend',
  actualizado   DATETIME(3)  NULL,
  extra         LONGTEXT     NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_bp_unica CHECK (id = 1),
  CONSTRAINT chk_bp_plantilla CHECK (plantilla IS NULL OR JSON_VALID(plantilla)),
  CONSTRAINT chk_bp_extra CHECK (extra IS NULL OR JSON_VALID(extra))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bonos_semanas (
  clave         VARCHAR(100) NOT NULL,
  orden         BIGINT       NOT NULL AUTO_INCREMENT,
  semana        INT          NULL,
  periodo_ini   VARCHAR(50)  NULL,
  periodo_fin   VARCHAR(50)  NULL,
  fecha         VARCHAR(50)  NULL,
  celdas        LONGTEXT     NULL,
  guardado      DATETIME(3)  NULL,
  extra         LONGTEXT     NULL,
  PRIMARY KEY (clave),
  UNIQUE KEY uq_bs_orden (orden),
  CONSTRAINT chk_bs_celdas CHECK (celdas IS NULL OR JSON_VALID(celdas)),
  CONSTRAINT chk_bs_extra CHECK (extra IS NULL OR JSON_VALID(extra))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---------------------------------------------------------------------
-- Calendarios de mantenimiento (Excel)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendarios (
  id            VARCHAR(40)  COLLATE utf8mb4_bin NOT NULL,
  orden         BIGINT       NOT NULL AUTO_INCREMENT,
  nombre        VARCHAR(255) NULL,
  archivo_ruta  VARCHAR(600) NOT NULL COMMENT 'Relativa a DATA_DIR',
  subido        DATETIME(3)  NULL,
  hojas         LONGTEXT     NULL,
  estado        LONGTEXT     NULL COMMENT 'Estatus por celda (Realizado/Reprogramado/...)',
  extra         LONGTEXT     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cal_orden (orden),
  CONSTRAINT chk_cal_hojas CHECK (hojas IS NULL OR JSON_VALID(hojas)),
  CONSTRAINT chk_cal_estado CHECK (estado IS NULL OR JSON_VALID(estado)),
  CONSTRAINT chk_cal_extra CHECK (extra IS NULL OR JSON_VALID(extra))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Documentos (archivos por categoria en DATA_DIR/documentos/<categoria>)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documentos (
  id           INT          NOT NULL AUTO_INCREMENT,
  categoria    VARCHAR(100) COLLATE utf8mb4_bin NOT NULL,
  nombre       VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  ruta         VARCHAR(600) NOT NULL COMMENT 'Relativa a DATA_DIR',
  tamano       BIGINT       NOT NULL,
  modificado   DATETIME(3)  NOT NULL,
  registrado   DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_doc (categoria, nombre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Bitacora de migraciones JSON -> MySQL
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migraciones (
  id           INT          NOT NULL AUTO_INCREMENT,
  ejecutada    DATETIME(3)  NOT NULL,
  origen       VARCHAR(600) NOT NULL,
  resultado    VARCHAR(20)  NOT NULL,
  resumen      LONGTEXT     NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
