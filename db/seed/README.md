# Datos iniciales

| Qué | Fuente | Cómo se carga |
|---|---|---|
| Datos históricos de la app (contramedidas, fotos, bonos, plantilla, calendarios, documentos) | `data/*.json` + archivos en `data/` | `npm run migrate` (no destructiva, repetible) |
| Copia inicial de fuentes externas (paros y máquinas de koide, gastos y entregas de los Excel) | `data/tiempo-muerto.json`, `data/gastos.json`, `data/entregas.json` | `npm run migrate` (solo si la fuente nunca se ha sincronizado) |
| Usuarios de **desarrollo** `admin` / `operador` | `scripts/seed-dev.js` | `npm run seed:dev` (no corre con `NODE_ENV=production`) |
| Usuarios de producción | — | `node scripts/usuarios.js crear ...` |

Los usuarios no se guardan como SQL fijo porque la contraseña se guarda con hash
(scrypt con sal aleatoria): el script la calcula al crear el usuario.
