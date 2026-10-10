import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { leerCFDI, conciliar, asientoFactura } from '../src/conciliacion.js';
import { validar } from '../src/ledger.js';

const fixture = (nombre) => readFileSync(new URL(`./fixtures/${nombre}.xml`, import.meta.url), 'utf8');
const xmlValido = fixture('cfdi-valido');
const facturaValida = () => leerCFDI(xmlValido);
const intentPagado = (cambios = {}) => ({
  id: 'intent-1',
  estado: 'PAGADA',
  centroCosto: 'OPS',
  producto: { comercio: 'Papelería J-Pay & Asociados' },
  cotizacion: { moneda: 'MXN', desglose: { total: 12000 } },
  checkout: { orderId: 'order-1', finalAmount: 11600 },
  fechaPago: '2026-10-09T12:00:00-06:00',
  paisComercio: 'MX',
  preAsiento: [{ cuenta: 5100, debe: 11600, haber: 0 }, { cuenta: 2100, debe: 0, haber: 11600 }],
  ...cambios,
});
const sinMatch = (resultado) => {
  assert.equal(resultado.estado, 'SIN_MATCH');
  assert.equal(resultado.intentId, null);
  assert.ok(Array.isArray(resultado.diferencias));
};

test('lee el CFDI 4.0, decodifica el comercio y entrega los importes en centavos', () => {
  assert.deepEqual(facturaValida(), {
    uuid: 'D4BB25A0-CC70-4A10-8AE7-AB1234560001',
    serie: 'JP',
    folio: '1001',
    rfcEmisor: 'JPA010101AA1',
    comercio: 'Papelería J-Pay & Asociados',
    fecha: '2026-10-09T10:30:00',
    subtotal: 10000,
    iva: 1600,
    total: 11600,
    moneda: 'MXN',
  });
});

test('resuelve los namespaces por URI con prefijos alternos y con namespace CFDI por defecto', () => {
  const alternos = xmlValido.replaceAll('cfdi:', 'c:').replaceAll('xmlns:cfdi=', 'xmlns:c=')
    .replaceAll('tfd:', 't:').replaceAll('xmlns:tfd=', 'xmlns:t=');
  const porDefecto = xmlValido.replaceAll('cfdi:', '').replace('xmlns:cfdi=', 'xmlns=');
  assert.deepEqual(leerCFDI(alternos), facturaValida());
  assert.deepEqual(leerCFDI(porDefecto), facturaValida());
});

test('lee atributos con comillas simples, orden distinto y entidades XML numéricas', () => {
  const xml = xmlValido
    .replace('Rfc="JPA010101AA1" Nombre="Papelería J-Pay &amp; Asociados"',
      "Nombre='Papeler&#237;a J-Pay &#x26; Asociados' Rfc='JPA010101AA1'")
    .replace('Serie="JP" Folio="1001"', "Folio = '1001' Serie = 'JP'");
  assert.deepEqual(leerCFDI(xml), facturaValida());
});

test('los elementos dentro de comentarios y CDATA no sustituyen los atributos fiscales', () => {
  const señuelo = '<cfdi:Emisor Rfc="AAA010101AAA" Nombre="Otro comercio"/>';
  const xml = xmlValido.replace('<cfdi:Complemento>', `<!-- ${señuelo} --><![CDATA[${señuelo}]]><cfdi:Complemento>`);
  assert.deepEqual(leerCFDI(xml), facturaValida());
});

test('suma solo el IVA agregado: evita contar dos veces conceptos y excluye IEPS', () => {
  const xml = xmlValido
    .replace('Total="116.00"', 'Total="118.00"')
    .replace('TotalImpuestosTrasladados="16.00"', 'TotalImpuestosTrasladados="18.00"')
    .replace('  <cfdi:Impuestos TotalImpuestosTrasladados="18.00">\n    <cfdi:Traslados>',
      '  <cfdi:Impuestos TotalImpuestosTrasladados="18.00">\n    <cfdi:Traslados>\n      <cfdi:Traslado Base="100.00" Impuesto="003" TipoFactor="Tasa" TasaOCuota="0.020000" Importe="2.00"/>');
  assert.equal(leerCFDI(xml).iva, 1600);
  assert.equal(leerCFDI(xml).total, 11800);
});

