import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balanza, compromiso, presupuestos, validar } from '../src/ledger.js';
import { comprometidoVivo, decidir, liberarCompromiso, recomprometer, MAX_MOTIVO } from '../src/decision.js';
import { motivosBloqueo } from '../public/errores.js';

// Libro en memoria con el mismo publicar() que el servidor: valida y marca PUBLICADO.
function escenario({ estado = 'APROBADO', cotizacion = 'LISTA', topeUsd = 40 } = {}) {
  const asientos = [];
  const publicar = (asiento, intent, concepto) => {
    validar(asiento);
    const a = { id: `A-${asientos.length + 1}`, estado: 'PUBLICADO', intentId: intent?.id || null, concepto, ...asiento };
    asientos.push(a);
    return a;
  };
  const intent = { id: 'INT-1', cc: 'OPS', topeUsd, busqueda: 'coffee', estado, cotizacion };
  publicar(compromiso({ cc: 'OPS', monto: Math.round(topeUsd * 100) }), intent, 'Compromiso');
  const disponible = () => presupuestos(asientos).find((p) => p.cc === 'OPS').disponible;
  return { asientos, publicar, intent, disponible };
}

const conCodigo = (codigo) => (e) => e.codigoApi === codigo;

test('rechazar libera el compromiso una sola vez y deja la decision', () => {
  const { asientos, publicar, intent, disponible } = escenario();
  assert.equal(disponible(), 25000 - 4000);
  const ahora = new Date('2026-10-10T00:00:00Z');
  decidir(intent, { accion: 'RECHAZAR', por: 'Ana', motivo: '  No es prioritario  ' }, { asientos, publicar, ahora });
  assert.equal(intent.estado, 'RECHAZADA');
  assert.deepEqual(intent.decision, { por: 'Ana', en: ahora.toISOString(), accion: 'RECHAZAR', motivo: 'No es prioritario' });
  assert.equal(asientos.filter((a) => a.tipo === 'LIBERACION').length, 1);
  assert.equal(comprometidoVivo(asientos, intent.id), 0);
  assert.equal(disponible(), 25000);
  assert.equal(balanza(asientos).cuadra, true);

  // Terminal: ni otro rechazo, ni cambios, ni recomprometer; y no se libera dos veces.
  assert.throws(() => decidir(intent, { accion: 'RECHAZAR', por: 'Ana', motivo: 'otra vez' }, { asientos, publicar }), conCodigo('TRANSICION_INVALIDA'));
  assert.throws(() => decidir(intent, { accion: 'CAMBIOS', por: 'Ana', motivo: 'x' }, { asientos, publicar }), conCodigo('TRANSICION_INVALIDA'));
  assert.throws(() => recomprometer(intent, { asientos, publicar, disponibleCc: disponible() }), conCodigo('TRANSICION_INVALIDA'));
  assert.equal(liberarCompromiso(intent, asientos, publicar, 'de nuevo'), null);
  assert.equal(asientos.filter((a) => a.tipo === 'LIBERACION').length, 1);
});

test('se puede rechazar o pedir cambios con o sin cotizacion, bloqueada incluida', () => {
  for (const cotizacion of ['LISTA', 'BLOQUEADA', 'ERROR', undefined]) {
    for (const accion of ['RECHAZAR', 'CAMBIOS']) {
      const { asientos, publicar, intent } = escenario({ cotizacion });
      decidir(intent, { accion, por: 'Ana', motivo: 'motivo' }, { asientos, publicar });
      assert.equal(intent.estado, accion === 'RECHAZAR' ? 'RECHAZADA' : 'CAMBIOS_SOLICITADOS');
      assert.equal(comprometidoVivo(asientos, intent.id), 0);
    }
  }
});

