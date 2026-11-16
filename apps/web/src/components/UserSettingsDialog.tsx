import React, { useState, useEffect, useId } from 'react';
import {
  User,
  Palette,
  Mic,
  Bell,
  Keyboard,
  Globe,
  X,
  RotateCcw,
  Save,
  Check,
  AlertTriangle,
  Sparkles,
  Volume2,
  Calendar,
  LogOut,
  ExternalLink,
} from 'lucide-react';
import { NativeDialog } from './NativeDialog';
import { useAppearance } from '../hooks/useAppearance';
import {
  THEME_PRESETS,
  ThemePreset,
  getActiveSeasonalPreset,
} from '../lib/themes';
import {
  AREA_SWATCHES,
  BG_SWATCHES,
  ACCENT_SWATCHES,
  LayoutStyle,
  isContrastAdequate,
} from '../lib/appearance';
import { useAuthStore } from '../store/auth';
import { api } from '../lib/api';
import {
  VoiceFilterControls,
  loadAudioPrefs,
  saveAudioPrefs,
  AudioDevicePrefs,
} from './AudioSettingsDialog';
import { CustomSelect, CustomSelectOption } from './CustomSelect';
import '../styles/user-settings.css';

export type UserSettingsTab =
  | 'account'
  | 'appearance'
  | 'voice'
  | 'notifications'
  | 'shortcuts'
  | 'language';

interface UserSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  defaultTab?: UserSettingsTab;
  onOpenProfileEdit?: () => void;
}

