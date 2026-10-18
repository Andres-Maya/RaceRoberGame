import type { PerformanceMetrics } from '../ai/PerformanceTracker';
import { FEATURES, type SkillProfile } from '../ai/SkillClassifier';
import { LEVEL_NAMES } from '../config/levels';
import type { LevelConfig } from '../config/types';
import { isUnlocked, VEHICLES, vehicleById, vehicleStats, type VehicleId } from '../config/vehicles';
import type { SoundChannel, Volumes } from '../core/Audio';
import type { Input } from '../core/Input';
import { formatMoney, formatTime } from '../core/math';
import type { SaveData } from '../core/Storage';
import { PLAYER_COLORS } from '../entities/Player';
import { esc } from './html';
import { vehicleThumbnails } from './Thumbnails';

type Action = () => void;


/** Pantallas superpuestas en HTML: menú, historia, resultados, pausa... */
export class Screens {
  private el = document.querySelector('#screen') as HTMLElement;
  private actions = new Map<string, Action>();
  private keys: [string[], string][] = [];
  /** Recibe canal y volumen (0..1) cuando se mueve un control deslizante. */
  onVolume: ((channel: SoundChannel, v: number) => void) | null = null;
  /** Cada pantalla que se muestra (el anfitrión en línea la reenvía al invitado). */
  onShow: ((html: string, variant: string) => void) | null = null;

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
    this.onShow?.(html, variant);
  }

  /** Valor de un campo de texto de la pantalla actual. */
  private field(name: string): string {
    return this.el.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)?.value ?? '';
  }

  /** Despliega la opción de copiar o pegar el código como texto (por ejemplo, si la cámara falla). */
  openQrManual(): void {
    const d = this.el.querySelector<HTMLDetailsElement>('.qr-manual');
    if (d) d.open = true;
  }

  /** Video de la cámara de la pantalla de escaneo, si está visible. */
  qrVideo(): HTMLVideoElement | null {
    return this.el.querySelector<HTMLVideoElement>('video[data-qr-video]');
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

  menu(save: SaveData, a: { play: Action; select: Action; online: Action; garage: Action; controls: Action; stats: Action; sound: Action; mute: Action; music: Action; install?: Action }): void {
    this.show(
      `
      <div class="logo">
        <div class="logo-top">TURBO</div>
        <div class="logo-main">RATAS</div>
        <div class="logo-sub">Robo, fuga y radiación · Ciudad Cobalto</div>
      </div>
      <p class="tagline">Un golpe al Banco Central. Tres niveles de persecución. Una IA que estudia cómo manejas.</p>
      <div class="menu-buttons">
        ${
          save.campaign && save.campaign.level > 0
            ? `<button data-action="play" class="primary">CONTINUAR <kbd>1</kbd> <small>${save.campaign.level === 4 ? 'Nivel ∞' : `Nivel ${save.campaign.level}`} · ${esc(LEVEL_NAMES[save.campaign.level] ?? '')} · ${formatMoney(save.campaign.cash)}</small></button>`
            : '<button data-action="play" class="primary">JUGAR <kbd>1</kbd></button>'
        }
        <button data-action="select">SELECCIONAR NIVEL <kbd>2</kbd></button>
        <button data-action="online">EN LÍNEA · 2 JUGADORES <kbd>5</kbd> <small>código, hotspot o IP</small></button>
        <button data-action="garage">GARAJE <kbd>3</kbd> <small>${esc(vehicleById(save.vehicles[0]).name)}</small></button>
        <button data-action="controls">CONTROLES</button>
        <button data-action="stats">PERFIL DE LA IA Y ESTADÍSTICAS</button>
        ${a.install ? '<button data-action="install">INSTALAR EN ESTE DISPOSITIVO <small>para jugar sin internet</small></button>' : ''}
        <button data-action="sound">SONIDO <kbd>4</kbd> <small>${save.muted ? '(silenciado)' : `general ${Math.round(save.volumes.master * 100)}% · música ${save.musicOn ? `${Math.round(save.volumes.music * 100)}%` : 'apagada'}`}</small></button>
      </div>
      <div class="footer">Mejor puntaje: ${save.bestScore.toLocaleString('es-CO')} · Botín récord: ${formatMoney(save.bestCash)} · Récord infinito: ${(save.bestEndless / 1000).toFixed(2)} km</div>`,
      a,
      [
        [['Digit1', 'Numpad1', 'Enter'], 'play'],
        [['Digit2', 'Numpad2'], 'select'],
        [['Digit3', 'Numpad3'], 'garage'],
        [['Digit4', 'Numpad4'], 'sound'],
        [['Digit5', 'Numpad5'], 'online'],
        [['KeyM'], 'mute'],
        [['KeyN'], 'music'],
      ],
      'menu',
    );
  }

  levelSelect(save: SaveData, start: (level: number) => void, back: Action): void {
    const rows = LEVEL_NAMES
      .map(
        (n, i) => `<div class="level-row">
          <div><b>Nivel ${i === 4 ? '∞' : i}</b> — ${n}${i === 4 ? ` <small class="muted">(récord ${(save.bestEndless / 1000).toFixed(2)} km)</small>` : ''}</div>
          <div><button data-action="l${i}">Jugar</button></div>
        </div>`,
      )
      .join('');
    const actions: Record<string, Action> = { back };
    for (let i = 0; i < 5; i++) actions[`l${i}`] = () => start(i);
    const prof =
      'Elegir un nivel también deja ahí tu campaña (el prólogo es una partida nueva). Cada nivel empieza con una fase de calibración: El Analista mide tu habilidad en los primeros metros y ajusta ese mismo nivel.' +
      (save.profile ? ` Último perfil: <b>${save.profile.tier}</b> (${Math.round(save.profile.skill * 100)}%).` : '');
    this.show(`<h2>Seleccionar nivel</h2><p class="muted">${prof}</p>${rows}<div class="menu-buttons"><button data-action="back" class="ghost">Volver <kbd>Esc</kbd></button></div>`, actions, [[['Escape', 'Backspace'], 'back']]);
  }

  // ------------------------------------------------------------ en línea

  /**
   * Menú en línea: crear una sala (por código o por IP) o unirse a una.
   * `lan`: direcciones del servidor de red local si el juego se abrió desde él.
   */
  online(
    opts: { lan: { ips: string[]; port: number } | null; secure: boolean; camera: boolean },
    a: { hostCode: Action; hostIp: Action; hostQr: Action; joinCode: (code: string) => void; joinIp: (address: string) => void; joinQr: Action; back: Action },
  ): void {
    const ipHost = opts.lan
      ? `<button data-action="hostIp">CREAR PARTIDA POR IP <small>red local, sin internet</small></button>`
      : `<p class="muted small">Para crear una partida por IP (sin internet), un PC de la red debe ejecutar <code>npm run lan</code> y abrir el juego desde la dirección que muestra.</p>`;
    this.show(
      `<h2>En línea · 2 jugadores</h2>
      <p class="muted">Un jugador crea la partida y el otro se une. El anfitrión elige el nivel; cada uno juega con el vehículo de su garaje.</p>
      <div class="net-grid">
        <section class="net-card">
          <h3>Crear partida</h3>
          <button data-action="hostCode" class="primary">CREAR CON CÓDIGO <small>internet o hotspot</small></button>
          ${ipHost}
        </section>
        <section class="net-card">
          <h3>Unirse</h3>
          <label class="net-field"><span>Código de la sala</span><input name="code" maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDE" /></label>
          <button data-action="joinCode">UNIRSE CON CÓDIGO</button>
          <label class="net-field"><span>IP del anfitrión</span><input name="ip" inputmode="url" autocomplete="off" spellcheck="false" placeholder="192.168.43.1:8080" value="${opts.lan ? esc(location.host) : ''}" /></label>
          <button data-action="joinIp">UNIRSE POR IP</button>
          ${opts.secure ? '<p class="muted small">Al unirte por IP se abrirá el juego desde el equipo del anfitrión (misma red Wi-Fi o hotspot).</p>' : ''}
        </section>
        <section class="net-card">
          <h3>Hotspot sin internet</h3>
          <p class="muted small">Dos teléfonos, sin datos ni PC: uno activa su hotspot y el otro se conecta a él. Se escanean un código QR cada uno.</p>
          <button data-action="hostQr" class="primary">CREAR CON QR</button>
          <button data-action="joinQr">UNIRSE CON QR</button>
          <p class="muted small">${
            opts.camera
              ? 'Para jugar sin internet, abre el juego una vez con conexión y añádelo a la pantalla de inicio (quedará guardado).'
              : 'Aquí no hay cámara disponible (necesita https): podrás copiar y pegar los códigos como texto.'
          }</p>
        </section>
      </div>
      <div class="menu-buttons"><button data-action="back" class="ghost">Volver <kbd>Esc</kbd></button></div>`,
      {
        hostCode: a.hostCode,
        hostIp: a.hostIp,
        hostQr: a.hostQr,
        joinCode: () => a.joinCode(this.field('code')),
        joinIp: () => a.joinIp(this.field('ip')),
        joinQr: a.joinQr,
        back: a.back,
      },
      [[['Escape'], 'back']],
    );
  }

  /** Sala del anfitrión: código o direcciones para compartir y estado del invitado. */
  room(
    info: { kind: 'code' | 'ip' | 'qr'; code: string; addresses: string[]; guest: string | null; vehicle: string },
    a: { play: Action; garage: Action; leave: Action },
  ): void {
    const share =
      info.kind === 'qr'
        ? `<p class="muted small">Conectados por hotspot, sin internet. Si el otro jugador se desconecta, cierra la partida y vuelvan a escanear los códigos.</p>`
        : info.kind === 'code'
        ? `<div class="net-code">${esc(info.code)}</div><p class="muted small">El otro jugador elige <b>EN LÍNEA › Unirse con código</b>. Ambos necesitan internet (los datos del hotspot sirven); la partida va directo entre los dos dispositivos.</p>`
        : `<div class="net-addresses">${info.addresses.map((ip) => `<div class="net-code small">${esc(ip)}</div>`).join('')}</div><p class="muted small">Conecta el otro dispositivo a la misma red Wi-Fi o al hotspot, abre esa dirección en su navegador y elige <b>EN LÍNEA › Unirse por IP</b>.</p>`;
    const guest = `<p class="net-status" data-room-guest></p>`;
    this.show(
      `<h2>Tu partida</h2>
      ${share}
      ${guest}
      <p class="muted small">Tu vehículo: <b>${esc(info.vehicle)}</b></p>
      <div class="menu-buttons">
        <button data-action="play" class="primary"${info.guest ? '' : ' disabled'}>ELEGIR NIVEL Y JUGAR <kbd>Enter</kbd></button>
        <button data-action="garage">GARAJE</button>
        <button data-action="leave" class="ghost danger">Cerrar partida <kbd>Esc</kbd></button>
      </div>`,
      a,
      [
        [['Enter', 'NumpadEnter'], 'play'],
        [['Escape'], 'leave'],
      ],
    );
    this.roomGuest(info.guest);
  }

  /**
   * Actualiza en la sala solo la línea del invitado y el botón de jugar, sin
   * redibujar la pantalla (el anfitrión puede estar leyendo o eligiendo).
   */
  roomGuest(guest: string | null): void {
    const line = this.el.querySelector<HTMLElement>('[data-room-guest]');
    if (!line) return;
    line.textContent = guest ? `Jugador 2 conectado · ${guest}` : 'Esperando al jugador 2…';
    line.classList.toggle('ok', !!guest);
    line.classList.toggle('wait', !guest);
    const play = this.el.querySelector<HTMLButtonElement>('[data-action="play"]');
    if (play) play.disabled = !guest;
  }

  /**
   * Paso del intercambio por QR: instrucciones, el código propio (imagen y
   * texto para copiar), la cámara para escanear el del otro o un campo para pegarlo.
   */
  qrStep(
    o: { title: string; steps: string[]; qr?: string; text?: string; video?: boolean; status?: string },
    a: { scan?: Action; paste: (text: string) => void; leave: Action },
  ): void {
    const copy = o.text
      ? `<label class="net-field"><span>Tu código en texto</span><textarea readonly rows="3" class="qr-text">${esc(o.text)}</textarea></label><button data-action="copy">Copiar código</button>`
      : '';
    this.show(
      `<h2>${esc(o.title)}</h2>
      <ol class="qr-steps">${o.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      ${o.qr ? `<div class="qr-box"><img src="${o.qr}" alt="Código QR de conexión" draggable="false" /></div>` : ''}
      ${o.video ? '<div class="qr-video"><video data-qr-video playsinline muted></video><div class="qr-frame"></div></div>' : ''}
      ${o.status ? `<p class="net-status wait">${esc(o.status)}</p>` : ''}
      <details class="qr-manual">
        <summary>Sin cámara: copiar o pegar el código como texto</summary>
        ${copy}
        <label class="net-field"><span>Código del otro teléfono</span><textarea name="qrpaste" rows="3" autocomplete="off" spellcheck="false" placeholder="Pega aquí el texto que empieza por RR1"></textarea></label>
        <button data-action="paste">Usar código pegado</button>
      </details>
      <div class="menu-buttons">
        ${a.scan ? '<button data-action="scan" class="primary">ESCANEAR LA RESPUESTA</button>' : ''}
        <button data-action="leave" class="ghost danger">Cancelar <kbd>Esc</kbd></button>
      </div>`,
      {
        ...(a.scan ? { scan: a.scan } : {}),
        paste: () => a.paste(this.field('qrpaste')),
        copy: () => {
          const area = this.el.querySelector<HTMLTextAreaElement>('.qr-text');
          if (!area) return;
          area.select();
          void navigator.clipboard?.writeText(area.value).catch(() => document.execCommand('copy'));
        },
        leave: a.leave,
      },
      [[['Escape'], 'leave']],
    );
  }

  /** Aviso destacado arriba de la pantalla actual (por ejemplo, un vehículo desbloqueado). */
  notice(names: string[]): void {
    const panel = this.el.querySelector('.panel');
    if (!panel || !names.length) return;
    const note = document.createElement('div');
    note.className = 'unlock-note';
    note.innerHTML = `<b>¡${names.length > 1 ? 'Nuevos vehículos desbloqueados' : 'Nuevo vehículo desbloqueado'}!</b> ${names.map(esc).join(', ')} · elígelo en el garaje`;
    panel.prepend(note);
  }

  /** Estado de la conexión (conectando, esperando al anfitrión...). */
  netStatus(title: string, text: string, a: { leave: Action; garage?: Action }): void {
    this.show(
      `<h2>${esc(title)}</h2>
      <p class="net-status wait">${esc(text)}</p>
      <div class="menu-buttons">
        ${a.garage ? '<button data-action="garage">GARAJE</button>' : ''}
        <button data-action="leave" class="ghost danger">Salir <kbd>Esc</kbd></button>
      </div>`,
      a,
      [[['Escape'], 'leave']],
    );
  }

  /** Error de conexión con un botón para volver. */
  netError(text: string, back: Action): void {
    this.show(
      `<h2>Sin conexión</h2>
      <p class="net-status bad">${esc(text)}</p>
      <div class="menu-buttons"><button data-action="back" class="primary">Volver <kbd>Enter</kbd></button></div>`,
      { back },
      [[['Escape', 'Enter', 'NumpadEnter'], 'back']],
    );
  }

  /**
   * Invitado: muestra la pantalla que el anfitrión tiene abierta (historia,
   * pausa, resultados...) sin sus botones. El HTML viene de otro dispositivo,
   * así que se limpia de scripts, eventos y enlaces antes de mostrarlo.
   */
  mirror(html: string, variant: string, leave: Action): void {
    const tpl = document.createElement('template');
    // La pausa del anfitrión incluye sus controles de volumen: aquí basta con avisar.
    tpl.innerHTML = variant === 'pause' ? '<h2>Pausa</h2><p class="muted">El anfitrión pausó la partida.</p>' : html;
    const allowed = new Set(['DIV', 'P', 'SPAN', 'B', 'I', 'EM', 'SMALL', 'STRONG', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'TABLE', 'TR', 'TD', 'TH', 'TBODY', 'THEAD', 'BR', 'KBD', 'LABEL', 'SECTION', 'ARTICLE']);
    for (const el of [...tpl.content.querySelectorAll('*')]) {
      if (!allowed.has(el.tagName) || el.closest('.menu-buttons') || el.hasAttribute('data-action') || el.hasAttribute('data-volume')) {
        el.remove();
        continue;
      }
      for (const attr of [...el.attributes]) {
        if (attr.name !== 'class' && attr.name !== 'style') el.removeAttribute(attr.name);
        else if (attr.name === 'style' && /url\s*\(|expression/i.test(attr.value)) el.removeAttribute(attr.name);
      }
    }
    const holder = document.createElement('div');
    holder.appendChild(tpl.content);
    const safeVariant = /^[a-z]*$/.test(variant) ? variant : '';
    this.el.className = `screen ${safeVariant}`;
    this.el.innerHTML = `<div class="panel">${holder.innerHTML}<p class="net-status wait">Esperando al anfitrión…</p><div class="menu-buttons"><button data-action="leave" class="ghost danger">Salir de la partida</button></div></div>`;
    this.actions = new Map(Object.entries({ leave }));
    this.keys = [];
  }

  /**
   * Garaje: una tarjeta por vehículo con su foto, atributos y habilidades.
   * Los bloqueados muestran cómo conseguirlos.
   */
  garage(save: SaveData, pick: (id: VehicleId) => void, back: Action): void {
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
          <div class="vbadges"><span class="vbadge" style="--pc:${PLAYER_COLORS[0].css}">ELEGIDO</span></div>
          ${locked ? `<div class="vlock"><b>BLOQUEADO</b><span>${esc(v.unlock!.text)}</span>${v.unlock!.progress ? `<em>${esc(v.unlock!.progress(save))}</em>` : ''}</div>` : ''}
        </div>
        <div class="vhead"><h3>${esc(v.name)}</h3><span class="vrole">${esc(v.role)}</span><kbd>${i + 1}</kbd></div>
        <p class="vdesc">${esc(v.description)}</p>
        <div class="vfacts">${facts}</div>
        <div class="vstats">${bars}</div>
        <ul class="vperks">${v.perks.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        <div class="vbuttons">
          <button data-action="pick-${v.id}" style="--pc:${PLAYER_COLORS[0].css}"${locked ? ' disabled' : ''}>${locked ? 'Bloqueado' : 'Elegir'}</button>
        </div>
      </article>`;
    }).join('');

    let selected = save.vehicles[0];
    const mark = () => {
      this.el.querySelectorAll<HTMLElement>('.vcard').forEach((card) => {
        const on = card.dataset.vehicle === selected;
        card.classList.toggle('chosen', on);
        card.querySelector('.vbadge')?.classList.toggle('on', on);
        const btn = card.querySelector<HTMLButtonElement>('[data-action^="pick-"]');
        if (btn) {
          btn.classList.toggle('chosen', on);
          if (!btn.disabled) btn.textContent = on ? 'Elegido' : 'Elegir';
        }
      });
    };
    const actions: Record<string, Action> = { back };
    const keys: [string[], string][] = [[['Escape', 'Backspace', 'Enter'], 'back']];
    VEHICLES.forEach((v, i) => {
      actions[`pick-${v.id}`] = () => {
        if (!isUnlocked(v, save)) return;
        selected = v.id;
        pick(v.id);
        mark();
      };
      keys.push([[`Digit${i + 1}`, `Numpad${i + 1}`], `pick-${v.id}`]);
    });
    this.show(
      `<h2>Garaje</h2>
      <p class="muted">Cada vehículo tiene su propia vida, velocidad, munición y habilidades. Empiezas con el Cacharro; los demás se desbloquean jugando. Teclas <kbd>1</kbd>–<kbd>${VEHICLES.length}</kbd> para elegir rápido.</p>
      <div class="garage-grid">${cards}</div>
      <div class="menu-buttons"><button data-action="back" class="primary">Listo <kbd>Esc</kbd></button></div>`,
      actions,
      keys,
      'garage',
    );
    mark();
  }

  /** Cómo instalar el juego cuando el navegador no ofrece el aviso automático. */
  installHelp(o: { browser: 'ios' | 'android' | 'samsung' | 'firefox' | 'desktop'; secure: boolean; host: string }, back: Action): void {
    const steps: Record<typeof o.browser, string[]> = {
      ios: ['Abre el juego en <b>Safari</b> (en iPhone y iPad solo se instala desde el navegador, con la página abierta).', 'Toca <b>Compartir</b> (el cuadrado con la flecha hacia arriba).', 'Elige <b>Añadir a pantalla de inicio</b> y luego <b>Añadir</b>.'],
      android: ['Toca el menú <b>⋮</b> de Chrome (arriba a la derecha).', 'Elige <b>Instalar app</b> o <b>Agregar a la pantalla principal</b>.', 'Confirma con <b>Instalar</b>.'],
      samsung: ['Toca el menú <b>≡</b> de Samsung Internet (abajo).', 'Elige <b>Añadir página a</b> › <b>Pantalla de inicio</b>.'],
      firefox: ['Toca el menú <b>⋮</b> de Firefox.', 'Elige <b>Instalar</b> o <b>Añadir a la pantalla de inicio</b>.', 'Si no aparece, abre el juego en Chrome o Safari.'],
      desktop: ['En Chrome o Edge, toca el ícono de <b>instalar</b> al final de la barra de direcciones (una pantalla con una flecha).', 'O abre el menú <b>⋮</b> › <b>Transmitir, guardar y compartir</b> › <b>Instalar página como app</b>.'],
    };
    const warning = o.secure
      ? ''
      : `<p class="net-status bad">Esta dirección (<b>http://${esc(o.host)}</b>) no permite instalar ni guardar el juego sin internet. Ábrelo desde la versión segura (https), por ejemplo la publicada en Vercel, e instálalo desde ahí.</p>`;
    this.show(
      `<h2>Instalar el juego</h2>
      <p class="muted">Instalado, el juego queda guardado en el dispositivo: abre desde su ícono, a pantalla completa y sin internet (por ejemplo, para jugar por hotspot).</p>
      ${warning}
      <ol class="qr-steps">${steps[o.browser].map((s) => `<li>${s}</li>`).join('')}</ol>
      <p class="muted small">Si el navegador dice que ya está instalado, búscalo entre tus apps. Si cerraste antes el aviso de instalación, el navegador puede tardar en volver a ofrecerlo: usa los pasos de arriba.</p>
      <div class="menu-buttons"><button data-action="back" class="primary">Volver <kbd>Esc</kbd></button></div>`,
      { back },
      [[['Escape', 'Enter', 'Backspace'], 'back']],
    );
  }

  controls(back: Action): void {
    this.show(
      `<h2>Controles</h2>
      <div class="ctrl-card" style="--pc:#ff4d4d">
        <p><kbd>W</kbd> / <kbd>↑</kbd> acelerar · <kbd>S</kbd> / <kbd>↓</kbd> frenar / reversa</p>
        <p><kbd>A</kbd> <kbd>D</kbd> / <kbd>←</kbd> <kbd>→</kbd> girar</p>
        <p><kbd>Espacio</kbd> / <kbd>Shift</kbd> / <kbd>Enter</kbd> turbo</p>
        <p><kbd>F</kbd> / <kbd>Ctrl der.</kbd> disparar al objetivo más cercano</p>
      </div>
      <div class="ctrl-card" style="--pc:#4d9dff">
        <p><b>En celular:</b> el vehículo va hacia donde apuntes el joystick de la izquierda (arriba = hacia arriba de la pantalla; si apuntas hacia atrás, retrocede) y se detiene al soltarlo. Botones de <b>TURBO</b> y <b>DISPARO</b> a la derecha y pausa abajo al centro. Mejor con el teléfono en horizontal.</p>
      </div>
      <p class="muted"><kbd>Esc</kbd> / <kbd>P</kbd> pausa · <kbd>M</kbd> silencio · <kbd>N</kbd> música · <kbd>-</kbd> <kbd>+</kbd> volumen de la música.</p>
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

  intro(cfg: LevelConfig, vehicle: string, start: Action, back: Action): void {
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
      <p class="goal">${goal}</p>
      <p class="muted small">Vehículo: <b style="color:${PLAYER_COLORS[0].css}">${esc(vehicleById(vehicle).name)}</b> — cámbialo en el garaje del menú.</p>
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
