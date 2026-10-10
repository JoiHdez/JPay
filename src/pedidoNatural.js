// Pedido en lenguaje natural: Claude convierte lo que escribe el solicitante ("necesito detergente
// para la oficina, maximo 40 dolares") en los campos de un intent. Solo PROPONE: el solicitante
// revisa el formulario y confirma, y el intent pasa por las mismas validaciones, politica y
// Ledger Guard que un pedido escrito a mano. Claude nunca toca Reap, montos cobrados ni el ledger.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { CATEGORIAS, CENTROS } from './catalogo.js';

const MODELO = 'claude-opus-5-5';

export const Propuesta = z.object({
  cc: z.enum(Object.keys(CENTROS)),
  categoria: z.enum(Object.keys(CATEGORIAS)),
  busqueda: z.string(),
  cantidad: z.number().int(),
  maxCantidad: z.number().int(),
  topeUsd: z.number().nullable(),
  resumen: z.string(),
  faltante: z.string().nullable(),
});

const SISTEMA = `Eres el asistente de compras de J-Pay. Conviertes el pedido de un empleado en los campos de una solicitud de compra corporativa. No compras nada: el empleado revisa tu propuesta y finanzas autoriza el pago.

Centros de costo: ${Object.entries(CENTROS).map(([k, c]) => `${k} (${c.nombre})`).join(', ')}.
Categorías: ${Object.entries(CATEGORIAS).map(([k, c]) => `${k} (${c.etiqueta})`).join(', ')}.

Reglas:
- busqueda: 2 a 6 palabras en inglés para buscar el producto en tiendas de Estados Unidos (por ejemplo "laundry detergent", "laptop stand"). Sin marcas salvo que el empleado nombre una.
- cc: el área que menciona el empleado; si no la menciona, la que mejor corresponda al producto.
- cantidad: la que pide el empleado; 1 si no dice. maxCantidad: igual a cantidad, salvo que el empleado acepte explícitamente más unidades.
- topeUsd: el tope en dólares que da el empleado. Si da el monto en pesos u otra moneda, o no da tope, deja topeUsd en null y dilo en faltante. No conviertas monedas ni inventes un tope.
- resumen: una frase en español con lo que entendiste.
- faltante: en español, qué debe completar o confirmar el empleado; null si no falta nada.`;

let cliente = null;
const clienteAnthropic = () => (cliente ??= new Anthropic());

/**
 * @returns {Promise<z.infer<typeof Propuesta>>}
 * Lanza un Error con `status` (para la respuesta HTTP) si Claude no puede proponer.
 */
export async function interpretar(texto, { client = clienteAnthropic() } = {}) {
  let r;
  try {
    r = await client.beta.messages.parse({
      model: MODELO,
      max_tokens: 4096,
      // Si el clasificador de seguridad rechaza, el API reintenta en el modelo recomendado.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // Extraccion corta: esfuerzo bajo basta y responde rapido.
      output_config: { effort: 'low', format: betaZodOutputFormat(Propuesta) },
      system: SISTEMA,
      messages: [{ role: 'user', content: texto }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw conStatus(501, 'Claude no está configurado: define ANTHROPIC_API_KEY en .env.');
    if (e instanceof Anthropic.RateLimitError) throw conStatus(429, 'Claude está limitando las solicitudes; intenta en un momento.');
    if (e instanceof Anthropic.APIError) throw conStatus(502, `Claude respondió ${e.status ?? 'sin estado'}: ${e.message}`);
    if (/api ?key|apiKey|authToken/i.test(String(e?.message))) throw conStatus(501, 'Claude no está configurado: define ANTHROPIC_API_KEY en .env.');
    throw e;
  }
  if (r.stop_reason === 'refusal') throw conStatus(422, 'Claude no puede procesar ese pedido.');
  const p = r.parsed_output ? Propuesta.safeParse(r.parsed_output) : null;
  if (!p?.success) throw conStatus(502, 'Claude no devolvió una propuesta válida; escribe el pedido de otra forma.');
  return p.data;
}

function conStatus(status, mensaje) {
  const e = new Error(mensaje);
  e.status = status;
  return e;
}
