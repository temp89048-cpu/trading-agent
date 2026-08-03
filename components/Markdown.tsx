import { Fragment } from 'react';

// Renders a useful subset of markdown (fenced code, inline code, bold,
// italic, bullet lists, paragraphs) as real React elements — never via
// dangerouslySetInnerHTML, since this text comes from an LLM and must
// never be interpreted as HTML.
export function Markdown({ text }: { text: string }) {
  const blocks = splitBlocks(text);
  return (
    <div className="flex flex-col gap-2.5">
      {blocks.map((block, i) => {
        if (block.type === 'code') {
          return <CodeBlock key={i} lang={block.lang} code={block.code} />;
        }
        if (block.type === 'list') {
          return (
            <ul key={i} className="list-disc pl-5 flex flex-col gap-1">
              {block.items.map((item, j) => (
                <li key={j} className="text-sm leading-relaxed">
                  {inline(item)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="text-sm leading-relaxed whitespace-pre-wrap">
            {inline(block.text)}
          </p>
        );
      })}
    </div>
  );
}

type Block = { type: 'code'; lang: string; code: string } | { type: 'list'; items: string[] } | { type: 'p'; text: string };

function splitBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].trim().startsWith('```') && !/^\s*[-*]\s+/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'p', text: paraLines.join('\n') });
  }
  return blocks;
}

// Inline: **bold**, *italic*, `code` — split on the first match found at
// each step, left to right, no nested emphasis (kept simple on purpose).
function inline(text: string): React.ReactNode {
  const pattern = /(\*\*.+?\*\*|`.+?`|\*.+?\*)/;
  const parts = text.split(pattern).filter((p) => p !== '');
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code key={i} className="px-1 py-0.5 rounded text-[0.85em] font-mono bg-bg3 text-amber">
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.startsWith('*') && part.endsWith('*') && !part.startsWith('**')) {
          return <em key={i}>{part.slice(1, -1)}</em>;
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <div className="rounded-md border overflow-hidden border-line">
      <div className="flex items-center justify-between px-3 py-1.5 text-[10px] font-mono bg-bg3 text-txt2">
        <span>{lang || 'text'}</span>
        <button
          onClick={() => navigator.clipboard?.writeText(code)}
          className="hover:text-txt0 transition"
        >
          copy
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[12.5px] leading-relaxed font-mono bg-bg2 text-txt0">
        <code>{code}</code>
      </pre>
    </div>
  );
}
