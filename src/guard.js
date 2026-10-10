// Ledger Guard: decide si una propuesta del agente puede llegar al checkout de Reap.
// Deterministico. El agente (o el LLM) propone; la contabilidad decide. Cada regla devuelve un
// codigo y un mensaje para el chat y el dashboard.
import { CATEGORIAS } from './catalogo.js';
import { cuadra, centavos, usd } from './ledger.js';
import { RECOTIZABLES } from './estados.js';

const palabras = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{4,}/g) || [];

/**
 * @param intent    { estado, busqueda, categoria, cuenta, maxCantidad, topeUsd, envio, merchant?, moneda }
 * @param propuesta { producto: { nombre, tienda }, cantidad, envioId }
 * @param quote     respuesta de Reap: { shippingOptions, amountBreakdown, expiresAt }
 * @param pre       pre-asiento armado desde ese quote
 * @param disponibleCc  centavos disponibles en el centro de costo despues de reservar el tope del intent
 * @param ahora     Date
 */
export function revisar({ intent, propuesta, quote, pre, disponibleCc, ahora = new Date() }) {
  const v = [];
  const malo = (codigo, mensaje) => v.push({ codigo, mensaje });
  const final = quote.amountBreakdown?.finalAmount;

  // Solo se cotiza lo que todavia no se autoriza ni termina (ver src/estados.js).
  if (!RECOTIZABLES.includes(intent.estado)) malo('INTENT_CONSUMIDO', `El intent esta ${intent.estado}; no admite otro pago.`);
  if (quote.expiresAt && new Date(quote.expiresAt) <= ahora) malo('QUOTE_EXPIRADO', 'La cotizacion de Reap ya expiro.');

  if (intent.merchant && (propuesta.producto.tienda || '').toLowerCase() !== intent.merchant.toLowerCase()) {
    malo('MERCHANT', `La tienda ${propuesta.producto.tienda} no es la del intent (${intent.merchant}).`);
  }
  const pedidas = palabras(intent.busqueda);
  const nombre = palabras(propuesta.producto.nombre);
  if (pedidas.length && !pedidas.some((p) => nombre.some((n) => n.startsWith(p.slice(0, 5))))) {
    malo('PRODUCTO', `"${propuesta.producto.nombre}" no corresponde a lo pedido ("${intent.busqueda}").`);
  }
  if (!Number.isInteger(propuesta.cantidad) || propuesta.cantidad < 1 || propuesta.cantidad > intent.maxCantidad) {
    malo('CANTIDAD', `Cantidad ${propuesta.cantidad}; el intent permite hasta ${intent.maxCantidad}.`);
  }

  const opciones = quote.shippingOptions || [];
  const elegida = opciones.find((o) => o.id === propuesta.envioId) || opciones.find((o) => o.selected);
  const barata = [...opciones].sort((a, b) => Number(a.price.amount) - Number(b.price.amount))[0];
  if (intent.envio === 'economico' && elegida && barata && elegida.id !== barata.id) {
    malo('ENVIO', `Envio "${elegida.name}" no autorizado; la politica es el mas economico ("${barata.name}").`);
  }

  if (!final || final.currency !== intent.moneda) malo('MONEDA', `El quote viene en ${final?.currency}; el intent es en ${intent.moneda}.`);
  const total = centavos(final?.amount ?? 0);
  if (total > centavos(intent.topeUsd)) malo('TOPE', `Total USD ${usd(total)} supera el tope del intent (USD ${intent.topeUsd}).`);
  // El compromiso del intent ya reservo su tope; lo que no puede pasar es exceder tope + disponible.
  if (total > centavos(intent.topeUsd) + disponibleCc) malo('PRESUPUESTO', 'El total excede el presupuesto disponible del centro de costo.');

  if (CATEGORIAS[intent.categoria]?.cuenta !== intent.cuenta) malo('CUENTA', `La cuenta ${intent.cuenta} no es valida para la categoria ${intent.categoria}.`);
  if (!cuadra(pre)) malo('DESCUADRE', 'El pre-asiento no cuadra (suma del debe distinta del haber).');

  return { permitido: v.length === 0, violaciones: v };
}
