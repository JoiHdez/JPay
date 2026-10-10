// Conciliación sin I/O. Montos en centavos; los datos de pago siguen el contrato de J-Pay.
import { CUENTAS } from './catalogo.js';
import { validar } from './ledger.js';

const CFDI = 'http://www.sat.gob.mx/cfd/4';
const TFD = 'http://www.sat.gob.mx/TimbreFiscalDigital';
const XML = 'http://www.w3.org/XML/1998/namespace';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const DIA = 86400000;
const ZONA = 'America/Mexico_City';

const caracterXML = (c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 0xD7FF)
  || (c >= 0xE000 && c <= 0xFFFD) || (c >= 0x10000 && c <= 0x10FFFF);

function entidades(texto) {
  const simples = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' };
  return texto.replace(/&([^;&<\s]+);|&/g, (_, entidad) => {
    if (Object.hasOwn(simples, entidad)) return simples[entidad];
    if (!entidad || !/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entidad)) throw new Error('Entidad XML inválida o no soportada');
    const codigo = entidad.startsWith('#x') ? Number.parseInt(entidad.slice(2), 16) : Number(entidad.slice(1));
    if (!caracterXML(codigo)) throw new Error('Referencia a carácter XML inválido');
    return String.fromCodePoint(codigo);
  });
}

