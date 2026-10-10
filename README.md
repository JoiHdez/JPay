# J-Pay

> **Pagos agénticos que se contabilizan solos.**
> Cada pago que ejecuta el agente nace como un asiento contable de partida doble. No hay nada que conciliar después.

Proyecto para el **Reap Agentic Hackathon** (Reap × OSL × Payward, sede México).

| | |
|---|---|
| **Tema** | 01 · Gasto empresarial |
| **Track** | El problema que más vale la pena |
| **API obligatoria** | Reap API · Agentic module (enrollments, products, quotes, checkouts) |
| **Entorno** | Solo sandbox. Checkout simulado, sin dinero real. |

---

## 1. El problema

En una empresa, una compra pequeña pasa por cinco manos y dos sistemas que no se hablan:

1. Alguien pide algo (chat, correo, ticket).
2. Alguien lo busca y lo compra con la tarjeta corporativa.
3. Finanzas aprueba, muchas veces después de que ya se compró.
4. Llega el estado de cuenta y alguien busca la factura.
5. Contabilidad registra el gasto y concilia, días o semanas después.

La industria ha respondido automatizando el paso 5: **conciliación de facturas con OCR e IA**. Eso resuelve un síntoma. La causa es que **el pago y su registro contable nacen separados**, y alguien tiene que volver a juntarlos.

Además, en cuanto un agente de IA puede pagar aparece un riesgo nuevo: **la manipulación del agente**. Un documento, un mensaje o una cotización con instrucciones ocultas puede hacer que el agente compre más, compre otra cosa o se salte la aprobación.

## 2. La tesis

Con pagos agénticos, el agente sabe *qué* compra, *por qué*, *a quién*, *con qué presupuesto* y *en qué cuenta* debe registrarse **antes** de que se mueva un peso. Entonces el pago y el asiento pueden ser **el mismo evento**.

**J-Pay hace conciliación en el origen.** La conciliación de facturas se vuelve un paso trivial: cuando la factura llega, solo se adjunta a un asiento que ya existe y ya cuadra.

## 3. Qué hace J-Pay

Un agente de compras con un ledger de partida doble en vivo y tres pantallas, una por rol, con segregación de funciones: quien pide no autoriza y quien autoriza no registra.

| Rol | Pantalla | Qué hace |
|---|---|---|
| Solicitante | `/solicitante.html` | pide la compra, ve el estado y comparte documentos del proveedor |
| Finanzas | `/finanzas.html` | autoriza el pago en la página hosted de Reap y registra la tarjeta |
| Contador | `/contador.html` | ledger en vivo, balanza, log del Ledger Guard, facturas y cierre de mes |

El contrato entre roles está en [`docs/CONTRATO.md`](docs/CONTRATO.md). Hoy el pedido entra desde la pantalla del solicitante; el bot de Telegram es el siguiente paso (ver §11).

### 3.1 Ciclo contable completo de un pago agéntico

| # | Momento | Evento | Asiento que genera J-Pay |
|---|---|---|---|
| 1 | El empleado pide algo | `intent` propio, aprobado contra presupuesto | **Compromiso**: cuentas de orden 8100/8000, reserva el tope en el presupuesto del centro de costo (equivale a la orden de compra) |
| 2 | El agente cotiza | `POST /agentic/products/search` → `POST /agentic/quotes` → envío más económico | **Pre-asiento propuesto**, armado desde `amountBreakdown` (subtotal, envío, impuesto) y validado por el **Ledger Guard** |
| 3 | Finanzas aprueba y se completa el pago | `POST /agentic/checkouts` → `GET /agentic/checkouts/:id` `COMPLETED` | **Devengado**: gasto o activo + impuesto contra *Tarjeta corporativa por pagar*, por `finalAmount`. Si `finalAmount` ≠ quote, **asiento de ajuste** automático a 5900. Se libera el compromiso. |
| 4 | Llega la factura del proveedor | Orden de Reap + total + folio | **Match**: se adjunta al asiento existente por `orderId` y monto. Cierra el *three-way match*. |
| 5 | Cierre de mes | Botón "Cerrar mes" | **Liquidación** de la tarjeta corporativa, balanza de comprobación y P&L por centro de costo, en segundos. |

