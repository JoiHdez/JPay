# Contrato entre roles

J-Pay separa funciones como lo haría un control interno: **quien pide no autoriza, quien autoriza no registra, y quien registra ve todo**. Cada rol tiene su pantalla y su rama. Lo compartido se cambia en `main` y luego cada rama lo trae.

## Quién es dueño de qué

| Rol | Pantalla | Rama | Servidor (rutas y módulos) |
|---|---|---|---|
| **Solicitante** (pide la compra) | `public/solicitante.html` | `joel/solicitante` | `POST /api/intents`, `POST /api/intents/recotizar`, `POST /api/intents/documento`, `src/agente.js` |
| **Finanzas** (autoriza el pago) | `public/finanzas.html` | `jordy/autorizador` | `POST /api/intents/aprobar`, `POST /api/tarjeta`, `GET /retorno`, `src/guard.js` |
| **Contador** (registra y cierra) | `public/contador.html` | `contador` | `POST /api/facturas`, `POST /api/cierre` |

**Compartido (solo en `main`, con aviso):** `public/comun.js`, `public/comun.css`, `public/index.html`, `src/ledger.js`, `src/catalogo.js`, `src/reap.js`, `GET /api/estado`. Todo cambio a `ledger.js` o `guard.js` va con su prueba en `test/`.

## El intent: lo que pasa de un rol a otro

El solicitante lo crea con `POST /api/intents`:

```json
{ "solicitante": "Ana (Operaciones)", "cc": "OPS", "busqueda": "laundry detergent",
  "categoria": "oficina", "cantidad": 1, "maxCantidad": 2, "topeUsd": 45 }
```

- `cc`: `MKT`, `IT` u `OPS` (`src/catalogo.js`).
- `categoria`: `oficina`, `software`, `marketing` o `computo`. Define la cuenta contable.
- Si el tope no cabe en el presupuesto del centro de costo, responde `409` y no nace el intent.

Todos lo leen en `GET /api/estado` → `intents[]`. Campos que usan las otras pantallas:

| Campo | Significado |
|---|---|
| `id` | `INT-xxxxxxxx`; también es la raíz de las llaves de idempotencia |
| `estado` | `APROBADO` (comprometido, sin pagar) → `EN_CHECKOUT` → `COMPLETADO`; o `FALLIDO` / `EXPIRADO` |
| `cotizacion` | `LISTA` (el guard la permite), `BLOQUEADA` (el guard la frena) o `ERROR` |
| `guard.violaciones[]` | `{ codigo, mensaje }`, por ejemplo `CANTIDAD`, `ENVIO`, `TOPE` |
| `producto`, `propuesta`, `totalUsd`, `envioNombre`, `expira` | lo que cotizó el agente en Reap |
| `orderId`, `finalUsd` | al completarse el checkout |
| `factura` | `{ folio, total, fecha }` cuando el contador la adjunta |

## Las entregas entre roles

1. **Solicitante → finanzas:** un intent con `estado: APROBADO` y `cotizacion: LISTA` aparece en la bandeja de finanzas. Si está `BLOQUEADA`, finanzas lo ve en rojo y el servidor rechaza la aprobación.
2. **Finanzas → Reap → contador:** `POST /api/intents/aprobar` devuelve la URL de la página hosted de Reap. Al volver (`/retorno`), el servidor contabiliza y redirige a `/finanzas.html`. El contador ve los asientos en `asientos[]`.
3. **Contador:** adjunta la factura por `orderId` y total, y cierra el mes.

## Reglas para no chocar

- Cada quien edita solo su pantalla y sus rutas. Si necesitas un campo nuevo en el intent o en `/api/estado`, se agrega en `main` y cada rama hace `git merge main`.
- Nadie cambia el formato de un campo existente sin acordarlo; se agrega uno nuevo.
- Antes de un PR a `main`: `npm test` en verde.
