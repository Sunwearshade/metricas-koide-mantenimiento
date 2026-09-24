import msoffcrypto, io, openpyxl, re
from datetime import datetime
from collections import defaultdict

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

def to_float(v):
    if v is None: return None
    if isinstance(v, (int, float)): return float(v)
    if isinstance(v, str):
        v = v.strip().replace(',', '')
        try: return float(v)
        except: return None
    return None

with open(EXCEL_PATH, 'rb') as f:
    office_file = msoffcrypto.OfficeFile(f)
    office_file.load_key(password=PASSWORD)
    decrypted = io.BytesIO()
    office_file.decrypt(decrypted)
    decrypted.seek(0)
    wb = openpyxl.load_workbook(decrypted, data_only=True)

    ws = wb['8.AGOSTO']

    print('=== AGOSTO: TODAS LAS FILAS - Cada columna posible ===')
    print('Row | Cot | PO(col30) | Moneda | Importe(11) | IVA(13) | Total20 | Total25 | FechaEntrega')
    print('-' * 120)

    sum_col11 = 0
    sum_col13 = 0
    sum_col20 = 0
    sum_col25_all = 0
    sum_col25_with_po = 0
    sum_col25_no_po = 0
    count_col25 = 0
    count_po = 0
    count_no_po = 0

    for r in range(8, ws.max_row + 1):
        proveedor = ws.cell(r, 2).value
        producto = ws.cell(r, 6).value
        if proveedor is None and producto is None:
            continue
        cot = ws.cell(r, 1).value
        if cot is None:
            continue
        if isinstance(cot, str):
            try: float(cot.strip())
            except: continue
        elif not isinstance(cot, (int, float)):
            continue

        po_raw = ws.cell(r, 30).value
        po = str(po_raw or '').strip()
        tiene_po = bool(po)

        fecha_raw = ws.cell(r, 4).value
        fecha_str = parse_fecha(fecha_raw)

        moneda = str(ws.cell(r, 5).value or '').strip()
        c11 = to_float(ws.cell(r, 11).value) or 0
        c13 = to_float(ws.cell(r, 13).value) or 0
        c20 = to_float(ws.cell(r, 20).value) or 0
        c25 = to_float(ws.cell(r, 25).value) or 0

        sum_col11 += c11
        sum_col13 += c13
        sum_col20 += c20
        sum_col25_all += c25

        if c25 > 0:
            count_col25 += 1
            if tiene_po:
                sum_col25_with_po += c25
            else:
                sum_col25_no_po += c25

        if tiene_po:
            count_po += 1
        else:
            count_no_po += 1

        print('  R%d | %s | PO=%-8s | %s | %12.2f | %10.2f | %10.2f | %10.2f | %s' % (
            r, str(cot)[:4], po if po else '---', moneda, c11, c13, c20, c25, fecha_str))

    print()
    print('=== TOTALES AGOSTO SHEET ===')
    print('  Col11 (IMPORTE):    $%s' % '{:,.2f}'.format(sum_col11))
    print('  Col13 (IVA):        $%s' % '{:,.2f}'.format(sum_col13))
    print('  Col20 (TOT PARTIDA): $%s' % '{:,.2f}'.format(sum_col20))
    print('  Col25 (TOTAL PO):   $%s (todos: %d, con PO: %d, sin PO: %d)' % (
        '{:,.2f}'.format(sum_col25_all), count_col25, sum_col25_with_po, sum_col25_no_po))
    print('  Filas con PO: %d | Sin PO: %d' % (count_po, count_no_po))
    print()
    print('  Col11 + Col13 = $%s' % '{:,.2f}'.format(sum_col11 + sum_col13))
    print('  Col20 (ya incluye IVA) = $%s' % '{:,.2f}'.format(sum_col20))

    # Now check: what does the user see? Maybe they sum ALL items with PO across ALL sheets
    # and use a different column. Let me check the TOTAL DE PO column (col25) for each unique PO
    print()
    print('=== UNIQUE POs in AGOSTO sheet with their totals ===')
    po_groups = defaultdict(lambda: {'rows': 0, 'col20': 0, 'col25': 0, 'moneda': set()})
    for r in range(8, ws.max_row + 1):
        proveedor = ws.cell(r, 2).value
        producto = ws.cell(r, 6).value
        if proveedor is None and producto is None: continue
        cot = ws.cell(r, 1).value
        if cot is None: continue
        po_raw = ws.cell(r, 30).value
        po = str(po_raw or '').strip()
        moneda = str(ws.cell(r, 5).value or '').strip()
        c20 = to_float(ws.cell(r, 20).value) or 0
        c25 = to_float(ws.cell(r, 25).value) or 0
        if po:
            po_groups[po]['rows'] += 1
            po_groups[po]['col20'] += c20
            if c25 > 0: po_groups[po]['col25'] = c25
            po_groups[po]['moneda'].add(moneda)

    total_po20 = 0
    total_po25 = 0
    for po in sorted(po_groups.keys()):
        g = po_groups[po]
        total_po20 += g['col20']
        total_po25 += g['col25'] if g['col25'] > 0 else g['col20']
        print('  PO %-8s | %d rows | Col20=$%s | Col25=$%s | monedas=%s' % (
            po, g['rows'], '{:,.2f}'.format(g['col20']),
            '{:,.2f}'.format(g['col25']) if g['col25'] > 0 else 'igual col20',
            ','.join(g['moneda'])))
    print()
    print('  SUMA Col20 por PO: $%s' % '{:,.2f}'.format(total_po20))
    print('  SUMA Col25 por PO (o col20 si vacio): $%s' % '{:,.2f}'.format(total_po25))
