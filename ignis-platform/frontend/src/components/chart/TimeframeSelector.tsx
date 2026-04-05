'use client';

import React, { useMemo } from 'react';

/**
 * TimeframeSelector.tsx
 * - Sélecteur TF “trader friendly” (chips) + presets + options
 * - Support mono-sélection (analysis) et multi-sélection (scanner)
 * - Dark glass UI (tailwind)
 */

export type Timeframe = 'M1'|'M5'|'M15'|'M30'|'H1'|'H2'|'H4'|'H8'|'D1'|'W1'|'MN1';

type Mode = 'single' | 'multi';

const ALL_TF: Timeframe[] = ['M1','M5','M15','M30','H1','H2','H4','H8','D1','W1','MN1'];

type PresetKey = 'scalp' | 'intraday' | 'swing' | 'position' | 'all' | 'none';

const PRESETS: Record<PresetKey, Timeframe[]> = {
  scalp: ['M1','M5','M15'],
  intraday: ['M15','M30','H1','H2'],
  swing: ['H1','H2','H4','H8','D1'],
  position: ['H4','H8','D1','W1','MN1'],
  all: [...ALL_TF],
  none: [],
};

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function tfRank(tf: Timeframe) {
  return ALL_TF.indexOf(tf);
}

function uniqSorted(tfs: Timeframe[]) {
  return Array.from(new Set(tfs)).sort((a, b) => tfRank(a) - tfRank(b));
}

