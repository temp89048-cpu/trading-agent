'use client';

// ---------------------------------------------------------------------
// Type-to-confirm before an emergency stop, per the reference's `#estop-modal`.
//
// This is one of the few controls here wired to a REAL mutation:
// `POST /api/admin/emergency-stop` exists on the backend and is verified. The
// reference's generic `confirmAction()` used `alert()` and a
// `// TODO: wire to real mutation endpoint`; this does not.
//
// WHY TYPE-TO-CONFIRM AND NOT JUST A CONFIRM DIALOG
//
// An emergency stop is the one control an operator reaches for under pressure,
// and it is also the one whose accidental press is most expensive. Requiring the
// word makes a misclick impossible without making a deliberate press slow.
//
// It fails LOUDLY. If the request fails the modal stays open and shows the
// error, because a stop that silently did not apply is the worst possible
// outcome — worse than an error message.
// ---------------------------------------------------------------------

import { useEffect, useState } from 'react';

import { BACKEND_PATHS, backendUrl } from '@/lib/backendConfig';
// The arming rule and the failure wording live in a `.ts` module so they can be
// asserted — vitest here cannot parse JSX. See lib/ui/emergencyStop.ts.
import { CONFIRM_WORD, isArmed, stopFailureMessage } from '@/lib/ui/emergencyStop';

export function EmergencyStopModal({
  open,
  onClose,
  onStopped,
}: {
  open: boolean;
  onClose: () => void;
  onStopped?: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on open, so a previous attempt's typed word or error never carries
  // into a new one — a pre-filled "STOP" would defeat the whole control.
  useEffect(() => {
    if (open) {
      setTyped('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const armed = isArmed(typed);

  async function submit() {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(backendUrl(BACKEND_PATHS.emergencyStop), { method: 'POST' });
      if (!res.ok) {
        // Stay open. A failed stop must not look like a successful one.
        setError(stopFailureMessage({ httpStatus: res.status }));
        setBusy(false);
        return;
      }
      onStopped?.();
      onClose();
    } catch (e) {
      setError(stopFailureMessage({ networkError: e instanceof Error ? e.message : undefined }));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop p-4">
      <div className="card w-[420px] max-w-full p-5">
        <div className="flex items-start gap-3 mb-3">
          <div
            className="w-7 h-7 rounded flex items-center justify-center text-[14px] shrink-0"
            style={{
              background: 'color-mix(in srgb, var(--negative) 16%, transparent)',
              color: 'var(--negative)',
            }}
            aria-hidden
          >
            !
          </div>
          <div>
            <div className="text-[14px] font-semibold">Emergency Stop</div>
            <div className="text-[12px] mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Halts new position opening across the whole system. Closing an existing
              position is deliberately never blocked, so exits remain available.
            </div>
          </div>
        </div>

        <label className="block text-[11px] mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          Type <span className="mono font-semibold" style={{ color: 'var(--negative)' }}>{CONFIRM_WORD}</span> to confirm
        </label>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          disabled={busy}
          className="mono w-full px-2.5 py-2 text-[13px] rounded"
          placeholder={CONFIRM_WORD}
          aria-label={`Type ${CONFIRM_WORD} to confirm`}
        />

        {error ? (
          <div
            className="mt-3 text-[11.5px] leading-relaxed p-2.5 rounded"
            style={{
              background: 'color-mix(in srgb, var(--negative) 10%, transparent)',
              color: 'var(--negative)',
            }}
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 mt-4">
          <button type="button" className="chip" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!armed || busy}
            className="chip"
            style={
              armed && !busy
                ? {
                    background: 'color-mix(in srgb, var(--negative) 16%, transparent)',
                    borderColor: 'var(--negative)',
                    color: 'var(--negative)',
                    fontWeight: 600,
                  }
                : { opacity: 0.45, cursor: 'not-allowed' }
            }
          >
            {busy ? 'Stopping…' : 'Emergency Stop'}
          </button>
        </div>
      </div>
    </div>
  );
}
