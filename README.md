# JPay: el agente que paga lo de la casa, dentro de tu presupuesto

Proyecto para el **Agentic Hackathon de Reap** (AI Builders México).
Tema: **02 Vida diaria**. Track: **Most Worthwhile Problem** (incluye Best Use of Latest Technology).

## La idea en una línea

JPay es el agente de pagos de Ochavo: sabe qué se te está acabando, lo compra con Reap solo si cabe en tu presupuesto y deja el gasto registrado sin que toques nada.

## El problema

- En una casa mexicana se repiten las mismas compras cada 2 a 4 semanas: detergente, papel, croquetas, pañales, artículos de limpieza.
- Hoy alguien tiene que acordarse, buscar, comparar, pagar y luego (si es ordenado) registrar el gasto en su app de finanzas.
- Las apps de finanzas solo te dicen después que te pasaste del presupuesto. Las tiendas solo te venden. Nadie conecta las dos cosas.

## La solución

Ochavo pone el contexto (qué compras, cada cuánto y cuánto te queda); JPay pone la acción (cotiza, paga con Reap y concilia):

1. **Detecta**: con el historial de gastos de Ochavo calcula qué artículo se repite y cuándo toca reponerlo.
2. **Propone**: "Toca detergente. Te quedan $640 en Supermercado este mes. Lo encontré en $382 con envío". También acepta voz: "ya se acabó el papel".
3. **Cotiza con Reap**: `products/search` -> `quotes` -> el envío más barato.
4. **Respeta el presupuesto**: si el total en pesos supera lo que queda en la categoría, no compra y dice por cuánto se pasa.
5. **El usuario aprueba con un toque** en la página alojada por Reap (`checkouts` -> `nextAction.url`). La tarjeta nunca toca a JPay, a Ochavo ni al LLM.
6. **Concilia solo**: con el `orderId` y `finalAmount` del checkout, registra el gasto en Ochavo y el presupuesto se actualiza.

## Por qué no es "otro chatbot de compras"

| Chatbot genérico (desaconsejado por las reglas) | JPay |
|---|---|
| El usuario busca, el bot muestra, el usuario compra | El agente sabe **qué** y **cuándo** comprar a partir de datos reales del hogar |
| No sabe cuánto puedes gastar | Cada compra pasa por el presupuesto de la categoría antes del checkout |
| El gasto queda fuera de tus finanzas | El gasto entra conciliado a Ochavo con la orden de Reap |

## Cumplimiento de las reglas del hackathon

- Usa el **Agentic module de Reap API** (enrollments, products, quotes, checkouts). Es el centro del producto, no un extra.
- Todo en **sandbox** (`X-Simulate-Checkout: COMPLETED`).
- Solo **comercios compatibles** (`/comercios` en el bot de Telegram).
- Sin scraping de checkout ni datos de tarjeta al LLM: la tarjeta se guarda en la página alojada de Reap (enrollment).
- No es viaje ni categoría restringida.

## Nota honesta sobre mandatos

Los **mandatos** de Reap (cargos recurrentes aprobados una vez) aún no están disponibles en sandbox. Por eso hoy cada reposición se aprueba con un toque. El diseño ya modela el presupuesto de Ochavo como el "techo" del mandato: cuando Reap libere `mandates`, el usuario aprueba una vez ("hasta $250 al mes en detergente") y el agente compra solo.

## Comercios

El sandbox acepta 152 tiendas en 24 categorías y los organizadores recomiendan las de **Estados Unidos**. Por eso la demo compra en una tienda de EE. UU. de la lista oficial, con una dirección de envío a la que esa tienda entregue. El total llega en USD y se registra en MXN con el tipo de cambio del día (open.er-api.com, respaldo en `TC_USD_MXN`). Antes del evento hay que elegir 2 o 3 tiendas de hogar, limpieza o mascotas de la lista y anotar su producto de prueba.

## Cómo está construido

Es un servicio aparte, sin dependencias (Node 20.6+), que habla con Ochavo por su API pública con el token de Integraciones (`luca_...`), igual que el MCP de Ochavo. No toca el repo de Ochavo.

```
src/reap.js         Cliente del Agentic module: enrollment, search, quote, shipping, checkout. Real con REAP_API_KEY, simulado sin ella.
src/ochavo.js       Presupuestos (/budgets), historial (/expenses) y registro del gasto; tipo de cambio USD -> MXN.
src/sugerencias.js  Qué se compra cada N días y si ya toca reponerlo.
src/presupuesto.js  La guarda: sin presupuesto o si excede, no hay checkout.
src/server.js       HTTP + flujo: cotizar -> aprobar -> checkout -> retorno -> gasto conciliado.
public/index.html   La pantalla de la demo, con dictado y respuesta por voz en es-MX.
```

