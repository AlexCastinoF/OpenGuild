import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { avatarLetter, phoneLabel } from './waCrypto';
import type { WaHubApi } from './useWaHub';

type PeerData = {
  contactName?: string;
  pushName?: string;
  name?: string;
  phone?: string;
  phoneDisplay?: string;
  commonGroups?: Array<{ jid: string; subject?: string; size?: number }>;
  groupsListed?: number;
  groupsWithParticipants?: number;
  groupsRateLimited?: boolean;
  groupsRefreshed?: boolean;
};

type GroupMember = {
  jid?: string;
  lid?: string;
  name?: string;
  contactName?: string;
  pushName?: string;
  phone?: string;
  phoneDisplay?: string;
  role?: string;
};

type GroupData = {
  subject?: string;
  desc?: string;
  members?: GroupMember[];
  orphan?: boolean;
  forbidden?: boolean;
};

function SideAvatar({
  slot,
  jid,
  label,
  phone,
  imgClass,
  phClass,
}: {
  slot: number;
  jid: string;
  label: string;
  phone?: string;
  imgClass: string;
  phClass: string;
}) {
  const [broken, setBroken] = useState(false);
  if (!jid || broken) {
    return <span className={phClass}>{avatarLetter(label, phone)}</span>;
  }
  return (
    <img
      className={imgClass}
      src={`/api/community/wa/${slot}/avatar?jid=${encodeURIComponent(jid)}`}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}

export function WaSidePanel({ wa }: { wa: WaHubApi }) {
  const [peer, setPeer] = useState<PeerData | null>(null);
  const [group, setGroup] = useState<GroupData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const slot = wa.slot;
  const jid = wa.chatJid;
  const isGroup = wa.isGroup;

  async function loadPeer(refresh = false) {
    if (!slot || !jid) return;
    setLoading(true);
    setError('');
    try {
      const q = refresh ? '&refresh=1' : '';
      const data = await api<PeerData>(
        `/api/community/wa/${slot}/peer?jid=${encodeURIComponent(jid)}${q}`,
      );
      setPeer(data);
      setGroup(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro');
    } finally {
      setLoading(false);
    }
  }

  async function loadGroup() {
    if (!slot || !jid) return;
    setLoading(true);
    setError('');
    try {
      const data = await api<GroupData>(
        `/api/community/wa/${slot}/group?jid=${encodeURIComponent(jid)}`,
      );
      setGroup(data);
      setPeer(null);
      if (data.subject) {
        /* title refresh handled by parent via openChat name */
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/\b403\b|forbidden/i.test(msg)) {
        setGroup({ orphan: true, forbidden: true, subject: wa.chatName || jid });
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setPeer(null);
    setGroup(null);
    setError('');
    if (!slot || !jid) return;
    if (isGroup) void loadGroup();
    else void loadPeer(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot, jid, isGroup]);

  async function leaveOrDelete(opts: { leave: boolean; deleteChat: boolean }) {
    if (!slot || !jid) return;
    const label = opts.leave
      ? 'Sair deste grupo?'
      : 'Apagar conversa do painel/celular?';
    if (!confirm(label)) return;
    try {
      await api(`/api/community/wa/${slot}/leave-groups`, {
        method: 'POST',
        body: JSON.stringify({
          jids: [jid],
          leave: opts.leave,
          deleteChat: opts.deleteChat,
        }),
      });
      if (opts.deleteChat || opts.leave) {
        await wa.loadChats(slot);
        wa.setChatJid(null);
        wa.setChatName('');
        wa.setIsGroup(false);
      } else {
        void loadGroup();
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Falha');
    }
  }

  if (!slot || !jid) {
    return <p className="muted" style={{ padding: 8 }}>Abra uma conversa.</p>;
  }

  if (loading && !peer && !group) {
    return (
      <p className="muted" style={{ padding: 8 }}>
        {isGroup ? 'Carregando grupo…' : 'Carregando contato…'}
      </p>
    );
  }

  if (error && !peer && !group) {
    return <p className="muted" style={{ padding: 8 }}>{error}</p>;
  }

  if (isGroup && group) {
    if (group.orphan || group.forbidden) {
      return (
        <div className="comm-wa-group-sidehead is-orphan">
          <strong>{group.subject || wa.chatName || jid}</strong>
          <p className="muted">
            Você não participa mais deste grupo (metadata bloqueada). Pode excluir a conversa.
          </p>
          <div className="comm-wa-group-sideacts">
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => void leaveOrDelete({ leave: false, deleteChat: true })}
            >
              Excluir conversa
            </button>
          </div>
        </div>
      );
    }
    const members = group.members || [];
    return (
      <>
        <div className="comm-wa-group-sidehead">
          <strong>{group.subject || wa.chatName || 'Grupo'}</strong>
          {group.desc ? <p className="muted">{group.desc}</p> : null}
          <div className="comm-wa-group-sideacts">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void leaveOrDelete({ leave: true, deleteChat: false })}
            >
              Sair
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void leaveOrDelete({ leave: false, deleteChat: true })}
            >
              Apagar
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void loadGroup()}>
              Atualizar
            </button>
          </div>
        </div>
        {!members.length ? (
          <p className="muted" style={{ padding: 8 }}>
            Sem membros.
          </p>
        ) : (
          members.map((m) => {
            const phone = m.phoneDisplay || (m.phone ? `+${String(m.phone).replace(/\D/g, '')}` : '');
            const contactName = String(m.contactName || '').trim();
            const pushName = String(m.pushName || '').trim();
            const rawName = String(m.name || '').trim();
            const title = contactName || pushName || rawName || phone || 'Contato';
            const label = title;
            const pushLine = pushName && pushName !== label ? pushName : '';
            const sub = [phone && phone !== label ? phone : '', m.role || 'membro']
              .filter(Boolean)
              .join(' · ');
            const memberJid = m.lid || m.jid || '';
            return (
              <button
                key={memberJid || label}
                type="button"
                className="comm-member comm-wa-member"
                onClick={() => {
                  if (memberJid) void wa.openChat(memberJid, label, false);
                }}
              >
                <SideAvatar
                  slot={slot}
                  jid={memberJid}
                  label={label}
                  phone={m.phone || phone}
                  imgClass="comm-wa-av"
                  phClass="comm-wa-av-ph"
                />
                <span className="comm-wa-member-meta">
                  <strong title={label}>{label}</strong>
                  {pushLine ? <em className="comm-wa-row-push">{pushLine}</em> : null}
                  <em>{sub}</em>
                </span>
              </button>
            );
          })
        )}
      </>
    );
  }

  if (!isGroup && peer) {
    const saved = String(peer.contactName || '').trim();
    const pushName = String(peer.pushName || '').trim();
    const fallback = String(peer.name || '').trim();
    const title = saved || pushName || fallback || wa.chatName || 'Contato';
    const phone =
      peer.phoneDisplay ||
      (peer.phone ? `+${String(peer.phone).replace(/\D/g, '')}` : '') ||
      phoneLabel(jid);
    const groups = peer.commonGroups || [];
    const listed = Number(peer.groupsListed || 0);
    const withParts = Number(peer.groupsWithParticipants || 0);
    const rateLimited = !!peer.groupsRateLimited;

    return (
      <div className="comm-wa-peer" data-wa-peer-jid={jid}>
        <div className="comm-wa-peer-av">
          <SideAvatar
            slot={slot}
            jid={jid}
            label={title}
            phone={peer.phone || phone}
            imgClass="comm-wa-peer-photo"
            phClass="comm-wa-peer-photo-ph"
          />
        </div>
        <strong className="comm-wa-peer-name">{title}</strong>
        {pushName && pushName !== title ? <em className="comm-wa-peer-push">{pushName}</em> : null}
        {phone ? <p className="comm-wa-peer-phone">{phone}</p> : null}
        <div className="comm-wa-peer-h-row">
          <h4 className="comm-wa-peer-h">Grupos em comum</h4>
          <button
            type="button"
            className="btn btn-sm comm-wa-peer-verify"
            disabled={loading}
            onClick={() => void loadPeer(true)}
            title="Atualiza cache de grupos e busca em comum"
          >
            Verificar
          </button>
        </div>
        {rateLimited && listed > 0 ? (
          <p className="muted comm-wa-peer-groups-meta">
            {listed} grupo(s) · limite WhatsApp
            {groups.length ? ` · ${groups.length} em comum` : ''}
          </p>
        ) : listed > 0 ? (
          <p className="muted comm-wa-peer-groups-meta">
            {listed} grupo(s)
            {withParts ? ` · ${withParts} com membros` : ''}
            {groups.length ? ` · ${groups.length} em comum` : ''}
          </p>
        ) : null}
        {groups.length ? (
          <ul className="comm-wa-peer-groups">
            {groups.map((g) => (
              <li key={g.jid}>
                <button
                  type="button"
                  className="comm-wa-peer-group"
                  onClick={() => void wa.openChat(g.jid, g.subject || g.jid, true)}
                >
                  {g.subject || g.jid}
                  {g.size ? <span className="muted"> ({g.size})</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted comm-wa-peer-groups-empty">
            {listed > 0
              ? 'Nenhum grupo em comum encontrado na sua conta.'
              : 'Nenhum grupo na conta — abra um grupo no WhatsApp ou clique em Verificar.'}
          </p>
        )}
      </div>
    );
  }

  return null;
}
