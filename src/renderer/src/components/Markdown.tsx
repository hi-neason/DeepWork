import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { memo } from "react";

interface Props {
  content: string;
}

// Memoized: during a streaming turn the chat state updates on every token,
// re-rendering the whole tree. Only the tail message's content changes, so
// memoizing on `content` skips re-parsing every prior Markdown message.
function MarkdownImpl({ content }: Props): React.ReactElement {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
