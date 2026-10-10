import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { leerCheckout, cierreDelCheckout, NO_SE_COBRO } from '../src/checkout.js';
import { preAsiento, cuadra } from '../src/ledger.js';

// checkout-completed.json es la respuesta de ejemplo de GET /agentic/checkouts/:id en
// docs.reap.global/agentic-payments/one-time-purchases ("Confirm the order"). La doc no trae
// ejemplo de FAILED: checkout-failed.json sale del schema de la referencia (get-checkout).
const fixture = (n) => JSON.parse(readFileSync(new URL(`fixtures/${n}.json`, import.meta.url), 'utf8'));
const completed = fixture('checkout-completed');
const failed = fixture('checkout-failed');

const usd = (amount) => ({ amount, currency: 'USD' });
const intentCon = (breakdown) => ({
  id: 'INT-1', cc: 'IT', topeUsd: 150, moneda: 'USD', totalUsd: breakdown.finalAmount.amount,
  producto: { nombre: 'Sony WH 1000XM5', tienda: 'Tienda' },
  pre: preAsiento({ cc: 'IT', cuenta: 5100, breakdown }),
});
// Cotizado 134 = 124 + envio 5 + impuesto 5, igual a lo que cobra el fixture.
const exacto = intentCon({ itemsSubtotal: usd(124), shipping: usd(5), tax: { amount: usd(5), includedInPrices: false }, finalAmount: usd(134) });
// Cotizado 142; Reap cobra 134.
const caro = intentCon({ itemsSubtotal: usd(129), shipping: usd(8), tax: { amount: usd(5), includedInPrices: false }, finalAmount: usd(142) });
const tipos = (c) => c.asientos.map((a) => a.tipo);
const linea = (a, cuenta) => a.lineas.find((l) => l.cuenta === cuenta);

test('lee el COMPLETED de la doc: orden, monto en centavos y moneda', () => {
  assert.deepEqual(leerCheckout(completed), { estado: 'COMPLETED', orderId: '<merchant-order-id>', finalCents: 13400, moneda: 'USD', urlAprobacion: null, falta: null });
  // amount llega como number en la doc; si llegara como string tambien se lee.
  assert.equal(leerCheckout({ ...completed, finalAmount: { amount: '134.00', currency: 'USD' } }).finalCents, 13400);
  assert.equal(leerCheckout({ ...completed, finalAmount: { amount: 32.56, currency: 'USD' } }).finalCents, 3256);
});

test('lee FAILED y los estados en vuelo sin monto', () => {
  assert.deepEqual(leerCheckout(failed), { estado: 'FAILED', orderId: null, finalCents: null, moneda: null, urlAprobacion: null, falta: null });
  const enVuelo = leerCheckout({ id: 'c', status: 'REQUIRES_ACTION', orderId: null, nextAction: { type: 'REDIRECT', url: 'https://reap/aprobar', expiresAt: '2026-01-01T00:05:00Z' } });
  assert.equal(enVuelo.urlAprobacion, 'https://reap/aprobar');
  assert.equal(cierreDelCheckout({ intent: exacto, lectura: enVuelo }), null);
  assert.equal(cierreDelCheckout({ intent: exacto, lectura: leerCheckout({ status: 'PROCESSING' }) }), null);
  assert.equal(leerCheckout(undefined).estado, null);
});

test('COMPLETED igual a lo cotizado: devengado por finalAmount y liberacion del tope', () => {
  const c = cierreDelCheckout({ intent: exacto, lectura: leerCheckout(completed) });
  assert.equal(c.estado, 'COMPLETADO');
  assert.equal(c.error, null);
  assert.deepEqual(tipos(c), ['DEVENGADO', 'LIBERACION']);
  assert.ok(c.asientos.every(cuadra));
  assert.equal(linea(c.asientos[0], 2100).haber, 13400);
  assert.equal(linea(c.asientos[1], 8100).haber, 15000);
  assert.match(c.asientos[0].concepto, /orden <merchant-order-id>/);
});

test('COMPLETED distinto a lo cotizado: la diferencia va a 5900, en los dos sentidos', () => {
  const menos = cierreDelCheckout({ intent: caro, lectura: leerCheckout(completed) });
  assert.deepEqual(tipos(menos), ['DEVENGADO', 'AJUSTE', 'LIBERACION']);
  assert.deepEqual(menos.asientos[1].lineas, [{ cuenta: 2100, debe: 800 }, { cuenta: 5900, cc: 'IT', haber: 800 }]);

  const mas = cierreDelCheckout({ intent: exacto, lectura: leerCheckout({ ...completed, finalAmount: { amount: '135.50', currency: 'USD' } }) });
  assert.deepEqual(mas.asientos[1].lineas, [{ cuenta: 5900, cc: 'IT', debe: 150 }, { cuenta: 2100, haber: 150 }]);
  assert.ok(mas.asientos.every(cuadra));
});

test('COMPLETED sin finalAmount: error visible y nada se contabiliza (no se usa lo cotizado)', () => {
  const { finalAmount, ...sinMonto } = completed;
  const lectura = leerCheckout(sinMonto);
  assert.equal(lectura.falta, 'finalAmount');
  const c = cierreDelCheckout({ intent: exacto, lectura });
  assert.equal(c.estado, null);
  assert.deepEqual(c.asientos, []);
  assert.match(c.error, /COMPLETED \(orden <merchant-order-id>\) sin finalAmount/);

  assert.equal(leerCheckout({ ...completed, finalAmount: { amount: 'abc', currency: 'USD' } }).falta, 'finalAmount');
  assert.equal(leerCheckout({ ...completed, finalAmount: { amount: 134 } }).falta, 'finalAmount.currency');
  const otraMoneda = cierreDelCheckout({ intent: exacto, lectura: leerCheckout({ ...completed, finalAmount: { amount: 134, currency: 'MXN' } }) });
  assert.equal(otraMoneda.estado, null);
  assert.match(otraMoneda.error, /MXN/);
});

test('FAILED y EXPIRED liberan el compromiso una vez y dicen que no se cobro', () => {
  const f = cierreDelCheckout({ intent: exacto, lectura: leerCheckout(failed) });
  assert.equal(f.estado, 'FALLIDO');
  assert.equal(f.error, NO_SE_COBRO);
  assert.deepEqual(tipos(f), ['LIBERACION']);
  assert.deepEqual(f.asientos[0].lineas, [{ cuenta: 8000, cc: 'IT', debe: 15000 }, { cuenta: 8100, cc: 'IT', haber: 15000 }]);

  const e = cierreDelCheckout({ intent: exacto, lectura: leerCheckout({ ...failed, status: 'EXPIRED' }) });
  assert.equal(e.estado, 'EXPIRADO');
  assert.match(e.error, /No se cobro nada/);
  assert.deepEqual(tipos(e), ['LIBERACION']);
});
