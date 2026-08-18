# Motor de fórmulas de conceptos — diseño y plan (brecha #6)

_8/7/2026. Réplica de las "fórmulas + variables" de Tango Sueldos, adaptada al Portal._

## Objetivo

Permitir que RR.HH. defina **conceptos calculados por fórmula** (como en Tango: fórmulas tipo Excel + variables), sin depender de que un programador toque el motor. Debe **convivir** con el cálculo actual (que seguirá resolviendo básico, antigüedad, aportes, contribuciones, Ganancias, etc.), agregando conceptos propios.

## Principio rector: aditivo y seguro

El motor de cálculo actual (`liquidacion.js`) **no se reescribe**. Los conceptos por fórmula se **suman** al recibo como haberes o descuentos adicionales, calculados con un evaluador seguro. Así evitamos el riesgo de romper la liquidación, F.931, SICOSS, LSD y Ganancias que ya funcionan.

## Componente ya construido y probado (esta etapa)

`src/lib/formulas.js` — evaluador de fórmulas **seguro** (no usa `eval`; parser propio). Soporta:

- Números, variables, paréntesis, `+ - * / %` y signo negativo.
- Comparaciones `> < >= <= == !=` y lógicos `&& ||` (devuelven 1/0).
- Funciones: `SI(cond, a, b)`, `MIN`, `MAX`, `ABS`, `REDONDEAR(x[,dec])`, `ENTERO`, `PISO`, `TECHO`.
- Variables no sensibles a mayúsculas; inexistente = 0 (en liquidación) o error (en el editor "probar fórmula").
- División por cero = 0 (no rompe la corrida).

Cubierto por `test/formulas.test.js` (12 casos, incluidos seguridad y errores de sintaxis). `npm test` corre las dos suites (20 + 12 OK).

## Catálogo de variables (propuesto)

Disponibles dentro de una fórmula de concepto, tomadas del legajo, el período y los valores ya calculados:

- **Del legajo:** `basico`, `sueldo`, `complemento`, `norem`, `antiguedad_monto`, `bruto`, `anios` (antigüedad en años), y **todos los campos adicionales `cx_*`** (brecha #5).
- **Del período/liquidación:** `remun` (total remunerativo ya calculado), `noRem`, `dias` (días trabajados), `he50`, `he100`, `ausencias`, `feriados`.
- **Parámetros:** `smvm`, `topeSipa`.

(El listado final se muestra en el editor con ayuda y autocompletado.)

## Modelo de datos (propuesto)

Reutilizar la tabla `conceptos` existente sumando: `formula TEXT`, `base` (rem | norem | exento | descuento), `activo`, `orden`, `condicion` (fórmula opcional que, si da 0, no aplica el concepto), `alcance` (todas las empresas / una / un convenio / un sindicato).

## Punto de integración (la parte de riesgo — requiere tu OK)

Dentro de `calcularRecibo`, **antes** de calcular aportes/Ganancias, se evalúan los conceptos por fórmula activos y se insertan como haberes/descuentos según su `base`. Esto es lo único que toca el motor vivo, por eso se hace en un paso aparte, con:

- Bandera para prender/apagar el motor de fórmulas (si está apagado, todo funciona como hoy).
- Validación previa de cada fórmula; si una falla, se omite ese concepto y se registra el aviso (no frena la corrida).
- Cobertura de tests comparando un recibo "sin fórmulas" vs "con una fórmula que da 0" (deben ser idénticos).

## Plan por fases

1. **✅ Evaluador seguro + tests** (hecho en esta etapa).
2. **Editor de conceptos por fórmula**: pantalla para escribir la fórmula, elegir base, condición y alcance, con botón "probar" (usa `analizarFormula` + `evaluarFormula` estricto sobre un legajo de ejemplo). _Aditivo, sin tocar el motor._
3. **Integración en el cálculo**: evaluar e insertar los conceptos en `calcularRecibo` (paso opcional detrás de bandera). _Es el paso sensible; se hace con tu confirmación._
4. **Variables "campo adicional" y de acumuladores** en el catálogo; documentación y ejemplos.

## Recomendación

Avanzar con la **fase 2** (editor de conceptos por fórmula) que es aditiva y sin riesgo para lo que ya funciona, dejar la **fase 3** (tocar el cálculo) para una entrega dedicada con tests de no-regresión y tu visto bueno.
