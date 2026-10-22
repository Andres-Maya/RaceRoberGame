# Turbo Ratas — Robo, fuga y radiación

Videojuego 2D con vista cenital al estilo GTA 1, para 1 jugador o 2 en línea, en PC o celular. Las Turbo Ratas, una banda de ladrones a todo turbo, asaltan el Banco Central de Ciudad Cobalto y huyen de la policía, de una banda rival y de los mutantes de una tierra baldía. Al comienzo de cada nivel, una IA ("El Analista") estudia cómo manejas y ajusta ese mismo nivel: cuántos tipos de vehículos te persiguen, cuántos a la vez, cuántos obstáculos hay y cuánto falta para la meta.

## Cómo ejecutarlo

Requisitos: Node.js 20.19 o superior (Vite 8). El proyecto fija Node 22 para el despliegue.

```bash
npm install
npm run dev        # servidor de desarrollo en http://localhost:5173
npm run build      # verificación de tipos + build de producción en dist/
npm run preview    # sirve el build de producción
npm run lan        # compila y sirve el juego en la red local para jugar por IP (puerto 8080)
npm run dev:lan    # servidor de desarrollo visible en la red local (también admite la conexión por IP)
npm test           # pruebas automáticas (unos 10 s)
```

Las pruebas (`tests/`) corren la lógica real del juego en Node, con física y azar con semilla para que siempre den lo mismo: desbloqueos de vehículos, rampas (saltos normales, torcidos, rozones y que nunca se atraviesen), la réplica de la escena del modo en línea, los códigos QR de conexión y el servidor de red local.

### Desplegar en Vercel

El repositorio incluye `vercel.json`, así que al importarlo en Vercel la configuración se detecta sola:

| Parámetro | Valor |
|---|---|
| Framework Preset | Vite |
| Root Directory | `./` (la raíz del repositorio) |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Node.js Version | 22.x (tomada de `engines` en `package.json`) |
| Variables de entorno | Ninguna |

El juego es 100 % estático (HTML, CSS y JS; el WASM de Rapier va incrustado en el JS), así que no necesita funciones de servidor. Los archivos de `/assets` llevan caché de un año porque su nombre cambia en cada build. Desde Vercel funciona el modo en línea **por código**; el modo **por IP** necesita el servidor de red local (ver abajo).

## En línea · 2 jugadores

En el menú, **En línea** (tecla `5`). Un jugador crea la partida y el otro se une; cada uno juega con el vehículo de su propio garaje. El anfitrión elige el nivel y simula la partida completa; el invitado envía sus controles y recibe la escena, los efectos, los sonidos y el HUD unas 30 veces por segundo (~60–100 KB/s), así que los dos ven exactamente lo mismo. Las pantallas de historia, pausa y resultados del anfitrión aparecen también en el invitado.

| Modo | Cómo se conecta | Qué necesita |
|---|---|---|
| **Con código** | El anfitrión elige *Crear con código* y dicta el código de 5 letras; el otro elige *Unirse con código*. | Internet en ambos dispositivos solo para encontrarse (los datos del hotspot sirven). Después la partida va directo entre los dos (WebRTC); en un hotspot, por la red local. Funciona desde Vercel. |
| **Hotspot sin internet (QR)** | Un teléfono activa su hotspot (sin datos) y el otro se conecta a él. El anfitrión elige *Crear con QR* y muestra un código; el otro elige *Unirse con QR*, lo escanea y muestra el suyo, que el anfitrión escanea con *Escanear la respuesta*. Si no hay cámara, los códigos se pueden copiar y pegar como texto. | Solo los dos teléfonos en la misma red (hotspot o Wi-Fi). El juego debe estar guardado en ambos: ábrelo una vez con internet y toca **Instalar en este dispositivo** (o *Añadir a pantalla de inicio*). La cámara funciona en la versión https (Vercel). |
| **Por IP** | Un PC ejecuta `npm run lan` y muestra su dirección (por ejemplo `http://192.168.43.20:8080`). El anfitrión abre esa dirección y elige *Crear partida por IP*; el otro dispositivo, conectado al mismo Wi-Fi o hotspot, abre la misma dirección y elige *Unirse por IP*. | Misma red local, sin internet. Si alguien escribe la IP desde la versión de Vercel, el juego lo lleva a la dirección del anfitrión. |

