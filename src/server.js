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
import { comprometidoVivo, decidir, liberarCompromiso, sincronizarCompromiso } from './decision.js';
import { CON_COMPROMISO, ESTADOS, RECOTIZABLES, anotar, migrar, nacer, puede, transicionar, transicionInvalida } from './estados.js';
import { atenderAprobacion } from './reap-sim.js';

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

// Un asiento que ya trae id (la apertura, APERTURA-<cc>-<mes>) lo conserva: de ese id estable
// depende que la apertura no se repita.
function publicar(asiento, intent, concepto) {
  L.validar(asiento);
  const a = { id: `A-${String(db.asientos.length + 1).padStart(4, '0')}`, fecha: new Date().toISOString(), estado: 'PUBLICADO', intentId: intent?.id || null, concepto, ...asiento };
  db.asientos.push(a);
  return a;
}

// Presupuesto mensual en cuentas de orden (8000/8900): una apertura por centro y mes, idempotente.
if (L.asegurarAperturasPresupuesto(db.asientos, new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' }).slice(0, 7), (a) => publicar(a, null, 'Apertura de presupuesto')).length) await guardar();

// Checkouts en vuelo: un doble clic en autorizar no crea dos, y la expiracion no los pisa.
const enCurso = new Set();

// Toda transicion del servidor: la maquina de estados decide si aplica y el compromiso sigue al
// estado (se reserva con una cotizacion valida, se libera al salir de ella).
function mover(intent, a, { concepto, ...traza } = {}) {
  transicionar(intent, a, traza);
  sincronizarCompromiso(intent, db.asientos, publicar, concepto);
}

// Al arrancar: intents con el formato anterior pasan a la maquina de estados (ver migrar en
// src/estados.js), y los compromisos huerfanos, vivos en un estado que no reserva presupuesto (una
// compra que nunca cotizo, una bloqueada), se liberan con su asiento. Nunca se borra un asiento.
{
  let cambio = false;
  for (const i of Object.values(db.intents)) {
    if (migrar(i)) cambio = true;
    if (!ESTADOS.includes(i.estado)) { console.warn(`Intent ${i.id} con estado desconocido ${i.estado}; no se toca.`); continue; }
    if (!CON_COMPROMISO.includes(i.estado) && liberarCompromiso(i, db.asientos, publicar, `Libera compromiso huerfano: la compra esta ${i.estado}`)) {
      anotar(i, { evento: 'COMPROMISO_LIBERADO', datos: { motivo: 'huerfano', estado: i.estado } });
      cambio = true;
    }
    if (CON_COMPROMISO.includes(i.estado) && comprometidoVivo(db.asientos, i.id) <= 0) console.warn(`Intent ${i.id} ${i.estado} sin compromiso vivo.`);
    if (vencer(i)) cambio = true;
  }
  if (cambio) await guardar();
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

// Arma el pre-asiento desde el quote real de Reap y lo pasa por el Ledger Guard. Si pasa, la
// compra queda COTIZADA y reserva su tope; si no, BLOQUEADA y sin compromiso.
function evaluar(intent, { quote, producto, propuesta }, contexto, actor = 'agente') {
  // Otra peticion pudo cambiar el estado mientras Reap respondia.
  if (!RECOTIZABLES.includes(intent.estado)) throw transicionInvalida(intent.estado, 'COTIZADA');
  const pre = L.preAsiento({ cc: intent.cc, cuenta: intent.cuenta, breakdown: quote.amountBreakdown });
  // Lo libre si este intent no tuviera compromiso; el guard espera lo disponible ya con el tope reservado.
  const libre = disponible(intent.cc) + comprometidoVivo(db.asientos, intent.id);
  const tope = L.centavos(intent.topeUsd);
  const resultado = revisar({ intent, propuesta, quote, pre, disponibleCc: libre - tope });
  if (tope > libre && !resultado.violaciones.some((v) => v.codigo === 'PRESUPUESTO')) {
    resultado.violaciones.push({ codigo: 'PRESUPUESTO', mensaje: `El tope (USD ${intent.topeUsd}) ya no cabe en el presupuesto disponible del centro de costo.` });
    resultado.permitido = false;
  }
  if (propuesta.saltarAprobacion) {
    resultado.violaciones.push({ codigo: 'SIN_APROBACION', mensaje: 'El documento pidio pagar sin la aprobacion de finanzas; J-Pay no paga sin ella.' });
    resultado.permitido = false;
  }
  const destino = resultado.permitido ? 'COTIZADA' : 'BLOQUEADA';
  if (!puede(intent.estado, destino)) throw transicionInvalida(intent.estado, destino);
  delete intent.error;
  Object.assign(intent, {
    quoteId: quote.id, expira: quote.expiresAt, producto, propuesta,
    pre: { ...pre, estado: 'PROPUESTO' },
    totalUsd: monto(quote.amountBreakdown.finalAmount),
    envioNombre: (quote.shippingOptions || []).find((o) => o.id === propuesta.envioId)?.name || null,
    guard: resultado,
    cotizacion: resultado.permitido ? 'LISTA' : 'BLOQUEADA',
  });
  registrarGuard(intent, resultado, contexto);
  const de = intent.estado;
  mover(intent, destino, { actor, evento: contexto, datos: { quoteId: quote.id, totalUsd: intent.totalUsd, violaciones: resultado.violaciones.map((v) => v.codigo) } });
  // Los cambios pedidos ya se atendieron: la compra vuelve a esperar decision (el pedido queda en la traza).
  if (de === 'CAMBIOS_SOLICITADOS') intent.decision = null;
}

// La cotizacion de Reap vence (~5 min). Antes del checkout la compra queda EXPIRADA (se puede
// recotizar); si ya estaba autorizada y el checkout no se creo, FALLIDA. Ambas liberan.
function vencer(intent, ahora = new Date()) {
  if (!['COTIZADA', 'AUTORIZADA'].includes(intent.estado) || !intent.expira || new Date(intent.expira) > ahora) return false;
  if (enCurso.has(intent.id)) return false; // el checkout ya va en camino; lo resuelve aprobar
  intent.cotizacion = 'BLOQUEADA';
  intent.guard = { permitido: false, violaciones: [{ codigo: 'QUOTE_EXPIRADO', mensaje: 'La cotizacion de Reap ya expiro; hay que cotizar de nuevo.' }] };
  mover(intent, intent.estado === 'COTIZADA' ? 'EXPIRADA' : 'FALLIDA', { evento: 'QUOTE_EXPIRADO', datos: { quoteId: intent.quoteId, expira: intent.expira }, ahora });
  return true;
}

// Lee el checkout y contabiliza. Solo COMPLETED devenga; FAILED y EXPIRED son finales y liberan.
async function conciliar(intent) {
  if (intent.estado !== 'EN_PAGO' || !intent.checkoutId) return;
  const c = await reapApi.consultarCheckout(intent.checkoutId);
  if (intent.estado !== 'EN_PAGO') return; // otra lectura ya lo concilio mientras Reap respondia
  if (c.status === 'FAILED' || c.status === 'EXPIRED') {
    mover(intent, 'FALLIDA', { actor: 'reap', evento: `CHECKOUT_${c.status}`, datos: { checkoutId: c.id, motivo: c.failureReason || null }, concepto: `Libera compromiso: checkout ${c.status}` });
    await guardar();
    return;
  }
  if (c.status !== 'COMPLETED') return;
  intent.orderId = c.orderId;
  intent.finalUsd = monto(c.finalAmount ?? intent.totalUsd);
  for (const a of L.devengado({ pre: intent.pre, finalCheckout: intent.finalUsd, cc: intent.cc })) {
    publicar(a, intent, a.tipo === 'AJUSTE' ? `Ajuste: Reap cobro distinto a lo cotizado (orden ${c.orderId})` : `${intent.producto.nombre} · ${intent.producto.tienda} · orden ${c.orderId}`);
  }
  mover(intent, 'PAGADA', { actor: 'reap', evento: 'CHECKOUT_COMPLETED', datos: { checkoutId: c.id, orderId: c.orderId, finalUsd: intent.finalUsd } });
  await guardar();
}

const rutas = {
  'GET /api/estado': async () => {
    if (Object.values(db.intents).filter((i) => vencer(i)).length) await guardar();
    for (const i of Object.values(db.intents)) await conciliar(i).catch((e) => console.error(e.message));
    let tarjeta = null;
    if (db.enrollmentId) tarjeta = (await reapApi.enrollment(db.enrollmentId).catch(() => ({ status: 'SIN_CONEXION' }))).status;
    const completados = Object.values(db.intents).filter((i) => i.estado === 'PAGADA');
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

  // 1. Intent del empleado: nace SIN_COTIZACION y sin compromiso. 2. El agente cotiza; el tope se
  // reserva solo si la cotizacion pasa el guard.
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
      busqueda, cantidad, maxCantidad, topeUsd, envio: 'economico', moneda: MONEDA,
    };
    nacer(intent, { actor: intent.solicitante, datos: { cc, topeUsd, busqueda } });
    db.intents[intent.id] = intent;
    await guardar();
    try {
      evaluar(intent, await cotizar(intent, { cantidad }, 'base'), 'Cotizacion del agente');
    } catch (e) {
      if (e.codigoApi === 'TRANSICION_INVALIDA') throw e;
      intent.cotizacion = 'ERROR';
      intent.error = e.message;
      anotar(intent, { actor: 'agente', evento: 'COTIZACION_ERROR', datos: { mensaje: e.message } });
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
    puedeCotizar(intent);
    const instr = leerInstrucciones(String(b.texto || '').slice(0, 5000));
    const cotizado = await cotizar(intent, { cantidad: instr.cantidad ?? intent.cantidad, envioCaro: instr.envioCaro }, `doc-${Date.now()}`);
    cotizado.propuesta.saltarAprobacion = instr.saltarAprobacion;
    evaluar(intent, cotizado, 'Documento de proveedor compartido en el chat');
    await guardar();
    return intent;
  },

  // 3. Finanzas autoriza. La cotizacion ya reservo el tope al pasar el guard; aqui basta con que
  // siga vigente. COTIZADA -> AUTORIZADA -> EN_PAGO. Si crear el checkout falla, queda AUTORIZADA
  // y autorizar de nuevo reintenta con la misma Idempotency-Key.
  'POST /api/intents/aprobar': async (b) => {
    const intent = db.intents[b.id];
    if (!intent) throw falla(404, 'Ese intent no existe.');
    if (intent.estado === 'BLOQUEADA' || intent.estado === 'SIN_COTIZACION') {
      registrarGuard(intent, intent.guard || { permitido: false, violaciones: [{ codigo: 'SIN_COTIZACION', mensaje: 'No hay cotizacion valida.' }] }, 'Intento de pago');
      await guardar();
      throw falla(409, `Ledger Guard bloqueo el pago: ${(intent.guard?.violaciones || []).map((v) => v.codigo).join(', ') || 'sin cotizacion valida'}`, intent.estado === 'BLOQUEADA' ? 'GUARD_BLOQUEO' : 'SIN_COTIZACION');
    }
    const autorizable = () => (intent.estado === 'COTIZADA' || intent.estado === 'AUTORIZADA') && !enCurso.has(intent.id);
    if (!autorizable()) throw falla(409, `El intent esta ${intent.estado}.`, 'TRANSICION_INVALIDA');
    if (vencer(intent)) {
      registrarGuard(intent, intent.guard, 'Intento de pago');
      await guardar();
      throw falla(409, intent.estado === 'EXPIRADA' ? 'La cotizacion de Reap expiro; cotiza de nuevo.' : 'La cotizacion de Reap expiro antes de crear el pago; pide la compra de nuevo.', 'QUOTE_EXPIRADO');
    }
    if (!db.enrollmentId) throw falla(409, 'Primero registra la tarjeta corporativa en Reap.');
    if ((await reapApi.enrollment(db.enrollmentId)).status !== 'ACTIVE') throw falla(409, 'La tarjeta en Reap no esta ACTIVE.');
    // Mientras se consultaba la tarjeta, finanzas pudo rechazar, pedir cambios o autorizar dos veces.
    if (!autorizable()) throw falla(409, `El intent esta ${intent.estado}.`, 'TRANSICION_INVALIDA');

    // Reclamo antes de llamar a Reap: un doble clic ya no encuentra la compra libre.
    enCurso.add(intent.id);
    try {
      if (intent.estado === 'COTIZADA') {
        const por = String(b.por || 'Finanzas').trim().slice(0, 40) || 'Finanzas';
        mover(intent, 'AUTORIZADA', { actor: por, evento: 'AUTORIZAR', datos: { quoteId: intent.quoteId, totalUsd: intent.totalUsd } });
        intent.decision = { por, en: new Date().toISOString(), accion: 'AUTORIZAR', motivo: null };
      }
      await guardar();
      const c = await reapApi.checkout({ quoteId: intent.quoteId, enrollmentId: db.enrollmentId, returnUrl: `${PUBLIC_URL}/retorno?intent=${intent.id}`, clave: `${intent.id}-chk-${intent.quoteId}` });
      intent.checkoutId = c.id;
      mover(intent, 'EN_PAGO', { actor: 'reap', evento: 'CHECKOUT_CREADO', datos: { checkoutId: c.id } });
      await guardar();
      return { url: c.nextAction?.url || `${PUBLIC_URL}/retorno?intent=${intent.id}` };
    } catch (e) {
      // Si Reap rechaza el checkout (cotizacion vencida o invalida), no hay reintento que valga:
      // FALLIDA y se libera. Sin red, 5xx, 408 o 429 queda AUTORIZADA para reintentar.
      const definitivo = e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
      if (definitivo && intent.estado === 'AUTORIZADA') {
        mover(intent, 'FALLIDA', { actor: 'reap', evento: 'CHECKOUT_RECHAZADO', datos: { mensaje: e.message } });
        e.codigoApi = 'REAP_RECHAZO';
      } else anotar(intent, { actor: 'reap', evento: 'CHECKOUT_ERROR', datos: { mensaje: e.message } });
      await guardar();
      throw e;
    } finally {
      enCurso.delete(intent.id);
    }
  },

  // Recotiza: cotizacion vencida, bloqueada, sin cotizacion, o con cambios pedidos por finanzas.
  // Si pasa el guard vuelve a COTIZADA y reserva el tope (si no hay compromiso, revisa antes que quepa).
  'POST /api/intents/recotizar': async (b) => {
    const intent = db.intents[b.id];
    if (!intent) throw falla(404, 'Ese intent no existe.');
    puedeCotizar(intent);
    evaluar(intent, await cotizar(intent, { cantidad: intent.cantidad }, `re-${Date.now()}`), 'Recotizacion del agente');
    await guardar();
    return intent;
  },

  // Finanzas rechaza o pide cambios sin llamar a Reap: no hay checkout que cancelar todavia.
  'POST /api/intents/rechazar': async (b) => decision(b, 'RECHAZAR', b.motivo),
  'POST /api/intents/cambios': async (b) => decision(b, 'CAMBIOS', b.comentario),

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

// Solo se cotiza desde los estados de la maquina que lo permiten, y si el tope todavia cabe.
function puedeCotizar(intent) {
  if (!RECOTIZABLES.includes(intent.estado)) throw falla(409, `La compra esta ${intent.estado}; ya no se puede cotizar.`, 'TRANSICION_INVALIDA');
  if (!comprometidoVivo(db.asientos, intent.id) && L.centavos(intent.topeUsd) > disponible(intent.cc)) {
    throw falla(409, `El centro de costo ${intent.cc} ya no tiene presupuesto para el tope de USD ${intent.topeUsd}; no se puede recotizar.`, 'PRESUPUESTO_INSUFICIENTE');
  }
}

async function decision(b, accion, motivo) {
  const intent = db.intents[b.id];
  if (!intent) throw falla(404, 'Ese intent no existe.');
  decidir(intent, { accion, por: b.por, motivo }, { asientos: db.asientos, publicar });
  await guardar();
  return intent;
}

async function retorno(url) {
  const intent = db.intents[url.searchParams.get('intent')];
  if (!intent) return '/finanzas.html';
  for (let i = 0; i < 5 && intent.estado === 'EN_PAGO'; i++) {
    await conciliar(intent);
    if (intent.estado === 'EN_PAGO') await new Promise((s) => setTimeout(s, 2000));
  }
  return `/finanzas.html?intent=${intent.id}`;
}

function falla(status, mensaje, codigo) {
  const e = new Error(mensaje);
  e.status = status;
  if (codigo) e.codigoApi = codigo;
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
  '/logo.svg': ['logo.svg', 'image/svg+xml'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
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
    // Hace las veces de la pagina alojada de checkout de Reap; solo existe sin REAP_API_KEY.
    if (modoReap === 'simulado' && url.pathname === '/sim/aprobar') return await atenderAprobacion(req, res, url);
    const ruta = rutas[`${req.method} ${url.pathname}`];
    if (!ruta) return responder(res, 404, { error: 'No existe' });
    return responder(res, 200, await ruta(req.method === 'POST' ? await leerCuerpo(req) : {}));
  } catch (e) {
    if (!e.status || e.status >= 500) console.error(e.message);
    // error sigue siendo texto; codigo es aditivo (TRANSICION_INVALIDA, ...) para quien lo quiera.
    return responder(res, e.status >= 400 && e.status < 600 ? e.status : 502, { error: e.message, ...(e.codigoApi ? { codigo: e.codigoApi } : {}) });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`J-Pay en ${PUBLIC_URL} (Reap ${modoReap})`);
});
