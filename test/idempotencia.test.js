import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claveEnrollment } from '../src/reap.js';

const base = { clienteId: 'jpay-empresa-demo', email: 'compras@jpay.demo', returnUrl: 'https://uno.trycloudflare.com/finanzas.html' };

test('la llave del enrollment se repite para el mismo cliente y cuerpo (doble clic)', () => {
  assert.equal(claveEnrollment(base), claveEnrollment({ ...base }));
  assert.equal(claveEnrollment(base), claveEnrollment({ ...base, sufijo: 1 }));
  assert.match(claveEnrollment(base), /^jpay-enr-jpay-empresa-demo-1-[0-9a-f]{12}$/);
  assert.ok(claveEnrollment(base).length <= 255);
});

test('la llave cambia si avanza el sufijo o cambia el cuerpo (otro tunel, otro correo)', () => {
  const llaves = new Set([
    claveEnrollment(base),
    claveEnrollment({ ...base, sufijo: 2 }),
    claveEnrollment({ ...base, returnUrl: 'https://dos.trycloudflare.com/finanzas.html' }),
    claveEnrollment({ ...base, email: 'otro@jpay.demo' }),
    claveEnrollment({ ...base, clienteId: 'otra-empresa' }),
  ]);
  assert.equal(llaves.size, 5);
});