export default function TimeframeSelector(props:
  | {
      mode?: 'single';
      value: Timeframe;
      onChange: (tf: Timeframe) => void;

      allowed?: Timeframe[];
      disabled?: boolean;

      showPresets?: boolean;
      showDropdown?: boolean;

      className?: string;
      label?: string;
      hint?: string;
      dense?: boolean;
    }
  | {
      mode: 'multi';
      value: Timeframe[];
      onChange: (tfs: Timeframe[]) => void;

      allowed?: Timeframe[];
      disabled?: boolean;

      showPresets?: boolean;
      showDropdown?: boolean;

      className?: string;
      label?: string;
      hint?: string;
      dense?: boolean;
    }
) {
  const mode: Mode = (props as any).mode ?? 'single';

  const allowed = useMemo(() => {
    const a = (props as any).allowed as Timeframe[] | undefined;
    return (a && a.length ? a : ALL_TF).slice();
  }, [props]);

  const dense = !!(props as any).dense;

  const label = (props as any).label as string | undefined;
  const hint = (props as any).hint as string | undefined;

  const disabled = !!(props as any).disabled;
  const showPresets = (props as any).showPresets ?? true;
  const showDropdown = (props as any).showDropdown ?? false;

  const valueSingle = mode === 'single' ? (props as any).value as Timeframe : undefined;
  const valueMulti = mode === 'multi' ? (props as any).value as Timeframe[] : undefined;

  const selectedSet = useMemo(() => {
    if (mode === 'single') return new Set<Timeframe>(valueSingle ? [valueSingle] : []);
    return new Set<Timeframe>((valueMulti ?? []) as Timeframe[]);
  }, [mode, valueSingle, valueMulti]);

  const setPreset = (key: PresetKey) => {
    if (disabled) return;
    const tfs = PRESETS[key].filter((tf) => allowed.includes(tf));
    if (mode === 'single') {
      const next = tfs[0] ?? allowed[0] ?? 'H4';
      (props as any).onChange(next);
    } else {
      (props as any).onChange(uniqSorted(tfs));
    }
  };

  const toggle = (tf: Timeframe) => {
    if (disabled) return;

    if (mode === 'single') {
      (props as any).onChange(tf);
      return;
    }

    const curr = new Set(valueMulti ?? []);
    if (curr.has(tf)) curr.delete(tf);
    else curr.add(tf);

    (props as any).onChange(uniqSorted(Array.from(curr)));
  };

  const clear = () => {
    if (disabled) return;
    if (mode === 'single') {
      (props as any).onChange((allowed[0] ?? 'H4') as Timeframe);
    } else {
      (props as any).onChange([]);
    }
  };

  const selectAll = () => {
    if (disabled) return;
    if (mode === 'single') return;
    (props as any).onChange(uniqSorted(allowed));
  };

  const summary = useMemo(() => {
    if (mode === 'single') return valueSingle ?? '—';
    const n = (valueMulti ?? []).length;
    if (!n) return 'Aucun TF';
    return `${n} TF: ${(valueMulti ?? []).join(', ')}`;
  }, [mode, valueSingle, valueMulti]);

  return (
    <div className={cn('rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px]', dense ? 'p-3' : 'p-4', (props as any).className)}>
      {(label || hint) && (
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            {label && <div className="text-sm font-semibold text-white/90">{label}</div>}
            {hint && <div className="text-xs text-white/60 mt-1">{hint}</div>}
          </div>
          <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs text-white/70">
            {summary}
          </span>
        </div>
      )}

      {showPresets && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <PresetButton disabled={disabled} onClick={() => setPreset('scalp')}>Scalp</PresetButton>
          <PresetButton disabled={disabled} onClick={() => setPreset('intraday')}>Intraday</PresetButton>
          <PresetButton disabled={disabled} onClick={() => setPreset('swing')}>Swing</PresetButton>
          <PresetButton disabled={disabled} onClick={() => setPreset('position')}>Position</PresetButton>

          <span className="mx-1 text-white/20">·</span>

          <PresetButton disabled={disabled} onClick={() => setPreset('all')}>All</PresetButton>
          <PresetButton disabled={disabled} onClick={() => setPreset('none')}>None</PresetButton>

          <div className="ml-auto flex items-center gap-2">
            {mode === 'multi' && (
              <button
                disabled={disabled}
                onClick={selectAll}
                className={cn(
                  'rounded-xl border px-3 py-2 text-xs font-medium transition',
                  disabled ? 'border-white/10 bg-white/5 text-white/40' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15'
                )}
              >
                Select all
              </button>
            )}

            <button
              disabled={disabled}
              onClick={clear}
              className={cn(
                'rounded-xl border px-3 py-2 text-xs font-medium transition',
                disabled ? 'border-white/10 bg-white/5 text-white/40' : 'border-rose-500/20 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15'
              )}
            >
              Clear
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {allowed.map((tf) => {
          const on = selectedSet.has(tf);
          return (
            <button
              key={tf}
              disabled={disabled}
              onClick={() => toggle(tf)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                on
                  ? 'border-[#E85D1A]/30 bg-[#E85D1A]/10 text-white'
                  : 'border-white/10 bg-black/20 text-white/65 hover:bg-white/10 hover:text-white/85',
                disabled && 'opacity-60 cursor-not-allowed'
              )}
              title={mode === 'multi' ? 'Toggle timeframe' : 'Select timeframe'}
            >
              {tf}
            </button>
          );
        })}
      </div>

      {showDropdown && (
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
          <div>
            <div className="text-xs text-white/60 mb-1">Quick select</div>
            <select
              disabled={disabled}
              value={mode === 'single' ? valueSingle : ''}
              onChange={(e) => {
                if (disabled) return;
                const v = e.target.value as Timeframe;
                if (!v) return;
                if (mode === 'single') (props as any).onChange(v);
                else toggle(v);
              }}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40 disabled:opacity-60"
            >
              <option value="">—</option>
              {allowed.map((tf) => (
                <option key={tf} value={tf}>
                  {tf}
                </option>
              ))}
            </select>
          </div>

          {mode === 'multi' && (
            <div>
              <div className="text-xs text-white/60 mb-1">Selected</div>
              <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/80 min-h-[40px]">
                {(valueMulti ?? []).length ? (valueMulti ?? []).join(', ') : '—'}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Sub-components
────────────────────────────────────────────────────────────── */

function PresetButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-xl border px-3 py-2 text-xs font-medium transition',
        disabled
          ? 'border-white/10 bg-white/5 text-white/40'
          : 'border-white/10 bg-white/5 text-white/75 hover:bg-white/10 hover:text-white/90'
      )}
    >
      {children}
    </button>
  );
}