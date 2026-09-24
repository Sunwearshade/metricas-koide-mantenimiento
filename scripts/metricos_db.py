"""Utilidades compartidas por los scripts de extraccion: .env y MySQL."""
import json
import os
import re
import sys
from datetime import datetime, timezone

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def load_env(path=None):
    """Carga ROOT/.env sin sobrescribir variables ya definidas (igual que lib/env.js)."""
    path = path or os.environ.get('METRICOS_ENV_FILE') or os.path.join(ROOT, '.env')
    if not os.path.exists(path):
        return
    with open(path, 'r', encoding='utf-8-sig') as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, val = line.split('=', 1)
            key, val = key.strip(), val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                val = val[1:-1]
            if key and key not in os.environ:
                os.environ[key] = val


load_env()


def env(name, default=None):
    v = os.environ.get(name)
    return default if v is None or v == '' else v


def require_env(name):
    v = env(name)
    if v is None:
        sys.stderr.write('Falta la variable %s en .env\n' % name)
        sys.exit(2)
    return v


def connect():
    import pymysql
    return pymysql.connect(
        host=env('DB_HOST', '127.0.0.1'),
        port=int(env('DB_PORT', '3306')),
        user=env('DB_USER', 'metricos'),
        password=env('DB_PASSWORD', ''),
        database=env('DB_NAME', 'metricos'),
        charset='utf8mb4',
        autocommit=False,
    )


# --- conversiones para columnas tipadas (el valor exacto queda en payload) ---

def s(v, maxlen):
    if v is None:
        return None
    v = str(v)
    return v[:maxlen]


def text(v):
    if v is None:
        return None
    v = str(v)
    while len(v.encode('utf-8')) > 65535:
        v = v[:int(len(v) * 0.9)]
    return v


def date_or_none(v):
    if isinstance(v, str) and DATE_RE.match(v):
        try:
            datetime.strptime(v, '%Y-%m-%d')
            return v
        except ValueError:
            return None
    return None


def int_or_none(v):
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int) and abs(v) <= 2147483647:
        return v
    if isinstance(v, float) and v.is_integer() and abs(v) <= 2147483647:
        return int(v)
    return None


def tiny_or_none(v):
    v = int_or_none(v)
    return v if v is not None and -128 <= v <= 127 else None


def num_or_none(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def replace_table(table, fuente, items, typed_row, detalle=None):
    """Reemplaza todo el contenido de `table` en una transaccion (equivale a
    sobrescribir el archivo JSON anterior) y registra la actualizacion."""
    rows = []
    for i, it in enumerate(items):
        row = typed_row(it)
        row['orden'] = i
        row['payload'] = json.dumps(it, ensure_ascii=False)
        rows.append(row)
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute('DELETE FROM %s' % table)
            if rows:
                cols = list(rows[0].keys())
                sql = 'INSERT INTO %s (%s) VALUES (%s)' % (
                    table, ', '.join(cols), ', '.join(['%s'] * len(cols)))
                for i in range(0, len(rows), 300):
                    cur.executemany(sql, [[r[c] for c in cols] for r in rows[i:i + 300]])
            cur.execute(
                'INSERT INTO fuentes_sync (fuente, area, actualizado, registros, detalle) '
                'VALUES (%s, NULL, %s, %s, %s) '
                'ON DUPLICATE KEY UPDATE actualizado = VALUES(actualizado), '
                'registros = VALUES(registros), detalle = VALUES(detalle)',
                (fuente, datetime.now(timezone.utc).replace(tzinfo=None), len(rows), detalle))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return len(rows)


def gasto_row(it):
    return {
        'sheet': s(it.get('sheet'), 100),
        'cotizacion': s(it.get('cotizacion'), 50),
        'proveedor': text(it.get('proveedor')),
        'producto': text(it.get('producto')),
        'observaciones': text(it.get('observaciones')),
        'cantidad': num_or_none(it.get('cantidad')),
        'unidad': s(it.get('unidad'), 50),
        'precio_unitario': num_or_none(it.get('precio_unitario')),
        'importe': num_or_none(it.get('importe')),
        'iva': num_or_none(it.get('iva')),
        'total_partida': num_or_none(it.get('total_partida')),
        'po': s(it.get('po'), 50),
        'tiene_po': int_or_none(it.get('tiene_po')),
        'entregado': int_or_none(it.get('entregado')),
        'fecha_elaboracion': date_or_none(it.get('fecha_elaboracion')),
        'fecha_entrega': date_or_none(it.get('fecha_entrega')),
        'mes_entrega': tiny_or_none(it.get('mes_entrega')),
        'moneda': s(it.get('moneda'), 20),
        'proyecto': s(it.get('proyecto'), 255),
        'termino_pago': s(it.get('termino_pago'), 100),
        'comentario': text(it.get('comentario')),
    }


def entrega_row(it):
    return {
        'proveedor': text(it.get('proveedor')),
        'material': text(it.get('material')),
        'cantidad': num_or_none(it.get('cantidad')),
        'depto': s(it.get('depto'), 100),
        'serie': s(it.get('serie'), 50),
        'po': s(it.get('po'), 50),
        'fecha_envio': date_or_none(it.get('fecha_envio')),
        'fecha_estimada': date_or_none(it.get('fecha_estimada')),
        'dias': int_or_none(it.get('dias')),
        'estatus': s(it.get('estatus'), 50),
        'observaciones': text(it.get('observaciones')),
        'mes': tiny_or_none(it.get('mes')),
    }


def save_gastos(items):
    return replace_table('gastos', 'gastos', items, gasto_row)


def save_entregas(items):
    return replace_table('entregas', 'entregas', items, entrega_row)
