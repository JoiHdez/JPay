// Politica de compras del solicitante: lo que el hackathon deja fuera de alcance (viajes y
// categorias restringidas por las redes de tarjetas) se rechaza antes de que nazca el intent,
// sin depender de que el catalogo de Reap lo filtre.
// ponytail: lista de palabras; un clasificador cuando el pedido entre en lenguaje natural.

const PROHIBIDAS = [
  ['viajes', 'Las reservas de viaje estan fuera de alcance.', [
    'vuelo', 'vuelos', 'boleto de avion', 'boletos de avion', 'aerolinea', 'hotel', 'hoteles', 'hospedaje', 'airbnb',
    'renta de auto', 'crucero', 'flight', 'flights', 'airline', 'airfare', 'travel', 'booking', 'car rental', 'cruise',
  ]],
  ['apuestas', 'Las apuestas son una categoria restringida.', [
    'apuesta', 'apuestas', 'casino', 'loteria', 'poker', 'gambling', 'betting', 'lottery', 'sportsbook',
  ]],
  ['adultos', 'El contenido para adultos es una categoria restringida.', [
    'xxx', 'porn', 'porno', 'adult toy', 'sex toy', 'juguete sexual', 'escort',
  ]],
  ['armas', 'Las armas y municiones son una categoria restringida.', [
    'arma de fuego', 'armas de fuego', 'municion', 'municiones', 'firearm', 'firearms', 'ammo', 'ammunition',
  ]],
];

const normalizar = (s) => ` ${String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** null si el pedido se permite; si no, { categoria, mensaje } con el motivo. */
export function restriccion(texto) {
  const t = normalizar(texto);
  for (const [categoria, mensaje, palabras] of PROHIBIDAS) {
    if (palabras.some((p) => t.includes(` ${p} `))) return { categoria, mensaje };
  }
  return null;
}
