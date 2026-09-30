# Análisis: u1convert.com y los archivos de ejemplo

## 1. Cómo funciona u1convert.com

El sitio es de código abierto: [thadius83/bambu-to-snapmaker-u1](https://github.com/thadius83/bambu-to-snapmaker-u1), con licencia PolyForm Noncommercial. Este proyecto **no reutiliza su código**; solo se estudió su comportamiento.

- **Arquitectura.** Backend en Python (FastAPI) y frontend en Svelte. **La conversión se hace en su servidor**: el archivo se sube, se guarda en una carpeta temporal y se borra a los 5 minutos. Límite: 200 MB.
- **Flujo de la interfaz.**
  1. Subís el `.3mf` y el servidor sugiere un perfil de calidad de la U1 según la altura de capa y la palabra clave del perfil (Standard, Fine, Draft…).
  2. Muestra avisos: archivo ya convertido, modelo pintado con más de 4 colores, varias placas, pieza más grande que la cama, origen que no es Bambu.
  3. Opciones: perfil de referencia, "reglas de filamento" (topes de velocidad en YAML), pausas para cambio de bobina y ajustes avanzados en YAML.
  4. Si hay más de 4 colores pintados, abre un diálogo para asignarlos a los 4 cabezales (T1–T4).
  5. Muestra una lista de cambios y descarga `<nombre>-U1.3mf`.
- **Transformación del 3MF.** Parte de un 3MF de referencia exportado por Snapmaker Orca.
  1. **Identidad:** copia de la referencia `printer_settings_id`, `printer_model`, `printable_area`, `printable_height`, `nozzle_*`, `bed_exclude_area` y `version`. A `print_settings_id` le agrega " (converted)".
  2. **G-code:** reemplaza inicio, fin, cambio de capa, cambio de filamento y pausa (`M600`).
  3. **Filtro de claves:** conserva solo las claves que existen en la referencia y completa las faltantes con los valores de la referencia.
  4. **Arreglos varios:**
     - convierte las listas por extrusor en valores simples;
     - pasa `wall_filament`, `sparse_infill_filament` y `solid_infill_filament` de 0 a 1;
     - resuelve los centinelas -1;
     - traduce enumeraciones (`ensure_vertical_shell_thickness`, `tree_organic`).
  5. **Topes:** las velocidades y aceleraciones de la referencia actúan como máximo.
  6. **Filamentos:** reordena las listas de filamentos a 4 cabezales. No fusiona colores y deja los nombres de perfil de Bambu tal cual.
  7. **Posición:** suma unos +3,5 / +4 mm a todos los `transform`, sin recentrar, y solo en la primera placa.
  8. **Archivos:** borra G-code, `plate_N.json`, perfiles embebidos, `filament_sequence.json` y `cut_information.xml`. Agrega `plate_1.json`.

## 2. Diferencias entre `Cubo.3mf` (Bambu A1) y `Cubo-U1.3mf`

- **Geometría (`object_1.model`):** idéntica.
- **Posición:** el objeto se movió 7 mm en X y 8 mm en Y. Los desplazamientos de +3,5 y +4 se aplicaron a la vez en el componente y en el ítem.
- **`project_settings.config`:**
  - 582 claves → 556: se quitaron 204 claves exclusivas de Bambu y se agregaron 178 de Orca con valores por defecto.
  - Las listas de Bambu (`["300"]`) pasaron a valores simples (`"300"`).
  - Cambiaron la impresora, el área (0,5–270,5 × 1–271), la altura (270,05), la boquilla (`hardened_steel`, volumen 143) y los G-code de Klipper (`PRINT_START`, `SM_PRINT_*`).
  - Las velocidades bajaron: pared externa 200 → 150, desplazamiento 700 → 500, superficie superior 200 → 100.
  - `print_settings_id` pasó a "0.20mm Standard @BBL A1 (converted)" e `inherits_group` quedó vacío.
- **Filamentos:** con un solo color no se tocaron (`Bambu PLA Basic @BBL A1`).

## 3. Cómo abre Bambu Studio un 3MF

Fuente: `bbs_3mf.cpp`, `PresetBundle.cpp` y `Preset.cpp` de BambuStudio. Todo esto se verificó laminando con el Bambu Studio real.

- **Proyecto o geometría:** solo lee los ajustes si la metadata `Application` empieza con `BambuStudio-`. Si no, avisa "The 3mf is not from Bambu Lab, load geometry data only". Por eso un archivo de OrcaSlicer o Snapmaker Orca pierde colores y ajustes al abrirse directo.
- **Qué se toma del proyecto:** por cada perfil (proceso, filamentos, impresora), las claves que **no** figuran en `different_settings_to_system` se reemplazan por el valor del perfil de sistema con ese nombre. El conversor aprovecha esto:
  - escribe los nombres oficiales;
  - lista solo los ajustes traídos del original;
  - Bambu Studio completa todo lo demás con su versión instalada.
- **Placas:**
  - Se definen con `<plate>` en `model_settings.config`, y cada objeto pertenece a la placa en la que cae según su posición.
  - La grilla se separa 1/5 del ancho de la cama. Las columnas se calculan como `round(√n)`, más una si hace falta. Las filas crecen hacia −Y.
- **Pintado:** es la misma codificación hexadecimal en Bambu, Orca y PrusaSlicer hasta el estado 16. Desde el 17 PrusaSlicer usa otra, y el conversor la traduce.
- **Resultado laminando con el Bambu Studio real:** el archivo U1 original falla con "The selected printer is not compatible with the process preset in the 3mf". Todas las conversiones laminan sin errores.
