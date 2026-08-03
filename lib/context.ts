type ApiMsg = { role: string; content: string };

const MAX_HISTORY_MESSAGES = 24; // keep the most recent N non-system messages
const MAX_HISTORY_CHARS = 16000; // ~4k tokens, rough rule of thumb

// A longer input means a longer time-to-first-token and a longer total
// generation time on essentially every provider — this is the one lever
// the app itself actually controls over the model's own inherent speed.
// Without this, a long-running conversation sends its ENTIRE history on
// every single turn, so it gets slower and slower the longer you chat,
// independent of anything the model is doing.
export function trimApiMessages(messages: ApiMsg[]): ApiMsg[] {
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');

  let trimmed = rest.slice(-MAX_HISTORY_MESSAGES);
  let omitted = rest.length - trimmed.length;

  let totalChars = trimmed.reduce((n, m) => n + m.content.length, 0);
  while (totalChars > MAX_HISTORY_CHARS && trimmed.length > 2) {
    const dropped = trimmed.shift()!;
    totalChars -= dropped.content.length;
    omitted++;
  }

  const note: ApiMsg[] =
    omitted > 0
      ? [{ role: 'system', content: `[${omitted} earlier message(s) omitted from this request to keep response time reasonable — they're still saved in the conversation, just not sent to the model.]` }]
      : [];

  return [...systemMsgs, ...note, ...trimmed];
}
