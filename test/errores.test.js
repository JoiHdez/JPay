import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explicarError, errorHttp, resultadoAutorizar, cuentaRegresiva, restante, motivosBloqueo } from '../public/errores.js';

test('explicarError: shippingAddress faltante en la cotizacion', () => {
  const t = 'Reap 400 en /agentic/quotes: AGENTIC_REQUEST_REJECTED Invalid request {"field":"shippingAddress","reason":"required"}';
  const r = explicarError(t);
  assert.match(r.claro, /^Reap rechazó la cotización: falta la dirección de envío/);
  assert.equal(r.tecnico, t);
});

test('explicarError: ninguna tienda pudo surtir', () => {
  const r = explicarError('Ninguna tienda pudo surtir "coffee": Reap 422 en /agentic/quotes: QUOTE_UNFULFILLABLE Cannot ship');
  assert.match(r.claro, /^Ninguna tienda pudo surtir/);
  assert.match(r.tecnico, /QUOTE_UNFULFILLABLE/);
});

test('explicarError: sin conexion, campo generico y estados de Reap', () => {
  assert.match(explicarError('Sin conexion con Reap (ECONNRESET)').claro, /^Sin conexión con Reap/);
  assert.match(explicarError('Reap 400 en /agentic/checkouts: AGENTIC_REQUEST_REJECTED x {"field":"enrollmentId"}').claro, /el pago: el campo enrollmentId/);
  assert.match(explicarError('Reap 401 en /agentic/quotes: UNAUTHORIZED').claro, /REAP_API_KEY/);
  assert.match(explicarError('Reap 503 en /agentic/products/search: UNAVAILABLE').claro, /falla interna con la búsqueda/);
});

test('explicarError: mensajes propios del servidor y vacios', () => {
  assert.equal(explicarError(''), null);
  assert.equal(explicarError(undefined), null);
  // "Algo falló" nunca va solo: dice que falta el detalle y trae algo que desplegar.
  const generico = explicarError('Algo falló');
  assert.match(generico.claro, /no llegó el detalle/);
  assert.ok(generico.tecnico);
  assert.match(explicarError('Ledger Guard bloqueo el pago: TOPE').claro, /bloqueó el pago: TOPE/);
  assert.match(explicarError('La cotizacion de Reap expiro; cotiza de nuevo.').claro, /expiró/);
});

test('autorizar: el tunel cambia el 502 por HTML y el error conserva el detalle', () => {
  // Lo que regresa un tunel de Cloudflare cuando el origen responde 502 o no responde.
  const html = '<!DOCTYPE html><html><head><title>scanning-cuisine.trycloudflare.com | 502: Bad gateway</title></head><body>…</body></html>';
  const t = errorHttp('/api/intents/aprobar', 502, html);
  assert.equal(t, 'HTTP 502 en /api/intents/aprobar: scanning-cuisine.trycloudflare.com | 502: Bad gateway');
  const r = explicarError(t);
  assert.match(r.claro, /^No llegó la respuesta del servidor de J-Pay \(error 502/);
  assert.equal(r.tecnico, t);
  assert.equal(errorHttp('/api/estado', 200, ''), 'HTTP 200 en /api/estado');
  assert.match(explicarError(errorHttp('/api/estado', 404, 'x')).claro, /respondió 404/);
});

test('autorizar: con url redirige; sin url muestra lo que paso con el pago', () => {
  const url = 'https://x.trycloudflare.com/retorno?intent=INT-1';
  assert.deepEqual(resultadoAutorizar({ url }, null), { ir: url });
  // El checkout se completo al instante y la respuesta no trajo url (o no llego).
  const pagado = { id: 'INT-fee635ab', estado: 'PAGADA', orderId: 'SIM-914341', finalUsd: 27.54, totalUsd: 27.54 };
  assert.deepEqual(resultadoAutorizar({}, pagado), { aviso: 'Pagado · orden SIM-914341 · cobrado $27.54' });
  assert.deepEqual(resultadoAutorizar(null, pagado), { aviso: 'Pagado · orden SIM-914341 · cobrado $27.54' });
  assert.match(resultadoAutorizar(null, { ...pagado, estado: 'EN_PAGO', orderId: undefined }).aviso, /esperando su confirmación/);
  // Sigue pendiente: no se sabe nada, va el error con su detalle.
  assert.equal(resultadoAutorizar(null, { ...pagado, estado: 'COTIZADA' }), null);
  assert.equal(resultadoAutorizar(null, undefined), null);
});

test('cuentaRegresiva y restante', () => {
  const ahora = Date.parse('2026-10-10T00:00:00Z');
  assert.equal(restante(null, ahora), null);
  assert.equal(restante('2026-10-10T00:05:00Z', ahora), 300000);
  assert.equal(cuentaRegresiva(300000), 'Vence en 05:00');
  assert.equal(cuentaRegresiva(61500), 'Vence en 01:02');
  assert.equal(cuentaRegresiva(0), 'Cotización expirada');
  assert.equal(cuentaRegresiva(null), '');
});

test('motivosBloqueo: cada razon para no autorizar', () => {
  const ahora = Date.parse('2026-10-10T00:00:00Z');
  const ok = { estado: 'COTIZADA', cotizacion: 'LISTA', quoteId: 'quo_1', expira: '2026-10-10T00:05:00Z', guard: { permitido: true, violaciones: [] } };
  assert.deepEqual(motivosBloqueo(ok, 'ACTIVE', ahora), []);
  assert.match(motivosBloqueo({ ...ok, estado: 'SIN_COTIZACION', cotizacion: 'ERROR', quoteId: undefined }, 'ACTIVE', ahora)[0], /Sin cotización/);
  assert.match(motivosBloqueo(ok, 'ACTIVE', Date.parse('2026-10-10T00:05:01Z'))[0], /expiró/);
  const bloq = { ...ok, estado: 'BLOQUEADA', cotizacion: 'BLOQUEADA', guard: { permitido: false, violaciones: [{ codigo: 'TOPE', mensaje: 'Total supera el tope.' }, { codigo: 'ENVIO', mensaje: 'Envio caro.' }] } };
  assert.deepEqual(motivosBloqueo(bloq, 'ACTIVE', ahora), ['Ledger Guard: Total supera el tope.', 'Ledger Guard: Envio caro.']);
  assert.match(motivosBloqueo(ok, null, ahora)[0], /sin registrar/);
  assert.match(motivosBloqueo(ok, 'PENDING', ahora)[0], /PENDING/);
  // Expirada y bloqueada por el servidor por lo mismo: un solo motivo.
  const exp = { ...ok, estado: 'EXPIRADA', cotizacion: 'BLOQUEADA', expira: '2026-10-09T23:00:00Z', guard: { permitido: false, violaciones: [{ codigo: 'QUOTE_EXPIRADO', mensaje: 'Ya expiro.' }] } };
  assert.equal(motivosBloqueo(exp, 'ACTIVE', ahora).length, 1);
});
