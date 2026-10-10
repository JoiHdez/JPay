// Decisiones de finanzas que no pasan por Reap: rechazar y pedir cambios. Reap no tiene endpoint
// para cancelar un checkout, asi que estas decisiones solo existen antes de crearlo.
//
// Funciones puras sobre el intent y el libro: el servidor les pasa su publicar() y guarda.
import * as L from './ledger.js';

// Pendiente de autorizar en el formato actual de /api/estado (ver nota en docs/CONTRATO.md).
export const PENDIENTE = 'APROBADO';
export const MAX_MOTIVO = 280;

/** Error con status HTTP y codigo para la respuesta { error, codigo }. */
export function falla(status, mensaje, codigo) {
  const e = new Error(mensaje);
  e.status = status;
  if (codigo) e.codigoApi = codigo;
  return e;
}

/** Centavos que el intent tiene vivos en 8100: compromisos menos liberaciones, del libro mismo. */
export function comprometidoVivo(asientos, intentId) {
  let vivo = 0;
  for (const a of asientos) {
    if (a.estado !== 'PUBLICADO' || a.intentId !== intentId) continue;
    for (const l of a.lineas) if (Number(l.cuenta) === 8100) vivo += (l.debe || 0) - (l.haber || 0);
  }
  return vivo;
}

/**
 * Libera lo que el intent tenga comprometido, una sola vez: se calcula del libro, asi que una
 * segunda llamada no encuentra nada que liberar. Devuelve el asiento publicado o null.
 */
export function liberarCompromiso(intent, asientos, publicar, concepto) {
  const vivo = comprometidoVivo(asientos, intent.id);
  if (vivo <= 0) return null;
  return publicar(L.liberacion({ cc: intent.cc, monto: vivo }), intent, concepto);
}

/** Texto corto obligatorio (motivo o comentario). */
export function textoObligatorio(valor, nombre) {
  const t = String(valor ?? '').trim();
  if (!t) throw falla(400, `Escribe el ${nombre}.`, 'DATOS_INVALIDOS');
  if (t.length > MAX_MOTIVO) throw falla(400, `El ${nombre} va de 1 a ${MAX_MOTIVO} letras.`, 'DATOS_INVALIDOS');
  return t;
}

const ACCIONES = {
  RECHAZAR: { estado: 'RECHAZADA', campo: 'motivo', concepto: 'Libera compromiso: finanzas rechazo la compra' },
  CAMBIOS: { estado: 'CAMBIOS_SOLICITADOS', campo: 'comentario', concepto: 'Libera compromiso: finanzas pidio cambios' },
};

/**
 * Rechaza o pide cambios a una compra pendiente de autorizar (con o sin cotizacion, bloqueada
 * incluida). Libera el compromiso y deja la decision en el intent.
 */
export function decidir(intent, { accion, por, motivo }, { asientos, publicar, ahora = new Date() }) {
  const a = ACCIONES[accion];
  if (!a) throw falla(400, 'Accion invalida.', 'DATOS_INVALIDOS');
  if (intent.estado !== PENDIENTE) {
    throw falla(409, `La compra esta ${intent.estado}; solo se rechaza o se piden cambios mientras espera autorizacion.`, 'TRANSICION_INVALIDA');
  }
  const texto = textoObligatorio(motivo, a.campo);
  intent.estado = a.estado;
  intent.decision = { por: String(por || 'Finanzas').trim().slice(0, 40) || 'Finanzas', en: ahora.toISOString(), accion, motivo: texto };
  liberarCompromiso(intent, asientos, publicar, a.concepto);
  return intent;
}

/**
 * Despues de pedir cambios, la recotizacion vuelve a reservar el tope antes de quedar pendiente.
 * disponibleCc: centavos libres del centro de costo (ya sin este intent, que no tiene compromiso).
 */
export function recomprometer(intent, { asientos, publicar, disponibleCc }) {
  if (intent.estado !== 'CAMBIOS_SOLICITADOS') throw falla(409, `La compra esta ${intent.estado}.`, 'TRANSICION_INVALIDA');
  const tope = L.centavos(intent.topeUsd);
  if (comprometidoVivo(asientos, intent.id) <= 0) {
    if (tope > disponibleCc) {
      throw falla(409, `El centro de costo ${intent.cc} ya no tiene presupuesto para el tope de USD ${intent.topeUsd}; no se puede recotizar.`, 'PRESUPUESTO_INSUFICIENTE');
    }
    publicar(L.compromiso({ cc: intent.cc, monto: tope }), intent, `Compromiso: ${intent.busqueda} (recotizacion tras cambios)`);
  }
  // La decision anterior se conserva en el historial; la compra vuelve a esperar autorizacion.
  intent.decisiones = [...(intent.decisiones || []), intent.decision].filter(Boolean);
  intent.decision = null;
  intent.estado = PENDIENTE;
  return intent;
}
