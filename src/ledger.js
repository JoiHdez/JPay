// Ledger de partida doble. Funciones puras sobre la lista de asientos: el servidor decide cuando
// publicar, aqui solo se valida y se calcula. Montos en centavos para que la suma cuadre exacta.
import { CUENTAS, CENTROS, CUENTAS_DE_CONSUMO } from './catalogo.js';

export const centavos = (usd) => Math.round(Number(usd) * 100);
export const usd = (c) => c / 100;

/** Lanza si el asiento no cuadra o usa una cuenta fuera del catalogo. */
export function validar(asiento) {
  if (!asiento.lineas?.length) throw new Error('Asiento sin lineas');
  let debe = 0;
  let haber = 0;
  for (const l of asiento.lineas) {
    if (!CUENTAS[l.cuenta]) throw new Error(`Cuenta ${l.cuenta} fuera del catalogo`);
    if (l.cc && !CENTROS[l.cc]) throw new Error(`Centro de costo ${l.cc} no existe`);
    if (!Number.isInteger(l.debe || 0) || !Number.isInteger(l.haber || 0) || (l.debe || 0) < 0 || (l.haber || 0) < 0) {
      throw new Error('Montos invalidos');
    }
    debe += l.debe || 0;
    haber += l.haber || 0;
  }
  if (debe !== haber) throw new Error(`No cuadra: debe ${usd(debe)} / haber ${usd(haber)}`);
  if (debe === 0) throw new Error('Asiento en cero');
  return asiento;
}

export const cuadra = (asiento) => { try { validar(asiento); return true; } catch { return false; } };

function resumirBalanza(filas) {
  const total = filas.reduce((t, f) => ({ debe: t.debe + f.debe, haber: t.haber + f.haber }), { debe: 0, haber: 0 });
  return { filas, total, cuadra: total.debe === total.haber };
}

/**
 * Saldos publicados (debe - haber), separados en balance y cuentas de orden.
 * Conserva filas/total globales para los consumidores existentes; cada fila indica orden.
 * El cuadre global exige también el cuadre independiente de ambos grupos.
 */
export function balanza(asientos) {
  const s = {};
  for (const a of asientos) {
    if (a.estado !== 'PUBLICADO') continue;
    for (const l of a.lineas) {
      s[l.cuenta] ??= { cuenta: Number(l.cuenta), nombre: CUENTAS[l.cuenta].nombre, orden: Boolean(CUENTAS[l.cuenta].orden), debe: 0, haber: 0 };
      s[l.cuenta].debe += l.debe || 0;
      s[l.cuenta].haber += l.haber || 0;
    }
  }
  const filas = Object.values(s).sort((a, b) => a.cuenta - b.cuenta).map((f) => ({ ...f, saldo: f.debe - f.haber }));
  const general = resumirBalanza(filas);
  const balance = resumirBalanza(filas.filter((f) => !f.orden));
  const orden = resumirBalanza(filas.filter((f) => f.orden));
  return { ...general, cuadra: general.cuadra && balance.cuadra && orden.cuadra, balance, orden };
}

/** Por centro de costo: comprometido vivo, consumido (devengado) y disponible, en centavos. */
export function presupuestos(asientos) {
  const r = Object.fromEntries(Object.entries(CENTROS).map(([cc, c]) => [cc, { cc, nombre: c.nombre, presupuesto: centavos(c.presupuesto), comprometido: 0, consumido: 0 }]));
  for (const a of asientos) {
    if (a.estado !== 'PUBLICADO') continue;
    for (const l of a.lineas) {
      if (!l.cc) continue;
      const neto = (l.debe || 0) - (l.haber || 0);
      if (Number(l.cuenta) === 8100) r[l.cc].comprometido += neto;
      else if (CUENTAS_DE_CONSUMO.includes(Number(l.cuenta))) r[l.cc].consumido += neto;
    }
  }
  for (const p of Object.values(r)) p.disponible = p.presupuesto - p.comprometido - p.consumido;
  return Object.values(r);
}

// ── Asientos tipo ──────────────────────────────────────────────────────────────

function validarPresupuesto(centroCosto, monto) {
  if (!Object.hasOwn(CENTROS, centroCosto)) throw new Error(`Centro de costo ${centroCosto} no existe`);
  if (!Number.isSafeInteger(monto) || monto <= 0) throw new Error('El presupuesto debe ser un entero positivo en centavos');
}

/**
 * Construye una apertura con ID estable por centro de costo y período mensual (YYYY-MM).
 * monto está en centavos. No publica ni guarda estado: asegurarAperturasPresupuesto evita
 * duplicados consultando el libro persistido, incluso después de reiniciar el proceso.
 */
export function aperturaPresupuesto(centroCosto, monto, periodo) {
  validarPresupuesto(centroCosto, monto);
  if (typeof periodo !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) {
    throw new Error('El período de presupuesto debe tener formato YYYY-MM');
  }
  return validar({
    id: `APERTURA-${centroCosto}-${periodo}`,
    tipo: 'APERTURA_PRESUPUESTO',
    periodo,
    lineas: [{ cuenta: 8000, cc: centroCosto, debe: monto }, { cuenta: 8900, cc: centroCosto, haber: monto }],
  });
}

/**
 * Publica solo aperturas faltantes de CENTROS para el período indicado.
 * publicar debe añadir el asiento PUBLICADO a asientos; el servidor debe guardar el libro
 * antes de aceptar solicitudes. Una apertura existente no se repite aunque cambie el tope.
 * Esto no implementa cierre ni traslado de saldos entre períodos.
 */
