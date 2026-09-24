import msoffcrypto, io, openpyxl, re, json
from datetime import datetime
from collections import Counter, defaultdict

EXCEL_PATH = r'Z:\1.REQUISICIONES\6. REQUISICIONES 2026\12.- MANTENIMIENTO\2.-  MANTENIMIENTO_2026.xlsx'
PASSWORD = 'FLOWERS26'

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

    items = []
    sheet_stats = {}

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        count_with_po = 0
        count_no_po = 0
        total_with_po = 0
        total_no_po = 0

        for r in range(8, ws.max_row + 1):
            proveedor = ws.cell(r, 2).value
            producto = ws.cell(r, 6).value
            if proveedor is None and producto is None:
                continue

            cot = ws.cell(r, 1).value
            if cot is None:
                continue
            if isinstance(cot, str):
                try:
                    float(cot.strip())
                except:
                    continue
            elif not isinstance(cot, (int, float)):
                continue

            po_raw = ws.cell(r, 30).value
            po = str(po_raw or '').strip()
            tiene_po = bool(po)

            fecha_raw = ws.cell(r, 4).value
            fecha_str = parse_fecha(fecha_raw)
            mes_idx = fecha_mes_idx(fecha_str)

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

            if total_partida is None:
                total_partida = 0
            if importe is None:
                importe = 0
            if iva is None:
                iva = 0

            item = {
                'sheet': sheet_name,
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
                'fecha_elaboracion': parse_fecha(ws.cell(r, 3).value),
                'fecha_entrega': fecha_str,
                'mes_entrega': mes_idx,
                'moneda': str(ws.cell(r, 5).value or ''),
                'proyecto': str(ws.cell(r, 24).value or ''),
                'termino_pago': str(ws.cell(r, 21).value or ''),
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

    with open(r'C:\metricos\data\gastos.json', 'w', encoding='utf-8') as out:
        json.dump(items, out, ensure_ascii=False, indent=2)

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
    print('=== POR MES DE ENTREGA (TODAS LAS HOJAS) ===')
    mes_data = defaultdict(lambda: {
        'confirmado': 0, 'pendiente': 0,
        'count_conf': 0, 'count_pend': 0,
        'iva_conf': 0, 'iva_pend': 0,
        'subtotal_conf': 0, 'subtotal_pend': 0,
    })
    sin_mes = {'confirmado': 0, 'pendiente': 0, 'count_conf': 0, 'count_pend': 0}

    for it in items:
        mi = it['mes_entrega']
        tp = it['total_partida']
        imp = it['importe']
        iva_v = it['iva']

        if mi < 0:
            if it['tiene_po']:
                sin_mes['confirmado'] += tp
                sin_mes['count_conf'] += 1
            else:
                sin_mes['pendiente'] += tp
                sin_mes['count_pend'] += 1
            continue

        if it['tiene_po']:
            mes_data[mi]['confirmado'] += tp
            mes_data[mi]['count_conf'] += 1
            mes_data[mi]['iva_conf'] += iva_v
            mes_data[mi]['subtotal_conf'] += imp
        else:
            mes_data[mi]['pendiente'] += tp
            mes_data[mi]['count_pend'] += 1
            mes_data[mi]['iva_pend'] += iva_v
            mes_data[mi]['subtotal_pend'] += imp

    grand_conf = 0
    grand_pend = 0
    for i in range(12):
        d = mes_data.get(i)
        if d and (d['count_conf'] > 0 or d['count_pend'] > 0):
            total_mes = d['confirmado'] + d['pendiente']
            grand_conf += d['confirmado']
            grand_pend += d['pendiente']
            print('  %s: CON PO=%d ($%s) | SIN PO=%d ($%s) | TOTAL=$%s' % (
                MESES[i],
                d['count_conf'], '{:,.2f}'.format(d['confirmado']),
                d['count_pend'], '{:,.2f}'.format(d['pendiente']),
                '{:,.2f}'.format(total_mes)))

    if sin_mes['count_conf'] > 0 or sin_mes['count_pend'] > 0:
        print('  SIN MES: CON PO=%d ($%s) | SIN PO=%d ($%s)' % (
            sin_mes['count_conf'], '{:,.2f}'.format(sin_mes['confirmado']),
            sin_mes['count_pend'], '{:,.2f}'.format(sin_mes['pendiente'])))

    print()
    print('TOTAL GENERAL: Confirmado=$%s | Pendiente=$%s | GRAN TOTAL=$%s' % (
        '{:,.2f}'.format(grand_conf),
        '{:,.2f}'.format(grand_pend),
        '{:,.2f}'.format(grand_conf + grand_pend)))
