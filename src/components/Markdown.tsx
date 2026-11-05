import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

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

export function Markdown({ text, empty = 'No description provided.' }: { text: string; empty?: string }) {
  if (!text.trim()) return <p className="muted md-empty">{empty}</p>;
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          code({ className, children, ...props }) {
            const lang = /language-(\w+)/.exec(className ?? '')?.[1];
            if (lang === 'mermaid') return <Mermaid code={String(children).replace(/\n$/, '')} />;
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre({ children }) {
            // Mermaid diagrams render their own container; don't wrap them in <pre>.
            const child = Array.isArray(children) ? children[0] : children;
            if ((child as any)?.props?.className?.includes('language-mermaid')) return <>{children}</>;
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
