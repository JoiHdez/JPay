// JPay: servidor HTTP sin dependencias.
//
// Flujo: sugerencias (historial de Ochavo) -> cotizar con Reap -> guarda de presupuesto ->
// la persona aprueba -> checkout de Reap (pagina alojada) -> retorno -> gasto en Ochavo.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { reapApi, modo as modoReap } from './reap.js';
import * as ochavo from './ochavo.js';
import { presupuestoDe, evaluar } from './presupuesto.js';
import { sugerencias } from './sugerencias.js';

const PORT = Number(process.env.PORT || 3010);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const PAIS = process.env.REAP_PAIS || 'US';
const MONEDA = process.env.REAP_MONEDA || 'USD';
const EMAIL = process.env.REAP_EMAIL || 'demo@ochavo.com.mx';
const ENVIO = process.env.REAP_ENVIO ? JSON.parse(process.env.REAP_ENVIO) : undefined;
const RAIZ = new URL('..', import.meta.url);
const ARCHIVO = new URL('data/estado.json', RAIZ);

// ponytail: estado en un JSON local (una persona, un demo); a BD si esto pasa a Ochavo.
let estado = { enrollmentId: null, pedidos: {} };
try { estado = JSON.parse(await readFile(ARCHIVO, 'utf8')); } catch { /* primera vez */ }
const guardar = async () => {
  await mkdir(new URL('data/', RAIZ), { recursive: true });
  await writeFile(ARCHIVO, JSON.stringify(estado, null, 2));
};

const montoUsd = (m) => Number(m?.amount ?? m);

async function revisarPresupuesto(totalUsd) {
  const [tc, lista] = await Promise.all([ochavo.tipoDeCambio(), ochavo.presupuestos()]);
  const totalMxn = Math.round(totalUsd * tc * 100) / 100;
  return { tc, totalMxn, ...evaluar({ totalMxn, presupuesto: presupuestoDe(lista, ochavo.CATEGORIA) }) };
}

const rutas = {
  'GET /api/estado': async () => {
    for (const p of Object.values(estado.pedidos)) await conciliar(p).catch((e) => console.error(e.message));
    const [lista, historial] = await Promise.all([ochavo.presupuestos(), ochavo.gastos(3)]);
    let tarjeta = null;
    if (estado.enrollmentId) tarjeta = (await reapApi.enrollment(estado.enrollmentId)).status;
    return {
      modo: { reap: modoReap, ochavo: ochavo.modo },
      categoria: ochavo.CATEGORIA,
      presupuesto: presupuestoDe(lista, ochavo.CATEGORIA),
      tarjeta,
      sugerencias: sugerencias(historial),
      pedidos: Object.values(estado.pedidos).sort((a, b) => b.creado.localeCompare(a.creado)).slice(0, 10),
    };
  },

  // Guarda la tarjeta en la pagina alojada de Reap; aqui solo vuelve el enrollmentId.
  'POST /api/tarjeta': async () => {
    const e = await reapApi.crearEnrollment({ clienteId: 'ochavo-demo', email: EMAIL, returnUrl: `${PUBLIC_URL}/` });
    estado.enrollmentId = e.id;
    await guardar();
    return { url: e.nextAction?.url || null, status: e.status };
  },

  'POST /api/cotizar': async (body) => {
    const articulo = String(body.articulo || '').trim();
    const cantidad = Number(body.cantidad || 1);
    if (articulo.length < 2 || articulo.length > 80) throw falla(400, 'Escribe que hace falta (2 a 80 letras).');
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 10) throw falla(400, 'La cantidad va de 1 a 10.');

    const busqueda = await reapApi.buscar({ query: articulo, pais: PAIS, moneda: MONEDA });
    const candidatos = (busqueda.products || []).filter((p) => p.available && p.previewVariant?.available).slice(0, 3);
    if (!candidatos.length) throw falla(404, `No encontre "${articulo}" en las tiendas compatibles. Prueba con otro nombre.`);

    const id = randomUUID();
    // Si una tienda no puede surtir (direccion, telefono, envio), se prueba la siguiente.
    let producto, quote, ultimoError;
    for (const [i, p] of candidatos.entries()) {
      try {
        quote = await reapApi.cotizar({ variantId: p.previewVariant.id, cantidad, email: EMAIL, envio: ENVIO, clave: `quo-${id}-${i}` });
        producto = p;
        break;
      } catch (e) {
        if (e.codigo !== 'QUOTE_UNFULFILLABLE') throw e;
        ultimoError = e;
      }
    }
    if (!quote) throw falla(422, `Ninguna tienda pudo surtir "${articulo}": ${ultimoError.message}`);
    // El envio mas barato: el agente cuida el presupuesto, no la prisa.
    const barato = [...(quote.shippingOptions || [])].sort((a, b) => montoUsd(a.price) - montoUsd(b.price))[0];
    if (barato && !barato.selected) quote = await reapApi.elegirEnvio(quote.id, barato.id);

    const totalUsd = montoUsd(quote.amountBreakdown.finalAmount);
    const guarda = await revisarPresupuesto(totalUsd);
    const pedido = {
      id, articulo, cantidad, creado: new Date().toISOString(),
      producto: { nombre: producto.name, tienda: producto.merchant?.name, imagen: producto.imageUrl || null },
      quoteId: quote.id, expira: quote.expiresAt, totalUsd, envio: barato?.name || null,
      totalMxn: guarda.totalMxn, tc: guarda.tc, guarda: { permitido: guarda.permitido, motivo: guarda.motivo, restante: guarda.restante, despues: guarda.despues, faltante: guarda.faltante },
      status: guarda.permitido ? 'COTIZADO' : 'BLOQUEADO',
    };
    estado.pedidos[id] = pedido;
    await guardar();
    return pedido;
  },

  // La aprobacion de la persona dispara el checkout. La guarda se vuelve a correr aqui: lo que
  // dijo la cotizacion no vale si entre tanto se gasto en otra cosa.
  'POST /api/aprobar': async (body) => {
    const pedido = estado.pedidos[body.id];
    if (!pedido) throw falla(404, 'Ese pedido no existe.');
    if (pedido.status !== 'COTIZADO') throw falla(409, `El pedido esta ${pedido.status}.`);
    if (!estado.enrollmentId) throw falla(409, 'Primero guarda una tarjeta en Reap.');
    // Reap no abre un checkout contra una tarjeta que no este ACTIVE.
    if ((await reapApi.enrollment(estado.enrollmentId)).status !== 'ACTIVE') throw falla(409, 'La tarjeta en Reap no esta activa; guardala de nuevo.');
    if (pedido.expira && new Date(pedido.expira) < new Date()) {
      pedido.status = 'EXPIRADO';
      await guardar();
      throw falla(409, 'La cotizacion vencio; cotiza de nuevo.');
    }
    const guarda = await revisarPresupuesto(pedido.totalUsd);
    if (!guarda.permitido) throw falla(409, 'Ya no cabe en el presupuesto.');

    pedido.status = 'EN_CHECKOUT'; // reclamo antes de llamar a Reap: un doble clic no cobra dos veces
    await guardar();
    try {
      const c = await reapApi.checkout({
        quoteId: pedido.quoteId,
        enrollmentId: estado.enrollmentId,
        returnUrl: `${PUBLIC_URL}/retorno?pedido=${pedido.id}`,
        clave: `chk-${pedido.id}`,
      });
      pedido.checkoutId = c.id;
      await guardar();
      if (c.nextAction?.url) return { url: c.nextAction.url };
      return { url: `${PUBLIC_URL}/retorno?pedido=${pedido.id}` };
    } catch (e) {
      pedido.status = 'COTIZADO';
      await guardar();
      throw e;
    }
  },
};

