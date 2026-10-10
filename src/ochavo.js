// Cliente de la API de Ochavo con el token de Integraciones (Bearer luca_...), igual que el
// servidor MCP de Ochavo. Solo usa dos rutas que aceptan ese token: /budgets y /expenses.
// Sin OCHAVO_TOKEN trabaja con un presupuesto de ejemplo en memoria para ensayar.
const TOKEN = process.env.OCHAVO_TOKEN;
const BASE = (process.env.OCHAVO_URL || 'https://ochavo.com.mx').replace(/\/+$/, '');
export const modo = TOKEN ? 'real' : 'simulado';
export const CATEGORIA = process.env.OCHAVO_CATEGORIA || 'Supermercado';

if (TOKEN && !/^luca_[a-f0-9]{48}$/.test(TOKEN)) {
  throw new Error('OCHAVO_TOKEN no tiene la forma de un token de Ochavo (luca_...).');
}

async function api(ruta, { metodo = 'GET', cuerpo } = {}) {
  const r = await fetch(`${BASE}/api${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Ochavo ${r.status}: ${datos.error || 'sin detalle'}`);
  return datos;
}

// ponytail: estado de ensayo en memoria; se pierde al reiniciar, que es lo que se quiere.
const ensayo = { gastado: 860 };

export async function presupuestos() {
  if (TOKEN) return api('/budgets');
  const amount = 1500;
  return [{ id: 0, name: 'Supermercado', budget_type: 'category', category: CATEGORIA, amount, spent: ensayo.gastado, remaining: Math.max(0, Math.round((amount - ensayo.gastado) * 100) / 100) }];
}

/** Gastos de la categoria en los ultimos `meses` meses (la API filtra por mes). */
export async function gastos(meses = 3) {
  if (!TOKEN) return historialEnsayo();
  const hoy = new Date();
  const pedidos = [];
  for (let i = 0; i < meses; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    pedidos.push(api(`/expenses?category=${encodeURIComponent(CATEGORIA)}&year=${d.getFullYear()}&month=${d.getMonth() + 1}`));
  }
  return (await Promise.all(pedidos)).flat();
}

function historialEnsayo() {
  const hace = (dias) => fechaMx(new Date(Date.now() - dias * 86400000));
  return [
    { description: 'Detergente', amount: 245, expense_date: hace(62) },
    { description: 'Detergente', amount: 259, expense_date: hace(31) },
    { description: 'Toallas de papel', amount: 189, expense_date: hace(44) },
    { description: 'Toallas de papel', amount: 199, expense_date: hace(22) },
    { description: 'Croquetas perro', amount: 610, expense_date: hace(40) },
    { description: 'Croquetas perro', amount: 640, expense_date: hace(12) },
  ];
}

export async function registrarGasto({ monto, descripcion, categoria, notas }) {
  const gasto = {
    amount: monto,
    description: descripcion.slice(0, 255),
    category: categoria,
    expense_date: fechaMx(),
    payment_method: 'credito',
    notes: notas?.slice(0, 500),
  };
  if (TOKEN) return api('/expenses', { metodo: 'POST', cuerpo: gasto });
  ensayo.gastado += monto;
  return { id: `sim-${Date.now()}`, ...gasto };
}

// Ochavo cuenta el dia en hora de Mexico; el servidor puede correr en UTC.
const fechaMx = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(d);

let tc = { valor: null, en: 0 };
/** USD a MXN. Fuente publica sin llave, cache de 1 h y respaldo en TC_USD_MXN. */
export async function tipoDeCambio() {
  if (tc.valor && Date.now() - tc.en < 3600000) return tc.valor;
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) });
    const v = (await r.json())?.rates?.MXN;
    if (v > 0) return (tc = { valor: v, en: Date.now() }).valor;
  } catch { /* cae al respaldo */ }
  const respaldo = Number(process.env.TC_USD_MXN);
  if (respaldo > 0) return respaldo;
  throw new Error('Sin tipo de cambio: define TC_USD_MXN en .env');
}
