import { Archive } from '../../core/src/index.js';
import { ArchiveError, capabilities, str, assert, LIMITS } from '../../protocol/src/index.js';
export function dispatch(a: Archive, method: string, p: Record<string, any>): unknown {
  switch(method) {
    case 'capabilities': return capabilities();
    case 'registerProject': return a.registerProject(str(p.name,'name'),str(p.origin,'origin'));
    case 'registerWorkspace': return a.registerWorkspace(str(p.project_id,'project_id'),str(p.root,'root'),p.policy);
    case 'startSession': return a.startSession(str(p.workspace_id,'workspace_id'),str(p.producer,'producer'),p.capabilities);
    case 'appendEvents': return a.appendEvents(p.events);
    case 'coverage': return a.coverage(str(p.workspace_id,'workspace_id'));
    case 'createCheckpoint': return a.createCheckpoint(str(p.workspace_id,'workspace_id'),{...p,mode:p.mode});
    case 'listSessions': return a.listSessions(p);
    case 'listEvents': return a.listEvents(p);
    case 'history': return a.history(p.workspace_id,p);
    case 'getCheckpoint': return a.getCheckpoint(str(p.checkpoint_id,'checkpoint_id'));
    case 'diffCheckpoints': return a.diffCheckpoints(str(p.before,'before'),str(p.after,'after'));
    case 'materializeCheckpoint': return a.materializeCheckpoint(str(p.checkpoint_id,'checkpoint_id'),str(p.target,'target'));
    case 'forkTimeline': return a.forkTimeline(str(p.checkpoint_id,'checkpoint_id'));
    case 'bindTimeline': return a.bindTimeline(str(p.timeline_id,'timeline_id'),str(p.workspace_id,'workspace_id'));
    case 'buildResumeContext': return a.buildResumeContext(str(p.checkpoint_id,'checkpoint_id'),p.budget);
    case 'search': return a.listEvents({...p,query:str(p.query,'query')});
    case 'getAction': return a.getAction(str(p.session_id,'session_id'),str(p.action_id,'action_id'));
    case 'listActions': return a.listActions(p);
    case 'putAttachment': {
      assert(typeof p.base64==='string','Expected base64 attachment');const encoded=p.base64;
      assert(encoded.length<=Math.ceil(LIMITS.attachment/3)*4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded),'Invalid or oversized base64 attachment','LIMIT_EXCEEDED');
      const bytes=Buffer.from(encoded,'base64'); assert(bytes.toString('base64')===encoded,'Noncanonical base64');return a.putAttachment(bytes,str(p.media_type,'media_type'));
    }
    case 'getAttachment': return a.getAttachment(str(p.hash,'hash'));
    case 'recordProvenance': return a.recordProvenance({source_event_id:p.source_event_id,checkpoint_id:p.checkpoint_id,relation:p.relation,method:p.method,certainty:p.certainty,...(p.path===undefined?{}:{path:p.path})});
    case 'listProvenance': return a.listProvenance(str(p.checkpoint_id,'checkpoint_id'));
    case 'getOperation': return a.getOperation(str(p.operation_id,'operation_id'));
    case 'status': return a.status();
    case 'verify': case 'doctor': return a.verify();
    case 'exportArchive': return a.exportArchive(str(p.target,'target'));
    case 'importArchive': return a.importArchive(str(p.source,'source'));
    case 'backup': return a.store.backup(str(p.target,'target'));
    default: throw new ArchiveError('INVALID_REQUEST','Unknown operation');
  }
}
