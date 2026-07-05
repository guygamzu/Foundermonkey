'use client';

import { useState, useEffect, useCallback, lazy, Suspense, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  getSetupDocument,
  getSetupDocumentDirectUrl,
  getSetupDocumentProxyUrl,
  createSetupField,
  deleteSetupField,
  updateSetupFieldPosition,
  addSetupSigner,
  removeSetupSigner,
  sendForSigning,
  finishSetup,
  voidAndReconfigure,
  updateSetupSigningMode,
  type SetupDocument,
  type SetupField,
  type SetupSigner,
} from '@/lib/api';

const PDFViewer = lazy(() => import('@/components/PDFViewer'));

type ToolType = 'signature' | 'text' | 'date' | 'checkbox' | 'option' | null;

const SIGNER_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#be185d', '#4f46e5'];

export default function SetupPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [doc, setDoc] = useState<SetupDocument | null>(null);
  const [fields, setFields] = useState<SetupField[]>([]);
  const [activeTool, setActiveTool] = useState<ToolType>(null);
  const [selectedSignerIdx, setSelectedSignerIdx] = useState(0);
  const [selectedFieldIds, setSelectedFieldIds] = useState<Set<string>>(new Set());

  // Undo history — each entry is a command with enough info to reverse it
  type UndoCmd =
    | { type: 'create'; ids: string[] }
    | { type: 'delete'; fields: SetupField[] }
    | { type: 'move'; updates: Array<{ id: string; oldX: number; oldY: number }> };
  const historyRef = useRef<UndoCmd[]>([]);
  const pushHistory = useCallback((cmd: UndoCmd) => {
    historyRef.current.push(cmd);
    // Cap history at 50 entries
    if (historyRef.current.length > 50) historyRef.current.shift();
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [showAddSigner, setShowAddSigner] = useState(false);
  const [newSignerEmail, setNewSignerEmail] = useState('');
  const [newSignerName, setNewSignerName] = useState('');
  const [showVoidWarning, setShowVoidWarning] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [doneSuccess, setDoneSuccess] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const data = await getSetupDocument(id);
        // Show page immediately with whatever data we have
        setDoc(data);
        setFields(data.fields);
        setLoading(false);

        // In template mode (no signers), auto-create a placeholder signer and default to individual mode
        const hasTemplateSigner = data.signers.some(s => s.email === 'template@lapen.ai');
        if (data.signers.length === 0) {
          try {
            const [templateSigner] = await Promise.all([
              addSetupSigner(id, { name: 'Template', email: 'template@lapen.ai' }),
              data.signingMode !== 'individual' ? updateSetupSigningMode(id, 'individual') : Promise.resolve(),
            ]);
            setDoc(prev => prev ? {
              ...prev,
              signers: [...prev.signers, templateSigner],
              signingMode: 'individual',
            } : prev);
          } catch {
            // Template signer creation failed — page still works, user can add signers manually
          }
        }
      } catch (err: any) {
        setError(err.message);
        setLoading(false);
      }
    }
    load();
  }, [id]);

  const signers = doc?.signers ?? [];
  const selectedSigner = signers[selectedSignerIdx];

  const getSignerColor = (signerId: string) => {
    const idx = signers.findIndex(s => s.id === signerId);
    return SIGNER_COLORS[idx % SIGNER_COLORS.length];
  };

  // Determine if this is template mode: only signer is the placeholder template@lapen.ai
  const isTemplateMode = signers.length === 0 || (signers.length === 1 && signers[0].email === 'template@lapen.ai');
  const realSigners = signers.filter(s => s.email !== 'template@lapen.ai');

  // Place field on PDF click
  const handlePdfClick = useCallback(async (pageIndex: number, relativeX: number, relativeY: number) => {
    if (!activeTool || !selectedSigner) return;

    const type = activeTool;
    const dims: Record<string, { w: number; h: number }> = {
      signature: { w: 0.25, h: 0.05 },
      text: { w: 0.15, h: 0.035 },
      date: { w: 0.12, h: 0.03 },
      checkbox: { w: 0.04, h: 0.04 },
      option: { w: 0.04, h: 0.04 },
    };
    const dim = dims[type] || { w: 0.15, h: 0.035 };

    const x = Math.max(0, Math.min(1 - dim.w, relativeX - dim.w / 2));
    const y = Math.max(0, Math.min(1 - dim.h, relativeY - dim.h / 2));

    try {
      const field = await createSetupField(id, {
        signerId: selectedSigner.id,
        type,
        page: pageIndex + 1,
        x,
        y,
        width: dim.w,
        height: dim.h,
      });
      setFields(prev => [...prev, field]);
      pushHistory({ type: 'create', ids: [field.id] });
    } catch (err: any) {
      setError(err.message);
    }
    // Deselect the tool after placing so blank-area clicks can drive selection/marquee
    setActiveTool(null);
  }, [activeTool, selectedSigner, id, pushHistory]);

  // Done — mark template as ready (no signers needed)
  const handleDone = useCallback(async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await finishSetup(id);
      setDoneSuccess(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }, [id, sending]);

  // Void and reconfigure
  const handleVoidAndReconfigure = useCallback(async () => {
    setVoiding(true);
    setError(null);
    try {
      await voidAndReconfigure(id);
      // Reload the page data
      const data = await getSetupDocument(id);
      setDoc(data);
      setFields(data.fields);
      setShowVoidWarning(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setVoiding(false);
    }
  }, [id]);

  // Remove field
  const handleRemoveField = useCallback(async (fieldId: string) => {
    const removed = fields.find(f => f.id === fieldId);
    try {
      await deleteSetupField(id, fieldId);
      setFields(prev => prev.filter(f => f.id !== fieldId));
      setSelectedFieldIds(prev => {
        if (!prev.has(fieldId)) return prev;
        const next = new Set(prev);
        next.delete(fieldId);
        return next;
      });
      if (removed) pushHistory({ type: 'delete', fields: [removed] });
    } catch (err: any) {
      setError(err.message);
    }
  }, [id, fields, pushHistory]);

  // Selection: click on placed field
  const handleSelectField = useCallback((fieldId: string, shift: boolean) => {
    setSelectedFieldIds(prev => {
      if (shift) {
        const next = new Set(prev);
        if (next.has(fieldId)) next.delete(fieldId);
        else next.add(fieldId);
        return next;
      }
      // Plain click on already-selected keeps it; plain click on unselected selects only it
      if (prev.size === 1 && prev.has(fieldId)) return prev;
      return new Set([fieldId]);
    });
  }, []);

  // Delete selected fields
  const handleDeleteSelection = useCallback(async () => {
    if (selectedFieldIds.size === 0) return;
    const ids = Array.from(selectedFieldIds);
    const removed = fields.filter(f => ids.includes(f.id));
    setSelectedFieldIds(new Set());
    setFields(prev => prev.filter(f => !ids.includes(f.id)));
    await Promise.all(
      ids.map(fid => deleteSetupField(id, fid).catch(() => null)),
    );
    if (removed.length > 0) pushHistory({ type: 'delete', fields: removed });
  }, [selectedFieldIds, id, fields, pushHistory]);

  // Undo (Cmd/Ctrl+Z) — pops the last command from history and reverses it
  const [undoBusy, setUndoBusy] = useState(false);
  const handleUndo = useCallback(async () => {
    if (undoBusy) return;
    const cmd = historyRef.current.pop();
    if (!cmd) return;
    setUndoBusy(true);
    try {
      if (cmd.type === 'create') {
        setFields(prev => prev.filter(f => !cmd.ids.includes(f.id)));
        setSelectedFieldIds(prev => {
          const next = new Set(prev);
          cmd.ids.forEach(i => next.delete(i));
          return next;
        });
        await Promise.all(cmd.ids.map(fid => deleteSetupField(id, fid).catch(() => null)));
      } else if (cmd.type === 'delete') {
        const created: SetupField[] = [];
        for (const src of cmd.fields) {
          try {
            const c = await createSetupField(id, {
              signerId: src.signerId,
              type: src.type,
              page: src.page,
              x: src.x,
              y: src.y,
              width: src.width,
              height: src.height,
              optionGroupId: src.optionGroupId ?? null,
            });
            created.push(c);
          } catch {
            // Individual recreate failed — skip
          }
        }
        if (created.length > 0) setFields(prev => [...prev, ...created]);
      } else if (cmd.type === 'move') {
        const posById = new Map(cmd.updates.map(u => [u.id, { x: u.oldX, y: u.oldY }]));
        setFields(prev => prev.map(f => {
          const p = posById.get(f.id);
          return p ? { ...f, x: p.x, y: p.y } : f;
        }));
        await Promise.all(
          cmd.updates.map(u => updateSetupFieldPosition(id, u.id, u.oldX, u.oldY).catch(() => null)),
        );
      }
    } finally {
      setUndoBusy(false);
    }
  }, [id, undoBusy]);

  // Escape clears selection; Delete/Backspace removes selected; Cmd/Ctrl+Z undoes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (e.key === 'Escape') {
        setSelectedFieldIds(new Set());
        setActiveTool(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !inInput) {
        if (selectedFieldIds.size > 0) {
          e.preventDefault();
          handleDeleteSelection();
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !inInput) {
        e.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedFieldIds, handleDeleteSelection, handleUndo]);

  // Persist a batch of field position updates
  const persistPositions = useCallback(async (updates: Array<{ id: string; x: number; y: number }>) => {
    await Promise.all(
      updates.map(u => updateSetupFieldPosition(id, u.id, u.x, u.y).catch(() => null)),
    );
  }, [id]);

  // Alignment operations — all act on selectedFieldIds
  const applyAlignment = useCallback((op:
    | 'left' | 'center-x' | 'right'
    | 'top' | 'center-y' | 'bottom'
    | 'distribute-h' | 'distribute-v'
  ) => {
    if (selectedFieldIds.size < 2) return;
    const selected = fields.filter(f => selectedFieldIds.has(f.id));
    if (selected.length < 2) return;

    let updated: SetupField[] = [];

    if (op === 'left') {
      const minX = Math.min(...selected.map(f => f.x));
      updated = selected.map(f => ({ ...f, x: minX }));
    } else if (op === 'right') {
      const maxRight = Math.max(...selected.map(f => f.x + f.width));
      updated = selected.map(f => ({ ...f, x: maxRight - f.width }));
    } else if (op === 'center-x') {
      const minX = Math.min(...selected.map(f => f.x));
      const maxRight = Math.max(...selected.map(f => f.x + f.width));
      const center = (minX + maxRight) / 2;
      updated = selected.map(f => ({ ...f, x: center - f.width / 2 }));
    } else if (op === 'top') {
      const minY = Math.min(...selected.map(f => f.y));
      updated = selected.map(f => ({ ...f, y: minY }));
    } else if (op === 'bottom') {
      const maxBottom = Math.max(...selected.map(f => f.y + f.height));
      updated = selected.map(f => ({ ...f, y: maxBottom - f.height }));
    } else if (op === 'center-y') {
      const minY = Math.min(...selected.map(f => f.y));
      const maxBottom = Math.max(...selected.map(f => f.y + f.height));
      const center = (minY + maxBottom) / 2;
      updated = selected.map(f => ({ ...f, y: center - f.height / 2 }));
    } else if (op === 'distribute-h' && selected.length >= 3) {
      const sorted = [...selected].sort((a, b) => a.x - b.x);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const startCenter = first.x + first.width / 2;
      const endCenter = last.x + last.width / 2;
      const step = (endCenter - startCenter) / (sorted.length - 1);
      updated = sorted.map((f, i) => ({ ...f, x: startCenter + i * step - f.width / 2 }));
    } else if (op === 'distribute-v' && selected.length >= 3) {
      const sorted = [...selected].sort((a, b) => a.y - b.y);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const startCenter = first.y + first.height / 2;
      const endCenter = last.y + last.height / 2;
      const step = (endCenter - startCenter) / (sorted.length - 1);
      updated = sorted.map((f, i) => ({ ...f, y: startCenter + i * step - f.height / 2 }));
    } else {
      return;
    }

    // Snapshot original positions for undo
    const originalById = new Map(selected.map(f => [f.id, { x: f.x, y: f.y }]));
    const moveUndo = updated
      .filter(u => {
        const orig = originalById.get(u.id);
        return orig && (orig.x !== u.x || orig.y !== u.y);
      })
      .map(u => ({ id: u.id, oldX: originalById.get(u.id)!.x, oldY: originalById.get(u.id)!.y }));

    const updatedMap = new Map(updated.map(u => [u.id, u]));
    setFields(prev => prev.map(f => updatedMap.get(f.id) ?? f));
    persistPositions(updated.map(u => ({ id: u.id, x: u.x, y: u.y })));
    if (moveUndo.length > 0) pushHistory({ type: 'move', updates: moveUndo });
  }, [fields, selectedFieldIds, persistPositions, pushHistory]);

  // Duplicate selected fields (offset by small amount, preserving option stacks)
  const handleDuplicateSelection = useCallback(async () => {
    if (selectedFieldIds.size === 0) return;
    const selected = fields.filter(f => selectedFieldIds.has(f.id));
    if (selected.length === 0) return;

    // For option fields: each source group_id maps to a NEW group_id in the duplicate.
    // Option fields without a group_id (legacy) get grouped by page instead.
    const groupIdMap = new Map<string, string>();
    const newGroupId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `grp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const OFFSET = 0.02;
    const newIds: string[] = [];
    for (const src of selected) {
      const x = Math.max(0, Math.min(1 - src.width, src.x + OFFSET));
      const y = Math.max(0, Math.min(1 - src.height, src.y + OFFSET));

      let optionGroupId: string | null = null;
      if (src.type === 'option') {
        const srcKey = src.optionGroupId ?? `page-${src.page}`;
        const mapped = groupIdMap.get(srcKey);
        if (mapped) {
          optionGroupId = mapped;
        } else {
          optionGroupId = newGroupId();
          groupIdMap.set(srcKey, optionGroupId);
        }
      }

      try {
        const created = await createSetupField(id, {
          signerId: src.signerId,
          type: src.type,
          page: src.page,
          x,
          y,
          width: src.width,
          height: src.height,
          optionGroupId,
        });
        newIds.push(created.id);
        setFields(prev => [...prev, created]);
      } catch (err: any) {
        setError(err.message);
      }
    }
    if (newIds.length > 0) {
      setSelectedFieldIds(new Set(newIds));
      pushHistory({ type: 'create', ids: newIds });
    }
  }, [fields, selectedFieldIds, id, pushHistory]);

  // Cmd/Ctrl+D duplicates current selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && !inInput) {
        if (selectedFieldIds.size > 0) {
          e.preventDefault();
          handleDuplicateSelection();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedFieldIds, handleDuplicateSelection]);

  // Marquee (rubber-band) selection
  const [marquee, setMarquee] = useState<{
    pageIndex: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null>(null);
  const marqueeRef = useRef<{
    pageIndex: number;
    startX: number;
    startY: number;
    containerRect: DOMRect;
    additive: boolean;
    dragged: boolean;
  } | null>(null);

  const handleMarqueeStart = useCallback((e: React.MouseEvent, pageIndex: number) => {
    if (activeTool) return;
    if ((e.target as HTMLElement).closest('.placed-item')) return;

    const catcherEl = e.currentTarget as HTMLElement;
    const containerRect = catcherEl.getBoundingClientRect();

    e.preventDefault();
    e.stopPropagation();

    marqueeRef.current = {
      pageIndex,
      startX: e.clientX,
      startY: e.clientY,
      containerRect,
      additive: e.shiftKey || e.metaKey || e.ctrlKey,
      dragged: false,
    };
  }, [activeTool]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!marqueeRef.current) return;
      const { pageIndex, startX, startY, containerRect } = marqueeRef.current;
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      if (!marqueeRef.current.dragged && dx < 3 && dy < 3) return;
      marqueeRef.current.dragged = true;

      const nx1 = (startX - containerRect.left) / containerRect.width;
      const ny1 = (startY - containerRect.top) / containerRect.height;
      const nx2 = (e.clientX - containerRect.left) / containerRect.width;
      const ny2 = (e.clientY - containerRect.top) / containerRect.height;

      setMarquee({
        pageIndex,
        minX: Math.max(0, Math.min(nx1, nx2)),
        minY: Math.max(0, Math.min(ny1, ny2)),
        maxX: Math.min(1, Math.max(nx1, nx2)),
        maxY: Math.min(1, Math.max(ny1, ny2)),
      });
    };

    const onUp = () => {
      const state = marqueeRef.current;
      if (!state) return;
      marqueeRef.current = null;

      if (!state.dragged) {
        // Was a click on empty area, not a drag → clear selection
        if (!state.additive) setSelectedFieldIds(new Set());
        setMarquee(null);
        return;
      }

      // Determine intersecting fields on this page
      setMarquee(current => {
        if (!current) return null;
        const { pageIndex, minX, minY, maxX, maxY } = current;
        const intersecting = fields
          .filter(f =>
            f.page === pageIndex + 1 &&
            f.x < maxX &&
            f.x + f.width > minX &&
            f.y < maxY &&
            f.y + f.height > minY,
          )
          .map(f => f.id);

        setSelectedFieldIds(prev => {
          if (state.additive) {
            const next = new Set(prev);
            intersecting.forEach(id => next.add(id));
            return next;
          }
          return new Set(intersecting);
        });
        return null;
      });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [fields]);

  // Drag-to-move fields (supports group drag when multiple selected)
  const dragRef = useRef<{
    primaryId: string;
    startX: number;
    startY: number;
    containerRect: DOMRect;
    items: Array<{ id: string; origX: number; origY: number; width: number; height: number }>;
  } | null>(null);

  const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent, fieldId: string) => {
    if ((e.target as HTMLElement).closest('.remove-item-btn')) return;

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    const itemEl = (e.target as HTMLElement).closest('.placed-item') as HTMLElement;
    if (!itemEl) return;
    const container = itemEl.closest('.field-overlay-container > div') as HTMLElement;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const primary = fields.find(f => f.id === fieldId);
    if (!primary) return;

    e.preventDefault();
    e.stopPropagation();

    // If dragging a selected field with others selected, group-drag them all
    const dragIds = selectedFieldIds.has(fieldId) && selectedFieldIds.size > 1
      ? selectedFieldIds
      : new Set([fieldId]);

    const items = fields
      .filter(f => dragIds.has(f.id))
      .map(f => ({ id: f.id, origX: f.x, origY: f.y, width: f.width, height: f.height }));

    dragRef.current = {
      primaryId: fieldId,
      startX: clientX,
      startY: clientY,
      containerRect,
      items,
    };

    document.querySelectorAll('.placed-item').forEach(el => {
      const el2 = el as HTMLElement;
      const id = el2.getAttribute('data-field-id');
      if (id && dragIds.has(id)) el2.classList.add('dragging');
    });
  }, [fields, selectedFieldIds]);

  useEffect(() => {
    const handleDragMove = (e: MouseEvent | TouchEvent) => {
      if (!dragRef.current) return;
      e.preventDefault();

      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

      const { startX, startY, containerRect, items } = dragRef.current;
      const rawDX = (clientX - startX) / containerRect.width;
      const rawDY = (clientY - startY) / containerRect.height;

      // Clamp movement so no item leaves the page
      const minDX = Math.max(...items.map(i => -i.origX));
      const maxDX = Math.min(...items.map(i => 1 - i.width - i.origX));
      const minDY = Math.max(...items.map(i => -i.origY));
      const maxDY = Math.min(...items.map(i => 1 - i.height - i.origY));
      const dX = Math.max(minDX, Math.min(maxDX, rawDX));
      const dY = Math.max(minDY, Math.min(maxDY, rawDY));

      const updates = new Map(items.map(i => [i.id, { x: i.origX + dX, y: i.origY + dY }]));
      setFields(prev =>
        prev.map(f => {
          const u = updates.get(f.id);
          return u ? { ...f, x: u.x, y: u.y } : f;
        }),
      );
    };

    const handleDragEnd = async () => {
      if (!dragRef.current) return;
      const { items } = dragRef.current;
      document.querySelectorAll('.placed-item.dragging').forEach(el => el.classList.remove('dragging'));

      // Persist all moved items
      const currentById = new Map(fields.map(f => [f.id, f]));
      const updates = items
        .map(i => currentById.get(i.id))
        .filter((f): f is SetupField => !!f)
        .map(f => ({ id: f.id, x: f.x, y: f.y }));

      // Build undo entry using the original positions captured at drag start
      const undoUpdates = items
        .filter(i => {
          const cur = currentById.get(i.id);
          return cur && (cur.x !== i.origX || cur.y !== i.origY);
        })
        .map(i => ({ id: i.id, oldX: i.origX, oldY: i.origY }));

      await persistPositions(updates);
      if (undoUpdates.length > 0) pushHistory({ type: 'move', updates: undoUpdates });

      dragRef.current = null;
    };

    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);
    document.addEventListener('touchmove', handleDragMove, { passive: false });
    document.addEventListener('touchend', handleDragEnd);

    return () => {
      document.removeEventListener('mousemove', handleDragMove);
      document.removeEventListener('mouseup', handleDragEnd);
      document.removeEventListener('touchmove', handleDragMove);
      document.removeEventListener('touchend', handleDragEnd);
    };
  }, [fields, id, persistPositions, pushHistory]);

  // Add signer
  const handleAddSigner = useCallback(async () => {
    if (!newSignerEmail.trim()) return;
    try {
      const signer = await addSetupSigner(id, { name: newSignerName.trim() || undefined, email: newSignerEmail.trim() });
      setDoc(prev => prev ? { ...prev, signers: [...prev.signers, signer] } : prev);
      setNewSignerEmail('');
      setNewSignerName('');
      setShowAddSigner(false);
      // Select the new signer
      setSelectedSignerIdx(signers.length);
    } catch (err: any) {
      setError(err.message);
    }
  }, [id, newSignerEmail, newSignerName, signers.length]);

  // Remove signer
  const handleRemoveSigner = useCallback(async (signerId: string, idx: number) => {
    try {
      await removeSetupSigner(id, signerId);
      setDoc(prev => {
        if (!prev) return prev;
        const updated = prev.signers.filter(s => s.id !== signerId);
        return { ...prev, signers: updated };
      });
      setFields(prev => prev.filter(f => f.signerId !== signerId));
      if (selectedSignerIdx >= idx && selectedSignerIdx > 0) {
        setSelectedSignerIdx(selectedSignerIdx - 1);
      }
    } catch (err: any) {
      setError(err.message);
    }
  }, [id, selectedSignerIdx]);

  // Toggle signing mode
  const handleToggleMode = useCallback(async () => {
    if (!doc) return;
    const newMode = doc.signingMode === 'shared' ? 'individual' : 'shared';
    try {
      await updateSetupSigningMode(id, newMode);
      setDoc(prev => prev ? { ...prev, signingMode: newMode } : prev);
      // Clear activeTool if switching to shared with checkbox/option selected
      if (newMode === 'shared' && (activeTool === 'checkbox' || activeTool === 'option')) {
        setActiveTool(null);
      }
    } catch (err: any) {
      setError(err.message);
    }
  }, [doc, id]);

  // Send for signing
  const handleSend = useCallback(async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await sendForSigning(id);
      router.push(`/status/${id}`);
    } catch (err: any) {
      setError(err.message);
      setSending(false);
    }
  }, [id, sending, router]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Loading setup...</p>
      </div>
    );
  }

  if (error && !doc) {
    return (
      <div className="message-page">
        <div className="message-card">
          <h2>Error</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!doc) return null;

  const fieldTypeLabel = (type: string) => {
    if (type === 'signature') return 'Sig';
    if (type === 'text') return 'Text';
    if (type === 'date') return 'Date';
    if (type === 'checkbox') return '✓';
    if (type === 'option') return 'Opt';
    return type;
  };

  // Show done success page
  if (doneSuccess) {
    const emailSubject = encodeURIComponent(`Please sign: ${doc?.fileName || 'Document'}`);
    const emailBody = encodeURIComponent(
      `Hi,\n\nPlease review and sign the attached document "${doc?.fileName || 'Document'}".\n\n` +
      `Once you receive this email, Lapen will send you a simple and secure link to sign the document electronically — no account or downloads needed.\n\n` +
      `Thank you!`
    );
    const mailtoLink = `mailto:?cc=sign@lapen.ai&subject=${emailSubject}&body=${emailBody}`;
    const downloadUrl = `${getSetupDocumentProxyUrl(id)}?download=true`;

    return (
      <div className="message-page">
        <div className="message-card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '3rem', marginBottom: 16 }}>✓</div>
          <h2>Document Ready!</h2>
          <p style={{ margin: '12px 0', color: 'var(--gray-500)' }}>
            Your fields for <strong>{doc?.fileName}</strong> are configured.
          </p>
          <div style={{
            background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8,
            padding: 16, margin: '16px 0', textAlign: 'left',
          }}>
            <p style={{ fontWeight: 600, margin: '0 0 8px' }}>What to do next:</p>
            <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8 }}>
              <li>Click <strong>&quot;Send via Email&quot;</strong> below to open your email with everything pre-filled</li>
              <li>Attach the PDF <strong>&quot;{doc?.fileName}&quot;</strong> (download it below if needed)</li>
              <li>Add your recipients and hit send</li>
              <li>Lapen will send each recipient a personalized signing link</li>
            </ol>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '20px 0' }}>
            <a
              href={mailtoLink}
              className="btn btn-primary btn-block"
              style={{ textDecoration: 'none', textAlign: 'center' }}
            >
              Send via Email
            </a>
            <a
              href={downloadUrl}
              className="btn btn-block"
              style={{
                textDecoration: 'none', textAlign: 'center',
                background: 'white', border: '1px solid var(--gray-300)', color: 'var(--gray-700)',
              }}
            >
              Download PDF
            </a>
          </div>
          <p style={{ fontSize: '0.8125rem', color: 'var(--gray-400)' }}>
            Make sure <strong>sign@lapen.ai</strong> is in CC so we can send signing links to your recipients.
          </p>
        </div>
      </div>
    );
  }

  // Show void warning if document already sent
  if (doc?.warning?.alreadySent && !showVoidWarning) {
    return (
      <div className="message-page">
        <div className="message-card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '3rem', marginBottom: 16 }}>⚠️</div>
          <h2>Document Already Sent</h2>
          <p style={{ margin: '12px 0', color: 'var(--gray-500)' }}>
            This document has been sent to <strong>{doc.warning.signerCount}</strong> signer{doc.warning.signerCount !== 1 ? 's' : ''}.
            {doc.warning.signedCount > 0 && (
              <> <strong>{doc.warning.signedCount}</strong> ha{doc.warning.signedCount !== 1 ? 've' : 's'} already signed.</>
            )}
          </p>
          <p style={{ margin: '12px 0', color: '#991b1b', fontWeight: 500 }}>
            Making changes will void all existing signatures. Signers will need to re-sign.
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 20 }}>
            <button
              className="btn btn-secondary"
              onClick={() => router.push(`/status/${id}`)}
            >
              Cancel
            </button>
            <button
              className="btn"
              style={{ background: '#dc2626', color: 'white' }}
              onClick={() => {
                setShowVoidWarning(true);
                handleVoidAndReconfigure();
              }}
              disabled={voiding}
            >
              {voiding ? 'Voiding...' : 'Proceed & Void Signatures'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="signing-page">
      {/* Header */}
      <div className="signing-header">
        <span className="logo">La <span className="pen">Pen</span><span className="seal">.</span></span>
        <h1>{doc.fileName}</h1>
        {!isTemplateMode ? (
          <button
            className="btn btn-primary"
            style={{ padding: '6px 16px', fontSize: '0.8rem', minHeight: 'auto' }}
            onClick={handleSend}
            disabled={sending}
          >
            {sending ? 'Sending...' : 'Send for Signing'}
          </button>
        ) : (
          <button
            className="btn btn-primary"
            style={{ padding: '6px 16px', fontSize: '0.8rem', minHeight: 'auto' }}
            onClick={handleDone}
            disabled={sending || fields.length === 0}
          >
            {sending ? 'Saving...' : 'Done'}
          </button>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          background: '#fef2f2', borderBottom: '1px solid #fecaca', padding: '8px 16px',
          fontSize: '0.8125rem', color: '#991b1b', textAlign: 'center',
          maxWidth: 832, margin: '0 auto', width: '100%',
        }}>
          {error}
          <button onClick={() => setError(null)} style={{
            marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', color: '#991b1b', fontWeight: 700,
          }}>&times;</button>
        </div>
      )}

      {/* Signing Mode Cards */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
        padding: '6px 16px', maxWidth: 832, margin: '0 auto', width: '100%',
      }}>
        <SigningModeCard
          active={doc.signingMode === 'shared'}
          onClick={() => doc.signingMode !== 'shared' && handleToggleMode()}
          title="Shared document"
          subtitle="One PDF, everyone signs it"
          bestFor="Contracts, leases, partnership agreements — where every party appears together on one signed file."
          fields="✍ Signature · T Text · 📅 Date"
          limitation="Checkbox and Option are disabled (they'd conflict between signers on one document)."
        />
        <SigningModeCard
          active={doc.signingMode === 'individual'}
          onClick={() => doc.signingMode !== 'individual' && handleToggleMode()}
          title="Individual copies"
          subtitle="Each signer gets their own PDF"
          bestFor="NDAs, HR forms, surveys, questionnaires — where each person returns their own signed version."
          fields="✍ Signature · T Text · 📅 Date · ☑ Checkbox · ◉ Option"
          limitation={null}
        />
      </div>

      {/* Signer Tabs — hidden entirely in template mode */}
      {!isTemplateMode && (
        <div className="signer-tabs">
          {signers.map((signer, idx) => (
            <div
              key={signer.id}
              className={`signer-tab ${idx === selectedSignerIdx ? 'active' : ''}`}
              style={{
                '--signer-color': SIGNER_COLORS[idx % SIGNER_COLORS.length],
              } as React.CSSProperties}
              onClick={() => setSelectedSignerIdx(idx)}
            >
              <span className="signer-tab-dot" style={{ background: SIGNER_COLORS[idx % SIGNER_COLORS.length] }} />
              <span className="signer-tab-name">{signer.name || signer.email}</span>
              {signers.length > 1 && (
                <button
                  className="signer-tab-remove"
                  onClick={(e) => { e.stopPropagation(); handleRemoveSigner(signer.id, idx); }}
                  title="Remove signer"
                >
                  &times;
                </button>
              )}
            </div>
          ))}
          <button className="add-signer-btn" onClick={() => setShowAddSigner(true)} title="Add signer">+</button>
        </div>
      )}

      {/* Toolbar */}
      <div className="signing-toolbar">
        <span style={{ fontSize: '0.75rem', color: 'var(--gray-500)', marginRight: 8 }}>
          {isTemplateMode ? 'Place fields:' : `Place for ${selectedSigner?.name || selectedSigner?.email || 'signer'}:`}
        </span>
        {(['signature', 'text', 'date', 'checkbox', 'option'] as ToolType[]).map(tool => {
          // In shared mode, only signature/text/date are allowed
          const isDisabled = doc?.signingMode === 'shared' && (tool === 'checkbox' || tool === 'option');
          return (
            <button
              key={tool!}
              className={`toolbar-btn ${activeTool === tool ? 'active' : ''}${isDisabled ? ' disabled' : ''}`}
              onClick={() => !isDisabled && setActiveTool(activeTool === tool ? null : tool)}
              disabled={isDisabled}
              title={isDisabled ? 'Only available in Individual Copies mode' : undefined}
            >
              <span className="toolbar-icon">
                {tool === 'signature' && '✍'}
                {tool === 'text' && 'T'}
                {tool === 'date' && '📅'}
                {tool === 'checkbox' && '☑'}
                {tool === 'option' && '◉'}
              </span>
              <span className="toolbar-label">
                {tool === 'signature' && 'Signature'}
                {tool === 'text' && 'Text'}
                {tool === 'date' && 'Date'}
                {tool === 'checkbox' && 'Checkbox'}
                {tool === 'option' && 'Option'}
              </span>
            </button>
          );
        })}
        <button
          onClick={handleUndo}
          disabled={undoBusy || historyRef.current.length === 0}
          title="Undo (⌘Z)"
          style={{
            marginLeft: 'auto',
            padding: '6px 12px',
            background: 'white',
            border: '1px solid var(--gray-300)',
            borderRadius: 6,
            fontSize: '0.8rem',
            fontWeight: 600,
            color: 'var(--gray-700)',
            cursor: undoBusy ? 'not-allowed' : 'pointer',
            opacity: historyRef.current.length === 0 ? 0.4 : 1,
          }}
        >
          {undoBusy ? '⏳ Undoing…' : '↶ Undo'}
        </button>
      </div>

      {activeTool && (
        <div style={{
          background: '#fef3c7', borderBottom: '1px solid #fbbf24', padding: '8px 16px',
          fontSize: '0.8125rem', color: '#92400e', textAlign: 'center',
          maxWidth: 832, margin: '0 auto', width: '100%',
        }}>
          Click on the document to place a {activeTool} field for {selectedSigner?.name || selectedSigner?.email}
        </div>
      )}

      {selectedFieldIds.size >= 1 && (
        <div className="align-toolbar" style={{
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
          background: '#f0fdf4', borderBottom: '1px solid #bbf7d0',
          padding: '8px 12px', maxWidth: 832, margin: '0 auto', width: '100%',
        }}>
          <span style={{ fontSize: '0.75rem', color: '#166534', fontWeight: 600, marginRight: 4 }}>
            {selectedFieldIds.size} selected
          </span>
          <AlignBtn title="Duplicate selection (⌘D)" onClick={handleDuplicateSelection}>⧉ Duplicate</AlignBtn>
          <AlignBtn
            title="Undo (⌘Z)"
            onClick={handleUndo}
            disabled={undoBusy || historyRef.current.length === 0}
          >↶ Undo</AlignBtn>
          <AlignBtn title="Delete selection (Del)" onClick={handleDeleteSelection} danger>✕ Delete</AlignBtn>
          {selectedFieldIds.size >= 2 && (
            <>
              <span style={{ borderLeft: '1px solid #bbf7d0', height: 20, margin: '0 4px' }} />
              <AlignBtn title="Center on vertical axis (align X)" onClick={() => applyAlignment('center-x')}>↔ Center X</AlignBtn>
              <AlignBtn title="Center on horizontal axis (align Y)" onClick={() => applyAlignment('center-y')}>↕ Center Y</AlignBtn>
              <AlignBtn
                title="Distribute Horizontally (needs 3+)"
                onClick={() => applyAlignment('distribute-h')}
                disabled={selectedFieldIds.size < 3}
              >|⇔| Distribute H</AlignBtn>
              <AlignBtn
                title="Distribute Vertically (needs 3+)"
                onClick={() => applyAlignment('distribute-v')}
                disabled={selectedFieldIds.size < 3}
              >|⇕| Distribute V</AlignBtn>
            </>
          )}
          <button
            onClick={() => setSelectedFieldIds(new Set())}
            style={{
              marginLeft: 'auto', background: 'transparent', border: 'none',
              color: '#166534', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600,
            }}
          >
            Clear
          </button>
        </div>
      )}

      {/* Document Viewer */}
      <div className="document-viewer">
        <div className="document-container">
          <Suspense
            fallback={
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--gray-400)' }}>
                Loading PDF viewer...
              </div>
            }
          >
            <PDFViewer
              url={getSetupDocumentDirectUrl(id)}
              fallbackUrl={getSetupDocumentProxyUrl(id)}
              pageCount={doc.pageCount}
              onPageClick={activeTool ? handlePdfClick : undefined}
              renderOverlay={(pageIndex) => (
                <>
                  {!activeTool && (
                    <div
                      className="marquee-catcher"
                      onMouseDown={(e) => handleMarqueeStart(e, pageIndex)}
                      style={{
                        position: 'absolute',
                        inset: 0,
                        pointerEvents: 'auto',
                        cursor: 'default',
                      }}
                    />
                  )}
                  {marquee && marquee.pageIndex === pageIndex && (
                    <div
                      style={{
                        position: 'absolute',
                        left: `${marquee.minX * 100}%`,
                        top: `${marquee.minY * 100}%`,
                        width: `${(marquee.maxX - marquee.minX) * 100}%`,
                        height: `${(marquee.maxY - marquee.minY) * 100}%`,
                        border: '1px dashed #166534',
                        background: 'rgba(22, 163, 74, 0.08)',
                        pointerEvents: 'none',
                        zIndex: 5,
                      }}
                    />
                  )}
                  {fields
                    .filter((f) => f.page === pageIndex + 1)
                    .map((f) => {
                      const color = getSignerColor(f.signerId);
                      const signer = signers.find(s => s.id === f.signerId);
                      return (
                        <div
                          key={f.id}
                          data-field-id={f.id}
                          className={`placed-item completed${selectedFieldIds.has(f.id) ? ' selected' : ''}`}
                          style={{
                            left: `${f.x * 100}%`,
                            top: `${f.y * 100}%`,
                            width: `${f.width * 100}%`,
                            height: `${f.height * 100}%`,
                            borderColor: color,
                            background: `${color}0D`,
                            cursor: 'grab',
                            outline: selectedFieldIds.has(f.id) ? `2px solid ${color}` : undefined,
                            outlineOffset: selectedFieldIds.has(f.id) ? 1 : undefined,
                          }}
                          onMouseDown={(e) => handleDragStart(e, f.id)}
                          onTouchStart={(e) => handleDragStart(e, f.id)}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelectField(f.id, e.shiftKey || e.metaKey || e.ctrlKey);
                          }}
                        >
                          {f.type === 'option' ? (
                            <span style={{
                              fontSize: '16px', color, fontWeight: 700,
                              lineHeight: 1, display: 'inline-block',
                            }}>○</span>
                          ) : f.type === 'checkbox' ? (
                            <span style={{
                              fontSize: '16px', color, fontWeight: 700,
                              lineHeight: 1, display: 'inline-block',
                            }}>☐</span>
                          ) : (
                            <span style={{
                              fontSize: '9px',
                              color,
                              fontWeight: 600,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              maxWidth: '100%',
                              padding: '0 2px',
                            }}>
                              {fieldTypeLabel(f.type)} — {signer?.name || signer?.email || ''}
                            </span>
                          )}
                          <button
                            className="remove-item-btn"
                            onClick={(e) => { e.stopPropagation(); handleRemoveField(f.id); }}
                            title="Remove"
                          >
                            &times;
                          </button>
                        </div>
                      );
                    })}
                </>
              )}
              onError={() => {}}
            />
          </Suspense>
        </div>
      </div>

      {/* Send/Done Banner */}
      <div className="send-banner">
        <div style={{ fontSize: '0.8125rem', color: 'var(--gray-500)' }}>
          {isTemplateMode
            ? `${fields.length} field${fields.length !== 1 ? 's' : ''} placed (template mode)`
            : `${realSigners.length} signer${realSigners.length !== 1 ? 's' : ''} · ${fields.length} field${fields.length !== 1 ? 's' : ''} placed`}
        </div>
        {!isTemplateMode ? (
          <button
            className="btn btn-primary"
            onClick={handleSend}
            disabled={sending || fields.length === 0}
            style={{ padding: '10px 24px' }}
          >
            {sending ? 'Sending...' : 'Send for Signing'}
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={handleDone}
            disabled={sending || fields.length === 0}
            style={{ padding: '10px 24px' }}
          >
            {sending ? 'Saving...' : 'Done'}
          </button>
        )}
      </div>

      {/* Add Signer Modal */}
      {showAddSigner && (
        <div className="modal-overlay" onClick={() => setShowAddSigner(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Add Signer</h2>
              <button className="modal-close" onClick={() => setShowAddSigner(false)}>&times;</button>
            </div>
            <input
              type="email"
              value={newSignerEmail}
              onChange={(e) => setNewSignerEmail(e.target.value)}
              placeholder="Email address"
              autoFocus
              style={{
                width: '100%', padding: 12,
                border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)',
                marginBottom: 8, fontSize: '1rem',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newSignerEmail.trim()) handleAddSigner();
              }}
            />
            <input
              type="text"
              value={newSignerName}
              onChange={(e) => setNewSignerName(e.target.value)}
              placeholder="Name (optional)"
              style={{
                width: '100%', padding: 12,
                border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)',
                marginBottom: 12, fontSize: '1rem',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newSignerEmail.trim()) handleAddSigner();
              }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowAddSigner(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary" style={{ flex: 1 }}
                disabled={!newSignerEmail.trim()}
                onClick={handleAddSigner}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SigningModeCard({
  active, onClick, title, subtitle, bestFor, fields, limitation,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  bestFor: string;
  fields: string;
  limitation: string | null;
}) {
  const [hover, setHover] = useState(false);
  const expanded = hover;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      role="button"
      tabIndex={0}
      style={{
        cursor: active ? 'default' : 'pointer',
        border: `1px solid ${active ? '#2c4a35' : 'var(--gray-200)'}`,
        background: active ? '#f0fdf4' : 'white',
        borderRadius: 8,
        padding: '8px 12px',
        transition: 'border-color 120ms, background 120ms',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
            border: `2px solid ${active ? '#2c4a35' : 'var(--gray-400)'}`,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          {active && (
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#2c4a35' }} />
          )}
        </span>
        <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--ink)' }}>{title}</div>
        <span style={{
          fontSize: '0.72rem', color: 'var(--gray-500)', marginLeft: 'auto',
          opacity: expanded ? 0 : 1, transition: 'opacity 120ms',
        }}>
          hover for details
        </span>
      </div>
      <div style={{
        overflow: 'hidden',
        maxHeight: expanded ? 240 : 0,
        transition: 'max-height 200ms ease',
      }}>
        <div style={{ fontSize: '0.8rem', color: 'var(--gray-700)', marginTop: 8, marginBottom: 6, lineHeight: 1.4 }}>
          {subtitle}
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--gray-500)', lineHeight: 1.5, marginBottom: 4 }}>
          <strong style={{ color: 'var(--gray-700)' }}>Good for:</strong> {bestFor}
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--gray-500)', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--gray-700)' }}>Available fields:</strong> {fields}
        </div>
        {limitation && (
          <div style={{
            fontSize: '0.7rem', color: '#92400e', marginTop: 6, lineHeight: 1.4,
            padding: '5px 8px', background: '#fef3c7', border: '1px solid #fbbf24', borderRadius: 6,
          }}>
            {limitation}
          </div>
        )}
      </div>
    </div>
  );
}

function AlignBtn({
  children, title, onClick, disabled, danger,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const borderColor = danger ? '#fecaca' : '#bbf7d0';
  const textColor = disabled ? 'var(--gray-400)' : (danger ? '#b03826' : '#166534');
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        minWidth: 30,
        height: 28,
        padding: '0 6px',
        background: disabled ? '#f3f4f6' : 'white',
        border: `1px solid ${borderColor}`,
        borderRadius: 6,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: '0.85rem',
        color: textColor,
        fontWeight: 700,
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </button>
  );
}
