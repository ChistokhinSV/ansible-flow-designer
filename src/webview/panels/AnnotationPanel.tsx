// The right panel for a selected Note, Section or Text (AFD-65): its words (Markdown), colour, size
// and the node a Note is on. Each change is one command; none of it changes the flow's version.
import { modelOf } from '../../core/flow/model';
import { ANNOTATION_COLORS, type AnnotationColor, type TextSize } from '../../core/flow/types';
import { run } from '../actions';
import { detachAnnotation, startAttach } from '../annotationActions';
import { useEditable } from '../editActions';
import { useUi } from '../store';
import { CommitField, ReadOnly } from './fields';

const KIND = { note: 'Note', section: 'Section', text: 'Text' } as const;
const SIZE: Record<TextSize, string> = { s: 'Small', m: 'Medium', l: 'Large' };

export function AnnotationPanel({ id }: { id: string }) {
  const snapshot = useUi((s) => s.snapshot);
  const design = useUi((s) => s.mode === 'design');
  const editable = useEditable() && design;
  if (!snapshot?.doc) return null;
  const model = modelOf(snapshot.doc);
  const a = model.annotations.get(id)?.annotation;
  if (!a) return null;
  const kind = a.kind ?? 'note';
  const color = a.color ?? (kind === 'note' ? 'yellow' : 'gray');
  const on = a.on ? model.nodes.get(a.on)?.node : undefined;
  const update = (patch: Parameters<typeof patchOf>[0]) =>
    void run({ kind: 'updateAnnotation', id, patch: patchOf(patch) });
  return (
    <div className="afd-panel-body" data-annotation-panel={kind}>
      <h2 className="afd-panel-title">{KIND[kind]}</h2>
      <p className="muted">
        Explains the flow and never runs: changing it keeps the flow's version.
        {kind === 'note' && on ? ' Its text is a comment above the code of the node it is on.' : ''}
      </p>
      <fieldset className="afd-editable" disabled={!editable}>
        <CommitField
          label={kind === 'section' ? 'Title (Markdown)' : 'Text (Markdown)'}
          focusKey="annotationText"
          multiline={kind !== 'section'}
          value={a.text}
          placeholder="**bold**, *italic*, `code`, - lists, [links](https://...)"
          onCommit={(text) => update({ text })}
        />
        <div className="afd-field">
          <label htmlFor="afd-annotation-color">Color</label>
          <select
            id="afd-annotation-color"
            value={color}
            onChange={(e) => update({ color: e.target.value as AnnotationColor })}
          >
            {ANNOTATION_COLORS.map((c) => (
              <option key={c} value={c}>
                {c[0]?.toUpperCase()}
                {c.slice(1)}
              </option>
            ))}
          </select>
        </div>
        {kind === 'text' ? (
          <div className="afd-field">
            <label htmlFor="afd-annotation-size">Size</label>
            <select
              id="afd-annotation-size"
              value={a.size ?? 'm'}
              onChange={(e) => update({ size: e.target.value as TextSize })}
            >
              {(Object.keys(SIZE) as TextSize[]).map((s) => (
                <option key={s} value={s}>
                  {SIZE[s]}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </fieldset>
      {kind === 'note' ? (
        <div className="afd-field">
          <ReadOnly label="On node" value={on ? on.title : 'None (free on the canvas)'} />
          {editable ? (
            on ? (
              <button type="button" className="secondary" onClick={() => detachAnnotation(id)}>
                Detach from Node
              </button>
            ) : (
              <button type="button" className="secondary" onClick={() => startAttach(id)}>
                Attach to Node…
              </button>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Only what changed goes into the command. */
function patchOf(p: { text?: string; color?: AnnotationColor; size?: TextSize }) {
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
}