/** Tokenizador de XML con pila y namespaces por ámbito; no carga DTD ni recursos externos. */
function analizarXML(entrada) {
  if (typeof entrada !== 'string' || entrada.length > 2 * 1024 * 1024) throw new Error('Se requiere XML de hasta 2 Mi caracteres');
  const xml = entrada.replace(/^\uFEFF/, '');
  for (const c of xml) if (!caracterXML(c.codePointAt(0))) throw new Error('Carácter XML inválido');
  const nombre = /[\p{L}_][\p{L}\p{N}\p{M}_.\-\u00B7]*(?::[\p{L}_][\p{L}\p{N}\p{M}_.\-\u00B7]*)?/uy;
  const pila = [];
  let raiz = null;
  let i = 0;
  const espacios = () => { while (i < xml.length && /[ \t\r\n]/.test(xml[i])) i++; };
  const leerNombre = () => {
    nombre.lastIndex = i;
    const encontrado = nombre.exec(xml);
    if (!encontrado) throw new Error('Nombre de elemento o atributo XML inválido');
    i = nombre.lastIndex;
    return encontrado[0];
  };
  const buscarFin = (marca, inicio) => {
    const fin = xml.indexOf(marca, inicio);
    if (fin < 0) throw new Error('XML truncado');
    return fin;
  };
  while (i < xml.length) {
    if (xml[i] !== '<') {
      const fin = xml.indexOf('<', i);
      const texto = xml.slice(i, fin < 0 ? xml.length : fin);
      if (texto.includes(']]>')) throw new Error('Cierre CDATA fuera de sección');
      entidades(texto);
      if (!pila.length && texto.trim()) throw new Error('Texto fuera del elemento raíz');
      i = fin < 0 ? xml.length : fin;
      continue;
    }
    if (xml.startsWith('<!--', i)) {
      const fin = buscarFin('-->', i + 4);
      if (xml.slice(i + 4, fin).includes('--') || xml[fin - 1] === '-') throw new Error('Comentario XML inválido');
      i = fin + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      if (!pila.length) throw new Error('CDATA fuera del elemento raíz');
      i = buscarFin(']]>', i + 9) + 3;
      continue;
    }
    if (xml.startsWith('<?', i)) {
      const inicio = i;
      i += 2;
      const destino = leerNombre();
      if (destino.toLowerCase() === 'xml' && (destino !== 'xml' || inicio !== 0)) throw new Error('Declaración XML fuera del inicio');
      if (!/[ \t\r\n?]/.test(xml[i] || '')) throw new Error('Instrucción XML inválida');
      const fin = buscarFin('?>', i);
      if (destino === 'xml' && !/^[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(["'])1\.0\1(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(["'])[A-Za-z][A-Za-z0-9._-]*\2)?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(["'])(?:yes|no)\3)?[ \t\r\n]*$/.test(xml.slice(i, fin))) {
        throw new Error('Declaración XML 1.0 inválida');
      }
      i = fin + 2;
      continue;
    }
    if (xml.startsWith('<!', i)) throw new Error('DTD y declaraciones de entidades no soportadas');
    if (xml.startsWith('</', i)) {
      i += 2;
      const cierre = leerNombre();
      espacios();
      if (xml[i++] !== '>' || pila.pop()?.nombre !== cierre) throw new Error('Etiquetas XML desbalanceadas');
      continue;
    }
    i++;
    const etiqueta = leerNombre();
    const atributos = Object.create(null);
    let autocierre = false;
    while (true) {
      const antes = i;
      espacios();
      if (xml[i] === '>') { i++; break; }
      if (xml.startsWith('/>', i)) { i += 2; autocierre = true; break; }
      if (i === antes) throw new Error('Falta separación entre atributos XML');
      const clave = leerNombre();
      if (Object.hasOwn(atributos, clave)) throw new Error(`Atributo XML duplicado: ${clave}`);
      espacios();
      if (xml[i++] !== '=') throw new Error('Atributo XML sin valor');
      espacios();
      const comilla = xml[i++];
      if (comilla !== '"' && comilla !== "'") throw new Error('Atributo XML sin comillas');
      const fin = buscarFin(comilla, i);
      const valor = xml.slice(i, fin);
      if (valor.includes('<')) throw new Error('Carácter < sin escapar en atributo XML');
      atributos[clave] = entidades(valor.replace(/\r\n?|\n|\t/g, ' '));
      i = fin + 1;
    }
    const namespaces = new Map(pila.at(-1)?.namespaces || [['xml', XML]]);
    for (const [clave, valor] of Object.entries(atributos)) {
      if (clave !== 'xmlns' && !clave.startsWith('xmlns:')) continue;
      const prefijo = clave === 'xmlns' ? '' : clave.slice(6);
      if (prefijo === 'xmlns' || valor === XMLNS || (prefijo === 'xml' && valor !== XML)
        || (valor === XML && prefijo !== 'xml') || (prefijo && !valor)) throw new Error('Namespace XML reservado o vacío');
      namespaces.set(prefijo, valor);
    }
    const expandir = (clave, atributo = false) => {
      const partes = clave.split(':');
      if (partes.length === 1) return [atributo ? '' : namespaces.get('') || '', partes[0]];
      const uri = namespaces.get(partes[0]);
      if (!uri) throw new Error(`Prefijo XML no declarado: ${partes[0]}`);
      return [uri, partes[1]];
    };
    const expandidos = new Set();
    for (const clave of Object.keys(atributos)) {
      if (clave === 'xmlns' || clave.startsWith('xmlns:')) continue;
      const expandido = JSON.stringify(expandir(clave, true));
      if (expandidos.has(expandido)) throw new Error('Atributos XML duplicados por namespace');
      expandidos.add(expandido);
    }
    const [uri, local] = expandir(etiqueta);
    if (uri === XMLNS) throw new Error('Namespace xmlns no válido para elementos');
    const nodo = { nombre: etiqueta, uri, local, atributos, namespaces, hijos: [] };
    if (pila.length) pila.at(-1).hijos.push(nodo);
    else {
      if (raiz) throw new Error('XML con más de un elemento raíz');
      raiz = nodo;
    }
    if (!autocierre) pila.push(nodo);
  }
  if (!raiz || pila.length) throw new Error('XML vacío o truncado');
  return raiz;
}

