import json

d = json.load(open(r'C:\metricos\data\gastos.json', 'r', encoding='utf-8'))
from collections import Counter

all_rows = []
for sheet in d:
    for r in d[sheet]:
        if r.get('po'):
            all_rows.append(r)

print(f'Total con PO: {len(all_rows)}')
print()

# Check fecha_recepcion distribution by month
month_count = Counter()
month_total = Counter()
for r in all_rows:
    fr = r.get('fecha_recepcion', '')
    if fr and len(fr) >= 7:
        m = fr[:7]  # YYYY-MM
        month_count[m] += 1
        if r.get('total_partida'):
            month_total[m] += r['total_partida']

for m in sorted(month_count.keys()):
    print(f'{m}: {month_count[m]} partidas, ${month_total[m]:,.2f}')

# Show some sample dates
print()
print('Sample fecha_recepcion values:')
dates = set(r.get('fecha_recepcion','') for r in all_rows if r.get('fecha_recepcion'))
for d_val in sorted(dates)[:20]:
    print(f'  {d_val}')
