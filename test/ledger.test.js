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

test('pre-asiento MX cuadra y separa envío e IVA acreditable', () => {
  const pre = preAsiento({ cc: 'OPS', cuenta: 5100, breakdown, paisComercio: 'MX' });
  assert.equal(cuadra(pre), true);
  assert.deepEqual(pre.lineas, [
    { cuenta: 5100, cc: 'OPS', debe: 1995 },
    { cuenta: 5400, cc: 'OPS', debe: 995 },
    { cuenta: 1300, debe: 266 },
    { cuenta: 2100, haber: 3256 },
  ]);
  // Si Reap mandara componentes que no suman, el pre-asiento no cuadra.
  assert.equal(cuadra(preAsiento({ cc: 'OPS', cuenta: 5100, breakdown: { ...breakdown, finalAmount: { amount: 40 } }, paisComercio: 'MX' })), false);
});

for (const caso of [
  { paisComercio: 'MX', incluido: false, compra: 1995, iva: 266, consumo: 2990 },
  { paisComercio: 'US', incluido: false, compra: 2261, iva: 0, consumo: 3256 },
  { paisComercio: ' mx ', incluido: true, compra: 1995, iva: 266, consumo: 2990 },
  { paisComercio: 'US', incluido: true, compra: 2261, iva: 0, consumo: 3256 },
]) {
  test(`impuesto ${caso.paisComercio.trim().toUpperCase()} ${caso.incluido ? 'incluido' : 'excluido'}: cuentas, presupuesto y P&L`, () => {
    const pre = preAsiento({
      cc: 'OPS', cuenta: 5100, paisComercio: caso.paisComercio,
      breakdown: {
        ...breakdown,
        itemsSubtotal: { amount: caso.incluido ? 22.61 : 19.95, currency: 'USD' },
        tax: { ...breakdown.tax, includedInPrices: caso.incluido },
      },
    });
    validar(pre);
    const libro = [pub(pre)];
    const balance = balanza(libro);
    const saldo = (cuenta) => balance.filas.find((f) => f.cuenta === cuenta)?.saldo ?? 0;
    assert.equal(saldo(5100), caso.compra);
    assert.equal(saldo(5400), 995);
    assert.equal(saldo(1300), caso.iva);
    assert.equal(saldo(2100), -3256);
    assert.deepEqual(balance.total, { debe: 3256, haber: 3256 });
    const ops = presupuestos(libro).find((p) => p.cc === 'OPS');
    assert.equal(ops.consumido, caso.consumo);
    assert.equal(ops.disponible, 25000 - caso.consumo);
    assert.equal(pnl(libro).find((p) => p.cc === 'OPS').total, caso.consumo);
  });
}

test('otro país o país ausente no registra impuesto acreditable', () => {
  for (const paisComercio of ['CA', undefined, null, '']) {
    const pre = preAsiento({ cc: 'OPS', cuenta: 5100, breakdown, paisComercio });
    validar(pre);
    const balance = balanza([pub(pre)]);
    assert.equal(balance.filas.some((f) => f.cuenta === 1300), false);
    assert.equal(balance.filas.find((f) => f.cuenta === 5100).saldo, 2261);
  }
});

test('el impuesto no acreditable sigue la cuenta de la compra cuando es un activo', () => {
  const pre = preAsiento({ cc: 'IT', cuenta: 1500, breakdown, paisComercio: 'US' });
  validar(pre);
  const libro = [pub(pre)];
  const balance = balanza(libro);
  assert.equal(balance.filas.some((f) => f.cuenta === 1300), false);
  assert.equal(balance.filas.find((f) => f.cuenta === 1500).saldo, 2261);
  assert.equal(presupuestos(libro).find((p) => p.cc === 'IT').consumido, 3256);
  assert.equal(pnl(libro).find((p) => p.cc === 'IT').total, 995);
});

test('impuesto a gasto respeta descuentos, cargos adicionales y detecta un total inconsistente', () => {
  const ajustado = {
    ...breakdown,
    discounts: [{ amount: { amount: 1.50 } }],
    additionalCharges: [{ amount: { amount: 0.75 } }],
    finalAmount: { amount: 31.81, currency: 'USD' },
  };
  const pre = preAsiento({ cc: 'OPS', cuenta: 5100, breakdown: ajustado, paisComercio: 'US' });
  validar(pre);
  const balance = balanza([pub(pre)]);
  assert.equal(balance.filas.find((f) => f.cuenta === 5100).saldo, 2186);
  assert.deepEqual(balance.total, { debe: 3181, haber: 3181 });
  assert.equal(cuadra(preAsiento({ cc: 'OPS', cuenta: 5100, paisComercio: 'US', breakdown: { ...ajustado, finalAmount: { amount: 40 } } })), false);
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
  assert.equal(ops.consumido, 3256 + 44);
  assert.equal(balanza(libro).cuadra, true);

  const liq = liquidacion(libro);
  assert.deepEqual(liq.lineas, [{ cuenta: 2100, debe: 3300 }, { cuenta: 1100, haber: 3300 }]);
  libro.push(pub(liq));
  assert.equal(balanza(libro).filas.find((f) => f.cuenta === 2100).saldo, 0);
  assert.equal(pnl(libro).find((p) => p.cc === 'OPS').total, 3256 + 44);
  assert.equal(liquidacion(libro), null);
});

test('sin diferencia no hay ajuste', () => {
  assert.equal(devengado({ pre: preAsiento({ cc: 'OPS', cuenta: 5100, breakdown }), finalCheckout: 32.56, cc: 'OPS' }).length, 1);
});
