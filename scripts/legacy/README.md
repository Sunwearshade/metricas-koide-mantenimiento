# Scripts heredados (no los usa la aplicación)

Scripts de depuración/versiones anteriores del extractor de gastos. Contienen
rutas absolutas de la PC original (`C:\metricos\...`, `Z:\...`) y escriben
`gastos.json`, que la aplicación **ya no lee** (ahora los datos están en MySQL).

Se conservan solo como referencia. Los scripts vigentes son:

- `scripts/extract_v4.py` → tabla `gastos`
- `scripts/extract_entregas.py` → tabla `entregas`
