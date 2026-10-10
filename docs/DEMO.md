# J-Pay · Demo de Finanzas en 3 minutos

La empresa paga en fiat con una tarjeta Visa corporativa de Reap garantizada por colateral en stablecoins. El agente de J-Pay propone la compra y usa el Agentic module para ejecutarla; J-Pay aplica presupuesto y control humano antes del checkout, y registra el monto que Reap devuelve como cobrado.

Este guion se ensaya en un worktree dedicado, con el servidor en **PORT=3020**. El entorno de Reap es sandbox: una respuesta `COMPLETED` en sandbox no demuestra un cargo de producción.

## Guion de 3 minutos

Preparar dos propuestas sin checkout: `coffee` para aprobar y `keyboard` para rechazar. Mantener abiertas las pestañas Solicitante, Finanzas y Contador. Generar cotizaciones frescas al comenzar; las reales pueden expirar en unos cinco minutos.

| Tiempo | Acción y evidencia | Qué decir |
|---|---|---|
| 0:00–0:15 | Abrir Finanzas y declarar el modo de Reap y del checkout usado en este ensayo. | «La empresa compra en fiat. El agente propone; Finanzas conserva la decisión de pagar». |
| 0:15–0:35 | En Solicitante, enviar `coffee`, cantidad 1, máximo 1, OPS, categoría oficina y tope USD 40. El agente busca y cotiza; volver a Finanzas. | «El pedido nace con centro de costo y límite, antes de llegar al checkout». |
| 0:35–1:00 | Revisar producto, comercio, producto/envío/impuesto/descuento/total y pre-asiento. Señalar disponible, comprometido y consumido, y cuánto quedaría tras la compra. Mostrar que Guard permite la compra y que la cotización sigue vigente. | «Veo qué compra, cuánto cuesta y cómo afecta el presupuesto. El agente no decide saltarse este control». |
| 1:00–1:20 | Rechazar la segunda propuesta, `keyboard`: si existe el botón Rechazar, registrar «No es prioritario; conservar presupuesto». Comprobar que esa propuesta no tiene checkout ni pago. En el main que aún carece de ese botón, usar el rechazo humano descrito abajo. | «Esta compra no la autorizo. Mi decisión ocurre antes de crear el checkout». |
| 1:20–1:55 | Volver a `coffee`, revisar total y comercio y pulsar Autorizar. Si el ensayo usa checkout hosted, aprobar en la página de Reap; si usa `X-Simulate-Checkout`, declarar que ese paso se completa mediante simulación de sandbox. | «Finanzas autoriza esta compra. Reap ejecuta el flujo de pago en el modo que acabamos de indicar». |
| 1:55–2:25 | Esperar `COMPLETED` y mostrar `orderId` y el `finalAmount` devuelto por Reap. Compararlo con el cotizado; si difiere, señalar el ajuste 5900 realmente generado. | «Contabilizamos lo cobrado, no damos por hecho que coincide con la cotización». |
| 2:25–3:00 | Abrir Contador: mostrar el devengado, su vínculo con la compra/orden y la balanza cuadrada, Debe = Haber. Si está integrada la apertura, distinguir cuentas de balance y de orden. | «El pago ya tiene asiento. Contabilidad revisa una traza vinculada, sin reconstruir el gasto a mano». |

### Cómo ensayar con la versión disponible

- **Rechazo:** el main revisado aún no tiene botón ni ruta de rechazo. En ese caso, Finanzas declara que rechaza `keyboard` y deja esa propuesta sin autorizar. Mostrar que no tiene checkout ni orden pagada. Aclarar que es una negativa humana a pagar: no queda registrada como `RECHAZADA` y su reserva puede seguir comprometida. No sustituirla por un rechazo en Reap: no hay endpoint para cancelar/rechazar un checkout ya creado. Cuando esté integrada la acción Rechazar de J-Pay, usarla y comprobar decisión y traza.
- **Desglose:** si la tarjeta de Finanzas todavía muestra solo el total, abrir junto a ella la respuesta de `GET /api/estado`, mostrando el pre-asiento y presupuesto realmente disponibles. La vista completa del desglose de cotización sigue siendo requisito de integración de la UI; no atribuir al main campos que aún no devuelve. Si se usa `?mock=1` para enseñarla, declarar que esa vista usa un fixture y que no es la evidencia del pago.
- **Checkout:** el main revisado envía `X-Simulate-Checkout: COMPLETED`. El recorrido hosted sin ese header depende de la rama de checkout y del ensayo previo; no hay que asumir que `Reap real` implica checkout sin simular. Confirmar el comportamiento efectivo antes de presentar.
- **Contabilidad/CFDI:** los PRs contable y conciliación deben integrarse junto con sus conexiones de backend. Aprobar un PR no activa por sí solo la apertura, el consumo del presupuesto ni la carga de XML desde la UI.
- **Monto cobrado:** en el contrato nuevo se muestra `checkout.finalAmount`; la implementación anterior lo expone como `finalUsd`, en unidades monetarias. Comprobar contra la respuesta de checkout y los asientos. Si falta el dato de cobro de Reap, no presentar el cotizado como evidencia de lo cobrado.

