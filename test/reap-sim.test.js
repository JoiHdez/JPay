import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearSimulado, atenderAprobacion } from '../src/reap-sim.js';
import { revisar } from '../src/guard.js';
import { preAsiento, cuadra, centavos } from '../src/ledger.js';
import { proponer } from '../src/agente.js';
import { CATEGORIAS } from '../src/catalogo.js';

// Cada prueba usa su propio JSON en un directorio temporal; nunca toca data/reap-sim.json.
const dir = await mkdtemp(join(tmpdir(), 'jpay-sim-'));
after(() => rm(dir, { recursive: true, force: true }));
let n = 0;
const archivoNuevo = () => join(dir, `sim-${++n}.json`);
const sim = crearSimulado({ archivo: archivoNuevo() });
const RETORNO = 'http://localhost:3013/retorno?intent=INT-prueba';

// Los presets de public/solicitante.html: sin red, cada uno debe cotizar y pasar el Ledger Guard.
const PRESETS = [
  { cc: 'OPS', busqueda: 'laundry detergent', categoria: 'oficina', tope: 45, cantidad: 1, max: 2 },
  { cc: 'OPS', busqueda: 'paper towels', categoria: 'oficina', tope: 70, cantidad: 1, max: 1 },
  { cc: 'MKT', busqueda: 'tote bag', categoria: 'marketing', tope: 80, cantidad: 1, max: 3 },
  { cc: 'IT', busqueda: 'laptop stand', categoria: 'computo', tope: 120, cantidad: 1, max: 1 },
];

// Lo mismo que hace server.js: primer producto de la busqueda, quote, propuesta, pre-asiento y guard.
async function cotizarPreset(p, cantidad) {
  const { products } = await sim.buscar({ query: p.busqueda, pais: 'US', moneda: 'USD' });
  assert.ok(products.length, `sin productos para "${p.busqueda}"`);
  const [primero] = products;
  const quote = await sim.cotizar({ variantId: primero.previewVariant.id, cantidad, email: 'compras@jpay.demo' });
  const producto = { nombre: primero.name, tienda: primero.merchant.name };
  const propuesta = proponer({ producto, quote, cantidadBase: cantidad });
  const cuenta = CATEGORIAS[p.categoria].cuenta;
  const intent = { estado: 'SIN_COTIZACION', busqueda: p.busqueda, categoria: p.categoria, cuenta, maxCantidad: p.max, topeUsd: p.tope, envio: 'economico', moneda: 'USD' };
  const pre = preAsiento({ cc: p.cc, cuenta, breakdown: quote.amountBreakdown });
  return revisar({ intent, propuesta, quote, pre, disponibleCc: 0 });
}

for (const p of PRESETS) {
  test(`preset "${p.busqueda}" cotiza y pasa el guard, aun con la cantidad maxima`, async () => {
    assert.deepEqual(await cotizarPreset(p, p.cantidad), { permitido: true, violaciones: [] });
    assert.deepEqual(await cotizarPreset(p, p.max), { permitido: true, violaciones: [] });
  });
}

test('la busqueda pone primero lo mas parecido y conserva el catalogo de aef8f3a', async () => {
  const { products } = await sim.buscar({ query: 'tote bag' });
  assert.deepEqual(products.map((p) => p.name), ['Organic Cotton Tote Bag', 'Thinker Tote Bundle']);
  for (const q of ['cleaning spray', 'coffee', 'keyboard', 'docking station']) {
    assert.equal((await sim.buscar({ query: q })).products.length, 1, q);
  }
  assert.deepEqual((await sim.buscar({ query: 'gaming chair' })).products, []);
});

