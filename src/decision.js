// Decisiones de finanzas que no pasan por Reap (rechazar y pedir cambios) y el compromiso de
// presupuesto que sigue al estado del intent. Reap no tiene endpoint para cancelar un checkout,
// asi que rechazar solo existe antes de crearlo.
//
// Funciones puras sobre el intent y el libro: el servidor les pasa su publicar() y guarda.
import * as L from './ledger.js';
import { CON_COMPROMISO, puede, transicionar } from './estados.js';

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

const LIBERA = {
  BLOQUEADA: 'Libera compromiso: el Ledger Guard bloqueo la cotizacion',
  SIN_COTIZACION: 'Libera compromiso: sin cotizacion valida',
  EXPIRADA: 'Libera compromiso: la cotizacion de Reap expiro',
  RECHAZADA: 'Libera compromiso: finanzas rechazo la compra',
  CAMBIOS_SOLICITADOS: 'Libera compromiso: finanzas pidio cambios',
  FALLIDA: 'Libera compromiso: el pago no se completo',
  PAGADA: 'Libera compromiso: pago completado',
};

/**
 * El compromiso sigue al estado: se reserva el tope al entrar a CON_COMPROMISO (una cotizacion
 * que paso el guard) y se libera al salir. Idempotente. Devuelve el asiento publicado o null.
 */
export function sincronizarCompromiso(intent, asientos, publicar, concepto) {
  const vivo = comprometidoVivo(asientos, intent.id);
  if (CON_COMPROMISO.includes(intent.estado)) {
    if (vivo > 0) return null;
    return publicar(L.compromiso({ cc: intent.cc, monto: L.centavos(intent.topeUsd) }), intent, concepto || `Compromiso: ${intent.busqueda} (${intent.solicitante || 'Equipo'})`);
  }
  return liberarCompromiso(intent, asientos, publicar, concepto || LIBERA[intent.estado] || `Libera compromiso: ${intent.estado}`);
}

/** Texto corto obligatorio (motivo o comentario). */
export function textoObligatorio(valor, nombre) {
  const t = String(valor ?? '').trim();
  if (!t) throw falla(400, `Escribe el ${nombre}.`, 'DATOS_INVALIDOS');
  if (t.length > MAX_MOTIVO) throw falla(400, `El ${nombre} va de 1 a ${MAX_MOTIVO} letras.`, 'DATOS_INVALIDOS');
  return t;
}

const ACCIONES = {
  RECHAZAR: { estado: 'RECHAZADA', campo: 'motivo', verbo: 'rechazar' },
  CAMBIOS: { estado: 'CAMBIOS_SOLICITADOS', campo: 'comentario', verbo: 'pedir cambios a' },
};

/**
 * Rechaza o pide cambios segun la maquina de estados (rechazar: cotizada, bloqueada, sin
 * cotizacion o expirada; pedir cambios: cotizada). Libera el compromiso y deja la decision.
 */
export function decidir(intent, { accion, por, motivo }, { asientos, publicar, ahora = new Date() }) {
  const a = ACCIONES[accion];
  if (!a) throw falla(400, 'Accion invalida.', 'DATOS_INVALIDOS');
  if (!puede(intent.estado, a.estado)) {
    throw falla(409, `La compra esta ${intent.estado}; no se puede ${a.verbo} una compra en ese estado.`, 'TRANSICION_INVALIDA');
  }
  const texto = textoObligatorio(motivo, a.campo);
  const quien = String(por || 'Finanzas').trim().slice(0, 40) || 'Finanzas';
  transicionar(intent, a.estado, { actor: quien, evento: accion, datos: { motivo: texto }, ahora });
  intent.decision = { por: quien, en: ahora.toISOString(), accion, motivo: texto };
  sincronizarCompromiso(intent, asientos, publicar);
  return intent;
}
