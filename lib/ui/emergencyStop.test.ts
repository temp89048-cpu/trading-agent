import { describe, expect, it } from 'vitest';

import { CONFIRM_WORD, isArmed, stopFailureMessage } from './emergencyStop';

describe('emergency stop arming', () => {
  it('arms on the exact word, case- and whitespace-insensitively', () => {
    for (const input of ['STOP', 'stop', 'Stop', '  STOP  ', '\tstop\n']) {
      expect(isArmed(input), input).toBe(true);
    }
  });

  it('does NOT arm on a prefix, a superstring, or anything else', () => {
    // If any of these armed, type-to-confirm would stop being a gate — which is
    // the entire reason this control is not a plain confirm dialog.
    for (const input of ['', ' ', 'S', 'STO', 'STOPP', 'STOP NOW', 'HALT', 'PAUSE', 'ESTOP']) {
      expect(isArmed(input), input).toBe(false);
    }
  });

  it('uses the word the label tells the operator to type', () => {
    // A drift between the label and the predicate would leave the button
    // permanently disabled with no visible reason.
    expect(isArmed(CONFIRM_WORD)).toBe(true);
  });
});

describe('emergency stop failure wording', () => {
  it('states the system is NOT stopped on an HTTP refusal', () => {
    const msg = stopFailureMessage({ httpStatus: 503 });
    expect(msg).toContain('HTTP 503');
    expect(msg).toContain('The system is NOT stopped.');
  });

  it('states the system is NOT stopped on a network failure', () => {
    const msg = stopFailureMessage({ networkError: 'Failed to fetch' });
    expect(msg).toContain('Failed to fetch');
    expect(msg).toContain('The system is NOT stopped.');
  });

  it('still says so when the cause is unknown', () => {
    // The one thing that must survive every branch.
    expect(stopFailureMessage({})).toContain('The system is NOT stopped.');
  });
});
