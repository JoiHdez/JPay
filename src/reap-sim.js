// Cliente simulado de Reap Agentic Payments: el plan B de la demo si cae la red del venue.
//
// Misma interfaz y mismas formas de respuesta que el real (src/reap.js elige uno u otro). El
// estado vive en data/reap-sim.json para que un reinicio no deje la tarjeta EXPIRED ni pierda
// checkouts a medio aprobar. El checkout pasa por REQUIRES_ACTION y se aprueba en /sim/aprobar,
// una pagina local que hace las veces de la pagina alojada de Reap. Sin tarjeta y sin dinero.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const ENVIOS = [
  { id: 'std', name: 'Standard', centavos: 599 },
  { id: 'exp', name: 'Express', centavos: 1299 },
];
const QUOTE_MS = 15 * 60000;
// Reap da por fallido el checkout si nadie lo aprueba en unos minutos; aqui, 5.
const APROBACION_MS = 5 * 60000;

const usd = (centavos) => ({ amount: centavos / 100, currency: 'USD' });
const centavos = (m) => Math.round(Number(m) * 100);
const copia = (o) => structuredClone(o);

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

// Como Reap: lo mas parecido a la busqueda sale primero, y el servidor cotiza el primero que surta.
const relevancia = (p, q) => {
  const texto = `${p.name} ${p.tags.join(' ')}`.toLowerCase();
  return q.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && texto.includes(w)).length;
};

// Mismo formato de error que el cliente real, para que server.js lo trate igual.
function fallaReap(status, ruta, code, message) {
  const e = new Error(`Reap ${status} en ${ruta}: ${code} ${message}`);
  e.status = status;
  e.codigo = code;
  return e;
}