Cada jugador tiene su propia cámara, que sigue a su vehículo y no se aleja aunque el compañero se separe. Si un jugador se queda más de 60 m atrás, lo **capturan**; si su vehículo es destruido, cae. En ambos casos su pantalla sigue al compañero, desaparecen los botones y las barras, y solo quedan la distancia recorrida y una cuenta regresiva de 10 s; luego reaparece junto al compañero (cuesta $20.000). Cuando el compañero queda fuera de la pantalla, en el borde aparece un círculo con la foto de su vehículo, una flecha que apunta hacia él y la distancia.

Si el invitado se desconecta a mitad de nivel, su vehículo sale de la carrera y el anfitrión sigue jugando; si se vuelve a conectar, entra en el siguiente nivel.

## Celular

**Instalar como app:** en el menú, **Instalar en este dispositivo** (aparece mientras el juego no esté instalado). Si el navegador ofrece la instalación directa, se abre su aviso; si no (iPhone, Firefox, Samsung Internet o un aviso que se cerró antes), muestra los pasos para ese navegador. Solo se puede instalar desde una dirección https (por ejemplo, la de Vercel), no desde `http://IP:8080`. Un *service worker* guarda el juego completo en el teléfono, así que después abre sin internet; con conexión, se actualiza solo a la última versión publicada.

El juego detecta la pantalla táctil y muestra controles en pantalla. El vehículo **va hacia donde apunta la bolita del joystick** (arriba = hacia arriba de la pantalla, derecha = hacia la derecha; si apunta hacia atrás, retrocede en esa dirección); al soltar el joystick deja de acelerar y se detiene. A la derecha están los botones de **TURBO** y **DISPARO** (apuntado automático); la pausa está abajo al centro. Al empezar a jugar pasa a pantalla completa en horizontal cuando el navegador lo permite. En celulares se dibuja a menor resolución y con sombras más livianas para mantener la fluidez.

## Historia y niveles

| Nivel | Perseguidores | Inicio → final |
|---|---|---|
| **0 — La Ruta del Polvo** (prólogo) | Tormenta de arena | Desierto → afueras → ciudad. Termina cuando la moto atraviesa la puerta del Banco Central. |
| **1 — El Golpe** | Policía: patrullas, motos, SUVs, SWAT con lanzagranadas y helicóptero | Explosión de la bóveda y salto por la puerta del banco → ciudad → puente del río. Termina al entrar al túnel de la montaña; al escapar, el helicóptero apaga el reflector, sube y se aleja. |
| **2 — Territorio Enemigo** | Los Cuervos: muscle cars, moteros que lanzan bombas, pickups con lanzagranadas, tráileres, furgón blindado | Salida del túnel → zona industrial con contenedores y barricadas. Termina al entrar a la planta nuclear, que explota. |
| **3 — Tierra Baldía** | Saqueadores: buggies, mutantes a pie (con esqueleto articulado), harpías mutantes que lanzan lluvia de ácido, incineradores con lanzallamas, moteros mutantes que lanzan bombas, camiones de guerra con lanzagranadas | Explosión verde y salto desde dentro de la planta → ruinas con zombis que cruzan la vía y charcos de ácido. Termina al cruzar la zona segura. |

| **∞ — Carretera Sin Fin** | Cualquier enemigo de los tres bandos | Sin meta. Zonas de 500–900 m que cambian bioma (desierto, ciudad, industrial, tierra baldía), iluminación (día, tarde, atardecer, noche, tóxico) y música; puentes o afueras unen las zonas. Cada zona suma tipos de enemigos, perseguidores y obstáculos. Se guarda el récord de distancia. |

Los niveles 0 a 3 terminan **por distancia**: el HUD muestra cuánto falta para la meta. Cada disparo que recibes te quita $2.500 del botín.

Un **círculo verde con una bandera a cuadros** en el borde de la pantalla (como el del compañero que sale de cámara) indica hacia dónde queda la meta, con una flecha y la distancia que falta: mientras está lejos sigue la carretera (útil en las curvas) y, cuando la meta ya está cerca, apunta a ella; al verla en pantalla rebota encima con el texto «META». En el nivel infinito no aparece.

El juego recuerda tu campaña. Al tocar **JUGAR** con una campaña empezada puedes elegir **Continuar** (vuelves al nivel en que quedaste, con el botín y el puntaje acumulados; si superaste un nivel y volviste al menú, al siguiente; tras ganar la campaña, al nivel infinito) o **Nueva partida** (empieza en el prólogo sin botín, conservando los niveles y vehículos desbloqueados). Desde **Seleccionar nivel** puedes empezar en cualquier nivel, y la campaña sigue desde ahí (el prólogo es una partida nueva); cada nivel calibra tu habilidad por su cuenta.

