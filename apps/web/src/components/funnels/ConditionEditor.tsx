"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Condition, Operator, Scalar, ValueType } from "../../server/funnels/funnelDefinition";
import type { UiSource } from "./funnelUi";
import { conditionNodes, parseConditionScalar } from "./funnelGraph";

const input = "input input-bordered min-h-11 w-full min-w-0 bg-base-100";
const select = "select select-bordered min-h-11 w-full min-w-0 bg-base-100";
const button = "btn btn-ghost min-h-11 h-auto whitespace-normal normal-case";
const presence = ["isKnown", "isMissing", "isNull"];
const operators: { value: Operator; label: string }[] = [{ value: "eq", label: "Equals" }, { value: "neq", label: "Does not equal" },
  { value: "gt", label: "Greater than" }, { value: "gte", label: "At least" }, { value: "lt", label: "Less than" }, { value: "lte", label: "At most" },
  { value: "in", label: "Is one of" }, { value: "isKnown", label: "Is known" }, { value: "isMissing", label: "Is missing" }, { value: "isNull", label: "Is explicitly null" }];
const fallbackValue = (type: ValueType): Scalar => type === "boolean" ? true : type === "number" ? 0 : type === "decimal" ? "0" : "";
const stored = (value: Scalar) => typeof value === "string" ? value : String(value);
type Props = { value?: Condition; onChange: (value: Condition | undefined) => void; fields: string[];
  scope?: "EVENT" | "EVENT_AND_PROPERTY"; sources?: UiSource[]; disabled?: boolean; label?: string; onValidityChange?: (valid: boolean) => void };

function ValueInput({ value, type, onChange, disabled, label, path, report }: {
  value: Scalar; type: ValueType; onChange: (value: Scalar) => void; disabled?: boolean; label: string; path: string; report: (path: string, valid: boolean) => void;
}) {
  const id = useId(), [raw, setRaw] = useState(stored(value));
  useEffect(() => { setRaw(stored(value)); }, [value, type]);
  const parsed = parseConditionScalar(raw, type), error = parsed.error;
  useEffect(() => { report(path, !error); return () => report(path, true); }, [error, path, report]);
  const update = (text: string) => { setRaw(text); const next = parseConditionScalar(text, type); if (!next.error && next.value !== undefined) onChange(next.value); };
  return <div className="grid min-w-0 gap-1">
    <label className="text-sm font-medium" htmlFor={id}>{label}</label>
    {type === "boolean" ? <select id={id} className={select} disabled={disabled} value={raw} onChange={event => update(event.target.value)}>
      <option value="true">True</option><option value="false">False</option>
    </select> : <input id={id} className={input} disabled={disabled} value={raw} type="text" inputMode={type === "number" || type === "decimal" ? "decimal" : undefined}
      aria-invalid={!!error} aria-describedby={error ? `${id}-error` : type === "datetime" ? `${id}-hint` : undefined}
      onChange={event => update(event.target.value)} />}
    {error ? <p id={`${id}-error`} className="text-sm text-error">{error}</p> : type === "datetime" ? <p id={`${id}-hint`} className="text-sm text-base-content/70">Include Z or an explicit timezone offset.</p> : null}
  </div>;
}

