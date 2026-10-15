# Race Robber — Fuga en Moto

Videojuego 2D con vista cenital al estilo GTA 1 para 1 o 2 jugadores. Una banda de ladrones en moto asalta el Banco Central de Ciudad Cobalto y huye de la policía, de una banda rival y de los mutantes de una tierra baldía. Al comienzo de cada nivel, una IA ("El Analista") estudia cómo manejas y ajusta ese mismo nivel: cuántos tipos de vehículos te persiguen, cuántos a la vez, cuántos obstáculos hay y cuánto falta para la meta.

## Cómo ejecutarlo

Requisitos: Node.js 18 o superior.

```bash
npm install
npm run dev        # servidor de desarrollo en http://localhost:5173
npm run build      # verificación de tipos + build de producción en dist/
npm run preview    # sirve el build de producción
```

## Historia y niveles

| Nivel | Perseguidores | Inicio → final |
|---|---|---|
| **0 — La Ruta del Polvo** (prólogo) | Tormenta de arena | Desierto → afueras → ciudad. Termina cuando la moto atraviesa la puerta del Banco Central. |
| **1 — El Golpe** | Policía: patrullas, motos, SUVs, SWAT y helicóptero | Explosión de la bóveda y salto por la puerta del banco → ciudad → puente del río. Termina al entrar al túnel de la montaña. |
| **2 — Territorio Enemigo** | Los Cuervos: muscle cars, moteros, pickups con tirador, tráileres, furgón blindado | Salida del túnel → zona industrial con contenedores y barricadas. Termina al entrar a la planta nuclear, que explota. |
| **3 — Tierra Baldía** | Saqueadores: buggies, mutantes a pie (con esqueleto articulado), harpías mutantes voladoras, moteros mutantes, camiones de guerra | Explosión verde y salto desde dentro de la planta → ruinas con zombis que cruzan la vía y charcos de ácido. Termina al cruzar la zona segura. |

| **∞ — Carretera Sin Fin** | Cualquier enemigo de los tres bandos | Sin meta. Zonas de 500–900 m que cambian bioma (desierto, ciudad, industrial, tierra baldía), iluminación (día, tarde, atardecer, noche, tóxico) y música; puentes o afueras unen las zonas. Cada zona suma tipos de enemigos, perseguidores y obstáculos. Se guarda el récord de distancia. |

Los niveles 0 a 3 terminan **por distancia**: el HUD muestra cuánto falta para la meta. Cada disparo que recibes te quita $2.500 del botín.

Desde **Seleccionar nivel** puedes empezar en cualquier nivel: cada uno calibra tu habilidad por su cuenta.

## Controles

| Acción | Jugador 1 | Jugador 2 |
|---|---|---|
| Acelerar / frenar-reversa | `W` / `S` | `↑` / `↓` |
| Girar | `A` / `D` | `←` / `→` |
| Turbo | `Espacio` o `Shift izq.` | `Shift der.` o `Enter` |

Con un solo jugador sirven ambos esquemas. `Esc`/`P` pausa, `M` silencia todo el sonido, `N` activa o desactiva la música y `-` / `+` cambian su volumen (también hay un control deslizante en el menú y en la pausa).

Modo cooperativo (mismo teclado): la cámara sigue a las dos motos. Si un jugador cae, reaparece a los 6 s junto a su compañero (cuesta $20.000). Si uno se queda muy atrás, se le trae de vuelta junto al otro.

## Música

La banda sonora es brutal death metal sintetizado en tiempo real con WebAudio (`src/core/Music.ts`), sin archivos de audio:

- Dos guitarras afinadas muy grave con distorsión, abiertas a izquierda y derecha: trémolo, *palm mutes* y acordes de quinta. El bajo dobla la tónica.
- Batería con blast beats, doble bombo, crash y china. Cada pieza se sintetiza una vez en un buffer para que el costo por golpe sea mínimo.
- Coro épico con reverberación en la historia de cada nivel, los *breakdowns* y la pantalla de victoria.
- **Menú principal:** una pieza tranquila en La menor, con arpegios de guitarra limpia, coro suave y percusión mínima.
- **Al morir:** cuando caen todas las motos, el metal se corta y entra un réquiem lento en Re menor (campana, coro trágico y timbal) que sigue en la pantalla de derrota.
- Los cambios de pieza tienen una transición suave.
- Cada nivel tiene su tonalidad, tempo (de 176 a 222 BPM) y escala (frigia, frigia dominante, locria, cromática). Los riffs se generan con semilla, así que se repiten como en una canción.
- La intensidad sigue a la acción: en calma suenan *chugs* y *breakdowns*; con muchos perseguidores, la tormenta cerca o la meta a la vista, entran los blast beats.

## La IA adaptativa

