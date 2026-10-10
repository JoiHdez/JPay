// Carga la lista oficial de comercios compatibles (hoja de Google del hackathon) en MongoDB,
// coleccion `comercios`. Se puede correr las veces que sea: actualiza por comercio (upsert).
//
//   MONGODB_URI=mongodb://localhost:27017/jpay npm run importar:comercios
//
// La base sale de la URI (por defecto `jpay`). La hoja se lee como CSV publico.
import { pathToFileURL } from 'node:url';
import { MongoClient } from 'mongodb';

const HOJA = process.env.COMERCIOS_CSV_URL
  || 'https://docs.google.com/spreadsheets/d/1pqb1Jlx1sycembPcjMZ4dxhwzVWXfK7k8RtfNMhb_cs/export?format=csv&gid=0';
const URI = process.env.MONGODB_URI;

/** CSV (RFC 4180): comas dentro de comillas y comillas escapadas como "". */
export function parseCsv(texto) {
  const filas = [];
  let fila = [];
  let campo = '';
  let comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo); campo = '';
      if (fila.some((x) => x !== '')) filas.push(fila);
      fila = [];
    } else campo += c;
  }
  fila.push(campo);
  if (fila.some((x) => x !== '')) filas.push(fila);
  return filas;
}

/** Fila de la hoja -> documento de Mongo. `enviaA` incluye '*' cuando la tienda envia a todo el mundo. */
export function aDocumento(r) {
  return {
    comercio: r['Merchant door'].trim().toLowerCase(),
    categoria: r.Category.trim(),
    mercado: r.Market.trim(),
    enviaA: r['Ships to'].split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
    productoPrueba: r['Test product'].trim(),
    variantId: r['Variant ID'].trim(),
    precio: Number(r['Item price']),
    moneda: r.Currency.trim(),
    carritoUrl: r['Cart permalink'].trim(),
  };
}

async function main() {
  if (!URI) throw new Error('Define MONGODB_URI (por ejemplo mongodb://localhost:27017/jpay).');
  const r = await fetch(HOJA, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`No se pudo leer la hoja (${r.status}).`);
  const [encabezado, ...filas] = parseCsv(await r.text());
  const docs = filas.map((f) => aDocumento(Object.fromEntries(encabezado.map((h, i) => [h.trim(), f[i] ?? '']))))
    .filter((d) => d.comercio);

  const cliente = new MongoClient(URI);
  try {
    await cliente.connect();
    const col = cliente.db().collection('comercios');
    const ahora = new Date();
    const res = await col.bulkWrite(docs.map((d) => ({
      updateOne: { filter: { comercio: d.comercio }, update: { $set: { ...d, actualizado: ahora } }, upsert: true },
    })));
    await col.createIndex({ comercio: 1 }, { unique: true });
    await col.createIndex({ enviaA: 1 });
    await col.createIndex({ mercado: 1, categoria: 1 });
    console.log(`Comercios: ${docs.length} en la hoja · ${res.upsertedCount} nuevos · ${res.modifiedCount} actualizados · base "${cliente.db().databaseName}"`);
  } finally {
    await cliente.close();
  }
}

// Solo corre al ejecutarlo directo; las pruebas lo importan sin conectarse a nada.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