test('suma los traslados de IVA antes de redondear los seis decimales admitidos a centavos', () => {
  const xml = xmlValido
    .replace('Total="116.00"', 'Total="116.008"')
    .replace('  <cfdi:Impuestos TotalImpuestosTrasladados="16.00">\n    <cfdi:Traslados>\n      <cfdi:Traslado Base="100.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="16.00"/>',
      '  <cfdi:Impuestos TotalImpuestosTrasladados="16.008">\n    <cfdi:Traslados>\n      <cfdi:Traslado Base="100.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="16.004"/>\n      <cfdi:Traslado Base="0.025" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="0.004"/>');
  const factura = leerCFDI(xml);
  assert.equal(factura.iva, 1601);
  assert.equal(factura.total, 11601);
});

test('rechaza XML truncado, atributos duplicados, DTD y namespaces fiscales falsos', () => {
  const casos = [
    xmlValido.replace('</cfdi:Comprobante>', ''),
    xmlValido.replace('Moneda="MXN"', 'Moneda="MXN" Moneda="USD"'),
    xmlValido.replace('<?xml version="1.0" encoding="UTF-8"?>',
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE cfdi:Comprobante [<!ENTITY comercio "Otro">]>'),
    xmlValido.replace('http://www.sat.gob.mx/cfd/4', 'https://ejemplo.invalid/cfd/4'),
    xmlValido.replace('http://www.sat.gob.mx/TimbreFiscalDigital', 'https://ejemplo.invalid/timbre'),
    ...['<?xml?>', '<?xml invalid?>', '<?xml version="9.9"?>'].map((declaracion) =>
      xmlValido.replace('<?xml version="1.0" encoding="UTF-8"?>', declaracion)),
  ];
  for (const xml of casos) assert.throws(() => leerCFDI(xml));
});

test('rechaza datos obligatorios ausentes e importes fuera del formato CFDI', () => {
  for (const valor of ['-1.00', '1e2', '116,00', '116.0000001', 'NaN']) {
    assert.throws(() => leerCFDI(xmlValido.replace('Total="116.00"', `Total="${valor}"`)));
  }
  for (const atributo of ['Moneda="MXN"', 'UUID="D4BB25A0-CC70-4A10-8AE7-AB1234560001"', 'Rfc="JPA010101AA1"']) {
    assert.throws(() => leerCFDI(xmlValido.replace(atributo, '')));
  }
  assert.throws(() => leerCFDI(xmlValido.replace('2026-10-09T10:30:00', '2026-02-30T10:30:00')));
});

test('concilia el fixture por monto cobrado, comercio y fecha, sin usar el total cotizado', () => {
  const intent = intentPagado();
  assert.deepEqual(conciliar(facturaValida(), [intent]), {
    estado: 'CONCILIADA', intentId: 'intent-1', diferencias: [],
  });
  sinMatch(conciliar(facturaValida(), [intentPagado({ checkout: { orderId: 'order-1', finalAmount: 12000 } })]));
});

test('los fixtures con total distinto y sin coincidencia no empatan por aproximación', () => {
  sinMatch(conciliar(leerCFDI(fixture('cfdi-total-distinto')), [intentPagado()]));
  sinMatch(conciliar(leerCFDI(fixture('cfdi-sin-match')), [intentPagado()]));
});

test('orderId tiene prioridad y devuelve las diferencias del cobro identificado', () => {
  const factura = { ...leerCFDI(fixture('cfdi-total-distinto')), orderId: 'order-1' };
  const resultado = conciliar(factura, [
    intentPagado({ id: 'aproximado', checkout: { orderId: 'otra-orden', finalAmount: 13920 } }),
    intentPagado(),
  ]);
  assert.equal(resultado.estado, 'DIFERENCIA');
  assert.equal(resultado.intentId, 'intent-1');
  assert.ok(resultado.diferencias.some((d) => /total|monto/i.test(d)));
});

test('un orderId desconocido nunca cae a una coincidencia por monto', () => {
  sinMatch(conciliar({ ...facturaValida(), orderId: 'order-desconocido' }, [intentPagado()]));
});

test('con orderId informa moneda, estado, comercio y fecha distintos', () => {
  const resultado = conciliar({ ...facturaValida(), orderId: 'order-1' }, [intentPagado({
    estado: 'EN_PAGO',
    cotizacion: { moneda: 'USD' },
    producto: { comercio: 'Otro comercio' },
    fechaPago: '2026-10-20T10:00:00-06:00',
  })]);
  assert.equal(resultado.estado, 'DIFERENCIA');
  assert.equal(resultado.intentId, 'intent-1');
  for (const dato of [/moneda/i, /estado|pagad/i, /comercio/i, /fecha/i]) {
    assert.ok(resultado.diferencias.some((d) => dato.test(d)));
  }
});

test('sin orderId acepta un centavo de diferencia, pero dos centavos no empatan', () => {
  for (const delta of [-1, 0, 1]) {
    assert.equal(conciliar({ ...facturaValida(), total: 11600 + delta }, [intentPagado()]).estado, 'CONCILIADA');
  }
  for (const delta of [-2, 2]) sinMatch(conciliar({ ...facturaValida(), total: 11600 + delta }, [intentPagado()]));
});

test('normaliza mayúsculas, acentos y espacios en el comercio', () => {
  assert.equal(conciliar(facturaValida(), [intentPagado({
    producto: { comercio: '  PAPELERIA   j-pay &   ASOCIADOS  ' },
  })]).estado, 'CONCILIADA');
});

test('usa días calendario de México: acepta hasta tres días y rechaza cuatro', () => {
  for (const fechaPago of ['2026-10-06', '2026-10-12T23:59:59-06:00', '2026-10-13T04:30:00Z']) {
    assert.equal(conciliar(facturaValida(), [intentPagado({ fechaPago })]).estado, 'CONCILIADA');
  }
  for (const fechaPago of ['2026-10-05', '2026-10-13T00:00:00-06:00']) {
    sinMatch(conciliar(facturaValida(), [intentPagado({ fechaPago })]));
  }
});

test('la aproximación exige pago, moneda y fecha verificables', () => {
  for (const cambios of [
    { estado: 'EN_PAGO' },
    { cotizacion: { moneda: 'USD' } },
    { cotizacion: null },
    { fechaPago: undefined },
    { fechaPago: '2026-02-30' },
    { producto: { comercio: '' } },
  ]) sinMatch(conciliar(facturaValida(), [intentPagado(cambios)]));
});

test('dos candidatos compatibles requieren resolución explícita', () => {
  const resultado = conciliar(facturaValida(), [intentPagado(), intentPagado({ id: 'intent-2' })]);
  sinMatch(resultado);
  assert.ok(resultado.diferencias.some((d) => /ambigu|varios|múltiples|multiples/i.test(d)));
});

test('el orderId permite vincular sin fecha interna para aproximar', () => {
  assert.deepEqual(conciliar({ ...facturaValida(), orderId: 'order-1' }, [intentPagado({ fechaPago: undefined })]), {
    estado: 'CONCILIADA', intentId: 'intent-1', diferencias: [],
  });
});

test('normaliza espacios en orderId para conciliar y preparar el asiento', () => {
  const factura = { ...facturaValida(), orderId: '  order-1  ' };
  const intent = intentPagado({ fechaPago: undefined });
  assert.deepEqual(conciliar(factura, [intent]), {
    estado: 'CONCILIADA', intentId: 'intent-1', diferencias: [],
  });
  validar(asientoFactura(factura, intent));
});

test('la reclasificación MX mueve IVA de gasto a 1300 y conserva el centro de costo', () => {
  const asiento = asientoFactura(facturaValida(), intentPagado());
  validar(asiento);
  assert.equal(asiento.tipo, 'RECLASIFICACION_IVA');
  assert.deepEqual(asiento.lineas, [
    { cuenta: 1300, cc: 'OPS', debe: 1600 },
    { cuenta: 5100, cc: 'OPS', haber: 1600 },
  ]);
  assert.equal(asiento.lineas.some((l) => l.cuenta === 2100), false);
});

test('la factura no duplica IVA que F-13 ya dejó en 1300', () => {
  const intent = intentPagado({ preAsiento: [
    { cuenta: 5100, debe: 10000 }, { cuenta: 1300, debe: 1600 }, { cuenta: 2100, haber: 11600 },
  ] });
  assert.equal(asientoFactura(facturaValida(), intent), null);
  assert.equal(asientoFactura(facturaValida(), intentPagado({ preAsiento: [
    { cuenta: 5100, debe: 10000 }, { cuenta: 1300, debe: 1700 },
    { cuenta: 1300, haber: 100 }, { cuenta: 2100, haber: 11600 },
  ] })), null);
});

test('reclasifica solo IVA pendiente y revierte un exceso de IVA ya acreditado', () => {
  const conIVA = (iva) => intentPagado({ preAsiento: [
    { cuenta: 5100, debe: 11600 - iva }, { cuenta: 1300, debe: iva }, { cuenta: 2100, haber: 11600 },
  ] });
  const parcial = asientoFactura(facturaValida(), conIVA(1000));
  validar(parcial);
  assert.deepEqual(parcial.lineas, [
    { cuenta: 1300, cc: 'OPS', debe: 600 }, { cuenta: 5100, cc: 'OPS', haber: 600 },
  ]);
  const inverso = asientoFactura(facturaValida(), conIVA(1700));
  validar(inverso);
  assert.deepEqual(inverso.lineas, [
    { cuenta: 5100, cc: 'OPS', debe: 100 }, { cuenta: 1300, cc: 'OPS', haber: 100 },
  ]);
});

test('elige la cuenta principal de gasto y no fletes ni diferencias', () => {
  const asiento = asientoFactura(facturaValida(), intentPagado({ preAsiento: [
    { cuenta: 5400, debe: 1000 }, { cuenta: 5900, debe: 100 }, { cuenta: 5100, debe: 10500 },
    { cuenta: 2100, haber: 11600 },
  ] }));
  assert.equal(asiento.lineas.find((l) => l.haber)?.cuenta, 5100);
  validar(asiento);
});

test('otro país o país ausente solo vincula, sin asiento', () => {
  for (const paisComercio of ['US', 'CA', undefined, null, '']) {
    assert.equal(asientoFactura(facturaValida(), intentPagado({ paisComercio })), null);
  }
  assert.ok(asientoFactura(facturaValida(), intentPagado({ paisComercio: ' mx ' })));
});

test('no permite reclasificar un pago incoherente ni una cuenta de gasto ambigua', () => {
  for (const cambios of [
    { estado: 'EN_PAGO' },
    { checkout: { orderId: 'order-1', finalAmount: 12000 } },
    { cotizacion: { moneda: 'USD' } },
    { preAsiento: [{ cuenta: 5100, debe: 6000 }, { cuenta: 5200, debe: 5600 }, { cuenta: 2100, haber: 11600 }] },
    { preAsiento: [{ cuenta: 1500, debe: 10600 }, { cuenta: 5400, debe: 1000 }, { cuenta: 2100, haber: 11600 }] },
  ]) assert.throws(() => asientoFactura(facturaValida(), intentPagado(cambios)));
});

test('no reclasifica una factura de otro comercio o de otra fecha aunque coincida el monto', () => {
  for (const cambios of [
    { producto: { comercio: 'Otro comercio' } },
    { fechaPago: '2026-10-20T10:00:00-06:00' },
  ]) {
    const intent = intentPagado(cambios);
    assert.throws(() => asientoFactura(facturaValida(), intent));
    assert.throws(() => asientoFactura({ ...facturaValida(), orderId: 'order-1' }, intent));
  }
});

test('las funciones son puras y la reclasificación tiene ID estable por UUID e intent', () => {
  const factura = facturaValida();
  const intent = intentPagado();
  const antes = structuredClone({ factura, intent });
  const a = asientoFactura(factura, intent);
  assert.deepEqual(asientoFactura(factura, intent), a);
  assert.equal(typeof a.id, 'string');
  assert.ok(a.id.length > 0);
  assert.notEqual(asientoFactura(factura, { ...intent, id: 'intent-2' }).id, a.id);
  assert.notEqual(asientoFactura({ ...factura, uuid: 'D4BB25A0-CC70-4A10-8AE7-AB1234560002' }, intent).id, a.id);
  conciliar(factura, [intent]);
  assert.deepEqual({ factura, intent }, antes);
});
