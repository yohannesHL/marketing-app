"use client";
import type { FunnelDefinition } from "../../server/funnels/funnelDefinition";
import type { CanvasConnectionRequest } from "./CanvasConnectionDialog";
import { funnelEdges } from "./funnelGraph";

export function FunnelStageList({ definition, selectedStageId, disabled, onEdit, onAdd }: {
  definition: FunnelDefinition; selectedStageId: string | null; disabled: boolean;
  onEdit: (id: string) => void; onAdd: (request: CanvasConnectionRequest) => void;
}) {
  const paths = funnelEdges(definition);
  return <section className="funnel-stage-table" aria-label="Stage list"><header><h2>Journey stages</h2><p>Review each milestone and where people go next.</p></header>
    <ol>{definition.stages.map(stage => {
      const outgoing = paths.filter(path => path.from === stage.id);
      return <li key={stage.id} className={stage.id === selectedStageId ? "is-selected" : ""}>
        <div><span className={`funnel-list-kind ${stage.terminal !== "NONE" ? `is-${stage.terminal.toLowerCase()}` : ""}`}>{stage.terminal === "SUCCESS" ? "Goal exit" : stage.terminal === "FAILURE" ? "Exit" : definition.entryStages.includes(stage.id) ? "Entry stage" : stage.goal ? "Goal stage" : "Stage"}</span><h3>{stage.name}</h3>
          <p>{stage.terminal !== "NONE" ? "This journey ends here." : outgoing.length ? `Next: ${[...new Set(outgoing.map(path => definition.stages.find(item => item.id === path.to)?.name))].join(" · ")}` : "No next step yet."}</p>
        </div>
        <div className="funnel-list-actions"><button type="button" className="btn btn-ghost min-h-11 normal-case" aria-label={`Edit ${stage.name}`} disabled={disabled} onClick={event => { event.currentTarget.focus({ preventScroll: true }); onEdit(stage.id); }}>Edit stage</button>
          {stage.terminal === "NONE" && <button type="button" className="btn btn-ghost min-h-11 normal-case" aria-label={`Add next step after ${stage.name}`} disabled={disabled} onClick={() => onAdd({ from: stage.id })}>Add next step</button>}</div>
      </li>;
    })}</ol>
    {!definition.stages.length && <div className="p-5"><p>No stages yet.</p><button type="button" className="btn min-h-11 normal-case" disabled={disabled} onClick={() => onAdd({ from: null })}>Add first stage</button></div>}
  </section>;
}
