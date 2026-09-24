import msoffcrypto, io, openpyxl, json

EXCEL_PATH = r'Z:\1.REQUISICIONES\6. REQUISICIONES 2026\12.- MANTENIMIENTO\2.-  MANTENIMIENTO_2026.xlsx'
OUT_PATH = r'C:\metricos\data\gastos.json'
PASSWORD = 'FLOWERS26'

def to_float(v):
    if v is None: return None
    if isinstance(v, (int, float)): return float(v)
    if isinstance(v, str):
        v = v.strip().replace(',', '')
        try: return float(v)
        except: return None
    return None

def fmt_date(v):
    if v is None: return ''
    if hasattr(v, 'strftime'): return v.strftime('%Y-%m-%d')
    s = str(v).strip()
    if len(s) >= 10: return s[:10]
    return ''

print("Leyendo archivo...", flush=True)
with open(EXCEL_PATH, 'rb') as f:
    office_file = msoffcrypto.OfficeFile(f)
    office_file.load_key(password=PASSWORD)
    decrypted = io.BytesIO()
    office_file.decrypt(decrypted)
    decrypted.seek(0)
    print("Descifrado OK. Cargando workbook...", flush=True)
    wb = openpyxl.load_workbook(decrypted, data_only=True)
    print(f"Hojas: {wb.sheetnames}", flush=True)

    all_data = {}
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows = []
        for r in range(7, ws.max_row + 1):
            proveedor = ws.cell(r, 2).value
            producto = ws.cell(r, 6).value

            if proveedor is None and producto is None:
                continue

            cot_num = ws.cell(r, 1).value

            cot_f = to_float(cot_num)
            if cot_f is None and cot_num is not None:
                continue

            fecha_elab = ws.cell(r, 3).value
            fecha_recep = ws.cell(r, 4).value
            moneda = ws.cell(r, 5).value
            obs = ws.cell(r, 7).value
            cant = ws.cell(r, 8).value
            unidad = ws.cell(r, 9).value
            precio = ws.cell(r, 10).value
            importe_val = ws.cell(r, 11).value
            iva_pct = ws.cell(r, 12).value
            iva_val = ws.cell(r, 13).value
            total_partida = ws.cell(r, 20).value
            termino = ws.cell(r, 21).value
            ref_cot = ws.cell(r, 22).value
            proyecto = ws.cell(r, 24).value
            estatus = ws.cell(r, 31).value
            comentarios = ws.cell(r, 32).value
            po = ws.cell(r, 30).value

            cant_f = to_float(cant)
            precio_f = to_float(precio)

            imp = to_float(importe_val)
            if imp is None and cant_f and precio_f:
                imp = cant_f * precio_f

            iva_f = to_float(iva_pct)
            iva = to_float(iva_val)
            if iva is None and imp and iva_f:
                iva = imp * iva_f

            total = to_float(total_partida)
            if total is None and imp is not None:
                iva_amt = iva if iva else 0
                total = imp + iva_amt

            rows.append({
                'cotizacion_num': cot_num,
                'proveedor': str(proveedor or ''),
                'fecha_elaboracion': fmt_date(fecha_elab),
                'fecha_recepcion': fmt_date(fecha_recep),
                'moneda': str(moneda or ''),
                'producto': str(producto or ''),
                'observaciones': str(obs or ''),
                'cantidad': cant_f,
                'unidad': str(unidad or ''),
                'precio_unitario': precio_f,
                'importe': round(imp, 2) if imp else None,
                'iva_pct': iva_f,
                'iva': round(iva, 2) if iva else None,
                'total_partida': round(total, 2) if total else None,
                'termino_pago': str(termino or ''),
                'ref_cotizacion': str(ref_cot or ''),
                'proyecto': str(proyecto or ''),
                'estatus': str(estatus or '')[:10] if estatus else '',
                'comentarios': str(comentarios or ''),
                'po': str(po or '').strip()
            })
        all_data[sheet_name] = rows
        print(f'  {sheet_name}: {len(rows)} partidas', flush=True)

    with open(OUT_PATH, 'w', encoding='utf-8') as out:
        json.dump(all_data, out, ensure_ascii=False, indent=2)
    print(f'Guardado en {OUT_PATH}', flush=True)
