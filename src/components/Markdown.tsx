import { useEffect, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { CsvTable } from './Csv';

let mermaidCounter = 0;

function Mermaid({ code }: { code: string }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const dark = document.documentElement.dataset.theme === 'dark';

  useEffect(() => {
    let cancelled = false;
    import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'neutral', fontFamily: 'inherit' });
      try {
        const { svg } = await mermaid.render(`mmd-${mermaidCounter++}`, code);
        if (!cancelled) {
          setSvg(svg);
          setError('');
        }
      } catch (e) {
        if (!cancelled) setError(String((e as Error)?.message ?? e));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, dark]);

  if (error) return <pre className="mermaid-error">{error}</pre>;
  return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * `baseUrl`: where relative links and images resolve to (e.g. a card's attachments folder), so a Markdown
 * file attached to a card can show a sibling attachment with `![](diagram.png)`.
 */
export function Markdown({ text, empty = 'No description provided.', baseUrl }: { text: string; empty?: string; baseUrl?: string }) {
  if (!text.trim()) return <p className="muted md-empty">{empty}</p>;
  const urlTransform = (url: string) => {
    if (baseUrl && !/^([a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(url)) {
      const rel = url.replace(/^\.\//, '');
      try {
        return baseUrl + encodeURIComponent(decodeURIComponent(rel));
      } catch {
        return baseUrl + encodeURIComponent(rel);
      }
    }
    return defaultUrlTransform(url);
  };
  return (
    <div className="md">
      <ReactMarkdown
        urlTransform={urlTransform}
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          code({ className, children, ...props }) {
            const lang = /language-(\w+)/.exec(className ?? '')?.[1];
            if (lang === 'mermaid') return <Mermaid code={String(children).replace(/\n$/, '')} />;
            if (lang === 'csv' || lang === 'tsv') return <CsvTable text={String(children).replace(/\n$/, '')} delimiter={lang === 'tsv' ? '\t' : undefined} />;
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre({ children }) {
            // Mermaid diagrams and CSV tables render their own container; don't wrap them in <pre>.
            const child = Array.isArray(children) ? children[0] : children;
            if (/language-(mermaid|csv|tsv)\b/.test((child as any)?.props?.className ?? '')) return <>{children}</>;
            return <pre>{children}</pre>;
          },
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