// Lee el checkout y concilia. Volver de Reap no prueba nada: solo COMPLETED crea el gasto, una
// vez. REQUIRES_ACTION y PROCESSING siguen en curso; FAILED y EXPIRED son finales (doc de Reap:
// Lifecycle and Statuses) y piden cotizar de nuevo.
async function conciliar(pedido) {
  if (pedido.status !== 'EN_CHECKOUT' || !pedido.checkoutId) return;
  const c = await reapApi.consultarCheckout(pedido.checkoutId);
  if (c.status === 'FAILED' || c.status === 'EXPIRED') {
    pedido.status = c.status === 'FAILED' ? 'FALLIDO' : 'EXPIRADO';
    await guardar();
    return;
  }
  if (c.status !== 'COMPLETED') return;

  pedido.status = 'REGISTRANDO'; // reclamo: dos lecturas a la vez no registran dos gastos
  const finalUsd = montoUsd(c.finalAmount ?? pedido.totalUsd);
  pedido.orderId = c.orderId;
  pedido.totalUsd = finalUsd;
  pedido.totalMxn = Math.round(finalUsd * pedido.tc * 100) / 100;
  try {
    const gasto = await ochavo.registrarGasto({
      monto: pedido.totalMxn,
      descripcion: `${pedido.producto.nombre} (${pedido.producto.tienda || 'Reap'})`,
      categoria: ochavo.CATEGORIA,
      notas: `Compra de JPay con Reap. Orden ${c.orderId}, USD ${finalUsd}, TC ${pedido.tc}.`,
    });
    pedido.gastoId = gasto.id;
    pedido.status = 'COMPLETADO';
  } catch (e) {
    pedido.status = 'PAGADO_SIN_REGISTRO'; // cobrado pero no conciliado: se ve en la lista
    pedido.error = e.message;
  }
  await guardar();
}

async function retorno(url) {
  const pedido = estado.pedidos[url.searchParams.get('pedido')];
  if (!pedido) return '/';
  // PROCESSING suele durar poco: se espera unos segundos antes de volver a la pantalla.
  for (let i = 0; i < 5 && pedido.status === 'EN_CHECKOUT'; i++) {
    await conciliar(pedido);
    if (pedido.status === 'EN_CHECKOUT') await new Promise((s) => setTimeout(s, 2000));
  }
  return `/?pedido=${pedido.id}`;
}

function falla(status, mensaje) {
  const e = new Error(mensaje);
  e.status = status;
  return e;
}

async function leerCuerpo(req) {
  let texto = '';
  for await (const parte of req) {
    texto += parte;
    if (texto.length > 10000) throw falla(413, 'Cuerpo demasiado grande.');
  }
  try { return texto ? JSON.parse(texto) : {}; } catch { throw falla(400, 'JSON invalido.'); }
}

const responder = (res, status, datos) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(datos));
};

createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('public/index.html', RAIZ)));
    }
    if (req.method === 'GET' && url.pathname === '/retorno') {
      res.writeHead(303, { Location: await retorno(url) });
      return res.end();
    }
    const ruta = rutas[`${req.method} ${url.pathname}`];
    if (!ruta) return responder(res, 404, { error: 'No existe' });
    return responder(res, 200, await ruta(req.method === 'POST' ? await leerCuerpo(req) : {}));
  } catch (e) {
    if (!e.status || e.status >= 500) console.error(e.message);
    return responder(res, e.status && e.status < 500 ? e.status : 502, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`JPay en ${PUBLIC_URL} (Reap ${modoReap}, Ochavo ${ochavo.modo})`);
});
