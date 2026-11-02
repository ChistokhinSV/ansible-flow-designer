// A Note, Section or Text on the canvas (AFD-65). No ports: it never runs. A Note on a node is a
// React Flow child of that node (its stored position is relative to it, as React Flow's is), and
// draws its own dashed tie, border to border. Double-click or Enter (the canvas) edits the Markdown
// as text: Ctrl+Enter or leaving the field saves (one edit), Escape cancels.
import { type Node, type NodeProps, NodeResizer, useInternalNode } from '@xyflow/react';
import { memo, useEffect, useRef, useState } from 'react';
import type { AnnotationView } from '../../core/flow/annotations';
import { plainText } from '../../core/view/markdown';
import { tieLine } from '../../core/view/tie';
import { run } from '../actions';
import { useUi } from '../store';
import { MarkdownView } from './MarkdownView';

export type AnnotationRFNode = Node<{ view: AnnotationView; editable: boolean }, 'annotation'>;

const KIND_LABEL = { note: 'Note', section: 'Section', text: 'Text' } as const;

/** What a screen reader says: the kind and the first line. */
export function annotationName(view: AnnotationView): string {
  const first = plainText(view.annotation.text).split('\n')[0] ?? '';
  return `${KIND_LABEL[view.kind]}: ${first.slice(0, 80) || '(empty)'}`;
}

function Editor({ id, text, done }: { id: string; text: string; done(): void }) {
  const [value, setValue] = useState(text);
  const field = useRef<HTMLTextAreaElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const save = () => {
    if (finished.current) return;
    finished.current = true;
    if (value !== text) void run({ kind: 'updateAnnotation', id, patch: { text: value } });
    done();
  };
  return (
    <textarea
      ref={field}
      className="afd-annotation-editor nodrag nopan nowheel"
      aria-label="Annotation text (Markdown); Ctrl+Enter saves, Escape cancels"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finished.current = true;
          done();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          save();
        }
        e.stopPropagation();
      }}
    />
  );
}

export const AnnotationNodeView = memo(function AnnotationNodeView({
  id,
  data,
  selected,
  parentId,
  positionAbsoluteX,
  positionAbsoluteY,
  width,
  height,
}: NodeProps<AnnotationRFNode>) {
  const { view, editable } = data;
  const a = view.annotation;
  const editing = useUi((s) => s.editingAnnotation === id);
  const setEditing = useUi((s) => s.editAnnotation);
  const parent = useInternalNode(parentId ?? '');
  const w = width ?? view.width;
  const h = height ?? view.height;
  // The tie, in this node's own coordinates.
  let tie: ReturnType<typeof tieLine>;
  if (parentId && parent?.measured.width && parent.measured.height) {
    const rel = {
      x: positionAbsoluteX - parent.internals.positionAbsolute.x,
      y: positionAbsoluteY - parent.internals.positionAbsolute.y,
    };
    const line = tieLine(
      { ...rel, width: w, height: h },
      { x: 0, y: 0, width: parent.measured.width, height: parent.measured.height },
    );
    tie = line && {
      from: { x: line.from.x - rel.x, y: line.from.y - rel.y },
      to: { x: line.to.x - rel.x, y: line.to.y - rel.y },
    };
  }
  const classes = [
    'afd-annotation',
    `afd-kind-${view.kind}`,
    `color-${a.color ?? (view.kind === 'note' ? 'yellow' : 'gray')}`,
    view.kind === 'text' ? `size-${a.size ?? 'm'}` : '',
    selected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const stop = () => setEditing(null);
  const body = editing ? (
    <Editor id={id} text={a.text} done={stop} />
  ) : (
    <div className="afd-annotation-text">
      <MarkdownView text={a.text} />
    </div>
  );
  return (
    <div
      className={classes}
      data-annotation-id={a.id}
      data-annotation-kind={view.kind}
      style={{ width: w, height: h }}
    >
      {selected && editable && !editing ? (
        <NodeResizer
          minWidth={40}
          minHeight={24}
          color="var(--afd-accent)"
          onResizeEnd={(_e, p) =>
            void run({
              kind: 'updateAnnotation',
              id,
              patch: {
                x: Math.round(p.x),
                y: Math.round(p.y),
                width: Math.round(p.width),
                height: Math.round(p.height),
              },
            })
          }
        />
      ) : null}
      {tie ? (
        <svg className="afd-tie" aria-hidden="true" overflow="visible" width="1" height="1">
          <line x1={tie.from.x} y1={tie.from.y} x2={tie.to.x} y2={tie.to.y} />
        </svg>
      ) : null}
      {view.kind === 'section' ? (
        <>
          <div className="afd-annotation-title">
            {editing ? (
              <Editor id={id} text={a.text} done={stop} />
            ) : (
              <MarkdownView text={a.text} />
            )}
          </div>
          <div className="afd-annotation-body" />
        </>
      ) : (
        body
      )}
    </div>
  );
});
