import { useEffect, useRef, useState } from 'react';
import {
  canUseAiNoiseEngines,
  noiseEngineLabel,
  type NoiseEngine,
} from '../lib/deepFilterMic';

export type { NoiseEngine };
export type AudioDevicePrefs = {
  micId: string;
  speakerId: string;
  /** Legado — derivado de noiseEngine !== 'off' */
  noiseFilter: boolean;
  noiseEngine: NoiseEngine;
  /** Intensidade 0–100 (estilo Discord) */
  noiseLevel: number;
  /** Cancelamento de eco WebRTC (AEC) */
  echoCancellation: boolean;
};

const STORAGE_KEY = 'steamfarm-audio-prefs';
/** One-shot: após update, todos passam a Krisp + AEC (preserva mic/speaker/nível). */
const MIGRATE_KRISP_AEC_KEY = 'steamfarm-audio-migrate-krisp-aec-v2';
const DEFAULT_AI_ENGINE: NoiseEngine = 'krisp';

function isNoiseEngine(v: unknown): v is NoiseEngine {
  return (
    v === 'off' ||
    v === 'browser' ||
    v === 'deepfilter' ||
    v === 'rnnoise' ||
    v === 'dtln' ||
    v === 'krisp'
  );
}

export function normalizeAudioPrefs(raw?: Partial<AudioDevicePrefs> | null): AudioDevicePrefs {
  let engine: NoiseEngine;
  if (isNoiseEngine(raw?.noiseEngine)) {
    engine = raw.noiseEngine;
  } else if (raw?.noiseFilter === false) {
    engine = 'off';
  } else {
    engine = DEFAULT_AI_ENGINE;
  }
  const level = Math.max(0, Math.min(100, Math.round(Number(raw?.noiseLevel ?? 85))));
  return {
    micId: String(raw?.micId || ''),
    speakerId: String(raw?.speakerId || ''),
    noiseEngine: engine,
    noiseFilter: engine !== 'off',
    noiseLevel: Number.isFinite(level) ? level : 85,
    echoCancellation: raw?.echoCancellation !== false,
  };
}

export function loadAudioPrefs(): AudioDevicePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<AudioDevicePrefs>) : null;
    const alreadyMigrated = localStorage.getItem(MIGRATE_KRISP_AEC_KEY) === '1';
    if (!alreadyMigrated) {
      // One-shot pós-update: Krisp + AEC para todos (preserva mic/saída/intensidade)
      const next = normalizeAudioPrefs({
        micId: String(parsed?.micId || ''),
        speakerId: String(parsed?.speakerId || ''),
        noiseLevel: parsed?.noiseLevel ?? 85,
        noiseEngine: DEFAULT_AI_ENGINE,
        echoCancellation: true,
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      localStorage.setItem(MIGRATE_KRISP_AEC_KEY, '1');
      return next;
    }
    if (parsed) return normalizeAudioPrefs(parsed);
  } catch {
    /* ignore */
  }
  return normalizeAudioPrefs(null);
}

export function saveAudioPrefs(prefs: AudioDevicePrefs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeAudioPrefs(prefs)));
}

function rmsToUnit(analyser: AnalyserNode, buf: Float32Array<ArrayBufferLike>): number {
  analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  const db = 20 * Math.log10(Math.max(rms, 1e-8));
  return Math.max(0, Math.min(1, (db + 50) / 40));
}

function levelEnabled(engine: NoiseEngine) {
  return engine === 'deepfilter' || engine === 'rnnoise' || engine === 'dtln' || engine === 'krisp';
}

