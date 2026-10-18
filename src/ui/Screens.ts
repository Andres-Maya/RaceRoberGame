import type { PerformanceMetrics } from '../ai/PerformanceTracker';
import { FEATURES, type SkillProfile } from '../ai/SkillClassifier';
import type { LevelConfig } from '../config/types';
import { isUnlocked, VEHICLES, vehicleById, vehicleStats, type VehicleId } from '../config/vehicles';
import type { SoundChannel, Volumes } from '../core/Audio';
import type { Input } from '../core/Input';
import { formatMoney, formatTime } from '../core/math';
import type { SaveData } from '../core/Storage';
import { PLAYER_COLORS } from '../entities/Player';
import { vehicleThumbnails } from './Thumbnails';

type Action = () => void;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Pantallas superpuestas en HTML: menú, historia, resultados, pausa... */
export class Screens {
  private el = document.querySelector('#screen') as HTMLElement;
  private actions = new Map<string, Action>();
  private keys: [string[], string][] = [];
  /** Recibe canal y volumen (0..1) cuando se mueve un control deslizante. */
  onVolume: ((channel: SoundChannel, v: number) => void) | null = null;

  constructor() {
    this.el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (t?.dataset.action) this.run(t.dataset.action);
    });
    this.el.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      const channel = t.dataset.volume as SoundChannel | undefined;
      if (!channel) return;
      const v = Number(t.value) / 100;
      this.showVolume(channel, v);
      this.onVolume?.(channel, v);
    });
  }

  /** Controles deslizantes de todos los canales de sonido. */
  private soundSliders(volumes: Volumes): string {
    const rows: [SoundChannel, string, string][] = [
      ['master', 'Volumen general', ''],
      ['music', 'Música', '<kbd>-</kbd> <kbd>+</kbd>'],
      ['engine', 'Motor del vehículo', ''],
      ['player', 'Tus disparos', ''],
      ['enemies', 'Enemigos', 'sirenas y disparos'],
      ['impacts', 'Choques y explosiones', ''],
      ['ui', 'Interfaz', 'avisos y recompensas'],
    ];
    return `<div class="sound-grid">${rows
      .map(
        ([ch, label, hint]) => `<label class="volume${ch === 'master' ? ' master' : ''}">
        <span>${label}${hint ? ` <small class="muted">${hint}</small>` : ''}</span>
        <input type="range" min="0" max="100" step="5" value="${Math.round(volumes[ch] * 100)}" data-volume="${ch}" />
        <b data-volume-label="${ch}">${Math.round(volumes[ch] * 100)}%</b>
      </label>`,
      )
      .join('')}</div>`;
  }

  /** Actualiza un control si está en pantalla (p. ej. al cambiar el volumen con el teclado). */
  showVolume(channel: SoundChannel, v: number): void {
    const input = this.el.querySelector<HTMLInputElement>(`input[data-volume="${channel}"]`);
    const label = this.el.querySelector<HTMLElement>(`[data-volume-label="${channel}"]`);
    if (input && document.activeElement !== input) input.value = String(Math.round(v * 100));
    if (label) label.textContent = `${Math.round(v * 100)}%`;
  }

  /** Apartado de sonido: volumen por canal, música y silencio. */
  sound(save: SaveData, a: { back: Action; music: Action; mute: Action }): void {
    this.show(
      `<h2>Sonido</h2>
      <p class="muted">Cada control reproduce una muestra al moverlo.</p>
      ${this.soundSliders(save.volumes)}
      <div class="menu-buttons">
        <button data-action="music">${save.musicOn ? 'Música: death metal' : 'Música: apagada'} <kbd>N</kbd></button>
        <button data-action="mute">${save.muted ? 'Sonido: silenciado' : 'Sonido: activado'} <kbd>M</kbd></button>
        <button data-action="back" class="primary">Volver <kbd>Esc</kbd></button>
      </div>`,
      a,
      [
        [['Escape', 'Backspace'], 'back'],
        [['KeyN'], 'music'],
        [['KeyM'], 'mute'],
      ],
    );
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  private run(id: string): void {
    this.actions.get(id)?.();
  }

  private show(html: string, actions: Record<string, Action>, keys: [string[], string][] = [], variant = ''): void {
    this.el.className = `screen ${variant}`;
    this.el.innerHTML = `<div class="panel">${html}</div>`;
    this.actions = new Map(Object.entries(actions));
    this.keys = keys;
  }

  hide(): void {
    this.el.className = 'screen hidden';
    this.el.innerHTML = '';
    this.actions.clear();
    this.keys = [];
  }

  /** Atajos de teclado de la pantalla activa. */
  handleKeys(input: Input): void {
    if (!this.visible) return;
    for (const [codes, id] of this.keys) {
      if (input.wasPressed(...codes)) {
        this.run(id);
        return;
      }
    }
  }

  // ------------------------------------------------------------ menú

  menu(save: SaveData, a: { one: Action; two: Action; select: Action; garage: Action; controls: Action; stats: Action; sound: Action; mute: Action; music: Action }): void {
    this.show(
      `
      <div class="logo">
        <div class="logo-top">RACE</div>
        <div class="logo-main">ROBBER</div>
        <div class="logo-sub">Fuga en moto · Ciudad Cobalto</div>
      </div>
      <p class="tagline">Un golpe al Banco Central. Tres niveles de persecución. Una IA que estudia cómo manejas.</p>
      <div class="menu-buttons">
        <button data-action="one" class="primary">1 JUGADOR <kbd>1</kbd></button>
        <button data-action="two">2 JUGADORES · mismo teclado <kbd>2</kbd></button>
        <button data-action="select">SELECCIONAR NIVEL <kbd>3</kbd></button>
        <button data-action="garage">GARAJE <kbd>5</kbd> <small>J1: ${esc(vehicleById(save.vehicles[0]).name)} · J2: ${esc(vehicleById(save.vehicles[1]).name)}</small></button>
        <button data-action="controls">CONTROLES</button>
        <button data-action="stats">PERFIL DE LA IA Y ESTADÍSTICAS</button>
        <button data-action="sound">SONIDO <kbd>4</kbd> <small>${save.muted ? '(silenciado)' : `general ${Math.round(save.volumes.master * 100)}% · música ${save.musicOn ? `${Math.round(save.volumes.music * 100)}%` : 'apagada'}`}</small></button>
      </div>
      <div class="footer">Mejor puntaje: ${save.bestScore.toLocaleString('es-CO')} · Botín récord: ${formatMoney(save.bestCash)} · Récord infinito: ${(save.bestEndless / 1000).toFixed(2)} km</div>`,
      a,
      [
        [['Digit1', 'Numpad1', 'Enter'], 'one'],
        [['Digit2', 'Numpad2'], 'two'],
        [['Digit3', 'Numpad3'], 'select'],
        [['Digit4', 'Numpad4'], 'sound'],
        [['Digit5', 'Numpad5'], 'garage'],
        [['KeyM'], 'mute'],
        [['KeyN'], 'music'],
      ],
      'menu',
    );
  }

  levelSelect(save: SaveData, start: (level: number, players: number) => void, back: Action): void {
    const names = ['La Ruta del Polvo', 'El Golpe', 'Territorio Enemigo', 'Tierra Baldía', 'Carretera Sin Fin'];
    const rows = names
      .map(
        (n, i) => `<div class="level-row">
          <div><b>Nivel ${i === 4 ? '∞' : i}</b> — ${n}${i === 4 ? ` <small class="muted">(récord ${(save.bestEndless / 1000).toFixed(2)} km)</small>` : ''}</div>
          <div><button data-action="l${i}p1">1 jugador</button><button data-action="l${i}p2">2 jugadores</button></div>
        </div>`,
      )
      .join('');
    const actions: Record<string, Action> = { back };
    for (let i = 0; i < 5; i++) {
      actions[`l${i}p1`] = () => start(i, 1);
      actions[`l${i}p2`] = () => start(i, 2);
    }
    const prof =
      'Cada nivel empieza con una fase de calibración: El Analista mide tu habilidad en los primeros metros y ajusta ese mismo nivel.' +
      (save.profile ? ` Último perfil: <b>${save.profile.tier}</b> (${Math.round(save.profile.skill * 100)}%).` : '');
    this.show(`<h2>Seleccionar nivel</h2><p class="muted">${prof}</p>${rows}<div class="menu-buttons"><button data-action="back" class="ghost">Volver <kbd>Esc</kbd></button></div>`, actions, [[['Escape', 'Backspace'], 'back']]);
  }

  /**
   * Garaje: una tarjeta por vehículo con su foto, atributos y habilidades.
   * Cada jugador elige el suyo; los bloqueados muestran cómo conseguirlos.
   */
  garage(save: SaveData, pick: (player: number, id: VehicleId) => void, back: Action): void {
    const photos = vehicleThumbnails(VEHICLES.map((v) => v.id));
    const cards = VEHICLES.map((v, i) => {
      const locked = !isUnlocked(v, save);
      const bars = vehicleStats(v)
        .map((st) => `<div class="vstat"><span>${st.label}</span><div class="bar"><div class="fill" style="width:${Math.round(st.value * 100)}%"></div></div></div>`)
        .join('');
      const facts = [
        ['Vida', String(v.hp)],
        ['Punta', `${Math.round(v.spec.maxSpeed * v.turboMul * 4.6)} km/h`],
        ['Balas', String(v.ammoMax)],
      ]
        .map(([k, val]) => `<div><b>${val}</b><span>${k}</span></div>`)
        .join('');
      return `<article class="vcard${locked ? ' locked' : ''}" data-vehicle="${v.id}">
        <div class="vphoto">
          ${photos[v.id] ? `<img src="${photos[v.id]}" alt="${esc(v.name)}" draggable="false" />` : ''}
          <div class="vbadges"><span class="vbadge" data-badge="0" style="--pc:${PLAYER_COLORS[0].css}">J1</span><span class="vbadge" data-badge="1" style="--pc:${PLAYER_COLORS[1].css}">J2</span></div>
          ${locked ? `<div class="vlock"><b>BLOQUEADO</b><span>${esc(v.unlock!.text)}</span></div>` : ''}
        </div>
        <div class="vhead"><h3>${esc(v.name)}</h3><span class="vrole">${esc(v.role)}</span><kbd>${i + 1}</kbd></div>
        <p class="vdesc">${esc(v.description)}</p>
        <div class="vfacts">${facts}</div>
        <div class="vstats">${bars}</div>
        <ul class="vperks">${v.perks.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        <div class="vbuttons">
          <button data-action="p0-${v.id}" style="--pc:${PLAYER_COLORS[0].css}"${locked ? ' disabled' : ''}>Elegir J1</button>
          <button data-action="p1-${v.id}" style="--pc:${PLAYER_COLORS[1].css}"${locked ? ' disabled' : ''}>Elegir J2</button>
        </div>
      </article>`;
    }).join('');

    const selected = [...save.vehicles];
    const mark = () => {
      this.el.querySelectorAll<HTMLElement>('.vcard').forEach((card) => {
        const id = card.dataset.vehicle;
        [0, 1].forEach((pl) => {
          const on = selected[pl] === id;
          card.querySelector(`[data-badge="${pl}"]`)?.classList.toggle('on', on);
          card.querySelector(`[data-action="p${pl}-${id}"]`)?.classList.toggle('chosen', on);
        });
        card.classList.toggle('sel0', selected[0] === id);
        card.classList.toggle('sel1', selected[1] === id);
      });
    };
    const actions: Record<string, Action> = { back };
    const keys: [string[], string][] = [[['Escape', 'Backspace', 'Enter'], 'back']];
    VEHICLES.forEach((v, i) => {
      for (const pl of [0, 1]) {
        actions[`p${pl}-${v.id}`] = () => {
          if (!isUnlocked(v, save)) return;
          selected[pl] = v.id;
          pick(pl, v.id);
          mark();
        };
      }
      keys.push([[`Digit${i + 1}`, `Numpad${i + 1}`], `p0-${v.id}`]);
    });
    this.show(
      `<h2>Garaje</h2>
      <p class="muted">Cada vehículo tiene su propia vida, velocidad, munición y habilidades. Teclas <kbd>1</kbd>–<kbd>6</kbd>: vehículo del jugador 1.</p>
      <div class="garage-grid">${cards}</div>
      <div class="menu-buttons"><button data-action="back" class="primary">Listo <kbd>Esc</kbd></button></div>`,
      actions,
      keys,
      'garage',
    );
    mark();
  }

  controls(back: Action): void {
    this.show(
      `<h2>Controles</h2>
      <div class="controls-grid">
        <div class="ctrl-card" style="--pc:#ff4d4d">
          <h3>Jugador 1</h3>
          <p><kbd>W</kbd> acelerar · <kbd>S</kbd> frenar / reversa</p>
          <p><kbd>A</kbd> <kbd>D</kbd> girar</p>
          <p><kbd>Espacio</kbd> / <kbd>Shift izq.</kbd> turbo</p>
          <p><kbd>F</kbd> disparar al más cercano · <b>clic izquierdo</b> disparar donde apunta la mira</p>
        </div>
        <div class="ctrl-card" style="--pc:#4d9dff">
          <h3>Jugador 2</h3>
          <p><kbd>↑</kbd> acelerar · <kbd>↓</kbd> frenar / reversa</p>
          <p><kbd>←</kbd> <kbd>→</kbd> girar</p>
          <p><kbd>Shift der.</kbd> / <kbd>Enter</kbd> turbo</p>
          <p><kbd>Ctrl der.</kbd> / <kbd>.</kbd> disparar al más cercano</p>
        </div>
      </div>
      <p class="muted">Con un solo jugador puedes usar cualquiera de los dos esquemas. <kbd>Esc</kbd> / <kbd>P</kbd> pausa · <kbd>M</kbd> silencio · <kbd>N</kbd> música · <kbd>-</kbd> <kbd>+</kbd> volumen de la música.</p>
      <ul class="tips">
        <li>Fuera del asfalto en el desierto se pierde velocidad (el buggy Escorpión no se frena ni en la arena).</li>
        <li>En el garaje eliges vehículo: la moto es ágil, el deportivo vuela pero es frágil, la camioneta y el blindado aguantan y destrozan al embestir.</li>
        <li>Manchas negras = aceite (derrapas). Tiras metálicas = púas (pinchazo).</li>
        <li>Los perseguidores que chocan fuerte contra muros u obstáculos quedan fuera de combate.</li>
        <li>Charcos verdes = ácido (daño continuo). Los zombis cruzan la vía: si los atropellas, te frenan.</li>
        <li>Las harpías se lanzan en picada: esquívalas o embístelas con turbo a toda velocidad para derribarlas. Su lluvia de ácido deja charcos que queman.</li>
        <li>Un anillo parpadeante en el suelo marca dónde caerá una granada, bomba o gota de ácido: sal de ahí.</li>
        <li>La munición es limitada (el máximo depende del vehículo): recógela en las cajas amarillas del camino. Disparar a un bidón rojo lo hace estallar.</li>
        <li>Los barriles rojos explotan: atrae a los perseguidores hacia ellos. Los incineradores queman de frente: no te quedes delante.</li>
        <li>Cada disparo que recibes rompe la mochila: pierdes $2.500 del botín.</li>
      </ul>
      <div class="menu-buttons"><button data-action="back" class="primary">Volver <kbd>Esc</kbd></button></div>`,
      { back },
      [[['Escape', 'Enter', 'Backspace'], 'back']],
    );
  }

  stats(save: SaveData, back: Action, reset: Action): void {
    const p = save.profile;
    const hist = save.history
      .slice(-8)
      .reverse()
      .map((r) => `<tr><td>${new Date(r.date).toLocaleDateString('es-CO')}</td><td>Nivel ${r.level}</td><td>${r.players}J</td><td>${Math.round(r.skill * 100)}%</td></tr>`)
      .join('');
    this.show(
      `<h2>Perfil de la IA</h2>
      ${p ? this.profileBlock(p) : '<p class="muted">Aún no hay perfil: juega cualquier nivel para que El Analista te evalúe.</p>'}
      <div class="stat-grid">
        <div><b>${save.runs}</b><span>niveles jugados</span></div>
        <div><b>${save.victories}</b><span>fugas exitosas</span></div>
        <div><b>${save.bestScore.toLocaleString('es-CO')}</b><span>mejor puntaje</span></div>
        <div><b>${formatMoney(save.bestCash)}</b><span>botín récord</span></div>
      </div>
      ${hist ? `<h3>Últimas evaluaciones</h3><table class="hist"><tr><th>Fecha</th><th>Nivel</th><th>Modo</th><th>Habilidad</th></tr>${hist}</table>` : ''}
      <p class="muted small">Cada evaluación guarda su vector de características en localStorage: es el dataset para entrenar más adelante un modelo con TensorFlow.js.</p>
      <div class="menu-buttons"><button data-action="back" class="primary">Volver <kbd>Esc</kbd></button><button data-action="reset" class="ghost danger">Borrar progreso</button></div>`,
      { back, reset },
      [[['Escape', 'Enter', 'Backspace'], 'back']],
    );
  }

  private profileBlock(p: SkillProfile): string {
    const bars = FEATURES.map(
      (f) => `<div class="feat"><span>${f.label}</span><div class="bar"><div class="fill" style="width:${Math.round(p.features[f.key] * 100)}%"></div></div><em>${Math.round(p.features[f.key] * 100)}</em></div>`,
    ).join('');
    return `<div class="profile">
      <div class="tier tier-${p.tier.toLowerCase()}">${p.tier}<small>${Math.round(p.skill * 100)}% de habilidad · ${esc(p.classifier)}</small></div>
      <div class="feats">${bars}</div>
    </div>`;
  }

  // ------------------------------------------------------------ juego

  intro(cfg: LevelConfig, players: number, vehicles: string[], start: Action, back: Action): void {
    const story = cfg.intro.map((t) => `<p>${esc(t)}</p>`).join('');
    const notes = cfg.adaptiveNotes.length
      ? `<div class="ai-notes"><h3>El Analista ajustó este nivel</h3><ul>${cfg.adaptiveNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`
      : '';
    const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
    const target = { bank: 'el Banco Central', tunnel: 'el túnel del puente', plant: 'la planta nuclear', safeZone: 'la zona segura', none: '' }[cfg.finish];
    const goal =
      cfg.index === 4
        ? `No hay meta: cada zona cambia el paisaje, la luz y los enemigos (de cualquier bando) y es más difícil que la anterior. Los primeros <b>${cfg.calibration} m</b> son de calibración. Récord a batir: distancia recorrida.`
        : cfg.index === 0
        ? `Recorre <b>${km(cfg.distance)}</b> hasta ${target}. La IA te observará todo el camino.`
        : `Llega a ${target}: unos <b>${km(cfg.distance)}</b>. Los primeros <b>${cfg.calibration} m</b> son de calibración: El Analista medirá tu habilidad y ajustará en este mismo nivel los tipos de vehículos, cuántos te persiguen, los obstáculos y la distancia.`;
    this.show(
      `<div class="level-tag">${cfg.index === 0 ? 'PRÓLOGO' : cfg.index === 4 ? 'NIVEL INFINITO' : `NIVEL ${cfg.index} DE 3`}</div>
      <h1>${esc(cfg.name.split('—')[1]?.trim() ?? cfg.name)}</h1>
      <div class="story">${story}</div>
      <p class="goal">${goal} ${players > 1 ? '<br><span class="muted">Cooperativo: si un compañero cae, vuelve a los 6 s mientras el otro siga vivo.</span>' : ''}</p>
      <p class="muted small">Vehículo: ${vehicles
        .slice(0, players)
        .map((id, i) => `<b style="color:${PLAYER_COLORS[i].css}">${esc(vehicleById(id).name)}</b>${players > 1 ? ` (J${i + 1})` : ''}`)
        .join(' · ')} — cámbialo en el garaje del menú.</p>
      ${notes}
      <div class="menu-buttons"><button data-action="start" class="primary">¡VAMOS! <kbd>Enter</kbd></button><button data-action="back" class="ghost">Menú <kbd>Esc</kbd></button></div>`,
      { start, back },
      [
        [['Enter', 'Space', 'NumpadEnter'], 'start'],
        [['Escape'], 'back'],
      ],
      'intro',
    );
  }

  pause(volumes: Volumes, resume: Action, restart: Action, menu: Action): void {
    this.show(
      `<h2>Pausa</h2>
      <div class="menu-buttons">
        <button data-action="resume" class="primary">Continuar <kbd>Esc</kbd></button>
        <button data-action="restart">Reiniciar nivel <kbd>R</kbd></button>
        <button data-action="menu" class="ghost">Salir al menú <kbd>Q</kbd></button>
      </div>
      <h3>Sonido</h3>
      ${this.soundSliders(volumes)}`,
      { resume, restart, menu },
      [
        [['Escape', 'KeyP'], 'resume'],
        [['KeyR'], 'restart'],
        [['KeyQ'], 'menu'],
      ],
      'pause',
    );
  }

  results(
    cfg: LevelConfig,
    m: PerformanceMetrics,
    score: number,
    cash: number | null,
    profile: SkillProfile | null,
    next: Action,
    menu: Action,
  ): void {
    const encountered = m.obstaclesPassed + m.obstaclesHit;
    const rows = [
      ['Tiempo', formatTime(m.time)],
      ['Distancia', `${Math.round(m.distance)} m`],
      ['Obstáculos esquivados', `${m.obstaclesPassed} / ${encountered}`],
      ['Pasadas al límite', String(m.nearMisses)],
      ['Choques', String(m.collisions)],
      ['Daño recibido', String(Math.round(m.damageTaken))],
      ...(cfg.index > 0
        ? [
            ['Disparos recibidos', `${m.bulletsHit} de ${m.bulletsFired}`],
            ['Perseguidores derribados', String(m.copsWrecked)],
          ]
        : []),
      ['Puntaje', Math.round(score).toLocaleString('es-CO')],
      ...(cash !== null ? [['Botín restante', formatMoney(cash)]] : []),
    ];
    const table = rows.map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`).join('');
    const notes = cfg.adaptiveNotes.length
      ? `<div class="ai-notes"><h3>Ajustes aplicados en este nivel</h3><ul>${cfg.adaptiveNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`
      : '';
    const ai = profile
      ? `<h3>Veredicto de El Analista</h3>${this.profileBlock(profile)}${notes}${
          cfg.index === 0 ? '<p class="muted small">Cada nivel siguiente empieza con su propia fase de calibración.</p>' : ''
        }`
      : '';
    this.show(
      `<div class="level-tag">${cfg.index === 0 ? 'PRÓLOGO COMPLETADO' : `NIVEL ${cfg.index} SUPERADO`}</div>
      <h2>${{ bank: '¡Dentro del Banco Central!', tunnel: '¡A salvo en el túnel!', plant: '¡La planta nuclear voló!', safeZone: '¡Zona segura!', none: '' }[cfg.finish]}</h2>
      <div class="kv-grid">${table}</div>
      ${ai}
      <div class="menu-buttons"><button data-action="next" class="primary">Continuar <kbd>Enter</kbd></button><button data-action="menu" class="ghost">Menú</button></div>`,
      { next, menu },
      [[['Enter', 'Space', 'NumpadEnter'], 'next']],
      'results',
    );
  }

  gameOver(cfg: LevelConfig, m: PerformanceMetrics, score: number, retry: Action, menu: Action, endless?: { zone: number; best: number; record: boolean }): void {
    const titles = ['La tormenta los alcanzó', '¡Los atrapó la policía!', '¡Los Cuervos se quedaron con el botín!', '¡La tierra baldía los devoró!', 'Fin del camino'];
    this.show(
      `<div class="level-tag danger">${cfg.name}</div>
      <h2>${titles[cfg.index]}</h2>
      ${endless ? `<div class="big-cash">${(m.distance / 1000).toFixed(2)} km</div>${endless.record ? '<p class="goal">¡Nuevo récord!</p>' : `<p class="muted">Récord: ${(endless.best / 1000).toFixed(2)} km</p>`}` : ''}
      <div class="kv-grid">
        <div class="kv"><span>Tiempo resistido</span><b>${formatTime(m.time)}</b></div>
        <div class="kv"><span>Distancia</span><b>${Math.round(m.distance)} m</b></div>
        ${endless ? `<div class="kv"><span>Zona alcanzada</span><b>${endless.zone}</b></div>` : ''}
        <div class="kv"><span>Perseguidores derribados</span><b>${m.copsWrecked}</b></div>
        <div class="kv"><span>Puntaje del nivel</span><b>${Math.round(score).toLocaleString('es-CO')}</b></div>
      </div>
      ${cfg.index > 0 ? '<p class="muted">En el reintento, El Analista volverá a calibrar tu habilidad desde el inicio.</p>' : ''}
      <div class="menu-buttons"><button data-action="retry" class="primary">Reintentar <kbd>Enter</kbd></button><button data-action="menu" class="ghost">Menú <kbd>Esc</kbd></button></div>`,
      { retry, menu },
      [
        [['Enter', 'Space', 'NumpadEnter'], 'retry'],
        [['Escape'], 'menu'],
      ],
      'gameover',
    );
  }

  victory(text: string[], cash: number, score: number, profile: SkillProfile | null, menu: Action, endless: Action): void {
    this.show(
      `<div class="level-tag">FUGA COMPLETADA</div>
      <h1>¡El botín es suyo!</h1>
      <div class="story">${text.map((t) => `<p>${esc(t)}</p>`).join('')}</div>
      <div class="big-cash">${formatMoney(cash)}</div>
      <div class="kv-grid">
        <div class="kv"><span>Puntaje total</span><b>${Math.round(score).toLocaleString('es-CO')}</b></div>
        ${profile ? `<div class="kv"><span>Perfil final</span><b>${profile.tier} (${Math.round(profile.skill * 100)}%)</b></div>` : ''}
      </div>
      <p class="muted">¿Quieres más? En el nivel infinito te persiguen todos a la vez.</p>
      <div class="menu-buttons"><button data-action="endless" class="primary">Nivel infinito <kbd>Enter</kbd></button><button data-action="menu" class="ghost">Volver al menú <kbd>Esc</kbd></button></div>`,
      { menu, endless },
      [
        [['Enter', 'NumpadEnter'], 'endless'],
        [['Escape'], 'menu'],
      ],
      'victory',
    );
  }

}
