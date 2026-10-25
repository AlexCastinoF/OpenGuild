import { useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Link2,
  MessageSquarePlus,
  MoreHorizontal,
  Power,
  QrCode,
  Search,
  Trash2,
} from 'lucide-react';
import {
  avatarLetter,
  chatIsGroup,
  chatPushSub,
  chatTitle,
  formatChatWhen,
  formatMePhone,
  lastMessagePreview,
  lastMessageTs,
  phoneLabel,
} from './waCrypto';
import type { WaHubApi } from './useWaHub';
import {
  WaNewChatDialog,
  WaQrDialog,
  WaStatusPostDialog,
  WaUnlockDialog,
  WaWizardDialog,
} from './WaDialogs';
import { WaMaisDialog } from './WaMaisDialog';

const WA_ICO = (
  <svg className="comm-wa-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
    <path
      fill="currentColor"
      d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"
    />
  </svg>
);

function WaAvatar({
  slot,
  jid,
  label,
  phone,
  imgClass = 'comm-wa-av',
  phClass = 'comm-wa-av-ph',
}: {
  slot: number;
  jid: string;
  label: string;
  phone?: string;
  imgClass?: string;
  phClass?: string;
}) {
  const [broken, setBroken] = useState(false);
  const letter = avatarLetter(label, phone);
  if (!jid || broken) {
    return <span className={phClass}>{letter}</span>;
  }
  return (
    <>
      <img
        className={imgClass}
        src={`/api/community/wa/${slot}/avatar?jid=${encodeURIComponent(jid)}`}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
      {/* placeholder kept for layout if img hides — onError swaps via state */}
    </>
  );
}

