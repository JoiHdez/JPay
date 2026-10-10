import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, aDocumento } from '../scripts/importar-comercios.mjs';

test('parsea comas y comillas dentro de campos', () => {
  const csv = 'Category,Market,Merchant door,Ships to,Test product,Variant ID,Item price,Currency,Cart permalink\r\n'
    + 'Household Essentials,US,PackageFreeShop.com,"*, US","Spray ""Lavender"", 4 Pack",123,14,USD,https://x/cart/123:1\r\n';
  const [h, f] = parseCsv(csv);
  const d = aDocumento(Object.fromEntries(h.map((k, i) => [k, f[i]])));
  assert.deepEqual(d, {
    comercio: 'packagefreeshop.com', categoria: 'Household Essentials', mercado: 'US', enviaA: ['*', 'US'],
    productoPrueba: 'Spray "Lavender", 4 Pack', variantId: '123', precio: 14, moneda: 'USD', carritoUrl: 'https://x/cart/123:1',
  });
});
