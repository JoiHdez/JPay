import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CENTROS, CUENTAS } from '../src/catalogo.js';
import {
  aperturaPresupuesto, asegurarAperturasPresupuesto, consumoPresupuesto,
  balanza, compromiso, devengado, liberacion, preAsiento, presupuestos, validar,
} from '../src/ledger.js';

const pub = (asiento) => ({ ...asiento, estado: 'PUBLICADO' });
const saldo = (libro, cuenta) => balanza(libro).filas.find((fila) => fila.cuenta === cuenta)?.saldo ?? 0;
const disponible = (libro) => presupuestos(libro).find((centro) => centro.cc === 'OPS').disponible;

test('apertura identifica centro y periodo y registra el presupuesto autorizado en cuentas de orden', () => {
  const apertura = aperturaPresupuesto('OPS', 25000, '2026-10');
  validar(apertura);
  assert.equal(apertura.tipo, 'APERTURA_PRESUPUESTO');
  assert.equal(apertura.periodo, '2026-10');
  assert.ok(apertura.id);
  assert.deepEqual(apertura.lineas, [
    { cuenta: 8000, cc: 'OPS', debe: 25000 },
    { cuenta: 8900, cc: 'OPS', haber: 25000 },
  ]);
  assert.equal(aperturaPresupuesto('OPS', 25000, '2026-10').id, apertura.id);
  assert.equal(aperturaPresupuesto('OPS', 26000, '2026-10').id, apertura.id);
  assert.notEqual(aperturaPresupuesto('IT', 40000, '2026-10').id, apertura.id);
  assert.notEqual(aperturaPresupuesto('OPS', 25000, '2026-11').id, apertura.id);
  assert.equal(CUENTAS[8900].nombre, 'Presupuesto autorizado (contra)');
  for (const cuenta of [8000, 8100, 8900]) assert.equal(CUENTAS[cuenta].orden, true);
});

test('aperturas idempotentes consultan el libro publicado incluso despues de recargarlo', () => {
  let libro = [{ ...pub(aperturaPresupuesto('OPS', 25000, '2026-10')), id: 'A-0001' }];
  const publicar = (asiento) => {
    validar(asiento);
    const publicado = pub(asiento);
    libro.push(publicado);
    return publicado;
  };
  const nuevas = asegurarAperturasPresupuesto(libro, '2026-10', publicar);
  assert.equal(nuevas.length, Object.keys(CENTROS).length - 1);
  assert.equal(libro.length, Object.keys(CENTROS).length);
  assert.equal(new Set(libro.map((asiento) => asiento.id)).size, libro.length);

  libro = JSON.parse(JSON.stringify(libro));
  assert.deepEqual(asegurarAperturasPresupuesto(libro, '2026-10', publicar), []);
  assert.equal(libro.length, Object.keys(CENTROS).length);

  const siguientePeriodo = asegurarAperturasPresupuesto(libro, '2026-11', publicar);
  assert.equal(siguientePeriodo.length, Object.keys(CENTROS).length);
  assert.equal(libro.length, Object.keys(CENTROS).length * 2);
  assert.equal(new Set(libro.map((asiento) => asiento.id)).size, libro.length);
  for (const [cc, centro] of Object.entries(CENTROS)) {
    const aperturas = libro.filter((asiento) => asiento.lineas[0].cc === cc);
    assert.deepEqual(aperturas.map((asiento) => asiento.periodo), ['2026-10', '2026-11']);
    assert.equal(aperturas[0].lineas[0].debe, Math.round(centro.presupuesto * 100));
  }
});

test('apertura rechaza centros, montos y periodos invalidos antes de publicarlos', () => {
  for (const cc of ['DESCONOCIDO', 'toString', null, undefined]) {
    assert.throws(() => aperturaPresupuesto(cc, 25000, '2026-10'));
  }
  for (const monto of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '25000', undefined]) {
    assert.throws(() => aperturaPresupuesto('OPS', monto, '2026-10'));
  }
  for (const periodo of ['', '2026-00', '2026-13', '2026-1', '2026-10-09', null, undefined]) {
    assert.throws(() => aperturaPresupuesto('OPS', 25000, periodo));
  }
  let publicaciones = 0;
  assert.throws(() => asegurarAperturasPresupuesto([], '2026-13', () => publicaciones++));
  assert.equal(publicaciones, 0);
});

