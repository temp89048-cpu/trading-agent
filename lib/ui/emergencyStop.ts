// ---------------------------------------------------------------------
// The arming rule and the failure wording for the emergency stop.
//
// EXTRACTED SO IT CAN BE TESTED. `components/shell/EmergencyStopModal.tsx` is a
// `.tsx`, and this project's vitest setup cannot parse JSX (`jsx: "preserve"`),
// so anything asserted about the stop has to live in a `.ts` module. That is a
// constraint worth paying here specifically: the emergency stop is the one control
// where a subtle behaviour change — arming on the wrong string, or reporting a
// failed stop as a success — is materially dangerous.
// ---------------------------------------------------------------------

export const CONFIRM_WORD = 'STOP';

/**
 * Whether the typed text arms the stop button.
 *
 * Trimmed and upper-cased deliberately: an operator typing under pressure should
 * not be defeated by a trailing space or caps lock. It is still an exact word
 * match — a prefix like "STO" or an extra character like "STOPP" must NOT arm,
 * or the type-to-confirm gate stops being a gate.
 */
export function isArmed(typed: string): boolean {
  return typed.trim().toUpperCase() === CONFIRM_WORD;
}

/**
 * The message shown when the stop did not apply.
 *
 * It always ends by stating the system is NOT stopped. A failed stop that reads
 * like a successful one is the worst outcome this component can produce — worse
 * than any error text — so the claim is part of the function, not left to the
 * call site to remember.
 */
export function stopFailureMessage(cause: { httpStatus?: number; networkError?: string }): string {
  const prefix =
    typeof cause.httpStatus === 'number'
      ? `Backend refused the stop: HTTP ${cause.httpStatus}.`
      : `Could not reach the backend (${cause.networkError || 'network error'}).`;
  return `${prefix} The system is NOT stopped.`;
}
