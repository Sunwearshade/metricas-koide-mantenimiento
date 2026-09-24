import msoffcrypto, io, openpyxl, re, json
from datetime import datetime
from collections import Counter

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
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        count = 0
        for r in range(7, ws.max_row + 1):
            proveedor = ws.cell(r, 2).value
            producto = ws.cell(r, 6).value
            if proveedor is None and producto is None:
                continue
            cot = ws.cell(r, 1).value
            cot_f = to_float(cot)
            if cot_f is None and cot is not None:
                continue
            po_raw = ws.cell(r, 30).value
            po = str(po_raw or '').strip()
            if not po:
                continue
            fecha_raw = ws.cell(r, 4).value
            fecha_str = parse_fecha(fecha_raw)
            mes_idx = fecha_mes_idx(fecha_str)
            cant = to_float(ws.cell(r, 8).value)
            precio = to_float(ws.cell(r, 10).value)
            importe = to_float(ws.cell(r, 11).value)
            if importe is None and cant and precio:
                importe = cant * precio
            iva_pct = to_float(ws.cell(r, 12).value)
            iva = to_float(ws.cell(r, 13).value)
            total20 = to_float(ws.cell(r, 20).value)
            total25 = to_float(ws.cell(r, 25).value)
            if total20 is None and importe is not None:
                iva_amt = iva if iva else (importe * iva_pct if iva_pct else 0)
                total20 = importe + iva_amt
            items.append({
                'sheet': sheet_name,
                'proveedor': str(proveedor or ''),
                'producto': str(producto or ''),
                'observaciones': str(ws.cell(r, 7).value or ''),
                'cantidad': cant,
                'unidad': str(ws.cell(r, 9).value or ''),
                'precio_unitario': precio,
                'importe': round(importe, 2) if importe else None,
                'iva': round(iva, 2) if iva else None,
                'total_partida': round(total20, 2) if total20 else None,
                'total_po_col': round(total25, 2) if total25 else None,
                'po': po,
                'fecha_elaboracion': parse_fecha(ws.cell(r, 3).value),
                'fecha_entrega': fecha_str,
                'mes_entrega': mes_idx,
                'moneda': str(ws.cell(r, 5).value or ''),
                'proyecto': str(ws.cell(r, 24).value or ''),
                'termino_pago': str(ws.cell(r, 21).value or ''),
            })
            count += 1
        print('  %s: %d partidas' % (sheet_name, count))

    with open(r'C:\metricos\data\gastos.json', 'w', encoding='utf-8') as out:
        json.dump(items, out, ensure_ascii=False, indent=2)

    print('\nTotal: %d partidas' % len(items))
    print('\nResumen por mes de entrega (usando COL 20 = total_partida):')
    mes_count = Counter()
    mes_total20 = Counter()
    mes_total25 = Counter()
    mes_iva = Counter()
    for it in items:
        mi = it['mes_entrega']
        mes_count[mi] += 1
        if it['total_partida']: mes_total20[mi] += it['total_partida']
        if it['total_po_col']: mes_total25[mi] += it['total_po_col']
        if it['iva']: mes_iva[mi] += it['iva']
    grand20 = 0
    grand25 = 0
    for i in range(12):
        c = mes_count.get(i, 0)
        t20 = mes_total20.get(i, 0)
        t25 = mes_total25.get(i, 0)
        iva_v = mes_iva.get(i, 0)
        grand20 += t20
        grand25 += t25
        if c > 0:
            print('  %s: %d partidas, TotalPartida=$%s  IVA=$%s  TotalPO(col25)=$%s' % (
                MESES[i], c, '{:,.2f}'.format(t20), '{:,.2f}'.format(iva_v), '{:,.2f}'.format(t25)))
    print('  TOTAL: TotalPartida=$%s  TotalPO(col25)=$%s' % ('{:,.2f}'.format(grand20), '{:,.2f}'.format(grand25)))
