// J-Pay: pagos agenticos que se contabilizan solos. Servidor HTTP sin dependencias.
//
// Ciclo de un pago: intent (compromiso) -> quote de Reap (pre-asiento + Ledger Guard) ->
// aprobacion de finanzas -> checkout de Reap -> COMPLETED (devengado, ajuste, liberacion) ->
// factura (match) -> cierre de mes (liquidacion, balanza, P&L).
//
// Reglas: los montos salen siempre de Reap; el ledger solo lo escribe este codigo, y validar()
// rechaza cualquier asiento descuadrado antes de publicarlo.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { reapApi, modo as modoReap } from './reap.js';
import { CATEGORIAS, CENTROS, CUENTAS } from './catalogo.js';
import * as L from './ledger.js';
import { revisar } from './guard.js';
import { leerInstrucciones, proponer } from './agente.js';
import { restriccion } from './politica.js';
import { interpretar } from './pedidoNatural.js';

// REAP_ENVIO es la shippingAddress de cada quote. Si falta o no es un objeto, Reap responde
// 400 AGENTIC_REQUEST_REJECTED {field: shippingAddress} hasta el primer pedido; mejor no arrancar.
function leerEnvio(texto) {
  const salir = (mensaje) => { console.error(`REAP_ENVIO: ${mensaje}`); process.exit(1); };
  if (!texto?.trim()) {
    if (modoReap === 'real') salir('falta en .env y Reap no cotiza sin direccion de envio. Copia la linea de .env.example.');
    return undefined;
  }
  let envio;
  try {
    envio = JSON.parse(texto);
  } catch (e) {
    salir(`no es JSON valido (${e.message}). Va en una sola linea y sin comillas alrededor, como en .env.example.`);
  }
  if (!envio || typeof envio !== 'object' || Array.isArray(envio)) {
    const tipo = envio === null ? 'null' : Array.isArray(envio) ? 'arreglo' : typeof envio;
    salir(`debe ser un objeto JSON y llego como ${tipo}.${tipo === 'string' ? ' Quita las comillas de afuera.' : ''} Copia el formato de .env.example.`);
  }
  // Los que Reap exige en shippingAddress (docs de POST /agentic/quotes).
  const faltan = ['firstName', 'lastName', 'phone', 'addressLine1', 'city', 'country'].filter((c) => !String(envio[c] ?? '').trim());
  if (faltan.length) salir(`le falta ${faltan.join(', ')}; Reap exige esos campos en shippingAddress.`);
  if (!/^\+[1-9]\d{6,14}$/.test(envio.phone)) salir('phone va en formato E.164, sin espacios ni guiones (por ejemplo +12127363100).');
  return envio;
}

const PORT = Number(process.env.PORT || 3010);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const PAIS = process.env.REAP_PAIS || 'US';
const MONEDA = process.env.REAP_MONEDA || 'USD';
const EMAIL = process.env.REAP_EMAIL || 'compras@jpay.demo';
const ENVIO = leerEnvio(process.env.REAP_ENVIO);
const RAIZ = new URL('..', import.meta.url);
const ARCHIVO = new URL('data/jpay.json', RAIZ);

// ponytail: estado en un JSON local; Postgres con trigger de cuadre cuando haya mas de un proceso.
let db = { enrollmentId: process.env.REAP_ENROLLMENT_ID || null, intents: {}, asientos: [], guard: [], facturas: [] };
try { db = { ...db, ...JSON.parse(await readFile(ARCHIVO, 'utf8')) }; } catch { /* primera vez */ }
const guardar = async () => {
  await mkdir(new URL('data/', RAIZ), { recursive: true });
  await writeFile(ARCHIVO, JSON.stringify(db, null, 2));
};

function publicar(asiento, intent, concepto) {
  L.validar(asiento);
  const a = { id: `A-${String(db.asientos.length + 1).padStart(4, '0')}`, fecha: new Date().toISOString(), estado: 'PUBLICADO', intentId: intent?.id || null, concepto, ...asiento };
  db.asientos.push(a);
  return a;
}

