import msoffcrypto, io, openpyxl, re
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

    # Show headers
    ws = wb['8.AGOSTO']
    print('=== HEADERS AGOSTO ===')
    for c in range(1, 35):
        v = ws.cell(5, c).value or ws.cell(6, c).value or ws.cell(4, c).value
        if v: print('  Col%d: %s' % (c, str(v).strip()))
    print()

    # Per-sheet, per-delivery-month detail
    for sname in ['7.JULIO', '8.AGOSTO']:
        ws = wb[sname]
        print('=== %s ===' % sname)
        from collections import defaultdict
        by_mes = defaultdict(lambda: {'count': 0, 'col20': 0, 'col25': 0, 'iva': 0, 'importe': 0})
        sin_po = 0
        sin_fecha = 0
        total_rows = 0
        for r in range(7, ws.max_row + 1):
            proveedor = ws.cell(r, 2).value
            producto = ws.cell(r, 6).value
            if proveedor is None and producto is None: continue
            cot = ws.cell(r, 1).value
            if cot is not None:
                if isinstance(cot, str):
                    try: float(cot.strip())
                    except: continue
                elif not isinstance(cot, (int, float)): continue
            total_rows += 1
            po_raw = ws.cell(r, 30).value
            po = str(po_raw or '').strip()
            if not po: sin_po += 1; continue
            fecha_raw = ws.cell(r, 4).value
            fecha_str = parse_fecha(fecha_raw)
            mi = fecha_mes_idx(fecha_str)
            cant = to_float(ws.cell(r, 8).value)
            precio = to_float(ws.cell(r, 10).value)
            importe = to_float(ws.cell(r, 11).value)
            iva = to_float(ws.cell(r, 13).value)
            c20 = to_float(ws.cell(r, 20).value)
            c25 = to_float(ws.cell(r, 25).value)
            prov = str(proveedor or '')[:30]
            if mi < 0:
                sin_fecha += 1
                if fecha_str:
                    print('  FECHA FUERA 2026: row%d fecha=%s prov=%s c20=%s c25=%s' % (r, fecha_str, prov, c20, c25))
                continue
            by_mes[mi]['count'] += 1
            if c20: by_mes[mi]['col20'] += c20
            if c25: by_mes[mi]['col25'] += c25
            if iva: by_mes[mi]['iva'] += iva
            if importe: by_mes[mi]['importe'] += importe
        print('  Total filas: %d, Sin PO: %d, Sin fecha valida 2026: %d' % (total_rows, sin_po, sin_fecha))
        for i in range(12):
            d = by_mes.get(i)
            if d and d['count'] > 0:
                print('  %s: %d partidas, Importe=$%s, IVA=$%s, Col20(TotalPartida)=$%s, Col25(TotalPO)=$%s' % (
                    MESES[i], d['count'],
                    '{:,.2f}'.format(d['importe']),
                    '{:,.2f}'.format(d['iva']),
                    '{:,.2f}'.format(d['col20']),
                    '{:,.2f}'.format(d['col25'])))
        print()

    # Cross-sheet: ALL sheets, items by delivery month, col25
    print('=== TODAS LAS HOJAS - Por mes de entrega - Col25 (TOTAL DE PO) ===')
    by_mes_all = defaultdict(lambda: {'count': 0, 'col25': 0, 'col20': 0})
    for sname in wb.sheetnames:
        ws = wb[sname]
        for r in range(7, ws.max_row + 1):
            proveedor = ws.cell(r, 2).value
            producto = ws.cell(r, 6).value
            if proveedor is None and producto is None: continue
            po = ws.cell(r, 30).value
            if not po or not str(po).strip(): continue
            fecha_str = parse_fecha(ws.cell(r, 4).value)
            mi = fecha_mes_idx(fecha_str)
            if mi < 0: continue
            c20 = to_float(ws.cell(r, 20).value) or 0
            c25 = to_float(ws.cell(r, 25).value) or 0
            by_mes_all[mi]['count'] += 1
            by_mes_all[mi]['col20'] += c20
            by_mes_all[mi]['col25'] += c25
    for i in range(12):
        d = by_mes_all.get(i)
        if d and d['count'] > 0:
            print('  %s: %d partidas, Col20=$%s, Col25=$%s' % (
                MESES[i], d['count'], '{:,.2f}'.format(d['col20']), '{:,.2f}'.format(d['col25'])))
