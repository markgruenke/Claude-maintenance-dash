/* Photos: take or pick pictures, shrink them on the device, attach them to an
   entry or a work order, and show them as thumbnails with a full-size viewer.

   Photos are resized before saving (longest side 1600 px, JPEG) so a 3–5 MB
   camera photo becomes roughly 200–400 KB: still sharp enough to read a part
   number, small enough that hundreds fit on a tablet. */

import { el, api, toast, state, openModal, segmented, confirmDialog, fmtWhen } from './core.js';

export const KINDS = [['done', 'Work done'], ['todo', 'Needs doing'], ['part', 'Part needed']];
const KIND_LABEL = Object.fromEntries(KINDS);
const FULL_PX = 1600;
const THUMB_PX = 360;

/**
 * Open the camera / photo library. Must be called straight from a tap.
 * On iPad the sheet offers "Take Photo", "Photo Library" and "Choose File".
 */
export function pickFiles({ multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept: 'image/*', style: 'display:none', ...(multiple ? { multiple: true } : {}) });
    input.addEventListener('change', () => {
      const files = [...(input.files || [])];
      input.remove();
      resolve(files);
    });
    document.body.append(input);
    input.click();
  });
}

function draw(img, maxPx, quality) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const scale = Math.min(1, maxPx / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL('image/jpeg', quality), width: canvas.width, height: canvas.height };
}

/** File -> { full, thumb, width, height } (JPEG data URLs, resized, right way up). */
export async function processImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    // Browsers apply the photo's rotation (EXIF) when decoding, so portrait
    // shots stay portrait.
    await img.decode();
    const full = draw(img, FULL_PX, 0.8);
    const thumb = draw(img, THUMB_PX, 0.7);
    return { full: full.dataUrl, thumb: thumb.dataUrl, width: full.width, height: full.height };
  } catch {
    throw new Error(`Couldn’t read “${file.name || 'that photo'}” as a picture`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Save already-processed images onto an entry and/or work order. */
export async function savePhotos(images, { workOrderId = null, logId = null, kind = 'done', caption = '' } = {}) {
  let saved = 0;
  for (const im of images) {
    await api('/api/photos', { method: 'POST', body: { workOrderId, logId, kind, caption, ...im } });
    saved++;
  }
  return saved;
}

/** Pick, shrink and save photos in one go. Call straight from a tap. */
export async function addPhotos(target, { onDone } = {}) {
  const files = await pickFiles();
  if (!files.length) return 0;
  let saved = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      toast(files.length > 1 ? `Saving photo ${i + 1} of ${files.length}…` : 'Saving photo…', 20000);
      saved += await savePhotos([await processImage(files[i])], target);
    }
    toast(saved === 1 ? 'Photo added' : `${saved} photos added`);
  } catch (err) {
    toast(err.message, 5000);
  }
  if (saved && onDone) onDone();
  return saved;
}

/** Ask what the photos show, then open the camera (work-order screen). */
export function addPhotosAskKind(target, { onDone } = {}) {
  openModal('Add photo', (close) => el('div', {}, [
    el('p', { class: 'desc' }, 'What will the photo show?'),
    el('div', { class: 'kind-picks' }, KINDS.map(([kind, label]) => el('button', {
      type: 'button', class: 'big kind-' + kind,
      // Opening the camera has to happen inside this tap.
      onclick: () => { close(); addPhotos({ ...target, kind }, { onDone }); },
    }, ['📷 ', label]))),
  ]));
}

/** URL for an <img>: from the tablet's storage, or from the server. */
export async function photoSrc(photoId, thumb = false) {
  if (state.local && state.engine) return state.engine.photoURL(photoId, thumb);
  return `/api/photos/${encodeURIComponent(photoId)}/file${thumb ? '?thumb=1' : ''}`;
}

function photoImg(photoId, thumb, attrs = {}) {
  const img = el('img', { alt: '', loading: 'lazy', decoding: 'async', ...attrs });
  photoSrc(photoId, thumb).then((src) => { if (src) img.src = src; }).catch(() => {});
  return img;
}

/**
 * A row of thumbnails. `photos` need { id, kind, caption }. Tap one to open
 * the viewer; `onChange` runs after an edit or delete there.
 */
export function thumbStrip(photos, { onChange, showKind = true } = {}) {
  if (!photos || !photos.length) return null;
  return el('div', { class: 'photo-strip' }, photos.map((ph, i) => el('button', {
    type: 'button', class: 'photo-thumb', 'aria-label': `Photo: ${KIND_LABEL[ph.kind] || ''} ${ph.caption || ''}`.trim(),
    onclick: (e) => { e.stopPropagation(); openViewer(photos, i, onChange); },
  }, [
    photoImg(ph.id, true),
    showKind ? el('span', { class: 'photo-kind kind-' + ph.kind }, KIND_LABEL[ph.kind] || '') : null,
  ])));
}

/** Full-size view: change what it shows, add a caption, or delete it. */
export function openViewer(photos, index = 0, onChange) {
  let i = index;
  openModal('Photo', (close) => {
    const box = el('div', { class: 'photo-viewer' });
    const draw = () => {
      const ph = photos[i];
      const kind = segmented(KINDS, ph.kind);
      const caption = el('input', { value: ph.caption || '', placeholder: 'Caption (optional), e.g. part number', class: 'big' });
      const changed = () => kind.value !== ph.kind || caption.value.trim() !== (ph.caption || '');
      box.replaceChildren(
        el('div', { class: 'pv-image' }, photoImg(ph.id, false, { class: 'pv-full' })),
        photos.length > 1 ? el('div', { class: 'row-end pv-nav' }, [
          el('button', { type: 'button', disabled: i === 0, onclick: () => { i--; draw(); } }, '‹ Previous'),
          el('span', { class: 'muted' }, `${i + 1} of ${photos.length}`),
          el('button', { type: 'button', disabled: i === photos.length - 1, onclick: () => { i++; draw(); } }, 'Next ›'),
        ]) : null,
        el('p', { class: 'muted small' }, [ph.createdAt ? `Taken ${fmtWhen(ph.createdAt)}` : '', ph.by ? ` by ${ph.by}` : '']),
        el('div', { class: 'fld' }, [el('span', { class: 'fld-label' }, 'Shows'), kind.node]),
        el('label', { class: 'fld' }, [el('span', { class: 'fld-label' }, 'Caption'), caption]),
        el('div', { class: 'row-end' }, [
          el('button', { class: 'danger ghost', type: 'button', onclick: async () => {
            if (!(await confirmDialog('Delete this photo?'))) return;
            try {
              await api('/api/photos/' + ph.id, { method: 'DELETE' });
              toast('Photo deleted');
              close();
              onChange && onChange();
            } catch (err) { toast(err.message); }
          } }, 'Delete'),
          el('span', { class: 'spacer' }),
          el('button', { class: 'primary', type: 'button', onclick: async () => {
            if (!changed()) { close(); return; }
            try {
              const updated = await api('/api/photos/' + ph.id, { method: 'PATCH', body: { kind: kind.value, caption: caption.value.trim() } });
              photos[i] = { ...ph, ...updated };
              toast('Saved');
              close();
              onChange && onChange();
            } catch (err) { toast(err.message); }
          } }, 'Save'),
        ]),
      );
    };
    draw();
    return box;
  }, { wide: true });
}
