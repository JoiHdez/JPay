import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluar, presupuestoDe } from '../src/presupuesto.js';

const hogar = { budget_type: 'category', category: 'Hogar', amount: 1500, spent: 860, remaining: 640 };

test('elige el presupuesto de la categoria sin importar mayusculas', () => {
  assert.equal(presupuestoDe([{ budget_type: 'general', category: null }, hogar], ' hogar '), hogar);
  assert.equal(presupuestoDe([hogar], 'Comida'), null);
});

test('permite cuando cabe y dice cuanto queda', () => {
  assert.deepEqual(evaluar({ totalMxn: 189.5, presupuesto: hogar }), { permitido: true, motivo: 'cabe', restante: 640, despues: 450.5 });
});

test('bloquea cuando excede y dice cuanto falta', () => {
  const r = evaluar({ totalMxn: 700, presupuesto: hogar });
  assert.equal(r.permitido, false);
  assert.equal(r.faltante, 60);
});

test('bloquea sin presupuesto o con monto invalido', () => {
  assert.equal(evaluar({ totalMxn: 10, presupuesto: null }).motivo, 'sin_presupuesto');
  assert.equal(evaluar({ totalMxn: 0, presupuesto: hogar }).motivo, 'monto_invalido');
  assert.equal(evaluar({ totalMxn: NaN, presupuesto: hogar }).motivo, 'monto_invalido');
});
