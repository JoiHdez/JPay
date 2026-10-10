import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validar, cuadra, balanza, presupuestos, compromiso, liberacion, preAsiento, devengado, liquidacion, pnl } from '../src/ledger.js';

const pub = (a) => ({ ...a, estado: 'PUBLICADO' });
const breakdown = {
  itemsSubtotal: { amount: 19.95, currency: 'USD' },
  shipping: { amount: 9.95, currency: 'USD' },
  tax: { amount: { amount: 2.66, currency: 'USD' }, includedInPrices: false },
  discounts: [],
  additionalCharges: [],
  finalAmount: { amount: 32.56, currency: 'USD' },
};

test('valida cuadre y catalogo', () => {
  assert.throws(() => validar({ lineas: [{ cuenta: 5100, debe: 100 }, { cuenta: 2100, haber: 90 }] }), /No cuadra/);
  assert.throws(() => validar({ lineas: [{ cuenta: 9999, debe: 1 }, { cuenta: 2100, haber: 1 }] }), /fuera del catalogo/);
  assert.equal(cuadra(compromiso({ cc: 'OPS', monto: 4000 })), true);
});

test('pre-asiento desde amountBreakdown cuadra y separa envio e impuesto', () => {
  const pre = preAsiento({ cc: 'OPS', cuenta: 5100, breakdown });
  assert.equal(cuadra(pre), true);
  assert.deepEqual(pre.lineas, [
    { cuenta: 5100, cc: 'OPS', debe: 1995 },
    { cuenta: 5400, cc: 'OPS', debe: 995 },
    { cuenta: 1300, debe: 266 },
    { cuenta: 2100, haber: 3256 },
  ]);
  // Si Reap mandara componentes que no suman, el pre-asiento no cuadra.
  assert.equal(cuadra(preAsiento({ cc: 'OPS', cuenta: 5100, breakdown: { ...breakdown, finalAmount: { amount: 40 } } })), false);
});

test('ciclo completo: compromiso, devengado con ajuste, liberacion, cierre', () => {
  const pre = preAsiento({ cc: 'OPS', cuenta: 5100, breakdown });
  const libro = [pub(compromiso({ cc: 'OPS', monto: 4000 }))];
  assert.equal(presupuestos(libro).find((p) => p.cc === 'OPS').disponible, 25000 - 4000);

  const [dev, ajuste] = devengado({ pre, finalCheckout: 33.0, cc: 'OPS' });
  assert.equal(ajuste.tipo, 'AJUSTE');
  assert.deepEqual(ajuste.lineas, [{ cuenta: 5900, cc: 'OPS', debe: 44 }, { cuenta: 2100, haber: 44 }]);
  libro.push(pub(dev), pub(ajuste), pub(liberacion({ cc: 'OPS', monto: 4000 })));

  const ops = presupuestos(libro).find((p) => p.cc === 'OPS');
  assert.equal(ops.comprometido, 0);
  assert.equal(ops.consumido, 1995 + 995 + 44);
  assert.equal(balanza(libro).cuadra, true);

  const liq = liquidacion(libro);
  assert.deepEqual(liq.lineas, [{ cuenta: 2100, debe: 3300 }, { cuenta: 1100, haber: 3300 }]);
  libro.push(pub(liq));
  assert.equal(balanza(libro).filas.find((f) => f.cuenta === 2100).saldo, 0);
  assert.equal(pnl(libro).find((p) => p.cc === 'OPS').total, 1995 + 995 + 44);
  assert.equal(liquidacion(libro), null);
});

test('sin diferencia no hay ajuste', () => {
  assert.equal(devengado({ pre: preAsiento({ cc: 'OPS', cuenta: 5100, breakdown }), finalCheckout: 32.56, cc: 'OPS' }).length, 1);
});
