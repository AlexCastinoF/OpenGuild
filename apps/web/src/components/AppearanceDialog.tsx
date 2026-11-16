import React, { useId } from 'react';
import { Palette, X, RotateCcw, Check, AlertTriangle } from 'lucide-react';
import { useAppearance } from '../hooks/useAppearance';
import {
  ACCENT_SWATCHES,
  AREA_SWATCHES,
  BG_SWATCHES,
  LayoutStyle,
  isContrastAdequate,
} from '../lib/appearance';
import '../styles/appearance.css';

export function AppearanceDialog() {
  const { isOpen, close, preview, updatePreview, save, resetToDefault, cancel } =
    useAppearance();

  const titleId = useId();

  if (!isOpen) return null;

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

  // Check contrast for text against main/chat background
  const mainContrastOk = isContrastAdequate(preview.main);
  const sideContrastOk = isContrastAdequate(preview.side);

  return (
    <div
      className="appearance-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div className="appearance-modal">
        <header className="appearance-header">
          <div className="appearance-title-group">
            <div className="appearance-icon-badge">
              <Palette size={20} strokeWidth={1.8} />
            </div>
            <div>
              <h2 id={titleId} className="appearance-title">
                Aparência do RallyDesk
              </h2>
              <p className="appearance-subtitle">
                Personalize o estilo em ilhas, cores por área e raio dos painéis
              </p>
            </div>
          </div>
          <button
            type="button"
            className="appearance-close-btn"
            onClick={cancel}
            aria-label="Fechar e descartar alterações"
          >
            <X size={18} strokeWidth={1.8} />
          </button>
        </header>

        <div className="appearance-body">
          {/* Layout Style Segmented Control */}
          <section className="appearance-section">
            <label className="appearance-section-label">Estilo do Layout</label>
            <div className="appearance-segmented" role="radiogroup">
              {(
                [
                  { id: 'islands', label: 'Ilhas (Padrão)', desc: 'Painéis flutuantes com espaçamento' },
                  { id: 'continuous', label: 'Contínuo', desc: 'Sem separação, visual sólido' },
                  { id: 'glass', label: 'Vidro (Glass)', desc: 'Semimtransparente com desfoque' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={preview.layoutStyle === opt.id}
                  className={`appearance-segment ${preview.layoutStyle === opt.id ? 'is-active' : ''}`}
                  onClick={() => updatePreview({ layoutStyle: opt.id as LayoutStyle })}
                >
                  <span className="appearance-segment-title">{opt.label}</span>
                  <span className="appearance-segment-desc">{opt.desc}</span>
                </button>
              ))}
            </div>
          </section>

          {/* Sliders for Radius and Gap */}
          {preview.layoutStyle !== 'continuous' && (
            <section className="appearance-section appearance-sliders-row">
              <div className="appearance-slider-item">
                <div className="appearance-slider-header">
                  <label htmlFor="input-radius" className="appearance-section-label">
                    Arredondamento das Ilhas
                  </label>
                  <span className="appearance-slider-val">{preview.radius}px</span>
                </div>
                <input
                  id="input-radius"
                  type="range"
                  min={0}
                  max={32}
                  value={preview.radius}
                  onChange={(e) => updatePreview({ radius: Number(e.target.value) })}
                  className="appearance-range"
                />
              </div>

              <div className="appearance-slider-item">
                <div className="appearance-slider-header">
                  <label htmlFor="input-gap" className="appearance-section-label">
                    Espaçamento entre Ilhas
                  </label>
                  <span className="appearance-slider-val">{preview.gap}px</span>
                </div>
                <input
                  id="input-gap"
                  type="range"
                  min={0}
                  max={24}
                  value={preview.gap}
                  onChange={(e) => updatePreview({ gap: Number(e.target.value) })}
                  className="appearance-range"
                />
              </div>
            </section>
          )}

          {/* Area Color Pickers */}
          <section className="appearance-section">
            <div className="appearance-section-header">
              <label className="appearance-section-label">Cores por Área</label>
              {(!mainContrastOk || !sideContrastOk) && (
                <div className="appearance-contrast-warn">
                  <AlertTriangle size={14} />
                  <span>Atenção: contraste de texto pode ficar reduzido com tons muito claros</span>
                </div>
              )}
            </div>

            <div className="appearance-color-rows">
              {areas.map((area) => {
                const currentColor = preview[area.key];

                return (
                  <div key={area.key} className="appearance-color-row">
                    <span className="appearance-color-name">{area.label}</span>
                    <div className="appearance-swatches-group">
                      {area.swatches.map((swatch) => {
                        const isSelected =
                          currentColor.toLowerCase() === swatch.value.toLowerCase();
                        return (
                          <button
                            key={swatch.value}
                            type="button"
                            className={`appearance-swatch-btn ${isSelected ? 'is-selected' : ''}`}
                            style={{ backgroundColor: swatch.value }}
                            title={`${swatch.label} (${swatch.value})`}
                            aria-label={`${area.label}: ${swatch.label}`}
                            onClick={() => updatePreview({ [area.key]: swatch.value })}
                          >
                            {isSelected && <Check size={14} strokeWidth={2.5} />}
                          </button>
                        );
                      })}

                      {/* Custom Color Picker input */}
                      <label
                        className="appearance-swatch-custom"
                        title="Escolher cor personalizada"
                        aria-label={`Cor personalizada para ${area.label}`}
                      >
                        <input
                          type="color"
                          value={currentColor}
                          onChange={(e) => updatePreview({ [area.key]: e.target.value })}
                          className="appearance-color-input"
                        />
                        <span
                          className="appearance-swatch-custom-preview"
                          style={{ backgroundColor: currentColor }}
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <footer className="appearance-footer">
          <button
            type="button"
            className="appearance-btn-ghost"
            onClick={resetToDefault}
          >
            <RotateCcw size={16} strokeWidth={1.8} />
            <span>Restaurar padrão</span>
          </button>

          <div className="appearance-footer-actions">
            <button
              type="button"
              className="appearance-btn-cancel"
              onClick={cancel}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="appearance-btn-save"
              onClick={save}
            >
              Salvar Alterações
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
