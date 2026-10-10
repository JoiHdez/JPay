# Graph Report - JPay  (2026-10-09)

## Corpus Check
- Corpus is ~9,529 words - fits in a single context window. You may not need a graph.

## Summary
- 109 nodes · 177 edges · 7 communities
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 10 edges (avg confidence: 0.86)
- Token cost: 97,999 input · 0 output

## Community Hubs (Navigation)
- Ledger y Ledger Guard
- Servidor y flujo de pago
- Dashboard y demo del ataque
- Ciclo contable y principios
- Configuracion del paquete
- Cliente de Reap
- Agente y pruebas del guard

## God Nodes (most connected - your core abstractions)
1. `revisar()` - 8 edges
2. `Ledger Guard` - 7 edges
3. `cargar()` - 7 edges
4. `centavos()` - 6 edges
5. `Reap API Agentic Module` - 6 edges
6. `Ciclo contable completo de un pago agentico` - 6 edges
7. `tarjetaIntent()` - 6 edges
8. `cuadra()` - 5 edges
9. `cotizar()` - 5 edges
10. `evaluar()` - 5 edges

## Surprising Connections (you probably didn't know these)
- `J-Pay` --references--> `Dashboard J-Pay (public/index.html)`  [EXTRACTED]
  README.md → public/index.html
- `Rutas /api (estado, intents, aprobar, recotizar, documento, tarjeta, facturas, cierre)` --references--> `Three-way match nativo`  [INFERRED]
  public/index.html → README.md
- `Rutas /api (estado, intents, aprobar, recotizar, documento, tarjeta, facturas, cierre)` --references--> `Cierre de mes (liquidacion, balanza, P&L)`  [INFERRED]
  public/index.html → README.md
- `cargar()` --shares_data_with--> `Ledger Guard`  [INFERRED]
  public/index.html → README.md
- `ESTADO (mapa de estados del intent)` --shares_data_with--> `Idempotency-Key y reclamo EN_CHECKOUT`  [INFERRED]
  public/index.html → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Asientos del ciclo de pago agentico** — readme_asiento_compromiso, readme_pre_asiento, readme_asiento_devengado, readme_three_way_match, readme_cierre_de_mes [EXTRACTED 1.00]
- **Defensa contra manipulacion del agente** — readme_manipulacion_del_agente, readme_agente_ingenuo, readme_ledger_guard, readme_demo_ataque, public_index_doc_envenenado [INFERRED 0.85]
- **Ciclo de render y polling del dashboard** — public_index_cargar, public_index_accion, public_index_api, public_index_tarjetaintent, public_index_el [EXTRACTED 1.00]

## Communities (7 total, 0 thin omitted)

### Community 0 - "Ledger y Ledger Guard"
Cohesion: 0.18
Nodes (19): CATEGORIAS, CENTROS, CUENTAS, CUENTAS_DE_CONSUMO, palabras(), revisar(), balanza(), centavos() (+11 more)

### Community 1 - "Servidor y flujo de pago"
Cohesion: 0.16
Nodes (17): ARCHIVO, conciliar(), cotizar(), db, disponible(), evaluar(), falla(), guardar() (+9 more)

### Community 2 - "Dashboard y demo del ataque"
Cohesion: 0.18
Nodes (16): accion(), api(), cargar(), DOC_ENVENENADO, el(), PRESETS, tarjetaIntent(), Agente ingenuo de la demo (agente.js) (+8 more)

### Community 3 - "Ciclo contable y principios"
Cohesion: 0.14
Nodes (17): Rutas /api (estado, intents, aprobar, recotizar, documento, tarjeta, facturas, cierre), Dashboard J-Pay (public/index.html), ESTADO (mapa de estados del intent), Asiento de compromiso (cuentas de orden 8100/8000), Asiento devengado y ajuste a 5900, El backend es dueno de las credenciales de Reap, Ciclo contable completo de un pago agentico, Cierre de mes (liquidacion, balanza, P&L) (+9 more)

### Community 4 - "Configuracion del paquete"
Cohesion: 0.18
Nodes (10): description, engines, node, name, private, scripts, start, test (+2 more)

### Community 5 - "Cliente de Reap"
Cohesion: 0.20
Nodes (9): BASE, CATALOGO, conReintento(), memoria, modo, real, reap(), reapApi (+1 more)

### Community 6 - "Agente y pruebas del guard"
Cohesion: 0.24
Nodes (7): leerInstrucciones(), proponer(), ahora, intent, pre, producto, quote

## Knowledge Gaps
- **30 isolated node(s):** `name`, `version`, `private`, `description`, `type` (+25 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 37 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Ledger Guard` connect `Dashboard y demo del ataque` to `Ciclo contable y principios`?**
  _High betweenness centrality (0.041) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `Ledger Guard` (e.g. with `cargar()` and `Manipulacion del agente (instrucciones ocultas)`) actually correct?**
  _`Ledger Guard` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _30 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Ciclo contable y principios` be split into smaller, more focused modules?**
  _Cohesion score 0.13970588235294118 - nodes in this community are weakly interconnected._