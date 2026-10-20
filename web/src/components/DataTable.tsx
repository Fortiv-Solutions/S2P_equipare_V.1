/**
 * DataTable — every list in the platform (FR-PLT-05): search, filters, sort, column choice,
 * saved views, bulk select, CSV export (opens in Excel), pagination, and card layout on phones.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronsUpDown, Columns3, Download, Search, Bookmark, X, Trash2 } from 'lucide-react';
import { Button, Empty, ErrorState, LoadingBlock } from './ui';
import { Modal } from './overlay';
import { Checkbox, Field, Input } from './forms';
import { api } from '@/lib/api';
import { useToast } from './overlay';

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  /** Raw value for sort, search and export. Defaults to row[key]. */
  value?: (row: T) => string | number | null | undefined;
  sortable?: boolean;
  align?: 'right';
  width?: number | string;
  /** Hidden by default (user can show it from the column chooser). */
  hidden?: boolean;
  exportable?: boolean;
  nowrap?: boolean;
}

export interface FilterDef<T> {
  key: string;
  label: string;
  value: (row: T) => string | null | undefined;
  options?: string[];
}

export interface MobileCard<T> {
  title: (row: T) => ReactNode;
  badge?: (row: T) => ReactNode;
  meta?: (row: T) => ReactNode[];
}

interface ViewState {
  search: string;
  filters: Record<string, string>;
  sort: { key: string; dir: 'asc' | 'desc' } | null;
  hidden: string[];
}

export interface DataTableProps<T> {
  id: string;
  rows: T[] | undefined;
  columns: Column<T>[];
  rowKey: (row: T) => string | number;
  rowLink?: (row: T) => string | undefined;
  onRowClick?: (row: T) => void;
  selectable?: boolean | ((row: T) => boolean);
  bulkActions?: (selected: T[], clear: () => void) => ReactNode;
  filters?: FilterDef<T>[];
  initialFilters?: Record<string, string>;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  searchable?: boolean;
  searchPlaceholder?: string;
  toolbar?: ReactNode;
  empty?: ReactNode;
  loading?: boolean;
  error?: unknown;
  refetch?: () => void;
  mobile?: MobileCard<T>;
  pageSize?: number;
  exportName?: string;
  dense?: boolean;
  savedViews?: boolean;
  frozen?: boolean;
  /** Called with filtered rows whenever they change — e.g. to drive summary totals. */
  onFiltered?: (rows: T[]) => void;
  rowTone?: (row: T) => 'selected' | undefined;
}

const getVal = <T,>(c: Column<T>, r: T) => (c.value ? c.value(r) : (r as any)[c.key]);

