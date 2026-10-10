import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balanza, compromiso, presupuestos, validar } from '../src/ledger.js';
import { comprometidoVivo, decidir, liberarCompromiso, sincronizarCompromiso, MAX_MOTIVO } from '../src/decision.js';
import { transicionar } from '../src/estados.js';
import { motivosBloqueo } from '../public/errores.js';

// Libro en memoria con el mismo publicar() que el servidor: valida y marca PUBLICADO.
function escenario({ estado = 'COTIZADA', topeUsd = 40 } = {}) {
  const asientos = [];
  const publicar = (asiento, intent, concepto) => {
    validar(asiento);
    const a = { id: `A-${asientos.length + 1}`, estado: 'PUBLICADO', intentId: intent?.id || null, concepto, ...asiento };
    asientos.push(a);
    return a;
  };
  const intent = { id: 'INT-1', cc: 'OPS', topeUsd, busqueda: 'coffee', estado, traza: [], decision: null };
  // Como en el servidor, solo los estados con cotizacion valida o pago en curso reservan el tope.
  sincronizarCompromiso(intent, asientos, publicar);
  const disponible = () => presupuestos(asientos).find((p) => p.cc === 'OPS').disponible;
  // mover() del servidor: transicion + compromiso que sigue al estado.
  const mover = (a, traza = {}) => { transicionar(intent, a, traza); sincronizarCompromiso(intent, asientos, publicar); };
  return { asientos, publicar, intent, disponible, mover };
}

const conCodigo = (codigo) => (e) => e.codigoApi === codigo;

test('rechazar libera el compromiso una sola vez y deja decision y traza', () => {
  const { asientos, publicar, intent, disponible } = escenario();
  assert.equal(disponible(), 25000 - 4000);
  const ahora = new Date('2026-10-10T00:00:00Z');
  decidir(intent, { accion: 'RECHAZAR', por: 'Ana', motivo: '  No es prioritario  ' }, { asientos, publicar, ahora });
  assert.equal(intent.estado, 'RECHAZADA');
  assert.deepEqual(intent.decision, { por: 'Ana', en: ahora.toISOString(), accion: 'RECHAZAR', motivo: 'No es prioritario' });
  assert.deepEqual(intent.traza.at(-1), { en: ahora.toISOString(), actor: 'Ana', evento: 'RECHAZAR', datos: { de: 'COTIZADA', a: 'RECHAZADA', motivo: 'No es prioritario' } });
  assert.equal(asientos.filter((a) => a.tipo === 'LIBERACION').length, 1);
  assert.equal(comprometidoVivo(asientos, intent.id), 0);
  assert.equal(disponible(), 25000);
  assert.equal(balanza(asientos).cuadra, true);

  // Terminal: ni otro rechazo ni cambios; y no se libera dos veces.
  assert.throws(() => decidir(intent, { accion: 'RECHAZAR', por: 'Ana', motivo: 'otra vez' }, { asientos, publicar }), conCodigo('TRANSICION_INVALIDA'));
  assert.throws(() => decidir(intent, { accion: 'CAMBIOS', por: 'Ana', motivo: 'x' }, { asientos, publicar }), conCodigo('TRANSICION_INVALIDA'));
  assert.equal(liberarCompromiso(intent, asientos, publicar, 'de nuevo'), null);
  assert.equal(sincronizarCompromiso(intent, asientos, publicar), null);
  assert.equal(asientos.filter((a) => a.tipo === 'LIBERACION').length, 1);
});

test('rechazar aplica a cotizada, bloqueada, sin cotizacion y expirada; pedir cambios solo a cotizada', () => {
  for (const estado of ['COTIZADA', 'BLOQUEADA', 'SIN_COTIZACION', 'EXPIRADA']) {
    const { asientos, publicar, intent, disponible } = escenario({ estado });
    decidir(intent, { accion: 'RECHAZAR', por: 'Ana', motivo: 'motivo' }, { asientos, publicar });
    assert.equal(intent.estado, 'RECHAZADA');
    assert.equal(disponible(), 25000);
  }
  for (const estado of ['BLOQUEADA', 'SIN_COTIZACION', 'EXPIRADA']) {
    const { asientos, publicar, intent } = escenario({ estado });
    assert.throws(() => decidir(intent, { accion: 'CAMBIOS', por: 'Ana', motivo: 'm' }, { asientos, publicar }), conCodigo('TRANSICION_INVALIDA'));
  }
  const { asientos, publicar, intent } = escenario();
  decidir(intent, { accion: 'CAMBIOS', por: 'Ana', motivo: 'Mejor 2 bolsas' }, { asientos, publicar });
  assert.equal(intent.estado, 'CAMBIOS_SOLICITADOS');
  assert.equal(comprometidoVivo(asientos, intent.id), 0);
});

