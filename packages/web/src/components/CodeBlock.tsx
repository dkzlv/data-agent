/**
 * CodeBlock — syntax-highlighted code panel used inside tool-call
 * expansions. Backed by `prism-react-renderer` (vendored slim Prism)
 * which keeps the bundle small and avoids the global namespace
 * pollution the full `prismjs` package causes.
 *
 * Themes:
 *   - light → vsLight
 *   - dark  → vsDark
 *
 * Earlier versions used a plain `<pre>` with a monospace font and no
 * coloring. That made longer codemode snippets visually indistinguish-
 * able from their JSON results, so SQL/TS reads were noisy. The new
 * block matches the screenshots in afb2d2 (Bash/Browser cards).
 */
import { Highlight, themes } from "prism-react-renderer";
import { useTheme } from "./theme-provider";
import { cn } from "~/lib/utils";

interface CodeBlockProps {
  code: string;
  /**
   * Prism language id. Pass undefined → falls back to `tsx` which
   * tokenises most TypeScript/JS reasonably well.
   */
  language?: string;
  /** Tailwind classes appended to the outer <pre>. */
  className?: string;
}

export function CodeBlock({ code, language = "tsx", className }: CodeBlockProps) {
  const { resolved } = useTheme();
  // vsLight + vsDark have a near-monochrome look that fits the
  // product's neutral palette better than e.g. dracula or shadesOfPurple.
  const theme = resolved === "dark" ? themes.vsDark : themes.vsLight;
  const trimmed = code.replace(/\n+$/, "");

  return (
    <Highlight theme={theme} code={trimmed} language={language}>
      {({ className: prismCls, style, tokens, getLineProps, getTokenProps }) => (
        <pre
          className={cn(
            // We deliberately drop prism's own background — it ships a
            // solid color that fights the surrounding card. Keep the
            // syntax colors via inline style on each token instead.
            "overflow-x-auto rounded-md border border-border bg-muted/30 px-3 py-2.5 font-mono text-[12px] leading-[1.55]",
            prismCls,
            className
          )}
          style={{ ...style, background: "transparent" }}
        >
          {tokens.map((line, i) => {
            const lineProps = getLineProps({ line });
            return (
              <div key={i} {...lineProps}>
                {line.map((token, key) => {
                  const tokenProps = getTokenProps({ token });
                  return <span key={key} {...tokenProps} />;
                })}
              </div>
            );
          })}
        </pre>
      )}
    </Highlight>
  );
}
