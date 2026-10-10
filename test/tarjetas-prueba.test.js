import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leerTabla } from '../scripts/importar-tarjetas-prueba.mjs';

// Fragmento con la forma de la pagina Setup de Reap (numeros ficticios).
const md = `## Store a card

| Otra | tabla |
| - | - |
| 1111 2222 3333 4444 | 999 |

## Test cards

| Card number | CVC | Expiry |
| - | - | - |
| 4000 0000 0000 0002 | 123 | 12/27 |
| 5500 0000 0000 0004 | 045 | 01/28 |

## One-time passwords

The card verification step may ask for a one-time password. Enter \`456789\`.
`;

test('lee solo la tabla "Test cards", con red, vencimiento y OTP', () => {
  assert.deepEqual(leerTabla(md), [
    { ultimos4: '0002', numero: '4000000000000002', cvc: '123', vence: { mes: 12, anio: 2027 }, red: 'Visa', otp: '456789' },
    { ultimos4: '0004', numero: '5500000000000004', cvc: '045', vence: { mes: 1, anio: 2028 }, red: 'Mastercard', otp: '456789' },
  ]);
});

test('sin la seccion devuelve una lista vacia', () => {
  assert.deepEqual(leerTabla('## Otra cosa\n| 4000 0000 0000 0002 | 123 | 12/27 |'), []);
});
