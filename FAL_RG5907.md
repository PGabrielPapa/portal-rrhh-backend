# Fondo de Asistencia Laboral — RG ARCA 5907/2026

Reglamentación del Título II de la Ley 27.802 (Modernización Laboral). Publicada en el
Boletín Oficial el **01/10/2026**; rige desde el **1/11/2026**, para las declaraciones
juradas del **devengado 11/2026** y siguientes (art. 19).

Estado: **implementado y probado**. Falta una definición de Contabilidad — ver el final.

---

## 1. Qué es, y qué NO es

El FAL **no agrega costo**. El Anexo de la resolución publica las alícuotas de los cuatro
subsistemas de seguridad social **ya netas** de la detracción del FAL: cada una es la
anterior multiplicada por el mismo factor, y el total del régimen se mantiene.

> Art. 9: el monto "será detraído de las sumas correspondientes a las contribuciones
> patronales sobre la nómina salarial con destino a los siguientes subsistemas: a) Sistema
> Integrado Previsional Argentino […] b) Instituto Nacional de Servicios Sociales para
> Jubilados y Pensionados […] c) Fondo Nacional de Empleo […] d) Régimen Nacional de
> Asignaciones Familiares."

## 2. El Anexo (IF-2026-03120430-ARCA-SGDADVCOAD#SDGINS)

| Régimen | Clasificación | SIPA | AAFF | FNE | INSSJP | FAL | Total |
|---|---|---|---|---|---|---|---|
| Ley 27.541 art. 19 inc. a) | MiPyME y entidades sin fines de lucro | 10,83 | 4,74 | 0,95 | 1,38 | **2,50** | 20,40 |
| Ley 27.541 art. 19 inc. a) | Resto del sector privado | 11,74 | 5,14 | 1,03 | 1,49 | 1,00 | 20,40 |
| Ley 27.541 art. 19 inc. b) | MiPyME y entidades sin fines de lucro | 9,27 | 4,05 | 0,81 | 1,37 | **2,50** | 18,00 |
| Ley 27.541 art. 19 inc. b) | Resto del sector privado | 10,17 | 4,44 | 0,89 | 1,50 | 1,00 | 18,00 |

Alícuota: **2,5%** para MiPyMEs y entidades sin fines de lucro, **1%** para el resto del
sector privado (art. 8), sobre la misma base que las contribuciones con destino al SIPA.
Código de pago **266-019-019** (art. 10). Aplicativo: versión **48** de Declaración en Línea
(art. 17).

**Todas las empresas del grupo son MiPyME**, así que les corresponde el 2,5%.

## 3. Cómo quedó implementado

Las alícuotas del Anexo se usan **tal cual, sin prorratear**: ya vienen netas. La fila se
elige por el régimen del art. 19 y la clasificación de cada empresa.

- `src/lib/liquidacion.js` — tabla `ALICUOTAS_SS`, selector `alicuotasSS()` y constante
  `SS_DESDE`. Desde el devengado 11/2026 las cuatro contribuciones salen de la tabla;
  **antes de esa fecha siguen saliendo de los parámetros cargados**, para que reliquidar
  un mes anterior dé exactamente lo mismo que dio en su momento.
- **Asignaciones Familiares pasa a ser una línea propia** del recibo. Antes el motor no la
  calculaba: las contribuciones patronales eran SIPA, obra social, INSSJP, FNE, ART y
  sindical, sin AAFF.
- El recibo guarda las alícuotas aplicadas (`bases.ssAlicuotas`, `ssRegimen`,
  `ssClasificacion`), así que siempre se puede reconstruir con qué valores se liquidó.
- **Baja voluntaria (cód. 658) o empleador excluido (659)**: la porción del FAL vuelve a
  los cuatro subsistemas en la misma proporción. Es la inversa exacta del reparto del
  Anexo, así que reconstituye las alícuotas previas sin que cambie el total.
- `src/lib/asientoSueldos.js` + `src/db/migrateAsiento.js` — el FAL tiene clave contable
  propia (`CONT_FAL`), por ahora apuntando a **174 SUSS a pagar**. Ver el punto 4.
- `AdminEmpresas.tsx` — régimen, clasificación y baja voluntaria se configuran por empresa.

## 4. El asiento de sueldos

El cambio de alícuotas se hizo primero en el motor de liquidación y el asiento quedó
desfasado. Revisado de punta a punta, esto es lo que pasaba y cómo quedó:

**Los importes del asiento siempre estuvieron bien.** El asiento no recalcula las
contribuciones: las lee del recibo (`costoEmpleador.contribuciones`) y las clasifica por el
texto del concepto. La hoja ASTO SUELDO imputa el **total** de contribuciones —que incluye
el FAL y las nuevas Asignaciones Familiares— contra la cuenta de cargas sociales del centro
de costos. O sea: el asiento cuadraba y los números eran los liquidados.

**Lo que estaba mal era la hoja Contribuciones**, que es la que Contabilidad usa para
auditar legajo por legajo:

1. Las columnas `% sijp`, `% 19032`, `% fne` y `% afam` salían de *Parámetros de
   liquidación*, no de lo que se había liquidado. Desde 11/2026 esos parámetros ya no
   gobiernan, así que la hoja mostraba porcentajes que no se correspondían con los importes
   de al lado. **Ahora se leen del propio recibo** (`bases.ssAlicuotas`), con los parámetros
   como respaldo para los períodos anteriores.