## Garaje

En el menú principal, **Garaje** (tecla `3`) muestra una tarjeta por vehículo con su foto (renderizada con el mismo modelo 3D del juego), su papel, barras de atributos y habilidades. Se elige con **Elegir** (o las teclas `1`–`7`) y la elección se guarda.

Se empieza con el **Cacharro**; cada uno de los demás se desbloquea con un objetivo distinto. Las tarjetas bloqueadas muestran el objetivo y el progreso (por ejemplo, «12/40»), y al conseguirlo aparece un aviso en la pantalla de resultados. En línea, el invitado también suma a su propio progreso.

| Vehículo | Papel | Vida | Punta con turbo | Balas (máx.) | Particularidades | Cómo se consigue |
|---|---|---|---|---|---|---|
| **Cacharro** (hatchback viejo) | Inicial | 170 | ~213 km/h | 60 | Fácil de manejar y resistente; cuatro ruedas | Desde el inicio |
| **Furia** (moto) | Equilibrada | 150 | ~219 km/h | 60 | Pequeña y ágil, cabe por cualquier hueco; salta las rampas hasta por la esquina | Superar el prólogo |
| **Relámpago** (deportivo) | Velocista | 110 | ~273 km/h | 50 | La mayor velocidad y aceleración; frágil y lento fuera del asfalto | Superar el nivel 1 |
| **Toro** (camioneta 4x4) | Tanque | 260 | ~180 km/h | 80 | Embestida ×2,2, casi no sufre fuera del asfalto, −10 % de daño de armas | Derribar 40 perseguidores en total |
| **Escorpión** (buggy) | Todoterreno | 140 | ~242 km/h | 60 | Sin penalización fuera del asfalto ni en la arena; salta más lejos en las rampas | Completar 15 saltos en rampas |
| **Bestia** (muscle car) | Clásico | 180 | ~263 km/h | 60 | Turbo potente que dura más; embestida ×1,6; derrapa | Superar el nivel 2 |
| **Bóveda** (furgón blindado) | Blindado | 340 | ~161 km/h | 100 | −35 % de daño de balas, explosiones, ácido y fuego; embestida ×2,6; muy lento | Ganar la campaña o recorrer 3 km en el nivel infinito |

Cada vehículo tiene además su propio tono de motor. La tormenta de arena del prólogo ajusta su ritmo al vehículo más lento para que siempre se pueda escapar de ella.

Al empezar cada nivel aparece una pantalla de carga con una llanta rodando mientras se construye el mundo y se preparan los gráficos.

## Controles

| Acción | Teclas |
|---|---|
| Acelerar / frenar-reversa | `W` / `S` o `↑` / `↓` |
| Girar | `A` / `D` o `←` / `→` |
| Turbo | `Espacio`, `Shift` o `Enter` |
| Disparar al objetivo más cercano | `F` o `Ctrl der.` |
| Celular | Joystick de dirección (el vehículo va hacia donde apunta), botones TURBO y DISPARO, pausa abajo al centro |

`Esc`/`P` pausa, `M` silencia todo el sonido, `N` activa o desactiva la música y `-` / `+` cambian su volumen.

### Sonido

En el menú principal, **Sonido** (tecla `4`) abre un apartado con volúmenes independientes. Cada control reproduce una muestra al moverlo, se guardan entre partidas y también están en la pausa:

| Canal | Qué controla |
|---|---|
| General | Todo el audio del juego |
| Música | La banda sonora |
| Motor del vehículo | El rugido del motor según la velocidad (cada vehículo con su tono) |
| Tus disparos | El arma del jugador |
| Enemigos | Sirenas y disparos |
| Choques y explosiones | Colisiones, vehículos destruidos y la planta nuclear |
| Interfaz | Cuenta regresiva, recompensas y avisos |

El modo de dos jugadores en el mismo teclado se retiró del menú para preparar el juego en línea. El nivel sigue admitiendo varios jugadores por dentro, que es la base del modo en línea.

## Música

Los navegadores no dejan que una página suene hasta que el jugador la toca o presiona una tecla. Al abrir, el juego intenta arrancar la música de todos modos (lo logra, por ejemplo, instalado como app); si el navegador lo bloquea, muestra **«Toca la pantalla para empezar»** y ese primer toque enciende la música del menú (la tecla no llega al menú, así que no empieza una partida sin querer).