export function ConditionEditor({ value, onChange, fields, scope = "EVENT_AND_PROPERTY", sources = [], disabled, label = "Condition", onValidityChange }: Props) {
  const [invalid, setInvalid] = useState<Record<string, boolean>>({}), id = useId();
  const validityCallback = useRef(onValidityChange);
  validityCallback.current = onValidityChange;
  const report = useCallback((path: string, valid: boolean) => setInvalid(previous => {
    if (Boolean(previous[path]) === !valid) return previous;
    const next = { ...previous }; if (valid) delete next[path]; else next[path] = true; return next;
  }), []);
  const valid = !Object.values(invalid).some(Boolean);
  useEffect(() => { onValidityChange?.(valid); }, [valid, onValidityChange]);
  useEffect(() => () => validityCallback.current?.(true), []);
  const newCondition = (): Condition | undefined => fields[0] ? { field: { scope: "EVENT", key: fields[0] }, type: "string", op: "isKnown" } :
    scope === "EVENT_AND_PROPERTY" && sources.some(source => source.config.propertyKeys.length && source.config.allowedEvents.length) ? (() => {
      const source = sources.find(source => source.config.propertyKeys.length && source.config.allowedEvents.length)!;
      return { field: { scope: "PROPERTY" as const, sourceId: source.id, type: source.config.allowedEvents[0], key: source.config.propertyKeys[0] }, type: "string" as const, op: "isKnown" as const };
    })() : undefined;
  const capacity = conditionNodes(value) < 256;
  function render(condition: Condition, change: (condition: Condition) => void, remove: () => void, path: string, depth: number) {
    if ("all" in condition || "any" in condition) {
      const kind = "all" in condition ? "all" : "any", children = "all" in condition ? condition.all : condition.any;
      const replace = (items: Condition[]) => items.length ? change(kind === "all" ? { all: items } : { any: items }) : remove();
      return <fieldset className="min-w-0 rounded-box border border-base-300 p-3" key={path}>
        <legend className="px-1 text-sm font-semibold">{label} group</legend>
        <div className="grid gap-3">
          <label className="grid gap-1 text-sm font-medium">Match
            <select className={select} disabled={disabled} value={kind} onChange={event => change(event.target.value === "all" ? { all: children } : { any: children })}>
              <option value="all">All conditions (AND)</option><option value="any">Any condition (OR)</option>
            </select>
          </label>
          {children.map((child, index) => render(child, replacement => replace(children.map((item, at) => at === index ? replacement : item)),
            () => replace(children.filter((_, at) => at !== index)), `${path}.${index}`, depth + 1))}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={disabled || !capacity || depth >= 8 || !newCondition()} onClick={() => { const added = newCondition(); if (added) replace([...children, added]); }}>Add condition</button>
            <button type="button" className={button} disabled={disabled || conditionNodes(value) > 254 || depth >= 7 || !newCondition()} onClick={() => { const added = newCondition(); if (added) replace([...children, { all: [added] }]); }}>Add condition group</button>
            <button type="button" className={button} disabled={disabled} onClick={remove}>Remove group</button>
          </div>
        </div>
      </fieldset>;
    }
    const field = condition.field, selectedSource = field.scope === "PROPERTY" ? sources.find(source => source.id === field.sourceId) : undefined;
    const keys = field.scope === "PROPERTY" ? selectedSource?.config.propertyKeys ?? [] : fields;
    const availableKeys = keys.includes(field.key) ? keys : [field.key, ...keys];
    const changeOperator = (op: Operator) => { const { value: previous, ...rest } = condition;
      change(presence.includes(op) ? { ...rest, op } : { ...rest, op, value: op === "in" ? Array.isArray(previous) ? previous : [previous ?? fallbackValue(condition.type)] :
        Array.isArray(previous) ? previous[0] ?? fallbackValue(condition.type) : previous ?? fallbackValue(condition.type) }); };
    return <fieldset key={path} className="grid min-w-0 gap-3 rounded-box border border-base-300 p-3">
      <legend className="px-1 text-sm font-semibold">{label} {path.split(".").slice(1).map(part => Number(part) + 1).join(".")}</legend>
      {scope !== "EVENT" ? <label className="grid gap-1 text-sm font-medium">Read field from
        <select className={select} disabled={disabled} value={field.scope} onChange={event => {
          if (event.target.value === "EVENT") change({ ...condition, field: { scope: "EVENT", key: fields[0] ?? field.key } });
          else { const source = sources.find(item => item.config.allowedEvents.length && item.config.propertyKeys.length); if (source) change({ ...condition,
            field: { scope: "PROPERTY", sourceId: source.id, type: source.config.allowedEvents[0], key: source.config.propertyKeys[0] } }); }
        }}><option value="EVENT" disabled={!fields.length}>This event</option><option value="PROPERTY" disabled={!sources.some(source => source.config.allowedEvents.length && source.config.propertyKeys.length)}>Latest observed property</option></select>
      </label> : field.scope !== "EVENT" ? <p className="text-sm text-error">Email event waits only support fields from the matching event. Remove this condition to replace it.</p> : null}
      {field.scope === "PROPERTY" && <>
        <label className="grid gap-1 text-sm font-medium">Property source<select className={select} disabled={disabled || scope === "EVENT"} value={field.sourceId} onChange={event => {
          const source = sources.find(item => item.id === event.target.value); if (source) change({ ...condition, field: { scope: "PROPERTY", sourceId: source.id,
            type: source.config.allowedEvents[0] ?? field.type, key: source.config.propertyKeys[0] ?? field.key } });
        }}>{!selectedSource && <option value={field.sourceId}>Unavailable source ({field.sourceId})</option>}{sources.map(source => <option key={source.id} value={source.id}>{source.name}{source.status !== "ACTIVE" ? " · unavailable" : ""}</option>)}</select></label>
        <label className="grid gap-1 text-sm font-medium">Property event<select className={select} disabled={disabled || scope === "EVENT"} value={field.type} onChange={event => change({ ...condition, field: { ...field, type: event.target.value } })}>
          {!selectedSource?.config.allowedEvents.includes(field.type) && <option value={field.type}>{field.type} · unavailable</option>}
          {selectedSource?.config.allowedEvents.map(type => <option key={type} value={type}>{type}</option>)}</select></label>
      </>}
      <label className="grid gap-1 text-sm font-medium">Field<select className={select} disabled={disabled} value={field.key} onChange={event => change({ ...condition, field: { ...field, key: event.target.value } })}>
        {availableKeys.map(key => <option key={key} value={key}>{key}{!keys.includes(key) ? " · unavailable" : ""}</option>)}</select></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium">Value type<select className={select} disabled={disabled} value={condition.type} onChange={event => {
          const type = event.target.value as ValueType, op = ["gt", "gte", "lt", "lte"].includes(condition.op) && ["string", "boolean"].includes(type) ? "eq" : condition.op;
          const { value: _old, ...rest } = condition; change({ ...rest, type, op, ...(presence.includes(op) ? {} : { value: op === "in" ? [fallbackValue(type)] : fallbackValue(type) }) });
        }}>{["string", "boolean", "number", "decimal", "datetime"].map(type => <option key={type} value={type}>{type === "string" ? "Text" : type === "decimal" ? "Exact decimal" : type === "datetime" ? "Timestamp" : type === "boolean" ? "True / false" : "Number"}</option>)}</select></label>
        <label className="grid gap-1 text-sm font-medium">Comparison<select className={select} disabled={disabled} value={condition.op} onChange={event => changeOperator(event.target.value as Operator)}>
          {operators.filter(operator => !["gt", "gte", "lt", "lte"].includes(operator.value) || ["number", "decimal", "datetime"].includes(condition.type)).map(operator => <option key={operator.value} value={operator.value}>{operator.label}</option>)}</select></label>
      </div>
      {!presence.includes(condition.op) && (condition.op === "in" ? <div className="grid gap-3">{(Array.isArray(condition.value) ? condition.value : [condition.value ?? fallbackValue(condition.type)]).map((value, index, values) => <div key={index} className="grid min-w-0 gap-1">
        <ValueInput value={value} type={condition.type} onChange={next => change({ ...condition, value: values.map((item, at) => at === index ? next : item) })} disabled={disabled} label={`Allowed value ${index + 1}`} path={`${path}.value.${index}`} report={report} />
        <button type="button" className={`${button} justify-self-start`} disabled={disabled || values.length === 1} onClick={() => change({ ...condition, value: values.filter((_, at) => at !== index) })}>Remove value {index + 1}</button>
      </div>)}<button type="button" className={`${button} justify-self-start`} disabled={disabled || Array.isArray(condition.value) && condition.value.length >= 100} onClick={() => change({ ...condition, value: [...(Array.isArray(condition.value) ? condition.value : []), fallbackValue(condition.type)] })}>Add allowed value</button></div> :
        <ValueInput value={Array.isArray(condition.value) ? condition.value[0] : condition.value ?? fallbackValue(condition.type)} type={condition.type} onChange={value => change({ ...condition, value })} disabled={disabled} label="Compare with" path={`${path}.value`} report={report} />)}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={disabled || !capacity || depth >= 8} onClick={() => change({ all: [condition] })}>Group with more conditions</button>
        <button type="button" className={button} disabled={disabled} onClick={remove}>Remove condition</button>
      </div>
    </fieldset>;
  }
  return <div className="grid min-w-0 gap-2" aria-describedby={`${id}-semantics`}>
    {value ? render(value, onChange, () => onChange(undefined), "condition", 1) : <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-base-content/70">No filter — this branch always matches its trigger.</span>
      <button type="button" className={button} disabled={disabled || !newCondition()} onClick={() => onChange(newCondition())}>Add condition</button>
    </div>}
    {!newCondition() && <p className="text-sm text-base-content/70">Configure event property keys on a source to add conditions.</p>}
    <p id={`${id}-semantics`} className="text-xs text-base-content/70">Missing, null or conflicting values may be unknown. An earlier unknown branch waits instead of falling through.</p>
  </div>;
}