test('no se decide sobre una compra que ya se autorizo, salio a Reap o termino', () => {
  for (const estado of ['AUTORIZADA', 'EN_PAGO', 'PAGADA', 'FALLIDA', 'RECHAZADA', 'CAMBIOS_SOLICITADOS']) {
    const { asientos, publicar, intent } = escenario({ estado });
    const antes = asientos.length;
    assert.throws(() => decidir(intent, { accion: 'RECHAZAR', por: 'Ana', motivo: 'no' }, { asientos, publicar }), (e) => e.status === 409 && e.codigoApi === 'TRANSICION_INVALIDA');
    assert.equal(intent.estado, estado);
    assert.equal(asientos.length, antes, 'sin liberacion');
  }
});

test('motivo y comentario son obligatorios y cortos; un error no toca el libro', () => {
  for (const motivo of [undefined, null, '', '   ', 'x'.repeat(MAX_MOTIVO + 1)]) {
    const { asientos, publicar, intent } = escenario();
    assert.throws(() => decidir(intent, { accion: 'CAMBIOS', por: 'Ana', motivo }, { asientos, publicar }), (e) => e.status === 400 && e.codigoApi === 'DATOS_INVALIDOS');
    assert.equal(intent.estado, 'COTIZADA');
    assert.equal(intent.decision, null);
    assert.equal(asientos.length, 1);
  }
  const { asientos, publicar, intent } = escenario();
  decidir(intent, { accion: 'CAMBIOS', por: '', motivo: 'x'.repeat(MAX_MOTIVO) }, { asientos, publicar });
  assert.equal(intent.decision.por, 'Finanzas');
});

test('pedir cambios y recotizar vuelve a comprometer el tope al quedar COTIZADA', () => {
  const { asientos, publicar, intent, disponible, mover } = escenario();
  decidir(intent, { accion: 'CAMBIOS', por: 'Ana', motivo: 'Mejor la marca de la casa' }, { asientos, publicar });
  assert.equal(disponible(), 25000);
  assert.deepEqual(motivosBloqueo(intent, 'ACTIVE'), ['Finanzas pidió cambios; falta recotizar.']);

  mover('COTIZADA', { actor: 'agente', evento: 'Recotizacion del agente' });
  assert.equal(comprometidoVivo(asientos, intent.id), 4000);
  assert.equal(disponible(), 25000 - 4000);
  assert.deepEqual(asientos.map((a) => a.tipo), ['COMPROMISO', 'LIBERACION', 'COMPROMISO']);
  assert.equal(balanza(asientos).cuadra, true);

  // Pendiente otra vez: se puede volver a decidir y libera solo lo recomprometido.
  decidir(intent, { accion: 'RECHAZAR', por: 'Ana', motivo: 'Ya no' }, { asientos, publicar });
  assert.equal(comprometidoVivo(asientos, intent.id), 0);
  assert.equal(disponible(), 25000);
  assert.deepEqual(intent.traza.map((t) => t.evento), ['CAMBIOS', 'Recotizacion del agente', 'RECHAZAR']);
});

test('el compromiso sigue al estado en todo el ciclo y nunca queda huerfano', () => {
  // Sin cotizacion no hay compromiso; al cotizar se reserva; bloqueada lo libera.
  const s = escenario({ estado: 'SIN_COTIZACION' });
  assert.equal(comprometidoVivo(s.asientos, s.intent.id), 0);
  s.mover('COTIZADA');
  assert.equal(comprometidoVivo(s.asientos, s.intent.id), 4000);
  s.mover('BLOQUEADA');
  assert.equal(comprometidoVivo(s.asientos, s.intent.id), 0);
  s.mover('COTIZADA');
  s.mover('EXPIRADA');
  assert.equal(comprometidoVivo(s.asientos, s.intent.id), 0);
  s.mover('COTIZADA');
  s.mover('AUTORIZADA');
  s.mover('EN_PAGO');
  assert.equal(comprometidoVivo(s.asientos, s.intent.id), 4000, 'autorizada y en pago conservan la reserva');
  s.mover('FALLIDA');
  assert.equal(comprometidoVivo(s.asientos, s.intent.id), 0);
  assert.equal(s.disponible(), 25000);
  assert.equal(balanza(s.asientos).cuadra, true);
  assert.equal(s.asientos.filter((a) => a.tipo === 'COMPROMISO').length, s.asientos.filter((a) => a.tipo === 'LIBERACION').length);
});

test('un compromiso huerfano del formato anterior se libera con asiento, sin borrar nada', () => {
  // A-0002 del QA: $70 reservados por un intent que nunca cotizo.
  const { asientos, publicar, intent, disponible } = escenario({ estado: 'SIN_COTIZACION', topeUsd: 70 });
  publicar(compromiso({ cc: 'OPS', monto: 7000 }), intent, 'Compromiso viejo');
  assert.equal(disponible(), 25000 - 7000);
  const libera = sincronizarCompromiso(intent, asientos, publicar);
  assert.equal(libera.tipo, 'LIBERACION');
  assert.equal(libera.lineas[0].debe, 7000);
  assert.equal(asientos.length, 2);
  assert.equal(disponible(), 25000);
  assert.equal(sincronizarCompromiso(intent, asientos, publicar), null);
});
