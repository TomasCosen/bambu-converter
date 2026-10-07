# Conversor de proyectos 3MF

Página web que convierte un archivo `.3mf` hecho con cualquier programa en un proyecto listo para la impresora que elijas:

| Impresora | Slicer de destino | Cama |
|---|---|---|
| Bambu Lab A1 | Bambu Studio | 256 × 256 × 256 mm |
| Bambu Lab A1 mini | Bambu Studio | 180 × 180 × 180 mm |
| Bambu Lab A2L | Bambu Studio | 330 × 320 × 325 mm |
| Snapmaker U1 (4 cabezales) | Snapmaker Orca | 270 × 270 × 270 mm |

Cubre los dos sentidos: lo mismo que hace [u1convert.com](https://u1convert.com/) (Bambu → U1) y el camino inverso (U1 o cualquier otro → Bambu).

Todo corre en el navegador: el archivo nunca sale de tu computadora.

## Qué convierte

| Origen | Qué se aprovecha |
|---|---|
| **Bambu Studio** (cualquier impresora) | Geometría intacta, piezas, modificadores, pintado, placas, ajustes por objeto y ajustes que cambiaste a mano |
| **OrcaSlicer / Snapmaker Orca (U1)** y derivados | Igual que Bambu. Los valores que cada slicer nombra distinto se traducen en ambos sentidos (`ensure_all` ↔ `enabled`, `rectilinear` ↔ `zig-zag`, `organic` ↔ `tree_organic`, índice de filamento por defecto 1 ↔ 0) |
| **Archivos pasados por u1convert** | Vuelven a la A1 casi idénticos al original (verificado con el cubo de ejemplo) |
| **PrusaSlicer** | Volúmenes (piezas, modificadores, negativos, bloqueadores y forzadores de soporte), pintado MMU, soportes y costuras pintadas, ajustes globales y por objeto |
| **Cura** | Extrusor por objeto, mallas de soporte, relleno y corte, ajustes del perfil de usuario |
| **3MF genérico** (CAD, Thingiverse, Printables) | Objetos, copias, componentes, unidades (pulgadas, cm…), colores por objeto y por triángulo (se convierten en pintado) |

## Qué hace con el archivo

1. **Impresora.** Reemplaza máquina, boquilla, área de impresión, G-code de inicio y fin, y cambio de filamento por los perfiles oficiales del fabricante. Marca el archivo como `BambuStudio-02.00.00.00` o `Snapmaker_Orca-2.4.0` para que el slicer lo abra como proyecto y no como geometría suelta.
2. **Proceso.** Elige el perfil de la impresora más cercano a la altura de capa original y conserva los ajustes estructurales: paredes, capas superiores e inferiores, relleno y patrón, soportes, borde, falda, balsa, costura, planchado, modo jarrón, secuencia y torre de purga.
   - Los valores propios de cada máquina (compensación de pata de elefante, distancias de soporte, etc.) solo se conservan si los habías cambiado a mano.
   - Velocidades, aceleraciones y temperaturas quedan las del perfil de la impresora.
3. **Filamentos.**
   - **Detección:** encuentra qué filamentos usa realmente el modelo (por objeto, pieza, pintado, cambios de color por capa y soportes) y descarta los que no se usan.
   - **Perfiles:** asigna a cada uno el perfil más parecido de la impresora, por familia (Bambu PLA Matte ↔ Snapmaker PLA Matte, PETG HF, TPU 95A…), por marca (PolyTerra, SUNLU, eSUN…), por el perfil del que hereda o genérico.
   - **Ranuras:** en las Bambu cada filamento va a una ranura del AMS; en la U1, a uno de sus 4 cabezales. Avisa si hay más filamentos que ranuras o cabezales.
   - **Fusión:** podés juntar colores en una misma ranura. El pintado y los cambios de color se reasignan solos.
   - **Placa:** solo se ofrecen las placas compatibles con los filamentos elegidos.
   - **Purga:** los volúmenes de purga entre colores se calculan con la misma fórmula que usa Bambu Studio.
4. **Posición.** Recentra cada placa en la cama nueva respetando la grilla de placas del slicer. También puede centrar o reorganizar automáticamente en varias placas. Ubica la torre de purga en una esquina libre y avisa si algo no entra.
5. **Archivos.** Descarta el G-code laminado y los perfiles embebidos. Conserva miniaturas, cortes, capas variables y pausas; las pausas pasan al G-code de pausa de la impresora (`M400 U1` en Bambu, `M600` en la U1).

El proyecto se guarda con los nombres de los perfiles oficiales y la lista `different_settings_to_system`. Así el slicer selecciona sus propios perfiles de sistema, marca como modificados solo los ajustes traídos del original y toma el resto de su versión instalada.

## Uso

La página es estática: HTML, CSS y JavaScript, sin compilar. Tiene que servirse por HTTP, porque no funciona abriendo `index.html` como archivo local.

```bash
npm run serve          # http://localhost:8080
```

Para publicarla gratis, activá **GitHub Pages** en el repositorio (Settings → Pages → rama `main`, carpeta `/`).

## Estructura

```
index.html, css/, js/app.js     interfaz
js/core/                        conversor (sirve en navegador y en Node)
  source.js                     lee 3MF de Bambu, Orca, SnapOrca, PrusaSlicer, Cura y genéricos
  convert.js                    ubicación, project_settings, escritura del proyecto Bambu
  settings.js                   traducción de ajustes (Orca, PrusaSlicer, Cura → Bambu)
  paint.js                      codificador del pintado por triángulo (formato Bambu y Prusa)
  profiles.js                   perfiles de Bambu y elección de filamentos
data/bambu.json                 perfiles oficiales A1 / A1 mini / A2L ya resueltos (herencias incluidas)
data/snapmaker.json             perfiles oficiales de la Snapmaker U1
tools/build_data.py             regenera data/ desde el código de BambuStudio o Snapmaker Orca
tools/check-with-bambustudio.sh lamina un 3MF con el Bambu Studio real (CLI)
tests/                          pruebas y archivos de ejemplo
docs/analisis.md                análisis de u1convert.com y de los archivos de ejemplo
```

## Actualizar los perfiles

```bash
git clone --depth 1 https://github.com/bambulab/BambuStudio /tmp/BambuStudio
python3 tools/build_data.py bambu /tmp/BambuStudio tests/fixtures/bambu-template-project_settings.config

git clone --depth 1 https://github.com/Snapmaker/OrcaSlicer /tmp/SnapOrca
python3 tools/build_data.py snapmaker /tmp/SnapOrca tests/fixtures/snapmaker-template-project_settings.config
```

Las plantillas son `project_settings.config` reales guardados por cada slicer. Aportan las claves que ningún perfil define. Para sumar otra impresora de esos fabricantes, agregala en `VENDORS` dentro de `tools/build_data.py`.

## Pruebas

```bash
npm install
npm test                         # conversión de todos los formatos de ejemplo
node tests/make-fixtures.mjs     # regenera los 3MF sintéticos de Orca, PrusaSlicer, Cura y genérico
```

Además, todos los ejemplos se laminaron con los slicers reales en modo línea de comandos: **Bambu Studio 02.08.02.61** (`tools/check-with-bambustudio.sh`) para A1, A1 mini y A2L, y **Snapmaker Orca 2.4.0** para la U1 (con el parche de línea de comandos de [snapmaker-orca-cli](https://github.com/djgringoboy2003/snapmaker-orca-cli), porque la versión oficial no lamina sin interfaz). En todos los casos:

- tomaron los perfiles, colores, ajustes y placas convertidos;
- generaron cambios de filamento donde había pintado;
- no dieron errores.

## Limitaciones

- Por ahora, A1, A1 mini, A2L y U1.
- La A1 mini no tiene perfiles oficiales de ABS, ASA, PC ni PA: se asigna el más parecido y se avisa.
- Las miniaturas de placa se conservan tal cual; Bambu Studio las regenera al guardar.
- Revisá siempre la vista previa laminada antes de imprimir.
