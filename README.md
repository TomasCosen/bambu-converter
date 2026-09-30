# Conversor 3MF a Bambu

Página web que convierte un archivo `.3mf` hecho con cualquier programa en un **proyecto de Bambu Studio** para **Bambu Lab A1** o **A1 mini**. Hace el camino inverso de [u1convert.com](https://u1convert.com/), que pasa proyectos de Bambu a la Snapmaker U1.

Todo corre en el navegador: el archivo nunca sale de tu computadora.

## Qué convierte

| Origen | Qué se aprovecha |
|---|---|
| **Bambu Studio** (otra impresora, p. ej. X1C o P1S → A1) | Geometría intacta, piezas, modificadores, pintado, placas, ajustes por objeto y ajustes que cambiaste a mano |
| **OrcaSlicer / Snapmaker Orca (U1)** y derivados | Igual que Bambu, con traducción de valores propios de Orca (p. ej. `ensure_all` → `enabled`, `tpmsd` → `gyroid`, índices de filamento 1 → 0) |
| **Archivos pasados por u1convert** | Vuelven a la A1 casi idénticos al original (verificado con el cubo de ejemplo) |
| **PrusaSlicer** | Volúmenes (piezas, modificadores, negativos, bloqueadores y forzadores de soporte), pintado MMU, soportes y costuras pintadas, ajustes globales y por objeto |
| **Cura** | Extrusor por objeto, mallas de soporte, relleno y corte, ajustes del perfil de usuario |
| **3MF genérico** (CAD, Thingiverse, Printables) | Objetos, copias, componentes, unidades (pulgadas, cm…), colores por objeto y por triángulo (se convierten en pintado) |

## Qué hace con el archivo

1. **Impresora.** Reemplaza máquina, boquilla, área de impresión, G-code de inicio y fin, y cambio de filamento por los perfiles oficiales de Bambu. Escribe `Application = BambuStudio-02.00.00.00` para que Bambu Studio lo abra como proyecto y no como geometría suelta.
2. **Proceso.** Elige el perfil de Bambu más cercano a la altura de capa original y conserva los ajustes estructurales: paredes, capas superiores e inferiores, relleno y patrón, soportes, borde, falda, balsa, costura, planchado, modo jarrón, secuencia y torre de purga.
   - Los valores propios de cada máquina (compensación de pata de elefante, distancias de soporte, etc.) solo se conservan si los habías cambiado a mano.
   - Velocidades, aceleraciones y temperaturas quedan las del perfil de Bambu.
3. **Filamentos.**
   - **Detección:** encuentra qué filamentos usa realmente el modelo (por objeto, pieza, pintado, cambios de color por capa y soportes) y descarta los que no se usan.
   - **Perfiles:** asigna a cada uno el perfil de Bambu más parecido, por familia (Bambu PLA Matte, PETG HF, TPU 95A…), por marca (PolyTerra, SUNLU, eSUN…) o genérico.
   - **Fusión:** podés juntar colores en una misma ranura. El pintado y los cambios de color se reasignan solos.
   - **Placa:** solo se ofrecen las placas compatibles con los filamentos elegidos.
   - **Purga:** los volúmenes de purga entre colores se calculan con la misma fórmula que usa Bambu Studio.
4. **Posición.** Recentra cada placa en la cama nueva (256 × 256 o 180 × 180) respetando la grilla de placas de Bambu Studio. También puede centrar o reorganizar automáticamente en varias placas. Ubica la torre de purga en una esquina libre y avisa si algo no entra.
5. **Archivos.** Descarta el G-code laminado y los perfiles embebidos de otras impresoras. Conserva miniaturas, cortes, capas variables y pausas; las pausas pasan a `M400 U1`.

El proyecto se guarda con los nombres de los perfiles oficiales y la lista `different_settings_to_system`. Así Bambu Studio selecciona sus propios perfiles de sistema, marca como modificados solo los ajustes traídos del original y toma el resto de su versión instalada.

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
data/bambu-a1.json              perfiles oficiales A1 / A1 mini ya resueltos (herencias incluidas)
tools/build_data.py             regenera data/ desde el código de BambuStudio
tools/check-with-bambustudio.sh lamina un 3MF con el Bambu Studio real (CLI)
tests/                          pruebas y archivos de ejemplo
docs/analisis.md                análisis de u1convert.com y de los archivos de ejemplo
```

## Actualizar los perfiles

```bash
git clone --depth 1 https://github.com/bambulab/BambuStudio /tmp/BambuStudio
python3 tools/build_data.py /tmp/BambuStudio tests/fixtures/bambu-template-project_settings.config
```

La plantilla es un `project_settings.config` real guardado por Bambu Studio para la A1. Aporta las claves que ningún perfil define.

## Pruebas

```bash
npm install
npm test                         # conversión de todos los formatos de ejemplo
node tests/make-fixtures.mjs     # regenera los 3MF sintéticos de Orca, PrusaSlicer, Cura y genérico
```

Además, todos los ejemplos se laminaron con **Bambu Studio 02.08.02.61 real** en modo línea de comandos (`tools/check-with-bambustudio.sh`):

- tomaron los perfiles, colores, ajustes y placas convertidos;
- generaron cambios de filamento donde había pintado;
- no dieron errores.

## Limitaciones

- Por ahora, solo A1 y A1 mini. Agregar otra impresora es sumar su nombre en `tools/build_data.py`.
- La A1 mini no tiene perfiles oficiales de ABS, ASA, PC ni PA: se asigna el más parecido y se avisa.
- Las miniaturas de placa se conservan tal cual; Bambu Studio las regenera al guardar.
- Revisá siempre la vista previa laminada antes de imprimir.