function readPrefs(id: string): string[] | null {
  try {
    const v = localStorage.getItem(`dt:${id}:hidden`);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}
function writePrefs(id: string, hidden: string[]) {
  try { localStorage.setItem(`dt:${id}:hidden`, JSON.stringify(hidden)); } catch { /* storage unavailable */ }
}

export function DataTable<T>(p: DataTableProps<T>) {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const defaultHidden = p.columns.filter((c) => c.hidden).map((c) => c.key);
  const [state, setState] = useState<ViewState>(() => ({
    search: '',
    filters: p.initialFilters ?? {},
    sort: p.initialSort ?? null,
    hidden: readPrefs(p.id) ?? defaultHidden,
  }));
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(p.pageSize ?? 25);
  const [selected, setSelected] = useState<Set<string | number>>(new Set());
  const [colsOpen, setColsOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState('');

  useEffect(() => { if (p.initialFilters) setState((s) => ({ ...s, filters: { ...s.filters, ...p.initialFilters } })); /* eslint-disable-next-line */ }, [JSON.stringify(p.initialFilters ?? {})]);
  useEffect(() => setPage(0), [state.search, JSON.stringify(state.filters), size]);

  const views = useQuery<{ id: number; name: string; state: ViewState }[]>({
    queryKey: ['views', p.id],
    queryFn: () => api.get('/views', { screen: p.id }),
    enabled: p.savedViews !== false,
    staleTime: 300_000,
  });

  const visibleCols = p.columns.filter((c) => !state.hidden.includes(c.key));

  const filterOptions = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const f of p.filters ?? []) {
      out[f.key] = f.options ?? [...new Set((p.rows ?? []).map((r) => f.value(r)).filter((v): v is string => !!v))].sort();
    }
    return out;
  }, [p.filters, p.rows]);

  const filtered = useMemo(() => {
    let rows = p.rows ?? [];
    const q = state.search.trim().toLowerCase();
    if (q) rows = rows.filter((r) => p.columns.some((c) => String(getVal(c, r) ?? '').toLowerCase().includes(q)));
    for (const f of p.filters ?? []) {
      const v = state.filters[f.key];
      if (v) rows = rows.filter((r) => f.value(r) === v);
    }
    if (state.sort) {
      const col = p.columns.find((c) => c.key === state.sort!.key);
      if (col) {
        const dir = state.sort.dir === 'asc' ? 1 : -1;
        rows = [...rows].sort((a, b) => {
          const x = getVal(col, a);
          const y = getVal(col, b);
          if (x == null && y == null) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en-IN', { numeric: true })) * dir;
        });
      }
    }
    return rows;
  }, [p.rows, p.columns, p.filters, state]);

  useEffect(() => { p.onFiltered?.(filtered); /* eslint-disable-next-line */ }, [filtered]);

  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const pageRows = filtered.slice(page * size, page * size + size);
  const canSelect = (r: T) => (typeof p.selectable === 'function' ? p.selectable(r) : !!p.selectable);
  const selectedRows = (p.rows ?? []).filter((r) => selected.has(p.rowKey(r)));
  const clear = () => setSelected(new Set());
  const allOnPage = pageRows.filter(canSelect);
  const allChecked = allOnPage.length > 0 && allOnPage.every((r) => selected.has(p.rowKey(r)));

  const toggleSort = (key: string) =>
    setState((s) => ({ ...s, sort: s.sort?.key === key ? (s.sort.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' } }));

  const exportCsv = () => {
    const cols = visibleCols.filter((c) => c.exportable !== false);
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const csv = [cols.map((c) => esc(c.header)).join(','), ...filtered.map((r) => cols.map((c) => esc(getVal(c, r))).join(','))].join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${p.exportName ?? p.id}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    api.post('/audit-export', { screen: p.id, rows: filtered.length }).catch(() => undefined);
    toast(`Exported ${filtered.length} rows`);
  };

  const saveView = async () => {
    await api.post('/views', { screen: p.id, name: viewName, state });
    setSaveOpen(false);
    setViewName('');
    qc.invalidateQueries({ queryKey: ['views', p.id] });
    toast('View saved');
  };

  const open = (r: T) => {
    if (p.onRowClick) return p.onRowClick(r);
    const link = p.rowLink?.(r);
    if (link) navigate(link);
  };
  const clickable = !!(p.onRowClick || p.rowLink);
  const activeFilters = Object.entries(state.filters).filter(([, v]) => v);

  return (
    <div>
      <div className="tbl-toolbar">
        {p.searchable !== false && (
          <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 300 }}>
            <Search size={16} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-3)' }} aria-hidden />
            <Input
              aria-label="Search this list" placeholder={p.searchPlaceholder ?? 'Search…'} value={state.search}
              onChange={(e) => setState((s) => ({ ...s, search: e.target.value }))} style={{ paddingLeft: 32, maxWidth: 'none' }}
            />
          </div>
        )}
        {(p.filters ?? []).map((f) => (
          <select
            key={f.key} className="select select--sm" style={{ width: 'auto', minWidth: 130 }} aria-label={f.label}
            value={state.filters[f.key] ?? ''} onChange={(e) => setState((s) => ({ ...s, filters: { ...s.filters, [f.key]: e.target.value } }))}
          >
            <option value="">{f.label}: all</option>
            {filterOptions[f.key]?.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ))}
        {activeFilters.length > 0 && (
          <Button size="sm" variant="ghost" icon={<X />} onClick={() => setState((s) => ({ ...s, filters: {} }))}>Clear filters</Button>
        )}
        <div className="grow" />
        {p.toolbar}
        {p.savedViews !== false && (
          <div className="row">
            <select
              className="select select--sm desktop-only" style={{ width: 'auto' }} aria-label="Saved views" value=""
              onChange={(e) => {
                const v = views.data?.find((x) => String(x.id) === e.target.value);
                if (v) setState({ ...v.state, hidden: v.state.hidden ?? state.hidden });
              }}
            >
              <option value="">Saved views{views.data?.length ? ` (${views.data.length})` : ''}</option>
              {views.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <Button size="sm" variant="ghost" iconOnly icon={<Bookmark />} onClick={() => setSaveOpen(true)} title="Save current view">Save view</Button>
          </div>
        )}
        <Button size="sm" variant="ghost" iconOnly icon={<Columns3 />} onClick={() => setColsOpen(true)} className="desktop-only" title="Choose columns">Choose columns</Button>
        <Button size="sm" variant="ghost" icon={<Download />} onClick={exportCsv} disabled={!filtered.length} title="Export to Excel (CSV)">Export</Button>
      </div>

      {p.bulkActions && selected.size > 0 && (
        <div className="tbl-bulk" role="region" aria-label="Bulk actions">
          <strong>{selected.size} selected</strong>
          {p.bulkActions(selectedRows, clear)}
          <Button size="sm" variant="ghost" onClick={clear} style={{ color: '#fff' }}>Clear</Button>
        </div>
      )}

      {p.loading ? (
        <LoadingBlock rows={6} />
      ) : p.error ? (
        <ErrorState error={p.error} retry={p.refetch} />
      ) : filtered.length === 0 ? (
        p.rows?.length ? (
          <Empty title="No rows match">Change the search or filters to see more.</Empty>
        ) : (
          p.empty ?? <Empty title="Nothing here yet" />
        )
      ) : (
        <>
          <div className="tbl-wrap" data-cards={p.mobile ? 'true' : 'false'}>
            <table className={`tbl${p.dense ? ' tbl--dense' : ''}${p.frozen ? ' tbl--frozen' : ''}`}>
              <thead>
                <tr>
                  {p.selectable && (
                    <th className="cell-check">
                      <input type="checkbox" aria-label="Select all on this page" checked={allChecked} onChange={() => {
                        const n = new Set(selected);
                        for (const r of allOnPage) allChecked ? n.delete(p.rowKey(r)) : n.add(p.rowKey(r));
                        setSelected(n);
                      }} />
                    </th>
                  )}
                  {visibleCols.map((c) => (
                    <th key={c.key} className={c.align === 'right' ? 'num' : undefined} style={{ width: c.width }} aria-sort={state.sort?.key === c.key ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                      {c.sortable === false ? c.header : (
                        <button onClick={() => toggleSort(c.key)}>
                          {c.header}
                          {state.sort?.key === c.key ? (state.sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ChevronsUpDown size={12} style={{ opacity: 0.35 }} />}
                        </button>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => {
                  const k = p.rowKey(r);
                  return (
                    <tr key={k} data-clickable={clickable} data-selected={selected.has(k)} onClick={(e) => {
                      if ((e.target as HTMLElement).closest('a,button,input,select,label')) return;
                      open(r);
                    }}>
                      {p.selectable && (
                        <td className="cell-check">
                          {canSelect(r) && (
                            <input type="checkbox" aria-label={`Select row ${k}`} checked={selected.has(k)} onChange={() => {
                              const n = new Set(selected);
                              n.has(k) ? n.delete(k) : n.add(k);
                              setSelected(n);
                            }} />
                          )}
                        </td>
                      )}
                      {visibleCols.map((c) => (
                        <td key={c.key} className={[c.align === 'right' ? 'num' : '', c.nowrap ? 'nowrap' : ''].join(' ')}>
                          {c.render ? c.render(r) : (getVal(c, r) ?? <span className="subtle">—</span>)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {p.mobile && (
            <div className="tbl-cards">
              {pageRows.map((r) => {
                const k = p.rowKey(r);
                const link = p.rowLink?.(r);
                return (
                  <div key={k} className="tbl-card" data-selected={selected.has(k)} role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}
                    onClick={(e) => { if ((e.target as HTMLElement).closest('a,button,input,label')) return; open(r); }}
                    onKeyDown={(e) => e.key === 'Enter' && open(r)} aria-label={link ? 'Open record' : undefined}>
                    <div className="tbl-card__top">
                      <div className="row" style={{ minWidth: 0 }}>
                        {p.selectable && canSelect(r) && (
                          <input type="checkbox" aria-label={`Select row ${k}`} checked={selected.has(k)} onChange={() => {
                            const n = new Set(selected);
                            n.has(k) ? n.delete(k) : n.add(k);
                            setSelected(n);
                          }} />
                        )}
                        <span className="tbl-card__title">{p.mobile!.title(r)}</span>
                      </div>
                      {p.mobile!.badge?.(r)}
                    </div>
                    {p.mobile!.meta && <div className="tbl-card__meta">{p.mobile!.meta(r).map((m, i) => <span key={i}>{m}</span>)}</div>}
                  </div>
                );
              })}
            </div>
          )}
          <div className="tbl-foot">
            <span>{filtered.length === (p.rows?.length ?? 0) ? `${filtered.length} rows` : `${filtered.length} of ${p.rows?.length ?? 0} rows`}</span>
            <div className="row">
              <select className="select select--sm" style={{ width: 'auto' }} aria-label="Rows per page" value={size} onChange={(e) => setSize(Number(e.target.value))}>
                {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
              </select>
              <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
              <span>Page {page + 1} of {pages}</span>
              <Button size="sm" variant="ghost" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          </div>
        </>
      )}

      <Modal open={colsOpen} onClose={() => setColsOpen(false)} title="Choose columns" footer={<><Button onClick={() => { setState((s) => ({ ...s, hidden: defaultHidden })); writePrefs(p.id, defaultHidden); }}>Reset</Button><Button variant="deep" onClick={() => setColsOpen(false)}>Done</Button></>}>
        <div className="grid-2">
          {p.columns.map((c) => (
            <Checkbox key={c.key} label={c.header} checked={!state.hidden.includes(c.key)} onChange={() => {
              const hidden = state.hidden.includes(c.key) ? state.hidden.filter((x) => x !== c.key) : [...state.hidden, c.key];
              setState((s) => ({ ...s, hidden }));
              writePrefs(p.id, hidden);
            }} />
          ))}
        </div>
      </Modal>

      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Save this view" sub="Saves search, filters, sort and columns for you on this screen." footer={<><Button onClick={() => setSaveOpen(false)}>Cancel</Button><Button variant="deep" onClick={saveView} disabled={!viewName.trim()}>Save view</Button></>}>
        <div className="stack">
          <Field label="View name" required><Input value={viewName} onChange={(e) => setViewName(e.target.value)} maxLength={60} data-autofocus /></Field>
          {!!views.data?.length && (
            <div className="stack-sm">
              <span className="small muted">Your saved views</span>
              {views.data.map((v) => (
                <div key={v.id} className="row between">
                  <span>{v.name}</span>
                  <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={async () => { await api.del(`/views/${v.id}`); qc.invalidateQueries({ queryKey: ['views', p.id] }); }}>Delete {v.name}</Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
