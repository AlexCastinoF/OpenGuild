import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Send, Square, X } from 'lucide-react';

type Phase = 'idle' | 'recording' | 'paused' | 'preview';

function formatClock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
    return 'audio/webm;codecs=opus';
  }
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
    return 'audio/ogg;codecs=opus';
  }
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
  return '';
}

export function WaRecPanel({
  active,
  onCancel,
  onSend,
}: {
  active: boolean;
  onCancel: () => void;
  onSend: (file: File) => Promise<void>;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [timer, setTimer] = useState('0:00');
  const [sending, setSending] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef<Phase>('idle');
  const blobRef = useRef<Blob | null>(null);
  const stateRef = useRef<{
    stream: MediaStream | null;
    recorder: MediaRecorder | null;
    chunks: Blob[];
    startedAt: number;
    pausedAt: number;
    pauseTotal: number;
    audioCtx: AudioContext | null;
    analyser: AnalyserNode | null;
    animId: number | null;
    timerId: ReturnType<typeof setInterval> | null;
    mime: string;
  }>({
    stream: null,
    recorder: null,
    chunks: [],
    startedAt: 0,
    pausedAt: 0,
    pauseTotal: 0,
    audioCtx: null,
    analyser: null,
    animId: null,
    timerId: null,
    mime: 'audio/webm',
  });

  function setPhaseSafe(p: Phase) {
    phaseRef.current = p;
    setPhase(p);
  }

  function cleanupStreams() {
    const s = stateRef.current;
    if (s.animId) cancelAnimationFrame(s.animId);
    if (s.timerId) clearInterval(s.timerId);
    s.animId = null;
    s.timerId = null;
    if (s.stream) s.stream.getTracks().forEach((t) => t.stop());
    if (s.audioCtx) void s.audioCtx.close().catch(() => undefined);
    s.stream = null;
    s.audioCtx = null;
    s.analyser = null;
  }

  function resetAll() {
    cleanupStreams();
    const rec = stateRef.current.recorder;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.onstop = null;
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    stateRef.current.recorder = null;
    stateRef.current.chunks = [];
    stateRef.current.startedAt = 0;
    stateRef.current.pausedAt = 0;
    stateRef.current.pauseTotal = 0;
    blobRef.current = null;
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return '';
    });
    setPhaseSafe('idle');
    setTimer('0:00');
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function elapsedMs() {
    const s = stateRef.current;
    const now = phaseRef.current === 'paused' ? s.pausedAt || Date.now() : Date.now();
    return Math.max(0, now - s.startedAt - s.pauseTotal);
  }

  function updateTimer() {
    setTimer(formatClock(elapsedMs()));
  }

  function drawWave() {
    const s = stateRef.current;
    const canvas = canvasRef.current;
    if (!canvas || !s.analyser) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 240;
    const cssH = 52;
    if (canvas.width !== Math.floor(cssW * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const buf = new Uint8Array(s.analyser.frequencyBinCount);
    s.analyser.getByteTimeDomainData(buf);
    ctx.clearRect(0, 0, w, h);
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(248,113,113,.25)');
    grad.addColorStop(0.5, '#f87171');
    grad.addColorStop(1, 'rgba(248,113,113,.25)');
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = grad;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(buf.length / (cssW || 1)));
    for (let x = 0; x < cssW; x++) {
      const v = (buf[x * step] - 128) / 128;
      const y = h / 2 + v * (h * 0.44);
      const px = x * dpr;
      if (x === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.stroke();
    if (phaseRef.current === 'recording' && s.recorder) {
      s.animId = requestAnimationFrame(drawWave);
    }
  }

  async function start() {
    if (phaseRef.current !== 'idle') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      const mime = pickMime();
      if (!mime && typeof MediaRecorder === 'undefined') {
        throw new Error('Gravação não suportada neste navegador');
      }
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AC();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const s = stateRef.current;
      s.stream = stream;
      s.recorder = recorder;
      s.chunks = [];
      s.startedAt = Date.now();
      s.pausedAt = 0;
      s.pauseTotal = 0;
      s.audioCtx = audioCtx;
      s.analyser = analyser;
      s.mime = recorder.mimeType || mime || 'audio/webm';
      blobRef.current = null;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) s.chunks.push(ev.data);
      };

      recorder.onerror = () => {
        resetAll();
        onCancel();
        alert('Erro na gravação de áudio');
      };

      recorder.onstop = () => {
        cleanupStreams();
        const chunks = s.chunks.slice();
        s.recorder = null;
        s.chunks = [];
        const blob = new Blob(chunks, { type: s.mime });
        if (blob.size < 200) {
          resetAll();
          onCancel();
          alert('Áudio muito curto — grave de novo');
          return;
        }
        blobRef.current = blob;
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
        setPhaseSafe('preview');
      };

      // timeslice garante chunks periódicos (alguns browsers entregam vazio só no stop)
      recorder.start(200);
      setPhaseSafe('recording');
      updateTimer();
      s.timerId = setInterval(updateTimer, 200);
      s.animId = requestAnimationFrame(drawWave);
    } catch (e) {
      resetAll();
      alert(e instanceof Error ? e.message : 'Sem permissão de microfone');
      onCancel();
    }
  }

  useEffect(() => {
    if (active && phaseRef.current === 'idle') {
      void start();
    } else if (!active && phaseRef.current !== 'idle') {
      resetAll();
    }
    return () => {
      if (!active) return;
      // unmount while recording
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    return () => {
      resetAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function togglePause() {
    const s = stateRef.current;
    const rec = s.recorder;
    if (!rec) return;
    try {
      if (phaseRef.current === 'recording' && rec.state === 'recording') {
        if (typeof rec.pause === 'function') {
          rec.pause();
          s.pausedAt = Date.now();
          setPhaseSafe('paused');
          if (s.animId) cancelAnimationFrame(s.animId);
          s.animId = null;
        }
        return;
      }
      if (phaseRef.current === 'paused' && rec.state === 'paused') {
        rec.resume();
        s.pauseTotal += Date.now() - s.pausedAt;
        s.pausedAt = 0;
        setPhaseSafe('recording');
        s.animId = requestAnimationFrame(drawWave);
      }
    } catch {
      /* pause não suportado — ignore */
    }
  }

  function stop() {
    const s = stateRef.current;
    const rec = s.recorder;
    if (!rec) return;
    if (s.timerId) clearInterval(s.timerId);
    s.timerId = null;
    try {
      if (rec.state === 'recording' || rec.state === 'paused') {
        try {
          rec.requestData();
        } catch {
          /* ignore */
        }
        rec.stop();
      }
    } catch (e) {
      resetAll();
      onCancel();
      alert(e instanceof Error ? e.message : 'Falha ao parar gravação');
    }
  }

  function cancel() {
    const rec = stateRef.current.recorder;
    if (rec && rec.state !== 'inactive') {
      rec.onstop = () => {
        resetAll();
        onCancel();
      };
      try {
        rec.stop();
      } catch {
        resetAll();
        onCancel();
      }
      return;
    }
    resetAll();
    onCancel();
  }

  function playPreview() {
    if (!previewUrl) return;
    const audio = new Audio(previewUrl);
    void audio.play().catch(() => undefined);
  }

  async function send() {
    const blob = blobRef.current;
    if (!blob || sending) return;
    setSending(true);
    try {
      const ext = blob.type.includes('ogg')
        ? 'ogg'
        : blob.type.includes('mp4')
          ? 'm4a'
          : 'webm';
      const file = new File([blob], `ptt-${Date.now()}.${ext}`, {
        type: blob.type || 'audio/webm;codecs=opus',
      });
      await onSend(file);
      resetAll();
      onCancel();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Falha ao enviar áudio');
    } finally {
      setSending(false);
    }
  }

  const recording = phase === 'recording' || phase === 'paused';
  const show = active || phase !== 'idle';

  return (
    <div
      className="comm-wa-rec-panel"
      data-comm-wa-rec-panel
      hidden={!show}
      aria-hidden={!show}
    >
      <div className="comm-wa-rec-wave-wrap">
        <canvas className="comm-wa-rec-wave" ref={canvasRef} height={52} aria-hidden />
        <span className="comm-wa-rec-timer">{timer}</span>
      </div>
      <div className="comm-wa-rec-actions">
        {recording ? (
          <button
            type="button"
            className="comm-wa-rec-action"
            title={phase === 'paused' ? 'Continuar' : 'Pausar'}
            onClick={togglePause}
          >
            {phase === 'paused' ? <Play size={16} /> : <Pause size={16} />}
            <span>{phase === 'paused' ? 'Continuar' : 'Pausar'}</span>
          </button>
        ) : null}
        {recording ? (
          <button type="button" className="comm-wa-rec-action" title="Parar" onClick={stop}>
            <Square size={16} />
            <span>Parar</span>
          </button>
        ) : null}
        {phase === 'preview' ? (
          <button type="button" className="comm-wa-rec-action" title="Ouvir" onClick={playPreview}>
            <Play size={16} />
            <span>Ouvir</span>
          </button>
        ) : null}
        {phase === 'preview' ? (
          <button
            type="button"
            className="comm-wa-rec-action is-primary"
            title="Enviar áudio"
            disabled={sending}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void send();
            }}
          >
            <Send size={16} />
            <span>{sending ? 'Enviando…' : 'Enviar'}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="comm-wa-rec-action is-muted"
          title="Cancelar"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          }}
        >
          <X size={16} />
          <span>Cancelar</span>
        </button>
      </div>
    </div>
  );
}