test('elegir envio recalcula el total y marca la opcion, y el pre-asiento sigue cuadrando', async () => {
  const q = await sim.cotizar({ variantId: 'var_prd_sim_6', cantidad: 1 });
  const exp = await sim.elegirEnvio(q.id, 'exp');
  assert.equal(exp.id, q.id);
  assert.deepEqual(exp.shippingOptions.map((o) => [o.id, o.selected]), [['std', false], ['exp', true]]);
  assert.equal(exp.amountBreakdown.shipping.amount, 12.99);
  assert.equal(centavos(exp.amountBreakdown.finalAmount.amount) - centavos(q.amountBreakdown.finalAmount.amount), 700);
  assert.ok(cuadra(preAsiento({ cc: 'OPS', cuenta: 5100, breakdown: exp.amountBreakdown })));
  await assert.rejects(sim.elegirEnvio(q.id, 'dron'), { status: 400, codigo: 'AGENTIC_REQUEST_REJECTED' });
  await assert.rejects(sim.elegirEnvio('quo_no_existe', 'std'), { status: 404 });
});

test('el estado sobrevive un reinicio: tarjeta ACTIVE, quote y checkout siguen ahi', async () => {
  const archivo = archivoNuevo();
  const antes = crearSimulado({ archivo });
  const e = await antes.crearEnrollment({ clienteId: 'jpay-empresa-demo', email: 'compras@jpay.demo', returnUrl: RETORNO });
  const q = await antes.cotizar({ variantId: 'var_prd_sim_9', cantidad: 1, clave: 'INT-1-quo-base-0' });
  const c = await antes.checkout({ quoteId: q.id, enrollmentId: e.id, returnUrl: RETORNO, clave: 'INT-1-chk' });

  const despues = crearSimulado({ archivo }); // como si el servidor se reiniciara
  assert.equal((await despues.enrollment(e.id)).status, 'ACTIVE');
  assert.equal((await despues.consultarCheckout(c.id)).status, 'REQUIRES_ACTION');
  // La misma Idempotency-Key devuelve lo mismo, aun despues del reinicio.
  assert.equal((await despues.cotizar({ variantId: 'var_prd_sim_9', cantidad: 1, clave: 'INT-1-quo-base-0' })).id, q.id);
  assert.equal((await despues.checkout({ quoteId: q.id, enrollmentId: e.id, returnUrl: RETORNO, clave: 'INT-1-chk' })).id, c.id);
  // Un checkout que el simulador no conoce se da por expirado en vez de reventar la conciliacion.
  assert.deepEqual(await despues.consultarCheckout('chk_sim_perdido'), { id: 'chk_sim_perdido', status: 'EXPIRED' });
});

test('una cotización perdida devuelve 409 y pide recotizar en lugar de crear checkout', async () => {
  const archivo = archivoNuevo();
  const antes = crearSimulado({ archivo });
  const q = await antes.cotizar({ variantId: 'var_prd_sim_9', cantidad: 1 });
  await rm(archivo);
  const despues = crearSimulado({ archivo });
  await assert.rejects(despues.checkout({ quoteId: q.id, returnUrl: RETORNO }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.codigo, 'QUOTE_EXPIRED');
    assert.match(error.message, /recotiza/);
    return true;
  });
});

// Un checkout listo para aprobar, con reloj controlable para probar el vencimiento.
async function checkoutNuevo() {
  const reloj = { t: Date.parse('2026-10-10T18:00:00Z') };
  const s = crearSimulado({ archivo: archivoNuevo(), ahora: () => reloj.t });
  const e = await s.crearEnrollment({ clienteId: 'jpay-empresa-demo', email: 'compras@jpay.demo', returnUrl: RETORNO });
  const q = await s.cotizar({ variantId: 'var_prd_sim_8', cantidad: 2 });
  const c = await s.checkout({ quoteId: q.id, enrollmentId: e.id, returnUrl: RETORNO });
  return { s, q, c, reloj };
}

