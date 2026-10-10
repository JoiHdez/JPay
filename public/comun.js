// Utilidades compartidas por solicitante.html y finanzas.html. Cambios aqui afectan a las dos
// pantallas: se hacen en main y se avisan (ver docs/CONTRATO.md).

export const $ = (id) => document.getElementById(id);
export const money = (c) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
export const usd = (n) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// Todo lo que viene de Reap o del usuario se pinta como texto, nunca como HTML.
export function el(tag, props = {}, ...hijos) {
  const e = Object.assign(document.createElement(tag), props);
  for (const h of hijos) if (h != null && h !== false) e.append(h);
  return e;
}

// Marca y titulo compartidos; cada pantalla conserva sus enlaces y acciones.
async function montarEncabezados() {
  const encabezados = document.querySelectorAll('[data-encabezado]');
  if (!encabezados.length) return;
  const logos = [];
  for (const encabezado of encabezados) {
    const logo = el('a', { className: 'logo', href: '/', ariaLabel: 'J-Pay · Inicio' });
    encabezado.prepend(logo, el('div', {},
      el('h1', { textContent: encabezado.dataset.titulo }),
      encabezado.dataset.subtitulo ? el('div', { className: 'sub', textContent: encabezado.dataset.subtitulo }) : null));
    logos.push(logo);
  }
  // Insertarlo inline permite que currentColor herede el color del encabezado.
  const respuesta = await fetch('/logo.svg');
  if (!respuesta.ok) throw new Error('No se pudo cargar la marca de J-Pay.');
  const marca = new DOMParser().parseFromString(await respuesta.text(), 'image/svg+xml').documentElement;
  for (const logo of logos) logo.append(document.importNode(marca, true));
}

montarEncabezados().catch((error) => console.error(error.message));

export async function api(ruta, cuerpo) {
  const r = await fetch(ruta, cuerpo ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) } : {});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Algo falló');
  return d;
}

// Estados del intent (contrato con el servidor).
export const ESTADO = {
  APROBADO: ['Comprometido', 'warn'],
  EN_CHECKOUT: ['Esperando a Reap', 'warn'],
  COMPLETADO: ['Pagado y contabilizado', 'ok'],
  FALLIDO: ['Reap no completó', 'bad'],
  EXPIRADO: ['Checkout expirado', 'bad'],
};

/** Chips de estado y del guard para una compra. */
export function chipsDe(i) {
  const [txt, cls] = ESTADO[i.estado] || [i.estado, 'warn'];
  const bloq = i.cotizacion === 'BLOQUEADA' && i.estado === 'APROBADO';
  const lista = i.cotizacion === 'LISTA' && i.estado === 'APROBADO';
  return el('span', {},
    el('span', { className: `chip ${cls}`, textContent: txt }), ' ',
    bloq ? el('span', { className: 'chip bad', textContent: 'Guard: bloqueado' }) : lista ? el('span', { className: 'chip ok', textContent: 'Guard: ok' }) : null);
}

/** Encabezado y detalle de una compra, igual en las dos pantallas. */
export function resumenCompra(i) {
  return [
    el('div', { className: 'fila', style: 'justify-content:space-between' },
      el('div', {}, el('strong', { textContent: i.producto ? i.producto.nombre : i.busqueda }), el('div', { className: 'muted', textContent: `${i.id} · ${i.solicitante} · ${i.cc} · cuenta ${i.cuenta} · tope ${usd(i.topeUsd)}` })),
      el('div', { style: 'text-align:right' }, el('div', {}, chipsDe(i)),
        i.totalUsd != null ? el('div', { style: 'font-weight:700;margin-top:4px', textContent: usd(i.finalUsd ?? i.totalUsd) }) : null)),
    i.producto ? el('div', { className: 'muted', textContent: `${i.producto.tienda} · cantidad ${i.propuesta?.cantidad} · envío ${i.envioNombre || '-'}${i.orderId ? ` · orden ${i.orderId}` : ''}${i.factura ? ` · factura ${i.factura.folio}` : ''}` }) : null,
    i.error ? el('div', { className: 'err', textContent: i.error }) : null,
    i.guard && !i.guard.permitido && i.estado === 'APROBADO' ? el('ul', { className: 'viol' }, ...i.guard.violaciones.map((v) => el('li', { textContent: v.mensaje }))) : null,
  ].filter(Boolean);
}

/** Barras de presupuesto por centro de costo. */
export function pintarPresupuestos(contenedor, presupuestos) {
  contenedor.replaceChildren(...presupuestos.map((p) => el('div', { style: 'margin-bottom:8px' },
    el('div', { className: 'fila', style: 'justify-content:space-between' }, el('strong', { textContent: `${p.cc} · ${p.nombre}` }), el('span', { className: 'muted', textContent: `${money(p.disponible)} de ${money(p.presupuesto)}` })),
    el('div', { className: 'barra' },
      el('div', { className: 'g', style: `width:${Math.max(0, (p.consumido / p.presupuesto) * 100)}%` }),
      el('div', { className: 'c', style: `width:${Math.max(0, (p.comprometido / p.presupuesto) * 100)}%` })))));
}

/** Ejecuta una accion con el boton deshabilitado y muestra el error, si hay. */
export async function accion(boton, fn, error) {
  boton.disabled = true;
  if (error) error.textContent = '';
  try { await fn(); }
  catch (e) { if (error) error.textContent = e.message; alert(e.message); }
  finally { boton.disabled = false; }
}
