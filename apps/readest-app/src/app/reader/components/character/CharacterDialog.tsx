import clsx from 'clsx';
import React, { useRef, useState } from 'react';
import { LuArrowDown, LuArrowUp, LuClipboardPaste, LuImagePlus, LuTrash2 } from 'react-icons/lu';
import Dialog from '@/components/Dialog';
import { useTranslation } from '@/hooks/useTranslation';
import { BookCharacter, CharacterBlock, CharacterBlockType } from '@/types/book';
import { uniqueId } from '@/utils/misc';

const MAX_IMAGE_SIZE = 800;

/** Downscale to keep the book config small; flatten transparency onto white. */
async function imageToDataUrl(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIZE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}

const imagesFrom = (files: FileList | File[] | undefined | null): File[] =>
  Array.from(files ?? []).filter((f) => f.type.startsWith('image/'));

interface CharacterDialogProps {
  character: BookCharacter;
  isNew: boolean;
  onSave: (character: BookCharacter) => void;
  onDelete: (character: BookCharacter) => void;
  onClose: () => void;
}

const CharacterDialog: React.FC<CharacterDialogProps> = ({
  character,
  isNew,
  onSave,
  onDelete,
  onClose,
}) => {
  const _ = useTranslation();
  const [name, setName] = useState(character.name);
  const [aliases, setAliases] = useState((character.aliases ?? []).join(', '));
  const [blocks, setBlocks] = useState<CharacterBlock[]>(character.blocks);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Which image slot the file picker was opened for (null = append a new one).
  const pickerTarget = useRef<string | null>(null);

  const updateBlock = (id: string, patch: Partial<CharacterBlock>) =>
    setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));

  const addBlock = (type: CharacterBlockType) =>
    setBlocks((prev) => [...prev, { id: uniqueId(), type, text: '', src: '' }]);

  const moveBlock = (id: string, delta: -1 | 1) =>
    setBlocks((prev) => {
      const i = prev.findIndex((b) => b.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const removeBlock = (id: string) => setBlocks((prev) => prev.filter((b) => b.id !== id));

  // Put images into `targetId` (first one) and append the rest; with no target,
  // fill the first empty image slot before appending.
  const insertImages = async (files: File[], targetId?: string | null) => {
    if (!files.length) return;
    const urls: string[] = [];
    for (const file of files) {
      try {
        urls.push(await imageToDataUrl(file));
      } catch (err) {
        console.warn('Failed to read image', err);
      }
    }
    if (!urls.length) return;
    setBlocks((prev) => {
      const next = prev.map((b) => ({ ...b }));
      let target = targetId;
      for (const src of urls) {
        const slot = target
          ? next.find((b) => b.id === target && b.type === 'image')
          : next.find((b) => b.type === 'image' && !b.src);
        target = null;
        if (slot) slot.src = src;
        else next.push({ id: uniqueId(), type: 'image', src });
      }
      return next;
    });
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = imagesFrom(e.clipboardData.files);
    if (!files.length) return; // plain text paste keeps its default behavior
    e.preventDefault();
    void insertImages(files);
  };

  const handlePasteButton = async (targetId?: string) => {
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) files.push(new File([await item.getType(type)], 'pasted', { type }));
      }
      await insertImages(files, targetId);
    } catch (err) {
      console.warn('Clipboard image read failed', err);
    }
  };

  const openPicker = (targetId: string | null) => {
    pickerTarget.current = targetId;
    fileInputRef.current?.click();
  };

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave({
      ...character,
      name: trimmed,
      aliases: aliases
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      // Drop slots the user never filled.
      blocks: blocks.filter((b) => (b.type === 'image' ? !!b.src : !!b.text?.trim())),
    });
  };

  const iconBtn = 'btn btn-ghost btn-xs btn-square';

  return (
    <Dialog
      id='character-dialog'
      isOpen
      title={isNew ? _('New Character') : _('Character')}
      onClose={onClose}
      boxClassName='sm:h-[85%] sm:min-w-[520px] sm:max-w-[640px]'
      contentClassName='px-4! sm:px-6!'
      useOverlayScroll
    >
      <div className='flex flex-col gap-4 pb-6 pt-2' onPaste={handlePaste}>
        <label className='form-control w-full'>
          <span className='label-text mb-1'>{_('Name')}</span>
          <input
            className='input input-bordered w-full'
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className='form-control w-full'>
          <span className='label-text mb-1'>{_('Other names (comma separated)')}</span>
          <input
            className='input input-bordered w-full'
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
          />
        </label>

        {blocks.map((block, i) => (
          <div key={block.id} className='border-base-300 rounded-lg border p-3'>
            {block.type === 'image' && (
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const files = imagesFrom(e.dataTransfer.files);
                  if (!files.length) return;
                  e.preventDefault();
                  void insertImages(files, block.id);
                }}
              >
                {block.src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={block.src} alt={name} className='mx-auto max-h-72 rounded' />
                ) : (
                  <div className='text-base-content/60 flex flex-col items-center gap-2 py-6 text-sm'>
                    <span>{_('Paste (Ctrl+V), drop or upload an image')}</span>
                    <div className='flex gap-2'>
                      <button className='btn btn-sm' onClick={() => openPicker(block.id)}>
                        <LuImagePlus /> {_('Upload')}
                      </button>
                      <button className='btn btn-sm' onClick={() => handlePasteButton(block.id)}>
                        <LuClipboardPaste /> {_('Paste')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {block.type === 'title' && (
              <input
                className='input input-bordered w-full text-lg font-semibold'
                placeholder={_('Title')}
                value={block.text ?? ''}
                onChange={(e) => updateBlock(block.id, { text: e.target.value })}
              />
            )}
            {block.type === 'text' && (
              <textarea
                className='textarea textarea-bordered min-h-24 w-full'
                placeholder={_('Description')}
                value={block.text ?? ''}
                onChange={(e) => updateBlock(block.id, { text: e.target.value })}
              />
            )}
            <div className='mt-2 flex justify-end gap-1'>
              {block.type === 'image' && block.src && (
                <button className={iconBtn} onClick={() => openPicker(block.id)}>
                  <LuImagePlus />
                </button>
              )}
              <button
                className={iconBtn}
                disabled={i === 0}
                onClick={() => moveBlock(block.id, -1)}
              >
                <LuArrowUp />
              </button>
              <button
                className={iconBtn}
                disabled={i === blocks.length - 1}
                onClick={() => moveBlock(block.id, 1)}
              >
                <LuArrowDown />
              </button>
              <button className={clsx(iconBtn, 'text-error')} onClick={() => removeBlock(block.id)}>
                <LuTrash2 />
              </button>
            </div>
          </div>
        ))}

        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-base-content/60 text-sm'>{_('Add')}:</span>
          <button className='btn btn-sm' onClick={() => addBlock('image')}>
            {_('Image')}
          </button>
          <button className='btn btn-sm' onClick={() => addBlock('title')}>
            {_('Title')}
          </button>
          <button className='btn btn-sm' onClick={() => addBlock('text')}>
            {_('Text')}
          </button>
        </div>

        <div className='mt-2 flex justify-between'>
          {isNew ? (
            <span />
          ) : (
            <button className='btn btn-ghost text-error' onClick={() => onDelete(character)}>
              {_('Delete')}
            </button>
          )}
          <div className='flex gap-2'>
            <button className='btn btn-ghost' onClick={onClose}>
              {_('Cancel')}
            </button>
            <button className='btn btn-primary' disabled={!name.trim()} onClick={handleSave}>
              {_('Save')}
            </button>
          </div>
        </div>
      </div>
      <input
        ref={fileInputRef}
        type='file'
        accept='image/*'
        multiple
        className='hidden'
        onChange={(e) => {
          void insertImages(imagesFrom(e.target.files), pickerTarget.current);
          e.target.value = '';
        }}
      />
    </Dialog>
  );
};

export default CharacterDialog;
