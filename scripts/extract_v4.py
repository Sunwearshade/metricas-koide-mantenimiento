import msoffcrypto, io, openpyxl, re, json
from datetime import datetime
from collections import Counter, defaultdict

from metricos_db import require_env, save_gastos

# Rutas y contrasena en .env (usar ruta UNC \\servidor\recurso\... en el servicio de Windows)
EXCEL_PATH = require_env('GASTOS_EXCEL_PATH')
TIEMPO_PATH = require_env('ENTREGAS_EXCEL_PATH')
PASSWORD = require_env('GASTOS_EXCEL_PASSWORD')

def parse_fecha(v):
    if v is None: return ''
    if hasattr(v, 'strftime'): return v.strftime('%Y-%m-%d')
    s = str(v).strip()
    if not s: return ''
    for fmt in ('%Y-%m-%d', '%d/%m/%Y', '%d-%m-%Y'):
        try: return datetime.strptime(s, fmt).strftime('%Y-%m-%d')
        except: pass
    nums = re.findall(r'(\d{1,2})', s)
    if len(nums) >= 3:
        a, b, c = int(nums[0]), int(nums[1]), int(nums[2])
        if c > 100: year, month, day = c, a, b
        elif a > 100: year, month, day = a, b, c
        else: return ''
        if year < 100: year += 2000
        month = max(1, min(12, month))
        day = max(1, min(28, day))
        return '%04d-%02d-%02d' % (year, month, day)
    return ''

def fecha_mes_idx(fecha_str):
    if not fecha_str or len(fecha_str) < 7: return -1
    try:
        y = int(fecha_str[:4])
        m = int(fecha_str[5:7])
        if y == 2026 and 1 <= m <= 12: return m - 1
    except: pass
    return -1

def sheet_mes_idx(sheet_name):
    # Mapear nombre de hoja (1-ENERO, 2.FEBRERO, ...) a índice de mes (0..11)
    up = str(sheet_name or '').upper()
    for i, m in enumerate(['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
                           'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE']):
        if m in up:
            return i
    return -1

def to_float(v):
    if v is None: return None
    if isinstance(v, (int, float)): return float(v)
    if isinstance(v, str):
        v = v.strip().replace(',', '')
        try: return float(v)
        except: return None
    return None

MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']

