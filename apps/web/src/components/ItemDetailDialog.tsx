import { NativeDialog } from './NativeDialog';
import { SkinPickItem, type SkinItem } from './SkinPickItem';
import { parseSteamProvenance, stripSteamHtml } from '../lib/steamProvenance';

function rarityTier(color?: string): string {
  const c = (color || '').toLowerCase();
  if (c.includes('e4ae39')) return 'mythic';
  if (c.includes('eb4b4b')) return 'legendary';
  if (c.includes('d32ce6')) return 'epic';
  if (c.includes('8847ff')) return 'rare';
  if (c.includes('4b69ff')) return 'uncommon';
  return 'normal';
}

export function ItemDetailDialog({
  open,
  onClose,
  item,
}: {
  open: boolean;
  onClose: () => void;
  item: SkinItem | null;
}) {
  if (!item) return null;
  const accent = item.rarity_color || '#8b9bb4';
  const tier = rarityTier(accent);
  const floatVal =
    (item as { float_value?: string | number }).float_value != null
      ? String((item as { float_value?: string | number }).float_value)
      : '';
  const weapon = (item as { weapon?: string }).weapon || (item as { type?: string }).type || '—';
  const quality = (item as { quality?: string }).quality || '—';
  const acquiredRaw = (item as { acquired_hint?: string }).acquired_hint || '';
  const acquired = acquiredRaw ? stripSteamHtml(acquiredRaw) : 'Sem data pública';
  const marketUrl = (item as { market_url?: string }).market_url;
  const inspectUrl = (item as { inspect_url?: string }).inspect_url;
  const prov = ((item as { provenance?: string[] }).provenance || []).slice(0, 16);
  const { texts, stickers } = parseSteamProvenance(prov);

  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog comm-dialog-wide">
      <div className="comm-dialog-form" onClick={(e) => e.stopPropagation()}>
        <h2>{item.name || 'Item'}</h2>
        <div className="comm-item-detail">
          <div
            className={`comm-item-detail-hero tier-${tier}`}
            style={{ ['--skin-accent' as string]: accent }}
          >
            <span className="comm-skin-ring" aria-hidden />
            <img
              src={item.icon_large || item.icon || '/icon.svg'}
              alt=""
              referrerPolicy="no-referrer"
            />
          </div>
          <dl className="comm-item-facts">
            <div>
              <dt>Raridade</dt>
              <dd style={{ color: accent }}>{item.rarity || '—'}</dd>
            </div>
            <div>
              <dt>Exterior</dt>
              <dd>{item.exterior || '—'}</dd>
            </div>
            <div>
              <dt>Float</dt>
              <dd>{floatVal || 'Indisponível no inventário público'}</dd>
            </div>
            <div>
              <dt>Arma / tipo</dt>
              <dd>{weapon}</dd>
            </div>
            <div>
              <dt>Qualidade</dt>
              <dd>{quality}</dd>
            </div>
            <div>
              <dt>Obtido</dt>
              <dd>{acquired}</dd>
            </div>
            <div>
              <dt>Market hash</dt>
              <dd>{item.market_hash_name || '—'}</dd>
            </div>
            <div>
              <dt>Asset ID</dt>
              <dd>{item.assetid || '—'}</dd>
            </div>
          </dl>

          {stickers.length ? (
            <div className="comm-item-stickers-block">
              <p className="comm-label">Adesivos</p>
              <ul className="comm-item-stickers">
                {stickers.map((s) => (
                  <li key={`${s.src}-${s.title}`}>
                    <img src={s.src} alt={s.title} title={s.title} referrerPolicy="no-referrer" />
                    <span>{s.title.replace(/^Adesivo:\s*/i, '')}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {texts.length ? (
            <div className="comm-item-prov">
              <p className="comm-label">Histórico / descrições</p>
              <ul>
                {texts.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
            {marketUrl ? (
              <a className="btn btn-primary" href={marketUrl} target="_blank" rel="noopener noreferrer">
                Mercado Steam
              </a>
            ) : null}
            {inspectUrl ? (
              <a className="btn" href={inspectUrl} target="_blank" rel="noopener noreferrer">
                Inspecionar no jogo
              </a>
            ) : null}
          </div>
          <p className="muted">
            Float exato só aparece quando a Steam/inventário expõe (inspect). Itens salvos antigos:
            atualize o inventário e salve de novo.
          </p>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </NativeDialog>
  );
}

/** Pré-visualização estática no sheet de membro (tiles compactos). */
export function MemberShowcaseGrid({
  items,
  onOpen,
}: {
  items?: SkinItem[] | null;
  onOpen?: (item: SkinItem) => void;
}) {
  const list = (items || []).slice(0, 5);
  if (!list.length) return null;
  return (
    <div className="comm-member-sheet-showcase">
      {list.map((it) => (
        <button
          key={it.assetid}
          type="button"
          className="comm-member-sheet-skin"
          title={it.name}
          style={{ ['--skin-accent' as string]: it.rarity_color || '#8b9bb4' }}
          onClick={() => onOpen?.(it)}
        >
          <img src={it.icon || it.icon_large || '/icon.svg'} alt="" referrerPolicy="no-referrer" />
        </button>
      ))}
    </div>
  );
}

export { SkinPickItem };
export type { SkinItem };
