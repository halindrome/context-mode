import{createRequire as W}from"node:module";import{existsSync as H,unlinkSync as w,renameSync as $}from"node:fs";import{tmpdir as Y}from"node:os";import{join as G}from"node:path";var S=class{#t;constructor(t){this.#t=t}pragma(t){let s=this.#t.prepare(`PRAGMA ${t}`).all();if(!s||s.length===0)return;if(s.length>1)return s;let i=Object.values(s[0]);return i.length===1?i[0]:s[0]}exec(t){let e="",s=null;for(let o=0;o<t.length;o++){let a=t[o];if(s)e+=a,a===s&&(s=null);else if(a==="'"||a==='"')e+=a,s=a;else if(a===";"){let u=e.trim();u&&this.#t.prepare(u).run(),e=""}else e+=a}let i=e.trim();return i&&this.#t.prepare(i).run(),this}prepare(t){let e=this.#t.prepare(t);return{run:(...s)=>e.run(...s),get:(...s)=>{let i=e.get(...s);return i===null?void 0:i},all:(...s)=>e.all(...s),iterate:(...s)=>e.iterate(...s)}}transaction(t){return this.#t.transaction(t)}close(){this.#t.close()}},v=class{#t;constructor(t){this.#t=t}pragma(t){let s=this.#t.prepare(`PRAGMA ${t}`).all();if(!s||s.length===0)return;if(s.length>1)return s;let i=Object.values(s[0]);return i.length===1?i[0]:s[0]}exec(t){return this.#t.exec(t),this}prepare(t){let e=this.#t.prepare(t);return{run:(...s)=>e.run(...s),get:(...s)=>e.get(...s),all:(...s)=>e.all(...s),iterate:(...s)=>typeof e.iterate=="function"?e.iterate(...s):e.all(...s)[Symbol.iterator]()}}transaction(t){return(...e)=>{this.#t.exec("BEGIN");try{let s=t(...e);return this.#t.exec("COMMIT"),s}catch(s){throw this.#t.exec("ROLLBACK"),s}}}close(){this.#t.close()}},l=null;function q(n){let t=null;try{return t=new n(":memory:"),t.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)"),!0}catch{return!1}finally{try{t?.close()}catch{}}}function z(){if(!l){let n=W(import.meta.url);if(globalThis.Bun){let t=n(["bun","sqlite"].join(":")).Database;l=function(s,i){let o=new t(s,{readonly:i?.readonly,create:!0}),a=new S(o);return i?.timeout&&a.pragma(`busy_timeout = ${i.timeout}`),a}}else if(process.platform==="linux"){let t=null;try{({DatabaseSync:t}=n(["node","sqlite"].join(":")))}catch{t=null}t&&q(t)?l=function(s,i){let o=new t(s,{readOnly:i?.readonly??!1});return new v(o)}:l=n("better-sqlite3")}else l=n("better-sqlite3")}return l}function D(n){n.pragma("journal_mode = WAL"),n.pragma("synchronous = NORMAL");try{n.pragma("mmap_size = 268435456")}catch{}}function O(n){if(!H(n))for(let t of["-wal","-shm"])try{w(n+t)}catch{}}function K(n){for(let t of["","-wal","-shm"])try{w(n+t)}catch{}}function N(n){try{n.pragma("wal_checkpoint(TRUNCATE)")}catch{}try{n.close()}catch{}}function I(n="context-mode"){return G(Y(),`${n}-${process.pid}.db`)}function V(n,t=[100,500,2e3]){let e;for(let s=0;s<=t.length;s++)try{return n()}catch(i){let o=i instanceof Error?i.message:String(i);if(!o.includes("SQLITE_BUSY")&&!o.includes("database is locked"))throw i;if(e=i instanceof Error?i:new Error(o),s<t.length){let a=t[s],u=Date.now();for(;Date.now()-u<a;);}}throw new Error(`SQLITE_BUSY: database is locked after ${t.length} retries. Original error: ${e?.message}`)}function Q(n){return n.includes("SQLITE_CORRUPT")||n.includes("SQLITE_NOTADB")||n.includes("database disk image is malformed")||n.includes("file is not a database")}function Z(n){let t=Date.now();for(let e of["","-wal","-shm"])try{$(n+e,`${n}${e}.corrupt-${t}`)}catch{}}var _=Symbol.for("__context_mode_live_dbs__"),R=(()=>{let n=globalThis;return n[_]||(n[_]=new Set,process.on("exit",()=>{for(let t of n[_])N(t);n[_].clear()})),n[_]})(),y=class{#t;#e;constructor(t){let e=z();this.#t=t,O(t);let s;try{s=new e(t,{timeout:3e4}),D(s)}catch(i){let o=i instanceof Error?i.message:String(i);if(Q(o)){Z(t),O(t);try{s=new e(t,{timeout:3e4}),D(s)}catch(a){throw new Error(`Failed to create fresh DB after renaming corrupt file: ${a instanceof Error?a.message:String(a)}`)}}else throw i}this.#e=s,R.add(this.#e),this.initSchema(),this.prepareStatements()}get db(){return this.#e}get dbPath(){return this.#t}close(){R.delete(this.#e),N(this.#e)}withRetry(t){return V(t)}cleanup(){R.delete(this.#e),N(this.#e),K(this.#t)}};import{createHash as p}from"node:crypto";import{execFileSync as J}from"node:child_process";import{existsSync as U,realpathSync as tt,renameSync as et}from"node:fs";import{join as x}from"node:path";var E;function T(n){let t=n.replace(/\\/g,"/");return/^\/+$/.test(t)?"/":/^[A-Za-z]:\/+$/.test(t)?`${t.slice(0,2)}/`:t.replace(/\/+$/,"")}function M(n){let t=n;try{t=tt.native(n)}catch{}let e=T(t);return process.platform==="win32"||process.platform==="darwin"?e.toLowerCase():e}function k(n,t){return J("git",["-C",n,...t],{encoding:"utf-8",timeout:2e3,stdio:["ignore","pipe","ignore"]}).trim()}function st(n){let t=k(n,["rev-parse","--show-toplevel"]);return t.length>0?T(t):null}function nt(n){let t=k(n,["worktree","list","--porcelain"]).split(/\r?\n/).find(e=>e.startsWith("worktree "))?.replace("worktree ","")?.trim();return t?T(t):null}function rt(n=process.cwd()){let t=process.env.CONTEXT_MODE_SESSION_SUFFIX;if(E&&E.projectDir===n&&E.envSuffix===t)return E.suffix;let e="";if(t!==void 0)e=t?`__${t}`:"";else try{let s=st(n),i=nt(n);if(s&&i){let o=M(s),a=M(i);o!==a&&(e=`__${p("sha256").update(o).digest("hex").slice(0,8)}`)}}catch{}return E={projectDir:n,envSuffix:t,suffix:e},e}function yt(){E=void 0}function it(n){return p("sha256").update(T(n)).digest("hex").slice(0,16)}function ot(n){let t=T(n),e=process.platform==="darwin"||process.platform==="win32"?t.toLowerCase():t;return p("sha256").update(e).digest("hex").slice(0,16)}function ht(n){return at({...n,ext:".db"})}function at(n){let{projectDir:t,sessionsDir:e,ext:s}=n,i=n.suffix??rt(t),o=ot(t),a=x(e,`${o}${i}${s}`);if(U(a))return a;let u=it(t);if(u===o)return a;let d=x(e,`${u}${i}${s}`);if(U(d))try{et(d,a)}catch{}return a}var F=1e3,B=5;function h(n){let t=Number(n);return!Number.isFinite(t)||t<=0?0:Math.floor(t)}var r={insertEvent:"insertEvent",getEvents:"getEvents",getEventsByType:"getEventsByType",getEventsByPriority:"getEventsByPriority",getEventsByTypeAndPriority:"getEventsByTypeAndPriority",getEventCount:"getEventCount",getLatestAttributedProject:"getLatestAttributedProject",checkDuplicate:"checkDuplicate",evictLowestPriority:"evictLowestPriority",updateMetaLastEvent:"updateMetaLastEvent",ensureSession:"ensureSession",getSessionStats:"getSessionStats",incrementCompactCount:"incrementCompactCount",upsertResume:"upsertResume",getResume:"getResume",markResumeConsumed:"markResumeConsumed",claimLatestUnconsumedResume:"claimLatestUnconsumedResume",deleteEvents:"deleteEvents",deleteMeta:"deleteMeta",deleteResume:"deleteResume",getOldSessions:"getOldSessions",searchEvents:"searchEvents",incrementToolCall:"incrementToolCall",getToolCallTotals:"getToolCallTotals",getToolCallByTool:"getToolCallByTool",getEventBytesSummary:"getEventBytesSummary"},P=class extends y{constructor(t){super(t?.dbPath??I("session"))}stmt(t){return this.stmts.get(t)}initSchema(){try{let e=this.db.pragma("table_xinfo(session_events)").find(s=>s.name==="data_hash");e&&e.hidden!==0&&this.db.exec("DROP TABLE session_events")}catch{}this.db.exec(`
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
    `);try{let t=this.db.pragma("table_xinfo(session_events)"),e=new Set(t.map(s=>s.name));e.has("project_dir")||this.db.exec("ALTER TABLE session_events ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''"),e.has("attribution_source")||this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_source TEXT NOT NULL DEFAULT 'unknown'"),e.has("attribution_confidence")||this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_confidence REAL NOT NULL DEFAULT 0"),e.has("bytes_avoided")||this.db.exec("ALTER TABLE session_events ADD COLUMN bytes_avoided INTEGER NOT NULL DEFAULT 0"),e.has("bytes_returned")||this.db.exec("ALTER TABLE session_events ADD COLUMN bytes_returned INTEGER NOT NULL DEFAULT 0"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(session_id, project_dir)")}catch{}}prepareStatements(){this.stmts=new Map;let t=(e,s)=>{this.stmts.set(e,this.db.prepare(s))};t(r.insertEvent,`INSERT INTO session_events (
         session_id, type, category, priority, data,
         project_dir, attribution_source, attribution_confidence,
         bytes_avoided, bytes_returned,
         source_hook, data_hash
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),t(r.getEvents,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`),t(r.getEventsByType,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`),t(r.getEventsByPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(r.getEventsByTypeAndPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(r.getEventCount,"SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?"),t(r.getLatestAttributedProject,`SELECT project_dir
       FROM session_events
       WHERE session_id = ? AND project_dir != ''
       ORDER BY id DESC
       LIMIT 1`),t(r.checkDuplicate,`SELECT 1 FROM (
         SELECT type, data_hash FROM session_events
         WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) AS recent
       WHERE recent.type = ? AND recent.data_hash = ?
       LIMIT 1`),t(r.evictLowestPriority,`DELETE FROM session_events WHERE id = (
         SELECT id FROM session_events WHERE session_id = ?
         ORDER BY priority ASC, id ASC LIMIT 1
       )`),t(r.updateMetaLastEvent,`UPDATE session_meta
       SET last_event_at = datetime('now'), event_count = event_count + 1
       WHERE session_id = ?`),t(r.ensureSession,"INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)"),t(r.getSessionStats,`SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count
       FROM session_meta WHERE session_id = ?`),t(r.incrementCompactCount,"UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?"),t(r.upsertResume,`INSERT INTO session_resume (session_id, snapshot, event_count)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         event_count = excluded.event_count,
         created_at = datetime('now'),
         consumed = 0`),t(r.getResume,"SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?"),t(r.markResumeConsumed,"UPDATE session_resume SET consumed = 1 WHERE session_id = ?"),t(r.claimLatestUnconsumedResume,`UPDATE session_resume
       SET consumed = 1
       WHERE id = (
         SELECT id FROM session_resume
         WHERE consumed = 0
           AND session_id != ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )
       RETURNING session_id, snapshot`),t(r.deleteEvents,"DELETE FROM session_events WHERE session_id = ?"),t(r.deleteMeta,"DELETE FROM session_meta WHERE session_id = ?"),t(r.deleteResume,"DELETE FROM session_resume WHERE session_id = ?"),t(r.searchEvents,`SELECT id, session_id, category, type, data, created_at
       FROM session_events
       WHERE project_dir = ?
         AND (data LIKE '%' || ? || '%' ESCAPE '\\' OR category LIKE '%' || ? || '%' ESCAPE '\\')
         AND (? IS NULL OR category = ?)
       ORDER BY id ASC
       LIMIT ?`),t(r.getOldSessions,"SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')"),t(r.incrementToolCall,`INSERT INTO tool_calls (session_id, tool, calls, bytes_returned)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(session_id, tool) DO UPDATE SET
         calls = calls + 1,
         bytes_returned = bytes_returned + excluded.bytes_returned,
         updated_at = datetime('now')`),t(r.getToolCallTotals,`SELECT COALESCE(SUM(calls), 0) AS calls,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM tool_calls WHERE session_id = ?`),t(r.getToolCallByTool,`SELECT tool, calls, bytes_returned
       FROM tool_calls WHERE session_id = ? ORDER BY calls DESC`),t(r.getEventBytesSummary,`SELECT COALESCE(SUM(bytes_avoided), 0) AS bytes_avoided,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM session_events WHERE session_id = ?`)}insertEvent(t,e,s="PostToolUse",i,o){let a=p("sha256").update(e.data).digest("hex").slice(0,16).toUpperCase(),u=String(i?.projectDir??e.project_dir??"").trim(),d=String(i?.source??e.attribution_source??"unknown"),c=Number(i?.confidence??e.attribution_confidence??0),g=Number.isFinite(c)?Math.max(0,Math.min(1,c)):0,m=h(o?.bytesAvoided),f=h(o?.bytesReturned),b=this.db.transaction(()=>{if(this.stmt(r.checkDuplicate).get(t,B,e.type,a))return;this.stmt(r.getEventCount).get(t).cnt>=F&&this.stmt(r.evictLowestPriority).run(t),this.stmt(r.insertEvent).run(t,e.type,e.category,e.priority,e.data,u,d,g,m,f,s,a),this.stmt(r.updateMetaLastEvent).run(t)});this.withRetry(()=>b())}bulkInsertEvents(t,e,s="PostToolUse",i,o){if(!e||e.length===0)return;if(e.length===1){this.insertEvent(t,e[0],s,i?.[0],o?.[0]);return}let a=e.map((d,c)=>{let g=p("sha256").update(d.data).digest("hex").slice(0,16).toUpperCase(),m=i?.[c],f=String(m?.projectDir??d.project_dir??"").trim(),b=String(m?.source??d.attribution_source??"unknown"),L=Number(m?.confidence??d.attribution_confidence??0),A=Number.isFinite(L)?Math.max(0,Math.min(1,L)):0,C=o?.[c],j=h(C?.bytesAvoided),X=h(C?.bytesReturned);return{event:d,dataHash:g,projectDir:f,attributionSource:b,attributionConfidence:A,bytesAvoided:j,bytesReturned:X}}),u=this.db.transaction(()=>{let d=this.stmt(r.getEventCount).get(t).cnt;for(let c of a)this.stmt(r.checkDuplicate).get(t,B,c.event.type,c.dataHash)||(d>=F?this.stmt(r.evictLowestPriority).run(t):d++,this.stmt(r.insertEvent).run(t,c.event.type,c.event.category,c.event.priority,c.event.data,c.projectDir,c.attributionSource,c.attributionConfidence,c.bytesAvoided,c.bytesReturned,s,c.dataHash));this.stmt(r.updateMetaLastEvent).run(t)});this.withRetry(()=>u())}getEvents(t,e){let s=e?.limit??1e3,i=e?.type,o=e?.minPriority;return i&&o!==void 0?this.stmt(r.getEventsByTypeAndPriority).all(t,i,o,s):i?this.stmt(r.getEventsByType).all(t,i,s):o!==void 0?this.stmt(r.getEventsByPriority).all(t,o,s):this.stmt(r.getEvents).all(t,s)}getEventCount(t){return this.stmt(r.getEventCount).get(t).cnt}getEventBytesSummary(t){let e=this.stmt(r.getEventBytesSummary).get(t);return{bytesAvoided:Number(e?.bytes_avoided??0),bytesReturned:Number(e?.bytes_returned??0)}}getLatestAttributedProjectDir(t){return this.stmt(r.getLatestAttributedProject).get(t)?.project_dir||null}searchEvents(t,e,s,i){try{let o=t.replace(/[%_]/g,u=>"\\"+u),a=i??null;return this.stmt(r.searchEvents).all(s,o,o,a,a,e)}catch{return[]}}ensureSession(t,e){this.stmt(r.ensureSession).run(t,e)}getSessionStats(t){return this.stmt(r.getSessionStats).get(t)??null}incrementCompactCount(t){this.stmt(r.incrementCompactCount).run(t)}upsertResume(t,e,s){this.stmt(r.upsertResume).run(t,e,s??0)}getResume(t){return this.stmt(r.getResume).get(t)??null}markResumeConsumed(t){this.stmt(r.markResumeConsumed).run(t)}claimLatestUnconsumedResume(t){let e=this.stmt(r.claimLatestUnconsumedResume).get(t);return e?{sessionId:e.session_id,snapshot:e.snapshot}:null}getLatestSessionId(){try{return this.db.prepare("SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1").get()?.session_id??null}catch{return null}}incrementToolCall(t,e,s=0){let i=Number.isFinite(s)&&s>0?Math.round(s):0;try{this.stmt(r.incrementToolCall).run(t,e,i)}catch{}}getToolCallStats(t){try{let e=this.stmt(r.getToolCallTotals).get(t),s=this.stmt(r.getToolCallByTool).all(t),i={};for(let o of s)i[o.tool]={calls:o.calls,bytesReturned:o.bytes_returned};return{totalCalls:e?.calls??0,totalBytesReturned:e?.bytes_returned??0,byTool:i}}catch{return{totalCalls:0,totalBytesReturned:0,byTool:{}}}}deleteSession(t){this.db.transaction(()=>{this.stmt(r.deleteEvents).run(t),this.stmt(r.deleteResume).run(t),this.stmt(r.deleteMeta).run(t)})()}cleanupOldSessions(t=7){let e=`-${t}`,s=this.stmt(r.getOldSessions).all(e);for(let{session_id:i}of s)this.deleteSession(i);return s.length}};export{P as SessionDB,yt as _resetWorktreeSuffixCacheForTests,rt as getWorktreeSuffix,ot as hashProjectDirCanonical,it as hashProjectDirLegacy,T as normalizeWorktreePath,ht as resolveSessionDbPath,at as resolveSessionPath};
