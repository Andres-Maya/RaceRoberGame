import RAPIER from '@dimforge/rapier3d-compat';
import { Game } from './core/Game';
import { Loader } from './ui/Loader';
import './style.css';

async function boot(): Promise<void> {
  const app = document.querySelector('#app') as HTMLElement;
  const loader = new Loader();
  try {
    await RAPIER.init();
    const game = new Game(app, loader);
    // Acceso de depuración desde la consola durante el desarrollo.
    if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;
    // Los navegadores no dejan sonar una página hasta que se toca: si la bloquean,
    // se pide "toca para empezar" y ese toque enciende la música del menú.
    if (await game.tryAutoplay()) loader.hide();
    else await loader.pressStart();
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
