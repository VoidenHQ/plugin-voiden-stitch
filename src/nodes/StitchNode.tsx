/**
 * Stitch Block Node
 *
 * TipTap atom node for defining a stitch (batch run) configuration.
 * Uses bg-surface styling, OAuth2-style key-value option rows,
 * folder picker for include patterns.
 */

import { mergeAttributes, Node, NodeViewProps } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Plus, X, ChevronDown, ChevronRight, Folder, FolderOpen, Loader, History } from 'lucide-react';
import type { StitchConfig } from '../lib/types';
import { stitchStore } from '../lib/stitchStore';
import { runStitch, discoverFiles } from '../lib/stitchEngine';

// Lazy-loaded accessor for the current file path
let getFilePath: (() => string | null) | null = null;
async function getCurrentFilePath(): Promise<string> {
  if (!getFilePath) {
    try {
      // @ts-ignore - Vite dynamic import
      const mod = await import(/* @vite-ignore */ '@/core/editors/voiden/VoidenEditor') as any;
      getFilePath = () => mod.useVoidenEditorStore?.getState?.()?.filePath ?? null;
    } catch {
      getFilePath = () => null;
    }
  }
  return getFilePath() || '';
}

// --- OAuth2-style row classes (matching voiden-advanced-auth) ---
const rowClass = "flex hover:bg-muted/50 transition-colors";
const keyCellClass = "p-1 px-2 h-6 flex items-center text-sm font-mono text-comment whitespace-nowrap border-r border-border shrink-0";
const valueCellClass = "p-1 px-2 h-6 flex items-center text-sm font-mono text-text w-full min-w-0 justify-end";

