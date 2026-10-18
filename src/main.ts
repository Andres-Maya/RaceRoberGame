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
    loader.hide();
  } catch (err) {
    console.error(err);
    loader.error('No se pudo iniciar el juego: tu navegador necesita WebGL y WebAssembly.');
  }
}

void boot();
