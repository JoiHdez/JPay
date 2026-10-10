# Contrato entre roles

J-Pay separa funciones como lo haría un control interno: **quien pide no autoriza, quien autoriza no registra, y quien registra ve todo**. Cada rol tiene su pantalla y su rama. Lo compartido se cambia en `main` y luego cada rama lo trae.

## Quién es dueño de qué

| Rol | Pantalla | Rama | Servidor (rutas y módulos) |
|---|---|---|---|
| **Solicitante** (pide la compra) | `public/solicitante.html` | `joel/solicitante` | `POST /api/intents`, `POST /api/intents/recotizar`, `POST /api/intents/documento`, `src/agente.js` |
| **Finanzas** (autoriza el pago) | `public/finanzas.html` | `jordy/autorizador` | `POST /api/intents/aprobar`, `POST /api/intents/rechazar`, `POST /api/intents/cambios`, `POST /api/tarjeta`, `GET /retorno`, `src/guard.js` |
| **Contador** (registra y cierra) | `public/contador.html` | `contador` | `POST /api/facturas`, `POST /api/cierre` |

**Compartido (solo en `main`, con aviso):** `public/comun.js`, `public/comun.css`, `public/index.html`, `src/ledger.js`, `src/catalogo.js`, `src/reap.js`, `GET /api/estado`. Todo cambio a `ledger.js` o `guard.js` va con su prueba en `test/`.

## API del aprobador

Este contrato es la fuente de verdad del flujo del aprobador.

> **Estado de implementación:** es el formato destino. Mientras no se migre (pendiente de acordar con Solicitante y con las ramas de Codex), `GET /api/estado` sigue sirviendo el formato anterior: `estado` `APROBADO → EN_CHECKOUT → COMPLETADO | FALLIDO | EXPIRADO`, `cotizacion` `LISTA | BLOQUEADA | ERROR`, montos en USD y `error` como texto. Lo nuevo se agrega sin cambiar el tipo de los campos existentes.

### Estados

```
COTIZADA | SIN_COTIZACION | BLOQUEADA | CAMBIOS_SOLICITADOS | RECHAZADA | EXPIRADA | AUTORIZADA | EN_PAGO | PAGADA | FALLIDA
```

Transiciones:

```
COTIZADA -> AUTORIZADA | RECHAZADA | CAMBIOS_SOLICITADOS | EXPIRADA
BLOQUEADA -> COTIZADA (recotizar) | RECHAZADA
AUTORIZADA -> EN_PAGO | FALLIDA
EN_PAGO -> PAGADA | FALLIDA
SIN_COTIZACION | EXPIRADA | CAMBIOS_SOLICITADOS -> COTIZADA (recotizar)
```

Terminales: `PAGADA`, `RECHAZADA`, `FALLIDA`.

Montos: centavos enteros en la API; la UI formatea.

### Intent en `GET /api/estado`

```
{ id, estado, descripcion, centroCosto, solicitante, justificacion,
  producto: { nombre, variante, comercio, imagen },
  cotizacion: { quoteId, expiraEn, moneda, desglose: { producto, envio, impuesto, descuento, total } } | null,
  guard: { permitido, reglas: [ { codigo, ok, mensaje } ] },
  presupuesto: { tope, disponibleAntes, disponibleDespues, pctTope },
  preAsiento: [ { cuenta, nombre, debe, haber } ],
  checkout: { checkoutId, urlAprobacion, estadoReap, orderId, finalAmount } | null,
  decision: { por, en, accion, motivo } | null,     accion: AUTORIZAR | RECHAZAR | CAMBIOS
  error: { codigo, mensaje, detalle } | null,
  traza: [ { en, actor, evento, datos } ] }
```

Raíz de `/api/estado`: `modo: { reap: "sandbox" | "simulado", checkout: "hosted" | "simulado" }`

### Rutas

```
POST /api/intents/aprobar   { id, por, confirmarTotal? }
POST /api/intents/rechazar  { id, por, motivo }
POST /api/intents/cambios   { id, por, comentario }
POST /api/intents/recotizar { id }
```

### Errores

4xx con `{ error: { codigo, mensaje, detalle } }`

Códigos: `QUOTE_EXPIRADO`, `TOTAL_CAMBIO` (trae el nuevo desglose), `GUARD_BLOQUEO`, `SIN_COTIZACION`, `REAP_RECHAZO`, `TRANSICION_INVALIDA`

## Reglas para no chocar

- Cada quien edita solo su pantalla y sus rutas. Si necesitas un campo nuevo en el intent o en `/api/estado`, se agrega en `main` y cada rama hace `git merge main`.
- Nadie cambia el formato de un campo existente sin acordarlo; se agrega uno nuevo.
- Antes de un PR a `main`: `npm test` en verde.
