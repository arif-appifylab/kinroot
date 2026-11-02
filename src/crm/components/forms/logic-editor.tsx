import {Plus, X} from 'lucide-react';

import {hasOptions, isInput, OPS, type FormField, type Rule, type RuleGroup} from '@/lib/forms';

import {Button} from '../ui/button';
import {Input, NativeSelect} from '../ui/form';

/** Options a rule value can take for this field (choices, yes/no), or null for free text. */
function valueOptions(f: FormField | undefined): string[] | null {
  if (!f) return null;
  if (hasOptions(f.type)) return f.options ?? [];
  if (f.type === 'yes_no') return ['yes', 'no'];
  if (f.type === 'consent') return ['true', 'false'];
  if (f.type === 'rating') return Array.from({length: f.scale ?? 5}, (_, i) => String(i + 1));
  return null;
}

/** Rules against earlier questions: "all / any of: <field> <op> <value>". */
export function RuleGroupEditor({group, onChange, sources}: {group: RuleGroup; onChange: (g: RuleGroup) => void; sources: FormField[]}) {
  const candidates = sources.filter((f) => isInput(f.type) && f.type !== 'file');
  const setRule = (i: number, patch: Partial<Rule>) => onChange({...group, rules: group.rules.map((r, j) => (j === i ? {...r, ...patch} : r))});
  const add = () => onChange({...group, rules: [...group.rules, {fieldId: candidates.at(-1)?.id ?? '', op: 'is', value: ''}]});

  if (!candidates.length) return <p className="text-xs text-muted-foreground">Add a question above this one to build a rule on.</p>;

  return (
    <div className="grid gap-2">
      {group.rules.length > 1 && (
        <div className="flex items-center gap-2 text-xs text-slate-600">
          Match
          <NativeSelect className="h-7 w-auto py-0 text-xs" value={group.match} onChange={(e) => onChange({...group, match: e.target.value as RuleGroup['match']})}>
            <option value="all">all rules</option>
            <option value="any">any rule</option>
          </NativeSelect>
        </div>
      )}
      {group.rules.map((r, i) => {
        const field = candidates.find((f) => f.id === r.fieldId);
        const opts = valueOptions(field);
        const op = OPS.find((o) => o.op === r.op);
        return (
          <div key={i} className="grid gap-1.5 rounded-lg border border-slate-200 bg-slate-50/60 p-2">
            <div className="flex gap-1.5">
              <NativeSelect className="h-8 min-w-0 flex-1 py-0 text-xs" value={r.fieldId} onChange={(e) => setRule(i, {fieldId: e.target.value, value: ''})} aria-label="Question">
                <option value="">Choose a question…</option>
                {candidates.map((f) => <option key={f.id} value={f.id}>{f.label || '(untitled)'}</option>)}
              </NativeSelect>
              <Button type="button" variant="ghost" size="icon-sm" className="shrink-0" onClick={() => onChange({...group, rules: group.rules.filter((_, j) => j !== i)})} aria-label="Remove rule"><X /></Button>
            </div>
            <div className="flex gap-1.5">
              <NativeSelect className="h-8 w-auto py-0 text-xs" value={r.op} onChange={(e) => setRule(i, {op: e.target.value as Rule['op']})} aria-label="Condition">
                {OPS.filter((o) => (o.op === 'gt' || o.op === 'lt' ? field?.type === 'number' || field?.type === 'rating' : true)).map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
              </NativeSelect>
              {op?.needsValue &&
                (opts ? (
                  <NativeSelect className="h-8 min-w-0 flex-1 py-0 text-xs" value={r.value ?? ''} onChange={(e) => setRule(i, {value: e.target.value})} aria-label="Value">
                    <option value="">Pick…</option>
                    {opts.map((o) => <option key={o} value={o}>{o === 'true' ? 'Checked' : o === 'false' ? 'Not checked' : o}</option>)}
                  </NativeSelect>
                ) : (
                  <Input className="h-8 min-w-0 flex-1 text-xs" value={r.value ?? ''} onChange={(e) => setRule(i, {value: e.target.value})} placeholder="Value" aria-label="Value" />
                ))}
            </div>
          </div>
        );
      })}
      <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={add}><Plus /> Add rule</Button>
    </div>
  );
}