**Three-way match nativo:** orden de compra (intent) ↔ precio y recepción (quote) ↔ pago (checkout). Los tres comparten el mismo ID de origen, así que el match no se busca: se construye.

Si el checkout termina `FAILED` o `EXPIRED`, el compromiso se libera con su propio asiento y el intent queda cerrado.

### 3.2 Ledger Guard: la partida doble como sistema de seguridad

> *La partida doble lleva 500 años detectando errores y fraude. J-Pay la usa para vigilar agentes de IA.*

Antes de crear cualquier checkout, el backend arma el pre-asiento desde el quote real de Reap y lo compara contra el compromiso aprobado. Es **determinístico**: el agente propone, la contabilidad decide (`src/guard.js`).

El guard bloquea si:

| Código | Regla |
|---|---|
| `MERCHANT` | la tienda no es la que fijó el intent |
| `PRODUCTO` | el producto no corresponde a lo pedido |
| `CANTIDAD` | la cantidad supera `maxCantidad` |
| `TOPE` | `finalAmount` supera el tope del intent |
| `PRESUPUESTO` | `finalAmount` supera el presupuesto disponible del centro de costo |
| `ENVIO` | la opción de envío viola la política (solo el más económico) |
| `MONEDA` | la moneda del quote no coincide con la del intent |
| `CUENTA` | la cuenta contable no es válida para la categoría |
| `DESCUADRE` | el pre-asiento no cuadra (Σ debe ≠ Σ haber) |
| `QUOTE_EXPIRADO` | el quote de Reap expiró |
| `INTENT_CONSUMIDO` | el intent ya se pagó o se cerró |
| `SIN_APROBACION` | algo pidió pagar sin la aprobación de finanzas |

Cada decisión queda en el log del guard con la lista de violaciones y aparece en el dashboard.

Además, `validar()` rechaza cualquier asiento descuadrado o con cuentas fuera del catálogo antes de publicarlo, y los montos se manejan en centavos para que la suma cuadre exacta.

### 3.3 Qué NO es

- No es un chatbot de "buscar, mostrar y comprar". Es un sistema contable que ejecuta pagos.
- No ve datos de tarjeta: el registro de tarjeta y la aprobación ocurren en las páginas hosted de Reap.
- No hace scraping de checkouts: todo pasa por la API de Reap.

## 4. Arquitectura

```
┌──────────────────────┐      ┌────────────────────────────────────────┐      ┌─────────────────┐
│ Pantallas por rol    │─────▶│ Servidor Node (sin dependencias)       │─────▶│ Reap API        │
│ solicitante, finanzas│◀─────│  ├─ reap.js      cliente Reap          │◀─────│ Agentic module  │
│ y contador (public/) │ poll │  ├─ agente.js    propuesta del agente  │      │ (sandbox SG)    │
│ + comun.js/comun.css │      │  ├─ guard.js     Ledger Guard          │      └─────────────────┘
│                      │      │  ├─ ledger.js    partida doble, cierre │
└──────────────────────┘      │  ├─ catalogo.js  cuentas, CC, categ.   │
                              │  └─ server.js    flujo y rutas         │
                              └───────────────────┬────────────────────┘
                                                  ▼
                                          data/jpay.json
```

Principios:

- **El backend es dueño de las credenciales de Reap.** El agente nunca llama a Reap directo; el servidor cotiza, valida y paga.
- **El enrollment ID vive en el backend** (`REAP_ENROLLMENT_ID` o `data/jpay.json`), nunca en el contexto del agente.
- **El ledger se escribe solo desde código determinístico.** El agente sugiere cuenta y centro de costo dentro de un catálogo cerrado; los montos salen siempre de Reap.
- **Ningún asiento descuadrado se publica** (`validar()` antes de cada publicación).
- **Un pago no se duplica:** cada quote y checkout lleva `Idempotency-Key` derivada del intent; el intent se reclama (`EN_CHECKOUT`) antes de llamar a Reap; y solo `COMPLETED` devenga, una vez.
- **Red inestable:** el cliente de Reap reintenta solo cuando la conexión no llegó a abrirse. Si una tienda responde `QUOTE_UNFULFILLABLE`, prueba la siguiente.

