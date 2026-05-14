import{createRequire as st}from"node:module";import{existsSync as nt,unlinkSync as X,renameSync as rt}from"node:fs";import{tmpdir as W}from"node:os";import{join as it}from"node:path";import{writeFileSync as A,readFileSync as M,unlinkSync as Z}from"node:fs";import{tmpdir as tt}from"node:os";var l=class extends Error{pid;dbPath;constructor(t,e){super(`Another context-mode server is already running (PID: ${t}). Stop it before starting a new instance.`),this.name="DatabaseLockedError",this.pid=t,this.dbPath=e}};function et(n){try{return process.kill(n,0),!0}catch{return!1}}function F(n){return`${n}.lock`}function P(n){let t=tt();return n===t||n.startsWith(t+"/")||n.startsWith(t+"\\")}function k(n){let{dbPath:t}=n;if(P(t))return{skipped:!0};let e=F(t),s=String(process.pid);try{return A(e,s,{flag:"wx"}),{skipped:!1}}catch(c){if(c?.code!=="EEXIST")throw c}let r;try{r=M(e,"utf-8").trim()}catch{try{return A(e,s,{flag:"wx"}),{skipped:!1}}catch{throw new l(0,t)}}let o=Number.parseInt(r,10);if(Number.isFinite(o)&&o>0&&et(o))throw new l(o,t);A(e,s,{flag:"w"});let a;try{a=Number.parseInt(M(e,"utf-8").trim(),10)}catch{throw new l(0,t)}if(a!==process.pid)throw new l(a,t);return{skipped:!1}}function E(n){let{dbPath:t}=n;if(!P(t))try{Z(F(t))}catch{}}var C=class{#t;constructor(t){this.#t=t}pragma(t){let s=this.#t.prepare(`PRAGMA ${t}`).all();if(!s||s.length===0)return;if(s.length>1)return s;let r=Object.values(s[0]);return r.length===1?r[0]:s[0]}exec(t){let e="",s=null;for(let o=0;o<t.length;o++){let a=t[o];if(s)e+=a,a===s&&(s=null);else if(a==="'"||a==='"')e+=a,s=a;else if(a===";"){let c=e.trim();c&&this.#t.prepare(c).run(),e=""}else e+=a}let r=e.trim();return r&&this.#t.prepare(r).run(),this}prepare(t){let e=this.#t.prepare(t);return{run:(...s)=>e.run(...s),get:(...s)=>{let r=e.get(...s);return r===null?void 0:r},all:(...s)=>e.all(...s),iterate:(...s)=>e.iterate(...s)}}transaction(t){return this.#t.transaction(t)}close(){this.#t.close()}},O=class{#t;constructor(t){this.#t=t}pragma(t){let s=this.#t.prepare(`PRAGMA ${t}`).all();if(!s||s.length===0)return;if(s.length>1)return s;let r=Object.values(s[0]);return r.length===1?r[0]:s[0]}exec(t){return this.#t.exec(t),this}prepare(t){let e=this.#t.prepare(t);return{run:(...s)=>e.run(...s),get:(...s)=>e.get(...s),all:(...s)=>e.all(...s),iterate:(...s)=>typeof e.iterate=="function"?e.iterate(...s):e.all(...s)[Symbol.iterator]()}}transaction(t){return(...e)=>{this.#t.exec("BEGIN");try{let s=t(...e);return this.#t.exec("COMMIT"),s}catch(s){throw this.#t.exec("ROLLBACK"),s}}}close(){this.#t.close()}},m=null;function ot(n){let t=null;try{return t=new n(":memory:"),t.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)"),!0}catch{return!1}finally{try{t?.close()}catch{}}}function at(n,t){let e=t!==void 0?t:globalThis.Bun;if(typeof e<"u"&&e!==null)return!0;let s=n??process.versions,[r,o]=(s.node??"0.0.0").split("."),a=Number(r),c=Number(o);return!Number.isFinite(a)||!Number.isFinite(c)?!1:a>22||a===22&&c>=5}function ct(){if(!m){let n=st(import.meta.url);if(globalThis.Bun){let t=n(["bun","sqlite"].join(":")).Database;m=function(s,r){let o=new t(s,{readonly:r?.readonly,create:!0}),a=new C(o);return r?.timeout&&a.pragma(`busy_timeout = ${r.timeout}`),a}}else if(at()){let t=null;try{({DatabaseSync:t}=n(["node","sqlite"].join(":")))}catch{t=null}t&&ot(t)?m=function(s,r){let o=new t(s,{readOnly:r?.readonly??!1});return new O(o)}:m=n("better-sqlite3")}else m=n("better-sqlite3")}return m}function B(n){n.pragma("journal_mode = WAL"),n.pragma("synchronous = NORMAL");try{n.pragma("mmap_size = 268435456")}catch{}}function j(n){if(!nt(n))for(let t of["-wal","-shm"])try{X(n+t)}catch{}}function ut(n){for(let t of["","-wal","-shm"])try{X(n+t)}catch{}}function w(n){try{n.pragma("wal_checkpoint(TRUNCATE)")}catch{}try{n.close()}catch{}}function H(n="context-mode"){return it(W(),`${n}-${process.pid}.db`)}function dt(n,t=[100,500,2e3]){let e;for(let s=0;s<=t.length;s++)try{return n()}catch(r){let o=r instanceof Error?r.message:String(r);if(!o.includes("SQLITE_BUSY")&&!o.includes("database is locked"))throw r;if(e=r instanceof Error?r:new Error(o),s<t.length){let a=t[s],c=Date.now();for(;Date.now()-c<a;);}}throw new Error(`SQLITE_BUSY: database is locked after ${t.length} retries. Original error: ${e?.message}`)}function lt(n){return n.includes("SQLITE_CORRUPT")||n.includes("SQLITE_NOTADB")||n.includes("database disk image is malformed")||n.includes("file is not a database")}function Et(n){let t=Date.now();for(let e of["","-wal","-shm"])try{rt(n+e,`${n}${e}.corrupt-${t}`)}catch{}}var _=Symbol.for("__context_mode_live_dbs_v2__"),D=(()=>{let n=globalThis;return n[_]||(n[_]=new Map,process.on("exit",()=>{for(let[t,e]of n[_])w(t),E({dbPath:e});n[_].clear()})),n[_]})(),f=class{#t;#e;constructor(t){let e=ct();this.#t=t,k({dbPath:t});let s=t.startsWith(W());j(t);let r;try{if(r=new e(t,{timeout:3e4}),B(r),!s)try{r.pragma("locking_mode = EXCLUSIVE")}catch{}}catch(o){let a=o instanceof Error?o.message:String(o);if(lt(a)){Et(t),j(t);try{if(r=new e(t,{timeout:3e4}),B(r),!s)try{r.pragma("locking_mode = EXCLUSIVE")}catch{}}catch(c){throw E({dbPath:t}),new Error(`Failed to create fresh DB after renaming corrupt file: ${c instanceof Error?c.message:String(c)}`)}}else throw E({dbPath:t}),o}this.#e=r,D.set(this.#e,t),this.initSchema(),this.prepareStatements()}get db(){return this.#e}get dbPath(){return this.#t}close(){D.delete(this.#e),w(this.#e),E({dbPath:this.#t})}withRetry(t){return dt(t)}cleanup(){D.delete(this.#e),w(this.#e),ut(this.#t),E({dbPath:this.#t})}};import{createHash as y}from"node:crypto";import{execFileSync as mt}from"node:child_process";import{existsSync as S,realpathSync as pt,renameSync as I}from"node:fs";import{join as L}from"node:path";var p;function T(n){let t=n.replace(/\\/g,"/");return/^\/+$/.test(t)?"/":/^[A-Za-z]:\/+$/.test(t)?`${t.slice(0,2)}/`:t.replace(/\/+$/,"")}function $(n){let t=n;try{t=pt.native(n)}catch{}let e=T(t);return process.platform==="win32"||process.platform==="darwin"?e.toLowerCase():e}function V(n,t){return mt("git",["-C",n,...t],{encoding:"utf-8",timeout:2e3,stdio:["ignore","pipe","ignore"]}).trim()}function gt(n){let t=V(n,["rev-parse","--show-toplevel"]);return t.length>0?T(t):null}function _t(n){let t=V(n,["worktree","list","--porcelain"]).split(/\r?\n/).find(e=>e.startsWith("worktree "))?.replace("worktree ","")?.trim();return t?T(t):null}function yt(n=process.cwd()){let t=process.env.CONTEXT_MODE_SESSION_SUFFIX;if(p&&p.projectDir===n&&p.envSuffix===t)return p.suffix;let e="";if(t!==void 0)e=t?`__${t}`:"";else try{let s=gt(n),r=_t(n);if(s&&r){let o=$(s),a=$(r);o!==a&&(e=`__${y("sha256").update(o).digest("hex").slice(0,8)}`)}}catch{}return p={projectDir:n,envSuffix:t,suffix:e},e}function xt(){p=void 0}function z(n){return y("sha256").update(T(n)).digest("hex").slice(0,16)}function K(n){let t=T(n),e=process.platform==="darwin"||process.platform==="win32"?t.toLowerCase():t;return y("sha256").update(e).digest("hex").slice(0,16)}function Ut(n){let{projectDir:t,contentDir:e}=n,s=K(t),r=L(e,`${s}.db`);if(S(r))return r;let o=z(t);if(o===s)return r;let a=L(e,`${o}.db`);if(S(a))try{I(a,r);for(let c of["-wal","-shm"])try{I(a+c,r+c)}catch{}}catch{}return r}function Mt(n){return Tt({...n,ext:".db"})}function Tt(n){let{projectDir:t,sessionsDir:e,ext:s}=n,r=n.suffix??yt(t),o=K(t),a=L(e,`${o}${r}${s}`);if(S(a))return a;let c=z(t);if(c===o)return a;let d=L(e,`${c}${r}${s}`);if(S(d))try{I(d,a)}catch{}return a}var Y=1e3,G=5;function b(n){let t=Number(n);return!Number.isFinite(t)||t<=0?0:Math.floor(t)}var i={insertEvent:"insertEvent",getEvents:"getEvents",getEventsByType:"getEventsByType",getEventsByPriority:"getEventsByPriority",getEventsByTypeAndPriority:"getEventsByTypeAndPriority",getEventCount:"getEventCount",getLatestAttributedProject:"getLatestAttributedProject",checkDuplicate:"checkDuplicate",evictLowestPriority:"evictLowestPriority",updateMetaLastEvent:"updateMetaLastEvent",ensureSession:"ensureSession",getSessionStats:"getSessionStats",incrementCompactCount:"incrementCompactCount",upsertResume:"upsertResume",getResume:"getResume",markResumeConsumed:"markResumeConsumed",claimLatestUnconsumedResume:"claimLatestUnconsumedResume",deleteEvents:"deleteEvents",deleteMeta:"deleteMeta",deleteResume:"deleteResume",getOldSessions:"getOldSessions",searchEvents:"searchEvents",incrementToolCall:"incrementToolCall",getToolCallTotals:"getToolCallTotals",getToolCallByTool:"getToolCallByTool",getEventBytesSummary:"getEventBytesSummary"},q=class extends f{constructor(t){super(t?.dbPath??H("session"))}stmt(t){return this.stmts.get(t)}initSchema(){try{let e=this.db.pragma("table_xinfo(session_events)").find(s=>s.name==="data_hash");e&&e.hidden!==0&&this.db.exec("DROP TABLE session_events")}catch{}this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        data TEXT NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        attribution_source TEXT NOT NULL DEFAULT 'unknown',
        attribution_confidence REAL NOT NULL DEFAULT 0,
        bytes_avoided INTEGER NOT NULL DEFAULT 0,
        bytes_returned INTEGER NOT NULL DEFAULT 0,
        source_hook TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        data_hash TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type);
      CREATE INDEX IF NOT EXISTS idx_session_events_priority ON session_events(session_id, priority);

      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_event_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        compact_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS session_resume (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        snapshot TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        consumed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        bytes_returned INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, tool)
      );

      CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
    `);try{let t=this.db.pragma("table_xinfo(session_events)"),e=new Set(t.map(s=>s.name));e.has("project_dir")||this.db.exec("ALTER TABLE session_events ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''"),e.has("attribution_source")||this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_source TEXT NOT NULL DEFAULT 'unknown'"),e.has("attribution_confidence")||this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_confidence REAL NOT NULL DEFAULT 0"),e.has("bytes_avoided")||this.db.exec("ALTER TABLE session_events ADD COLUMN bytes_avoided INTEGER NOT NULL DEFAULT 0"),e.has("bytes_returned")||this.db.exec("ALTER TABLE session_events ADD COLUMN bytes_returned INTEGER NOT NULL DEFAULT 0"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(session_id, project_dir)")}catch{}}prepareStatements(){this.stmts=new Map;let t=(e,s)=>{this.stmts.set(e,this.db.prepare(s))};t(i.insertEvent,`INSERT INTO session_events (
         session_id, type, category, priority, data,
         project_dir, attribution_source, attribution_confidence,
         bytes_avoided, bytes_returned,
         source_hook, data_hash
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),t(i.getEvents,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`),t(i.getEventsByType,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`),t(i.getEventsByPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(i.getEventsByTypeAndPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(i.getEventCount,"SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?"),t(i.getLatestAttributedProject,`SELECT project_dir
       FROM session_events
       WHERE session_id = ? AND project_dir != ''
       ORDER BY id DESC
       LIMIT 1`),t(i.checkDuplicate,`SELECT 1 FROM (
         SELECT type, data_hash FROM session_events
         WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) AS recent
       WHERE recent.type = ? AND recent.data_hash = ?
       LIMIT 1`),t(i.evictLowestPriority,`DELETE FROM session_events WHERE id = (
         SELECT id FROM session_events WHERE session_id = ?
         ORDER BY priority ASC, id ASC LIMIT 1
       )`),t(i.updateMetaLastEvent,`UPDATE session_meta
       SET last_event_at = datetime('now'), event_count = event_count + 1
       WHERE session_id = ?`),t(i.ensureSession,"INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)"),t(i.getSessionStats,`SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count
       FROM session_meta WHERE session_id = ?`),t(i.incrementCompactCount,"UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?"),t(i.upsertResume,`INSERT INTO session_resume (session_id, snapshot, event_count)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         event_count = excluded.event_count,
         created_at = datetime('now'),
         consumed = 0`),t(i.getResume,"SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?"),t(i.markResumeConsumed,"UPDATE session_resume SET consumed = 1 WHERE session_id = ?"),t(i.claimLatestUnconsumedResume,`UPDATE session_resume
       SET consumed = 1
       WHERE id = (
         SELECT id FROM session_resume
         WHERE consumed = 0
           AND session_id != ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )
       RETURNING session_id, snapshot`),t(i.deleteEvents,"DELETE FROM session_events WHERE session_id = ?"),t(i.deleteMeta,"DELETE FROM session_meta WHERE session_id = ?"),t(i.deleteResume,"DELETE FROM session_resume WHERE session_id = ?"),t(i.searchEvents,`SELECT id, session_id, category, type, data, created_at
       FROM session_events
       WHERE project_dir = ?
         AND (data LIKE '%' || ? || '%' ESCAPE '\\' OR category LIKE '%' || ? || '%' ESCAPE '\\')
         AND (? IS NULL OR category = ?)
       ORDER BY id ASC
       LIMIT ?`),t(i.getOldSessions,"SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')"),t(i.incrementToolCall,`INSERT INTO tool_calls (session_id, tool, calls, bytes_returned)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(session_id, tool) DO UPDATE SET
         calls = calls + 1,
         bytes_returned = bytes_returned + excluded.bytes_returned,
         updated_at = datetime('now')`),t(i.getToolCallTotals,`SELECT COALESCE(SUM(calls), 0) AS calls,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM tool_calls WHERE session_id = ?`),t(i.getToolCallByTool,`SELECT tool, calls, bytes_returned
       FROM tool_calls WHERE session_id = ? ORDER BY calls DESC`),t(i.getEventBytesSummary,`SELECT COALESCE(SUM(bytes_avoided), 0) AS bytes_avoided,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM session_events WHERE session_id = ?`)}insertEvent(t,e,s="PostToolUse",r,o){let a=y("sha256").update(e.data).digest("hex").slice(0,16).toUpperCase(),c=String(r?.projectDir??e.project_dir??"").trim(),d=String(r?.source??e.attribution_source??"unknown"),u=Number(r?.confidence??e.attribution_confidence??0),h=Number.isFinite(u)?Math.max(0,Math.min(1,u)):0,g=b(o?.bytesAvoided),R=b(o?.bytesReturned),v=this.db.transaction(()=>{if(this.stmt(i.checkDuplicate).get(t,G,e.type,a))return;this.stmt(i.getEventCount).get(t).cnt>=Y&&this.stmt(i.evictLowestPriority).run(t),this.stmt(i.insertEvent).run(t,e.type,e.category,e.priority,e.data,c,d,h,g,R,s,a),this.stmt(i.updateMetaLastEvent).run(t)});this.withRetry(()=>v())}bulkInsertEvents(t,e,s="PostToolUse",r,o){if(!e||e.length===0)return;if(e.length===1){this.insertEvent(t,e[0],s,r?.[0],o?.[0]);return}let a=e.map((d,u)=>{let h=y("sha256").update(d.data).digest("hex").slice(0,16).toUpperCase(),g=r?.[u],R=String(g?.projectDir??d.project_dir??"").trim(),v=String(g?.source??d.attribution_source??"unknown"),N=Number(g?.confidence??d.attribution_confidence??0),x=Number.isFinite(N)?Math.max(0,Math.min(1,N)):0,U=o?.[u],Q=b(U?.bytesAvoided),J=b(U?.bytesReturned);return{event:d,dataHash:h,projectDir:R,attributionSource:v,attributionConfidence:x,bytesAvoided:Q,bytesReturned:J}}),c=this.db.transaction(()=>{let d=this.stmt(i.getEventCount).get(t).cnt;for(let u of a)this.stmt(i.checkDuplicate).get(t,G,u.event.type,u.dataHash)||(d>=Y?this.stmt(i.evictLowestPriority).run(t):d++,this.stmt(i.insertEvent).run(t,u.event.type,u.event.category,u.event.priority,u.event.data,u.projectDir,u.attributionSource,u.attributionConfidence,u.bytesAvoided,u.bytesReturned,s,u.dataHash));this.stmt(i.updateMetaLastEvent).run(t)});this.withRetry(()=>c())}getEvents(t,e){let s=e?.limit??1e3,r=e?.type,o=e?.minPriority;return r&&o!==void 0?this.stmt(i.getEventsByTypeAndPriority).all(t,r,o,s):r?this.stmt(i.getEventsByType).all(t,r,s):o!==void 0?this.stmt(i.getEventsByPriority).all(t,o,s):this.stmt(i.getEvents).all(t,s)}getEventCount(t){return this.stmt(i.getEventCount).get(t).cnt}getEventBytesSummary(t){let e=this.stmt(i.getEventBytesSummary).get(t);return{bytesAvoided:Number(e?.bytes_avoided??0),bytesReturned:Number(e?.bytes_returned??0)}}getLatestAttributedProjectDir(t){return this.stmt(i.getLatestAttributedProject).get(t)?.project_dir||null}searchEvents(t,e,s,r){try{let o=t.replace(/[%_]/g,c=>"\\"+c),a=r??null;return this.stmt(i.searchEvents).all(s,o,o,a,a,e)}catch{return[]}}ensureSession(t,e){this.stmt(i.ensureSession).run(t,e)}getSessionStats(t){return this.stmt(i.getSessionStats).get(t)??null}incrementCompactCount(t){this.stmt(i.incrementCompactCount).run(t)}upsertResume(t,e,s){this.stmt(i.upsertResume).run(t,e,s??0)}getResume(t){return this.stmt(i.getResume).get(t)??null}markResumeConsumed(t){this.stmt(i.markResumeConsumed).run(t)}claimLatestUnconsumedResume(t){let e=this.stmt(i.claimLatestUnconsumedResume).get(t);return e?{sessionId:e.session_id,snapshot:e.snapshot}:null}getLatestSessionId(){try{return this.db.prepare("SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1").get()?.session_id??null}catch{return null}}incrementToolCall(t,e,s=0){let r=Number.isFinite(s)&&s>0?Math.round(s):0;try{this.stmt(i.incrementToolCall).run(t,e,r)}catch{}}getToolCallStats(t){try{let e=this.stmt(i.getToolCallTotals).get(t),s=this.stmt(i.getToolCallByTool).all(t),r={};for(let o of s)r[o.tool]={calls:o.calls,bytesReturned:o.bytes_returned};return{totalCalls:e?.calls??0,totalBytesReturned:e?.bytes_returned??0,byTool:r}}catch{return{totalCalls:0,totalBytesReturned:0,byTool:{}}}}deleteSession(t){this.db.transaction(()=>{this.stmt(i.deleteEvents).run(t),this.stmt(i.deleteResume).run(t),this.stmt(i.deleteMeta).run(t)})()}cleanupOldSessions(t=7){let e=`-${t}`,s=this.stmt(i.getOldSessions).all(e);for(let{session_id:r}of s)this.deleteSession(r);return s.length}};export{q as SessionDB,xt as _resetWorktreeSuffixCacheForTests,yt as getWorktreeSuffix,K as hashProjectDirCanonical,z as hashProjectDirLegacy,T as normalizeWorktreePath,Ut as resolveContentStorePath,Mt as resolveSessionDbPath,Tt as resolveSessionPath};