La banda sonora es brutal death metal sintetizado en tiempo real con WebAudio (`src/core/Music.ts`), sin archivos de audio:

- Dos guitarras afinadas muy grave con distorsión, abiertas a izquierda y derecha: trémolo, *palm mutes* y acordes de quinta. El bajo dobla la tónica.
- Batería con blast beats, doble bombo, crash y china. Cada pieza se sintetiza una vez en un buffer para que el costo por golpe sea mínimo.
- Coro épico con reverberación en la historia de cada nivel, los *breakdowns* y la pantalla de victoria.
- **Menú principal:** una pieza tranquila en La menor, con arpegios de guitarra limpia, coro suave y percusión mínima.
- **Al morir:** cuando caen todas las motos, el metal se corta y entra un réquiem lento en Re menor (campana, coro trágico y timbal) que sigue en la pantalla de derrota.
- Los cambios de pieza tienen una transición suave.
- Cada nivel tiene su tonalidad, tempo (de 176 a 222 BPM) y escala (frigia, frigia dominante, locria, cromática). Los riffs se generan con semilla, así que se repiten como en una canción.
- La intensidad sigue a la acción: en calma suenan *chugs* y *breakdowns*; con muchos perseguidores, la tormenta cerca o la meta a la vista, entran los blast beats.

## Arma del vehículo

- **Auto-apuntado:** la tecla de disparo apunta sola al objetivo más cercano a la vista dentro de 45 m: perseguidores, harpías o bidones explosivos. Un anillo del color del jugador marca el objetivo.
- **Sin ratón:** durante la partida el cursor se oculta; se dispara con la tecla (o el botón DISPARO en celular) y el arma apunta sola.
- **Daño:** cada bala hace 20 de daño a los perseguidores, revienta zombis y hace estallar los bidones. Los mutantes a pie y los moteros mutantes aguantan 4 balas y las harpías 3. Las paredes las bloquean y los civiles solo se asustan.
- **Munición:** depende del vehículo (la moto empieza con 30 balas y lleva como máximo 60; el blindado, 50 y 100). Las cajas amarillas del camino dan +20, igual que las llaves verdes reparan y las latas azules llenan el turbo.

## Adrenalina

- **Barriles de combustible:** abundan en el camino. Estallan al chocarlos con algo de fuerza (tú o los enemigos) o si una bala los roza; y si apenas los tocas y los llevas empujando, también estallan en poco más de un segundo, avisando antes con chispas, humo, temblor y pitidos. Aprisionados contra un muro revientan enseguida. Encadenan a los barriles cercanos. La onda daña mucho a los perseguidores y poco a la moto (máximo ~16 de 150).
- **Explosiones en cadena:** cuando un perseguidor estalla, su onda daña y empuja a los que tiene al lado. Hay bola de fuego, columna, escombros, onda expansiva y temblor de cámara según la distancia.
- **Rampas:** saltas por encima de muros, obstáculos y autos (sin colisiones en el aire) y ganas 300 puntos y turbo. Siempre hay un hueco para rodear, por si prefieres no saltar. Se entra de frente y a más de 4 m/s; el salto siempre pasa la rampa completa y en el aire no se pierde velocidad. La **moto**, con una sola línea de ruedas, salta aunque tome la rampa por la esquina. Los vehículos de **cuatro ruedas** dependen de cuánto ancho sube: con el 80 % o más saltan normal; si solo sube un lado de llantas, hacen un **salto torcido** (vuelan más bajo, se inclinan hacia el lado que quedó fuera, salen empujados y girados hacia ese lado y aterrizan duro: pierden velocidad y algo de vida); si apenas rozan la esquina, se llevan un **rozón** que los desvía y gira sin frenarlos en seco. La rampa es sólida: quien la toma de lado, la cruza por delante, la roza apenas o llega casi detenido choca con ella, y los perseguidores y el tráfico la esquivan como a un muro.
- **Granadas y bombas:** algunos enemigos las lanzan en arco. Un anillo rojo o naranja parpadea en el suelo donde van a caer, así que se pueden esquivar. Su onda también daña a otros enemigos.
- **Lluvia de ácido:** las harpías dejan caer gotas de ácido verde, marcadas en el suelo, que salpican y dejan charcos que queman unos segundos.
- **Lanzallamas:** los incineradores queman a corta distancia por delante, en ráfagas, y su fuego también hace estallar barriles y quema zombis.
- **Estética tóxica:** en la tierra baldía todas las explosiones, el humo y el fuego son verdes.
- **Combos:** derribar perseguidores seguidos (menos de 3,5 s entre uno y otro) da puntos extra, turbo y un poco de vida. Si caen dos o más casi a la vez, entra un breve **tiempo bala**.

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
  net/                    En línea: Link (código con PeerJS/WebRTC e IP con WebSocket), QrLink (hotspot sin
                          internet: WebRTC con la oferta y la respuesta comprimidas en códigos QR),
                          SceneSync (réplica de la escena), HostSync y GuestView, protocolo
  core/                   Game (bucle y estados), Input, Audio y Music (WebAudio), Storage, Rng, math
  config/                 Tipos y configuración base de los niveles e historia; vehicles.ts (garaje)
  ai/                     Métricas, clasificador de habilidad y dificultad adaptativa
  world/
    Physics.ts            Envoltura de Rapier: plano XZ, colisiones y raycasts
    Track.ts              Trazado curvo de la vía y biomas
    ChunkManager.ts       Generación procedural por tramos de 40 m (y su liberación)
    Level.ts              Una partida: calibración, reglas, colisiones, escenas, cámara
    Jumps.ts              Rampas y saltos: despegue, salto torcido, rozones, vuelo y aterrizaje
    CameraRig.ts          Cámara cenital que sigue al vehículo de cada jugador
  entities/               Vehicle (controlador arcade), Player, Pursuer (IA de policía,
                          banda y mutantes), Flyer (harpías), Civilian, Helicopter,
                          Projectiles, Sandstorm
  fx/                     Modelos low-poly y partículas instanciadas
  ui/                     HUD, pantallas HTML/CSS, fotos del garaje (Thumbnails), pantalla de carga
                          (Loader) y controles táctiles (Touch)