1. **`PerformanceTracker`** (`src/ai/PerformanceTracker.ts`) registra durante el nivel: choques, daño, obstáculos esquivados o golpeados, pasadas al límite, avance real (distancia por segundo), tiempo fuera de la vía o sobre aceite/arena, cambios de dirección y tiempo cerca del peligro (la tormenta o los perseguidores).
2. **`SkillClassifier`** (`src/ai/SkillClassifier.ts`) convierte esas métricas en un vector de 8 características normalizadas y calcula una habilidad entre 0 y 1 con un modelo lineal de pesos fijos y una sigmoide. Cada característica se compara contra la de un jugador promedio, y solo cuentan los obstáculos que estaban en tu trayectoria; así chocar seguido o avanzar poco baja el perfil aunque mantengas el acelerador. Según el resultado te clasifica como *Novato*, *Intermedio*, *Experto* o *Leyenda*. El HUD muestra la estimación en vivo.
3. **Calibración dentro de cada nivel.** Los primeros ~550 m de los niveles 1 a 3 funcionan como un nivel 0: hay obstáculos en densidad neutral y solo uno o dos perseguidores del tipo más básico. El nivel 0 completo es la calibración del prólogo.
4. **`AdaptiveDifficulty`** (`src/ai/AdaptiveDifficulty.ts`) aplica el resultado al mismo nivel, en caliente:
   - **Tipos de vehículo** habilitados: 1 para un novato y los 4 para un experto (más en los niveles avanzados).
   - **Perseguidores simultáneos**, frecuencia de refuerzos, agresividad y puntería.
   - **Cantidad de obstáculos** según la habilidad y qué tan bien esquivaste. Si vas rápido, hay más obstáculos duros (barreras, contenedores, chatarra) y, en la tierra baldía, más zombis.
   - **Distancia** hasta la meta (más larga para jugadores hábiles), retenes o barricadas y helicóptero policial.
5. Si pierdes, el reintento vuelve a calibrar desde cero.

### Cómo pasar a TensorFlow.js

El clasificador implementa la interfaz `SkillClassifier`, así que un modelo entrenado puede reemplazarlo sin tocar el resto del juego. Cada evaluación guarda su vector de características en `localStorage` (`racerober.save.v1` → `history`); ese historial sirve como dataset de entrenamiento. Para hacer el cambio:

```ts
import * as tf from '@tensorflow/tfjs';
class TfClassifier implements SkillClassifier {
  name = 'TF.js v1';
  constructor(private model: tf.LayersModel) {}
  predict(f: FeatureVector) {
    const x = tf.tensor2d([FEATURES.map((k) => f[k.key])]);
    return (this.model.predict(x) as tf.Tensor).dataSync()[0];
  }
}
```

## Arquitectura

```
src/
  main.ts                 Arranque: inicializa Rapier (WASM) y el juego
  core/                   Game (bucle y estados), Input, Audio y Music (WebAudio), Storage, Rng, math
  config/                 Tipos y configuración base de los niveles e historia
  ai/                     Métricas, clasificador de habilidad y dificultad adaptativa
  world/
    Physics.ts            Envoltura de Rapier: plano XZ, colisiones y raycasts
    Track.ts              Trazado curvo de la vía y biomas
    ChunkManager.ts       Generación procedural por tramos de 40 m (y su liberación)
    Level.ts              Una partida: calibración, reglas, colisiones, escenas, cámara
  entities/               Vehicle (controlador arcade), Player, Pursuer (IA de policía,
                          banda y mutantes), Flyer (harpías), Civilian, Helicopter,
                          Projectiles, Sandstorm
  fx/                     Modelos low-poly y partículas instanciadas
  ui/                     HUD y pantallas HTML/CSS
```

Notas técnicas:

- **Render:** Three.js con cámara en perspectiva mirando hacia abajo. Así los edificios ganan algo de paralaje, como en GTA 1.
- **Física:** Rapier 3D con la traslación en Y y las rotaciones bloqueadas. El juego ocurre en el plano XZ y todos los colliders tienen la misma altura física, así que los contactos siempre son horizontales.
- **Controlador arcade:** el acelerador cambia directamente la velocidad longitudinal, y el agarre solo amortigua la velocidad lateral. Por eso, sobre aceite la moto derrapa y conserva su inercia.
- **Mapa:** se genera por delante de los jugadores y se libera por detrás, lo que mantiene estable la cantidad de cuerpos físicos y mallas. Cada partida tiene un trazado distinto (frecuencias y amplitudes de curva aleatorias).
- **Contenido diferido:** el paisaje se crea con anticipación, pero los obstáculos, el tráfico, los zombis y los retenes aparecen cuando la moto está a ~85 m. Así nada los choca antes de que llegues, y los autos de los cruces se programan para atravesarse justo delante de ti.
- **Formaciones de obstáculos:** además del reparto suelto hay slaloms, muros con un hueco reservado, chicanes, derrames de carga, filas de autos estacionados, hordas de zombis y tramos de respiro. Los huecos siempre dejan paso.
- **Ciudad variable:** cruces a intervalos irregulares y parques o estacionamientos entre los edificios. En el desierto aparecen mesetas y oasis.

## Próximos pasos sugeridos

- Multijugador en red con Socket.IO y un servidor Node.js (hoy el modo para 2 jugadores es local).
- Entrenar el modelo de TF.js con el historial guardado.
- Soporte para gamepad (Gamepad API) y controles táctiles.
- Voces guturales y efectos de sonido grabados.
