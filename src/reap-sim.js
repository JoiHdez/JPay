// Cliente simulado de Reap Agentic Payments: el plan B de la demo si cae la red del venue.
//
// Misma interfaz y mismas formas de respuesta que el real; src/reap.js elige uno u otro.
import { randomUUID } from 'node:crypto';

// ponytail: catalogo fijo con productos de la lista oficial de comercios; basta para ensayar sin red.
// Del 6 en adelante cubren los presets de la UI dentro de su tope, aun con la cantidad maxima.
export const CATALOGO = [
  { id: 'prd_sim_1', merchant: 'Package Free', name: 'Multi-Purpose Cleaning Spray (4 Pack)', price: 28.99, tags: ['cleaning', 'cleaner', 'spray', 'limpiador'] },
  { id: 'prd_sim_2', merchant: 'CoffeeAM', name: 'Costa Rica Reserve Coffee', price: 19.95, tags: ['coffee', 'cafe'] },
  { id: 'prd_sim_3', merchant: 'Keychron', name: 'Keychron K8 Wireless Mechanical Keyboard', price: 69.99, tags: ['keyboard', 'keychron', 'teclado'] },
  { id: 'prd_sim_4', merchant: 'Plugable Technologies', name: 'Plugable USB-C Triple Monitor Docking Station', price: 149.99, tags: ['docking', 'dock', 'plugable'] },
  { id: 'prd_sim_5', merchant: 'Baronfig', name: 'Thinker Tote Bundle', price: 95, tags: ['tote', 'baronfig', 'bolsa'] },
  { id: 'prd_sim_6', merchant: 'Package Free', name: 'Laundry Detergent Powder - Unscented (64 Loads)', price: 16.95, tags: ['laundry', 'detergent', 'jabon', 'ropa'] },
  { id: 'prd_sim_7', merchant: 'Public Goods', name: 'Bamboo Paper Towels (6 Rolls)', price: 24.95, tags: ['paper', 'towel', 'toallas', 'papel'] },
  { id: 'prd_sim_8', merchant: 'Public Goods', name: 'Organic Cotton Tote Bag', price: 18, tags: ['tote', 'bolsa', 'tela'] },
  { id: 'prd_sim_9', merchant: 'ZM Desktop', name: 'Modular Space-Saving Laptop Stand - Black Walnut', price: 58, tags: ['laptop', 'stand', 'soporte'] },
];
const memoria = new Map();

const ENVIOS = [
  { id: 'std', name: 'Standard', centavos: 599 },
  { id: 'exp', name: 'Express', centavos: 1299 },
];

const usd = (centavos) => ({ amount: centavos / 100, currency: 'USD' });
const centavos = (m) => Math.round(Number(m) * 100);

// En centavos para que subtotal + envio + impuesto sumen exacto finalAmount; si no, el pre-asiento descuadra.
function desglose(subtotal, envio) {
  const tax = Math.round(subtotal * 0.08);
  return {
    itemsSubtotal: usd(subtotal),
    shipping: usd(envio),
    tax: { amount: usd(tax), includedInPrices: false },
    finalAmount: usd(subtotal + envio + tax),
  };
}

// Mismo formato de error que el cliente real, para que server.js lo trate igual.
function fallaReap(status, ruta, code, message) {
  const e = new Error(`Reap ${status} en ${ruta}: ${code} ${message}`);
  e.status = status;
  e.codigo = code;
  return e;
}

// Como Reap: lo mas parecido a la busqueda sale primero, y el servidor cotiza el primero que surta.
const relevancia = (p, q) => {
  const texto = `${p.name} ${p.tags.join(' ')}`.toLowerCase();
  return q.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && texto.includes(w)).length;
};

export const simulado = {
  async crearEnrollment({ clienteId, email, returnUrl }) {
    const id = `enr_sim_${clienteId}`;
    memoria.set(id, { id, status: 'ACTIVE', owner: { type: 'CLIENT_REFERENCE', id: clienteId, email } });
    return { ...memoria.get(id), status: 'REQUIRES_ACTION', nextAction: { type: 'REDIRECT', url: returnUrl } };
  },
  enrollment: async (id) => memoria.get(id) || { id, status: 'EXPIRED' },
  async buscar({ query, max }) {
    const q = query.toLowerCase();
    const hits = CATALOGO
      .filter((p) => p.tags.some((t) => q.includes(t)) || q.includes(p.name.toLowerCase()))
      .filter((p) => !max || p.price <= Number(max))
      .map((p) => ({ p, r: relevancia(p, q) }))
      .sort((a, b) => b.r - a.r)
      .slice(0, 5)
      .map(({ p }) => p);
    return {
      id: randomUUID(),
      products: hits.map((p) => ({
        id: p.id,
        merchant: { name: p.merchant },
        name: p.name,
        available: true,
        previewVariant: { id: `var_${p.id}`, name: p.name, price: usd(centavos(p.price)), available: true },
      })),
    };
  },
  async cotizar({ variantId, cantidad }) {
    const p = CATALOGO.find((x) => `var_${x.id}` === variantId);
    if (!p) throw fallaReap(404, '/agentic/quotes', 'NOT_FOUND', `Variant ${variantId} not found`);
    const q = {
      id: `quo_sim_${randomUUID().slice(0, 8)}`,
      items: [{ variantId, quantity: cantidad, name: p.name, merchant: { name: p.merchant } }],
      shippingOptions: ENVIOS.map((o, i) => ({ id: o.id, name: o.name, selected: i === 0, price: usd(o.centavos) })),
      amountBreakdown: desglose(centavos(p.price) * cantidad, ENVIOS[0].centavos),
      expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
    };
    memoria.set(q.id, q);
    return structuredClone(q);
  },
  // Como en Reap, cambiar el envio recalcula amountBreakdown y marca la opcion elegida.
  async elegirEnvio(quoteId, shippingOptionId) {
    const ruta = `/agentic/quotes/${quoteId}/shipping-option`;
    const q = memoria.get(quoteId);
    if (!q) throw fallaReap(404, ruta, 'NOT_FOUND', `Quote ${quoteId} not found`);
    const opcion = q.shippingOptions.find((o) => o.id === shippingOptionId);
    if (!opcion) throw fallaReap(400, ruta, 'AGENTIC_REQUEST_REJECTED', `Unknown shippingOptionId ${shippingOptionId}`);
    for (const o of q.shippingOptions) o.selected = o.id === shippingOptionId;
    q.amountBreakdown = desglose(centavos(q.amountBreakdown.itemsSubtotal.amount), centavos(opcion.price.amount));
    return structuredClone(q);
  },
  async checkout({ quoteId, enrollmentId, returnUrl }) {
    const q = memoria.get(quoteId);
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