Piezas de StrideCode que reutiliza: el `api()` y las reglas de seguridad del MCP de Ochavo (`Ochavo/mcp/index.js`), el patrón real/simulado de pagos de `Peluqueria/api/src/integraciones/pagos/index.js` y el motor de voz del navegador que usa `LucaVoiceEngine.jsx`.

**Reglas de dinero:**
- El LLM y el navegador solo proponen. La guarda corre en el servidor al cotizar y otra vez al aprobar.
- El pedido se reclama (`EN_CHECKOUT`) antes de llamar a Reap: un doble clic no cobra dos veces. Cada quote y checkout lleva `Idempotency-Key`.
- Volver de Reap no prueba nada: se lee el checkout y solo `COMPLETED` registra el gasto, una vez.
- La tarjeta se captura en la página alojada de Reap; aquí solo viaja el `enrollmentId`.

## Cómo correrlo

```bash
cp .env.example .env
npm start
npm test
```

Sin `REAP_API_KEY` ni `OCHAVO_TOKEN` todo corre simulado (sirve para ensayar sin red). En el evento:
1. Pedir la API key a Wen (en persona) y ponerla en `REAP_API_KEY`. Confirmar `REAP_VERSION` y si conviene `REAP_BASE` de México (`https://mx.sandbox.api.reap.global`).
2. Generar un token en Ochavo > Integraciones > API Tokens con `read`, `write`, `budgets` y `expenses`, y crear un presupuesto de la categoría `Supermercado`.
3. Abrir un túnel HTTPS (`cloudflared tunnel --url http://localhost:3010`) y poner esa URL en `PUBLIC_URL`: Reap regresa ahí.
4. "Guardar tarjeta en Reap" y capturar la tarjeta del sandbox del equipo en la página de Reap.
5. Elegir de la lista de comercios compatibles las tiendas y productos de prueba, y ajustar `REAP_ENVIO` a una dirección a la que entreguen.

## Pitch (3 minutos)

**0:00 Gancho (20 s)**
"¿Cuántas veces este mes te diste cuenta de que no había papel justo cuando lo necesitabas? Y cuando lo compraste, ¿lo anotaste en tu presupuesto? Nadie lo hace."

**0:20 Problema (30 s)**
Las compras de la casa son repetitivas, predecibles y aburridas. Las apps de finanzas te regañan después; las tiendas te venden sin saber si te alcanza. El dato y el pago viven separados.

**0:50 Solución (30 s)**
"Les presento JPay. Ochavo, nuestra app de finanzas personales que ya está en producción, sabe qué compras y cuánto te queda. JPay es su agente de pagos: con el Agentic module de Reap convierte ese dato en una compra, siempre dentro del presupuesto y siempre con tu aprobación."

**1:20 Demo (80 s)**
1. JPay avisa: "Toca reponer detergente; te quedan $640 en Supermercado".
2. Por voz: "también se acabó el papel".
3. JPay cotiza con Reap en una tienda compatible, muestra el total con envío en dólares y pesos, y que cabe en el presupuesto.
4. Un caso que no cabe: JPay no compra y dice por cuánto se pasa.
5. Toque en "Aprobar con Reap": página alojada de Reap, checkout completado en sandbox.
6. De vuelta en JPay: la orden aparece como comprada y registrada, y el presupuesto de Ochavo ya bajó.

**2:40 Por qué ahora y qué sigue (20 s)**
Cuando Reap libere los mandatos, apruebas una vez ("hasta $250 al mes en detergente") y JPay paga solo dentro de ese límite. El mismo motor sirve para regalos, útiles escolares y dinero a la familia.

**3:00 Cierre**
"Ochavo te dice en qué se va tu dinero. JPay lo paga por ti, sin salirse del presupuesto."

## Preguntas probables de los jueces

- **¿Quién paga por esto?** Ochavo ya cobra suscripción ($99/mes); JPay es la razón para quedarse. Además hay ingreso potencial por afiliación con comercios.
- **¿Qué pasa si sube el precio?** Cada ciclo se recotiza y se compara contra el presupuesto antes del checkout; si no cabe, no se cobra.
- **¿Y la seguridad?** La tarjeta vive en Reap; JPay solo guarda el `enrollmentId`. El LLM nunca ve datos de tarjeta, y la guarda de presupuesto corre en el servidor al cotizar y otra vez al aprobar.