test('el checkout espera aprobacion en /sim/aprobar, del mismo origen que el returnUrl', async () => {
  const { q, c } = await checkoutNuevo();
  assert.equal(c.status, 'REQUIRES_ACTION');
  assert.deepEqual(c.nextAction, { type: 'REDIRECT', url: `http://localhost:3013/sim/aprobar?checkout=${c.id}` });
  assert.deepEqual(c.finalAmount, q.amountBreakdown.finalAmount);
  assert.equal(c.orderId, undefined);
});

test('aprobar deja el checkout COMPLETED con orderId y finalAmount; un segundo clic no cambia nada', async () => {
  const { s, q, c } = await checkoutNuevo();
  const ok = await s.decidir(c.id, true);
  assert.equal(ok.status, 'COMPLETED');
  assert.match(ok.orderId, /^SIM-\d{6}$/);
  assert.deepEqual(ok.finalAmount, q.amountBreakdown.finalAmount);
  assert.equal(ok.nextAction, undefined);
  assert.deepEqual(await s.decidir(c.id, false), ok);
  assert.deepEqual(await s.consultarCheckout(c.id), ok);
});

test('rechazar lo deja FAILED, y si nadie decide en 5 minutos tambien falla, como Reap', async () => {
  const rechazado = await checkoutNuevo();
  assert.equal((await rechazado.s.decidir(rechazado.c.id, false)).status, 'FAILED');

  const { s, c, reloj } = await checkoutNuevo();
  reloj.t += 4 * 60000;
  assert.equal((await s.consultarCheckout(c.id)).status, 'REQUIRES_ACTION');
  reloj.t += 60000;
  assert.deepEqual([(await s.consultarCheckout(c.id)).status, (await s.consultarCheckout(c.id)).failureReason], ['FAILED', 'APPROVAL_TIMEOUT']);
  assert.equal((await s.decidir(c.id, true)).status, 'FAILED'); // tarde: ya no se puede aprobar
});

// Peticion y respuesta minimas de node:http para probar la pagina sin abrir un puerto.
function llamar(s, metodo, ruta, cuerpo = '') {
  const req = { method: metodo, async *[Symbol.asyncIterator]() { if (cuerpo) yield cuerpo; } };
  return new Promise((ok, mal) => {
    const res = {
      writeHead(status, headers = {}) { Object.assign(this, { status, headers }); },
      end(body = '') { ok({ status: this.status, headers: this.headers, body: String(body) }); },
    };
    atenderAprobacion(req, res, new URL(ruta, 'http://localhost:3013'), s).catch(mal);
  });
}

test('la pagina /sim/aprobar avisa que es simulada, muestra el monto y redirige al returnUrl', async () => {
  const { s, q, c } = await checkoutNuevo();
  const total = q.amountBreakdown.finalAmount.amount.toFixed(2);
  const pagina = await llamar(s, 'GET', `/sim/aprobar?checkout=${c.id}`);
  assert.equal(pagina.status, 200);
  assert.match(pagina.body, /Simulador de Reap &mdash; sin dinero real/);
  assert.ok(pagina.body.includes(`USD ${total}`));
  assert.ok(pagina.body.includes('Organic Cotton Tote Bag'));

  assert.equal((await llamar(s, 'POST', '/sim/aprobar', `checkout=${c.id}&accion=borrar`)).status, 400);
  const r = await llamar(s, 'POST', '/sim/aprobar', `checkout=${c.id}&accion=aprobar`);
  assert.deepEqual([r.status, r.headers.Location], [303, RETORNO]);
  assert.equal((await s.consultarCheckout(c.id)).status, 'COMPLETED');
  assert.match((await llamar(s, 'GET', `/sim/aprobar?checkout=${c.id}`)).body, /Pago aprobado\. Orden SIM-/);

  assert.equal((await llamar(s, 'GET', '/sim/aprobar?checkout=chk_sim_nada')).status, 404);
  assert.equal((await llamar(s, 'POST', '/sim/aprobar', 'checkout=chk_sim_nada&accion=aprobar')).status, 404);
});
