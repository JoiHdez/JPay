// Carga en MongoDB (coleccion `tarjetas_prueba`) la tabla "Test cards" que Reap publica en la
// pagina Setup de su documentacion. Son tarjetas PUBLICAS de sandbox: solo funcionan con la API
// de Agentic Payments y se rechazan en cualquier otro lado. No se guardan aqui tarjetas asignadas
// en privado al equipo; esas se capturan solo en la pagina hosted de Reap.
//
//   npm run importar:tarjetas
import { pathToFileURL } from 'node:url';
import dns from 'node:dns/promises';
import { MongoClient } from 'mongodb';

const FUENTE = 'https://docs.reap.global/agentic-payments/setup';
const URI = process.env.MONGODB_URI;

/** Filas de la tabla "Test cards" del markdown de la pagina Setup. */
export function leerTabla(markdown) {
  const seccion = markdown.split(/^## Test cards\s*$/m)[1]?.split(/^## /m)[0] || '';
  const otp = markdown.match(/one-time password[^`]*`(\d{4,8})`/i)?.[1] || null;
  const filas = [];
  for (const linea of seccion.split('\n')) {
    const m = linea.match(/^\|\s*([\d ]{12,23})\s*\|\s*(\d{3,4})\s*\|\s*(\d{2})\/(\d{2})\s*\|/);
    if (!m) continue;
    const numero = m[1].replace(/\s/g, '');
    filas.push({
      ultimos4: numero.slice(-4),
      numero,
      cvc: m[2],
      vence: { mes: Number(m[3]), anio: 2000 + Number(m[4]) },
      red: numero.startsWith('4') ? 'Visa' : numero.startsWith('5') ? 'Mastercard' : 'Otra',
      otp,
    });
  }
  return filas;
}

// Mismo arreglo que importar-comercios: en algunas maquinas Windows el resolvedor de Node no
// resuelve el SRV de Atlas aunque el del sistema si.
async function asegurarDnsSrv(uri) {
  if (!uri.startsWith('mongodb+srv://')) return;
  try { await dns.resolveSrv(`_mongodb._tcp.${new URL(uri).hostname}`); } catch { dns.setServers(['8.8.8.8', '1.1.1.1']); }
}

async function main() {
  if (!URI) throw new Error('Define MONGODB_URI en .env.');
  const r = await fetch(`${FUENTE}.md`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`No se pudo leer la documentacion de Reap (${r.status}).`);
  const tarjetas = leerTabla(await r.text());
  if (!tarjetas.length) throw new Error('La pagina Setup ya no trae la tabla "Test cards"; revisa el formato.');

  await asegurarDnsSrv(URI);
  const cliente = new MongoClient(URI);
  try {
    await cliente.connect();
    const col = cliente.db().collection('tarjetas_prueba');
    const ahora = new Date();
    const res = await col.bulkWrite(tarjetas.map((t) => ({
      updateOne: {
        filter: { numero: t.numero },
        update: { $set: { ...t, uso: 'Solo sandbox de Reap Agentic Payments (pagina hosted de enrollment)', fuente: FUENTE, actualizado: ahora } },
        upsert: true,
      },
    })));
    await col.createIndex({ numero: 1 }, { unique: true });
    console.log(`Tarjetas de prueba: ${tarjetas.length} en la documentacion · ${res.upsertedCount} nuevas · ${res.modifiedCount} actualizadas · terminan en ${tarjetas.map((t) => t.ultimos4).join(', ')}`);
  } finally {
    await cliente.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
