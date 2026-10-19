import { useEffect, useState, type DragEvent } from 'react';
import { parsePalette } from '../../color';
import { deleteImage, importImage } from '../../images';
import { useImageUrl } from '../hooks';
import { Icon } from '../icons';
import { useModel } from '../model';
import { Flash } from './common';

/** The default autumn theme's key colours, for the swatch preview. */
const AUTUMN_SWATCHES = ['#f4ede2', '#b14f27', '#c98b2b', '#6b7238', '#2b2119'];

type Status = 'idle' | 'working' | 'error';

/** One saved picture in the "Your pictures" gallery. */
function SavedPictureTile({ id, palette, current }: { id: string; palette: string; current: boolean }) {
  const { store, t } = useModel();
  const url = useImageUrl(id);
  return (
    <li className="picture-tile" data-current={current || undefined}>
      <button
        type="button"
        className="picture-use"
        aria-pressed={current}
        aria-label={current ? t('currentPicture') : t('usePicture')}
        title={current ? t('currentPicture') : t('usePicture')}
        onClick={() => store.setAppearance({ image: id, palette })}
      >
        {url ? <img src={url} alt="" /> : <span className="picture-placeholder" />}
        {current && (
          <span className="picture-current">
            <Icon name="check" />
          </span>
        )}
      </button>
      <button
        type="button"
        className="picture-remove"
        aria-label={t('removePicture')}
        title={t('removePicture')}
        onClick={() => {
          if (current) store.setAppearance({ image: '', palette: '' });
          store.remove('picture', id);
          void deleteImage(id).catch(() => undefined);
        }}
      >
        <Icon name="close" />
      </button>
    </li>
  );
}

export function AppearanceCard() {
  const model = useModel();
  const { store, t } = model;
  const { image, palette } = store.appearance;
  const preview = useImageUrl(image);
  const [status, setStatus] = useState<Status>('idle');
  const [dragging, setDragging] = useState(false);
  const swatches = palette ? parsePalette(palette) : AUTUMN_SWATCHES;
  const saved = store.list('picture').sort((a, b) => b.addedAt - a.addedAt);

  // A picture chosen before the gallery existed: add it so it is not lost.
  useEffect(() => {
    if (image && !store.get('picture', image)) store.update('picture', image, { palette, addedAt: Date.now() });
  }, [image, palette, store]);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setStatus('working');
    try {
      // The picture is stored before any record changes, so other tabs can load it at once.
      const { id, palette: colours } = await importImage(file);
      store.update('picture', id, { palette: colours, addedAt: Date.now(), deleted: false });
      store.setAppearance({ image: id, palette: colours });
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
          <button type="button" className="button" onClick={() => store.setAppearance({ image: '', palette: '' })}>
            <Icon name="leaf" />
            {t('useDefaultTheme')}
          </button>
        )}
      </div>
      <p className="setting-hint">{status === 'error' ? <span className="error-text">{t('imageError')}</span> : t('dropHint')}</p>

      {saved.length > 0 && (
        <div className="saved-pictures">
          <h3 className="subheading">{t('savedPictures')}</h3>
          <p className="setting-hint">{t('savedPicturesHint')}</p>
          <ul className="picture-grid">
            {saved.map((picture) => (
              <SavedPictureTile key={picture.id} id={picture.id} palette={picture.palette} current={picture.id === image} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
