import { IS_TOUCH } from './Touch';

const TIPS = [
  'Dispara a los bidones rojos cuando un perseguidor pase al lado.',
  'Un anillo parpadeante en el suelo marca dónde caerá una granada.',
  'El buggy no se frena en la arena: ideal para el desierto y la tierra baldía.',
  'La camioneta y el blindado destrozan patrullas al embestirlas.',
  'Con turbo a fondo puedes derribar a una harpía en picada.',
  'Las cajas amarillas recargan la munición; las llaves, la vida.',
  'Los perseguidores que caen al río se hunden.',
  'El Analista recalibra la dificultad en los primeros metros de cada nivel.',
];

/** Pantalla de carga: una llanta rodando sobre el asfalto. */
export class Loader {
  private el = document.querySelector('#loader') as HTMLElement;
  private text = this.el.querySelector('.loader-text') as HTMLElement;
  private tip = this.el.querySelector('.loader-tip') as HTMLElement;

  show(text: string, tip = true): void {
    this.text.textContent = text;
    this.tip.textContent = tip ? `Consejo: ${TIPS[Math.floor(Math.random() * TIPS.length)]}` : '';
    this.el.classList.remove('hidden', 'fade');
  }

  hide(): void {
    this.el.classList.add('fade');
    window.setTimeout(() => {
      if (this.el.classList.contains('fade')) this.el.classList.add('hidden');
    }, 260);
  }

  /**
   * Pantalla de inicio al estilo arcade: espera un toque, clic o tecla (el gesto
   * que el navegador exige para reproducir sonido) y se retira. La tecla no
   * llega al menú, para que Enter no empiece una partida sin querer.
   */
  pressStart(): Promise<void> {
    this.text.textContent = IS_TOUCH ? 'Toca la pantalla para empezar' : 'Haz clic o presiona una tecla para empezar';
    this.tip.textContent = '';
    this.el.classList.remove('hidden', 'fade');
    this.el.classList.add('press');
    return new Promise((resolve) => {
      const events = ['pointerup', 'keydown'] as const;
      const go = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        for (const ev of events) window.removeEventListener(ev, go, { capture: true });
        this.el.classList.remove('press');
        this.hide();
        resolve();
      };
      // Se registra después de los del juego: su desbloqueo de audio corre primero.
      for (const ev of events) window.addEventListener(ev, go, { capture: true });
    });
  }

  error(text: string): void {
    this.el.classList.add('error');
    this.text.textContent = text;
    this.tip.textContent = '';
  }
}