function registrarGuard(intent, resultado, contexto) {
  db.guard.push({ id: randomUUID(), fecha: new Date().toISOString(), intentId: intent.id, busqueda: intent.busqueda, cc: intent.cc, contexto, ...resultado });
}

const disponible = (cc) => L.presupuestos(db.asientos).find((p) => p.cc === cc).disponible;
const monto = (m) => Number(m?.amount ?? m);

// Busca y cotiza. Si una tienda no puede surtir (direccion, telefono), prueba la siguiente.
async function cotizar(intent, { cantidad, envioCaro = false }, sufijo) {
  const busqueda = await reapApi.buscar({ query: intent.busqueda, pais: PAIS, moneda: MONEDA });
  const candidatos = (busqueda.products || []).filter((p) => p.available && p.previewVariant?.available).slice(0, 3);
  if (!candidatos.length) throw falla(404, `No hay "${intent.busqueda}" en las tiendas compatibles.`);
  let ultimo;
  for (const [i, p] of candidatos.entries()) {
    try {
      let quote = await reapApi.cotizar({ variantId: p.previewVariant.id, cantidad, email: EMAIL, envio: ENVIO, clave: `${intent.id}-quo-${sufijo}-${i}` });
      const producto = { id: p.id, nombre: p.name, tienda: p.merchant?.name, imagen: p.imageUrl || null };
      const propuesta = proponer({ producto, quote, cantidadBase: cantidad, instrucciones: { envioCaro } });
      const actual = (quote.shippingOptions || []).find((o) => o.selected);
      if (propuesta.envioId && actual?.id !== propuesta.envioId) quote = await reapApi.elegirEnvio(quote.id, propuesta.envioId);
      return { quote, producto, propuesta };
    } catch (e) {
      if (e.codigo !== 'QUOTE_UNFULFILLABLE') throw e;
      ultimo = e;
    }
  }
  throw falla(422, `Ninguna tienda pudo surtir "${intent.busqueda}": ${ultimo.message}`);
}

// Arma el pre-asiento desde el quote real de Reap y lo pasa por el Ledger Guard.
function evaluar(intent, { quote, producto, propuesta }, contexto) {
  const pre = L.preAsiento({ cc: intent.cc, cuenta: intent.cuenta, breakdown: quote.amountBreakdown });
  const resultado = revisar({ intent, propuesta, quote, pre, disponibleCc: disponible(intent.cc) });
  if (propuesta.saltarAprobacion) {
    resultado.violaciones.push({ codigo: 'SIN_APROBACION', mensaje: 'El documento pidio pagar sin la aprobacion de finanzas; J-Pay no paga sin ella.' });
    resultado.permitido = false;
  }
  Object.assign(intent, {
    quoteId: quote.id, expira: quote.expiresAt, producto, propuesta,
    pre: { ...pre, estado: 'PROPUESTO' },
    totalUsd: monto(quote.amountBreakdown.finalAmount),
    envioNombre: (quote.shippingOptions || []).find((o) => o.id === propuesta.envioId)?.name || null,
    guard: resultado,
    cotizacion: resultado.permitido ? 'LISTA' : 'BLOQUEADA',
  });
  registrarGuard(intent, resultado, contexto);
}

// Lee el checkout y contabiliza. Solo COMPLETED devenga; FAILED y EXPIRED son finales y liberan.
async function conciliar(intent) {
  if (intent.estado !== 'EN_CHECKOUT' || !intent.checkoutId) return;
  const c = await reapApi.consultarCheckout(intent.checkoutId);
  if (c.status === 'FAILED' || c.status === 'EXPIRED') {
    intent.estado = c.status === 'FAILED' ? 'FALLIDO' : 'EXPIRADO';
    publicar(L.liberacion({ cc: intent.cc, monto: L.centavos(intent.topeUsd) }), intent, `Libera compromiso: checkout ${c.status}`);
    await guardar();
    return;
  }
  if (c.status !== 'COMPLETED') return;
  intent.estado = 'COMPLETADO';
  intent.orderId = c.orderId;
  intent.finalUsd = monto(c.finalAmount ?? intent.totalUsd);
  for (const a of L.devengado({ pre: intent.pre, finalCheckout: intent.finalUsd, cc: intent.cc })) {
    publicar(a, intent, a.tipo === 'AJUSTE' ? `Ajuste: Reap cobro distinto a lo cotizado (orden ${c.orderId})` : `${intent.producto.nombre} · ${intent.producto.tienda} · orden ${c.orderId}`);
  }
  publicar(L.liberacion({ cc: intent.cc, monto: L.centavos(intent.topeUsd) }), intent, 'Libera compromiso: pago completado');
  await guardar();
}

