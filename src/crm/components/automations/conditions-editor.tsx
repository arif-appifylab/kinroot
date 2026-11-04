import {Plus, Trash2} from 'lucide-react';

import {ENTITY_OF, TARGETS, targetLabel, type AutoObject, type ConditionBlock, type Conditions, type Target} from '@/lib/automations';
import type {SegmentRule, SegmentRules} from '@/lib/segments';

import {SegmentBuilder} from '../lists/segment-builder';
import {Button} from '../ui/button';
import {NativeSelect} from '../ui/form';
import {useConditionFields} from './hooks';

const FIRST_RULE: Record<Target, SegmentRule> = {
  contact: {field: 'lifecycleStage', op: 'is_any', values: []},
  company: {field: 'industry', op: 'is', value: ''},
  deal: {field: 'status', op: 'is_any', values: ['OPEN']},
  ticket: {field: 'status', op: 'is_any', values: []},
};

const newBlock = (target: Target): ConditionBlock => ({target, rules: {match: 'all', groups: [{match: 'all', rules: [FIRST_RULE[target]]}]}});

function BlockRules({target, rules, onChange}: {target: Target; rules: SegmentRules; onChange: (r: SegmentRules) => void}) {
  const fields = useConditionFields(target);
  // Contact conditions are real segment rules (every segment field, lists, activity…).
  if (target === 'contact') return <SegmentBuilder rules={rules} onChange={onChange} />;
  return <SegmentBuilder rules={rules} onChange={onChange} fields={fields} entity={target === 'ticket' ? undefined : ENTITY_OF[target]} />;
}

/**
 * Conditions over the run's record and its related records: one block per
 * record, combined with all / any. Contact blocks use the segment builder;
 * deal, company and ticket blocks the same builder over their own fields.
 */
export function ConditionsEditor({value, onChange, object, emptyText}: {value: Conditions | undefined; onChange: (c: Conditions) => void; object: AutoObject; emptyText?: string}) {
  const c = value ?? {match: 'all', blocks: []};
  const targets = TARGETS[object];
  const set = (i: number, b: ConditionBlock) => onChange({...c, blocks: c.blocks.map((x, j) => (j === i ? b : x))});
  if (!targets.length) return <p className="text-xs text-muted-foreground">This trigger has no record to check.</p>;
  return (
    <div className="grid gap-3">
      {c.blocks.length > 1 && (
        <div className="flex items-center gap-2 text-sm text-slate-600">
          Continue when
          <NativeSelect className="h-8 w-auto py-0 text-xs" value={c.match} onChange={(e) => onChange({...c, match: e.target.value as Conditions['match']})} aria-label="Match blocks">
            <option value="all">all of these match</option>
            <option value="any">any of these matches</option>
          </NativeSelect>
        </div>
      )}
      {c.blocks.length === 0 && emptyText && <p className="text-xs text-muted-foreground">{emptyText}</p>}
      {c.blocks.map((block, i) => (
        <div key={i} className="grid gap-2 rounded-xl border border-slate-200 bg-card p-3">
          <div className="flex items-center gap-2">
            <NativeSelect className="h-8 min-w-0 flex-1 py-0 text-xs font-semibold" value={block.target} onChange={(e) => set(i, newBlock(e.target.value as Target))} aria-label="Record">
              {targets.map((t) => <option key={t} value={t}>{targetLabel(object, t)}</option>)}
            </NativeSelect>
            <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => onChange({...c, blocks: c.blocks.filter((_, j) => j !== i)})} aria-label="Remove condition block"><Trash2 /></Button>
          </div>
          <BlockRules target={block.target} rules={block.rules} onChange={(rules) => set(i, {...block, rules})} />
        </div>
      ))}
      <div className="flex flex-wrap gap-1.5">
        {targets.map((t) => (
          <Button key={t} type="button" variant="secondary" size="sm" onClick={() => onChange({...c, blocks: [...c.blocks, newBlock(t)]})}>
            <Plus /> {targetLabel(object, t)}
          </Button>
        ))}
      </div>
    </div>
  );
}