with open(EXCEL_PATH, 'rb') as f:
    office_file = msoffcrypto.OfficeFile(f)
    office_file.load_key(password=PASSWORD)
    decrypted = io.BytesIO()
    office_file.decrypt(decrypted)
    decrypted.seek(0)
    wb = openpyxl.load_workbook(decrypted, data_only=True)

    # Leer TIEMPO DE ENTREGA para cruzar PO -> ESTATUS y mes de entrega real
    po_estatus = {}
    po_delivery_months = {}
    po_row_status = {}  # PO -> list of (month, status) for all rows
    try:
        te_wb = openpyxl.load_workbook(TIEMPO_PATH, data_only=True)
        te_ws = te_wb['ENTREGAS']
        for r in range(2, te_ws.max_row + 1):
            po_raw = te_ws.cell(r, 6).value
            estatus = str(te_ws.cell(r, 10).value or '').strip().upper()
            if po_raw is None: continue
            po = str(int(po_raw)) if isinstance(po_raw, (int, float)) else str(po_raw).strip()
            if not po: continue
            # Track all rows per PO
            if po not in po_row_status:
                po_row_status[po] = []
            fecha_est = te_ws.cell(r, 8).value
            m = fecha_est.month if (fecha_est and hasattr(fecha_est, 'month')) else None
            po_row_status[po].append((m, estatus))
            # Si ALGUNA fila es ENTREGADO, el PO es ENTREGADO
            if 'ENTREG' in estatus:
                po_estatus[po] = 'ENTREGADO'
            elif po not in po_estatus:
                po_estatus[po] = estatus
            # Mes de entrega estimado (col H = 8) — solo si ENTREGADO
            if fecha_est and hasattr(fecha_est, 'month') and 'ENTREG' in estatus:
                if po not in po_delivery_months:
                    po_delivery_months[po] = set()
                po_delivery_months[po].add(fecha_est.month)
        # Build set of POs where ALL rows are ENTREGADO (no PENDIENTE)
        po_all_entregado = set()
        for po, rows in po_row_status.items():
            if all(st == 'ENTREGADO' for _, st in rows):
                po_all_entregado.add(po)
        te_wb.close()
        ent_count = sum(1 for v in po_estatus.values() if v == 'ENTREGADO')
        pend_count = sum(1 for v in po_estatus.values() if v == 'PENDIENTE')
        print('TIEMPOS DE ENTREGA: %d POs (%d ENTREGADO, %d PENDIENTE)' % (
            len(po_estatus), ent_count, pend_count))
        print('POs ALL ENTREGADO: %d (sin filas PENDIENTE)' % len(po_all_entregado))
    except Exception as e:
        print('ADVERTENCIA: No se pudo leer TIEMPO DE ENTREGA: %s' % e)

    items = []
    sheet_stats = {}

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]

        # PASO 1: Construir mapa cotizacion -> PO
        # Recorrer todas las filas y para cada COT, buscar si ALGUN renglón tiene PO
        cot_po_map = {}
        for r in range(8, ws.max_row + 1):
            cot_raw = ws.cell(r, 1).value
            if cot_raw is None: continue
            if isinstance(cot_raw, str):
                try: float(cot_raw.strip())
                except: continue
            elif not isinstance(cot_raw, (int, float)):
                continue
            cot_key = int(cot_raw) if isinstance(cot_raw, float) else cot_raw
            po_raw = ws.cell(r, 30).value
            po = str(po_raw or '').strip()
            if po and cot_key not in cot_po_map:
                cot_po_map[cot_key] = po

        # PASO 2: Extraer items, propagando PO desde la cotización
        count_with_po = 0
        count_no_po = 0
        total_with_po = 0
        total_no_po = 0

        for r in range(8, ws.max_row + 1):
            proveedor = ws.cell(r, 2).value
            producto = ws.cell(r, 6).value
            if proveedor is None and producto is None:
                continue

            cot_raw = ws.cell(r, 1).value
            if cot_raw is None: continue
            if isinstance(cot_raw, str):
                try: float(cot_raw.strip())
                except: continue
            elif not isinstance(cot_raw, (int, float)):
                continue

            cot_key = int(cot_raw) if isinstance(cot_raw, float) else cot_raw

            po_raw = ws.cell(r, 30).value
            po = str(po_raw or '').strip()

            # Si este renglón NO tiene PO, heredar de la cotización
            if not po and cot_key in cot_po_map:
                po = cot_po_map[cot_key]

            tiene_po = bool(po)

            fecha_raw = ws.cell(r, 4).value
            fecha_str = parse_fecha(fecha_raw)
            # mes por HOJA (1-ENERO -> 0, 2.FEBRERO -> 1, etc.)
            mes_idx = sheet_mes_idx(sheet_name)

            cant = to_float(ws.cell(r, 8).value)
            precio = to_float(ws.cell(r, 10).value)
            importe = to_float(ws.cell(r, 11).value)
            if importe is None and cant is not None and precio is not None:
                importe = cant * precio

            iva_pct = to_float(ws.cell(r, 12).value)
            iva = to_float(ws.cell(r, 13).value)

            total_partida = to_float(ws.cell(r, 20).value)
            if total_partida is None and importe is not None:
                iva_amt = iva if iva else (importe * iva_pct if iva_pct else 0)
                total_partida = importe + iva_amt

            if total_partida is None: total_partida = 0
            if importe is None: importe = 0
            if iva is None: iva = 0

            item = {
                'sheet': sheet_name,
                'cotizacion': cot_key,
                'proveedor': str(proveedor or ''),
                'producto': str(producto or ''),
                'observaciones': str(ws.cell(r, 7).value or ''),
                'cantidad': cant,
                'unidad': str(ws.cell(r, 9).value or ''),
                'precio_unitario': precio,
                'importe': round(importe, 2),
                'iva': round(iva, 2),
                'total_partida': round(total_partida, 2),
                'po': po,
                'tiene_po': tiene_po,
                'entregado': po_estatus.get(po, '') == 'ENTREGADO' if po else False,
                'entregado_meses': sorted(po_delivery_months.get(po, [])) if po else [],
                'fecha_elaboracion': parse_fecha(ws.cell(r, 3).value),
                'fecha_entrega': fecha_str,
                'mes_entrega': mes_idx,
                'moneda': str(ws.cell(r, 5).value or ''),
                'proyecto': str(ws.cell(r, 24).value or ''),
                'termino_pago': str(ws.cell(r, 21).value or ''),
                'comentario': str(ws.cell(r, 32).value or '').strip(),
            }
            items.append(item)

            if tiene_po:
                count_with_po += 1
                total_with_po += total_partida
            else:
                count_no_po += 1
                total_no_po += total_partida

        sheet_stats[sheet_name] = {
            'with_po': count_with_po,
            'no_po': count_no_po,
            'total_po': round(total_with_po, 2),
            'total_no_po': round(total_no_po, 2),
        }

    save_gastos(items)

    print('Total items extraidos: %d' % len(items))
    print()
    print('=== RESUMEN POR HOJA ===')
    for sn in wb.sheetnames:
        st = sheet_stats.get(sn, {})
        print('  %s: Con PO=%d ($%s) | Sin PO=%d ($%s)' % (
            sn,
            st.get('with_po', 0), '{:,.2f}'.format(st.get('total_po', 0)),
            st.get('no_po', 0), '{:,.2f}'.format(st.get('total_no_po', 0))))

    print()
    print('=== GASTO POR HOJA (mes de la hoja) ===')
    mes_data = defaultdict(lambda: {
        'programado': 0, 'pendiente': 0, 'confirmado': 0, 'externo': 0,
        'count_prog': 0, 'count_pend': 0, 'count_ent': 0, 'count_ext': 0,
    })

    for it in items:
        tp = it['total_partida']
        mi = it['mes_entrega']
        if mi < 0: continue
        if it['comentario']:
            mes_data[mi]['externo'] += tp
            mes_data[mi]['count_ext'] += 1
        elif it['tiene_po']:
            mes_data[mi]['programado'] += tp
            mes_data[mi]['count_prog'] += 1
            mes_data[mi]['confirmado'] += tp
            mes_data[mi]['count_ent'] += 1
        else:
            mes_data[mi]['pendiente'] += tp
            mes_data[mi]['count_pend'] += 1

    grand_prog = 0
    grand_pend = 0
    grand_ent = 0
    grand_ext = 0
    for i in range(12):
        d = mes_data.get(i)
        if d and (d['count_prog'] > 0 or d['count_pend'] > 0 or d['count_ent'] > 0 or d['count_ext'] > 0):
            grand_prog += d['programado']
            grand_pend += d['pendiente']
            grand_ent += d['confirmado']
            grand_ext += d['externo']
            print('  %s: Con PO=%d ($%s) | Sin PO=%d ($%s) | Externo=%d ($%s)' % (
                MESES[i],
                d['count_prog'], '{:,.2f}'.format(d['programado']),
                d['count_pend'], '{:,.2f}'.format(d['pendiente']),
                d['count_ext'], '{:,.2f}'.format(d['externo'])))

    print()
    print('TOTAL: Con PO (programado)=$%s | Sin PO=$%s | Externo=$%s' % (
        '{:,.2f}'.format(grand_prog),
        '{:,.2f}'.format(grand_pend),
        '{:,.2f}'.format(grand_ext)))