server/lan.mjs            Servidor de red local: sirve dist/ y une anfitrión e invitado por WebSocket
pwa/sw.js                 Service worker (el build le agrega la lista de archivos) para jugar sin internet
public/                   Manifiesto de la app instalable e íconos
tests/                    Pruebas automáticas (npm test)
```

Notas técnicas:

- **Render:** Three.js con cámara en perspectiva mirando hacia abajo. Así los edificios ganan algo de paralaje, como en GTA 1.
- **Física:** Rapier 3D con la traslación en Y y las rotaciones bloqueadas. El juego ocurre en el plano XZ y todos los colliders tienen la misma altura física, así que los contactos siempre son horizontales.
- **Controlador arcade:** el acelerador cambia directamente la velocidad longitudinal, y el agarre solo amortigua la velocidad lateral. Por eso, sobre aceite la moto derrapa y conserva su inercia.
- **Mapa:** se genera por delante de los jugadores y se libera por detrás, lo que mantiene estable la cantidad de cuerpos físicos y mallas. Cada partida tiene un trazado distinto (frecuencias y amplitudes de curva aleatorias).
- **Contenido diferido:** el paisaje se crea con anticipación, pero los obstáculos, el tráfico, los zombis y los retenes aparecen cuando la moto está a ~85 m. Así nada los choca antes de que llegues, y los autos de los cruces se programan para atravesarse justo delante de ti.
- **Formaciones de obstáculos:** además del reparto suelto hay slaloms, muros con un hueco reservado, chicanes, derrames de carga, filas de autos estacionados, hordas de zombis y tramos de respiro. Los huecos siempre dejan paso.
- **Río:** bajo los puentes hay agua de verdad: los enemigos terrestres que caen en ella se hunden (y cuentan como derribados), y los mutantes nunca aparecen sobre el río. Los extremos del puente están cerrados para que nadie rodee la baranda; si aun así la moto toca el agua, cae al río (−30) y vuelve al puente.
- **Réplica en línea:** el anfitrión recorre su escena y envía solo lo que cambió: objetos nuevos (con su geometría y material la primera vez), posiciones, visibilidad, materiales y luces. Las partículas no viajan: el invitado repite las llamadas a los efectos con su propio sistema. Los mensajes grandes se parten en fragmentos de 16 KB, y el HTML de las pantallas que llega al invitado se limpia antes de mostrarse.
- **Ciudad variable:** cruces a intervalos irregulares y parques o estacionamientos entre los edificios. En el desierto aparecen mesetas y oasis.

## Próximos pasos sugeridos

- Servidor TURN propio para conectar por código entre redes muy restrictivas.
- Entrenar el modelo de TF.js con el historial guardado.
- Soporte para gamepad (Gamepad API).
- Voces guturales y efectos de sonido grabados.