const rutas = {
  'GET /api/estado': async () => {
    for (const i of Object.values(db.intents)) await conciliar(i).catch((e) => console.error(e.message));
    let tarjeta = null;
    if (db.enrollmentId) tarjeta = (await reapApi.enrollment(db.enrollmentId).catch(() => ({ status: 'SIN_CONEXION' }))).status;
    const completados = Object.values(db.intents).filter((i) => i.estado === 'COMPLETADO');
    return {
      modo: modoReap,
      tarjeta,
      catalogo: { cuentas: CUENTAS, categorias: CATEGORIAS, centros: CENTROS },
      intents: Object.values(db.intents).sort((a, b) => b.creado.localeCompare(a.creado)).slice(0, 15),
      asientos: db.asientos.slice(-40).reverse(),
      guard: db.guard.slice(-15).reverse(),
      balanza: L.balanza(db.asientos),
      presupuestos: L.presupuestos(db.asientos),
      pnl: L.pnl(db.asientos),
      pagos: {
        completados: completados.length,
        conAsiento: completados.filter((i) => db.asientos.some((a) => a.intentId === i.id && a.tipo === 'DEVENGADO')).length,
        conFactura: completados.filter((i) => i.factura).length,
      },
    };
  },

  'POST /api/tarjeta': async () => {
    const e = await reapApi.crearEnrollment({ clienteId: 'jpay-empresa-demo', email: EMAIL, returnUrl: `${PUBLIC_URL}/finanzas.html` });
    db.enrollmentId = e.id;
    await guardar();
    return { url: e.nextAction?.url || null, status: e.status };
  },

  // 1. Intent del empleado: se aprueba contra presupuesto y nace el compromiso. 2. El agente cotiza.
  'POST /api/intents': async (b) => {
    const cc = String(b.cc || '');
    const categoria = String(b.categoria || '');
    const busqueda = String(b.busqueda || '').trim();
    const cantidad = Number(b.cantidad || 1);
    const maxCantidad = Number(b.maxCantidad || cantidad);
    const topeUsd = Math.round(Number(b.topeUsd) * 100) / 100;
    if (!CENTROS[cc]) throw falla(400, 'Centro de costo invalido.');
    if (!CATEGORIAS[categoria]) throw falla(400, 'Categoria invalida.');
    if (busqueda.length < 2 || busqueda.length > 80) throw falla(400, 'Describe que se compra (2 a 80 letras).');
    const prohibido = restriccion(busqueda);
    if (prohibido) throw falla(422, `${prohibido.mensaje} No se crea el pedido.`);
    if (!Number.isInteger(cantidad) || !Number.isInteger(maxCantidad) || cantidad < 1 || cantidad > maxCantidad || maxCantidad > 20) throw falla(400, 'Cantidad invalida.');
    if (!(topeUsd > 0 && topeUsd <= 1000)) throw falla(400, 'El tope va de 0.01 a 1000 USD.');
    if (L.centavos(topeUsd) > disponible(cc)) throw falla(409, `${CENTROS[cc].nombre} no tiene presupuesto para un tope de USD ${topeUsd}.`);

    const intent = {
      id: `INT-${randomUUID().slice(0, 8)}`, creado: new Date().toISOString(),
      solicitante: String(b.solicitante || 'Equipo').slice(0, 40), cc, categoria, cuenta: CATEGORIAS[categoria].cuenta,
      busqueda, cantidad, maxCantidad, topeUsd, envio: 'economico', moneda: MONEDA, estado: 'APROBADO',
    };
    db.intents[intent.id] = intent;
    publicar(L.compromiso({ cc, monto: L.centavos(topeUsd) }), intent, `Compromiso: ${busqueda} (${intent.solicitante})`);
    await guardar();
    try {
      evaluar(intent, await cotizar(intent, { cantidad }, 'base'), 'Cotizacion del agente');
    } catch (e) {
      intent.cotizacion = 'ERROR';
      intent.error = e.message;
    }
    await guardar();
    return intent;
  },

  // Pedido en lenguaje natural: Claude propone los campos y el solicitante confirma en el formulario.
  // No crea el intent: ese paso sigue siendo POST /api/intents con sus validaciones.
  'POST /api/intents/interpretar': async (b) => {
    const texto = String(b.texto || '').trim();
    if (texto.length < 3 || texto.length > 1000) throw falla(400, 'Escribe el pedido (3 a 1000 caracteres).');
    const prohibido = restriccion(texto);
    if (prohibido) throw falla(422, `${prohibido.mensaje} No se crea el pedido.`);
    const propuesta = await interpretar(texto);
    const tambien = restriccion(propuesta.busqueda);
    if (tambien) throw falla(422, `${tambien.mensaje} No se crea el pedido.`);
    return propuesta;
  },

  // El vector de ataque: un "documento de proveedor" que el agente lee y obedece.
  'POST /api/intents/documento': async (b) => {
    const intent = db.intents[b.id];
    if (!intent) throw falla(404, 'Ese intent no existe.');
    if (intent.estado !== 'APROBADO') throw falla(409, `El intent esta ${intent.estado}.`);
    const instr = leerInstrucciones(String(b.texto || '').slice(0, 5000));
    const cotizado = await cotizar(intent, { cantidad: instr.cantidad ?? intent.cantidad, envioCaro: instr.envioCaro }, `doc-${Date.now()}`);
    cotizado.propuesta.saltarAprobacion = instr.saltarAprobacion;
    evaluar(intent, cotizado, 'Documento de proveedor compartido en el chat');
    await guardar();
    return intent;
  },

  // 3. Finanzas aprueba. El compromiso ya reservo el tope, asi que aqui basta con que la
  // cotizacion haya pasado el guard y siga vigente.
  'POST /api/intents/aprobar': async (b) => {
    const intent = db.intents[b.id];
    if (!intent) throw falla(404, 'Ese intent no existe.');
    if (intent.estado !== 'APROBADO') throw falla(409, `El intent esta ${intent.estado}.`);
    if (intent.cotizacion !== 'LISTA') {
      registrarGuard(intent, intent.guard || { permitido: false, violaciones: [{ codigo: 'SIN_COTIZACION', mensaje: 'No hay cotizacion valida.' }] }, 'Intento de pago');
      await guardar();
      throw falla(409, `Ledger Guard bloqueo el pago: ${(intent.guard?.violaciones || []).map((v) => v.codigo).join(', ') || 'sin cotizacion valida'}`);
    }
    if (intent.expira && new Date(intent.expira) <= new Date()) {
      intent.cotizacion = 'BLOQUEADA';
      intent.guard = { permitido: false, violaciones: [{ codigo: 'QUOTE_EXPIRADO', mensaje: 'La cotizacion de Reap ya expiro; hay que cotizar de nuevo.' }] };
      registrarGuard(intent, intent.guard, 'Intento de pago');
      await guardar();
      throw falla(409, 'La cotizacion de Reap expiro; cotiza de nuevo.');
    }
    if (!db.enrollmentId) throw falla(409, 'Primero registra la tarjeta corporativa en Reap.');
    if ((await reapApi.enrollment(db.enrollmentId)).status !== 'ACTIVE') throw falla(409, 'La tarjeta en Reap no esta ACTIVE.');

    intent.estado = 'EN_CHECKOUT'; // reclamo antes de llamar a Reap: un doble clic no cobra dos veces
    await guardar();
    try {
      const c = await reapApi.checkout({ quoteId: intent.quoteId, enrollmentId: db.enrollmentId, returnUrl: `${PUBLIC_URL}/retorno?intent=${intent.id}`, clave: `${intent.id}-chk-${intent.quoteId}` });
      intent.checkoutId = c.id;
      await guardar();
      return { url: c.nextAction?.url || `${PUBLIC_URL}/retorno?intent=${intent.id}` };
    } catch (e) {
      intent.estado = 'APROBADO';
      await guardar();
      throw e;
    }
  },

  // Recotiza un intent cuya cotizacion expiro o fue bloqueada.
  'POST /api/intents/recotizar': async (b) => {
    const intent = db.intents[b.id];
    if (!intent) throw falla(404, 'Ese intent no existe.');
    if (intent.estado !== 'APROBADO') throw falla(409, `El intent esta ${intent.estado}.`);
    evaluar(intent, await cotizar(intent, { cantidad: intent.cantidad }, `re-${Date.now()}`), 'Recotizacion del agente');
    await guardar();
    return intent;
  },

  // 4. Factura del proveedor: se adjunta al asiento que ya existe. No se busca, se construye.
  'POST /api/facturas': async (b) => {
    const orderId = String(b.orderId || '').trim();
    const total = Math.round(Number(b.total) * 100) / 100;
    const intent = Object.values(db.intents).find((i) => i.orderId && i.orderId === orderId);
    if (!intent) throw falla(404, `No hay un pago con la orden ${orderId}.`);
    if (intent.factura) throw falla(409, 'Ese pago ya tiene factura.');
    if (Math.abs(total - intent.finalUsd) > 0.01) throw falla(409, `La factura (USD ${total}) no coincide con lo pagado (USD ${intent.finalUsd}).`);
    intent.factura = { folio: String(b.folio || '').slice(0, 60) || orderId, total, fecha: new Date().toISOString() };
    db.facturas.push({ intentId: intent.id, ...intent.factura });
    await guardar();
    return { intent: intent.id, asientos: db.asientos.filter((a) => a.intentId === intent.id).map((a) => a.id), factura: intent.factura };
  },

  // 5. Cierre de mes: liquida la tarjeta y devuelve balanza y P&L.
  'POST /api/cierre': async () => {
    const liq = L.liquidacion(db.asientos);
    if (liq) publicar(liq, null, 'Cierre: liquidacion de la tarjeta corporativa Reap');
    await guardar();
    return { liquidacion: liq ? L.usd(liq.lineas[0].debe) : 0, balanza: L.balanza(db.asientos), pnl: L.pnl(db.asientos) };
  },
};

