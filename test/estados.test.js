import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CON_COMPROMISO, ESTADOS, RECOTIZABLES, TERMINALES, TRANSICIONES, estadoMigrado, migrar, nacer, puede, transicionar } from '../src/estados.js';

test('la tabla trae las transiciones del contrato y sus terminales', () => {
  const contrato = {
    COTIZADA: ['AUTORIZADA', 'RECHAZADA', 'CAMBIOS_SOLICITADOS', 'EXPIRADA'],
    BLOQUEADA: ['COTIZADA', 'RECHAZADA'],
    AUTORIZADA: ['EN_PAGO', 'FALLIDA'],
    EN_PAGO: ['PAGADA', 'FALLIDA'],
    SIN_COTIZACION: ['COTIZADA'],
    EXPIRADA: ['COTIZADA'],
    CAMBIOS_SOLICITADOS: ['COTIZADA'],
  };
  for (const [de, destinos] of Object.entries(contrato)) for (const a of destinos) assert.ok(puede(de, a), `${de} -> ${a}`);
  assert.deepEqual(TERMINALES.sort(), ['FALLIDA', 'PAGADA', 'RECHAZADA']);
  assert.deepEqual(Object.keys(TRANSICIONES).sort(), [...ESTADOS].sort());
  for (const destinos of Object.values(TRANSICIONES)) for (const a of destinos) assert.ok(ESTADOS.includes(a));
});

test('transiciones prohibidas: no se paga sin autorizar ni se revive una terminal', () => {
  for (const [de, a] of [
    ['COTIZADA', 'EN_PAGO'], ['COTIZADA', 'PAGADA'], ['BLOQUEADA', 'AUTORIZADA'], ['SIN_COTIZACION', 'AUTORIZADA'],
    ['AUTORIZADA', 'RECHAZADA'], ['AUTORIZADA', 'COTIZADA'], ['EN_PAGO', 'RECHAZADA'], ['EN_PAGO', 'COTIZADA'],
    ['PAGADA', 'FALLIDA'], ['RECHAZADA', 'COTIZADA'], ['FALLIDA', 'COTIZADA'], ['CAMBIOS_SOLICITADOS', 'AUTORIZADA'],
  ]) assert.equal(puede(de, a), false, `${de} -> ${a}`);
  for (const t of TERMINALES) assert.deepEqual(TRANSICIONES[t], []);
});

test('transicionar valida, deja traza y lanza TRANSICION_INVALIDA sin tocar el intent', () => {
  const ahora = new Date('2026-10-10T00:00:00Z');
  const intent = nacer({ id: 'INT-1' }, { actor: 'Joel', ahora });
  assert.equal(intent.estado, 'SIN_COTIZACION');
  assert.equal(intent.decision, null);
  transicionar(intent, 'COTIZADA', { actor: 'agente', evento: 'Cotizacion del agente', datos: { quoteId: 'q1' }, ahora });
  assert.deepEqual(intent.traza, [
    { en: ahora.toISOString(), actor: 'Joel', evento: 'CREADA', datos: { a: 'SIN_COTIZACION' } },
    { en: ahora.toISOString(), actor: 'agente', evento: 'Cotizacion del agente', datos: { de: 'SIN_COTIZACION', a: 'COTIZADA', quoteId: 'q1' } },
  ]);
  assert.throws(() => transicionar(intent, 'PAGADA'), (e) => e.status === 409 && e.codigoApi === 'TRANSICION_INVALIDA');
  assert.equal(intent.estado, 'COTIZADA');
  assert.equal(intent.traza.length, 2);
});

test('compromiso solo con cotizacion valida o pago en curso; se recotiza solo antes de autorizar', () => {
  assert.deepEqual(CON_COMPROMISO, ['COTIZADA', 'AUTORIZADA', 'EN_PAGO']);
  for (const e of RECOTIZABLES) assert.ok(puede(e, 'COTIZADA') || e === 'COTIZADA', e);
  for (const e of ['AUTORIZADA', 'EN_PAGO', ...TERMINALES]) assert.equal(RECOTIZABLES.includes(e), false, e);
});

test('migra los estados del formato anterior, con sus casos borde', () => {
  const casos = [
    [{ estado: 'APROBADO', cotizacion: 'LISTA' }, 'COTIZADA'],
    [{ estado: 'APROBADO', cotizacion: 'BLOQUEADA' }, 'BLOQUEADA'],
    [{ estado: 'APROBADO', cotizacion: 'ERROR' }, 'SIN_COTIZACION'],
    [{ estado: 'APROBADO' }, 'SIN_COTIZACION'], // se cayo a media cotizacion
    [{ estado: 'EN_CHECKOUT', checkoutId: 'chk_1' }, 'EN_PAGO'],
    [{ estado: 'EN_CHECKOUT' }, 'AUTORIZADA'], // se cayo entre el reclamo y Reap
    [{ estado: 'COMPLETADO' }, 'PAGADA'],
    [{ estado: 'FALLIDO' }, 'FALLIDA'],
    [{ estado: 'EXPIRADO' }, 'FALLIDA'],
  ];
  for (const [viejo, nuevo] of casos) {
    assert.equal(estadoMigrado(viejo), nuevo, JSON.stringify(viejo));
    const intent = { ...viejo };
    assert.equal(migrar(intent, new Date('2026-10-10T00:00:00Z')), true);
    assert.equal(intent.estado, nuevo);
    assert.equal(intent.decision, null);
    assert.deepEqual(intent.traza, [{ en: '2026-10-10T00:00:00.000Z', actor: 'sistema', evento: 'MIGRACION', datos: { de: viejo.estado, a: nuevo } }]);
    assert.equal(migrar(intent), false, 'idempotente');
  }
  // Ya migrados (incluidos RECHAZADA y CAMBIOS_SOLICITADOS de F-03) solo ganan decision y traza.
  const rechazada = { estado: 'RECHAZADA', decision: { accion: 'RECHAZAR' } };
  assert.equal(estadoMigrado(rechazada), null);
  migrar(rechazada);
  assert.deepEqual(rechazada, { estado: 'RECHAZADA', decision: { accion: 'RECHAZAR' }, traza: [] });
  // Desconocido: se deja como esta.
  assert.equal(estadoMigrado({ estado: 'RARO' }), null);
});