export function createStitchNode(
  NodeViewWrapper: any,
  RequestBlockHeader: any,
  useActiveEnv: () => Record<string, string> | undefined,
  useEnvs: () => { data?: { activeEnv: string | null; data: Record<string, Record<string, string>>; displayNames: Record<string, string> } },
  openResultsTab: () => void,
) {
  const StitchNodeView = (props: NodeViewProps) => {
    const { node, updateAttributes, editor } = props;
    const isEditable = editor.isEditable;
    const activeEnv = useActiveEnv();
    const { data: envData } = useEnvs();

    // Parse attributes
    const include: string[] = useMemo(() => {
      try { return JSON.parse(node.attrs.include || '[]'); }
      catch { return []; }
    }, [node.attrs.include]);

    const exclude: string[] = useMemo(() => {
      try { return JSON.parse(node.attrs.exclude || '[]'); }
      catch { return []; }
    }, [node.attrs.exclude]);

    const stopOnFailure = node.attrs.stopOnFailure === true || node.attrs.stopOnFailure === 'true';
    const isolateFiles = node.attrs.isolateFiles === true || node.attrs.isolateFiles === 'true';
    const delayBetweenFiles = parseInt(node.attrs.delayBetweenFiles || '0', 10) || 0;
    const environment = node.attrs.environment || '';
    const dataSource = node.attrs.dataSource || '';

    const fileOrder: string[] = useMemo(() => {
      try { return JSON.parse(node.attrs.fileOrder || '[]'); }
      catch { return []; }
    }, [node.attrs.fileOrder]);

    interface InlineVar { key: string; value: string; type?: 'string' | 'file' }
    interface InlineScenario { id: string; name: string; enabled: boolean; variables: InlineVar[] }
    const scenarios: InlineScenario[] = useMemo(() => {
      try { return JSON.parse(node.attrs.scenarios || '[]'); }
      catch { return []; }
    }, [node.attrs.scenarios]);

    const saveScenarios = useCallback((updated: InlineScenario[]) => {
      updateAttributes({ scenarios: JSON.stringify(updated) });
    }, [updateAttributes]);

    const addScenario = useCallback(() => {
      const id = Math.random().toString(36).slice(2);
      saveScenarios([...scenarios, { id, name: `Scenario ${scenarios.length + 1}`, enabled: true, variables: [] }]);
      setExpandedScenario(id);
    }, [scenarios, saveScenarios]);

    const removeScenario = useCallback((id: string) => {
      saveScenarios(scenarios.filter(s => s.id !== id));
    }, [scenarios, saveScenarios]);

    const updateScenario = useCallback((id: string, patch: Partial<InlineScenario>) => {
      saveScenarios(scenarios.map(s => s.id === id ? { ...s, ...patch } : s));
    }, [scenarios, saveScenarios]);

    const addVar = useCallback((scenarioId: string) => {
      saveScenarios(scenarios.map(s =>
        s.id === scenarioId ? { ...s, variables: [...s.variables, { key: '', value: '', type: 'string' as const }] } : s
      ));
    }, [scenarios, saveScenarios]);

    const updateVar = useCallback((scenarioId: string, idx: number, patch: Partial<InlineVar>) => {
      saveScenarios(scenarios.map(s =>
        s.id === scenarioId ? { ...s, variables: s.variables.map((v, i) => i === idx ? { ...v, ...patch } : v) } : s
      ));
    }, [scenarios, saveScenarios]);

    const removeVar = useCallback((scenarioId: string, idx: number) => {
      saveScenarios(scenarios.map(s =>
        s.id === scenarioId ? { ...s, variables: s.variables.filter((_, i) => i !== idx) } : s
      ));
    }, [scenarios, saveScenarios]);

    // File picker for scenario variable values of type "file"
    // Stores project-relative path so the config is portable across machines.
    const handlePickVarFile = useCallback(async (scenarioId: string, vi: number) => {
      try {
        const projects = await (window as any).electron?.state?.getProjects?.();
        const projectPath = projects?.activeProject;

        const [selectedPath] = (await (window as any).electron?.dialog?.openFile?.({
          defaultPath: projectPath,
          properties: ['openFile'],
        })) ?? [];
        if (!selectedPath) return;

        const normalizedSelected = selectedPath.replace(/\\/g, '/');
        const normalizedProject = (projectPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
        let relativePath = normalizedSelected;
        if (normalizedProject && normalizedSelected.startsWith(normalizedProject + '/')) {
          relativePath = normalizedSelected.slice(normalizedProject.length + 1);
        }

        updateVar(scenarioId, vi, { value: relativePath });
      } catch (err) {
        console.error('[voiden-stitch] File picker failed:', err);
      }
    }, [updateVar]);

    // Local state
    const [matchedCount, setMatchedCount] = useState<number | null>(null);
    const [matchedFiles, setMatchedFiles] = useState<string[]>([]);
    const [showFiles, setShowFiles] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [expandedScenario, setExpandedScenario] = useState<string | null>(null);
    const runningRef = useRef(false); // track if THIS block started the run
    const abortRef = useRef<AbortController | null>(null);
    const [refreshTick, setRefreshTick] = useState(0);
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

    // Re-discover when files are added/removed in the project
    useEffect(() => {
      const unsub = (window as any).electron?.files?.onReferencesUpdated?.(() => {
        setRefreshTick(t => t + 1);
      });
      return () => unsub?.();
    }, []);

    // Discover matched files when patterns change or project files change
    useEffect(() => {
      let cancelled = false;
      const config: StitchConfig = { include, exclude, stopOnFailure, delayBetweenFiles, isolateFiles, environment, dataSource: '', scenarios: '', fileOrder };

      getCurrentFilePath().then((currentFilePath) => {
        return discoverFiles(config, currentFilePath);
      }).then((result) => {
        if (!cancelled) {
          setMatchedCount(result.count);
          setMatchedFiles(result.files);
        }
      });

      return () => { cancelled = true; };
    }, [include, exclude, fileOrder, editor, refreshTick]);

    // File order management — custom mouse-event drag (bypasses TipTap/ProseMirror DnD interception)
    const dragStateRef = useRef<{ from: number; over: number } | null>(null);
    const fileOrderRef = useRef<string[]>(fileOrder);
    const matchedFilesRef = useRef<string[]>(matchedFiles);
    const updateAttributesRef = useRef(updateAttributes);
    useEffect(() => { fileOrderRef.current = fileOrder; }, [fileOrder]);
    useEffect(() => { matchedFilesRef.current = matchedFiles; }, [matchedFiles]);
    useEffect(() => { updateAttributesRef.current = updateAttributes; }, [updateAttributes]);

    // Document-level mouseup finalises the drag
    useEffect(() => {
      const onMouseUp = () => {
        if (dragStateRef.current === null) return;
        const { from, over } = dragStateRef.current;
        dragStateRef.current = null;
        setDragIndex(null);
        setDragOverIndex(null);
        if (from === over) return;
        const base = fileOrderRef.current.length > 0 ? [...fileOrderRef.current] : [...matchedFilesRef.current];
        const [moved] = base.splice(from, 1);
        base.splice(over, 0, moved);
        updateAttributesRef.current({ fileOrder: JSON.stringify(base) });
      };
      document.addEventListener('mouseup', onMouseUp);
      return () => document.removeEventListener('mouseup', onMouseUp);
    }, []);

    const startFileDrag = useCallback((e: React.MouseEvent, i: number) => {
      e.preventDefault();
      e.stopPropagation();
      dragStateRef.current = { from: i, over: i };
      setDragIndex(i);
      setDragOverIndex(i);
    }, []);

    const enterFileRow = useCallback((i: number) => {
      if (dragStateRef.current === null) return;
      dragStateRef.current.over = i;
      setDragOverIndex(i);
    }, []);

    const resetFileOrder = useCallback(() => {
      updateAttributes({ fileOrder: '[]' });
    }, [updateAttributes]);

    // Pattern management
    const addPattern = useCallback((type: 'include' | 'exclude') => {
      const current = type === 'include' ? include : exclude;
      const updated = [...current, ''];
      updateAttributes({ [type]: JSON.stringify(updated) });
    }, [include, exclude, updateAttributes]);

    const updatePattern = useCallback((type: 'include' | 'exclude', index: number, value: string) => {
      const current = type === 'include' ? [...include] : [...exclude];
      current[index] = value;
      updateAttributes({ [type]: JSON.stringify(current) });
    }, [include, exclude, updateAttributes]);

    const removePattern = useCallback((type: 'include' | 'exclude', index: number) => {
      const current = type === 'include' ? [...include] : [...exclude];
      current.splice(index, 1);
      updateAttributes({ [type]: JSON.stringify(current) });
    }, [include, exclude, updateAttributes]);

    // Data source file picker — stores path relative to active project root
    const handlePickDataSource = useCallback(async () => {
      try {
        const projects = await (window as any).electron?.state?.getProjects?.();
        const projectPath = projects?.activeProject;

        const [selectedPath] = (await (window as any).electron?.dialog?.openFile?.({
          defaultPath: projectPath,
          filters: [{ name: 'Scenario Files', extensions: ['csv', 'json', 'yaml', 'yml'] }],
          properties: ['openFile'],
        })) ?? [];

        if (!selectedPath) return;

        // Convert absolute → project-relative (with forward slashes)
        const normalizedSelected = selectedPath.replace(/\\/g, '/');
        const normalizedProject = (projectPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
        let relativePath = normalizedSelected;
        if (normalizedProject && normalizedSelected.startsWith(normalizedProject + '/')) {
          relativePath = normalizedSelected.slice(normalizedProject.length + 1);
        }
        updateAttributes({ dataSource: relativePath });
      } catch (err) {
        console.error('[voiden-stitch] Data source picker failed:', err);
      }
    }, [updateAttributes]);

    // Folder picker — opens native dialog, converts to relative glob
    const handlePickFolder = useCallback(async () => {
      try {
        const projects = await (window as any).electron?.state?.getProjects?.();
        const projectPath = projects?.activeProject;
        if (!projectPath) return;

        const [selectedPath] = (await (window as any).electron?.dialog?.openFile?.({
          defaultPath: projectPath,
          properties: ['openDirectory'],
        })) ?? [];

        if (!selectedPath) return;

        // Convert absolute path to project-relative glob (normalize separators for Windows)
        const normalizedSelected = selectedPath.replace(/\\/g, '/');
        const normalizedProject = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
        let relativePath = normalizedSelected;
        if (normalizedProject && normalizedSelected.startsWith(normalizedProject + '/')) {
          relativePath = normalizedSelected.slice(normalizedProject.length + 1);
        }
        // Add /**/*.void to include all void files recursively
        const pattern = relativePath ? `${relativePath}/**/*.void` : '**/*.void';

        const updated = [...include, pattern];
        updateAttributes({ include: JSON.stringify(updated) });
      } catch (err) {
        console.error('[voiden-stitch] Folder picker failed:', err);
      }
    }, [include, updateAttributes]);

    // Run stitch
    const handleRun = useCallback(async () => {
      if (runningRef.current) return;

      const config: StitchConfig = { include, exclude, stopOnFailure, delayBetweenFiles, isolateFiles, environment, dataSource, scenarios: JSON.stringify(scenarios), fileOrder };
      const currentFilePath = await getCurrentFilePath();

      abortRef.current = new AbortController();
      runningRef.current = true;
      setIsRunning(true);

      try {
        await runStitch(config, currentFilePath, {
          activeEnv,
          allEnvs: envData ? { data: envData.data } : undefined,
          openResultsTab,
          tabId: editor.storage.tabId,
        }, abortRef.current.signal);
      } catch (err) {
        console.error('[voiden-stitch] Run failed:', err);
      } finally {
        runningRef.current = false;
        setIsRunning(false);
        abortRef.current = null;
      }
    }, [include, exclude, stopOnFailure, delayBetweenFiles, isolateFiles, environment, fileOrder, editor, activeEnv, envData, scenarios]);

    const handleCancel = useCallback(() => {
      if (!runningRef.current) return;
      abortRef.current?.abort();
    }, []);

    // Cmd+Enter to run when focus is inside the stitch block (e.g. in an input)
    const wrapperRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        // Only handle if focus is inside this stitch block's DOM
        if (!wrapperRef.current?.contains(document.activeElement)) return;

        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          if (!isRunning) handleRun();
        }
        if (e.key === 'Escape' && isRunning) {
          e.preventDefault();
          handleCancel();
        }
      };
      document.addEventListener('keydown', handleKeyDown, true);
      return () => document.removeEventListener('keydown', handleKeyDown, true);
    }, [isRunning, handleRun, handleCancel]);

    return (
      <NodeViewWrapper>
        <div
          ref={wrapperRef}
          className="my-2 border border-border rounded-lg overflow-hidden bg-surface"
          contentEditable={false}
          onMouseDown={(e) => {
            // Prevent TipTap from stealing focus / moving cursor when clicking inside the stitch block
            // but allow inputs/selects/buttons to receive focus normally
            const tag = (e.target as HTMLElement).tagName;
            if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'BUTTON') {
              e.preventDefault();
            }
          }}
        >
          <RequestBlockHeader title="STITCH RUNNER" withBorder={false} editor={editor} />

          <div className="p-4 space-y-4">
            {/* Include patterns — with folder picker button */}
            <PatternSection
              label="Include"
              icon={<Folder size={12} className="text-comment" />}
              patterns={include}
              placeholder="e.g. api/**/*.void"
              emptyText="All .void files in project"
              isEditable={isEditable}
              onAdd={() => addPattern('include')}
              onUpdate={(i, v) => updatePattern('include', i, v)}
              onRemove={(i) => removePattern('include', i)}
              onPickFolder={handlePickFolder}
            />

            {/* Exclude patterns */}
            <PatternSection
              label="Exclude"
              icon={<X size={12} className="text-comment" />}
              patterns={exclude}
              placeholder="e.g. **/draft-*.void"
              emptyText="No exclusions"
              isEditable={isEditable}
              onAdd={() => addPattern('exclude')}
              onUpdate={(i, v) => updatePattern('exclude', i, v)}
              onRemove={(i) => removePattern('exclude', i)}
            />

            {/* Options — OAuth2-style key-value table */}
            <div className="border border-border rounded-md overflow-hidden">
              <div className={rowClass}>
                <div className={keyCellClass} style={{ width: 160 }}>Environment</div>
                <div className={valueCellClass}>
                  <select
                    value={environment}
                    onChange={(e) => updateAttributes({ environment: e.target.value })}
                    disabled={!isEditable}
                    className={`w-full bg-transparent text-sm font-mono text-text outline-none cursor-pointer${!isEditable ? ' opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <option value="">Active environment</option>
                    {envData && Object.keys(envData.data).map((envKey) => (
                      <option key={envKey} value={envKey}>
                        {envData.displayNames[envKey] || envKey.split('/').pop()?.replace(/\.env$/, '') || envKey}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className={rowClass}>
                <div className={keyCellClass} style={{ width: 160 }}>Data source</div>
                <div className={valueCellClass} style={{ gap: 4 }}>
                  {dataSource ? (
                    <>
                      <span
                        className="text-xs font-mono truncate text-text flex-1 min-w-0"
                        title={dataSource}
                        style={{ maxWidth: 180 }}
                      >
                        {dataSource.replace(/\\/g, '/').split('/').pop() || dataSource}
                      </span>
                      {isEditable && (
                        <button
                          onClick={() => updateAttributes({ dataSource: '' })}
                          className="text-comment hover:text-red-400 transition-colors p-0.5 rounded flex-shrink-0"
                          title="Clear data source"
                          style={{ cursor: 'pointer' }}
                        >
                          <X size={10} />
                        </button>
                      )}
                    </>
                  ) : (
                    isEditable ? (
                      <button
                        onClick={handlePickDataSource}
                        className="text-comment hover:text-accent transition-colors text-xs font-mono"
                        style={{ cursor: 'pointer' }}
                      >
                        Browse (.csv / .json / .yaml)
                      </button>
                    ) : (
                      <span className="text-comment text-xs font-mono italic">None</span>
                    )
                  )}
                </div>
              </div>
              <div className={rowClass}>
                <div className={keyCellClass} style={{ width: 160 }}>Stop on failure</div>
                <div className={valueCellClass}>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={stopOnFailure}
                      onChange={(e) => updateAttributes({ stopOnFailure: e.target.checked })}
                      disabled={!isEditable}
                      className="rounded border-stone-700/50"
                    />
                    <span className="text-sm font-mono text-text">{stopOnFailure ? 'enabled' : 'disabled'}</span>
                  </label>
                </div>
              </div>
              <div className={rowClass}>
                <div className={keyCellClass} style={{ width: 160 }}>Isolate variables</div>
                <div className={valueCellClass}>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={isolateFiles}
                      onChange={(e) => updateAttributes({ isolateFiles: e.target.checked })}
                      disabled={!isEditable}
                      className="rounded border-stone-700/50"
                    />
                    <span className="text-sm font-mono text-text">{isolateFiles ? 'enabled' : 'disabled'}</span>
                  </label>
                </div>
              </div>
              <div className={rowClass}>
                <div className={keyCellClass} style={{ width: 160 }}>Delay between files</div>
                <div className={valueCellClass}>
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={delayBetweenFiles}
                    onChange={(e) => updateAttributes({ delayBetweenFiles: parseInt(e.target.value) || 0 })}
                    disabled={!isEditable}
                    className={`w-16 bg-transparent text-sm font-mono text-text outline-none text-right${!isEditable ? ' opacity-50 cursor-not-allowed' : ''}`}
                  />
                  <span className="text-sm font-mono text-comment ml-1">ms</span>
                </div>
              </div>
            </div>

            {/* Inline scenarios */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-comment font-semibold uppercase tracking-wide">Scenarios</span>
                  {scenarios.length > 0 && (
                    <span
                      className="text-[9px] font-mono px-1 rounded-sm"
                      style={{ background: 'var(--color-accent, #6366f1)22', color: 'var(--color-accent, #6366f1)' }}
                    >
                      {scenarios.filter(s => s.enabled).length}/{scenarios.length}
                    </span>
                  )}
                </div>
                {isEditable && (
                  <button
                    onClick={addScenario}
                    className="text-comment hover:text-accent transition-colors p-0.5 rounded flex items-center gap-1 text-[10px]"
                    title="Add scenario"
                    style={{ cursor: 'pointer' }}
                  >
                    <Plus size={11} />
                    Add
                  </button>
                )}
              </div>

              {scenarios.length === 0 ? (
                <div className="text-[10px] text-comment italic px-1">
                  No scenarios — use the data source above or add rows manually
                </div>
              ) : (
                <div className="border border-border rounded-md overflow-hidden divide-y divide-border">
                  {scenarios.map((scenario, sIdx) => {
                    const isExpanded = expandedScenario === scenario.id;
                    const keySummary = scenario.variables
                      .filter(v => v.key)
                      .map(v => v.key)
                      .slice(0, 4)
                      .join(', ');
                    const extraVars = scenario.variables.filter(v => v.key).length - 4;

                    return (
                      <div key={scenario.id} className={scenario.enabled ? '' : 'opacity-50'}>
                        {/* Scenario header */}
                        <div
                          className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted/30 transition-colors"
                          style={{ minHeight: 28 }}
                        >
                          {/* Expand/collapse toggle */}
                          <button
                            onClick={() => setExpandedScenario(isExpanded ? null : scenario.id)}
                            className="text-comment hover:text-text transition-colors flex-shrink-0 flex items-center"
                            style={{ cursor: 'pointer' }}
                          >
                            {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                          </button>

                          {/* Enabled dot — click to toggle */}
                          {isEditable ? (
                            <button
                              onClick={() => updateScenario(scenario.id, { enabled: !scenario.enabled })}
                              className="flex-shrink-0 transition-colors"
                              title={scenario.enabled ? 'Disable scenario' : 'Enable scenario'}
                              style={{ cursor: 'pointer', lineHeight: 0 }}
                            >
                              <svg width="8" height="8" viewBox="0 0 8 8">
                                <circle
                                  cx="4" cy="4" r="3.5"
                                  fill={scenario.enabled ? 'var(--icon-success, #22c55e)' : 'transparent'}
                                  stroke={scenario.enabled ? 'var(--icon-success, #22c55e)' : 'currentColor'}
                                  strokeWidth="1"
                                  className="text-comment"
                                />
                              </svg>
                            </button>
                          ) : (
                            <svg width="8" height="8" viewBox="0 0 8 8" className="flex-shrink-0">
                              <circle
                                cx="4" cy="4" r="3.5"
                                fill={scenario.enabled ? 'var(--icon-success, #22c55e)' : 'transparent'}
                                stroke={scenario.enabled ? 'var(--icon-success, #22c55e)' : 'currentColor'}
                                strokeWidth="1"
                                className="text-comment"
                              />
                            </svg>
                          )}

                          {/* Scenario name */}
                          {isEditable ? (
                            <input
                              type="text"
                              value={scenario.name}
                              onChange={(e) => updateScenario(scenario.id, { name: e.target.value })}
                              placeholder={`Scenario ${sIdx + 1}`}
                              className="flex-1 bg-transparent text-xs font-mono text-text outline-none min-w-0"
                            />
                          ) : (
                            <span className="flex-1 text-xs font-mono text-text truncate min-w-0">{scenario.name}</span>
                          )}

                          {/* Variable key summary (collapsed only) */}
                          {!isExpanded && keySummary && (
                            <span
                              className="text-[10px] font-mono text-comment truncate flex-shrink-0"
                              style={{ maxWidth: 130 }}
                              title={scenario.variables.filter(v => v.key).map(v => `${v.key}: ${v.value}`).join('\n')}
                            >
                              {keySummary}{extraVars > 0 ? ` +${extraVars}` : ''}
                            </span>
                          )}

                          {/* Remove */}
                          {isEditable && (
                            <button
                              onClick={() => removeScenario(scenario.id)}
                              className="text-comment hover:text-red-400 transition-colors p-0.5 rounded flex-shrink-0"
                              style={{ cursor: 'pointer' }}
                            >
                              <X size={10} />
                            </button>
                          )}
                        </div>

                        {/* Expanded: variable table */}
                        {isExpanded && (
                          <div className="border border-border bg-editor">
                            {scenario.variables.length === 0 && !isEditable && (
                              <div className="px-3 py-2 text-[10px] text-comment italic">No variables</div>
                            )}
                            {scenario.variables.map((v, vi) => (
                              <div key={vi} className="flex border border-border hover:bg-muted/20 transition-colors group">
                                {/* Type toggle */}
                                {isEditable && (
                                  <button
                                    title={v.type === 'file' ? 'Switch to string' : 'Switch to file'}
                                    onClick={() => updateVar(scenario.id, vi, { type: v.type === 'file' ? 'string' : 'file', value: '' })}
                                    className="flex items-center justify-center px-1.5 border-r border-border text-comment hover:text-accent transition-colors flex-shrink-0"
                                    style={{ minHeight: 26, cursor: 'pointer' }}
                                  >
                                    {v.type === 'file' ? <Folder size={9} /> : <span className="text-[9px] font-mono leading-none">T</span>}
                                  </button>
                                )}
                                {/* Key */}
                                <div className="flex items-center px-2 flex-shrink-0 border-r border-border" style={{ width: 130, minHeight: 26 }}>
                                  {isEditable ? (
                                    <input
                                      type="text"
                                      value={v.key}
                                      onChange={(e) => updateVar(scenario.id, vi, { key: e.target.value })}
                                      placeholder="key"
                                      className="w-full bg-transparent text-[11px] font-mono text-comment outline-none placeholder:text-comment/40"
                                    />
                                  ) : (
                                    <span className="text-[11px] font-mono text-comment truncate">{v.key || '—'}</span>
                                  )}
                                </div>
                                {/* Value */}
                                <div className="flex items-center px-2 flex-1 min-w-0" style={{ minHeight: 26 }}>
                                  {isEditable ? (
                                    <>
                                      <input
                                        type="text"
                                        value={v.value}
                                        onChange={(e) => updateVar(scenario.id, vi, { value: e.target.value })}
                                        placeholder={v.type === 'file' ? '/path/to/file' : 'value'}
                                        className="flex-1 bg-transparent text-[11px] font-mono text-text outline-none placeholder:text-comment/40 min-w-0"
                                      />
                                      {v.type === 'file' && (
                                        <button
                                          title="Browse file"
                                          onClick={() => handlePickVarFile(scenario.id, vi)}
                                          className="text-comment hover:text-accent transition-colors p-0.5 rounded flex-shrink-0 ml-1"
                                          style={{ cursor: 'pointer' }}
                                        >
                                          <FolderOpen size={9} />
                                        </button>
                                      )}
                                    </>
                                  ) : (
                                    <span className="text-[11px] font-mono text-text truncate flex-1">{v.value || '—'}</span>
                                  )}
                                  {isEditable && (
                                    <button
                                      onClick={() => removeVar(scenario.id, vi)}
                                      className="opacity-0 group-hover:opacity-100 text-comment hover:text-red-400 transition-all p-0.5 rounded flex-shrink-0 ml-1"
                                      style={{ cursor: 'pointer' }}
                                    >
                                      <X size={9} />
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}

                            {/* Add variable row */}
                            {isEditable && (
                              <button
                                onClick={() => addVar(scenario.id)}
                                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] text-comment hover:text-accent hover:bg-muted/20 transition-colors border border-border"
                                style={{ cursor: 'pointer' }}
                              >
                                <Plus size={9} />
                                Add variable
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer — file count + play button */}
            <div className="flex items-center justify-between">
              <button
                onClick={() => setShowFiles(!showFiles)}
                className="flex items-center gap-1.5 text-[11px] text-comment hover:text-text transition-colors"
                style={{ cursor: 'pointer' }}
              >
                <FileIcon />
                {matchedCount !== null
                  ? `${matchedCount} file${matchedCount !== 1 ? 's' : ''} matched`
                  : 'Scanning...'
                }
                {matchedCount !== null && matchedCount > 0 && (
                  showFiles ? <ChevronDown size={10} /> : <ChevronRight size={10} />
                )}
              </button>

              <button
                onMouseDown={(e) => {
                  // Prevent TipTap from moving cursor / triggering selection
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (isRunning) {
                    handleCancel();
                  } else {
                    handleRun();
                  }
                }}
                disabled={!isRunning && (!matchedCount || matchedCount === 0)}
                className="p-1.5 rounded hover:bg-active transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                title={isRunning ? 'Cancel (Esc)' : 'Run Stitch (⌘↵)'}
                style={{
                  cursor: (!isRunning && (!matchedCount || matchedCount === 0)) ? 'not-allowed' : 'pointer',
                  color: isRunning ? undefined : 'var(--icon-success)',
                }}
              >
                {isRunning ? <Loader className="animate-spin" size={16} /> : <Play size={16} />}
              </button>
            </div>

            {/* Matched files preview with drag-to-reorder */}
            {showFiles && matchedFiles.length > 0 && (
              <div className="border border-border rounded-md bg-editor overflow-hidden">
                {isEditable && fileOrder.length > 0 && (
                  <div className="flex items-center justify-between px-2 py-1 border-b border-border">
                    <span className="text-[9px] text-comment uppercase tracking-wide">Custom order</span>
                    <button
                      onClick={resetFileOrder}
                      className="flex items-center gap-1 text-[9px] text-comment hover:text-red-400 transition-colors"
                      title="Reset to alphabetical order"
                      style={{ cursor: 'pointer' }}
                    >
                      <History size={8} />
                      Reset
                    </button>
                  </div>
                )}
                <div className="p-2 max-h-40 overflow-y-auto select-none">
                  {matchedFiles.map((f, i) => (
                    <div
                      key={f}
                      onMouseEnter={() => enterFileRow(i)}
                      className={`relative text-[10px] text-comment font-mono py-0.5 flex items-center gap-1 rounded transition-colors${dragIndex === i ? ' bg-active' : ''}`}
                    >
                      {/* Drop-target underline */}
                      {dragOverIndex === i && dragIndex !== null && dragIndex !== i && (
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-accent" />
                      )}
                      {isEditable && (
                        <div
                          onMouseDown={(e) => startFileDrag(e, i)}
                          style={{ cursor: dragIndex !== null ? 'grabbing' : 'grab', lineHeight: 0 }}
                        >
                          <GripHandle />
                        </div>
                      )}
                      <span className="text-[9px] text-comment/40 w-4 shrink-0 text-right">{i + 1}</span>
                      <FileIcon />
                      <span className="truncate">{f}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </NodeViewWrapper>
    );
  };

  /** Small file icon. */
  const FileIcon = () => (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" className="flex-shrink-0 opacity-50">
      <path d="M4 1h5.5L14 5.5V14a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 1v5h5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );

  /** Six-dot grip handle for drag-to-reorder. */
  const GripHandle = () => (
    <svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor" className="flex-shrink-0 opacity-30 group-hover:opacity-60 transition-opacity">
      <circle cx="2" cy="2" r="1" /><circle cx="6" cy="2" r="1" />
      <circle cx="2" cy="5" r="1" /><circle cx="6" cy="5" r="1" />
      <circle cx="2" cy="8" r="1" /><circle cx="6" cy="8" r="1" />
    </svg>
  );

  /** Pattern section with optional folder picker. */
  const PatternSection = ({
    label,
    icon,
    patterns,
    placeholder,
    emptyText,
    isEditable,
    onAdd,
    onUpdate,
    onRemove,
    onPickFolder,
  }: {
    label: string;
    icon: React.ReactNode;
    patterns: string[];
    placeholder: string;
    emptyText: string;
    isEditable: boolean;
    onAdd: () => void;
    onUpdate: (index: number, value: string) => void;
    onRemove: (index: number) => void;
    onPickFolder?: () => void;
  }) => (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          {icon}
          <span className="text-[11px] text-comment font-semibold uppercase tracking-wide">{label}</span>
        </div>
        {isEditable && (
          <div className="flex items-center gap-1">
            {onPickFolder && (
              <button
                onClick={onPickFolder}
                className="text-comment hover:text-accent transition-colors p-0.5 rounded"
                title="Browse for folder"
                style={{ cursor: 'pointer' }}
              >
                <FolderOpen size={12} />
              </button>
            )}
            <button
              onClick={onAdd}
              className="text-comment hover:text-accent transition-colors p-0.5 rounded"
              title={`Add ${label.toLowerCase()} pattern`}
              style={{ cursor: 'pointer' }}
            >
              <Plus size={12} />
            </button>
          </div>
        )}
      </div>
      {patterns.length === 0 ? (
        <div className="text-[10px] text-comment italic px-1">{emptyText}</div>
      ) : (
        <div className="space-y-1">
          {patterns.map((pattern, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="text"
                value={pattern}
                onChange={(e) => onUpdate(i, e.target.value)}
                placeholder={placeholder}
                disabled={!isEditable}
                className="flex-1 px-2 py-1 bg-editor border border-border rounded-md text-text text-[11px] font-mono focus:outline-none focus:border-accent placeholder:text-comment/40"
              />
              {isEditable && (
                <button
                  onClick={() => onRemove(i)}
                  className="text-comment hover:text-red-400 transition-colors p-0.5 rounded"
                  style={{ cursor: 'pointer' }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // TipTap Node definition
  return Node.create({
    name: 'stitch',
    group: 'block',
    content: '',
    atom: true,
    selectable: true,
    draggable: false,

    addAttributes() {
      return {
        include: {
          default: JSON.stringify(['**/*.void']),
          parseHTML: (el: HTMLElement) => el.getAttribute('data-include') || JSON.stringify(['**/*.void']),
          renderHTML: (attrs: any) => ({ 'data-include': attrs.include }),
        },
        exclude: {
          default: JSON.stringify([]),
          parseHTML: (el: HTMLElement) => el.getAttribute('data-exclude') || JSON.stringify([]),
          renderHTML: (attrs: any) => ({ 'data-exclude': attrs.exclude }),
        },
        stopOnFailure: {
          default: false,
          parseHTML: (el: HTMLElement) => el.getAttribute('data-stop-on-failure') === 'true',
          renderHTML: (attrs: any) => ({ 'data-stop-on-failure': String(attrs.stopOnFailure) }),
        },
        delayBetweenFiles: {
          default: 0,
          parseHTML: (el: HTMLElement) => parseInt(el.getAttribute('data-delay') || '0', 10),
          renderHTML: (attrs: any) => ({ 'data-delay': String(attrs.delayBetweenFiles) }),
        },
        isolateFiles: {
          default: false,
          parseHTML: (el: HTMLElement) => el.getAttribute('data-isolate-files') === 'true',
          renderHTML: (attrs: any) => ({ 'data-isolate-files': String(attrs.isolateFiles) }),
        },
        environment: {
          default: '',
          parseHTML: (el: HTMLElement) => el.getAttribute('data-environment') || '',
          renderHTML: (attrs: any) => ({ 'data-environment': attrs.environment }),
        },
        dataSource: {
          default: '',
          parseHTML: (el: HTMLElement) => el.getAttribute('data-data-source') || '',
          renderHTML: (attrs: any) => ({ 'data-data-source': attrs.dataSource }),
        },
        scenarios: {
          default: '[]',
          parseHTML: (el: HTMLElement) => el.getAttribute('data-scenarios') || '[]',
          renderHTML: (attrs: any) => ({ 'data-scenarios': attrs.scenarios }),
        },
        fileOrder: {
          default: '[]',
          parseHTML: (el: HTMLElement) => el.getAttribute('data-file-order') || '[]',
          renderHTML: (attrs: any) => ({ 'data-file-order': attrs.fileOrder }),
        },
      };
    },

    parseHTML() {
      return [{ tag: 'stitch' }];
    },

    renderHTML({ HTMLAttributes }) {
      return ['stitch', mergeAttributes(HTMLAttributes)];
    },

    addNodeView() {
      return ReactNodeViewRenderer(StitchNodeView);
    },
  });
}
