// Lectura del checkout de Reap y reglas del pago que no necesitan red ni estado: el servidor llama
// a Reap y publica; aqui solo se interpreta la respuesta, para probarlo con fixtures de la doc.
import * as L from './ledger.js';

export const NO_SE_COBRO = 'Reap no completo el pago. No se cobro nada.';

// Reap documenta finalAmount.amount como number; se acepta string por si el sandbox lo manda asi.
function aCentavos(amount) {
  const n = typeof amount === 'number' ? amount : typeof amount === 'string' && amount.trim() ? Number(amount) : NaN;
  return Number.isFinite(n) && n >= 0 ? L.centavos(n) : null;
}

/**
 * Lee la respuesta de GET /agentic/checkouts/{id}: { id, status, orderId, finalAmount: { amount,
 * currency }, nextAction }. status: REQUIRES_ACTION | PROCESSING | COMPLETED | FAILED | EXPIRED.
 * `falta` nombra el dato que un COMPLETED debio traer y no trajo; con el, no se contabiliza.
 */
export function leerCheckout(r) {
  const estado = r?.status ?? null;
  const finalCents = aCentavos(r?.finalAmount?.amount);
  const moneda = r?.finalAmount?.currency || null;
  let falta = null;
  if (estado === 'COMPLETED') falta = finalCents == null ? 'finalAmount' : !moneda ? 'finalAmount.currency' : null;
  return { estado, orderId: r?.orderId ?? null, finalCents, moneda, urlAprobacion: r?.nextAction?.url || null, falta };
}

/**
 * Que hacer con el intent segun el checkout leido. Solo COMPLETED devenga, por el finalAmount
 * cobrado (la diferencia contra lo cotizado va a 5900); FAILED y EXPIRED son finales y liberan el
 * compromiso. null mientras Reap no termine. Con `estado: null` y `error`, el intent sigue en
 * checkout y el error se muestra: nunca se contabiliza un monto que Reap no confirmo.
 */
export function cierreDelCheckout({ intent, lectura }) {
  const libera = (concepto) => ({ ...L.liberacion({ cc: intent.cc, monto: L.centavos(intent.topeUsd) }), concepto });
  if (lectura.estado === 'FAILED') return { estado: 'FALLIDO', error: NO_SE_COBRO, asientos: [libera('Libera compromiso: checkout FAILED')] };
  if (lectura.estado === 'EXPIRED') {
    return { estado: 'EXPIRADO', error: 'Reap no completo el pago: nadie lo aprobo a tiempo. No se cobro nada.', asientos: [libera('Libera compromiso: checkout EXPIRED')] };
  }
  if (lectura.estado !== 'COMPLETED') return null;

  const orden = lectura.orderId || 'sin orden';
  if (lectura.falta) {
    return { estado: null, asientos: [], error: `Reap marco el pago COMPLETED (orden ${orden}) sin ${lectura.falta}; no se contabiliza hasta saber cuanto cobro. Revisa la orden en Reap.` };
  }
  if (lectura.moneda !== intent.moneda) {
    return { estado: null, asientos: [], error: `Reap cobro en ${lectura.moneda} y el intent es en ${intent.moneda} (orden ${orden}); no se contabiliza sin convertir.` };
  }
  const asientos = L.devengado({ pre: intent.pre, finalCheckout: L.usd(lectura.finalCents), cc: intent.cc }).map((a) => ({
    ...a,
    concepto: a.tipo === 'AJUSTE' ? `Ajuste: Reap cobro distinto a lo cotizado (orden ${orden})` : `${intent.producto.nombre} · ${intent.producto.tienda} · orden ${orden}`,
  }));
  asientos.push(libera('Libera compromiso: pago completado'));
  return { estado: 'COMPLETADO', error: null, asientos };
}

/** amountBreakdown de un quote en centavos, con los nombres del contrato. */
export function desglose(b) {
  const c = (m) => aCentavos(m?.amount ?? m) ?? 0;
  return {
    producto: c(b?.itemsSubtotal),
    envio: c(b?.shipping),
    impuesto: c(b?.tax?.amount),
    descuento: (b?.discounts || []).reduce((s, d) => s + c(d.amount ?? d), 0),
    total: c(b?.finalAmount),
  };
}

/** true si a la cotizacion le queda menos del margen (o ya vencio): el checkout la rechazaria. */
export const porVencer = (expira, ahora = Date.now(), margenMs = 60000) => Boolean(expira) && new Date(expira).getTime() - ahora < margenMs;