async function retorno(url) {
  const intent = db.intents[url.searchParams.get('intent')];
  if (!intent) return '/finanzas.html';
  for (let i = 0; i < 5 && intent.estado === 'EN_CHECKOUT'; i++) {
    await conciliar(intent);
    if (intent.estado === 'EN_CHECKOUT') await new Promise((s) => setTimeout(s, 2000));
  }
  return `/finanzas.html?intent=${intent.id}`;
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
    if (texto.length > 20000) throw falla(413, 'Cuerpo demasiado grande.');
  }
  try { return texto ? JSON.parse(texto) : {}; } catch { throw falla(400, 'JSON invalido.'); }
}

// Lista cerrada de archivos de public/: nada fuera de aqui se sirve.
const ESTATICOS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/solicitante.html': ['solicitante.html', 'text/html; charset=utf-8'],
  '/finanzas.html': ['finanzas.html', 'text/html; charset=utf-8'],
  '/contador.html': ['contador.html', 'text/html; charset=utf-8'],
  '/comun.js': ['comun.js', 'text/javascript; charset=utf-8'],
  '/comun.css': ['comun.css', 'text/css; charset=utf-8'],
  '/errores.js': ['errores.js', 'text/javascript; charset=utf-8'],
};

const responder = (res, status, datos) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(datos));
};

createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  try {
    const estatico = req.method === 'GET' && ESTATICOS[url.pathname];
    if (estatico) {
      res.writeHead(200, { 'Content-Type': estatico[1] });
      return res.end(await readFile(new URL(`public/${estatico[0]}`, RAIZ)));
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
    return responder(res, e.status >= 400 && e.status < 600 ? e.status : 502, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`J-Pay en ${PUBLIC_URL} (Reap ${modoReap})`);
});
