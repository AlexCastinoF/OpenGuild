import { useEffect, useState } from 'react';
import {
  MessagesSquare,
  Mic,
  Radio,
  Sparkles,
  X,
} from 'lucide-react';
import { NativeDialog } from './CommunityDialogs';
import { useBrandStore } from '../store/brand';

const LS_SEEN = 'comm-welcome-v1-seen';

const SLIDES = [
  {
    id: 'start',
    stepLabel: 'Início',
    StepIcon: Sparkles,
    VisualIcon: MessagesSquare,
    hero: true,
    title: 'Bem-vindo',
    body: 'Chat, voz e compartilhamento de tela em servidores por convite — no navegador ou no app desktop.',
    bullets: [
      'Crie servidores ou entre com convite',
      'Converse em canais de texto e mensagens diretas',
      'Entre em voz e compartilhe a tela nas reuniões',
    ],
  },
  {
    id: 'screen',
    stepLabel: 'Tela',
    StepIcon: Radio,
    VisualIcon: Radio,
    hero: false,
    title: 'Compartilhar tela',
    body: 'Em um canal de voz, compartilhe a tela com o time e, se quiser, gere um link público para convidados assistirem sem login.',
    bullets: [
      'Entre em um canal de voz ou tela',
      'Use Compartilhar tela e confirme no assistente',
      'Opcional: ative o link público para espectadores externos',
    ],
  },
  {
    id: 'voice',
    stepLabel: 'Voz',
    StepIcon: Mic,
    VisualIcon: Mic,
    hero: false,
    title: 'Voz, tela e ruído',
    body: 'Entre em canais de voz ou tela, fale com o grupo e compartilhe monitor ou janela. A barra flutuante mantém a call ao navegar.',
    bullets: [
      'Canais Voz e Tela no servidor',
      'Ajuste de microfone e fones na barra inferior',
      'Volume individual por participante no palco',
    ],
  },
] as const;

export function shouldAutoOpenWelcome() {
  try {
    if (localStorage.getItem(LS_SEEN) === '1') return false;
  } catch {
    return false;
  }
  if (new URLSearchParams(location.search).get('convite')) return false;
  return true;
}

export function WelcomeTourDialog({
  open,
  onClose,
  onCreateServer,
  onJoinInvite,
}: {
  open: boolean;
  onClose: () => void;
  onCreateServer?: () => void;
  onJoinInvite?: () => void;
}) {
  const brandName = useBrandStore((s) => s.name);
  const [index, setIndex] = useState(0);
  const [dontShow, setDontShow] = useState(true);

  useEffect(() => {
    if (open) {
      setIndex(0);
      setDontShow(true);
    }
  }, [open]);

  function markSeen() {
    if (dontShow) {
      try {
        localStorage.setItem(LS_SEEN, '1');
      } catch {
        /* ignore */
      }
    }
  }

  function close() {
    markSeen();
    onClose();
  }

  const slide = SLIDES[index];
  const slideTitle =
    slide.id === 'start' ? `Bem-vindo ao ${brandName}` : slide.title;
  const last = index >= SLIDES.length - 1;
  const Visual = slide.VisualIcon;

  return (
    <NativeDialog open={open} onClose={close} className="comm-dialog comm-dialog-welcome">
      <div className="comm-welcome">
        <header className="comm-welcome-head">
          <div className="comm-welcome-head-text">
            <span className="comm-welcome-kicker">Tour da Comunidade</span>
            <h2>Descubra tudo que você pode fazer</h2>
          </div>
          <button type="button" className="comm-welcome-close" onClick={close} aria-label="Fechar tour">
            <X size={16} />
          </button>
        </header>

        <div className="comm-welcome-body">
          <nav className="comm-welcome-steps" aria-label="Etapas do tour">
            {SLIDES.map((s, n) => {
              const Icon = s.StepIcon;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`comm-welcome-step${n === index ? ' is-on' : ''}`}
                  aria-current={n === index ? 'step' : undefined}
                  onClick={() => setIndex(n)}
                >
                  <Icon size={15} aria-hidden />
                  <span>{s.stepLabel}</span>
                </button>
              );
            })}
          </nav>

          <div className="comm-welcome-stage">
            <article className="comm-welcome-slide is-on">
              <div
                className={`comm-welcome-visual${slide.hero ? ' comm-welcome-visual-hero' : ''}`}
              >
                <Visual size={slide.hero ? 52 : 44} aria-hidden />
              </div>
              <div className="comm-welcome-copy">
                <h3>{slideTitle}</h3>
                <p>{slide.body}</p>
                <ul className="comm-welcome-list">
                  {slide.bullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
                {slide.id === 'start' ? (
                  <div className="comm-welcome-actions-row">
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => {
                        close();
                        window.setTimeout(() => onCreateServer?.(), 120);
                      }}
                    >
                      Criar servidor
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        close();
                        window.setTimeout(() => onJoinInvite?.(), 120);
                      }}
                    >
                      Entrar com convite
                    </button>
                  </div>
                ) : null}
              </div>
            </article>
          </div>
        </div>

        <footer className="comm-welcome-foot">
          <div className="comm-welcome-dots" aria-hidden>
            {SLIDES.map((s, n) => (
              <span
                key={s.id}
                className={`comm-welcome-dot${n === index ? ' is-on' : ''}`}
              />
            ))}
          </div>
          <label className="comm-welcome-dont comm-check">
            <input
              type="checkbox"
              checked={dontShow}
              onChange={(e) => setDontShow(e.target.checked)}
            />
            <span>Não mostrar novamente</span>
          </label>
          <div className="comm-welcome-nav">
            <span className="comm-welcome-progress muted">
              {index + 1} / {SLIDES.length}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={index <= 0}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
            >
              Anterior
            </button>
            <button
              type="button"
              className={`btn btn-sm${last ? ' btn-primary' : ''}`}
              onClick={() => {
                if (last) close();
                else setIndex((i) => Math.min(SLIDES.length - 1, i + 1));
              }}
            >
              {last ? 'Começar' : 'Próximo'}
            </button>
          </div>
        </footer>
      </div>
    </NativeDialog>
  );
}