export function WaHub({ wa }: { wa: WaHubApi }) {
  const active = wa.currentSlot;
  const connected = active?.status === 'open';
  const phoneLine = active ? formatMePhone(active.me_jid) || `Slot ${active.slot}` : '';
  const nameLine = String(active?.push_name || '').trim();
  const statusLabel =
    connected ? 'Conectado' : active?.status === 'qr' ? 'QR' : active ? 'Offline' : '';
  const showList = wa.tab !== 'status';
  const listTitle =
    wa.tab === 'group'
      ? wa.showArchived
        ? 'Grupos arquivados'
        : 'Grupos recentes'
      : 'Conversas recentes';

  return (
    <>
      <div className="comm-cat comm-wa-hub-panel" data-comm-wa-channels>
        <div className="comm-wa-hub-brand">
          <span className="comm-wa-hub-brand-ico" aria-hidden>
            {WA_ICO}
          </span>
          <strong>WhatsApp</strong>
        </div>

        <div className="comm-wa-slots" data-comm-wa-slots>
          {wa.slots.length > 1 ? (
            <div className="comm-wa-slot-bar">
              {wa.slots.map((s) => {
                const st = s.status === 'open' ? '●' : s.status === 'qr' ? '◐' : '○';
                const label = s.push_name || phoneLabel(s.me_jid) || `WA ${s.slot}`;
                return (
                  <button
                    key={s.slot}
                    type="button"
                    className={`comm-wa-slot${wa.slot === s.slot ? ' is-on' : ''}`}
                    title={s.status}
                    onClick={() => void wa.selectSlot(s.slot)}
                  >
                    <span>{st}</span> {label}
                  </button>
                );
              })}
            </div>
          ) : null}

          {active ? (
            <div className="comm-wa-conn-card">
              <div className="comm-wa-conn-main">
                <div className="comm-wa-conn-who">
                  {active.me_jid && wa.slot ? (
                    <WaAvatar
                      slot={wa.slot}
                      jid={active.me_jid}
                      label={nameLine || phoneLine}
                      imgClass="comm-wa-conn-av"
                      phClass="comm-wa-conn-av-ph"
                    />
                  ) : (
                    <span className="comm-wa-conn-av-ph">WA</span>
                  )}
                  <div className="comm-wa-conn-id">
                    <strong title={phoneLine}>{phoneLine}</strong>
                    {nameLine ? <em title={nameLine}>{nameLine}</em> : null}
                  </div>
                </div>
                <span
                  className={`comm-wa-conn-badge${connected ? ' is-on' : ''}`}
                  title={statusLabel}
                >
                  <i className="comm-wa-conn-dot" aria-hidden />
                  <span>{statusLabel}</span>
                </span>
              </div>
              <div className="comm-wa-conn-actions">
                {!connected || wa.slots.length < 2 ? (
                  <button
                    type="button"
                    className="comm-wa-conn-btn"
                    title="Conectar"
                    onClick={() => void wa.addSlot()}
                  >
                    <Link2 size={14} />
                    <span>Conectar</span>
                  </button>
                ) : null}
                {!connected ? (
                  <button
                    type="button"
                    className="comm-wa-conn-btn"
                    title="Mostrar QR"
                    onClick={() => wa.slot && void wa.showQr(wa.slot)}
                  >
                    <QrCode size={14} />
                    <span>QR</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="comm-wa-conn-btn is-danger"
                  title="Desconectar"
                  onClick={() => {
                    if (
                      wa.slot &&
                      confirm(
                        'Excluir este canal WhatsApp? Isso desconecta o aparelho, apaga a sessão no painel e os relacionamentos locais.',
                      )
                    ) {
                      void wa.logoutSlot(wa.slot);
                    }
                  }}
                >
                  <Power size={14} />
                  <span>Sair</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="comm-wa-conn-card is-empty">
              <p className="muted">Conecte até 2 WhatsApps.</p>
              <div className="comm-wa-conn-actions">
                <button
                  type="button"
                  className="comm-wa-conn-btn is-accent"
                  title="Conectar"
                  onClick={() => void wa.addSlot()}
                >
                  <Link2 size={14} />
                  <span>Conectar</span>
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="comm-wa-actions" data-comm-wa-actions>
          <button
            type="button"
            className="comm-wa-action is-accent"
            title="Nova conversa"
            disabled={!wa.slot || !wa.unlocked || !connected}
            onClick={() => wa.setNewChatOpen(true)}
          >
            <MessageSquarePlus size={16} />
            <span>Nova conversa</span>
          </button>
          <button
            type="button"
            className="comm-wa-action"
            title="Limpar conversas do painel"
            disabled={!wa.slot || !wa.unlocked}
            onClick={() => void wa.clearChatsPanel()}
          >
            <Trash2 size={16} />
            <span>Limpar</span>
          </button>
          <button
            type="button"
            className="comm-wa-action"
            title="Mais opções"
            disabled={!wa.slot || !wa.unlocked}
            onClick={() => wa.setMaisOpen(true)}
          >
            <MoreHorizontal size={16} />
            <span>Mais</span>
          </button>
        </div>

        <div className="comm-wa-tabs" role="tablist">
          <button
            type="button"
            className={`comm-wa-tab${wa.tab === 'dm' ? ' is-on' : ''}`}
            data-wa-tab="dm"
            role="tab"
            aria-selected={wa.tab === 'dm'}
            onClick={() => wa.setTab('dm')}
          >
            Conversas
          </button>
          <button
            type="button"
            className={`comm-wa-tab${wa.tab === 'group' ? ' is-on' : ''}`}
            data-wa-tab="group"
            role="tab"
            aria-selected={wa.tab === 'group'}
            onClick={() => wa.setTab('group')}
          >
            Grupos
          </button>
          <button
            type="button"
            className={`comm-wa-tab${wa.tab === 'status' ? ' is-on' : ''}`}
            data-wa-tab="status"
            role="tab"
            aria-selected={wa.tab === 'status'}
            onClick={() => wa.setTab('status')}
          >
            Status
          </button>
        </div>

        {showList ? (
          <div className="comm-wa-search-wrap" data-comm-wa-search-wrap>
            <Search size={14} aria-hidden />
            <input
              type="search"
              className="comm-wa-search"
              placeholder={wa.tab === 'group' ? 'Buscar grupos…' : 'Buscar conversas…'}
              value={wa.search}
              onChange={(e) => wa.setSearch(e.target.value)}
              autoComplete="off"
            />
          </div>
        ) : null}

        {wa.tab === 'group' ? (
          <div className="comm-wa-subbar" data-comm-wa-subbar>
            <button
              type="button"
              className={`comm-wa-arch-toggle${wa.showArchived ? ' is-on' : ''}`}
              onClick={() => wa.setShowArchived(!wa.showArchived)}
            >
              {wa.showArchived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
              <span>{wa.showArchived ? 'Voltar aos grupos' : 'Ver arquivados'}</span>
              {!wa.showArchived && wa.archivedGroupCount > 0 ? (
                <em>{wa.archivedGroupCount}</em>
              ) : null}
            </button>
          </div>
        ) : null}

        {showList ? (
          <div className="comm-wa-list-head" data-comm-wa-list-head>
            <span>
              {wa.loadingChats
                ? 'Carregando…'
                : `${listTitle} · ${wa.chats.length}`}
            </span>
          </div>
        ) : null}

        {wa.error ? <p className="muted comm-wa-empty">{wa.error}</p> : null}

        <ul
          className="comm-wa-chat-list"
          data-comm-wa-chats
          hidden={wa.tab === 'status'}
        >
          {!wa.slot ? (
            <li className="muted comm-wa-empty">Conecte um WhatsApp para ver conversas.</li>
          ) : !wa.unlocked ? (
            <li className="muted comm-wa-empty">Desbloqueie com a senha de criptografia.</li>
          ) : wa.chats.length === 0 ? (
            <li className="muted comm-wa-empty">
              {wa.tab === 'group'
                ? wa.showArchived
                  ? 'Nenhum grupo arquivado.'
                  : 'Nenhum grupo ainda.'
                : 'Nenhuma conversa ainda. Use Nova para iniciar.'}
            </li>
          ) : (
            wa.chats.map((c) => {
              const on = wa.chatJid === c.jid;
              const group = chatIsGroup(c);
              const title = chatTitle(c);
              const push = chatPushSub(c);
              const preview = lastMessagePreview(c);
              const sub = group
                ? preview || 'Grupo'
                : preview || c.phoneDisplay || c.phone || '';
              const when = formatChatWhen(lastMessageTs(c));
              const unread = Number(c.unreadCount ?? c.unread ?? 0);
              const isArch = group && wa.archived.has(String(c.jid || ''));
              return (
                <li
                  key={c.jid}
                  className={`comm-wa-chat-item${on ? ' is-on' : ''}`}
                >
                  <button
                    type="button"
                    className={`comm-wa-row${on ? ' is-on' : ''}`}
                    onClick={() =>
                      void wa.openChat(c.jid, title, group, c.phone || '')
                    }
                  >
                    {wa.slot ? (
                      <WaAvatar
                        slot={wa.slot}
                        jid={c.jid}
                        label={title}
                        phone={c.phone}
                      />
                    ) : (
                      <span className="comm-wa-av-ph">{avatarLetter(title)}</span>
                    )}
                    <span className="comm-wa-row-meta">
                      <span className="comm-wa-row-top">
                        <strong>{title}</strong>
                        {when ? <time>{when}</time> : null}
                      </span>
                      {push ? <em className="comm-wa-row-push">{push}</em> : null}
                      <span className="comm-wa-row-bottom">
                        <em className="comm-wa-row-sub">{String(sub).slice(0, 64)}</em>
                        {unread > 0 ? (
                          <em className="comm-wa-unread">{unread > 99 ? '99+' : unread}</em>
                        ) : null}
                      </span>
                    </span>
                  </button>
                  {group ? (
                    <div className="comm-wa-row-acts">
                      <button
                        type="button"
                        className="comm-wa-row-act"
                        title={isArch || wa.showArchived ? 'Desarquivar' : 'Arquivar'}
                        onClick={(e) => {
                          e.stopPropagation();
                          void wa.toggleArchive(c.jid, !(isArch || wa.showArchived));
                        }}
                      >
                        {isArch || wa.showArchived ? (
                          <ArchiveRestore size={13} />
                        ) : (
                          <Archive size={13} />
                        )}
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>

        <div
          className="comm-wa-status-panel"
          data-comm-wa-statuses
          hidden={wa.tab !== 'status'}
        >
          <div className="comm-wa-status-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!wa.slot || !connected}
              onClick={() => wa.setStatusPostOpen(true)}
            >
              Meu status
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!wa.slot}
              onClick={() => wa.slot && void wa.loadStatuses(wa.slot)}
            >
              Atualizar
            </button>
          </div>
          {wa.loadingStatuses ? (
            <p className="muted" style={{ padding: '8px 12px', fontSize: '.8rem' }}>
              Carregando status…
            </p>
          ) : wa.statuses.length === 0 ? (
            <p className="muted" style={{ padding: '8px 12px', fontSize: '.8rem' }}>
              Nenhum status nesta sessão. Contatos aparecem quando publicam com você
              conectado.
            </p>
          ) : (
            <div className="comm-wa-status-rail">
              {wa.statuses.map((s) => {
                const title = s.isMe
                  ? 'Meu status'
                  : s.pushName || s.phoneDisplay || s.authorJid || s.authorKey;
                return (
                  <button
                    key={s.authorKey}
                    type="button"
                    className="comm-wa-status-tile"
                    title={title}
                  >
                    <span className={`comm-wa-status-ring${s.isMe ? ' is-me' : ''}`}>
                      {wa.slot && s.authorJid && !s.isMe ? (
                        <WaAvatar
                          slot={wa.slot}
                          jid={s.authorJid}
                          label={title}
                          phone={s.phone}
                        />
                      ) : (
                        <span className="comm-wa-av-ph">{avatarLetter(title, s.phone)}</span>
                      )}
                    </span>
                    <strong>{title}</strong>
                    <em>{(s.items || []).length} updates</em>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <WaWizardDialog
        open={wa.wizardOpen}
        slotNum={wa.wizardSlot}
        onClose={() => wa.setWizardOpen(false)}
        onReadyForQr={(s) => {
          void wa.refreshSlots().then(() => {
            wa.setSlot(s.slot);
            wa.setUnlocked(true);
            void wa.showQr(s.slot);
            wa.startEvents(s.slot);
          });
        }}
      />
      <WaUnlockDialog
        open={wa.unlockOpen}
        slot={wa.unlockSlot}
        onClose={() => wa.setUnlockOpen(false)}
        onUnlocked={() => {
          wa.setUnlocked(true);
          if (wa.unlockSlot) {
            const n = wa.unlockSlot.slot;
            wa.startEvents(n);
            if (wa.unlockSlot.status !== 'open') void wa.showQr(n);
            else void wa.loadChats(n);
          }
        }}
      />
      <WaQrDialog
        open={wa.qrOpen}
        slotNum={wa.slot || wa.wizardSlot}
        qrPng={wa.qrPng}
        statusText={wa.qrStatus}
        onClose={() => wa.setQrOpen(false)}
        onRefresh={() => void wa.showQr(wa.slot || wa.wizardSlot)}
      />
      {wa.slot ? (
        <WaNewChatDialog
          open={wa.newChatOpen}
          slotNum={wa.slot}
          onClose={() => wa.setNewChatOpen(false)}
          onStarted={(jid, name) => void wa.openChat(jid, name, jid.endsWith('@g.us'))}
        />
      ) : null}
      <WaStatusPostDialog
        open={wa.statusPostOpen}
        onClose={() => wa.setStatusPostOpen(false)}
        onPost={(text) => wa.postStatus(text)}
      />
      <WaMaisDialog
        open={wa.maisOpen}
        slot={wa.slot}
        slotInfo={wa.currentSlot}
        onClose={() => wa.setMaisOpen(false)}
      />
    </>
  );
}