### Sobre el agente de la demo

`src/agente.js` convierte lo que llega (un pedido o un documento de proveedor) en una propuesta de compra. Es ingenuo **a propósito**: obedece lo que dice el documento, como un LLM manipulado por instrucciones ocultas. Así se ve que la defensa no depende de que el modelo se porte bien, sino del Ledger Guard. Cambiarlo por Claude con tool use no cambia el contrato (texto → propuesta).

## 5. Catálogo de cuentas

| Código | Cuenta | Tipo |
|---|---|---|
| 1100 | Bancos | Activo |
| 1300 | IVA acreditable / impuestos por recuperar | Activo |
| 1500 | Equipo de cómputo | Activo |
| 2100 | Tarjeta corporativa Reap por pagar | Pasivo |
| 5100 | Gastos de oficina | Gasto |
| 5200 | Software y suscripciones | Gasto |
| 5300 | Marketing | Gasto |
| 5400 | Fletes y envíos | Gasto |
| 5900 | Diferencias en precio | Gasto |
| 8000 | Presupuesto disponible | Orden |
| 8100 | Presupuesto comprometido | Orden |

Centros de costo de la demo (presupuesto mensual en USD, la moneda de la tarjeta): **MKT** Marketing 300, **IT** 400, **OPS** Operaciones 250. Categorías: oficina → 5100, software → 5200, marketing → 5300, cómputo → 1500.

## 6. Estructura del repo

```
JPay/
├─ src/
│  ├─ server.js      # flujo intent → quote → guard → checkout → asientos; rutas HTTP
│  ├─ reap.js        # cliente del Agentic module (real con API key, simulado sin ella)
│  ├─ ledger.js      # validar, balanza, presupuestos, asientos tipo, liquidación, P&L
│  ├─ guard.js       # Ledger Guard
│  ├─ agente.js      # propuesta del agente e instrucciones leídas de documentos
│  └─ catalogo.js    # cuentas, categorías y centros de costo
├─ public/           # index (elige rol), solicitante, finanzas, contador, comun.js/css
├─ docs/             # CONTRATO.md, diagramas de arquitectura y flujo
├─ test/             # node --test: ledger y guard
├─ .env.example
└─ README.md
```

## 7. Setup

### Requisitos

- Node 22.9 o superior (sin dependencias, no hay `npm install`)
- API key del sandbox de Reap (se entrega en persona al líder del equipo)
- URL **HTTPS** pública para los `returnUrl` de Reap: túnel o deploy

### Arranque

```bash
cp .env.example .env
npm test
npm start
```

Para desarrollar, `npm run dev` reinicia el servidor solo cada vez que cambia un archivo de `src/` (`node --watch`). `public/index.html` no necesita reinicio: basta recargar la página.

Sin `REAP_API_KEY` todo corre simulado, con respuestas que imitan las de Reap, para ensayar sin red. Con la key llena en `.env`, corre contra el sandbox real.

Túnel HTTPS para los `returnUrl` (Reap rechaza `http://localhost`):

```bash
cloudflared tunnel --url http://localhost:3010
```

Pon la URL `https://...trycloudflare.com` en `PUBLIC_URL` y reinicia.

### Registrar la tarjeta (una sola vez)

1. En el dashboard, "Registrar tarjeta en Reap" crea un enrollment `EXTERNAL` con owner `CLIENT_REFERENCE` (la empresa).
2. Se abre la página hosted de Reap; ahí se captura la tarjeta del sandbox (OTP `456789`).
3. Al volver, J-Pay lee `GET /agentic/enrollments/:id` y muestra `ACTIVE`. El ID queda en `data/jpay.json`; para fijarlo, cópialo a `REAP_ENROLLMENT_ID`.

