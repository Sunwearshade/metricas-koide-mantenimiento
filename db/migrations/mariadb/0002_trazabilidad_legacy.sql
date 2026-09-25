-- =====================================================================
-- 0002_trazabilidad_legacy  (MariaDB 10.4.32 - XAMPP)
--
-- Tablas de trazabilidad de la migracion del sistema legacy. La aplicacion
-- (lib/store.js, API) NO lee estas tablas: sirven para conservar la foto
-- historica validada, las decisiones aprobadas y las anomalias.
--
-- Las fechas no usan DEFAULT CURRENT_TIMESTAMP porque este depende de la
-- zona horaria de la sesion. Los scripts escriben UTC de forma explicita.
-- =====================================================================

CREATE TABLE IF NOT EXISTS legacy_lotes (
  id                 INT          NOT NULL AUTO_INCREMENT,
  ejecutado          DATETIME(3)  NOT NULL COMMENT 'UTC',
  origen             VARCHAR(600) NOT NULL COMMENT 'Ruta de data/ usada como fuente',
  manifiesto_sha256  CHAR(64)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resultado          ENUM('en_proceso','ok','error') NOT NULL DEFAULT 'en_proceso',
  resumen            LONGTEXT     NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_ll_resumen CHECK (resumen IS NULL OR JSON_VALID(resumen))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci
  COMMENT='Una fila por cada importacion del legacy';

CREATE TABLE IF NOT EXISTS legacy_archivos (
  id        INT          NOT NULL AUTO_INCREMENT,
  lote_id   INT          NOT NULL,
  ruta      VARCHAR(500) COLLATE utf8mb4_bin NOT NULL COMMENT 'data/... en el legacy',
  bytes     BIGINT       NOT NULL,
  sha256    CHAR(64)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'SHA-256 del archivo legacy',
  tipo      ENUM('json','excel','imagen','log','otro') NOT NULL,
  estado    ENUM('migrado','conservado_en_disco','historico_pendiente_validacion') NOT NULL
            COMMENT 'Sin DEFAULT: el importador lo escribe de forma explicita',
  nota      VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_la_lote_ruta (lote_id, ruta),
  KEY idx_la_estado (estado),
  CONSTRAINT fk_la_lote FOREIGN KEY (lote_id) REFERENCES legacy_lotes (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci
  COMMENT='Inventario de archivos del legacy con checksum';

CREATE TABLE IF NOT EXISTS legacy_registros (
  id                BIGINT       NOT NULL AUTO_INCREMENT,
  lote_id           INT          NOT NULL,
  fuente            VARCHAR(40)  COLLATE utf8mb4_bin NOT NULL
                    COMMENT 'tiempo_muerto, tiempo_muerto_meta, maquinas, gastos, entregas, contramedidas, bonos_plantilla, bonos_semanas',
  clave_legacy      VARCHAR(100) COLLATE utf8mb4_bin NOT NULL
                    COMMENT 'ID original. En gastos y entregas, la posicion (orden) en el JSON',
  orden             INT          NOT NULL COMMENT 'Posicion en el archivo original',
  payload           LONGTEXT     NOT NULL COMMENT 'JSON exacto del registro legacy',
  payload_sha256    CHAR(64)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  huella_identidad  CHAR(64)     CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'Solo gastos y entregas',
  ocurrencia        INT          NULL COMMENT 'N-esima fila con la misma huella, por orden (gastos y entregas)',
  estado_migracion  ENUM('migrado','excluido') NOT NULL,
  motivo            VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lr_clave (lote_id, fuente, clave_legacy),
  KEY idx_lr_fuente_estado (fuente, estado_migracion),
  KEY idx_lr_huella (fuente, huella_identidad, ocurrencia),
  CONSTRAINT chk_lr_payload  CHECK (JSON_VALID(payload)),
  CONSTRAINT chk_lr_excluido CHECK (estado_migracion <> 'excluido' OR motivo IS NOT NULL),
  CONSTRAINT fk_lr_lote FOREIGN KEY (lote_id) REFERENCES legacy_lotes (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci
  COMMENT='Foto historica validada, un registro legacy por fila. Incluye excluidos (2026-W37).';

CREATE TABLE IF NOT EXISTS legacy_marcas (
  id        INT          NOT NULL AUTO_INCREMENT,
  lote_id   INT          NOT NULL,
  tabla     VARCHAR(64)  COLLATE utf8mb4_bin NOT NULL,
  registro  VARCHAR(100) COLLATE utf8mb4_bin NOT NULL,
  campo     VARCHAR(100) COLLATE utf8mb4_bin NOT NULL,
  marca     VARCHAR(60)  COLLATE utf8mb4_bin NOT NULL,
  valor     TEXT         NULL COMMENT 'Copia exacta del valor marcado. El dato operativo no se modifica',
  nota      VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lm (tabla, registro, campo, marca),
  CONSTRAINT fk_lm_lote FOREIGN KEY (lote_id) REFERENCES legacy_lotes (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci
  COMMENT='Marcas sobre datos migrados (p. ej. heredado_de_plantilla)';

CREATE TABLE IF NOT EXISTS legacy_anomalias (
  id           INT          NOT NULL AUTO_INCREMENT,
  lote_id      INT          NOT NULL,
  codigo       VARCHAR(30)  NOT NULL COMMENT 'TM-1, TM-2, TM-4, TM-5, GA-DUP, EN-DUP, GA-HUELLA-AMBIGUA, EN-HUELLA-AMBIGUA, CM-*, BO-*',
  fuente       VARCHAR(40)  NOT NULL,
  registro     VARCHAR(100) COLLATE utf8mb4_bin NOT NULL COMMENT 'ID legacy afectado',
  campo        VARCHAR(100) NULL,
  valor        TEXT         NULL COMMENT 'Valor tal cual, sin corregir',
  descripcion  VARCHAR(500) NOT NULL,
  estado       ENUM('abierta','validada','descartada') NOT NULL DEFAULT 'abierta',
  PRIMARY KEY (id),
  KEY idx_lan_codigo (codigo),
  KEY idx_lan_registro (fuente, registro),
  CONSTRAINT fk_lan_lote FOREIGN KEY (lote_id) REFERENCES legacy_lotes (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci
  COMMENT='Anomalias conservadas deliberadamente (no se corrigen)';

CREATE TABLE IF NOT EXISTS diccionario_datos (
  tabla        VARCHAR(64)  COLLATE utf8mb4_bin NOT NULL,
  campo        VARCHAR(150) COLLATE utf8mb4_bin NOT NULL COMMENT 'Columna o ruta JSON (payload.x, celdas.N)',
  origen       ENUM('original_koide','calculado_koide','original_excel','calculado_script',
                    'captura_usuario','calculado_app','copia_de_payload',
                    'heredado_de_plantilla','metadato_migracion') NOT NULL,
  descripcion  VARCHAR(500) NULL,
  PRIMARY KEY (tabla, campo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci
  COMMENT='Clasificacion de cada campo: original vs calculado';

-- Identidad estable de gastos y entregas, independiente del orden y de quien
-- inserte (Node o Python). Se calcula solo con campos originales y no mutables
-- del Excel, a partir de las columnas tipadas. Junto con "ocurrencia" (calculada
-- por el importador con ROW_NUMBER) identifica cada registro. La lista de campos
-- queda pendiente de validar con una segunda extraccion del Excel.
ALTER TABLE gastos
  ADD COLUMN IF NOT EXISTS huella_identidad CHAR(64) CHARACTER SET ascii COLLATE ascii_bin
    AS (SHA2(CONCAT_WS(0x1F,
          IFNULL(sheet, 0x00), IFNULL(cotizacion, 0x00), IFNULL(proveedor, 0x00),
          IFNULL(producto, 0x00), IFNULL(observaciones, 0x00), IFNULL(cantidad, 0x00),
          IFNULL(unidad, 0x00), IFNULL(precio_unitario, 0x00), IFNULL(moneda, 0x00),
          IFNULL(fecha_elaboracion, 0x00)), 256)) STORED
    COMMENT 'Generada por MariaDB. No la escribe la aplicacion',
  ADD INDEX IF NOT EXISTS idx_gastos_huella (huella_identidad);

ALTER TABLE entregas
  ADD COLUMN IF NOT EXISTS huella_identidad CHAR(64) CHARACTER SET ascii COLLATE ascii_bin
    AS (SHA2(CONCAT_WS(0x1F,
          IFNULL(proveedor, 0x00), IFNULL(material, 0x00), IFNULL(cantidad, 0x00),
          IFNULL(depto, 0x00), IFNULL(serie, 0x00), IFNULL(po, 0x00),
          IFNULL(fecha_envio, 0x00)), 256)) STORED
    COMMENT 'Generada por MariaDB. No la escribe la aplicacion',
  ADD INDEX IF NOT EXISTS idx_entregas_huella (huella_identidad);