## Real vs simulado vs roadmap

| Componente | Real | Simulado | Roadmap / pendiente |
|---|---|---|---|
| Agentic module de Reap | Llamadas reales al sandbox: enrollment, búsqueda, quote, envío y lectura del checkout. | Sin `REAP_API_KEY`, respuestas locales con la forma de Reap. | Producción fuera del alcance de este ensayo. |
| Checkout | Hosted, con aprobación en Reap, cuando ese recorrido esté habilitado y ensayado. | `X-Simulate-Checkout: COMPLETED` llama a la API real de sandbox pero simula el resultado; Plan B usa checkout local simulado. | Documentar cuál se usó en cada prueba. El main revisado usa el header de simulación. |
| Mandates | Los topes y políticas se aplican en J-Pay antes del checkout. | No presentar esos topes como mandates de Reap. | Mandates: roadmap de Reap; aún no disponibles para este flujo. |
| CFDI | Parser real y funciones de conciliación/reclasificación del PR #3. | XML de prueba con sellos y certificados sintéticos. | Integración de `POST /api/facturas` con XML; no valida autenticidad fiscal ni sellos ante el SAT. |
| Comercios en MongoDB | Importador real, colección `comercios`, upsert e índices de la lista del evento. | El Plan B usa el catálogo local de Reap simulado. | La colección todavía no está integrada al Guard; no afirmar que Mongo bloquea comercios en el checkout. |
| Agente y Guard | Propuesta mediante reglas/regex y Guard determinista. | Catálogo y cotización local en Plan B. | Un agente basado en modelo no está demostrado por las reglas actuales. |
| Asientos y presupuesto | Partida doble calculada por J-Pay; el devengado y ajuste usan el monto final del checkout. | En Plan B el monto final proviene del simulador. | Integrar apertura/consumo del PR #1 para que 8000 refleje disponible después de pagar. |

## Checklist antes del demo

Estos comandos se ejecutan en un **worktree de demo dedicado y limpio**, nunca en la carpeta compartida donde otra herramienta esté trabajando. No copiar `.env` entre worktrees. Preparar la configuración privada del sandbox localmente, sin incluir valores en este documento.

- [ ] Confirmar la rama/versión ensayada y las integraciones disponibles. El hotfix de Finanzas debe estar incluido; revisar las limitaciones de rechazo, desglose y checkout indicadas arriba.
- [ ] Actualizar el worktree de ensayo desde main y tener sus dependencias instaladas:

  ```bash
  git status --short
  git pull --ff-only origin main
  npm ci
  npm test
  ```

  Ejecutar el pull solo con árbol limpio y base compatible. Si un chequeo de Mongo falla por configuración ausente, registrar ese caso por separado; no atribuir otras fallas a `MONGODB_URI` ni declarar toda la suite aprobada. La importación real de comercios necesita su configuración y conexión.

- [ ] Detener el servidor de ese worktree y resetear su estado de ensayo. Mover el archivo conserva una copia local; no ejecutar este reset sobre datos de otra sesión:

  ```bash
  if [ -f data/jpay.json ]; then
    mv data/jpay.json "data/jpay.pre-demo.$(TZ=America/Mexico_City date +%Y%m%d-%H%M%S).json"
  fi
  ```

  La próxima ejecución crea el estado nuevo. El reset elimina del estado activo los intents/asientos y el enrollment guardado; comprobar después el registro de la tarjeta. Un `REAP_ENROLLMENT_ID` configurado localmente puede conservar el enrollment.