export function UserSettingsDialog({
  open,
  onClose,
  defaultTab = 'appearance',
  onOpenProfileEdit,
}: UserSettingsDialogProps) {
  const [tab, setTab] = useState<UserSettingsTab>(defaultTab);
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);

  const handleLogout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
    } catch {
      /* ignore */
    }
    setUser(null);
  };

  const {
    preview,
    applyPreset,
    updateAreaColor,
    updatePreview,
    setAutoSpecialDates,
    save,
    resetToDefault,
    cancel,
  } = useAppearance();

  // Audio prefs state for voice tab
  const [audioPrefs, setAudioPrefs] = useState<AudioDevicePrefs>(loadAudioPrefs());
  const [audioDevices, setAudioDevices] = useState<{
    mics: MediaDeviceInfo[];
    speakers: MediaDeviceInfo[];
  }>({ mics: [], speakers: [] });

  // Notifications state
  const [notifSound, setNotifSound] = useState(true);
  const [notifMention, setNotifMention] = useState(true);
  const [notifDesktop, setNotifDesktop] = useState(true);

  // Language state
  const [lang, setLang] = useState<'pt-BR' | 'en-US'>('pt-BR');

  // Sincroniza tab padrão se abrir
  useEffect(() => {
    if (open) {
      setTab(defaultTab);
      setAudioPrefs(loadAudioPrefs());
    }
  }, [open, defaultTab]);

  // Carrega dispositivos de áudio
  useEffect(() => {
    if (!open || tab !== 'voice') return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;

    navigator.mediaDevices
      .enumerateDevices()
      .then((devs) => {
        setAudioDevices({
          mics: devs.filter((d) => d.kind === 'audioinput'),
          speakers: devs.filter((d) => d.kind === 'audiooutput'),
        });
      })
      .catch(() => {});
  }, [open, tab]);

  if (!open) return null;

  const seasonalActive = getActiveSeasonalPreset();
  const mainContrastOk = isContrastAdequate(preview.main);
  const sideContrastOk = isContrastAdequate(preview.side);

  const areas: Array<{
    key: 'bg' | 'rail' | 'side' | 'main' | 'members' | 'accent';
    label: string;
    swatches: Array<{ label: string; value: string }>;
  }> = [
    { key: 'bg', label: 'Fundo da Aplicação', swatches: BG_SWATCHES },
    { key: 'rail', label: 'Barra de Servidores', swatches: AREA_SWATCHES },
    { key: 'side', label: 'Lista de Canais', swatches: AREA_SWATCHES },
    { key: 'main', label: 'Área do Chat', swatches: AREA_SWATCHES },
    { key: 'members', label: 'Painel de Membros', swatches: AREA_SWATCHES },
    { key: 'accent', label: 'Cor de Destaque', swatches: ACCENT_SWATCHES },
  ];

  const handleAudioChange = (partial: Partial<AudioDevicePrefs>) => {
    const updated = { ...audioPrefs, ...partial };
    setAudioPrefs(updated);
    saveAudioPrefs(updated);
  };

  const handleSaveAppearance = async () => {
    await save();
    onClose();
  };

  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog comm-dialog-user-settings">
      <div className="user-settings-modal" onClick={(e) => e.stopPropagation()}>
        {/* Barra Lateral de Navegação */}
        <aside className="user-settings-sidebar">
          <div className="user-settings-nav-header">
            <span className="user-settings-nav-title">Configurações</span>
          </div>

          <nav className="user-settings-nav" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'account'}
              className={`user-settings-nav-item ${tab === 'account' ? 'is-active' : ''}`}
              onClick={() => setTab('account')}
            >
              <User size={18} strokeWidth={1.8} />
              <span>Conta</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={tab === 'appearance'}
              className={`user-settings-nav-item ${tab === 'appearance' ? 'is-active' : ''}`}
              onClick={() => setTab('appearance')}
            >
              <Palette size={18} strokeWidth={1.8} />
              <span>Aparência</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={tab === 'voice'}
              className={`user-settings-nav-item ${tab === 'voice' ? 'is-active' : ''}`}
              onClick={() => setTab('voice')}
            >
              <Mic size={18} strokeWidth={1.8} />
              <span>Voz e vídeo</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={tab === 'notifications'}
              className={`user-settings-nav-item ${tab === 'notifications' ? 'is-active' : ''}`}
              onClick={() => setTab('notifications')}
            >
              <Bell size={18} strokeWidth={1.8} />
              <span>Notificações</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={tab === 'shortcuts'}
              className={`user-settings-nav-item ${tab === 'shortcuts' ? 'is-active' : ''}`}
              onClick={() => setTab('shortcuts')}
            >
              <Keyboard size={18} strokeWidth={1.8} />
              <span>Atalhos</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={tab === 'language'}
              className={`user-settings-nav-item ${tab === 'language' ? 'is-active' : ''}`}
              onClick={() => setTab('language')}
            >
              <Globe size={18} strokeWidth={1.8} />
              <span>Idioma</span>
            </button>
          </nav>

          <div className="user-settings-sidebar-footer">
            <button
              type="button"
              className="user-settings-logout-btn"
              onClick={() => {
                onClose();
                void handleLogout();
              }}
            >
              <LogOut size={16} />
              <span>Sair da conta</span>
            </button>
          </div>
        </aside>

        {/* Conteúdo Principal */}
        <main className="user-settings-content">
          <button
            type="button"
            className="user-settings-close-btn"
            onClick={() => {
              cancel();
              onClose();
            }}
            aria-label="Fechar"
          >
            <X size={20} strokeWidth={1.8} />
          </button>

          {/* ========================================================= */}
          {/* ABA APARÊNCIA */}
          {/* ========================================================= */}
          {tab === 'appearance' && (
            <div className="user-settings-pane appearance-pane">
              <header className="user-settings-pane-header">
                <h2>Aparência & Tema</h2>
                <p>Personalize os temas prontos, cores por área e estilo de ilhas da comunidade</p>
              </header>

              <div className="appearance-sections-stack">
                {/* 1. TEMAS PRONTOS EM GRADE DE 4 COLUNAS */}
                <section className="appearance-pane-section">
                  <div className="appearance-section-heading">
                    <div>
                      <h3 className="section-title">Temas Prontos</h3>
                      <p className="section-desc">
                        Escolha um conjunto de tokens prontos ou personalize suas próprias cores
                      </p>
                    </div>

                    {preview.selectedThemeId === 'custom' && (
                      <span className="theme-custom-pill">Personalizado</span>
                    )}
                  </div>

                  <div className="appearance-themes-grid">
                    {THEME_PRESETS.map((preset) => {
                      const isSelected = preview.selectedThemeId === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          className={`theme-card ${isSelected ? 'is-selected' : ''}`}
                          onClick={() => applyPreset(preset)}
                          title={`${preset.name} (${preset.tag})`}
                        >
                          {/* Faixa com as 4 cores: fundo, painel, chat e destaque */}
                          <div className="theme-strip">
                            <span
                              className="strip-block"
                              style={{ background: preset.bg }}
                              title="Fundo"
                            />
                            <span
                              className="strip-block"
                              style={{ background: preset.side }}
                              title="Painel"
                            />
                            <span
                              className="strip-block"
                              style={{ background: preset.main }}
                              title="Chat"
                            />
                            <span
                              className="strip-block"
                              style={{ background: preset.accent }}
                              title="Destaque"
                            />
                          </div>

                          <div className="theme-card-info">
                            <span className="theme-card-name">{preset.name}</span>
                            <span className="theme-card-tag">{preset.tag}</span>
                          </div>

                          {isSelected && (
                            <div className="theme-card-check">
                              <Check size={14} strokeWidth={2.5} />
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Switch "Trocar nas datas especiais" */}
                  <div className="special-dates-card">
                    <div className="special-dates-info">
                      <div className="special-dates-title-row">
                        <Calendar size={18} className="special-dates-icon" />
                        <strong>Trocar nas datas especiais</strong>
                        {seasonalActive && (
                          <span className="special-active-chip">
                            <Sparkles size={12} /> {seasonalActive.name} ativo
                          </span>
                        )}
                      </div>
                      <p className="special-dates-desc">
                        Aplica automaticamente Halloween (20 a 31 out), Natal (1 a 26 dez) e Páscoa
                        (de 7 dias antes até o domingo) durante o período comemorativo. Fora dessas
                        datas, retorna ao seu tema selecionado.
                      </p>
                    </div>

                    <label className="comm-switch">
                      <input
                        type="checkbox"
                        checked={preview.autoSpecialDates !== false}
                        onChange={(e) => setAutoSpecialDates(e.target.checked)}
                      />
                      <span className="comm-slider round" />
                    </label>
                  </div>
                </section>

                {/* 2. CORES POR ÁREA */}
                <section className="appearance-pane-section">
                  <div className="appearance-section-heading">
                    <div>
                      <h3 className="section-title">Cores por Área</h3>
                      <p className="section-desc">
                        Ajuste o tom exato de cada seção. Alterar qualquer área marca o tema como Personalizado.
                      </p>
                    </div>
                    {(!mainContrastOk || !sideContrastOk) && (
                      <div className="appearance-contrast-warn">
                        <AlertTriangle size={14} />
                        <span>Atenção: contraste pode ficar reduzido com tons muito claros</span>
                      </div>
                    )}
                  </div>

                  <div className="appearance-areas-list">
                    {areas.map((area) => {
                      const currentColor = preview[area.key];

                      return (
                        <div key={area.key} className="area-color-row">
                          <span className="area-name">{area.label}</span>
                          <div className="area-swatches">
                            {area.swatches.map((swatch) => {
                              const isSelected =
                                currentColor.toLowerCase() === swatch.value.toLowerCase();
                              return (
                                <button
                                  key={swatch.value}
                                  type="button"
                                  className={`area-swatch-circle ${isSelected ? 'is-selected' : ''}`}
                                  style={{ backgroundColor: swatch.value }}
                                  title={`${swatch.label} (${swatch.value})`}
                                  onClick={() => updateAreaColor(area.key, swatch.value)}
                                >
                                  {isSelected && <Check size={14} strokeWidth={2.5} />}
                                </button>
                              );
                            })}

                            {/* Seletor de cor personalizada */}
                            <label
                              className="area-swatch-picker"
                              title="Escolher cor personalizada"
                            >
                              <input
                                type="color"
                                value={currentColor}
                                onChange={(e) => updateAreaColor(area.key, e.target.value)}
                              />
                              <span
                                className="area-picker-preview"
                                style={{ backgroundColor: currentColor }}
                              />
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                {/* 3. ESTILO (ILHAS / CONTÍNUO / VIDRO) E SLIDERS */}
                <section className="appearance-pane-section">
                  <h3 className="section-title">Estilo do Layout & Espaçamento</h3>
                  <p className="section-desc">
                    Escolha a estrutura visual da interface e o arredondamento dos painéis
                  </p>

                  <div className="layout-style-segments">
                    {(
                      [
                        {
                          id: 'islands',
                          label: 'Ilhas (Padrão)',
                          desc: 'Painéis flutuantes com espaçamento e sombras',
                        },
                        {
                          id: 'continuous',
                          label: 'Contínuo',
                          desc: 'Layout sólido sem divisórias ou bordas arredondadas',
                        },
                        {
                          id: 'glass',
                          label: 'Vidro (Glass)',
                          desc: 'Superfícies translúcidas com efeito fosco de desfoque',
                        },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`layout-segment-btn ${
                          preview.layoutStyle === opt.id ? 'is-active' : ''
                        }`}
                        onClick={() => updatePreview({ layoutStyle: opt.id as LayoutStyle })}
                      >
                        <span className="segment-label">{opt.label}</span>
                        <span className="segment-sub">{opt.desc}</span>
                      </button>
                    ))}
                  </div>

                  {preview.layoutStyle !== 'continuous' && (
                    <div className="appearance-sliders-grid">
                      <div className="slider-control-card">
                        <div className="slider-meta">
                          <label htmlFor="radius-range">Arredondamento das Ilhas</label>
                          <span className="slider-val">{preview.radius}px</span>
                        </div>
                        <input
                          id="radius-range"
                          type="range"
                          min={0}
                          max={32}
                          value={preview.radius}
                          onChange={(e) => updatePreview({ radius: Number(e.target.value) })}
                          className="appearance-range-input"
                        />
                      </div>

                      <div className="slider-control-card">
                        <div className="slider-meta">
                          <label htmlFor="gap-range">Espaçamento entre Painéis</label>
                          <span className="slider-val">{preview.gap}px</span>
                        </div>
                        <input
                          id="gap-range"
                          type="range"
                          min={0}
                          max={24}
                          value={preview.gap}
                          onChange={(e) => updatePreview({ gap: Number(e.target.value) })}
                          className="appearance-range-input"
                        />
                      </div>
                    </div>
                  )}
                </section>

                {/* 4. COLUNA DE PRÉ-VISUALIZAÇÃO AO VIVO COM RESTAURAR PADRÃO E SALVAR */}
                <section className="appearance-pane-section preview-and-save-section">
                  <div className="appearance-section-heading">
                    <div>
                      <h3 className="section-title">Pré-visualização ao Vivo</h3>
                      <p className="section-desc">
                        Veja o resultado imediato das combinações de cores e estilo
                      </p>
                    </div>
                  </div>

                  <div
                    className="live-preview-box"
                    style={{
                      background: preview.bg,
                      ['--prev-radius' as string]:
                        preview.layoutStyle === 'continuous' ? '0px' : `${preview.radius}px`,
                      ['--prev-gap' as string]:
                        preview.layoutStyle === 'continuous' ? '0px' : `${preview.gap}px`,
                    }}
                  >
                    <div
                      className="prev-col prev-rail"
                      style={{ background: preview.rail }}
                      title="Barra de Servidores"
                    >
                      <div className="prev-circle" style={{ background: preview.accent }} />
                      <div className="prev-circle-ghost" />
                      <div className="prev-circle-ghost" />
                    </div>

                    <div
                      className="prev-col prev-side"
                      style={{ background: preview.side }}
                      title="Lista de Canais"
                    >
                      <div className="prev-line-short" style={{ background: preview.accent }} />
                      <div className="prev-line" />
                      <div className="prev-line" />
                    </div>

                    <div
                      className="prev-col prev-main"
                      style={{ background: preview.main }}
                      title="Chat Principal"
                    >
                      <div className="prev-chat-head">
                        <div className="prev-line-short" />
                      </div>
                      <div className="prev-msg">
                        <div className="prev-avatar" style={{ background: preview.accent }} />
                        <div className="prev-msg-lines">
                          <div className="prev-line-short" />
                          <div className="prev-line" />
                        </div>
                      </div>
                      <div className="prev-input" style={{ borderColor: preview.accent }}>
                        <span className="prev-send-btn" style={{ background: preview.accent }} />
                      </div>
                    </div>

                    <div
                      className="prev-col prev-members"
                      style={{ background: preview.members }}
                      title="Lista de Membros"
                    >
                      <div className="prev-member-row">
                        <div className="prev-avatar" style={{ background: preview.accent }} />
                        <div className="prev-line-short" />
                      </div>
                      <div className="prev-member-row">
                        <div className="prev-avatar-dim" />
                        <div className="prev-line-short" />
                      </div>
                    </div>
                  </div>

                  <div className="appearance-actions-bar">
                    <button
                      type="button"
                      className="appearance-restore-btn"
                      onClick={resetToDefault}
                      title="Restaurar valores de fábrica"
                    >
                      <RotateCcw size={16} />
                      <span>Restaurar padrão</span>
                    </button>

                    <div className="appearance-confirm-group">
                      <button
                        type="button"
                        className="appearance-cancel-btn"
                        onClick={() => {
                          cancel();
                          onClose();
                        }}
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        className="appearance-save-btn"
                        onClick={handleSaveAppearance}
                        style={{
                          background: preview.accent,
                          color: '#04101f',
                        }}
                      >
                        <Save size={16} />
                        <span>Salvar</span>
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          )}

          {/* ========================================================= */}
          {/* ABA CONTA */}
          {/* ========================================================= */}
          {tab === 'account' && (
            <div className="user-settings-pane account-pane">
              <header className="user-settings-pane-header">
                <h2>Minha Conta</h2>
                <p>Gerencie seus dados de usuário, perfil e autenticação</p>
              </header>

              <div className="account-card">
                <div className="account-hero">
                  <div className="account-avatar-wrap">
                    <img
                      src={user?.avatar_url || '/icon.svg'}
                      alt={user?.label || 'Usuário'}
                      className="account-avatar"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = '/icon.svg';
                      }}
                    />
                  </div>
                  <div className="account-meta">
                    <h3 className="account-name">{user?.label || 'Usuário'}</h3>
                    <span className="account-username">@{user?.username || 'user'}</span>
                    <span className="account-id">ID: #{user?.id || 0}</span>
                  </div>
                </div>

                <div className="account-details-grid">
                  <div className="detail-item">
                    <span className="detail-label">Status</span>
                    <span className="detail-val">Online</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Cargo</span>
                    <span className="detail-val">
                      {user?.is_super ? 'Super Admin' : 'Membro'}
                    </span>
                  </div>
                </div>

                <div className="account-actions">
                  {onOpenProfileEdit && (
                    <button
                      type="button"
                      className="btn-edit-profile"
                      onClick={() => {
                        onClose();
                        onOpenProfileEdit();
                      }}
                    >
                      Editar Perfil Completo
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-danger-logout"
                    onClick={() => {
                      onClose();
                      void handleLogout();
                    }}
                  >
                    <LogOut size={16} />
                    <span>Sair desta conta</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ========================================================= */}
          {/* ABA VOZ E VÍDEO */}
          {/* ========================================================= */}
          {tab === 'voice' && (
            <div className="user-settings-pane voice-pane">
              <header className="user-settings-pane-header">
                <h2>Voz & Vídeo</h2>
                <p>Ajuste dispositivos, supressão de ruído com IA e testes de áudio</p>
              </header>

              <div className="voice-device-selectors">
                <div className="device-select-card">
                  <label htmlFor="select-mic">
                    <Mic size={16} /> Dispositivo de Entrada (Microfone)
                  </label>
                  <CustomSelect
                    id="select-mic"
                    aria-label="Dispositivo de Entrada (Microfone)"
                    value={audioPrefs.micId}
                    placeholder="Padrão do Sistema"
                    options={[
                      { value: '', label: 'Padrão do Sistema' },
                      ...audioDevices.mics.map((d) => ({
                        value: d.deviceId,
                        label: d.label || `Microfone ${d.deviceId.slice(0, 5)}`,
                      })),
                    ]}
                    onChange={(val) => handleAudioChange({ micId: val })}
                  />
                </div>

                <div className="device-select-card">
                  <label htmlFor="select-speaker">
                    <Volume2 size={16} /> Dispositivo de Saída (Alto-falante)
                  </label>
                  <CustomSelect
                    id="select-speaker"
                    aria-label="Dispositivo de Saída (Alto-falante)"
                    value={audioPrefs.speakerId}
                    placeholder="Padrão do Sistema"
                    options={[
                      { value: '', label: 'Padrão do Sistema' },
                      ...audioDevices.speakers.map((d) => ({
                        value: d.deviceId,
                        label: d.label || `Alto-falante ${d.deviceId.slice(0, 5)}`,
                      })),
                    ]}
                    onChange={(val) => handleAudioChange({ speakerId: val })}
                  />
                </div>
              </div>

              {/* Controles integrados de filtro de ruído e barra de teste */}
              <div className="voice-filter-wrap">
                <VoiceFilterControls
                  micId={audioPrefs.micId}
                  engine={audioPrefs.noiseEngine}
                  noiseLevel={audioPrefs.noiseLevel}
                  echoCancellation={audioPrefs.echoCancellation}
                  onEngineChange={(engine) => handleAudioChange({ noiseEngine: engine })}
                  onLevelChange={(level) => handleAudioChange({ noiseLevel: level })}
                  onEchoChange={(echo) => handleAudioChange({ echoCancellation: echo })}
                />
              </div>
            </div>
          )}

          {/* ========================================================= */}
          {/* ABA NOTIFICAÇÕES */}
          {/* ========================================================= */}
          {tab === 'notifications' && (
            <div className="user-settings-pane notifications-pane">
              <header className="user-settings-pane-header">
                <h2>Notificações</h2>
                <p>Configure alertas sonoros e notificações de mensagens</p>
              </header>

              <div className="settings-toggles-list">
                <div className="settings-toggle-row">
                  <div>
                    <strong>Sons de mensagens no chat</strong>
                    <p>Tocar um efeito sonoro sutil ao receber mensagens em canais abertos</p>
                  </div>
                  <label className="comm-switch">
                    <input
                      type="checkbox"
                      checked={notifSound}
                      onChange={(e) => setNotifSound(e.target.checked)}
                    />
                    <span className="comm-slider round" />
                  </label>
                </div>

                <div className="settings-toggle-row">
                  <div>
                    <strong>Notificações de menção direta (@você)</strong>
                    <p>Alertar com prioridade quando outro membro marcar seu nome ou cargo</p>
                  </div>
                  <label className="comm-switch">
                    <input
                      type="checkbox"
                      checked={notifMention}
                      onChange={(e) => setNotifMention(e.target.checked)}
                    />
                    <span className="comm-slider round" />
                  </label>
                </div>

                <div className="settings-toggle-row">
                  <div>
                    <strong>Notificações na área de trabalho</strong>
                    <p>Exibir banner nativo do sistema operacional em segundo plano</p>
                  </div>
                  <label className="comm-switch">
                    <input
                      type="checkbox"
                      checked={notifDesktop}
                      onChange={(e) => setNotifDesktop(e.target.checked)}
                    />
                    <span className="comm-slider round" />
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* ========================================================= */}
          {/* ABA ATALHOS */}
          {/* ========================================================= */}
          {tab === 'shortcuts' && (
            <div className="user-settings-pane shortcuts-pane">
              <header className="user-settings-pane-header">
                <h2>Atalhos do Teclado</h2>
                <p>Ações rápidas para navegação eficiente</p>
              </header>

              <div className="shortcuts-table">
                <div className="shortcut-row">
                  <span className="shortcut-desc">Buscar canais e mensagens</span>
                  <div className="shortcut-keys">
                    <kbd>Ctrl</kbd> + <kbd>K</kbd>
                  </div>
                </div>
                <div className="shortcut-row">
                  <span className="shortcut-desc">Fechar modais e menus</span>
                  <div className="shortcut-keys">
                    <kbd>Esc</kbd>
                  </div>
                </div>
                <div className="shortcut-row">
                  <span className="shortcut-desc">Ativar ou desativar microfone</span>
                  <div className="shortcut-keys">
                    <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>M</kbd>
                  </div>
                </div>
                <div className="shortcut-row">
                  <span className="shortcut-desc">Ensurdecer áudio (Deafen)</span>
                  <div className="shortcut-keys">
                    <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd>
                  </div>
                </div>
                <div className="shortcut-row">
                  <span className="shortcut-desc">Alternar entre canais 1 a 9</span>
                  <div className="shortcut-keys">
                    <kbd>Alt</kbd> + <kbd>1..9</kbd>
                  </div>
                </div>
                <div className="shortcut-row">
                  <span className="shortcut-desc">Enviar mensagem no chat</span>
                  <div className="shortcut-keys">
                    <kbd>Enter</kbd>
                  </div>
                </div>
                <div className="shortcut-row">
                  <span className="shortcut-desc">Quebra de linha no texto</span>
                  <div className="shortcut-keys">
                    <kbd>Shift</kbd> + <kbd>Enter</kbd>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ========================================================= */}
          {/* ABA IDIOMA */}
          {/* ========================================================= */}
          {tab === 'language' && (
            <div className="user-settings-pane language-pane">
              <header className="user-settings-pane-header">
                <h2>Idioma da Aplicação</h2>
                <p>Selecione seu idioma de preferência para menus e interface</p>
              </header>

              <div className="language-options-list">
                <button
                  type="button"
                  className={`language-card ${lang === 'pt-BR' ? 'is-selected' : ''}`}
                  onClick={() => setLang('pt-BR')}
                >
                  <div className="language-card-meta">
                    <strong>Português (Brasil)</strong>
                    <span>Idioma padrão</span>
                  </div>
                  {lang === 'pt-BR' && <Check size={18} className="lang-check" />}
                </button>

                <button
                  type="button"
                  className={`language-card ${lang === 'en-US' ? 'is-selected' : ''}`}
                  onClick={() => setLang('en-US')}
                >
                  <div className="language-card-meta">
                    <strong>English (US)</strong>
                    <span>English language interface</span>
                  </div>
                  {lang === 'en-US' && <Check size={18} className="lang-check" />}
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </NativeDialog>
  );
}
