import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulado as sim } from '../src/reap-sim.js';
import { revisar } from '../src/guard.js';
import { preAsiento } from '../src/ledger.js';
import { proponer } from '../src/agente.js';
import { CATEGORIAS } from '../src/catalogo.js';

// Los presets de public/solicitante.html: sin red, cada uno debe cotizar y pasar el Ledger Guard.
const PRESETS = [
  { cc: 'OPS', busqueda: 'laundry detergent', categoria: 'oficina', tope: 45, cantidad: 1, max: 2 },
  { cc: 'OPS', busqueda: 'paper towels', categoria: 'oficina', tope: 70, cantidad: 1, max: 1 },
  { cc: 'MKT', busqueda: 'tote bag', categoria: 'marketing', tope: 80, cantidad: 1, max: 3 },
  { cc: 'IT', busqueda: 'laptop stand', categoria: 'computo', tope: 120, cantidad: 1, max: 1 },
];

// Lo mismo que hace server.js: primer producto de la busqueda, quote, propuesta, pre-asiento y guard.
async function cotizarPreset(p, cantidad) {
  const { products } = await sim.buscar({ query: p.busqueda, pais: 'US', moneda: 'USD' });
  assert.ok(products.length, `sin productos para "${p.busqueda}"`);
  const [primero] = products;
  const quote = await sim.cotizar({ variantId: primero.previewVariant.id, cantidad, email: 'compras@jpay.demo' });
  const producto = { nombre: primero.name, tienda: primero.merchant.name };
  const propuesta = proponer({ producto, quote, cantidadBase: cantidad });
  const cuenta = CATEGORIAS[p.categoria].cuenta;
  const intent = { estado: 'APROBADO', busqueda: p.busqueda, categoria: p.categoria, cuenta, maxCantidad: p.max, topeUsd: p.tope, envio: 'economico', moneda: 'USD' };
  const pre = preAsiento({ cc: p.cc, cuenta, breakdown: quote.amountBreakdown });
  return revisar({ intent, propuesta, quote, pre, disponibleCc: 0 });
}

for (const p of PRESETS) {
  test(`preset "${p.busqueda}" cotiza y pasa el guard, aun con la cantidad maxima`, async () => {
    assert.deepEqual(await cotizarPreset(p, p.cantidad), { permitido: true, violaciones: [] });
    assert.deepEqual(await cotizarPreset(p, p.max), { permitido: true, violaciones: [] });
  });
}

test('la busqueda pone primero lo mas parecido y conserva el catalogo de aef8f3a', async () => {
  const { products } = await sim.buscar({ query: 'tote bag' });
  assert.deepEqual(products.map((p) => p.name), ['Organic Cotton Tote Bag', 'Thinker Tote Bundle']);
  for (const q of ['cleaning spray', 'coffee', 'keyboard', 'docking station']) {
    assert.equal((await sim.buscar({ query: q })).products.length, 1, q);
  }
  assert.deepEqual((await sim.buscar({ query: 'gaming chair' })).products, []);
});