- [ ] Configurar en privado `REAP_API_KEY` del sandbox, la dirección válida en `REAP_ENVIO`, y país/moneda adecuados para la compra. No usar credenciales de producción ni mostrar valores privados en pantalla.
- [ ] Levantar el túnel hacia el puerto de ensayo:

  ```bash
  cloudflared tunnel --url http://localhost:3020
  ```

  Configurar `PUBLIC_URL` con el HTTPS público del túnel activo y reiniciar cuando cambie. El `returnUrl` real de Reap debe ser HTTPS público. No guardar la URL efectiva del túnel en la documentación.

- [ ] Arrancar la aplicación:

  ```bash
  PORT=3020 npm start
  ```

  Verificar el texto **Reap real** en la aplicación/log de arranque y que la API apunta a sandbox. Verificar por separado si el checkout será hosted o usará `X-Simulate-Checkout`.

- [ ] Registrar la tarjeta en la página hosted de Reap, usar el OTP de sandbox **456789** y comprobar enrollment `ACTIVE` al volver. Si el enrollment ya existe y está activo, no repetirlo.
- [ ] Completar una compra de prueba con el producto ensayado, dentro de su tope: aprobación, vuelta del checkout, `COMPLETED`, monto final y asiento cuadrado. No estrenar una búsqueda comercial durante el demo.
- [ ] Antes de presentar, preparar propuestas frescas dentro del presupuesto restante; si se resetea otra vez tras la prueba, volver a comprobar la tarjeta. Tener lista la propuesta que Finanzas rechazará.
- [ ] Comprobar disponible/comprometido/consumido, errores junto a la compra, cuenta regresiva y la vista de Contador. Si la apertura y consumo aún no están integrados, describir esa limitación de las cuentas de orden.
- [ ] Tener listo el Plan B y decir explícitamente cuándo se activa. Mongo y el parser CFDI son evidencia secundaria; no deben consumir el tiempo del recorrido principal de Finanzas.

## Plan B si cae la red

Detener el servidor, usar un estado local de ensayo limpio como arriba y arrancar con la clave vacía. La asignación explícita evita que `npm start` vuelva a tomar una clave real desde `.env`; también evita redirigir al túnel y reutilizar un enrollment real configurado:

```bash
REAP_API_KEY='' REAP_ENROLLMENT_ID='' REAP_PAIS=US REAP_MONEDA=USD PUBLIC_URL='http://localhost:3020' PORT=3020 npm start
```

Verificar **Reap simulado** y anunciar: «La conexión falló; continuamos con el simulador local. Este checkout y su monto no provienen de una llamada en vivo a Reap». Volver a registrar la tarjeta simulada desde Finanzas después de cada reinicio: el simulador guarda los objetos de enrollment/checkout en memoria. No necesita una tarjeta ni OTP reales.

Los botones antiguos de presets pueden seguir mostrando detergente/toallas/tote/laptop stand. Escribir estas búsquedas manualmente en el formulario hasta que la rama C corrija los presets:

| Búsqueda | Producto del catálogo local | Centro / categoría | Cantidad / máximo | Tope sugerido | Total simulado esperado |
|---|---|---|---|---|---|
| `coffee` | CoffeeAM · Costa Rica Reserve Coffee | OPS / oficina | 1 / 1 | USD 40 | USD 27.54 |
| `cleaning spray` | Package Free · Multi-Purpose Cleaning Spray (4 Pack) | OPS / oficina | 1 / 1 | USD 50 | USD 37.30 |
| `keyboard` | Keychron · K8 Wireless Mechanical Keyboard | IT / cómputo | 1 / 1 | USD 100 | USD 81.58 |

Estos totales describen el catálogo simulado revisado, con envío estándar y su impuesto local; no son cotizaciones de comercios en vivo. Siempre revisar el total y Guard antes de autorizar. **No usar `laundry detergent` hasta que lo arregle la rama C**: no tiene coincidencia en este catálogo.

Repetir el mismo control de Finanzas y mostrar el devengado y la balanza del simulador. En el main revisado, el checkout simulado devuelve a J-Pay y se completa localmente; no presentarlo como aprobación hosted de Reap. La importación desde la hoja/Mongo queda fuera del Plan B sin red.

## Pitch en 5 líneas

1. La empresa paga en fiat con una tarjeta Visa corporativa de Reap garantizada por colateral en stablecoins.
2. El agente compra y concilia dentro del presupuesto de cada centro de costo.
3. Finanzas revisa y autoriza cada pago antes del checkout, y puede decidir no comprar.
4. Cada pago genera su asiento contable con el monto real cobrado por Reap.
5. J-Pay vincula compra, pago y contabilidad para conciliar y reducir el trabajo manual de la empresa.