/** @param archivo ruta del JSON de estado; ahora() en ms, inyectable para probar vencimientos. */
export function crearSimulado({ archivo, ahora = () => Date.now() }) {
  let m;
  const leer = () => {
    if (m) return m;
    let previo = {};
    try {
      previo = JSON.parse(readFileSync(archivo, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`reap-sim: no se pudo leer ${archivo} (${e.message}); empieza vacio.`);
    }
    m = { enrollments: {}, quotes: {}, checkouts: {}, claves: {}, ...previo };
    return m;
  };

  // Escrituras en fila y a un temporal que luego se renombra: si el proceso muere a media
  // escritura, el JSON anterior queda entero.
  let cola = Promise.resolve();
  const guardar = () => {
    const escritura = cola.catch(() => {}).then(async () => {
      await mkdir(dirname(archivo), { recursive: true });
      await writeFile(`${archivo}.tmp`, JSON.stringify(leer(), null, 2));
      await rename(`${archivo}.tmp`, archivo);
    });
    cola = escritura;
    return escritura;
  };

  async function vencer(c) {
    if (c.status !== 'REQUIRES_ACTION' || new Date(c.expiresAt).getTime() > ahora()) return;
    Object.assign(c, { status: 'FAILED', failureReason: 'APPROVAL_TIMEOUT' });
    delete c.nextAction;
    await guardar();
  }

  return {
    async crearEnrollment({ clienteId, email, returnUrl }) {
      const id = `enr_sim_${clienteId}`;
      leer().enrollments[id] = { id, status: 'ACTIVE', owner: { type: 'CLIENT_REFERENCE', id: clienteId, email } };
      await guardar();
      return { ...copia(m.enrollments[id]), status: 'REQUIRES_ACTION', nextAction: { type: 'REDIRECT', url: returnUrl } };
    },

    enrollment: async (id) => copia(leer().enrollments[id] || { id, status: 'EXPIRED' }),

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

    async cotizar({ variantId, cantidad, clave }) {
      const datos = leer();
      if (clave && datos.claves[clave]) return copia(datos.quotes[datos.claves[clave]]);
      const p = CATALOGO.find((x) => `var_${x.id}` === variantId);
      if (!p) throw fallaReap(404, '/agentic/quotes', 'NOT_FOUND', `Variant ${variantId} not found`);
      const q = {
        id: `quo_sim_${randomUUID().slice(0, 8)}`,
        items: [{ variantId, quantity: cantidad, name: p.name, merchant: { name: p.merchant } }],
        shippingOptions: ENVIOS.map((o, i) => ({ id: o.id, name: o.name, selected: i === 0, price: usd(o.centavos) })),
        amountBreakdown: desglose(centavos(p.price) * cantidad, ENVIOS[0].centavos),
        expiresAt: new Date(ahora() + QUOTE_MS).toISOString(),
      };
      datos.quotes[q.id] = q;
      if (clave) datos.claves[clave] = q.id;
      await guardar();
      return copia(q);
    },

    // Como en Reap, cambiar el envio recalcula amountBreakdown y marca la opcion elegida.
    async elegirEnvio(quoteId, shippingOptionId) {
      const ruta = `/agentic/quotes/${quoteId}/shipping-option`;
      const q = leer().quotes[quoteId];
      if (!q) throw fallaReap(404, ruta, 'NOT_FOUND', `Quote ${quoteId} not found`);
      const opcion = q.shippingOptions.find((o) => o.id === shippingOptionId);
      if (!opcion) throw fallaReap(400, ruta, 'AGENTIC_REQUEST_REJECTED', `Unknown shippingOptionId ${shippingOptionId}`);
      for (const o of q.shippingOptions) o.selected = o.id === shippingOptionId;
      q.amountBreakdown = desglose(centavos(q.amountBreakdown.itemsSubtotal.amount), centavos(opcion.price.amount));
      await guardar();
      return copia(q);
    },

    async checkout({ quoteId, enrollmentId, returnUrl, clave }) {
      const datos = leer();
      if (clave && datos.claves[clave]) return copia(datos.checkouts[datos.claves[clave]]);
      const q = datos.quotes[quoteId];
      if (!q) throw fallaReap(409, '/agentic/checkouts', 'QUOTE_EXPIRED', 'La cotización simulada se perdió al reiniciar el servidor; recotiza.');
      if (new Date(q.expiresAt).getTime() <= ahora()) throw fallaReap(409, '/agentic/checkouts', 'QUOTE_EXPIRED', `Quote ${quoteId} expired`);
      const id = `chk_sim_${randomUUID().slice(0, 8)}`;
      datos.checkouts[id] = {
        id,
        status: 'REQUIRES_ACTION',
        quoteId,
        enrollmentId,
        finalAmount: q.amountBreakdown.finalAmount,
        presentation: { type: 'REDIRECT', returnUrl },
        // La "pagina alojada" es local, en el mismo origen que el returnUrl (este servidor).
        nextAction: { type: 'REDIRECT', url: `${new URL(returnUrl).origin}/sim/aprobar?checkout=${id}` },
        expiresAt: new Date(ahora() + APROBACION_MS).toISOString(),
      };
      if (clave) datos.claves[clave] = id;
      await guardar();
      return copia(datos.checkouts[id]);
    },

    // Un checkout que el simulador no conoce (de antes de persistir, o si se borro el JSON) se da
    // por expirado, como el enrollment: asi el intent libera su compromiso en vez de atorarse.
    async consultarCheckout(id) {
      const c = leer().checkouts[id];
      if (!c) return { id, status: 'EXPIRED' };
      await vencer(c);
      return copia(c);
    },

    // Solo del simulador: lo que veria y haria el usuario en la pagina alojada de Reap.
    async detalle(id) {
      const c = leer().checkouts[id];
      if (!c) return null;
      await vencer(c);
      return { checkout: copia(c), quote: copia(m.quotes[c.quoteId] || null), restanteMs: new Date(c.expiresAt).getTime() - ahora() };
    },

    async decidir(id, aprobar) {
      const c = leer().checkouts[id];
      if (!c) return null;
      await vencer(c);
      if (c.status !== 'REQUIRES_ACTION') return copia(c); // ya decidido: un doble clic no cambia nada
      delete c.nextAction;
      if (aprobar) Object.assign(c, { status: 'COMPLETED', orderId: `SIM-${String(ahora()).slice(-6)}`, completedAt: new Date(ahora()).toISOString() });
      else Object.assign(c, { status: 'FAILED', failureReason: 'DECLINED' });
      await guardar();
      return copia(c);
    },
  };
}

export const simulado = crearSimulado({ archivo: fileURLToPath(new URL('../data/reap-sim.json', import.meta.url)) });

// ── Pagina de aprobacion (/sim/aprobar) ───────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dinero = (m) => (m ? `${esc(m.currency)} ${Number(m.amount).toFixed(2)}` : '');

// La presentacion vive en public/; aqui solo se sirve con el detalle del checkout.
const plantilla = readFileSync(new URL('../public/sim-aprobar.html', import.meta.url), 'utf8');
function pagina(cuerpo) {
  return plantilla.replace('<!-- contenido -->', () => cuerpo);
}

function verDetalle({ checkout: c, quote: q, restanteMs }) {
  const item = q?.items?.[0];
  const b = q?.amountBreakdown;
  const envio = q?.shippingOptions?.find((o) => o.selected);
  const filas = [
    item && ['Comercio', esc(item.merchant?.name)],
    item && ['Producto', `${esc(item.name)} &times; ${esc(item.quantity)}`],
    b && ['Subtotal', dinero(b.itemsSubtotal)],
    b && [`Env&iacute;o${envio ? ` (${esc(envio.name)})` : ''}`, dinero(b.shipping)],
    b && ['Impuesto', dinero(b.tax?.amount)],
  ].filter(Boolean).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  const encabezado = `<h1>Aprobar pago</h1>
<p class="muted">Checkout ${esc(c.id)}</p>
<div class="total">${dinero(c.finalAmount)}</div>
<table>${filas}</table>`;

  if (c.status === 'REQUIRES_ACTION') {
    const minutos = Math.max(1, Math.ceil(restanteMs / 60000));
    return pagina(`${encabezado}
<p class="muted">Aqu&iacute; Reap pedir&iacute;a la tarjeta registrada. Este simulador no cobra nada: solo decide el estado del checkout. Expira en ${minutos} min si nadie decide.</p>
<form method="post" action="/sim/aprobar" class="botones">
  <input type="hidden" name="checkout" value="${esc(c.id)}">
  <button class="rechazar" name="accion" value="rechazar">Rechazar</button>
  <button class="aprobar" name="accion" value="aprobar">Aprobar</button>
</form>`);
  }
  const resultado = {
    COMPLETED: `Pago aprobado. Orden ${esc(c.orderId)}.`,
    FAILED: c.failureReason === 'APPROVAL_TIMEOUT' ? 'Nadie aprob&oacute; a tiempo: el checkout fall&oacute;.' : 'Pago rechazado.',
  }[c.status] || `Estado: ${esc(c.status)}.`;
  return pagina(`${encabezado}
<p><strong>${resultado}</strong></p>
<div class="botones"><a class="boton aprobar" href="${esc(c.presentation?.returnUrl)}">Volver a J-Pay</a></div>`);
}

async function leerFormulario(req) {
  let texto = '';
  for await (const parte of req) {
    texto += parte;
    if (texto.length > 2000) return null;
  }
  return new URLSearchParams(texto);
}

const html = (res, status, cuerpo) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(cuerpo);
};
const noExiste = (res) => html(res, 404, pagina('<h1>Checkout no encontrado</h1><p>Ese checkout no existe en el simulador.</p>'));

/** GET muestra el checkout; POST aprueba o rechaza y vuelve al returnUrl, como la pagina de Reap. */
export async function atenderAprobacion(req, res, url, sim = simulado) {
  if (req.method === 'GET') {
    const d = await sim.detalle(url.searchParams.get('checkout'));
    return d ? html(res, 200, verDetalle(d)) : noExiste(res);
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'GET, POST' });
    return res.end();
  }
  const form = await leerFormulario(req);
  if (!form) return html(res, 413, pagina('<h1>Formulario demasiado grande</h1>'));
  const accion = form.get('accion');
  if (accion !== 'aprobar' && accion !== 'rechazar') return html(res, 400, pagina('<h1>Accion invalida</h1><p>Usa Aprobar o Rechazar.</p>'));
  const c = await sim.decidir(form.get('checkout'), accion === 'aprobar');
  if (!c) return noExiste(res);
  // El returnUrl sale del checkout guardado, nunca del formulario: no hay redireccion abierta.
  res.writeHead(303, { Location: c.presentation.returnUrl });
  return res.end();
}
