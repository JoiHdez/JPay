import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restriccion } from '../src/politica.js';

test('permite compras normales de oficina', () => {
  for (const t of ['laundry detergent', 'paper towels', 'Laptop stand', 'tote bag', 'cartuchos de tinta']) assert.equal(restriccion(t), null, t);
});

test('rechaza viajes y categorias restringidas, en ingles y en espanol', () => {
  assert.equal(restriccion('Boleto de avión a Monterrey').categoria, 'viajes');
  assert.equal(restriccion('hotel near office').categoria, 'viajes');
  assert.equal(restriccion('poker chips set').categoria, 'apuestas');
  assert.equal(restriccion('Lotería').categoria, 'apuestas');
  assert.equal(restriccion('ammo box').categoria, 'armas');
});

test('compara palabras completas, no pedazos', () => {
  assert.equal(restriccion('hotelería kit de limpieza'), null); // "hotel" dentro de otra palabra
});
