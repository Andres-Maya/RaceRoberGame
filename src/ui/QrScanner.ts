/** Detector nativo de códigos (Chrome en Android); en otros navegadores se usa jsQR. */
interface NativeDetector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

/**
 * Lee códigos QR con la cámara trasera. Pedir la cámara también hace que el
 * navegador muestre las direcciones reales de la red local en la conexión
 * WebRTC (sin permiso las oculta tras nombres que en un hotspot pueden fallar).
 */
export class QrScanner {
  private stream: MediaStream | null = null;
  private timer = 0;
  private stopped = false;

  static get available(): boolean {
    return !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
  }

  /** Pide permiso de cámara sin mostrar nada (lo usa el anfitrión antes de crear su código). */
  static async warmup(): Promise<MediaStream | null> {
    if (!QrScanner.available) return null;
    try {
      return await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch {
      return null;
    }
  }

  /** Muestra la cámara en `video` y llama a `onText` con el primer código que acepte `accept`. */
  async start(video: HTMLVideoElement, accept: (text: string) => boolean, onText: (text: string) => void, stream?: MediaStream | null): Promise<void> {
    this.stopped = false;
    this.stream = stream ?? (await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }));
    if (this.stopped) {
      this.stop();
      return;
    }
    video.srcObject = this.stream;
    video.setAttribute('playsinline', '');
    video.muted = true;
    await video.play().catch(() => {});

    const Native = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => NativeDetector }).BarcodeDetector;
    let native: NativeDetector | null = null;
    if (Native) {
      try {
        native = new Native({ formats: ['qr_code'] });
      } catch {
        native = null;
      }
    }
    const jsQR = native ? null : (await import('jsqr')).default;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const scan = async () => {
      if (this.stopped) return;
      if (video.readyState >= 2 && video.videoWidth) {
        let found: string | null = null;
        try {
          if (native) {
            const codes = await native.detect(video);
            found = codes.find((c) => accept(c.rawValue))?.rawValue ?? null;
          } else if (jsQR && ctx) {
            // Se analiza una versión reducida del cuadro: suficiente para un QR en pantalla y más rápido.
            const scale = Math.min(1, 640 / video.videoWidth);
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if (code && accept(code.data)) found = code.data;
          }
        } catch {
          found = null;
        }
        if (found && !this.stopped) {
          this.stop();
          onText(found);
          return;
        }
      }
      this.timer = window.setTimeout(() => void scan(), 160);
    };
    void scan();
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
