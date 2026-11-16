import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
  CSSProperties,
} from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Compass,
  Crop,
  Image as ImageIcon,
  Palette,
  RefreshCw,
  Save,
  Shield,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { NativeDialog } from './NativeDialog';
import { CustomSelect } from './CustomSelect';
import { api, getApiBaseUrl } from '../lib/api';
import { PERMISSION_GROUPS } from '@steamfarm/shared';
import '../styles/server-settings.css';

const BORDER_EFFECT_OPTIONS = [
  { value: 'none', label: 'Nenhum' },
  { value: 'solid', label: 'Sólida' },
  { value: 'glow', label: 'Brilho (Glow)' },
  { value: 'neon', label: 'Neon' },
  { value: 'double', label: 'Borda Dupla' },
];

const BORDER_MOTION_OPTIONS = [
  { value: 'none', label: 'Parado' },
  { value: 'pulse', label: 'Pulso suave' },
  { value: 'shimmer', label: 'Brilho deslizante' },
  { value: 'laser', label: 'Laser girando' },
];

export type Role = {
  id: number;
  name: string;
  color?: string | null;
  permissions?: string[] | unknown;
  is_default?: boolean;
  hoist?: boolean;
  member_card_color?: string | null;
  border_color?: string | null;
  border_effect?: string | null;
  border_motion?: string | null;
};

// ---------------------------------------------------------------------------
// Upload com barra de progresso nativa (XMLHttpRequest)
// ---------------------------------------------------------------------------
function uploadMediaWithProgress(
  file: Blob | File,
  kind: 'icon' | 'banner',
  onProgress?: (percent: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('kind', kind);
    fd.append('file', file, file instanceof File ? file.name : `${kind}.png`);

    const xhr = new XMLHttpRequest();
    const base = getApiBaseUrl();
    xhr.open('POST', `${base}/api/community/media`);
    xhr.withCredentials = true;

    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          onProgress(pct);
        }
      };
    }

    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText) as { ok?: boolean; url?: string; error?: string };
        if (xhr.status >= 200 && xhr.status < 300 && data.ok !== false && data.url) {
          resolve(data.url);
        } else {
          reject(new Error(data.error || `HTTP ${xhr.status}`));
        }
      } catch {
        reject(new Error('Resposta inválida do servidor'));
      }
    };

    xhr.onerror = () => {
      reject(new Error('Falha de conexão ao enviar imagem'));
    };

    xhr.send(fd);
  });
}