/** Medidores live + seletor de motor / intensidade (estilo Discord). */
export function VoiceFilterControls({
  micId,
  engine,
  noiseLevel,
  echoCancellation,
  onEngineChange,
  onLevelChange,
  onEchoChange,
}: {
  micId: string;
  engine: NoiseEngine;
  noiseLevel: number;
  echoCancellation: boolean;
  onEngineChange: (e: NoiseEngine) => void;
  onLevelChange: (n: number) => void;
  onEchoChange: (v: boolean) => void;
}) {
  const desktop = canUseAiNoiseEngines();
  const [inputLevel, setInputLevel] = useState(0);
  const [filteredLevel, setFilteredLevel] = useState(0);
  const [previewErr, setPreviewErr] = useState('');
  const [loadingAi, setLoadingAi] = useState(false);
  const rawRef = useRef(0);
  const filtRef = useRef(0);
  const filterRef = useRef<{ setSuppressionLevel: (n: number) => void } | null>(null);

  useEffect(() => {
    filterRef.current?.setSuppressionLevel(Math.max(0, Math.min(100, noiseLevel)));
  }, [noiseLevel]);

  useEffect(() => {
    let dead = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let filter: {
      setSuppressionLevel: (n: number) => void;
      destroy: () => Promise<void> | void;
    } | null = null;
    let lkTrack: {
      stop: () => void;
      stopProcessor?: () => Promise<void>;
      mediaStreamTrack?: MediaStreamTrack;
    } | null = null;

    const tick = (
      rawA: AnalyserNode,
      rawBuf: Float32Array,
      filtA?: AnalyserNode,
      filtBuf?: Float32Array,
    ) => {
      if (dead) return;
      rawRef.current = rmsToUnit(rawA, rawBuf);
      if (filtA && filtBuf) filtRef.current = rmsToUnit(filtA, filtBuf);
      else {
        const atten =
          engine === 'off' ? 0 : engine === 'browser' ? 0.25 : noiseLevel / 100;
        filtRef.current = rawRef.current * (1 - atten * 0.55);
      }
      setInputLevel(rawRef.current);
      setFilteredLevel(filtRef.current);
      raf = requestAnimationFrame(() => tick(rawA, rawBuf, filtA, filtBuf));
    };

    void (async () => {
      try {
        setPreviewErr('');
        filterRef.current = null;
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: micId ? { ideal: micId } : undefined,
            echoCancellation,
            noiseSuppression: engine === 'browser',
            autoGainControl: true,
          },
        });
        if (dead) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        const rawSource = ctx.createMediaStreamSource(stream);
        const rawAnalyser = ctx.createAnalyser();
        rawAnalyser.fftSize = 1024;
        rawAnalyser.smoothingTimeConstant = 0.7;
        rawSource.connect(rawAnalyser);
        const rawBuf = new Float32Array(rawAnalyser.fftSize);

        let filtAnalyser: AnalyserNode | undefined;
        let filtBuf: Float32Array | undefined;

        if (levelEnabled(engine) && desktop) {
          setLoadingAi(true);
          try {
            const { createVoiceMicTrack } = await import('../lib/deepFilterMic');
            const mic = await createVoiceMicTrack({
              micId,
              speakerId: '',
              noiseFilter: true,
              noiseEngine: engine,
              noiseLevel,
              echoCancellation,
            });
            if (dead) {
              await mic.dispose();
              return;
            }
            filter = {
              setSuppressionLevel: mic.setNoiseLevel,
              destroy: mic.dispose,
            };
            filterRef.current = { setSuppressionLevel: mic.setNoiseLevel };
            lkTrack = mic.track;
            const mst = mic.track.mediaStreamTrack;
            if (mst && ctx) {
              const filtSource = ctx.createMediaStreamSource(new MediaStream([mst]));
              filtAnalyser = ctx.createAnalyser();
              filtAnalyser.fftSize = 1024;
              filtAnalyser.smoothingTimeConstant = 0.7;
              filtSource.connect(filtAnalyser);
              filtBuf = new Float32Array(filtAnalyser.fftSize);
            }
          } catch (e) {
            setPreviewErr(e instanceof Error ? e.message : 'Filtro IA indisponível no preview');
          } finally {
            setLoadingAi(false);
          }
        }

        void ctx.resume().catch(() => undefined);
        tick(rawAnalyser, rawBuf, filtAnalyser, filtBuf);
      } catch (e) {
        if (!dead) setPreviewErr(e instanceof Error ? e.message : 'Sem acesso ao microfone');
      }
    })();

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      filterRef.current = null;
      void (async () => {
        try {
          await lkTrack?.stopProcessor?.();
        } catch {
          /* ignore */
        }
        try {
          lkTrack?.stop();
        } catch {
          /* ignore */
        }
        try {
          await filter?.destroy?.();
        } catch {
          /* ignore */
        }
        try {
          stream?.getTracks().forEach((t) => t.stop());
        } catch {
          /* ignore */
        }
        try {
          await ctx?.close();
        } catch {
          /* ignore */
        }
      })();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nível via filterRef
  }, [micId, engine, echoCancellation, desktop]);

  const intensityOn = levelEnabled(engine);
  const engineHint = (() => {
    switch (engine) {
      case 'deepfilter':
        return 'DeepFilterNet: 1.ª carga ~25 MB. Intensidade alta remove mais fundo.';
      case 'rnnoise':
        return 'RNNoise: leve e rápido (WASM). Intensidade = mix dry/wet.';
      case 'dtln':
        return 'DTLN: modelo neural (WorkAdventure). Pode usar mais CPU.';
      case 'krisp':
        return 'Krisp + BVC: remove ruído e retorno de colunas (como o Discord). Se falhar, cai para DeepFilterNet.';
      case 'browser':
        return 'NS nativo do WebRTC — leve. O AEC WebRTC no app Desktop costuma falhar com partilha de ecrã.';
      default:
        return null;
    }
  })();

  return (
    <div className="sf-voice-filter">
      <p className="comm-dialog-hint sf-voice-filter-lead">
        Eco de altifalante: o app toca a voz remota em &lt;audio&gt; para o AEC WebRTC ter referência (como o
        Discord). Só passa a Web Audio enquanto <strong>tu</strong> partilhas ecrã. Mantém <strong>Krisp</strong> +
        AEC ligados no cliente com microfone aberto junto das colunas.
      </p>

      <label className="sf-voice-filter-field">
        Supressão de ruído
        <select
          value={engine}
          onChange={(e) => onEngineChange(e.target.value as NoiseEngine)}
        >
          <option value="off">Desligada</option>
          <option value="browser">Browser (WebRTC NS)</option>
          {desktop ? (
            <>
              <option value="deepfilter">DeepFilterNet (IA)</option>
              <option value="rnnoise">RNNoise</option>
              <option value="dtln">DTLN</option>
              <option value="krisp">Krisp (IA · recomendado)</option>
            </>
          ) : (
            <>
              <option value="deepfilter" disabled>
                DeepFilterNet (navegador sem AudioWorklet)
              </option>
              <option value="rnnoise" disabled>
                RNNoise (navegador sem AudioWorklet)
              </option>
              <option value="dtln" disabled>
                DTLN (navegador sem AudioWorklet)
              </option>
              <option value="krisp" disabled>
                Krisp (navegador sem AudioWorklet)
              </option>
            </>
          )}
        </select>
      </label>

      <label className="sf-voice-filter-field">
        Cancelamento de eco (AEC WebRTC)
        <select
          value={echoCancellation ? 'webrtc' : 'off'}
          onChange={(e) => onEchoChange(e.target.value === 'webrtc')}
        >
          <option value="webrtc">WebRTC AEC (ajuda no browser; fraco no Desktop)</option>
          <option value="off">Desligado</option>
        </select>
      </label>
      <p className="comm-dialog-hint">
        Eco de altifalante no Desktop: deixa <strong>Krisp</strong> ligado (BVC). O AEC WebRTC sozinho não
        chega — o Discord também não depende só dele.
      </p>

      <div className={`sf-voice-filter-level${intensityOn ? '' : ' is-dim'}`}>
        <div className="sf-voice-filter-level-head">
          <span>Intensidade do filtro</span>
          <strong>
            {intensityOn
              ? `${noiseLevel}%`
              : engine === 'browser'
                ? 'Fixo'
                : '—'}
          </strong>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={noiseLevel}
          disabled={!intensityOn}
          onChange={(e) => onLevelChange(Number(e.target.value))}
          aria-label="Intensidade do filtro de ruído"
        />
        <div className="sf-voice-filter-level-scale" aria-hidden>
          <span>Suave</span>
          <span>Máximo</span>
        </div>
      </div>

      <div className="sf-voice-meters" aria-live="polite">
        <div className="sf-voice-meter">
          <div className="sf-voice-meter-label">
            <span>Entrada do microfone</span>
            <em>{Math.round(inputLevel * 100)}%</em>
          </div>
          <div className="sf-voice-meter-track">
            <div
              className="sf-voice-meter-fill is-input"
              style={{ transform: `scaleX(${Math.max(0.02, inputLevel)})` }}
            />
          </div>
        </div>
        <div className="sf-voice-meter">
          <div className="sf-voice-meter-label">
            <span>
              Após filtro{' '}
              {loadingAi
                ? `(a carregar ${noiseEngineLabel(engine)}…)`
                : ''}
            </span>
            <em>{Math.round(filteredLevel * 100)}%</em>
          </div>
          <div className="sf-voice-meter-track">
            <div
              className="sf-voice-meter-fill is-filter"
              style={{ transform: `scaleX(${Math.max(0.02, filteredLevel)})` }}
            />
          </div>
        </div>
      </div>

      {previewErr ? <p className="pm-error">{previewErr}</p> : null}
      {engineHint ? <p className="comm-dialog-hint">{engineHint}</p> : null}
    </div>
  );
}