2. **No había columna de FAL.** Se agregaron `% fal` y `CONT FAL`, así que las contribuciones
   detalladas vuelven a sumar el `TOTAL CONT SS`.
3. La hoja **TABLA ALICUOTAS** mostraba los parámetros viejos. Ahora, cuando el período trae
   las alícuotas del Anexo, muestra ésas más el FAL y el total del régimen.

**El FAL ahora sale por su propia clave en el asiento.** Antes `CONT_FAL` existía en el plan
de cuentas pero nunca se usaba: el crédito iba íntegro a `CONT_SS`. Ahora se imputan por
separado. Como las dos claves apuntan a **174 SUSS a pagar**, el asiento es idéntico al
anterior; pero si Contabilidad le asigna una cuenta propia —se paga con código 266-019-019—
el renglón se separa solo, sin tocar código.

**Un cambio de estructura:** la tabla de clasificación de contribuciones se movió a
`src/lib/asientoConceptos.js`, para poder probarla sin base de datos. El asiento la importa
de ahí.

## 5. El recibo de sueldo

La lista de contribuciones del recibo se arma leyendo `costoEmpleador.contribuciones`, así
que el FAL y las Asignaciones Familiares aparecen solos, como renglones propios, tanto en
pantalla como en el PDF.

La **torta de composición del costo laboral (Decreto 407/2026)** sí había quedado desfasada:
el FAL caía sumado dentro de "Seguridad Social", y el rótulo del detalle todavía decía
*SIPA + FNE* cuando esa porción ya contenía también las Asignaciones Familiares. Ahora:

- El FAL es **una porción propia** de la torta y un renglón propio del detalle
  empleador/trabajador. Tiene sentido: se paga a otro destino y con otro código
  (266-019-019), y el trabajador tiene derecho a ver cuánto de su costo laboral va ahí.
- La porción "Seguridad Social" quedó rotulada **SIPA, AA.FF. y FNE**, que es lo que
  efectivamente contiene.
- El costo laboral total no cambia: el FAL ya estaba adentro, sólo que mezclado.

Vale para la vista en pantalla (`ReciboView.tsx`) y para el recibo impreso
(`reciboPrint.ts`), que comparten la misma estructura `composicion.cargas`.

## 6. Verificación

Once pruebas nuevas en `test/liquidacion.test.js` (suite: **41 OK, 0 fallidos**):

- Las cuatro filas del Anexo están cargadas al centavo y **cada una suma el total de su
  régimen** (20,40% o 18,00%).
- MiPyME tributa 2,5% y el resto 1%; por defecto, inciso b) y MiPyME.
- El recibo de 11/2026 aplica las cinco alícuotas sobre la base de contribuciones.
- **El FAL redistribuye y no encarece**: en las cuatro combinaciones, los cinco conceptos
  suman el total del régimen.
- La baja voluntaria deja el FAL en cero y el total en 18%.
- Octubre de 2026 sigue liquidando con `pctJubPatronal`, sin FAL.
- **Toda contribución que emite la liquidación encuentra clave en el asiento.** Es la prueba
  que evita que se repita lo de esta vez: si mañana se agrega un concepto patronal y no se
  lo mapea, el test falla en vez de que el importe caiga silenciosamente en "otras".
- El FAL se clasifica como `CONT_FAL` y no como jubilación patronal; AAFF como `CONT_AFAM`.
- El total de contribuciones del recibo incluye el FAL.
- El recibo guarda las alícuotas del Anexo para la hoja Contribuciones; octubre no.
- El FAL es un renglón propio de `composicion.cargas`, con el importe liquidado, y
  "Seguridad Social" queda en SIPA + AA.FF. + FNE.
- Separar el FAL no cambia el costo laboral total.

## 7. Lo que falta definir

**El inciso del art. 19 de cada empresa.** Hoy quedó por defecto en el **inciso b) (18%)**,
que es el régimen general y el que más se parece a los parámetros cargados. Si Contabilidad
confirma que alguna va por el inciso a) (20,40%), se cambia desde Administración → Empresas,
sin tocar código.

**Revisar el parámetro `pctJubPatronal` de producción.** Los valores de la semilla son
SIPA 10,17 · FNE 0,89 · INSSJP 1,50 — exactamente la fila "inc. b) resto del sector privado"
del Anexo, **sin AAFF**. Si en producción `pctJubPatronal` trae SIPA y AAFF juntos, está
bien. Si vale 10,17, faltaban 4,44 puntos de Asignaciones Familiares en las liquidaciones
anteriores a 11/2026. Desde 11/2026 el problema no existe, porque las alícuotas salen del
Anexo; lo que hay que revisar es el período anterior.

**Si Contabilidad quiere el FAL en cuenta separada**, se le asigna una propia a `CONT_FAL`
desde Plan de cuentas. Se paga con código distinto (266-019-019), así que puede tener
sentido.

## 8. Alcance

El art. 9 dice que quien determina el FAL en forma definitiva es el sistema **"Declaración
en línea"** de ARCA. Lo que calcula el portal alimenta el recibo, el costo laboral y el
asiento, y sirve para **conciliar** contra la DDJJ — no la reemplaza.