> Los datos de la tarjeta de sandbox se capturan **solo** en la página de Reap. No se guardan en el repo, en `.env` ni en el contexto del agente.

## 8. Uso de la API de Reap

| Paso | Endpoint | Notas |
|---|---|---|
| Registrar tarjeta | `POST /agentic/enrollments` | `Idempotency-Key`; `presentation.returnUrl` HTTPS |
| Verificar tarjeta | `GET /agentic/enrollments/:id` | solo se cobra si está `ACTIVE` |
| Buscar | `POST /agentic/products/search` | `context.country=US`, `currency=USD` |
| Cotizar | `POST /agentic/quotes` | `Idempotency-Key`; dirección de envío de la empresa |
| Envío | `POST /agentic/quotes/:id/shipping-option` | recalcula `amountBreakdown` |
| Pagar | `POST /agentic/checkouts` | `Idempotency-Key`; `X-Simulate-Checkout: COMPLETED` en sandbox |
| Confirmar | `GET /agentic/checkouts/:id` | `orderId` + `finalAmount` → asiento devengado |

Todas las llamadas llevan `Authorization: Bearer` y `Reap-Version: 2025-02-14` (la única que acepta el sandbox). Se usa el `previewVariant` de la búsqueda como variante comprable; `products/details` y `products/variant` entran cuando el usuario elija opciones (talla, color).

Probado contra el sandbox: búsquedas en inglés y en español devuelven Brooklinen, Public Goods y Package Free, y las cotizaciones regresan `amountBreakdown` completo, con el que el pre-asiento cuadra. Las cotizaciones duran unos 5 minutos.

## 9. Demo (3 minutos)

1. **Empresa en vivo.** Con los presets, Operaciones, Marketing e IT piden compras. El ledger se llena en tiempo real: compromiso → pre-asiento → devengado → liberación. La balanza cuadra en cada momento.
2. **El ataque.** En una compra se comparte una "cotización de proveedor" con instrucciones ocultas (10 unidades, envío express, saltar aprobación). El agente las obedece y recotiza, pero el pre-asiento no cuadra contra el compromiso: el guard marca `CANTIDAD`, `ENVIO`, `TOPE` y `SIN_APROBACION`, la compra aparece en rojo y el pago nunca ocurre.
3. **Cerrar mes.** Un clic: liquidación de la tarjeta, balanza y P&L por centro de costo. Se adjunta una factura con la orden de Reap y se liga sola a sus asientos.

## 10. Cumplimiento de reglas del hackathon

- [x] Usa el Agentic module de Reap API como núcleo del producto.
- [x] Los pagos agénticos son el centro: sin pago agéntico no hay asiento.
- [x] Todo corre en sandbox; checkout simulado, sin dinero real.
- [x] Solo comercios de la lista soportada (los que devuelve la búsqueda de Reap).
- [x] Sin viajes ni categorías restringidas: `src/politica.js` rechaza el pedido antes de que nazca el intent.
- [x] Sin scraping del checkout ni datos crudos de tarjeta al agente.
- [x] No es un chatbot genérico de compras.
- [x] Track: el problema que más vale la pena.

## 11. Siguiente paso y roadmap

Siguiente, dentro del mismo contrato:

- Bot de Telegram como entrada de pedidos y canal donde el guard explica sus bloqueos.
- Claude con tool use en `agente.js` (el guard no cambia).
- Postgres con trigger que rechace asientos descuadrados, en lugar de `data/jpay.json`.
- Lectura de CFDI (XML) y PDF para el match de facturas.

Post-hackathon:

- Mandates de Reap (cuando estén disponibles) como tope nativo por intent, en lugar del tope propio.
- Exportación de pólizas a ERP (SAP, NetSuite, Contpaqi) y CFDI de egreso.
- Tarjetas virtuales por centro de costo con Reap Cards Issuing.
- Track onchain: tesorería en stablecoins con el wallet module de Payward para fondear la tarjeta.

## Equipo

<!-- nombres y roles -->