test('apertura, compromiso y liberacion devuelven 8000 al tope autorizado', () => {
  const libro = [pub(aperturaPresupuesto('OPS', 25000, '2026-10'))];
  assert.equal(saldo(libro, 8000), 25000);
  libro.push(pub(compromiso({ cc: 'OPS', monto: 4000 })));
  assert.equal(saldo(libro, 8000), 21000);
  assert.equal(saldo(libro, 8000), disponible(libro));
  libro.push(pub(liberacion({ cc: 'OPS', monto: 4000 })));
  assert.equal(saldo(libro, 8000), 25000);
  assert.equal(saldo(libro, 8100), 0);
  assert.equal(saldo(libro, 8000), disponible(libro));
  assert.equal(balanza(libro).cuadra, true);
});

test('devengado y ajuste consumen el presupuesto y 8000 sigue positivo al liberar la reserva', () => {
  const pre = preAsiento({
    cc: 'OPS', cuenta: 5100,
    breakdown: {
      itemsSubtotal: { amount: 19.95 },
      shipping: { amount: 9.95 },
      tax: { amount: { amount: 2.66 }, includedInPrices: false },
      finalAmount: { amount: 32.56 },
    },
  });
  const libro = [
    pub(aperturaPresupuesto('OPS', 25000, '2026-10')),
    pub(compromiso({ cc: 'OPS', monto: 4000 })),
  ];
  const [dev, ajuste] = devengado({ pre, finalCheckout: 33, cc: 'OPS' });
  assert.equal(ajuste.lineas[0].cuenta, 5900);
  assert.equal(ajuste.lineas[0].debe, 44);
  const consumo = consumoPresupuesto('OPS', 3300);
  validar(consumo);
  assert.deepEqual(consumo.lineas, [
    { cuenta: 8900, cc: 'OPS', debe: 3300 },
    { cuenta: 8000, cc: 'OPS', haber: 3300 },
  ]);
  libro.push(pub(dev), pub(ajuste), pub(consumo));
  assert.equal(saldo(libro, 8000), 17700);
  assert.equal(saldo(libro, 8000), disponible(libro));

  libro.push(pub(liberacion({ cc: 'OPS', monto: 4000 })));
  assert.equal(saldo(libro, 8000), 21700);
  assert.equal(saldo(libro, 8100), 0);
  assert.equal(saldo(libro, 8000), disponible(libro));
  assert.equal(balanza(libro).cuadra, true);
});

test('balanza separa balance y orden y conserva el cuadre global con ambas clases incluidas', () => {
  const libro = [
    pub(aperturaPresupuesto('OPS', 25000, '2026-10')),
    pub(compromiso({ cc: 'OPS', monto: 4000 })),
    pub({ tipo: 'DEVENGADO', lineas: [{ cuenta: 5100, cc: 'OPS', debe: 3300 }, { cuenta: 2100, haber: 3300 }] }),
    aperturaPresupuesto('IT', 40000, '2026-10'),
  ];
  const resultado = balanza(libro);
  assert.deepEqual(resultado.balance.filas.map((fila) => fila.cuenta), [2100, 5100]);
  assert.deepEqual(resultado.orden.filas.map((fila) => fila.cuenta), [8000, 8100, 8900]);
  assert.ok(resultado.balance.filas.every((fila) => fila.orden === false));
  assert.ok(resultado.orden.filas.every((fila) => fila.orden === true));
  assert.deepEqual(resultado.balance.total, { debe: 3300, haber: 3300 });
  assert.deepEqual(resultado.orden.total, { debe: 29000, haber: 29000 });
  assert.deepEqual(resultado.total, { debe: 32300, haber: 32300 });
  assert.equal(resultado.balance.cuadra, true);
  assert.equal(resultado.orden.cuadra, true);
  assert.equal(resultado.cuadra, true);
  assert.equal(resultado.filas.length, resultado.balance.filas.length + resultado.orden.filas.length);
});

test('desbalances entre cuentas de orden y balance no se ocultan aunque el total global coincida', () => {
  const cruzado = { lineas: [{ cuenta: 8000, cc: 'OPS', debe: 100 }, { cuenta: 2100, haber: 100 }] };
  validar(cruzado);
  const resultado = balanza([pub(cruzado)]);
  assert.deepEqual(resultado.total, { debe: 100, haber: 100 });
  assert.equal(resultado.orden.cuadra, false);
  assert.equal(resultado.balance.cuadra, false);
  assert.equal(resultado.cuadra, false);
});
