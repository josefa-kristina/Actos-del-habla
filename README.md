# Actos del habla

Ejercicio 03 del curso (DPPI 2026), sobre gesto, sonido y color. La idea es tomar una sola cámara y una sola mano, y usarlas para armar dos maneras completamente distintas de traducir lo mismo: una lo vuelve sonido, la otra lo vuelve color.

## De qué se trata

Hay dos sistemas corriendo al mismo tiempo, alimentados por la misma detección de mano. Ninguno de los dos muestra la imagen de la cámara tal cual — cada uno se queda solo con el dato que le importa y lo traduce a su manera.

**Sistema A — Seña → Sonido.** Usa MediaPipe Hands para encontrar los 21 puntos de la mano en cada frame y reconocer una seña entre seis posibles (ver tabla abajo). En vez de mostrar la mano tal cual, se dibuja una constelación de nodos y curvas orgánicas que respira levemente sola. Cuando una seña se sostiene el tiempo suficiente para confirmarse, dos cosas ocurren a la vez: la constelación se tiñe del color asociado a esa seña y suena una nota sintetizada (Web Audio API, sin samples externos) que le es propia. La seña se vuelve audible.

**Sistema B — Palabra → Color.** No reconoce dedos ni gestos: recibe la palabra que el Sistema A ya identificó y la trata como una intención semántica, no como una forma. Muestrea el video en una grilla de puntos cuyo tamaño depende del brillo de cada zona; sin ninguna seña reconocida, esos puntos aparecen desaturados — la escena "no dice nada". En cuanto hay una seña estable, el campo completo de puntos vira al color que le corresponde a la intención de esa palabra, con una transición suave de matiz y saturación.

## Gestos reconocidos

| Seña | Palabra | Intención | Color | Sonido |
|---|---|---|---|---|
| 🖐️ Palma abierta | Apertura | calma | `#5ce1ff` | sinusoide suave y sostenida (C4) |
| ✊ Puño cerrado | Tensión | fuerza | `#ff3a3a` | pulso cuadrado grave y corto (A2) |
| ✌️ Índice + medio | Dualidad | equilibrio | `#4ade80` | dos senos en tercera mayor (C4+E4) |
| ☝️ Solo índice | Nombrar | foco | `#ffd166` | ping agudo y breve (G5) |
| 👍 Pulgar arriba | Afirmación | positividad | `#ff8a5c` | arpegio ascendente (C4→E4→G4) |
| 🤏 Pellizco pulgar-índice | Retener | concentración | `#a78bfa` | tono con vibrato (A4, LFO 5 Hz) |

Una seña solo se confirma — y solo entonces dispara sonido y color — después de mantenerse estable durante varios frames seguidos, para evitar destellos por detecciones ruidosas.

## Cómo probarlo

El `index.html` no se puede abrir directo con doble clic porque el script usa módulos de JS. Hay que levantar un servidor local desde la carpeta, por ejemplo:

```
python3 -m http.server 8000
```

y entrar a `http://localhost:8000`. Va a pedir permiso de cámara y, al activar el audio, permiso implícito del navegador para reproducir sonido (se habilita con el primer clic en el botón "Cámara").

## Reflexión

Una sola escena, dos lecturas. El Sistema A pregunta por el gesto: ¿qué forma adopta la mano? No muestra la mano tal cual, sino los puntos y relaciones que la definen. Cuando reconoce una seña con certeza, emite un sonido: el gesto se vuelve audible.

El Sistema B no sabe de manos. Recibe una palabra — la que el Sistema A le asigna al gesto — y la interpreta como intención. Cada palabra carga una orientación semántica, y esa orientación se traduce en un color que tiñe la escena completa.

Austin nos recuerda que el lenguaje no solo describe: también *hace*. La palma abierta no representa apertura — la realiza. El puño no señala tensión — la ejerce. El Sistema B intenta hacer visible esa dimensión ilocutiva: la intención que el gesto porta más allá de su forma.

Pero el color no es la palabra, y la palabra no es el gesto. Cada representación es una traducción, y en cada traducción algo se pierde — y algo nuevo aparece.

## Tecnologías

MediaPipe Hand Landmarker (cargado desde CDN), Web Audio API para la síntesis de sonido (osciladores con envolvente y un reverb por convolución construido en código, sin samples externos) y Canvas 2D con JavaScript puro, sin frameworks ni build.
