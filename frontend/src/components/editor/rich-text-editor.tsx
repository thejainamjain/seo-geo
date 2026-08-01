'use client';

import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import Placeholder from '@tiptap/extension-placeholder';
import CharacterCount from '@tiptap/extension-character-count';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  Heading1, Heading2, Heading3, Pilcrow,
  List, ListOrdered, Quote, Code, Minus,
  AlignLeft, AlignCenter, AlignRight,
  LinkIcon, Unlink, Undo2, Redo2,
} from 'lucide-react';

// ── Toolbar button ───────────────────────────────────────────────────────

function ToolbarButton({
  onClick, active, disabled, title, children,
}: {
  onClick:   () => void;
  active?:   boolean;
  disabled?: boolean;
  title:     string;
  children:  React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(active && 'bg-muted text-foreground')}
    >
      {children}
    </Button>
  );
}

function ToolbarDivider() {
  return <div className="w-px h-5 bg-border mx-1 shrink-0" />;
}

// ── Link panel — inline, not a native prompt() ───────────────────────────

function LinkPanel({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const existing = editor.getAttributes('link')['href'] as string | undefined;
  const [url, setUrl] = useState(existing ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function apply() {
    const trimmed = url.trim();
    if (!trimmed) {
      editor.chain().focus().unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: trimmed }).run();
    }
    onClose();
  }

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-muted/30">
      <Input
        ref={inputRef}
        value={url}
        onChange={e => setUrl(e.target.value)}
        placeholder="https://example.com"
        className="h-7 text-xs flex-1"
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); apply(); }
          if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }}
      />
      <Button type="button" size="sm" className="h-7 text-xs shrink-0" onClick={apply}>
        Apply
      </Button>
      {existing && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs shrink-0"
          onClick={() => { editor.chain().focus().unsetLink().run(); onClose(); }}
        >
          Remove
        </Button>
      )}
      <Button type="button" variant="ghost" size="sm" className="h-7 text-xs shrink-0" onClick={onClose}>
        Cancel
      </Button>
    </div>
  );
}

// ── Toolbar ───────────────────────────────────────────────────────────────

function Toolbar({ editor }: { editor: Editor }) {
  const [linkPanelOpen, setLinkPanelOpen] = useState(false);

  return (
    <div className="sticky top-0 z-10 bg-background border-b border-border">
      <div className="flex items-center gap-0.5 px-2 py-1.5 flex-wrap">
        <ToolbarButton title="Undo" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}>
          <Undo2 />
        </ToolbarButton>
        <ToolbarButton title="Redo" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}>
          <Redo2 />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton title="Paragraph" active={editor.isActive('paragraph')} onClick={() => editor.chain().focus().setParagraph().run()}>
          <Pilcrow />
        </ToolbarButton>
        <ToolbarButton title="Heading 1" active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
          <Heading1 />
        </ToolbarButton>
        <ToolbarButton title="Heading 2" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
          <Heading2 />
        </ToolbarButton>
        <ToolbarButton title="Heading 3" active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
          <Heading3 />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton title="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
          <Bold />
        </ToolbarButton>
        <ToolbarButton title="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <Italic />
        </ToolbarButton>
        <ToolbarButton title="Underline" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}>
          <UnderlineIcon />
        </ToolbarButton>
        <ToolbarButton title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
          <Strikethrough />
        </ToolbarButton>
        <ToolbarButton title="Inline code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
          <Code />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton title="Bullet list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          <List />
        </ToolbarButton>
        <ToolbarButton title="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
          <ListOrdered />
        </ToolbarButton>
        <ToolbarButton title="Blockquote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
          <Quote />
        </ToolbarButton>
        <ToolbarButton title="Horizontal rule" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
          <Minus />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton title="Align left" active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()}>
          <AlignLeft />
        </ToolbarButton>
        <ToolbarButton title="Align center" active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()}>
          <AlignCenter />
        </ToolbarButton>
        <ToolbarButton title="Align right" active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()}>
          <AlignRight />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          title={editor.isActive('link') ? 'Edit link' : 'Add link'}
          active={editor.isActive('link') || linkPanelOpen}
          onClick={() => setLinkPanelOpen(v => !v)}
        >
          <LinkIcon />
        </ToolbarButton>
        {editor.isActive('link') && (
          <ToolbarButton title="Remove link" onClick={() => editor.chain().focus().unsetLink().run()}>
            <Unlink />
          </ToolbarButton>
        )}
      </div>

      {linkPanelOpen && <LinkPanel editor={editor} onClose={() => setLinkPanelOpen(false)} />}
    </div>
  );
}

// ── Editor ────────────────────────────────────────────────────────────────

export function RichTextEditor({
  content,
  onChange,
  placeholder = 'Start writing…',
  className,
}: {
  content:      string;
  onChange:     (html: string) => void;
  placeholder?: string;
  className?:   string;
}) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        link: false, // configured separately below with openOnClick disabled for editing
        // underline is left enabled — StarterKit bundles it by default (v3),
        // no separate @tiptap/extension-underline registration needed.
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder }),
      CharacterCount,
    ],
    content,
    editorProps: {
      attributes: {
        class: cn(
          'prose prose-sm prose-invert max-w-none focus:outline-none',
          'prose-headings:font-semibold prose-headings:tracking-tight',
          'prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg',
          'prose-p:leading-relaxed',
          'prose-a:text-foreground prose-a:underline',
          'prose-strong:text-foreground',
          'prose-code:text-foreground prose-code:bg-muted prose-code:px-1 prose-code:rounded',
          'min-h-[500px] px-4 py-4',
        ),
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });

  if (!editor) {
    return <div className={cn('min-h-[500px] animate-pulse bg-muted/30 rounded-lg', className)} />;
  }

  const words = editor.storage['characterCount']?.words() as number | undefined;

  return (
    <div className={cn('border border-border rounded-lg overflow-hidden', className)}>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
      <div className="px-4 py-2 border-t border-border text-xs text-muted-foreground">
        {words ?? 0} words
      </div>
    </div>
  );
}

export type { Editor };
