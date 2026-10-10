// Cliente de Reap Agentic Payments.
//
// Mismo contrato en dos modos, como las integraciones de pago de Peluqueria: real cuando hay
// REAP_API_KEY y simulado cuando no. El simulado imita la forma de las respuestas de la doc
// para ensayar la demo sin red; nunca se usa si hay llave.
//
// La tarjeta nunca pasa por aqui: se guarda en la pagina alojada de Reap (enrollment) y cada
// cargo se aprueba en otra pagina alojada (checkout). Este modulo solo maneja IDs.
import { createHash } from 'node:crypto';
import { simulado } from './reap-sim.js';

const KEY = process.env.REAP_API_KEY;
const BASE = (process.env.REAP_BASE || 'https://sandbox.api.reap.global').replace(/\/+$/, '');
const VERSION = process.env.REAP_VERSION || '2025-02-14';
export const modo = KEY ? 'real' : 'simulado';
// X-Simulate-Checkout completa el checkout sin la pagina hosted; solo existe en sandbox y es opt-in,
// para que por defecto el humano apruebe cada cargo en Reap.
const SIMULAR_CHECKOUT = process.env.REAP_SIMULAR_CHECKOUT === '1';
export const modoCheckout = KEY && !SIMULAR_CHECKOUT ? 'hosted' : 'simulado';

/**
 * Idempotency-Key del enrollment. Reap guarda la primera respuesta 24 h por llave: un doble clic
 * con la misma llave recibe el mismo enrollment. La huella del cuerpo cambia la llave si cambia el
 * returnUrl (otro tunel), porque misma llave con otro cuerpo es 400 IDEMPOTENT_PARAMETER_MISMATCH;
 * el sufijo lo avanza el servidor cuando hace falta un enrollment nuevo.
 */
export function claveEnrollment({ clienteId, email, returnUrl, sufijo = 1 }) {
  const huella = createHash('sha256').update(JSON.stringify([email, returnUrl])).digest('hex').slice(0, 12);
  return `jpay-enr-${clienteId}-${sufijo}-${huella}`;
}

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

/**
 * true si Reap guardo este error con la Idempotency-Key y lo repetiria 24 h: reintentar exige otra
 * llave. Guarda todo salvo 401, 422 y 429; 409 IDEMPOTENCY_REQUEST_IN_PROGRESS es la misma llave aun
 * en vuelo. Sin status no hubo respuesta y la misma llave es lo seguro (api-reference/idempotency).
 */
export const errorGuardado = (e) => Boolean(e?.status) && ![401, 422, 429].includes(e.status) && e.codigo !== 'IDEMPOTENCY_REQUEST_IN_PROGRESS';

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
  crearEnrollment: ({ clienteId, email, returnUrl, sufijo }) =>
    reap('/agentic/enrollments', {
      metodo: 'POST',
      idempotencia: claveEnrollment({ clienteId, email, returnUrl, sufijo }),
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
      // Responde REQUIRES_ACTION con nextAction.url: la pagina hosted donde el humano aprueba.
      // El header de simulacion solo existe en sandbox; produccion lo rechaza.
      extra: SIMULAR_CHECKOUT ? { 'X-Simulate-Checkout': 'COMPLETED' } : {},
      cuerpo: { quoteId, enrollmentId, presentation: { type: 'REDIRECT', returnUrl } },
    }),
  consultarCheckout: (id) => reap(`/agentic/checkouts/${encodeURIComponent(id)}`),
};

// El simulado vive en reap-sim.js (plan B sin red); nunca se usa si hay llave.
export const reapApi = KEY ? real : simulado;
