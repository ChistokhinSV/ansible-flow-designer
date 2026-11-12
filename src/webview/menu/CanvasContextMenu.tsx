// The canvas context menu (AFD-18): the entries `canvasMenu` gives for what was right-clicked,
// drawn by the shared menu, each running an existing action (one command, so one undo step).

import { useReactFlow } from '@xyflow/react';
import {
  type CanvasAction,
  type CanvasMenuEntry,
  type CanvasTarget,
  canvasMenu,
} from '../../core/flow/canvasMenu';
import { type FlowModel, modelOf } from '../../core/flow/model';
import { scenarioMenu } from '../../core/scenario/authoring';
import { FULL_FIT } from '../../core/view/fit';
import { run } from '../actions';
import {
  addAnnotation,
  colorAnnotation,
  detachAnnotation,
  editAnnotation,
  startAttach,
} from '../annotationActions';
import { alignSelection, distributeSelection, resetPositions } from '../arrangeActions';
import { scenarioRequest, send } from '../bus';
import { copySelection } from '../clipboard';
import {
  cutNodes,
  deleteSelection,
  detachNodes,
  duplicate,
  editExitReason,
  rename,
  selectAll,
  selectFlow,
  startExtract,
  upLevel,
} from '../editActions';
import { addNextNode, runPortItem } from '../portActions';
import { startPartialRun } from '../runActions';
import { keysOf } from '../shortcuts';
import { type ContextMenuState, useUi } from '../store';
import { Menu, type UiMenuEntry } from './Menu';

function titleOf(model: FlowModel, target: CanvasTarget): string {
  switch (target.kind) {
    case 'node':
      return model.nodes.get(target.id)?.node.title ?? 'Node';
    case 'nodes':
      return `${target.ids.length} nodes`;
    case 'annotation': {
      const kind = model.annotations.get(target.id)?.annotation.kind ?? 'note';
      return kind === 'section' ? 'Section' : kind === 'text' ? 'Text' : 'Note';
    }
    case 'annotations':
      return `${target.ids.length} annotations`;
    case 'edge':
    case 'entry':
    case 'exit':
      return 'Wire';
    case 'pane':
      return 'Canvas';
  }
}

