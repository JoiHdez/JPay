// Catalogo cerrado: cuentas, categorias y centros de costo. El agente solo puede elegir de aqui.
// ponytail: en codigo y no en BD; un archivo de seed cuando haya mas de una empresa.

export const CUENTAS = {
  1100: { nombre: 'Bancos', tipo: 'activo' },
  1300: { nombre: 'IVA acreditable / impuestos por recuperar', tipo: 'activo' },
  1500: { nombre: 'Equipo de computo', tipo: 'activo' },
  2100: { nombre: 'Tarjeta corporativa Reap por pagar', tipo: 'pasivo' },
  5100: { nombre: 'Gastos de oficina', tipo: 'gasto' },
  5200: { nombre: 'Software y suscripciones', tipo: 'gasto' },
  5300: { nombre: 'Marketing', tipo: 'gasto' },
  5400: { nombre: 'Fletes y envios', tipo: 'gasto' },
  5900: { nombre: 'Diferencias en precio', tipo: 'gasto' },
  8000: { nombre: 'Presupuesto disponible', tipo: 'orden', orden: true },
  8100: { nombre: 'Presupuesto comprometido', tipo: 'orden', orden: true },
  8900: { nombre: 'Presupuesto autorizado (contra)', tipo: 'orden', orden: true },
};

// Cuenta de cargo valida por categoria de compra.
export const CATEGORIAS = {
  oficina: { cuenta: 5100, etiqueta: 'Oficina y limpieza' },
  software: { cuenta: 5200, etiqueta: 'Software y suscripciones' },
  marketing: { cuenta: 5300, etiqueta: 'Marketing' },
  computo: { cuenta: 1500, etiqueta: 'Equipo de computo' },
};

// Presupuesto mensual por centro de costo, en USD (la moneda de la tarjeta de Reap).
export const CENTROS = {
  MKT: { nombre: 'Marketing', presupuesto: 300 },
  IT: { nombre: 'IT', presupuesto: 400 },
  OPS: { nombre: 'Operaciones', presupuesto: 250 },
};

// Cuentas que consumen presupuesto del centro de costo al devengarse.
export const CUENTAS_DE_CONSUMO = [1500, 5100, 5200, 5300, 5400, 5900];
