# Race Robber — Fuga en Moto

Videojuego 2D con vista cenital al estilo GTA 1 para 1 o 2 jugadores. Una banda de ladrones en moto cruza el desierto, asalta el Banco Central de Ciudad Cobalto y escapa de la policía. Durante el nivel 0, una IA ("El Analista") estudia cómo manejas y, con eso, adapta los obstáculos y la duración de los niveles 1, 2 y 3.

## Cómo ejecutarlo

Requisitos: Node.js 18 o superior.

```bash
npm install
npm run dev        # servidor de desarrollo en http://localhost:5173
npm run build      # verificación de tipos + build de producción en dist/
npm run preview    # sirve el build de producción
```

## Historia y niveles

| Nivel | Escenario | Qué pasa |
|---|---|---|
| **0 — La Ruta del Polvo** | Desierto → afueras → ciudad | Esquivas rocas, cactus, barriles y rodadoras mientras una tormenta de arena te persigue. Cuando la IA está terminando su análisis llegas a la ciudad, y el nivel termina cuando la moto atraviesa la puerta del Banco Central. |
| **1 — El Golpe** | Ciudad (tarde) | Arranca con la explosión de la bóveda: la moto sale del banco con un salto. Las patrullas te persiguen, te embisten y algunos agentes disparan. |
| **2 — Avenida en Llamas** | Ciudad (atardecer) | Se suman motos policiales y SUVs, aparecen retenes y hay más obstáculos. |
| **3 — Último Cerco** | Ciudad (anochecer) → desierto | Llegan furgonetas SWAT, un helicóptero con reflector y más retenes. El último tramo vuelve al desierto. |

En los niveles 1 a 3 ganas si sigues vivo cuando el cronómetro llega a cero. Cada disparo que recibes te quita $2.500 del botín.

Desde **Seleccionar nivel** puedes empezar en cualquier nivel. Si todavía no hay un perfil de la IA, los niveles 1 a 3 usan dificultad media.

## Controles

| Acción | Jugador 1 | Jugador 2 |
|---|---|---|
| Acelerar / frenar-reversa | `W` / `S` | `↑` / `↓` |
| Girar | `A` / `D` | `←` / `→` |
| Turbo | `Espacio` o `Shift izq.` | `Shift der.` o `Enter` |

Con un solo jugador sirven ambos esquemas. `Esc`/`P` pausa y `M` silencia el sonido.

Modo cooperativo (mismo teclado): la cámara sigue a las dos motos. Si un jugador cae, reaparece a los 6 s junto a su compañero (cuesta $20.000). Si uno se queda muy atrás, se le trae de vuelta junto al otro.

## La IA adaptativa

1. **`PerformanceTracker`** (`src/ai/PerformanceTracker.ts`) registra durante el nivel: choques, daño, obstáculos esquivados o golpeados, pasadas al límite, avance real (distancia por segundo), tiempo fuera de la vía o sobre aceite/arena, cambios de dirección y tiempo cerca del peligro (la tormenta o la policía).
2. **`SkillClassifier`** (`src/ai/SkillClassifier.ts`) convierte esas métricas en un vector de 8 características normalizadas y calcula una habilidad entre 0 y 1 con un modelo lineal de pesos fijos y una sigmoide. Cada característica se compara contra la de un jugador promedio, y solo cuentan los obstáculos que estaban en tu trayectoria; así chocar seguido o avanzar poco baja el perfil aunque mantengas el acelerador. Según el resultado te clasifica como *Novato*, *Intermedio*, *Experto* o *Leyenda*. Durante el nivel 0 el HUD muestra la estimación en vivo.
3. **`AdaptiveDifficulty`** (`src/ai/AdaptiveDifficulty.ts`) usa ese perfil para generar la configuración de los niveles 1 a 3:
   - **Duración** de cada nivel (más larga para jugadores hábiles).
   - **Densidad de obstáculos** según la habilidad y qué tan bien esquivas.
   - **Distribución de obstáculos**: si vas rápido, hay más obstáculos duros (barreras, chatarra); si vas lento, más blandos (conos, cajas).
   - Tráfico civil, número y tipo de patrullas, agresividad, puntería, retenes y helicóptero.
4. Después de cada nivel el perfil se **reajusta** mezclándolo con el desempeño reciente. Si pierdes un nivel, el reintento es un poco más fácil.

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
  core/                   Game (bucle y estados), Input, Audio (WebAudio), Storage, Rng, math
  config/                 Tipos y configuración base de los niveles e historia
  ai/                     Métricas, clasificador de habilidad y dificultad adaptativa
  world/
    Physics.ts            Envoltura de Rapier: plano XZ, colisiones y raycasts
    Track.ts              Trazado curvo de la vía y biomas
    ChunkManager.ts       Generación procedural por tramos de 40 m (y su liberación)
    Level.ts              Una partida: reglas, colisiones, policía, cámara
  entities/               Vehicle (controlador arcade), Player, Police (IA), Civilian,
                          Helicopter, Projectiles, Sandstorm
  fx/                     Modelos low-poly y partículas instanciadas
  ui/                     HUD y pantallas HTML/CSS
```

Notas técnicas:

- **Render:** Three.js con cámara en perspectiva mirando hacia abajo. Así los edificios ganan algo de paralaje, como en GTA 1.
- **Física:** Rapier 3D con la traslación en Y y las rotaciones bloqueadas. El juego ocurre en el plano XZ y todos los colliders tienen la misma altura física, así que los contactos siempre son horizontales.
- **Controlador arcade:** el acelerador cambia directamente la velocidad longitudinal, y el agarre solo amortigua la velocidad lateral. Por eso, sobre aceite la moto derrapa y conserva su inercia.
- **Mapa:** se genera por delante de los jugadores y se libera por detrás, lo que mantiene estable la cantidad de cuerpos físicos y mallas.

## Próximos pasos sugeridos

- Multijugador en red con Socket.IO y un servidor Node.js (hoy el modo para 2 jugadores es local).
- Entrenar el modelo de TF.js con el historial guardado.
- Soporte para gamepad (Gamepad API) y controles táctiles.
- Efectos de sonido grabados y música.
