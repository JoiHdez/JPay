// Cliente simulado de Reap Agentic Payments: el plan B de la demo si cae la red del venue.
//
// Misma interfaz y mismas formas de respuesta que el real; src/reap.js elige uno u otro.
import { randomUUID } from 'node:crypto';

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

export const simulado = {
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
