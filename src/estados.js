// Maquina de estados del intent (docs/CONTRATO.md, "Estados"). Toda transicion pasa por
// transicionar(): valida contra la tabla, deja la traza y lanza TRANSICION_INVALIDA si no aplica.
//
// El compromiso de presupuesto sigue al estado: vive solo en CON_COMPROMISO (hay una cotizacion
// que paso el guard, o un pago en curso); en cualquier otro estado se libera.

export const ESTADOS = ['COTIZADA', 'SIN_COTIZACION', 'BLOQUEADA', 'CAMBIOS_SOLICITADOS', 'RECHAZADA', 'EXPIRADA', 'AUTORIZADA', 'EN_PAGO', 'PAGADA', 'FALLIDA'];

// Las del contrato, tal cual.
const CONTRATO = {
  COTIZADA: ['AUTORIZADA', 'RECHAZADA', 'CAMBIOS_SOLICITADOS', 'EXPIRADA'],
  BLOQUEADA: ['COTIZADA', 'RECHAZADA'],
  AUTORIZADA: ['EN_PAGO', 'FALLIDA'],
  EN_PAGO: ['PAGADA', 'FALLIDA'],
  SIN_COTIZACION: ['COTIZADA'],
  EXPIRADA: ['COTIZADA'],
  CAMBIOS_SOLICITADOS: ['COTIZADA'],
  PAGADA: [],
  RECHAZADA: [],
  FALLIDA: [],
};

// Extensiones (no estan en el contrato):
// - Una recotizacion o un documento del proveedor puede salir bloqueado por el guard, o seguir en
//   el mismo estado. El resultado lo decide el guard, no quien recotiza; sin esto el ataque del
//   documento (COTIZADA -> BLOQUEADA) no existiria.
// - Finanzas puede rechazar una compra sin cotizacion o con la cotizacion expirada; si no,
//   quedaria abierta para siempre.
const EXTENSIONES = {
  COTIZADA: ['COTIZADA', 'BLOQUEADA'],
  BLOQUEADA: ['BLOQUEADA'],
  SIN_COTIZACION: ['BLOQUEADA', 'RECHAZADA'],
  EXPIRADA: ['BLOQUEADA', 'RECHAZADA'],
  CAMBIOS_SOLICITADOS: ['BLOQUEADA'],
};

export const TRANSICIONES = Object.fromEntries(ESTADOS.map((e) => [e, [...CONTRATO[e], ...(EXTENSIONES[e] || [])]]));
export const TERMINALES = ESTADOS.filter((e) => !TRANSICIONES[e].length);
/** Estados desde los que se puede (re)cotizar: recotizar y el documento del proveedor. */
export const RECOTIZABLES = ['COTIZADA', 'BLOQUEADA', 'SIN_COTIZACION', 'EXPIRADA', 'CAMBIOS_SOLICITADOS'];
/** Estados que reservan el tope en 8100. */
export const CON_COMPROMISO = ['COTIZADA', 'AUTORIZADA', 'EN_PAGO'];

export const puede = (de, a) => Boolean(TRANSICIONES[de]?.includes(a));

/** Error con status y codigo para { error, codigo } del servidor. */
export function transicionInvalida(de, a) {
  const e = new Error(`La compra esta ${de}; no puede pasar a ${a}.`);
  e.status = 409;
  e.codigoApi = 'TRANSICION_INVALIDA';
  return e;
}

/** Agrega un evento a la traza del intent. */
export function anotar(intent, { actor = 'sistema', evento, datos = {}, ahora = new Date() }) {
  intent.traza ??= [];
  intent.traza.push({ en: ahora.toISOString(), actor, evento, datos });
}

/**
 * Mueve el intent a `a` si la tabla lo permite; si no, lanza TRANSICION_INVALIDA sin tocar nada.
 * Cada transicion queda en la traza con { de, a } y los datos del evento.
 */
export function transicionar(intent, a, { actor, evento, datos = {}, ahora } = {}) {
  const de = intent.estado;
  if (!puede(de, a)) throw transicionInvalida(de, a);
  intent.estado = a;
  anotar(intent, { actor, evento: evento || a, datos: { de, a, ...datos }, ahora });
  return intent;
}

/**
 * Nace un intent SIN_COTIZACION y sin compromiso: el agente cotiza despues. Si el proceso se cae
 * a media cotizacion, la compra queda sin cotizacion y sin dinero reservado.
 */
export function nacer(intent, { actor, datos = {}, ahora } = {}) {
  intent.estado = 'SIN_COTIZACION';
  intent.decision = null;
  intent.traza = [];
  anotar(intent, { actor, evento: 'CREADA', datos: { a: intent.estado, ...datos }, ahora });
  return intent;
}

// Formato anterior (APROBADO -> EN_CHECKOUT -> COMPLETADO | FALLIDO | EXPIRADO) al de la maquina.
const VIEJOS = { COMPLETADO: 'PAGADA', FALLIDO: 'FALLIDA', EXPIRADO: 'FALLIDA' };

/**
 * Estado nuevo para un intent guardado con el formato anterior; null si ya esta migrado.
 * Casos borde: APROBADO sin cotizacion (se cayo el proceso a media cotizacion) queda
 * SIN_COTIZACION; EN_CHECKOUT sin checkoutId (se cayo entre el reclamo y Reap) queda AUTORIZADA,
 * para que autorizar de nuevo reintente con la misma Idempotency-Key en lugar de quedar colgado.
 */
export function estadoMigrado(intent) {
  if (ESTADOS.includes(intent.estado)) return null;
  if (intent.estado === 'APROBADO') return { LISTA: 'COTIZADA', BLOQUEADA: 'BLOQUEADA' }[intent.cotizacion] || 'SIN_COTIZACION';
  if (intent.estado === 'EN_CHECKOUT') return intent.checkoutId ? 'EN_PAGO' : 'AUTORIZADA';
  return VIEJOS[intent.estado] || null;
}

/** Migra en sitio; devuelve true si cambio algo. Un estado desconocido se deja y se reporta. */
export function migrar(intent, ahora = new Date()) {
  const a = estadoMigrado(intent);
  let cambio = false;
  if (a) {
    const de = intent.estado;
    intent.estado = a;
    anotar(intent, { evento: 'MIGRACION', datos: { de, a }, ahora });
    cambio = true;
  }
  if (intent.decision === undefined) { intent.decision = null; cambio = true; }
  if (!intent.traza) { intent.traza = []; cambio = true; }
  return cambio;
}
