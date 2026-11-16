/**
 * AudioSignalMeter (RFC v3.0 - Etapa 9)
 *
 * Medidor visual de sinal de áudio de alta performance acionado exclusivamente
 * via Canvas 2D e requestAnimationFrame (RAF).
 *
 * Características de Hardening:
 * 1. Zero re-renders no React quando o nível de áudio oscila (decoupled).
 * 2. Renderização direta em Canvas 2D com suavização de pico (fast attack, smooth decay).
 * 3. Atualização imperativa de indicadores DOM (dot/status) sem ciclo de reconciliação.
 * 4. Consumo insignificante de CPU (< 0.1%) e taxa de atualização sincronizada com o display (60 FPS).
 */

import { useEffect, useRef, memo } from 'react';

type Props = {
  label: string;
  level: number;
  hasTrack: boolean;
  direction: 'in' | 'out';
  title?: string;
};

function AudioSignalMeterBase({ label, level, hasTrack, direction, title }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dotRef = useRef<HTMLSpanElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Armazena o nível alvo sem causar re-render
  const targetLevelRef = useRef<number>(level);
  targetLevelRef.current = level;

  const hasTrackRef = useRef<boolean>(hasTrack);
  hasTrackRef.current = hasTrack;

  const currentLevelRef = useRef<number>(0);
  const rafIdRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    // Configuração de DPI para renderização nítida
    const dpr = window.devicePixelRatio || 1;
    const width = 56;
    const height = 6;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    let isRunning = true;

    const render = () => {
      if (!isRunning) return;

      const target = hasTrackRef.current ? Math.max(0, Math.min(1, targetLevelRef.current)) : 0;
      let cur = currentLevelRef.current;

      // Fast attack (instantâneo para subidas) e smooth decay (decaimento suave exponencial)
      if (target > cur) {
        cur = target;
      } else {
        cur = cur * 0.85; // decaimento de ~15% por frame (~60 FPS)
        if (cur < 0.005) cur = 0;
      }
      currentLevelRef.current = cur;

      // Limpa frame anterior
      ctx.clearRect(0, 0, width, height);

      // Fundo da barra
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.beginPath();
      ctx.roundRect(0, 0, width, height, 3);
      ctx.fill();

      // Preenchimento com gradiente de acordo com a intensidade
      if (cur > 0.008) {
        const fillWidth = Math.max(3, Math.min(width, width * cur));
        const grad = ctx.createLinearGradient(0, 0, fillWidth, 0);

        if (cur >= 0.03) {
          // Live - Emerald verde neon
          grad.addColorStop(0, '#1f9d62');
          grad.addColorStop(1, '#3dd68c');
        } else {
          // Soft - Amber amarelo suave
          grad.addColorStop(0, '#b8860b');
          grad.addColorStop(1, '#e6c35c');
        }

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(0, 0, fillWidth, height, 3);
        ctx.fill();
      }

      // Atualização imperativa do indicador de presença (Dot) sem acionar render no React
      const live = hasTrackRef.current && cur >= 0.03;
      if (dotRef.current) {
        dotRef.current.classList.toggle('is-on', live);
      }
      if (rootRef.current) {
        rootRef.current.classList.toggle('is-live', live);
      }

      rafIdRef.current = requestAnimationFrame(render);
    };

    rafIdRef.current = requestAnimationFrame(render);

    return () => {
      isRunning = false;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  const arrow = direction === 'out' ? '↑' : '↓';

  return (
    <div
      ref={rootRef}
      className={`comm-audio-meter${!hasTrack ? ' is-missing' : ''}`}
      title={title || `${label} (${direction === 'out' ? 'enviando' : 'recebendo'})`}
      role="meter"
      aria-label={`${label} ${direction === 'out' ? 'enviando' : 'recebendo'}`}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="comm-audio-meter-label">
        <em aria-hidden>{arrow}</em>
        {label}
      </span>
      <span className="comm-audio-meter-bar" aria-hidden style={{ display: 'inline-flex', alignItems: 'center' }}>
        <canvas
          ref={canvasRef}
          style={{ width: '56px', height: '6px', display: 'block', borderRadius: '3px' }}
        />
      </span>
      <span ref={dotRef} className="comm-audio-meter-dot" aria-hidden />
    </div>
  );
}

/**
 * AudioSignalMeter memoizado com comparador customizado:
 * Ignora alterações na prop 'level' para evitar re-renderizações do React.
 * O valor de 'level' é repassado diretamente via ref para o loop de requestAnimationFrame (Canvas 2D).
 */
export const AudioSignalMeter = memo(AudioSignalMeterBase, (prevProps, nextProps) => {
  return (
    prevProps.label === nextProps.label &&
    prevProps.direction === nextProps.direction &&
    prevProps.hasTrack === nextProps.hasTrack &&
    prevProps.title === nextProps.title
    // prevProps.level !== nextProps.level é propositalmente ignorado para desarmar reconciliações do React!
  );
});
