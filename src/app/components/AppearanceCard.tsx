import { useState, type DragEvent } from 'react';
import { parsePalette } from '../../color';
import { deleteImage, importImage } from '../../images';
import { useImageUrl } from '../hooks';
import { Icon } from '../icons';
import { useModel } from '../model';
import { Flash } from './common';

/** The default autumn theme's key colours, for the swatch preview. */
const AUTUMN_SWATCHES = ['#f4ede2', '#b4532a', '#c98b2b', '#6b7238', '#2b2119'];

type Status = 'idle' | 'working' | 'error';

export function AppearanceCard() {
  const model = useModel();
  const { store, t } = model;
  const { image, palette } = store.appearance;
  const preview = useImageUrl(image);
  const [status, setStatus] = useState<Status>('idle');
  const [dragging, setDragging] = useState(false);
  const swatches = palette ? parsePalette(palette) : AUTUMN_SWATCHES;

  const replace = (next: { image: string; palette: string }) => {
    const previous = store.appearance.image;
    store.setAppearance(next);
    if (previous && previous !== next.image) void deleteImage(previous).catch(() => undefined);
  };

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setStatus('working');
    try {
      // The picture is stored before the record changes, so other tabs can load it at once.
      const { id, palette: colours } = await importImage(file);
      replace({ image: id, palette: colours });
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void choose(event.dataTransfer.files[0]);
  };

  return (
    <section
      className="card appearance"
      data-dragging={dragging || undefined}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <Flash count={model.flashCount('appearance')} />
      <div className="card-head">
        <h2>{t('appearance')}</h2>
      </div>
      <p className="setting-hint">{t('appearanceHint')}</p>

      <div className="appearance-preview">
        {preview ? (
          <img src={preview} alt="" className="appearance-thumb" />
        ) : (
          <div className="appearance-thumb appearance-thumb-default" aria-hidden="true" />
        )}
        <div className="appearance-info">
          <span className="setting-label">{palette ? t('paletteFromPicture') : t('defaultPalette')}</span>
          <ul className="swatches" aria-label={palette ? t('paletteFromPicture') : t('defaultPalette')}>
            {swatches.map((colour) => (
              <li key={colour} style={{ background: colour }} title={colour} />
            ))}
          </ul>
        </div>
      </div>

      <div className="actions">
        <label className="button button-primary file-button" aria-disabled={status === 'working' || undefined}>
          <Icon name="image" />
          {status === 'working' ? t('readingColours') : image ? t('chooseAnother') : t('choosePicture')}
          <input
            type="file"
            accept="image/*"
            className="visually-hidden"
            disabled={status === 'working'}
            onChange={(event) => {
              void choose(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </label>
        {(image || palette) && (
          <button type="button" className="button" onClick={() => replace({ image: '', palette: '' })}>
            <Icon name="leaf" />
            {t('useDefaultTheme')}
          </button>
        )}
      </div>
      <p className="setting-hint">{status === 'error' ? <span className="error-text">{t('imageError')}</span> : t('dropHint')}</p>
    </section>
  );
}
