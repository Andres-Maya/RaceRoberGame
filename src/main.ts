import RAPIER from '@dimforge/rapier3d-compat';
import { Game } from './core/Game';
import './style.css';

async function boot(): Promise<void> {
  const app = document.querySelector('#app') as HTMLElement;
  const loading = document.querySelector('#boot') as HTMLElement;
  try {
    await RAPIER.init();
    const game = new Game(app);
    // Acceso de depuración desde la consola durante el desarrollo.
    if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;
    loading.remove();
  } catch (err) {
    console.error(err);
    loading.textContent = 'No se pudo iniciar el juego: tu navegador necesita WebGL y WebAssembly.';
  }
}

void boot();
