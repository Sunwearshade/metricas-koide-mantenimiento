import msoffcrypto, io, openpyxl, re
from datetime import datetime

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
    print('=== AGOSTO: TODAS LAS FILAS CON PO, por fecha entrega ===')
    total_ago_conf = 0
    total_ago_pend = 0
    total_all_conf = 0
    total_all_pend = 0
    row_count = 0
    
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

        row_count += 1
        po_raw = ws.cell(r, 30).value
        po = str(po_raw or '').strip()
        tiene_po = bool(po)
        
        fecha_raw = ws.cell(r, 4).value
        fecha_str = parse_fecha(fecha_raw)
        
        moneda = str(ws.cell(r, 5).value or '').strip()
        importe = to_float(ws.cell(r, 11).value) or 0
        iva = to_float(ws.cell(r, 13).value) or 0
        total20 = to_float(ws.cell(r, 20).value)
        if total20 is None:
            total20 = importe + iva
        
        status = 'CONF' if tiene_po else 'PEND'
        
        # Only show items with fecha entrega in Aug 2026
        if fecha_str and fecha_str.startswith('2026-08'):
            total_ago_conf += total20 if tiene_po else 0
            total_ago_pend += total20 if not tiene_po else 0
            total_all_conf += total20 if tiene_po else 0
            total_all_pend += total20 if not tiene_po else 0
            print('  Row%d [%s] %s | fecha=%s | moneda=%s | importe=%.2f | iva=%.2f | total20=%.2f | po=%s | prov=%s' % (
                r, status, producto, fecha_str, moneda, importe, iva, total20, po, str(proveedor)[:30]))
        else:
            # Items NOT in Aug delivery
            total_all_conf += total20 if tiene_po else 0
            total_all_pend += total20 if not tiene_po else 0

    print()
    print('RESUMEN AGOSTO (items con fecha entrega en Ago 2026):')
    print('  Confirmados: $%.2f' % total_ago_conf)
    print('  Pendientes: $%.2f' % total_ago_pend)
    print('  TOTAL: $%.2f' % (total_ago_conf + total_ago_pend))
    print()
    print('TODOS los items de la hoja AGOSTO (sin filtro de fecha):')
    print('  Confirmados: $%.2f' % total_all_conf)
    print('  Pendientes: $%.2f' % total_all_pend)
    print('  TOTAL: $%.2f' % (total_all_conf + total_all_pend))
    print('  Total filas procesadas: %d' % row_count)