const hijos = (nodo, local, uri = CFDI) => nodo.hijos.filter((h) => h.local === local && h.uri === uri);
function unico(nodo, local, uri = CFDI, obligatorio = true) {
  const encontrados = hijos(nodo, local, uri);
  if (encontrados.length > 1 || (obligatorio && encontrados.length !== 1)) throw new Error(`Se requiere un único ${local}`);
  return encontrados[0] || null;
}
function atributo(nodo, clave) {
  const valor = nodo.atributos[clave]?.trim();
  if (!valor) throw new Error(`Falta el atributo ${clave} en ${nodo.local}`);
  return valor;
}

// CFDI admite importes con hasta seis decimales. Se suman antes de redondear a centavos.
function millonésimas(valor) {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(valor);
  if (!m) throw new Error('Importe CFDI inválido');
  return BigInt(m[1]) * 1000000n + BigInt((m[2] || '').padEnd(6, '0'));
}
function aCentavos(valor) {
  const resultado = (valor + 5000n) / 10000n;
  if (resultado > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Importe fuera del rango de centavos seguros');
  return Number(resultado);
}
const montoValido = (valor) => Number.isSafeInteger(valor) && valor >= 0;

function diaCalendario(fecha) {
  if (typeof fecha !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?)?$/.exec(fecha);
  if (!m) return null;
  const [año, mes, dia, hora, minuto, segundo] = m.slice(1, 7).map((n) => Number(n || 0));
  if (año < 1 || mes < 1 || mes > 12 || dia < 1 || hora > 23 || minuto > 59 || segundo > 59) return null;
  const civil = new Date(0);
  civil.setUTCFullYear(año, mes - 1, dia);
  civil.setUTCHours(hora, minuto, segundo, Number((m[7] || '').padEnd(3, '0').slice(0, 3)));
  if (civil.getUTCFullYear() !== año || civil.getUTCMonth() !== mes - 1 || civil.getUTCDate() !== dia) return null;
  if (!m[8]) return Math.floor(civil.getTime() / DIA); // Fecha fiscal sin zona: calendario local.
  let offset = 0;
  if (m[8] !== 'Z') {
    const h = Number(m[8].slice(1, 3));
    const min = Number(m[8].slice(4));
    if (h > 23 || min > 59) return null;
    offset = (h * 60 + min) * (m[8][0] === '+' ? 1 : -1);
  }
  const partes = new Intl.DateTimeFormat('en', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(civil.getTime() - offset * 60000));
  const obtener = (tipo) => Number(partes.find((p) => p.type === tipo).value);
  const local = new Date(0);
  local.setUTCFullYear(obtener('year'), obtener('month') - 1, obtener('day'));
  local.setUTCHours(0, 0, 0, 0);
  return Math.floor(local.getTime() / DIA);
}

/**
 * Lee los atributos fiscales de un CFDI 4.0 timbrado. Montos en centavos; folio/serie son
 * opcionales. No extrae orderId de UUID/folio ni valida XSD, sellos o vigencia ante el SAT.
 */
export function leerCFDI(xml) {
  const comprobante = analizarXML(xml);
  if (comprobante.uri !== CFDI || comprobante.local !== 'Comprobante' || atributo(comprobante, 'Version') !== '4.0') {
    throw new Error('Se requiere un Comprobante CFDI 4.0');
  }
  const emisor = unico(comprobante, 'Emisor');
  const timbre = unico(unico(comprobante, 'Complemento'), 'TimbreFiscalDigital', TFD);
  const uuid = atributo(timbre, 'UUID').toUpperCase();
  if (!/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(uuid)) throw new Error('UUID fiscal inválido');
  const fecha = atributo(comprobante, 'Fecha');
  if (!fecha.includes('T') || diaCalendario(fecha) === null) throw new Error('Fecha CFDI inválida');
  const moneda = atributo(comprobante, 'Moneda').toUpperCase();
  if (!/^[A-Z]{3}$/.test(moneda)) throw new Error('Moneda CFDI inválida');
  let iva = 0n;
  const impuestos = unico(comprobante, 'Impuestos', CFDI, false);
  const traslados = impuestos && unico(impuestos, 'Traslados', CFDI, false);
  for (const traslado of traslados ? hijos(traslados, 'Traslado') : []) {
    if (atributo(traslado, 'Impuesto') !== '002' || traslado.atributos.TipoFactor === 'Exento') continue;
    iva += millonésimas(atributo(traslado, 'Importe'));
  }
  return {
    uuid, serie: comprobante.atributos.Serie ?? null, folio: comprobante.atributos.Folio ?? null,
    rfcEmisor: atributo(emisor, 'Rfc').toUpperCase(), comercio: atributo(emisor, 'Nombre'), fecha,
    subtotal: aCentavos(millonésimas(atributo(comprobante, 'SubTotal'))), iva: aCentavos(iva),
    total: aCentavos(millonésimas(atributo(comprobante, 'Total'))), moneda,
  };
}

const normalizar = (valor) => typeof valor === 'string'
  ? valor.normalize('NFD').replace(/\p{M}/gu, '').trim().replace(/\s+/g, ' ').toUpperCase() : '';
const codigo = (valor) => typeof valor === 'string' ? valor.trim().toUpperCase() : '';
const resultado = (estado, intentId = null, diferencias = []) => ({ estado, intentId, diferencias });

function diferenciasPago(factura, intent) {
  const diferencias = [];
  if (intent.estado !== 'PAGADA') diferencias.push('estado: el intent no tiene un pago completado');
  if (!montoValido(intent.checkout?.finalAmount)) diferencias.push('total: falta el monto cobrado por Reap en centavos');
  else if (Math.abs(factura.total - intent.checkout.finalAmount) > 1) diferencias.push(`total: factura ${factura.total}, cobrado por Reap ${intent.checkout.finalAmount} centavos`);
  const moneda = codigo(intent.cotizacion?.moneda);
  if (!moneda || codigo(factura.moneda) !== moneda) diferencias.push('moneda: la factura y el pago deben usar la misma moneda; no se aplica conversión');
  return diferencias;
}

/**
 * Prioriza orderId explícito. Sin él exige monto cobrado ±1 centavo, moneda, comercio y
 * fecha de pago ±3 días calendario en CDMX. fechaPago/paisComercio son enriquecimientos
 * internos verificados por el backend, autorizados para este módulo; no campos de /api/estado.
 * Un match ambiguo devuelve SIN_MATCH. Nunca utiliza el cotizado ni la fecha de creación.
 */
export function conciliar(factura, intents) {
  if (!factura || !montoValido(factura.total) || !/^[A-Z]{3}$/.test(codigo(factura.moneda))) throw new Error('Factura sin total en centavos o moneda válida');
  if (!Array.isArray(intents)) throw new Error('Se requiere una lista de intents');
  const orderId = typeof factura.orderId === 'string' ? factura.orderId.trim() : '';
  if (factura.orderId != null && !orderId) throw new Error('orderId debe ser un texto no vacío');
  const diaFactura = diaCalendario(factura.fecha);
  const comercio = normalizar(factura.comercio);
  if (orderId) {
    const encontrados = intents.filter((i) => i.checkout?.orderId === orderId);
    if (!encontrados.length) return resultado('SIN_MATCH', null, ['orderId: no existe un pago con esa orden']);
    if (encontrados.length > 1) return resultado('SIN_MATCH', null, ['match ambiguo: varias compras tienen la misma orden']);
    const intent = encontrados[0];
    const diferencias = diferenciasPago(factura, intent);
    if (comercio && normalizar(intent.producto?.comercio) && comercio !== normalizar(intent.producto.comercio)) diferencias.push('comercio: la factura no corresponde al comercio del pago');
    const diaPago = diaCalendario(intent.fechaPago);
    if (diaFactura !== null && diaPago !== null && Math.abs(diaFactura - diaPago) > 3) diferencias.push('fecha: factura y pago separados por más de 3 días');
    return resultado(diferencias.length ? 'DIFERENCIA' : 'CONCILIADA', intent.id, diferencias);
  }
  if (!comercio || diaFactura === null) return resultado('SIN_MATCH', null, ['comercio/fecha: faltan datos válidos para buscar sin orderId']);
  const candidatos = intents.filter((intent) => diferenciasPago(factura, intent).length === 0
    && normalizar(intent.producto?.comercio) === comercio
    && diaCalendario(intent.fechaPago) !== null && Math.abs(diaFactura - diaCalendario(intent.fechaPago)) <= 3);
  if (!candidatos.length) return resultado('SIN_MATCH', null, ['No hay coincidencia de monto, moneda, comercio y fecha de pago']);
  if (candidatos.length > 1) return resultado('SIN_MATCH', null, ['match ambiguo: varias compras cumplen los criterios']);
  return resultado('CONCILIADA', candidatos[0].id);
}

/**
 * Reclasifica únicamente IVA pendiente de un comercio MX verificado. La contrapartida es
 * la cuenta principal de gasto del pre-asiento; no modifica tarjeta, fletes ni diferencias.
 * IVA ya reconocido no se duplica; una reducción de IVA genera el ajuste inverso.
 * ID estable por UUID/intent: al publicar, el backend debe deduplicar y guardar ese vínculo.
 */
export function asientoFactura(factura, intent) {
  if (codigo(intent?.paisComercio) !== 'MX') return null;
  if (!factura || !montoValido(factura.total) || !montoValido(factura.iva)) throw new Error('Factura sin importes válidos en centavos');
  if (conciliar(factura, [intent]).estado !== 'CONCILIADA') throw new Error('La factura no coincide con el pago: total, moneda, estado, comercio, fecha u orden');
  if (!Array.isArray(intent.preAsiento)) throw new Error('Falta el pre-asiento para identificar el gasto y el IVA registrado');
  let reconocido = 0;
  const gastos = new Map();
  for (const l of intent.preAsiento) {
    const debe = l.debe ?? 0;
    const haber = l.haber ?? 0;
    if (!montoValido(debe) || !montoValido(haber)) throw new Error('Pre-asiento con importes inválidos');
    const cuenta = Number(l.cuenta);
    if (cuenta === 1300) reconocido += debe - haber;
    if (CUENTAS[cuenta]?.tipo === 'gasto' && ![5400, 5900].includes(cuenta)) gastos.set(cuenta, (gastos.get(cuenta) || 0) + debe - haber);
  }
  if (!Number.isSafeInteger(reconocido) || reconocido < 0) throw new Error('IVA registrado inválido');
  const pendiente = factura.iva - reconocido;
  if (!pendiente) return null;
  if (gastos.size !== 1) throw new Error('Se requiere una única cuenta principal de gasto para reclasificar IVA');
  const [cuenta, saldo] = gastos.entries().next().value;
  if (pendiente > 0 && pendiente > saldo) throw new Error('El IVA pendiente excede el gasto registrado');
  if (typeof factura.uuid !== 'string' || !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(factura.uuid)
    || typeof intent.id !== 'string' || !intent.id || !intent.centroCosto) throw new Error('Falta UUID, intent o centro de costo para reclasificar IVA');
  const monto = Math.abs(pendiente);
  return validar({
    id: `FACTURA-${factura.uuid.toUpperCase()}-${intent.id}`, tipo: 'RECLASIFICACION_IVA',
    lineas: pendiente > 0
      ? [{ cuenta: 1300, cc: intent.centroCosto, debe: monto }, { cuenta, cc: intent.centroCosto, haber: monto }]
      : [{ cuenta, cc: intent.centroCosto, debe: monto }, { cuenta: 1300, cc: intent.centroCosto, haber: monto }],
  });
}