export function asegurarAperturasPresupuesto(asientos, periodo, publicar) {
  if (!Array.isArray(asientos) || typeof publicar !== 'function') throw new Error('Se requieren el libro y una función para publicar');
  const nuevas = [];
  for (const [cc, centro] of Object.entries(CENTROS)) {
    const apertura = aperturaPresupuesto(cc, centavos(centro.presupuesto), periodo);
    const existe = asientos.some((a) => a.estado === 'PUBLICADO' && a.tipo === apertura.tipo && a.periodo === periodo
      && a.lineas?.some((l) => Number(l.cuenta) === 8000 && l.cc === cc));
    if (existe) continue;
    publicar(apertura);
    nuevas.push(apertura);
  }
  return nuevas;
}

/**
 * Descuenta el consumo del disponible en cuentas de orden, sin cambiar compromiso/liberación.
 * monto es el neto en centavos de CUENTAS_DE_CONSUMO del devengado y sus ajustes, no el IVA
 * acreditable. El backend debe publicar este asiento al pagar, junto con la liberación.
 */
export function consumoPresupuesto(centroCosto, monto) {
  validarPresupuesto(centroCosto, monto);
  return validar({
    tipo: 'CONSUMO_PRESUPUESTO',
    lineas: [{ cuenta: 8900, cc: centroCosto, debe: monto }, { cuenta: 8000, cc: centroCosto, haber: monto }],
  });
}

/** Compromiso: reserva el tope del intent en cuentas de orden (la orden de compra). */
export const compromiso = ({ cc, monto }) => ({
  tipo: 'COMPROMISO',
  lineas: [{ cuenta: 8100, cc, debe: monto }, { cuenta: 8000, cc, haber: monto }],
});

/** Libera lo que quede comprometido del intent (inverso del compromiso). */
export const liberacion = ({ cc, monto }) => ({
  tipo: 'LIBERACION',
  lineas: [{ cuenta: 8000, cc, debe: monto }, { cuenta: 8100, cc, haber: monto }],
});

/**
 * Pre-asiento desde el amountBreakdown real del quote de Reap. Si los componentes de Reap no
 * suman finalAmount, el asiento sale descuadrado a proposito: el guard lo detecta.
 * paisComercio es un argumento opcional interno: el backend debe pasar el código de país
 * verificado del comercio, no el país de envío. Solo MX separa el impuesto en 1300;
 * cualquier otro país, o su ausencia, lo carga a la cuenta y centro de costo de la compra.
 * Las llamadas existentes con { cc, cuenta, breakdown } siguen siendo válidas.
 */
export function preAsiento({ cc, cuenta, breakdown, paisComercio }) {
  const b = breakdown;
  const taxIncluido = b.tax?.includedInPrices;
  const tax = centavos(b.tax?.amount?.amount ?? 0);
  const taxAcreditable = typeof paisComercio === 'string' && paisComercio.trim().toUpperCase() === 'MX';
  const descuentos = (b.discounts || []).reduce((s, d) => s + centavos(d.amount?.amount ?? d.amount ?? 0), 0);
  const extras = (b.additionalCharges || []).reduce((s, d) => s + centavos(d.amount?.amount ?? d.amount ?? 0), 0);
  const base = centavos(b.itemsSubtotal?.amount ?? 0) - (taxIncluido ? tax : 0) - descuentos + extras;
  const lineas = [{ cuenta, cc, debe: base }];
  const envio = centavos(b.shipping?.amount ?? 0);
  if (envio) lineas.push({ cuenta: 5400, cc, debe: envio });
  if (tax) lineas.push(taxAcreditable ? { cuenta: 1300, debe: tax } : { cuenta, cc, debe: tax });
  lineas.push({ cuenta: 2100, haber: centavos(b.finalAmount.amount) });
  return { tipo: 'PRE_ASIENTO', lineas };
}

/** Devengado: el pre-asiento ya validado, publicado por el finalAmount del checkout. */
export function devengado({ pre, finalCheckout, cc }) {
  const lineas = pre.lineas.map((l) => ({ ...l }));
  const cobrado = centavos(finalCheckout);
  const cotizado = lineas.find((l) => l.cuenta === 2100).haber;
  const asientos = [{ tipo: 'DEVENGADO', lineas }];
  // Si Reap cobro distinto a lo cotizado, la diferencia va a 5900 en un asiento de ajuste.
  if (cobrado !== cotizado) {
    const d = cobrado - cotizado;
    asientos.push({
      tipo: 'AJUSTE',
      lineas: d > 0
        ? [{ cuenta: 5900, cc, debe: d }, { cuenta: 2100, haber: d }]
        : [{ cuenta: 2100, debe: -d }, { cuenta: 5900, cc, haber: -d }],
    });
  }
  return asientos;
}

/** Cierre: liquida el saldo de la tarjeta contra bancos. */
export function liquidacion(asientos) {
  const tarjeta = balanza(asientos).filas.find((f) => f.cuenta === 2100);
  const porPagar = tarjeta ? -tarjeta.saldo : 0;
  if (porPagar <= 0) return null;
  return { tipo: 'LIQUIDACION', lineas: [{ cuenta: 2100, debe: porPagar }, { cuenta: 1100, haber: porPagar }] };
}

/** P&L por centro de costo: solo cuentas de gasto. */
export function pnl(asientos) {
  const r = {};
  for (const a of asientos) {
    if (a.estado !== 'PUBLICADO') continue;
    for (const l of a.lineas) {
      if (CUENTAS[l.cuenta].tipo !== 'gasto') continue;
      const cc = l.cc || 'SIN_CC';
      r[cc] ??= { cc, total: 0, cuentas: {} };
      const n = (l.debe || 0) - (l.haber || 0);
      r[cc].total += n;
      r[cc].cuentas[l.cuenta] = (r[cc].cuentas[l.cuenta] || 0) + n;
    }
  }
  return Object.values(r);
}
