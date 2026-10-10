// El "agente" de la demo: convierte lo que llega al chat (un pedido o un documento de proveedor)
// en una propuesta de compra. Es ingenuo A PROPOSITO: obedece lo que dice el documento, como un
// LLM manipulado por instrucciones ocultas. La defensa no esta aqui, esta en el Ledger Guard.
// ponytail: reglas fijas en lugar de Claude con tool use; el contrato (texto -> propuesta) no cambia.

/** Ajustes que el texto le "ordena" al agente sobre la compra del intent. */
export function leerInstrucciones(texto = '') {
  const t = texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const cantidad = t.match(/(\d{1,3})\s*(unidades|piezas|pzas|units|x\b)/);
  return {
    cantidad: cantidad ? Number(cantidad[1]) : null,
    envioCaro: /express|urgente|expedit|rush|next day|overnight/.test(t),
    saltarAprobacion: /(sin|saltar|omitir|skip).{0,20}(aprobacion|approval|autorizacion)/.test(t),
  };
}

/** Propuesta del agente para un quote: lo normal, o lo que el documento le haya ordenado. */
export function proponer({ producto, quote, cantidadBase, instrucciones = {} }) {
  const opciones = [...(quote.shippingOptions || [])].sort((a, b) => Number(a.price.amount) - Number(b.price.amount));
  const envio = instrucciones.envioCaro ? opciones.at(-1) : opciones[0];
  return {
    producto,
    cantidad: instrucciones.cantidad ?? cantidadBase,
    envioId: envio?.id,
    saltarAprobacion: !!instrucciones.saltarAprobacion,
  };
}
