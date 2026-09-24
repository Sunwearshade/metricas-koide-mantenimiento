import msoffcrypto, io, openpyxl, json, re
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
        return f'{year}-{month:02d}-{day:02d}'
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

    # For each sheet, compare col 25 (TOTAL DE PO) vs col 20 (TOTAL PARTIDA)
    for sname in wb.sheetnames:
        ws = wb[sname]
        print(f'\n=== {sname} ===')
        col25_total = 0
        col20_total = 0
        iva_total = 0
        importe_total = 0
        count = 0
        for r in range(7, ws.max_row + 1):
            proveedor = ws.cell(r, 2).value
            producto = ws.cell(r, 6).value
            if proveedor is None and producto is None:
                continue
            cot = ws.cell(r, 1).value
            if isinstance(cot, str):
                try: float(cot.strip())
                except: continue
            elif cot is None:
                continue
            elif not isinstance(cot, (int, float)):
                continue
            po = ws.cell(r, 30).value
            if not po or not str(po).strip():
                continue
            count += 1
            c25 = to_float(ws.cell(r, 25).value)
            c20 = to_float(ws.cell(r, 20).value)
            imp = to_float(ws.cell(r, 11).value)
            iva = to_float(ws.cell(r, 13).value)
            if c25: col25_total += c25
            if c20: col20_total += c20
            if imp: importe_total += imp
            if iva: iva_total += iva
        print(f'  Con PO: {count}')
        print(f'  Col25 (TOTAL DE PO): ${col25_total:,.2f}')
        print(f'  Col20 (TOTAL PARTIDA): ${col20_total:,.2f}')
        print(f'  Col11 (IMPORTE): ${importe_total:,.2f}')
        print(f'  Col13 (IVA): ${iva_total:,.2f}')

    # Detailed AGOSTO analysis
    print('\n\n=== DETALLE AGOSTO POR MES DE ENTREGA ===')
    ws = wb['8.AGOSTO']
    mes_po = Counter()
    mes_partida = Counter()
    mes_iva = Counter()
    mes_count = Counter()
    for r in range(7, ws.max_row + 1):
        proveedor = ws.cell(r, 2).value
        producto = ws.cell(r, 6).value
        if proveedor is None and producto is None:
            continue
        po = ws.cell(r, 30).value
        if not po or not str(po).strip():
            continue
        fecha = ws.cell(r, 4).value
        fs = parse_fecha(fecha)
        mi = fecha_mes_idx(fs)
        if mi < 0:
            print(f'  Row{r}: SIN MES VALIDO fecha={fs} prov={str(proveedor)[:30]}')
            continue
        c25 = to_float(ws.cell(r, 25).value) or 0
        c20 = to_float(ws.cell(r, 20).value) or 0
        iva = to_float(ws.cell(r, 13).value) or 0
        mes_po[mi] += c25
        mes_partida[mi] += c20
        mes_iva[mi] += iva
        mes_count[mi] += 1

    for i in range(12):
        if mes_count[i]:
            print(f'  {MESES[i]}: {mes_count[i]} partidas, TOTAL PO=${mes_po[i]:,.2f}, TOTAL PARTIDA=${mes_partida[i]:,.2f}, IVA=${mes_iva[i]:,.2f}')

    # Show rows with dates in Aug that land in other months
    print('\n=== FILAS AGOSTO con fecha entrega en AGO ===')
    ws = wb['8.AGOSTO']
    aug_total_po = 0
    aug_total_partida = 0
    aug_count = 0
    for r in range(7, ws.max_row + 1):
        proveedor = ws.cell(r, 2).value
        producto = ws.cell(r, 6).value
        if proveedor is None and producto is None:
            continue
        po = ws.cell(r, 30).value
        if not po or not str(po).strip():
            continue
        fecha = ws.cell(r, 4).value
        fs = parse_fecha(fecha)
        mi = fecha_mes_idx(fs)
        if mi == 7:  # Aug = index 7
            c25 = to_float(ws.cell(r, 25).value) or 0
            c20 = to_float(ws.cell(r, 20).value) or 0
            obs = str(ws.cell(r, 7).value or '')[:40]
            aug_total_po += c25
            aug_total_partida += c20
            aug_count += 1
            if aug_count <= 10:
                print(f'  Row{r}: PO#{po} fecha={fs} TOTAL_PO=${c25:,.2f} TOTAL_PARTIDA=${c20:,.2f} prov={str(proveedor)[:25]} obs={obs}')
    print(f'  TOTAL AGO partidas={aug_count}, TOTAL_PO=${aug_total_po:,.2f}, TOTAL_PARTIDA=${aug_total_partida:,.2f}')
