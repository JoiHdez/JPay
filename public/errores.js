// Por que no se puede pagar, en palabras de finanzas. Funciones puras (sin DOM) para probarlas
// con node:test; las usa finanzas.html.

// Lo que se pidio a Reap, segun la ruta que viene en el mensaje del servidor.
const QUE = [
  ['/agentic/quotes', 'la cotización'],
  ['/agentic/checkouts', 'el pago'],
  ['/agentic/enrollments', 'el registro de la tarjeta'],
  ['/agentic/products', 'la búsqueda'],
];

/**
 * Traduce un mensaje de error (del servidor o de Reap) a lenguaje claro.
 * Formato de Reap que arma src/reap.js: `Reap 400 en /agentic/quotes: CODIGO mensaje {detalle json}`.
 * @returns {{ claro: string, tecnico: string|null } | null} tecnico es el texto original cuando difiere.
 */
export function explicarError(texto) {
  const t = String(texto ?? '').trim();
  if (!t) return null;
  const con = (claro) => ({ claro, tecnico: claro === t ? null : t });

  if (/sin conexi[oó]n con reap/i.test(t)) return con('Sin conexión con Reap. Revisa la red y vuelve a intentar.');
  if (/failed to fetch|load failed|networkerror/i.test(t)) return con('Sin conexión con el servidor de J-Pay. ¿Sigue corriendo?');
  if (/QUOTE_UNFULFILLABLE|ninguna tienda pudo surtir/i.test(t)) {
    return con('Ninguna tienda pudo surtir el pedido (dirección de envío, teléfono o existencias). Recotiza o cambia la búsqueda.');
  }
  if (/ledger guard bloqueo el pago/i.test(t)) return con(t.replace(/Ledger Guard bloqueo el pago/i, 'Ledger Guard bloqueó el pago'));
  if (/cotizacion de reap expiro/i.test(t)) return con('La cotización de Reap expiró. Recotiza para obtener una nueva.');
  if (/no hay ".*" en las tiendas compatibles/i.test(t)) return con(`${t} Cambia la búsqueda.`);
  if (/primero registra la tarjeta/i.test(t)) return con('Primero registra la tarjeta corporativa en Reap.');
  if (/tarjeta en reap no esta active/i.test(t)) return con('La tarjeta en Reap no está activa (ACTIVE). Termina su registro.');

  const reap = t.match(/^Reap (\d{3}) en (\S+?):/);
  if (!reap) return con(t);
  const status = Number(reap[1]);
  const que = QUE.find(([ruta]) => reap[2].startsWith(ruta))?.[1] || 'la petición';

  if (/QUOTE_EXPIRED|EXPIRED/.test(t)) return con(`Reap rechazó ${que}: la cotización ya expiró. Recotiza.`);
  if (status === 401 || status === 403) return con('Reap rechazó la llave de API. Revisa REAP_API_KEY en .env.');
  if (status === 429) return con('Reap está limitando las peticiones. Espera un momento y vuelve a intentar.');
  if (status >= 500) return con(`Reap tuvo una falla interna con ${que}. Vuelve a intentar en un momento.`);
  if (status === 404) return con(`Reap no encontró lo que se pidió para ${que}.`);
  if (/shippingAddress/i.test(t)) return con(`Reap rechazó ${que}: falta la dirección de envío o está incompleta (REAP_ENVIO en .env).`);
  if (/\bphone\b/i.test(t)) return con(`Reap rechazó ${que}: el teléfono de envío no es válido (formato E.164, p. ej. +12127363100).`);
  const campo = t.match(/"field"\s*:\s*"([^"]+)"/)?.[1];
  if (campo) return con(`Reap rechazó ${que}: el campo ${campo} no es válido.`);
  return con(`Reap rechazó ${que} (error ${status}).`);
}

/** Milisegundos que le quedan a la cotizacion; null si no hay fecha de expiracion. */
export function restante(expira, ahora = Date.now()) {
  if (!expira) return null;
  const fin = new Date(expira).getTime();
  return Number.isNaN(fin) ? null : fin - ahora;
}

/** Cuenta regresiva mm:ss, o "Cotización expirada" cuando llega a 0. */
export function cuentaRegresiva(ms) {
  if (ms == null) return '';
  if (ms <= 0) return 'Cotización expirada';
  const s = Math.ceil(ms / 1000);
  return `Vence en ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Motivos por los que finanzas no puede autorizar el pago; vacio si se puede.
 * Usa los campos de GET /api/estado: el intent y la raiz `tarjeta`.
 */
export function motivosBloqueo(intent, tarjeta, ahora = Date.now()) {
  const m = [];
  if (intent.estado !== 'APROBADO') return [`La compra está ${intent.estado}.`];
  const ms = restante(intent.expira, ahora);
  if (intent.cotizacion === 'ERROR' || !intent.quoteId) m.push('Sin cotización de Reap. Recotiza para obtener una.');
  else if (ms != null && ms <= 0) m.push('La cotización expiró. Recotiza para obtener una nueva.');
  if (intent.cotizacion === 'BLOQUEADA') {
    const viol = (intent.guard?.violaciones || []).filter((v) => !(ms != null && ms <= 0 && v.codigo === 'QUOTE_EXPIRADO'));
    if (viol.length) for (const v of viol) m.push(`Ledger Guard: ${v.mensaje}`);
    else if (!(ms != null && ms <= 0)) m.push('Ledger Guard bloquea el pago.');
  }
  if (tarjeta === 'SIN_CONEXION') m.push('No se pudo revisar la tarjeta: sin conexión con Reap.');
  else if (!tarjeta) m.push('Tarjeta corporativa sin registrar en Reap.');
  else if (tarjeta !== 'ACTIVE') m.push(`La tarjeta en Reap está ${tarjeta}; debe estar ACTIVE.`);
  return m;
}
