import msoffcrypto, io, openpyxl, re
from datetime import datetime

EXCEL_PATH = r'Z:\1.REQUISICIONES\6. REQUISICIONES 2026\12.- MANTENIMIENTO\2.-  MANTENIMIENTO_2026.xlsx'
PASSWORD = 'FLOWERS26'

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

    # Dump ALL rows 1-15 of AGOSTO to find headers
    ws = wb['8.AGOSTO']
    print('=== AGOSTO - Filas 1-15, todas las columnas ===')
    for r in range(1, 16):
        vals = []
        for c in range(1, 35):
            v = ws.cell(r, c).value
            if v is not None:
                s = str(v).strip()
                if len(s) > 30: s = s[:30] + '...'
                vals.append('C%d=%s' % (c, s))
        if vals:
            print('Row%d: %s' % (r, ' | '.join(vals)))

    # Also check JULIO
    ws = wb['7.JULIO']
    print('\n=== JULIO - Filas 1-15 ===')
    for r in range(1, 16):
        vals = []
        for c in range(1, 35):
            v = ws.cell(r, c).value
            if v is not None:
                s = str(v).strip()
                if len(s) > 30: s = s[:30] + '...'
                vals.append('C%d=%s' % (c, s))
        if vals:
            print('Row%d: %s' % (r, ' | '.join(vals)))
