// La guarda que decide si una compra puede ir al checkout. Es la unica regla de dinero del
// agente y vive en el servidor: el LLM y el navegador solo proponen.

/** Presupuesto activo de la categoria, con lo que queda (Ochavo lo calcula en `remaining`). */
export function presupuestoDe(presupuestos, categoria) {
  const cat = categoria.trim().toLowerCase();
  return (presupuestos || []).find(
    (b) => b.budget_type === 'category' && (b.category || '').trim().toLowerCase() === cat,
  ) || null;
}

/**
 * Decide con el total ya convertido a MXN. Sin presupuesto en la categoria no se compra:
 * el agente no inventa un limite que la persona no puso.
 */
export function evaluar({ totalMxn, presupuesto }) {
  if (!presupuesto) {
    return { permitido: false, motivo: 'sin_presupuesto', restante: null };
  }
  const restante = Number(presupuesto.remaining ?? presupuesto.amount - (presupuesto.spent || 0));
  const total = Math.round(totalMxn * 100) / 100;
  if (!(total > 0)) return { permitido: false, motivo: 'monto_invalido', restante };
  if (total > restante) return { permitido: false, motivo: 'excede', restante, faltante: Math.round((total - restante) * 100) / 100 };
  return { permitido: true, motivo: 'cabe', restante, despues: Math.round((restante - total) * 100) / 100 };
}
