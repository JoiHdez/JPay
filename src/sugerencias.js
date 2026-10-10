// Que toca reponer, a partir del historial de gastos de Ochavo. Es lo que separa al agente de
// un buscador: no espera a que le pidan, ve que algo se compra cada N dias y que ya pasaron.

const DIA = 86400000;
const normalizar = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * @param gastos [{ description, amount, expense_date }]
 * @param hoy    Date
 * Devuelve los conceptos comprados 2+ veces, con su intervalo promedio y si ya toca.
 */
export function sugerencias(gastos, hoy = new Date()) {
  const grupos = new Map();
  for (const g of gastos || []) {
    const clave = normalizar(g.description);
    if (!clave || !g.expense_date) continue;
    if (!grupos.has(clave)) grupos.set(clave, { concepto: g.description.trim(), fechas: [], montos: [] });
    const grupo = grupos.get(clave);
    grupo.fechas.push(new Date(String(g.expense_date).slice(0, 10) + 'T12:00:00Z').getTime());
    grupo.montos.push(Number(g.amount) || 0);
  }

  const lista = [];
  for (const { concepto, fechas, montos } of grupos.values()) {
    if (fechas.length < 2) continue;
    fechas.sort((a, b) => a - b);
    const intervalos = fechas.slice(1).map((f, i) => (f - fechas[i]) / DIA);
    const cadaDias = Math.round(intervalos.reduce((s, x) => s + x, 0) / intervalos.length);
    if (cadaDias < 1) continue;
    const desde = Math.floor((hoy.getTime() - fechas.at(-1)) / DIA);
    lista.push({
      concepto,
      veces: fechas.length,
      cadaDias,
      diasDesdeUltima: desde,
      montoPromedio: Math.round((montos.reduce((s, x) => s + x, 0) / montos.length) * 100) / 100,
      toca: desde >= cadaDias - 2, // dos dias de margen para que llegue a tiempo
    });
  }
  return lista.sort((a, b) => Number(b.toca) - Number(a.toca) || (b.diasDesdeUltima - b.cadaDias) - (a.diasDesdeUltima - a.cadaDias));
}
