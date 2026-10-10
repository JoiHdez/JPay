// Zona de envio: antes de cotizar con una tienda, J-Pay revisa en la lista oficial de comercios
// (coleccion `comercios` en MongoDB, ver scripts/importar-comercios.mjs) que esa tienda este en la
// lista y que envie al pais de la direccion de la empresa. Reap pidio usar direcciones dentro de
// la zona de envio de cada comercio; asi no se gasta una cotizacion que el checkout va a rechazar.
import dns from 'node:dns/promises';
import { MongoClient } from 'mongodb';

const plano = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
// Dominio sin www. ni extension: "packagefreeshop.com" -> "packagefreeshop", "alchemist.com.sg" -> "alchemist".
const base = (dominio) => plano(String(dominio || '').replace(/^www\./, '').split('.')[0]);

/**
 * Comercio de la lista que corresponde al nombre que devuelve Reap.
 * ponytail: coincidencia por nombre contra dominio ("Package Free" ~ packagefreeshop.com,
 * "Plugable Technologies" ~ plugable.com); si Reap expone el dominio del comercio, usarlo.
 */
export function buscarComercio(lista, nombreReap) {
  const n = plano(nombreReap);
  if (n.length < 3) return null;
  let mejor = null;
  for (const c of lista || []) {
    const b = base(c.comercio);
    if (b.length < 3) continue;
    const coincide = b === n || b.includes(n) || n.includes(b);
    // Gana la coincidencia mas parecida en largo (evita que "go" pegue con todo).
    if (coincide && (!mejor || Math.abs(b.length - n.length) < Math.abs(base(mejor.comercio).length - n.length))) mejor = c;
  }
  return mejor;
}

/** { ok, motivo, comercio } para un comercio de Reap y el pais de la direccion de la empresa. */
export function revisarZona(lista, nombreReap, pais) {
  const c = buscarComercio(lista, nombreReap);
  const destino = String(pais || '').toUpperCase();
  if (!c) return { ok: false, motivo: `${nombreReap} no está en la lista de comercios compatibles`, comercio: null };
  const enviaA = (c.enviaA || []).map((x) => String(x).toUpperCase());
  if (!enviaA.includes(destino) && !enviaA.includes('*')) {
    return { ok: false, motivo: `${nombreReap} (${c.comercio}) no envía a ${destino}`, comercio: c.comercio };
  }
  return { ok: true, motivo: `${c.comercio} envía a ${destino}`, comercio: c.comercio };
}

// ── Lectura de la lista desde MongoDB ─────────────────────────────────────────────────────────
const VIGENCIA = 10 * 60000;
let cache = { lista: null, en: 0, aviso: false };

/**
 * Lista de comercios ({ comercio, enviaA }) desde MONGODB_URI, con cache de 10 minutos.
 * Sin MONGODB_URI o sin conexion devuelve null: la revision se omite (con un aviso en consola)
 * y la cotizacion sigue como antes, para no tumbar la demo por la base.
 */
export async function listaComercios() {
  if (cache.lista && Date.now() - cache.en < VIGENCIA) return cache.lista;
  const uri = process.env.MONGODB_URI;
  if (!uri) return avisar('falta MONGODB_URI');
  if (uri.startsWith('mongodb+srv://')) {
    // Algunas maquinas Windows no resuelven el SRV de Atlas con el resolvedor de Node.
    try { await dns.resolveSrv(`_mongodb._tcp.${new URL(uri).hostname}`); } catch { dns.setServers(['8.8.8.8', '1.1.1.1']); }
  }
  const cliente = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await cliente.connect();
    const lista = await cliente.db().collection('comercios').find({}, { projection: { _id: 0, comercio: 1, enviaA: 1 } }).toArray();
    if (!lista.length) return avisar('la coleccion comercios esta vacia (npm run importar:comercios)');
    cache = { lista, en: Date.now(), aviso: false };
    return lista;
  } catch (e) {
    return avisar(`sin conexion a MongoDB (${e.message})`);
  } finally {
    await cliente.close().catch(() => {});
  }
}

function avisar(motivo) {
  if (!cache.aviso) console.warn(`Zona de envio: se omite la revision, ${motivo}.`);
  cache.aviso = true;
  return null;
}
