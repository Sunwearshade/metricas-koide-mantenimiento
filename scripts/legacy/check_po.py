import json
d = json.load(open(r'C:\metricos\data\gastos.json', 'r', encoding='utf-8'))
for sheet in d:
    rows = d[sheet]
    with_po = [r for r in rows if r.get('po')]
    print(f'{sheet}: {len(rows)} total, {len(with_po)} con PO')
    for r in with_po[:3]:
        po_val = r['po']
        prov = r['proveedor'][:40]
        print(f'  PO={po_val}  prov={prov}')
