import type { EventInput } from './index.js';
import { assert, canonical } from './index.js';
export interface Action {
  id: string; session_id: string; parent_action_id: string | null;
  external_tool_id: string | null; type: 'action' | 'tool';
  status: 'unknown' | 'open-or-interrupted' | 'completed' | 'failed' | 'conflicted';
  attribution: 'explicit' | 'correlated' | 'unknown'; events: string[];
  before_checkpoints: string[]; after_checkpoints: string[];
  started: boolean; terminal_states: string[]; metadata_conflicts: string[];
}
// Pure projection: late start events never reopen an observed terminal action.
// Conflicting observations remain visible rather than choosing by timestamps.
export function projectActions(events: EventInput[]): Map<string, Action> {
  const actions = new Map<string,Action>();
  for (const e of events) {
    if (!/^(action|tool)\.(started|completed|failed)$/.test(e.type)) continue;
    const p=e.payload;
    // Legacy v1 observations without a correlatable action ID remain events only.
    if (typeof p.action_id !== 'string') continue;
    const key=canonical([e.session_id,p.action_id]);
    let a=actions.get(key);
    if(!a) { a={id:p.action_id,session_id:e.session_id,parent_action_id:null,external_tool_id:null,type:e.type.startsWith('tool.')?'tool':'action',status:'unknown',attribution:'unknown',events:[],before_checkpoints:[],after_checkpoints:[],started:false,terminal_states:[],metadata_conflicts:[]}; actions.set(key,a); }
    a.events.push(e.id);
    for(const field of ['parent_action_id','external_tool_id'] as const) if(typeof p[field]==='string') {
      if(a[field]!==null && a[field]!==p[field]) a.metadata_conflicts.push(field); else a[field]=p[field];
    }
    if(p.attribution==='explicit'||p.attribution==='correlated') {
      if(a.attribution!=='unknown' && a.attribution!==p.attribution) a.metadata_conflicts.push('attribution'); else a.attribution=p.attribution;
    }
    if(typeof p.before_checkpoint_id==='string') a.before_checkpoints.push(p.before_checkpoint_id);
    if(typeof p.after_checkpoint_id==='string') a.after_checkpoints.push(p.after_checkpoint_id);
    if(e.type.endsWith('.started')) a.started=true;
    else a.terminal_states.push(e.type.endsWith('.completed')?'completed':'failed');
  }
  for(const a of actions.values()) {
    a.before_checkpoints=[...new Set(a.before_checkpoints)].sort();a.after_checkpoints=[...new Set(a.after_checkpoints)].sort();a.terminal_states=[...new Set(a.terminal_states)].sort();a.metadata_conflicts=[...new Set(a.metadata_conflicts)].sort();
    if(a.metadata_conflicts.includes('attribution')) a.attribution='unknown';
    if(a.metadata_conflicts.includes('parent_action_id')) a.parent_action_id=null;
    if(a.metadata_conflicts.includes('external_tool_id')) a.external_tool_id=null;
    a.status=a.metadata_conflicts.length || a.terminal_states.length>1 ? 'conflicted' : a.terminal_states.length===1 ? a.terminal_states[0] as 'completed'|'failed' : a.started ? 'open-or-interrupted' : 'unknown';
  }
  // A parent may be pending. Reject a cycle only when its nodes are present.
  const checked=new Set<string>();
  for(const start of actions.keys()) {
    const chain=new Set<string>();let key: string | undefined=start;
    while(key && actions.has(key) && !checked.has(key)) {
      assert(!chain.has(key),'Action parent cycle');chain.add(key);const a:Action=actions.get(key)!;
      key=a.parent_action_id ? canonical([a.session_id,a.parent_action_id]) : undefined;
    }
    for(const member of chain) checked.add(member);
  }
  return actions;
}
