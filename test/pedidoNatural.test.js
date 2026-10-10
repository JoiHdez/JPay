import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretar } from '../src/pedidoNatural.js';

// Cliente falso con la misma forma que el SDK: no llama a la red.
const falso = (respuesta) => ({ beta: { messages: { parse: async (params) => { falso.ultimo = params; return respuesta; } } } });

const propuesta = { cc: 'OPS', categoria: 'oficina', busqueda: 'laundry detergent', cantidad: 1, maxCantidad: 1, topeUsd: 40, resumen: 'Detergente para la oficina, tope 40 USD.', faltante: null };

test('devuelve la propuesta validada y pide salida estructurada con fallback', async () => {
  const p = await interpretar('necesito detergente para la oficina, máximo 40 dólares', { client: falso({ stop_reason: 'end_turn', parsed_output: propuesta }) });
  assert.deepEqual(p, propuesta);
  assert.equal(falso.ultimo.model, 'claude-opus-5-5');
  assert.equal(falso.ultimo.fallbacks, 'default');
  assert.ok(falso.ultimo.output_config.format);
});

test('rechazo y salida invalida se convierten en errores con status', async () => {
  await assert.rejects(interpretar('x', { client: falso({ stop_reason: 'refusal', parsed_output: null }) }), (e) => e.status === 422);
  await assert.rejects(interpretar('x', { client: falso({ stop_reason: 'end_turn', parsed_output: { ...propuesta, cc: 'FIN' } }) }), (e) => e.status === 502);
  await assert.rejects(interpretar('x', { client: falso({ stop_reason: 'end_turn', parsed_output: null }) }), (e) => e.status === 502);
});