export function AudioSettingsDialog({
  open,
  onClose,
  prefs,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  prefs: AudioDevicePrefs;
  onSave: (p: AudioDevicePrefs) => void;
}) {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState(prefs.micId);
  const [speakerId, setSpeakerId] = useState(prefs.speakerId);
  const [engine, setEngine] = useState<NoiseEngine>(prefs.noiseEngine);
  const [noiseLevel, setNoiseLevel] = useState(prefs.noiseLevel);
  const [echoCancellation, setEchoCancellation] = useState(prefs.echoCancellation);

  useEffect(() => {
    if (!open) return;
    const n = normalizeAudioPrefs(prefs);
    setMicId(n.micId);
    setSpeakerId(n.speakerId);
    setEngine(n.noiseEngine);
    setNoiseLevel(n.noiseLevel);
    setEchoCancellation(n.echoCancellation);
    void (async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        /* permission may already exist */
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMics(devices.filter((d) => d.kind === 'audioinput'));
      setSpeakers(devices.filter((d) => d.kind === 'audiooutput'));
    })();
  }, [open, prefs]);

  if (!open) return null;

  return (
    <dialog className="comm-dialog" open>
      <div className="comm-dialog-form">
        <h2>Áudio e voz</h2>
        <label>
          Microfone
          <select value={micId} onChange={(e) => setMicId(e.target.value)}>
            <option value="">Padrão do sistema</option>
            {mics.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Mic ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Saída (alto-falante)
          <select value={speakerId} onChange={(e) => setSpeakerId(e.target.value)}>
            <option value="">Padrão do sistema</option>
            {speakers.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Out ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
        </label>

        <VoiceFilterControls
          micId={micId}
          engine={engine}
          noiseLevel={noiseLevel}
          echoCancellation={echoCancellation}
          onEngineChange={setEngine}
          onLevelChange={setNoiseLevel}
          onEchoChange={setEchoCancellation}
        />

        <div className="form-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const next = normalizeAudioPrefs({
                micId,
                speakerId,
                noiseEngine: engine,
                noiseLevel,
                echoCancellation,
              });
              saveAudioPrefs(next);
              onSave(next);
              onClose();
            }}
          >
            Aplicar
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </div>
    </dialog>
  );
}