test('no se decide sobre una compra que ya salio a Reap o termino', () => {
  for (const estado of ['EN_CHECKOUT', 'COMPLETADO', 'FALLIDO', 'EXPIRADO', 'RECHAZADA', 'CAMBIOS_SOLICITADOS']) {
    const { asientos, publicar, intent } = escenario({ estado });
    assert.throws(() => decidir(intent, { accion: 'RECHAZAR', por: 'Ana', motivo: 'no' }, { asientos, publicar }), (e) => e.status === 409 && e.codigoApi === 'TRANSICION_INVALIDA');
    assert.equal(intent.estado, estado);
    assert.equal(asientos.length, 1, 'sin liberacion');
  }
});

test('motivo y comentario son obligatorios y cortos; un error no toca el libro', () => {
  for (const motivo of [undefined, null, '', '   ', 'x'.repeat(MAX_MOTIVO + 1)]) {
    const { asientos, publicar, intent } = escenario();
    assert.throws(() => decidir(intent, { accion: 'CAMBIOS', por: 'Ana', motivo }, { asientos, publicar }), (e) => e.status === 400 && e.codigoApi === 'DATOS_INVALIDOS');
    assert.equal(intent.estado, 'APROBADO');
    assert.equal(intent.decision, undefined);
    assert.equal(asientos.length, 1);
  }
  const { asientos, publicar, intent } = escenario();
  decidir(intent, { accion: 'CAMBIOS', por: '', motivo: 'x'.repeat(MAX_MOTIVO) }, { asientos, publicar });
  assert.equal(intent.decision.por, 'Finanzas');
});

test('pedir cambios y recotizar vuelve a comprometer el tope antes de quedar pendiente', () => {
  const { asientos, publicar, intent, disponible } = escenario();
  decidir(intent, { accion: 'CAMBIOS', por: 'Ana', motivo: 'Mejor la marca de la casa' }, { asientos, publicar });
  assert.equal(intent.estado, 'CAMBIOS_SOLICITADOS');
  assert.equal(disponible(), 25000);
  assert.equal(motivosBloqueo(intent, 'ACTIVE').length, 1);

  recomprometer(intent, { asientos, publicar, disponibleCc: disponible() });
  assert.equal(intent.estado, 'APROBADO');
  assert.equal(intent.decision, null);
  assert.equal(intent.decisiones.at(-1).accion, 'CAMBIOS');
  assert.equal(comprometidoVivo(asientos, intent.id), 4000);
  assert.equal(disponible(), 25000 - 4000);
  assert.deepEqual(asientos.map((a) => a.tipo), ['COMPROMISO', 'LIBERACION', 'COMPROMISO']);
  assert.equal(balanza(asientos).cuadra, true);

  // Pendiente otra vez: se puede volver a decidir y libera solo lo recomprometido.
  decidir(intent, { accion: 'RECHAZAR', por: 'Ana', motivo: 'Ya no' }, { asientos, publicar });
  assert.equal(comprometidoVivo(asientos, intent.id), 0);
  assert.equal(disponible(), 25000);
});

test('recotizar tras cambios sin presupuesto da 409 claro y no compromete', () => {
  const { asientos, publicar, intent, disponible } = escenario({ topeUsd: 200 });
  decidir(intent, { accion: 'CAMBIOS', por: 'Ana', motivo: 'Otra tienda' }, { asientos, publicar });
  // Otra compra se lleva casi todo el presupuesto mientras tanto.
  publicar(compromiso({ cc: 'OPS', monto: 10000 }), { id: 'INT-2' }, 'Otra compra');
  assert.throws(() => recomprometer(intent, { asientos, publicar, disponibleCc: disponible() }), (e) => e.status === 409 && e.codigoApi === 'PRESUPUESTO_INSUFICIENTE' && /presupuesto/.test(e.message));
  assert.equal(intent.estado, 'CAMBIOS_SOLICITADOS');
  assert.equal(comprometidoVivo(asientos, intent.id), 0);
  assert.equal(balanza(asientos).cuadra, true);
});

test('recomprometer solo desde CAMBIOS_SOLICITADOS', () => {
  const { asientos, publicar, intent, disponible } = escenario();
  assert.throws(() => recomprometer(intent, { asientos, publicar, disponibleCc: disponible() }), conCodigo('TRANSICION_INVALIDA'));
  assert.equal(comprometidoVivo(asientos, intent.id), 4000);
});
