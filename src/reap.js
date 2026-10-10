// Cliente de Reap Agentic Payments.
//
// Mismo contrato en dos modos, como las integraciones de pago de Peluqueria: real cuando hay
// REAP_API_KEY y simulado cuando no. El simulado imita la forma de las respuestas de la doc
// para ensayar la demo sin red; nunca se usa si hay llave.
//
// La tarjeta nunca pasa por aqui: se guarda en la pagina alojada de Reap (enrollment) y cada
// cargo se aprueba en otra pagina alojada (checkout). Este modulo solo maneja IDs.
import { randomUUID } from 'node:crypto';

const KEY = process.env.REAP_API_KEY;
const BASE = (process.env.REAP_BASE || 'https://sandbox.api.reap.global').replace(/\/+$/, '');
const VERSION = process.env.REAP_VERSION || '2025-02-14';
export const modo = KEY ? 'real' : 'simulado';

// Solo se reintenta si la conexion no llego a abrirse (la red del venue corta al azar): Reap
// no vio la peticion, y los POST que crean algo llevan Idempotency-Key fija de todos modos.
async function conReintento(url, opciones, intentos = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, { ...opciones, signal: AbortSignal.timeout(60000) });
    } catch (e) {
      const sinConexion = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(e.cause?.code);
      if (!sinConexion || i >= intentos) throw new Error(`Sin conexion con Reap (${e.cause?.code || e.name})`);
      await new Promise((s) => setTimeout(s, 1000 * i));
    }
  }
}