export function runCanvasAction(
  action: CanvasAction,
  menu: ContextMenuState,
  model: FlowModel,
  fitView: () => void,
): void {
  const ui = useUi.getState();
  switch (action.do) {
    case 'openSubflow':
      ui.setLevel(action.node);
      return;
    // AFD-116: what-if in the scenario being edited, each one edit of the scenarios file.
    case 'scenarioForce':
      if (ui.scenarioEditing)
        ui.setHostPick({
          scenario: ui.scenarioEditing,
          step: action.step,
          outcome: action.outcome,
          title: action.title,
        });
      return;
    case 'scenarioApproval':
      if (ui.scenarioEditing)
        void scenarioRequest({
          kind: 'setApproval',
          name: ui.scenarioEditing,
          approval: action.approval,
          pick: action.pick,
        }).then((a) => ui.setError(a.ok ? null : (a.error ?? 'The scenario did not change')));
      return;
    case 'scenarioExpect':
      if (ui.scenarioEditing)
        void scenarioRequest({
          kind: 'expectHost',
          name: ui.scenarioEditing,
          host: action.host,
          where: action.where,
        }).then((a) => ui.setError(a.ok ? null : (a.error ?? 'The scenario did not change')));
      return;
    case 'properties':
      ui.openDetails(action.node, action.tab);
      return;
    case 'rename':
      rename(action.node);
      return;
    case 'setStatus':
      // `tested` by hand takes a reason (AFD-44).
      if (action.status === 'tested') ui.setTestedReason(action.node);
      else void run({ kind: 'updateNode', id: action.node, patch: { status: action.status } });
      return;
    case 'port':
      void runPortItem(action.item, action.ref);
      return;
    case 'addNext':
      addNextNode(action.from, action.insertOn);
      return;
    case 'cut':
      void cutNodes(action.nodes, action.annotations);
      return;
    case 'copy':
      copySelection(action.nodes, action.annotations ?? []);
      return;
    case 'duplicate':
      void duplicate(action.nodes, action.annotations);
      return;
    case 'delete':
      void deleteSelection(action.nodes, action.edges, action.annotations);
      return;
    case 'addAnnotation':
      void addAnnotation(
        action.kind,
        menu.at,
        action.on,
        action.around ? { around: action.around } : {},
      );
      return;
    case 'editAnnotation':
      editAnnotation(action.id);
      return;
    case 'colorAnnotation':
      colorAnnotation(action.id, action.color);
      return;
    case 'attachAnnotation':
      startAttach(action.id);
      return;
    case 'detachAnnotation':
      detachAnnotation(action.id);
      return;
    case 'extract':
      startExtract(action.nodes);
      return;
    case 'detach':
      void detachNodes(action.nodes);
      return;
    case 'setDisabled':
      void run({ kind: 'setDisabled', ids: action.nodes, disabled: action.disabled });
      return;
    case 'dissolve':
      void run({ kind: 'dissolveSubflow', id: action.node, place: true });
      return;
    case 'selectFlow':
      selectFlow(action.node, action.dir);
      return;
    case 'zoomSelection':
      ui.zoomToSelection();
      return;
    case 'align':
      void alignSelection(action.how, action.nodes);
      return;
    case 'distribute':
      void distributeSelection(action.how, action.nodes);
      return;
    case 'resetPosition':
      void resetPositions(action.nodes);
      return;
    case 'showInText': {
      const path = model.nodes.get(action.node)?.path;
      send({ type: 'openText', ...(path ? { path } : {}) });
      return;
    }
    case 'peekCode':
      send({ type: 'peekCode', node: action.node });
      return;
    case 'runPartial':
      startPartialRun(action.node, action.only);
      return;
    case 'removeEntry':
      void run({ kind: 'setBoundaryIn', subflow: action.subflow, node: null });
      return;
    case 'removeExit':
      void run({
        kind: 'disconnectBoundary',
        subflow: action.subflow,
        from: action.from,
        port: action.port,
      });
      return;
    case 'editReason':
      editExitReason(action.edge);
      return;
    case 'paste':
      send({ type: 'requestPaste', ...(menu.at ? { at: menu.at } : {}) });
      return;
    case 'addNode':
      ui.openQuickAdd({ type: 'task', ...(menu.at ? { position: menu.at } : {}) });
      return;
    case 'insertShared':
      send({ type: 'insertShared', level: ui.level, ...(menu.at ? { at: menu.at } : {}) });
      return;
    case 'selectAll':
      selectAll();
      return;
    case 'tidyUp':
      send({ type: 'tidyUp', level: ui.level });
      return;
    case 'fitView':
      fitView();
      return;
    case 'find':
      ui.openFind(true);
      return;
    case 'upLevel':
      upLevel();
      return;
  }
}

export function CanvasContextMenu() {
  const menu = useUi((s) => s.contextMenu);
  const snapshot = useUi((s) => s.snapshot);
  const mode = useUi((s) => s.mode);
  const level = useUi((s) => s.level);
  const close = useUi((s) => s.openContextMenu);
  const editing = useUi((s) => s.scenarioEditing);
  const check = useUi((s) => s.scenarioCheck);
  const flow = useReactFlow();
  if (!menu || !snapshot?.doc) return null;
  const model = modelOf(snapshot.doc);
  const scenario = editing && check ? scenarioMenu(snapshot.doc, check, editing) : undefined;
  const entries = canvasMenu(model, menu.target, {
    mode,
    level,
    stale: snapshot.stale || !!snapshot.idGaps,
    ...(snapshot.idGaps ? { why: 'Complete IDs first (the banner above the canvas)' } : {}),
    openPorts: snapshot.openPorts,
    hasPlay: (id) => !!snapshot.plays?.[id],
    ...(scenario ? { scenario } : {}),
  });
  if (entries.length === 0) return null;
  const fitView = () => void flow.fitView(FULL_FIT);
  const toUi = (e: CanvasMenuEntry): UiMenuEntry => {
    if (e.type === 'separator') return e;
    if (e.type === 'submenu') return { ...e, items: e.items.map(toUi) };
    return {
      type: 'item',
      label: e.label,
      icon: e.icon,
      shortcut: keysOf(e.shortcut),
      checked: e.checked,
      disabled: e.disabled,
      note: e.disabled,
      onSelect: () => runCanvasAction(e.action, menu, model, fitView),
    };
  };
  return (
    <Menu
      x={menu.x}
      y={menu.y}
      label={titleOf(model, menu.target)}
      data={{ 'data-canvas-menu': menu.target.kind }}
      items={entries.map(toUi)}
      onClose={() => close(null)}
    />
  );
}
