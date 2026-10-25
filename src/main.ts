import RAPIER from '@dimforge/rapier3d-compat';
import { Game } from './core/Game';
import { Loader } from './ui/Loader';
import './style.css';

async function boot(): Promise<void> {
  const app = document.querySelector('#app') as HTMLElement;
  const loader = new Loader();
  // ?models=1: sala de exhibición con todos los vehículos y personajes (se carga aparte, solo si se pide).
  if (new URLSearchParams(location.search).has('models')) {
    loader.hide();
    (await import('./ui/Showroom')).showShowroom(app);
    return;
  }
  try {
    await RAPIER.init();
    const game = new Game(app, loader);
    // Arrancó bien: si más adelante vuelve a faltar un archivo, index.html puede repararlo otra vez.
    try {
      sessionStorage.removeItem('rr-healed');
    } catch {
      /* ignorado */
    }
    // Acceso de depuración desde la consola durante el desarrollo.
    if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;
    // Los navegadores no dejan sonar una página hasta que se toca: si la bloquean,
    // se pide "toca para empezar" y ese toque enciende la música del menú.
    // Solo desarrollo: ?cine=3.2 muestra la cinemática congelada en ese instante; ?cine=hold, la escena detrás del menú.
    const freeze = import.meta.env.DEV ? new URLSearchParams(location.search).get('cine') : null;
    if (freeze !== null) {
      loader.hide();
      game.debugCinema(freeze === 'hold' ? -1 : Number(freeze) || 0, new URLSearchParams(location.search).has('menu'));
      return;
    }
    if (await game.tryAutoplay()) loader.hide();
    else await loader.pressStart();
    game.start();
  } catch (err) {
    console.error(err);
    loader.error('No se pudo iniciar el juego: tu navegador necesita WebGL y WebAssembly.');
  }
}

// Guarda el juego en el dispositivo para que abra sin internet (solo en producción y con https o localhost).
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

void boot();