async function reap(ruta, { metodo = 'GET', cuerpo, idempotencia, extra = {} } = {}) {
  const r = await conReintento(`${BASE}${ruta}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Reap-Version': VERSION,
      ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
      ...(idempotencia ? { 'Idempotency-Key': idempotencia } : {}),
      ...extra,
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    // La llave nunca va en el mensaje; el codigo de Reap si, porque dice que corregir.
    // Reap responde { error: { code, message, detail } }.
    const err = datos.error || datos;
    const detalle = err.detail ? ` ${JSON.stringify(err.detail).slice(0, 400)}` : '';
    const e = new Error(`Reap ${r.status} en ${ruta}: ${err.code || ''} ${err.message || ''}${detalle}`.trim());
    e.status = r.status;
    e.codigo = err.code;
    throw e;
  }
  return datos;
}

// Para la consola: deja ver que campos de la direccion van y cuales faltan, sin el telefono ni la calle.
const tapar = (v, visibles = 0) => (v ? `***${visibles ? String(v).slice(-visibles) : ''}` : v);
const enmascarar = (envio) => envio && { ...envio, phone: tapar(envio.phone, 2), addressLine1: tapar(envio.addressLine1), addressLine2: tapar(envio.addressLine2), postalCode: tapar(envio.postalCode) };

const real = {
  crearEnrollment: ({ clienteId, email, returnUrl }) =>
    reap('/agentic/enrollments', {
      metodo: 'POST',
      idempotencia: randomUUID(),
      cuerpo: {
        source: 'EXTERNAL',
        owner: { type: 'CLIENT_REFERENCE', id: clienteId, email },
        presentation: { type: 'REDIRECT', returnUrl },
      },
    }),
  enrollment: (id) => reap(`/agentic/enrollments/${encodeURIComponent(id)}`),
  buscar: ({ query, pais, moneda, max }) =>
    reap('/agentic/products/search', {
      metodo: 'POST',
      cuerpo: {
        query,
        context: { country: pais, currency: moneda },
        filters: { availability: 'AVAILABLE_ONLY', ...(max ? { price: { max: String(max) } } : {}) },
        pagination: { limit: 5 },
      },
    }),
  cotizar: ({ variantId, cantidad, email, envio, clave }) => {
    const cuerpo = { items: [{ variantId, quantity: cantidad }], email, shippingAddress: envio };
    console.log(`Reap POST /agentic/quotes ${JSON.stringify({ ...cuerpo, shippingAddress: enmascarar(envio) })}`);
    return reap('/agentic/quotes', { metodo: 'POST', idempotencia: clave, cuerpo });
  },
  elegirEnvio: (quoteId, shippingOptionId) =>
    reap(`/agentic/quotes/${encodeURIComponent(quoteId)}/shipping-option`, {
      metodo: 'POST',
      cuerpo: { shippingOptionId },
    }),
  checkout: ({ quoteId, enrollmentId, returnUrl, clave }) =>
    reap('/agentic/checkouts', {
      metodo: 'POST',
      idempotencia: clave,
      // Solo existe en sandbox; produccion lo rechaza, y este servicio solo corre en sandbox.
      extra: { 'X-Simulate-Checkout': 'COMPLETED' },
      cuerpo: { quoteId, enrollmentId, presentation: { type: 'REDIRECT', returnUrl } },
    }),
  consultarCheckout: (id) => reap(`/agentic/checkouts/${encodeURIComponent(id)}`),
};

// ponytail: catalogo fijo con productos de la lista oficial de comercios; basta para ensayar sin red.
const CATALOGO = [
  { id: 'prd_sim_1', merchant: 'Package Free', name: 'Multi-Purpose Cleaning Spray (4 Pack)', price: 28.99, tags: ['cleaning', 'cleaner', 'spray', 'limpiador'] },
  { id: 'prd_sim_2', merchant: 'CoffeeAM', name: 'Costa Rica Reserve Coffee', price: 19.95, tags: ['coffee', 'cafe'] },
  { id: 'prd_sim_3', merchant: 'Keychron', name: 'Keychron K8 Wireless Mechanical Keyboard', price: 69.99, tags: ['keyboard', 'keychron', 'teclado'] },
  { id: 'prd_sim_4', merchant: 'Plugable Technologies', name: 'Plugable USB-C Triple Monitor Docking Station', price: 149.99, tags: ['docking', 'dock', 'plugable'] },
  { id: 'prd_sim_5', merchant: 'Baronfig', name: 'Thinker Tote Bundle', price: 95, tags: ['tote', 'baronfig', 'bolsa'] },
];
const memoria = new Map();
const usd = (amount) => ({ amount: Math.round(amount * 100) / 100, currency: 'USD' });

const simulado = {
  async crearEnrollment({ clienteId, email, returnUrl }) {
    const id = `enr_sim_${clienteId}`;
    memoria.set(id, { id, status: 'ACTIVE', owner: { type: 'CLIENT_REFERENCE', id: clienteId, email } });
    return { ...memoria.get(id), status: 'REQUIRES_ACTION', nextAction: { type: 'REDIRECT', url: returnUrl } };
  },
  enrollment: async (id) => memoria.get(id) || { id, status: 'EXPIRED' },
  async buscar({ query }) {
    const q = query.toLowerCase();
    const hits = CATALOGO.filter((p) => p.tags.some((t) => q.includes(t)) || q.includes(p.name.toLowerCase()));
    return {
      id: randomUUID(),
      products: hits.map((p) => ({
        id: p.id,
        merchant: { name: p.merchant },
        name: p.name,
        available: true,
        previewVariant: { id: `var_${p.id}`, name: p.name, price: usd(p.price), available: true },
      })),
    };
  },
  async cotizar({ variantId, cantidad }) {
    const p = CATALOGO.find((x) => `var_${x.id}` === variantId);
    const sub = p.price * cantidad;
    const q = {
      id: `quo_sim_${randomUUID().slice(0, 8)}`,
      shippingOptions: [
        { id: 'std', name: 'Standard', selected: true, price: usd(5.99) },
        { id: 'exp', name: 'Express', selected: false, price: usd(12.99) },
      ],
      amountBreakdown: {
        itemsSubtotal: usd(sub),
        shipping: usd(5.99),
        tax: { amount: usd(sub * 0.08), includedInPrices: false },
        finalAmount: usd(sub * 1.08 + 5.99),
      },
      expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
    };
    memoria.set(q.id, q);
    return q;
  },
  elegirEnvio: async (quoteId) => memoria.get(quoteId),
  async checkout({ quoteId, enrollmentId, returnUrl }) {
    const q = memoria.get(quoteId);
    // Las cotizaciones simuladas viven en memoria: si el servidor se reinicio, ya no existen.
    if (!q) throw Object.assign(new Error('La cotización simulada se perdió al reiniciar el servidor; recotiza.'), { status: 409 });
    const c = {
      id: `chk_sim_${randomUUID().slice(0, 8)}`,
      status: 'COMPLETED',
      quoteId,
      enrollmentId,
      orderId: `SIM-${Date.now().toString().slice(-6)}`,
      finalAmount: q.amountBreakdown.finalAmount,
    };
    memoria.set(c.id, c);
    return { ...c, status: 'REQUIRES_ACTION', nextAction: { type: 'REDIRECT', url: returnUrl } };
  },
  consultarCheckout: async (id) => memoria.get(id),
};

export const reapApi = KEY ? real : simulado;
