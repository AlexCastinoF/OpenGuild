import { useEffect, useMemo, useState } from 'react';

/** Modal de legenda antes de enviar imagem/vídeo/documento. */
export function WaCaptionModal({
  file,
  onCancel,
  onSend,
}: {
  file: File | null;
  onCancel: () => void;
  onSend: (caption: string) => void;
}) {
  const [caption, setCaption] = useState('');
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : ''), [file]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  if (!file) return null;

  const isImg = file.type.startsWith('image/');
  const isVid = file.type.startsWith('video/');

  return (
    <div className="comm-wa-caption-modal" role="dialog" onClick={onCancel}>
      <div className="comm-wa-caption-card" onClick={(e) => e.stopPropagation()}>
        <h3>Enviar mídia</h3>
        <div className="comm-wa-caption-preview">
          {isImg ? <img src={previewUrl} alt="" /> : null}
          {isVid ? <video src={previewUrl} controls playsInline /> : null}
          {!isImg && !isVid ? <p className="muted">{file.name}</p> : null}
        </div>
        {(isImg || isVid || file.type.startsWith('application/')) && (
          <textarea
            rows={2}
            maxLength={1024}
            placeholder="Legenda (opcional)"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            autoFocus
          />
        )}
        <div className="comm-wa-caption-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onSend(caption)}>
            Enviar
          </button>
        </div>
      </div>
    </div>
  );
}
