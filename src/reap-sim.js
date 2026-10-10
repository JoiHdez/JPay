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
const usd = (amount) => ({ amount: Math.round(amount * 100) / 100, currency: 'USD' });

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
