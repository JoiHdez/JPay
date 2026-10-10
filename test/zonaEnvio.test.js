import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buscarComercio, revisarZona } from '../src/zonaEnvio.js';

const lista = [
  { comercio: 'packagefreeshop.com', enviaA: ['*', 'US'] },
  { comercio: 'plugable.com', enviaA: ['US'] },
  { comercio: 'fromourplace.com', enviaA: ['*', 'AE', 'AU', 'CA', 'US'] },
  { comercio: 'acteck.com', enviaA: ['MX'] },
  { comercio: 'alchemist.com.sg', enviaA: ['SG', 'US'] },
];

test('relaciona el nombre de Reap con el dominio de la lista', () => {
  assert.equal(buscarComercio(lista, 'Package Free').comercio, 'packagefreeshop.com');
  assert.equal(buscarComercio(lista, 'Plugable Technologies').comercio, 'plugable.com');
  assert.equal(buscarComercio(lista, 'Our Place').comercio, 'fromourplace.com');
  assert.equal(buscarComercio(lista, 'Alchemist').comercio, 'alchemist.com.sg');
  assert.equal(buscarComercio(lista, 'U.S. Polo Assn.'), null);
  assert.equal(buscarComercio(lista, 'ab'), null);
});

test('permite solo comercios de la lista que envian al pais de la empresa', () => {
  assert.deepEqual(revisarZona(lista, 'Plugable Technologies', 'us'), { ok: true, motivo: 'plugable.com envía a US', comercio: 'plugable.com' });
  assert.equal(revisarZona(lista, 'Package Free', 'MX').ok, true); // '*' = envia a todo el mundo
  assert.deepEqual(revisarZona(lista, 'Acteck', 'US'), { ok: false, motivo: 'Acteck (acteck.com) no envía a US', comercio: 'acteck.com' });
  assert.equal(revisarZona(lista, 'U.S. Polo Assn.', 'US').motivo, 'U.S. Polo Assn. no está en la lista de comercios compatibles');
});
