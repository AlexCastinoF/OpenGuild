import { useEffect, useRef, useState } from 'react';
import { Download, Pause, Play } from 'lucide-react';

function clock(sec: number) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function WaAudioPlayer({ src, fileName }: { src: string; fileName?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [seeking, setSeeking] = useState(false);
  const speeds = [1, 1.5, 2, 0.75];

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => {
      if (!seeking) setCur(a.currentTime || 0);
    };
    const onMeta = () => setDur(Number.isFinite(a.duration) ? a.duration : 0);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('ended', onPause);
    return () => {
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('ended', onPause);
    };
  }, [seeking, src]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  const seekVal = dur > 0 ? Math.round((cur / dur) * 1000) : 0;

  return (
    <div className="comm-wa-audio">
      <button
        type="button"
        className="comm-wa-audio-play"
        aria-label={playing ? 'Pausar' : 'Play'}
        onClick={() => {
          const a = audioRef.current;
          if (!a) return;
          if (a.paused) void a.play().catch(() => undefined);
          else a.pause();
        }}
      >
        {playing ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <div className="comm-wa-audio-body">
        <input
          type="range"
          className="comm-wa-audio-seek"
          min={0}
          max={1000}
          step={1}
          value={seekVal}
          aria-label="Posição"
          onPointerDown={() => setSeeking(true)}
          onPointerUp={() => setSeeking(false)}
          onChange={(e) => {
            const a = audioRef.current;
            const v = Number(e.target.value);
            if (a && dur > 0) {
              a.currentTime = (v / 1000) * dur;
              setCur(a.currentTime);
            }
          }}
        />
        <div className="comm-wa-audio-row">
          <span className="comm-wa-audio-time">
            {clock(cur)} / {clock(dur)}
          </span>
          <div className="comm-wa-audio-actions">
            <button
              type="button"
              className="comm-wa-audio-speed"
              title="Velocidade"
              onClick={() => {
                const i = speeds.indexOf(speed);
                setSpeed(speeds[(i + 1) % speeds.length]);
              }}
            >
              {speed}x
            </button>
            <a
              className="comm-wa-audio-dl"
              href={src}
              download={fileName || 'audio'}
              title="Baixar"
              aria-label="Baixar"
            >
              <Download size={14} />
            </a>
          </div>
        </div>
      </div>
      <audio ref={audioRef} preload="metadata" src={src} />
    </div>
  );
}