// ---------------------------------------------------------------------------
// Modal de Recorte Interativo (HTML5 Canvas — Proporção travada)
// ---------------------------------------------------------------------------
function ImageCropModal({
  open,
  imageSrc,
  aspectRatio, // 1 para 1:1, 4 para 4:1
  title,
  onConfirm,
  onCancel,
  onSkipCrop,
}: {
  open: boolean;
  imageSrc: string;
  aspectRatio: number;
  title: string;
  onConfirm: (croppedBlob: Blob) => void;
  onCancel: () => void;
  onSkipCrop: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!open || !imageSrc) return;
    setZoom(1);
    setPan({ x: 0, y: 0 });

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = imageSrc;
    img.onload = () => {
      imgRef.current = img;
      draw();
    };
  }, [open, imageSrc]);

  function draw() {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0b0b10';
    ctx.fillRect(0, 0, w, h);

    const imgRatio = img.width / img.height;
    let baseWidth = w;
    let baseHeight = w / imgRatio;
    if (baseHeight < h) {
      baseHeight = h;
      baseWidth = h * imgRatio;
    }

    const drawW = baseWidth * zoom;
    const drawH = baseHeight * zoom;
    const drawX = (w - drawW) / 2 + pan.x;
    const drawY = (h - drawH) / 2 + pan.y;

    ctx.drawImage(img, drawX, drawY, drawW, drawH);

    // Guia de corte
    if (aspectRatio === 1) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, Math.min(w, h) / 2 - 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  useEffect(() => {
    draw();
  }, [zoom, pan]);

  function handlePointerDown(e: React.PointerEvent) {
    setIsDragging(true);
    dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!isDragging) return;
    setPan({
      x: e.clientX - dragStart.current.x,
      y: e.clientY - dragStart.current.y,
    });
  }

  function handlePointerUp() {
    setIsDragging(false);
  }

  function handleConfirmCrop() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const outCanvas = document.createElement('canvas');
    if (aspectRatio === 1) {
      outCanvas.width = 512;
      outCanvas.height = 512;
    } else {
      outCanvas.width = 960;
      outCanvas.height = 240;
    }
    const outCtx = outCanvas.getContext('2d');
    const img = imgRef.current;
    if (!outCtx || !img) return;

    const w = outCanvas.width;
    const h = outCanvas.height;

    const imgRatio = img.width / img.height;
    let baseWidth = w;
    let baseHeight = w / imgRatio;
    if (baseHeight < h) {
      baseHeight = h;
      baseWidth = h * imgRatio;
    }

    const scaleFactor = outCanvas.width / (canvas.width || 1);
    const drawW = baseWidth * zoom;
    const drawH = baseHeight * zoom;
    const drawX = (w - drawW) / 2 + pan.x * scaleFactor;
    const drawY = (h - drawH) / 2 + pan.y * scaleFactor;

    outCtx.drawImage(img, drawX, drawY, drawW, drawH);

    outCanvas.toBlob(
      (blob) => {
        if (blob) onConfirm(blob);
      },
      'image/webp',
      0.92,
    );
  }

  if (!open) return null;

  const canvasWidth = 440;
  const canvasHeight = Math.round(canvasWidth / aspectRatio);

  return (
    <div className="comm-crop-modal-overlay" onClick={onCancel}>
      <div className="comm-crop-modal" onClick={(e) => e.stopPropagation()}>
        <div className="comm-crop-head">
          <h3>
            <Crop size={18} style={{ display: 'inline', marginRight: 6, verticalAlign: -2 }} />
            {title}
          </h3>
          <button type="button" className="comm-server-settings-close-btn" onClick={onCancel}>
            <X size={18} />
          </button>
        </div>
        <div className="comm-crop-body">
          <div
            className="comm-crop-canvas-container"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            <canvas ref={canvasRef} width={canvasWidth} height={canvasHeight} />
          </div>
          <div className="comm-crop-controls">
            <span className="comm-crop-zoom-label">Zoom</span>
            <input
              type="range"
              min="1"
              max="3"
              step="0.05"
              value={zoom}
              onChange={(e) => setZoom(parseFloat(e.target.value))}
              className="comm-crop-slider"
            />
            <span className="comm-char-count">{Math.round(zoom * 100)}%</span>
          </div>
        </div>
        <div className="comm-crop-foot">
          <button type="button" className="comm-btn-cancel" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="comm-media-thumb-btn" onClick={onSkipCrop}>
            Usar original
          </button>
          <button type="button" className="comm-btn-save" onClick={handleConfirmCrop}>
            <Check size={16} /> Aplicar recorte
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Componente Principal ServerSettingsDialog
// ---------------------------------------------------------------------------
export function ServerSettingsDialog({
  open,
  onClose,
  serverId,
  initial,
  canManageRoles,
  members = [],
  initialTab = 'appearance',
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  serverId: number;
  initial: {
    name: string;
    description: string;
    is_listed: boolean;
    icon_url: string;
    banner_url: string;
  };
  canManageRoles: boolean;
  members?: Array<{ id: number; label: string; role: string }>;
  initialTab?: 'appearance' | 'roles';
  onDone: () => void;
}) {
  const [tab, setTab] = useState<'appearance' | 'roles'>(initialTab);

  // Baseline snapshot para cálculo estrito de isDirty (inicializa idêntico)
  const baselineRef = useRef({
    name: (initial.name || '').trim(),
    description: (initial.description || '').trim(),
    listed: !!initial.is_listed,
    iconUrl: (initial.icon_url || '').trim(),
    bannerUrl: (initial.banner_url || '').trim(),
  });

  // Form states (Aparência)
  const [name, setName] = useState(baselineRef.current.name);
  const [description, setDescription] = useState(baselineRef.current.description);
  const [listed, setListed] = useState(baselineRef.current.listed);
  const [iconUrl, setIconUrl] = useState(baselineRef.current.iconUrl);
  const [bannerUrl, setBannerUrl] = useState(baselineRef.current.bannerUrl);
  const [nameTouched, setNameTouched] = useState(false);

  // Media upload states
  const [iconMode, setIconMode] = useState<'file' | 'url'>('file');
  const [bannerMode, setBannerMode] = useState<'file' | 'url'>('file');
  const [iconProgress, setIconProgress] = useState<number | null>(null);
  const [bannerProgress, setBannerProgress] = useState<number | null>(null);
  const [iconError, setIconError] = useState('');
  const [bannerError, setBannerError] = useState('');
  const [isDraggingIcon, setIsDraggingIcon] = useState(false);
  const [isDraggingBanner, setIsDraggingBanner] = useState(false);

  // Crop states
  const [cropModal, setCropModal] = useState<{
    open: boolean;
    kind: 'icon' | 'banner';
    src: string;
    rawFile?: File;
  }>({ open: false, kind: 'icon', src: '' });

  // Dialog & Saving states
  const [isSaving, setIsSaving] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [rolesError, setRolesError] = useState('');

  // Roles state (Mantém integridade total)
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [roleName, setRoleName] = useState('');
  const [roleColor, setRoleColor] = useState('#949ba4');
  const [cardColor, setCardColor] = useState('#5865f2');
  const [borderColor, setBorderColor] = useState('#949ba4');
  const [borderEffect, setBorderEffect] = useState('solid');
  const [borderMotion, setBorderMotion] = useState('none');
  const [hoist, setHoist] = useState(false);
  const [perms, setPerms] = useState<string[]>([]);
  const [assignUserId, setAssignUserId] = useState<number | ''>('');
  const [assignRoleIds, setAssignRoleIds] = useState<number[]>([]);

  const wasOpen = useRef(false);
  const fileInputIconRef = useRef<HTMLInputElement>(null);
  const fileInputBannerRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerElementRef = useRef<HTMLElement | null>(null);

  // Cálculo de isDirty: comparado contra o baseline capturado na abertura
  const isDirty =
    name.trim() !== baselineRef.current.name ||
    description.trim() !== baselineRef.current.description ||
    listed !== baselineRef.current.listed ||
    iconUrl.trim() !== baselineRef.current.iconUrl ||
    bannerUrl.trim() !== baselineRef.current.bannerUrl;

  const isNameValid = name.trim().length >= 2 && name.trim().length <= 100;

  // Ao abrir o modal, reseta os campos E o baseline snapshot
  useEffect(() => {
    if (open && !wasOpen.current) {
      triggerElementRef.current = document.activeElement as HTMLElement | null;
      setTab(canManageRoles ? initialTab : 'appearance');
      const b = {
        name: (initial.name || '').trim(),
        description: (initial.description || '').trim(),
        listed: !!initial.is_listed,
        iconUrl: (initial.icon_url || '').trim(),
        bannerUrl: (initial.banner_url || '').trim(),
      };
      baselineRef.current = b;
      setName(b.name);
      setDescription(b.description);
      setListed(b.listed);
      setIconUrl(b.iconUrl);
      setBannerUrl(b.bannerUrl);
      setNameTouched(false);
      setIconError('');
      setBannerError('');
      setIconProgress(null);
      setBannerProgress(null);
      setShowToast(false);
      setSelectedId(null);
      setAssignUserId('');
      setAssignRoleIds([]);
    } else if (!open && wasOpen.current) {
      if (triggerElementRef.current && typeof triggerElementRef.current.focus === 'function') {
        triggerElementRef.current.focus();
      }
    }
    wasOpen.current = open;
  }, [open, initial, initialTab, canManageRoles]);

  // Carregar cargos se a aba for roles
  useEffect(() => {
    if (open && tab === 'roles' && canManageRoles) {
      void loadRoles().catch((e: Error) => setRolesError(e.message));
    }
  }, [open, tab, serverId, canManageRoles]);

  async function loadRoles() {
    const d = await api<{ roles: Role[] }>(`/api/community/servers/${serverId}/roles`);
    setRoles(d.roles);
    if (d.roles[0] && !selectedId) selectRole(d.roles[0]);
  }

  function selectRole(r: Role) {
    setSelectedId(r.id);
    setRoleName(r.name);
    setRoleColor(r.color || '#949ba4');
    setCardColor(r.member_card_color || '#5865f2');
    setBorderColor(r.border_color || r.color || '#949ba4');
    setBorderEffect(r.border_effect || 'solid');
    setBorderMotion(r.border_motion || 'none');
    setHoist(!!r.hoist);
    setPerms(Array.isArray(r.permissions) ? (r.permissions as string[]) : []);
  }

  // Atalhos de teclado (Esc fecha direto, Enter salva fora de textarea)
  function handleKeyDown(e: ReactKeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      const target = e.target as HTMLElement;
      if (target.tagName.toLowerCase() !== 'textarea') {
        if (tab === 'appearance' && isDirty && isNameValid && !isSaving) {
          e.preventDefault();
          void submitAppearance();
        }
      }
    }
  }

  // Envio de formulário de Aparência
  async function submitAppearance(e?: FormEvent) {
    if (e) e.preventDefault();
    if (!isNameValid || isSaving) return;

    setIsSaving(true);
    try {
      await api(`/api/community/servers/${serverId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          is_listed: listed,
          icon_url: iconUrl.trim(),
          banner_url: bannerUrl.trim(),
        }),
      });

      setShowToast(true);
      setTimeout(() => {
        onDone();
        onClose();
      }, 700);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Falha ao salvar aparência');
    } finally {
      setIsSaving(false);
    }
  }

  // Processamento e validação de arquivos para Ícone e Banner
  function handleFileSelected(file: File, kind: 'icon' | 'banner') {
    const isIcon = kind === 'icon';
    const maxSize = isIcon ? 3 * 1024 * 1024 : 5 * 1024 * 1024;
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

    if (isIcon) setIconError('');
    else setBannerError('');

    if (!allowedTypes.includes(file.type)) {
      const msg = 'Formato inválido. Use JPG, PNG, WEBP ou GIF.';
      if (isIcon) setIconError(msg);
      else setBannerError(msg);
      return;
    }

    if (file.size > maxSize) {
      const msg = `Arquivo muito grande (máximo ${isIcon ? '3 MB' : '5 MB'}).`;
      if (isIcon) setIconError(msg);
      else setBannerError(msg);
      return;
    }

    // Se for GIF, envia diretamente sem crop para preservar animação
    if (file.type === 'image/gif') {
      void executeUpload(file, kind);
      return;
    }

    // Abre crop modal com proporção travada
    const objectUrl = URL.createObjectURL(file);
    setCropModal({
      open: true,
      kind,
      src: objectUrl,
      rawFile: file,
    });
  }

  async function executeUpload(blob: Blob | File, kind: 'icon' | 'banner') {
    const isIcon = kind === 'icon';
    if (isIcon) {
      setIconProgress(0);
      setIconError('');
    } else {
      setBannerProgress(0);
      setBannerError('');
    }

    try {
      const url = await uploadMediaWithProgress(blob, kind, (pct) => {
        if (isIcon) setIconProgress(pct);
        else setBannerProgress(pct);
      });
      if (isIcon) {
        setIconUrl(url);
        setIconProgress(null);
      } else {
        setBannerUrl(url);
        setBannerProgress(null);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro no envio';
      if (isIcon) {
        setIconError(msg);
        setIconProgress(null);
      } else {
        setBannerError(msg);
        setBannerProgress(null);
      }
    }
  }

  function handleConfirmCrop(blob: Blob) {
    if (cropModal.src) URL.revokeObjectURL(cropModal.src);
    const kind = cropModal.kind;
    setCropModal({ open: false, kind: 'icon', src: '' });
    void executeUpload(blob, kind);
  }

  function handleSkipCrop() {
    if (cropModal.src) URL.revokeObjectURL(cropModal.src);
    const kind = cropModal.kind;
    const rawFile = cropModal.rawFile;
    setCropModal({ open: false, kind: 'icon', src: '' });
    if (rawFile) void executeUpload(rawFile, kind);
  }

  function handleCancelCrop() {
    if (cropModal.src) URL.revokeObjectURL(cropModal.src);
    setCropModal({ open: false, kind: 'icon', src: '' });
  }

  if (!open) return null;

  return (
    <NativeDialog open={open} onClose={onClose} className="comm-dialog comm-dialog-server-settings">
      <div
        ref={dialogRef}
        className="comm-server-settings-root"
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Toast de Sucesso */}
        {showToast ? (
          <div className="comm-toast-success" role="status">
            <CheckCircle2 size={18} /> Aparência salva com sucesso!
          </div>
        ) : null}

        {/* Modal de Recorte de Imagem */}
        <ImageCropModal
          open={cropModal.open}
          imageSrc={cropModal.src}
          aspectRatio={cropModal.kind === 'icon' ? 1 : 4}
          title={cropModal.kind === 'icon' ? 'Recortar Ícone (1:1)' : 'Recortar Banner (4:1)'}
          onConfirm={handleConfirmCrop}
          onCancel={handleCancelCrop}
          onSkipCrop={handleSkipCrop}
        />

        {/* 1. Cabeçalho Fixo */}
        <header className="comm-server-settings-header">
          <div className="comm-server-settings-title-group">
            <h2>Configurações do servidor</h2>
            <p>Personalize a identidade visual, descoberta pública e permissões da sua comunidade.</p>
          </div>
          <button
            type="button"
            className="comm-server-settings-close-btn"
            onClick={onClose}
            aria-label="Fechar configurações"
          >
            <X size={18} />
          </button>
        </header>

        {/* 2. Abas Segmentadas */}
        <nav className="comm-server-settings-nav" aria-label="Abas de configuração">
          <div className="comm-segmented-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'appearance'}
              aria-controls="panel-server-appearance"
              id="tab-server-appearance"
              className={`comm-segmented-tab${tab === 'appearance' ? ' is-active' : ''}`}
              onClick={() => setTab('appearance')}
            >
              <Palette size={16} /> Aparência
            </button>
            {canManageRoles ? (
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'roles'}
                aria-controls="panel-server-roles"
                id="tab-server-roles"
                className={`comm-segmented-tab${tab === 'roles' ? ' is-active' : ''}`}
                onClick={() => setTab('roles')}
              >
                <Shield size={16} /> Cargos e permissões
              </button>
            ) : null}
          </div>
        </nav>

        {/* 3. Corpo com Rolagem */}
        <div className="comm-server-settings-scroll-body">
          {tab === 'appearance' ? (
            <div
              id="panel-server-appearance"
              role="tabpanel"
              aria-labelledby="tab-server-appearance"
              className="comm-appearance-grid"
            >
              {/* Coluna da Esquerda: Formulário de Edição */}
              <div className="comm-appearance-form-col">
                {/* Nome do Servidor */}
                <div className="comm-form-row">
                  <div className="comm-form-header-line">
                    <label htmlFor="server-name-input" className="comm-input-label">
                      Nome do servidor
                    </label>
                    <span
                      className={`comm-char-count${
                        name.length < 2 && nameTouched
                          ? ' is-error'
                          : name.length > 80
                          ? ' is-warn'
                          : ''
                      }`}
                    >
                      {name.length} / 100
                    </span>
                  </div>
                  <input
                    id="server-name-input"
                    type="text"
                    required
                    maxLength={100}
                    placeholder="Ex.: Comunidade CS2 Brasil"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setNameTouched(true);
                    }}
                    onBlur={() => setNameTouched(true)}
                    className={`comm-modern-input${!isNameValid && nameTouched ? ' is-invalid' : ''}`}
                    aria-invalid={!isNameValid && nameTouched}
                    aria-describedby={!isNameValid && nameTouched ? 'name-error-msg' : undefined}
                  />
                  {!isNameValid && nameTouched ? (
                    <p id="name-error-msg" className="comm-field-inline-error">
                      <AlertCircle size={13} /> O nome deve conter entre 2 e 100 caracteres.
                    </p>
                  ) : null}
                </div>

                {/* Descrição */}
                <div className="comm-form-row">
                  <div className="comm-form-header-line">
                    <label htmlFor="server-desc-input" className="comm-input-label">
                      Descrição (página Descobrir)
                    </label>
                    <span className="comm-char-count">{description.length} / 300</span>
                  </div>
                  <textarea
                    id="server-desc-input"
                    maxLength={300}
                    placeholder="Conte sobre sua comunidade, regras ou objetivos para novos membros…"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="comm-modern-textarea"
                  />
                </div>

                {/* Switch "Aparecer na Descobrir" */}
                <div
                  className="comm-switch-card"
                  onClick={() => setListed(!listed)}
                  role="switch"
                  aria-checked={listed}
                  aria-label="Aparecer na página Descobrir"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault();
                      setListed(!listed);
                    }
                  }}
                >
                  <div className="comm-switch-card-left">
                    <div className="comm-switch-card-icon">
                      <Compass size={18} />
                    </div>
                    <div className="comm-switch-card-texts">
                      <span className="comm-switch-card-title">Aparecer na página Descobrir</span>
                      <span className="comm-switch-card-desc">
                        Permite que novos jogadores encontrem seu servidor na vitrine pública e enviem solicitações de entrada.
                      </span>
                    </div>
                  </div>
                  <div className={`comm-switch-track${listed ? ' is-checked' : ''}`}>
                    <div className="comm-switch-thumb" />
                  </div>
                </div>

                {/* Grid de Upload de Mídias (Ícone e Banner Simétricos) */}
                <div className="comm-media-uploads-grid">
                  {/* Card: ÍCONE */}
                  <div
                    className="comm-media-upload-card"
                    onPaste={(e) => {
                      const item = e.clipboardData.items[0];
                      if (item && item.type.startsWith('image/')) {
                        const file = item.getAsFile();
                        if (file) handleFileSelected(file, 'icon');
                      }
                    }}
                  >
                    <div className="comm-media-upload-header">
                      <span className="comm-media-upload-title">
                        <ImageIcon size={14} /> Ícone
                      </span>
                      <div className="comm-media-segmented">
                        <button
                          type="button"
                          className={`comm-media-segmented-btn${iconMode === 'file' ? ' is-active' : ''}`}
                          onClick={() => setIconMode('file')}
                        >
                          Arquivo
                        </button>
                        <button
                          type="button"
                          className={`comm-media-segmented-btn${iconMode === 'url' ? ' is-active' : ''}`}
                          onClick={() => setIconMode('url')}
                        >
                          URL
                        </button>
                      </div>
                    </div>

                    {iconMode === 'file' ? (
                      iconProgress !== null ? (
                        <div className="comm-upload-progress-wrap">
                          <div className="comm-upload-progress-bar">
                            <div
                              className="comm-upload-progress-fill"
                              style={{ width: `${iconProgress}%` }}
                            />
                          </div>
                          <div className="comm-upload-progress-text">
                            <span>Enviando ícone...</span>
                            <span>{iconProgress}%</span>
                          </div>
                        </div>
                      ) : iconUrl ? (
                        <div className="comm-media-thumb-preview">
                          <div className="comm-media-thumb-img-wrap">
                            <img src={iconUrl} alt="Ícone do servidor" className="comm-media-thumb-icon" />
                          </div>
                          <div className="comm-media-thumb-actions">
                            <button
                              type="button"
                              className="comm-media-thumb-btn"
                              onClick={() => fileInputIconRef.current?.click()}
                            >
                              <RefreshCw size={12} /> Trocar
                            </button>
                            <button
                              type="button"
                              className="comm-media-thumb-btn is-remove"
                              onClick={() => setIconUrl('')}
                            >
                              <Trash2 size={12} /> Remover
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div
                          className={`comm-dropzone${isDraggingIcon ? ' is-dragging' : ''}`}
                          onClick={() => fileInputIconRef.current?.click()}
                          onDragOver={(e) => {
                            e.preventDefault();
                            setIsDraggingIcon(true);
                          }}
                          onDragLeave={() => setIsDraggingIcon(false)}
                          onDrop={(e) => {
                            e.preventDefault();
                            setIsDraggingIcon(false);
                            const file = e.dataTransfer.files[0];
                            if (file) handleFileSelected(file, 'icon');
                          }}
                        >
                          <Upload size={20} className="comm-dropzone-icon" />
                          <span className="comm-dropzone-prompt">Clique ou arraste</span>
                          <span className="comm-dropzone-hint">1:1 · até 3 MB (ou Cole Ctrl+V)</span>
                        </div>
                      )
                    ) : (
                      <div className="comm-form-row">
                        <input
                          type="url"
                          placeholder="https://exemplo.com/icone.png"
                          value={iconUrl}
                          onChange={(e) => setIconUrl(e.target.value)}
                          className="comm-modern-input"
                        />
                      </div>
                    )}

                    <input
                      ref={fileInputIconRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      hidden
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleFileSelected(f, 'icon');
                        e.target.value = '';
                      }}
                    />

                    {iconError ? (
                      <p className="comm-field-inline-error">
                        <AlertCircle size={13} /> {iconError}
                      </p>
                    ) : null}
                  </div>

                  {/* Card: BANNER */}
                  <div
                    className="comm-media-upload-card"
                    onPaste={(e) => {
                      const item = e.clipboardData.items[0];
                      if (item && item.type.startsWith('image/')) {
                        const file = item.getAsFile();
                        if (file) handleFileSelected(file, 'banner');
                      }
                    }}
                  >
                    <div className="comm-media-upload-header">
                      <span className="comm-media-upload-title">
                        <ImageIcon size={14} /> Banner
                      </span>
                      <div className="comm-media-segmented">
                        <button
                          type="button"
                          className={`comm-media-segmented-btn${bannerMode === 'file' ? ' is-active' : ''}`}
                          onClick={() => setBannerMode('file')}
                        >
                          Arquivo
                        </button>
                        <button
                          type="button"
                          className={`comm-media-segmented-btn${bannerMode === 'url' ? ' is-active' : ''}`}
                          onClick={() => setBannerMode('url')}
                        >
                          URL
                        </button>
                      </div>
                    </div>

                    {bannerMode === 'file' ? (
                      bannerProgress !== null ? (
                        <div className="comm-upload-progress-wrap">
                          <div className="comm-upload-progress-bar">
                            <div
                              className="comm-upload-progress-fill"
                              style={{ width: `${bannerProgress}%` }}
                            />
                          </div>
                          <div className="comm-upload-progress-text">
                            <span>Enviando banner...</span>
                            <span>{bannerProgress}%</span>
                          </div>
                        </div>
                      ) : bannerUrl ? (
                        <div className="comm-media-thumb-preview">
                          <div className="comm-media-thumb-img-wrap">
                            <img src={bannerUrl} alt="Banner do servidor" className="comm-media-thumb-banner" />
                          </div>
                          <div className="comm-media-thumb-actions">
                            <button
                              type="button"
                              className="comm-media-thumb-btn"
                              onClick={() => fileInputBannerRef.current?.click()}
                            >
                              <RefreshCw size={12} /> Trocar
                            </button>
                            <button
                              type="button"
                              className="comm-media-thumb-btn is-remove"
                              onClick={() => setBannerUrl('')}
                            >
                              <Trash2 size={12} /> Remover
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div
                          className={`comm-dropzone${isDraggingBanner ? ' is-dragging' : ''}`}
                          onClick={() => fileInputBannerRef.current?.click()}
                          onDragOver={(e) => {
                            e.preventDefault();
                            setIsDraggingBanner(true);
                          }}
                          onDragLeave={() => setIsDraggingBanner(false)}
                          onDrop={(e) => {
                            e.preventDefault();
                            setIsDraggingBanner(false);
                            const file = e.dataTransfer.files[0];
                            if (file) handleFileSelected(file, 'banner');
                          }}
                        >
                          <Upload size={20} className="comm-dropzone-icon" />
                          <span className="comm-dropzone-prompt">Clique ou arraste</span>
                          <span className="comm-dropzone-hint">4:1 (~960×240) · até 5 MB</span>
                        </div>
                      )
                    ) : (
                      <div className="comm-form-row">
                        <input
                          type="url"
                          placeholder="https://exemplo.com/banner.jpg"
                          value={bannerUrl}
                          onChange={(e) => setBannerUrl(e.target.value)}
                          className="comm-modern-input"
                        />
                      </div>
                    )}

                    <input
                      ref={fileInputBannerRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      hidden
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleFileSelected(f, 'banner');
                        e.target.value = '';
                      }}
                    />

                    {bannerError ? (
                      <p className="comm-field-inline-error">
                        <AlertCircle size={13} /> {bannerError}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Coluna da Direita: Live Preview (Apple TV Vitrine) */}
              <div className="comm-appearance-preview-col">
                <div className="comm-preview-card-wrap">
                  <span className="comm-input-label">Visualização</span>
                  <div className="comm-showcase-card" aria-label="Pré-visualização do servidor">
                    {/* Banner estritamente 4:1 */}
                    <div
                      className={`comm-showcase-banner${!bannerUrl ? ' comm-showcase-banner-default' : ''}`}
                      style={bannerUrl ? { backgroundImage: `url(${bannerUrl})` } : undefined}
                    />

                    {/* Avatar squircle de 64px sobreposto no canto inferior esquerdo com corte */}
                    <div className="comm-showcase-avatar-wrapper">
                      {iconUrl ? (
                        <img src={iconUrl} alt="" className="comm-showcase-avatar" />
                      ) : (
                        <div className="comm-showcase-avatar">
                          {name.trim().slice(0, 1).toUpperCase() || 'S'}
                        </div>
                      )}
                    </div>

                    {/* Meta e Informações */}
                    <div className="comm-showcase-body">
                      <h4 className="comm-showcase-name">{name.trim() || 'Nome do servidor'}</h4>

                      <div className="comm-showcase-badges">
                        {listed ? (
                          <span className="comm-showcase-chip is-discovery">
                            <Compass size={12} /> Na Descobrir
                          </span>
                        ) : null}
                        <span className="comm-showcase-chip">
                          <Users size={12} /> 0 membros
                        </span>
                      </div>

                      <p className={`comm-showcase-desc${!description.trim() ? ' is-empty' : ''}`}>
                        {description.trim() || 'Adicione uma descrição para que as pessoas conheçam sua comunidade…'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* Aba: Cargos e Permissões (Preserva todas as regras intactas) */
            <div
              id="panel-server-roles"
              role="tabpanel"
              aria-labelledby="tab-server-roles"
              className="comm-settings-panel comm-roles-panel"
            >
              <div className="comm-roles-layout">
                <aside className="comm-roles-list-wrap">
                  <div className="comm-roles-list-head">
                    <span className="comm-roles-head-title">Cargos do servidor</span>
                    <button
                      type="button"
                      className="comm-roles-new-btn"
                      onClick={() =>
                        void api(`/api/community/servers/${serverId}/roles`, {
                          method: 'POST',
                          body: JSON.stringify({ name: 'Novo cargo', color: '#ff9a3d', permissions: [] }),
                        }).then(() => loadRoles())
                      }
                    >
                      + Novo
                    </button>
                  </div>
                  <ul className="comm-roles-list">
                    {roles.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          className={`comm-role-pick${selectedId === r.id ? ' is-on' : ''}`}
                          onClick={() => selectRole(r)}
                        >
                          <span className="comm-role-dot" style={{ background: r.color || '#949ba4' }} />
                          <span className="comm-role-name">{r.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </aside>

                <div className="comm-roles-editor-wrap">
                  {selectedId ? (
                    <div className="comm-roles-editor">
                      {/* 1. Nome do cargo */}
                      <div className="comm-roles-field-group">
                        <label className="comm-input-label">Nome do cargo</label>
                        <input
                          type="text"
                          maxLength={64}
                          value={roleName}
                          onChange={(e) => setRoleName(e.target.value)}
                          className="comm-modern-input"
                          placeholder="Nome do cargo (ex.: Administrador, VIP...)"
                        />
                      </div>

                      {/* 2. Cores do cargo */}
                      <div className="comm-roles-colors-section">
                        <label className="comm-input-label">Cores do cargo</label>
                        <div className="comm-roles-colors-grid">
                          <div className="comm-role-color-card">
                            <span className="comm-color-card-title">Cor do cargo</span>
                            <div className="comm-color-card-body">
                              <input
                                type="color"
                                value={roleColor}
                                onChange={(e) => setRoleColor(e.target.value)}
                                className="comm-color-picker-input"
                              />
                              <span className="comm-color-hex">{roleColor}</span>
                            </div>
                          </div>

                          <div className="comm-role-color-card">
                            <span className="comm-color-card-title">Cor do card (membros)</span>
                            <div className="comm-color-card-body">
                              <input
                                type="color"
                                value={cardColor}
                                onChange={(e) => setCardColor(e.target.value)}
                                className="comm-color-picker-input"
                              />
                              <button
                                type="button"
                                className="comm-color-aux-btn"
                                onClick={() => setCardColor('#ff9a3d')}
                              >
                                Limpar
                              </button>
                            </div>
                          </div>

                          <div className="comm-role-color-card">
                            <span className="comm-color-card-title">Cor da borda</span>
                            <div className="comm-color-card-body">
                              <input
                                type="color"
                                value={borderColor}
                                onChange={(e) => setBorderColor(e.target.value)}
                                className="comm-color-picker-input"
                              />
                              <button
                                type="button"
                                className="comm-color-aux-btn"
                                onClick={() => setBorderColor(roleColor)}
                              >
                                Igual ao cargo
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* 3. Estilo e Movimento da Borda */}
                      <div className="comm-roles-border-section">
                        <div className="comm-roles-fx-grid">
                          <div className="comm-fx-field">
                            <label className="comm-input-label">Efeito da borda</label>
                            <CustomSelect
                              value={borderEffect}
                              onChange={(val) => setBorderEffect(val)}
                              options={BORDER_EFFECT_OPTIONS}
                            />
                          </div>

                          <div className="comm-fx-field">
                            <label className="comm-input-label">Movimento</label>
                            <CustomSelect
                              value={borderMotion}
                              onChange={(val) => setBorderMotion(val)}
                              options={BORDER_MOTION_OPTIONS}
                            />
                          </div>
                        </div>

                        <div className="comm-roles-border-preview-card" aria-hidden>
                          <span className="comm-preview-card-desc">Prévia do crachá do membro:</span>
                          <span
                            className={`comm-member-name-cargo fx-${borderEffect} motion-${borderMotion}`}
                            style={
                              {
                                ['--cargo-color' as string]: roleColor,
                                ['--cargo-border-color' as string]: borderColor,
                              } as CSSProperties
                            }
                          >
                            {roleName || 'Exemplo'}
                          </span>
                        </div>
                      </div>

                      {/* 4. Hoist */}
                      <div className="comm-roles-hoist-card">
                        <div className="comm-switch-label">
                          <label className="comm-switch">
                            <input
                              type="checkbox"
                              checked={hoist}
                              onChange={(e) => setHoist(e.target.checked)}
                            />
                            <span className="comm-slider round" />
                          </label>
                          <div
                            className="comm-switch-info"
                            onClick={() => setHoist(!hoist)}
                            style={{ cursor: 'pointer' }}
                          >
                            <strong>Destacar membros com este cargo na lista</strong>
                            <p>Exibe os membros deste cargo em uma categoria separada no painel lateral</p>
                          </div>
                        </div>
                      </div>

                      {/* 5. Permissões */}
                      <div className="comm-perms-section">
                        <label className="comm-input-label">Permissões do cargo</label>
                        <div className="comm-perms-grid">
                          {PERMISSION_GROUPS.map((g) => (
                            <div key={g.group} className="comm-perms-group-card">
                              <h4 className="comm-perms-group-title">{g.group}</h4>
                              <div className="comm-perms-items">
                                {g.permissions.map((p) => (
                                  <label key={p.key} className="comm-perm-checkbox-row">
                                    <input
                                      type="checkbox"
                                      checked={perms.includes(p.key)}
                                      onChange={() =>
                                        setPerms((prev) =>
                                          prev.includes(p.key)
                                            ? prev.filter((k) => k !== p.key)
                                            : [...prev, p.key],
                                        )
                                      }
                                      className="comm-checkbox-native"
                                    />
                                    <span className="comm-perm-label">{p.label}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* 6. Ações do Cargo */}
                      <div className="comm-roles-actions-footer">
                        <button
                          type="button"
                          className="comm-btn-save-role"
                          onClick={() =>
                            void api(`/api/community/servers/${serverId}/roles/${selectedId}`, {
                              method: 'PATCH',
                              body: JSON.stringify({
                                name: roleName,
                                color: roleColor,
                                permissions: perms,
                                hoist,
                                member_card_color: cardColor,
                                border_color: borderColor,
                                border_effect: borderEffect,
                                border_motion: borderMotion,
                              }),
                            }).then(() => loadRoles())
                          }
                        >
                          <Save size={15} /> Salvar cargo
                        </button>
                        <button
                          type="button"
                          className="comm-btn-delete-role"
                          onClick={() => {
                            if (!confirm('Deseja excluir este cargo?')) return;
                            void api(`/api/community/servers/${serverId}/roles/${selectedId}`, {
                              method: 'DELETE',
                            }).then(() => {
                              setSelectedId(null);
                              return loadRoles();
                            });
                          }}
                        >
                          <Trash2 size={15} /> Excluir cargo
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="comm-roles-empty-state">
                      <Shield size={28} />
                      <p>
                        <strong>Selecione um cargo</strong> na lista ou crie um novo para editar permissões.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {members.length ? (
                <div className="comm-roles-assign-card" style={{ marginTop: 20 }}>
                  <h4 className="comm-roles-assign-title">Atribuir cargos a um membro</h4>
                  <div className="comm-roles-assign-body">
                    <div className="comm-fx-field">
                      <label className="comm-input-label">Selecione o Membro</label>
                      <CustomSelect
                        value={assignUserId ? String(assignUserId) : ''}
                        onChange={(val) =>
                          setAssignUserId(val ? Number(val) : '')
                        }
                        options={[
                          { value: '', label: 'Selecione um membro…' },
                          ...members.map((m) => ({
                            value: String(m.id),
                            label: `${m.label} (${m.role})`,
                          })),
                        ]}
                        placeholder="Selecione um membro…"
                      />
                    </div>
                    <div className="comm-roles-assign-grid">
                      {roles.map((r) => (
                        <label key={r.id} className="comm-perm-checkbox-row">
                          <input
                            type="checkbox"
                            checked={assignRoleIds.includes(r.id)}
                            onChange={() =>
                              setAssignRoleIds((prev) =>
                                prev.includes(r.id)
                                  ? prev.filter((id) => id !== r.id)
                                  : [...prev, r.id],
                              )
                            }
                            className="comm-checkbox-native"
                          />
                          <span className="comm-role-dot" style={{ background: r.color || '#949ba4' }} />
                          <span className="comm-perm-label">{r.name}</span>
                        </label>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="comm-btn-save-role"
                      disabled={!assignUserId}
                      style={{ alignSelf: 'flex-start', marginTop: 6 }}
                      onClick={() => {
                        if (!assignUserId) return;
                        void api(
                          `/api/community/servers/${serverId}/members/${assignUserId}/roles`,
                          {
                            method: 'PATCH',
                            body: JSON.stringify({ role_ids: assignRoleIds }),
                          },
                        ).then(() => onDone());
                      }}
                    >
                      Salvar atribuição
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* 4. Rodapé Fixo */}
        <footer className="comm-server-settings-footer">
          <div className="comm-footer-status">
            {tab === 'appearance' && isDirty ? (
              <>
                <span className="comm-footer-unsaved-dot" />
                <span>Alterações não salvas</span>
              </>
            ) : null}
            {rolesError ? <span style={{ color: 'var(--comm-modal-danger)' }}>{rolesError}</span> : null}
          </div>

          <div className="comm-footer-actions">
            <button type="button" className="comm-btn-cancel" onClick={onClose}>
              Cancelar
            </button>
            {tab === 'appearance' ? (
              <button
                type="button"
                className="comm-btn-save"
                disabled={!isDirty || !isNameValid || isSaving}
                onClick={() => void submitAppearance()}
              >
                {isSaving ? <span className="comm-spinner" /> : <Save size={15} />}
                <span>{isSaving ? 'Salvando…' : 'Salvar aparência'}</span>
              </button>
            ) : null}
          </div>
        </footer>
      </div>
    </NativeDialog>
  );
}
