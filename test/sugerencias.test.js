import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sugerencias } from '../src/sugerencias.js';

const hoy = new Date('2026-10-09T12:00:00Z');
const g = (description, expense_date, amount = 100) => ({ description, expense_date, amount });

test('detecta lo que se repite y si ya toca', () => {
  const r = sugerencias([
    g('Detergente', '2026-08-10'), g('detergente ', '2026-09-08', 120), // cada 29 dias, ultima hace 31
    g('Papel higiénico', '2026-09-20'), g('Papel higienico', '2026-10-04'), // cada 14, ultima hace 5
    g('Pastel', '2026-09-01'), // una sola vez: no es recurrente
  ], hoy);
  assert.equal(r.length, 2);
  assert.deepEqual(
    { concepto: r[0].concepto, cadaDias: r[0].cadaDias, toca: r[0].toca, montoPromedio: r[0].montoPromedio },
    { concepto: 'Detergente', cadaDias: 29, toca: true, montoPromedio: 110 },
  );
  assert.equal(r[1].toca, false);
});

test('ignora compras del mismo dia y entradas sin fecha', () => {
  assert.deepEqual(sugerencias([g('Agua', '2026-10-01'), g('Agua', '2026-10-01'), g('Agua', null)], hoy), []);
});
