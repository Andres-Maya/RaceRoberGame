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

  error(text: string): void {
    this.el.classList.add('error');
    this.text.textContent = text;
    this.tip.textContent = '';
  }
}
