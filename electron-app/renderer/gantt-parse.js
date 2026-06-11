// Mermaid Gantt <-> task model.
//
// A project .md file holds a fenced ```mermaid block containing a `gantt`
// diagram. This module is the single source of truth for turning that text
// into editable task objects and back, so the file on disk stays a valid
// Mermaid diagram that renders unchanged in the Gantt view.
//
// Task model:
//   {
//     name:     string,
//     assignee: string,            // team member the task is assigned to ('' =
//                                  // unassigned). Persisted as the Mermaid
//                                  // `section` line, so the Gantt bands by
//                                  // assignee and unassigned tasks live under
//                                  // an "Unassigned" section.
//     id:       string,            // stable id (auto-assigned if missing)
//     status:   'todo'|'active'|'done',
//     crit:     boolean,
//     milestone:boolean,
//     start:    string|null,       // 'YYYY-MM-DD' or 'after <ids>' or null
//     duration: string|null,       // e.g. '5d', or an end date, or null
//   }
//
// Mermaid task line grammar (after the colon, comma-separated):
//   [tags,] [id,] [start,] dur-or-end
// where the token count after removing tags decides the shape:
//   3 -> id, start, end/dur
//   2 -> start, end/dur
//   1 -> end/dur            (start = after previous task)
// See https://mermaid.js.org/syntax/gantt.html

(function (global) {
  'use strict';

  const TAGS = ['active', 'done', 'crit', 'milestone'];
  const DUR_RE = /^\d+(\.\d+)?\s*(ms|s|m|h|d|w|min)$/i;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  // Section names that mean "no assignee" — the historical default sections,
  // plus the label we serialize unassigned tasks under (so it round-trips).
  const UNASSIGNED_RE = /^(general|unassigned)$/i;
  const UNASSIGNED_LABEL = 'Unassigned';

  function normalizeAssignee(name) {
    const n = String(name || '').trim();
    return UNASSIGNED_RE.test(n) ? '' : n;
  }

  // Pull the first ```mermaid fenced block out of a markdown document.
  // Returns { before, code, after } so writers can swap the code back in
  // without disturbing the surrounding prose. code is null if absent.
  function extractMermaidBlock(md) {
    const lines = md.split('\n');
    let start = -1;
    let end = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (start === -1 && /^```\s*mermaid\s*$/i.test(t)) {
        start = i;
      } else if (start !== -1 && /^```\s*$/.test(t)) {
        end = i;
        break;
      }
    }
    if (start === -1 || end === -1) {
      return { before: md, code: null, after: '' };
    }
    return {
      before: lines.slice(0, start + 1).join('\n') + '\n',
      code: lines.slice(start + 1, end).join('\n'),
      after: '\n' + lines.slice(end).join('\n'),
    };
  }

  // Parse the inside of a gantt code block into { title, dateFormat, tasks }.
  function parseGantt(code) {
    const result = { title: '', dateFormat: 'YYYY-MM-DD', profile: '', color: '', tasks: [] };
    if (!code) return result;

    let assignee = ''; // current section -> assignee ('' = unassigned)

    // First pass collects explicit ids so auto-assigned ids (for tasks the
    // user wrote without one) never collide with a real reference target.
    const used = new Set();
    const pending = [];

    for (const raw of code.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('%%')) {
        // Comment line — capture the projector tags, ignore everything else.
        // Mermaid renders neither, so other .md/Mermaid editors stay clean.
        const pm = line.match(/^%%\s*projector:profile\s+(.+)$/i);
        if (pm) result.profile = pm[1].trim();
        const cm = line.match(/^%%\s*projector:color\s+(#[0-9a-fA-F]{3,8})/i);
        if (cm) result.color = cm[1];
        continue;
      }

      if (/^gantt\b/i.test(line)) continue;
      const titleM = line.match(/^title\s+(.*)$/i);
      if (titleM) { result.title = titleM[1].trim(); continue; }
      const dfM = line.match(/^dateFormat\s+(.*)$/i);
      if (dfM) { result.dateFormat = dfM[1].trim(); continue; }
      // Directives we keep but don't model.
      if (/^(excludes|includes|todayMarker|axisFormat|tickInterval|weekday|sectionFmt)\b/i.test(line)) {
        continue;
      }
      const secM = line.match(/^section\s+(.*)$/i);
      if (secM) { assignee = normalizeAssignee(secM[1]); continue; }

      // Everything else is a task: "Task name : meta, meta, ..."
      // Split on the LAST colon, not the first: a task name may itself contain
      // a colon (e.g. "Update website: landing page"), whereas the metadata
      // tokens after the delimiter (tags, id, YYYY-MM-DD dates, durations,
      // "after"/"until" refs) never do. Splitting on the first colon would
      // truncate such a name to the text before its own colon.
      const colon = line.lastIndexOf(':');
      if (colon === -1) continue;
      const name = line.slice(0, colon).trim();
      const metaStr = line.slice(colon + 1).trim();
      const parts = metaStr.split(',').map((s) => s.trim()).filter(Boolean);

      const task = {
        name,
        assignee,
        id: '',
        status: 'todo',
        crit: false,
        milestone: false,
        start: null,
        duration: null,
      };

      // Strip leading tag tokens.
      const rest = [];
      for (const p of parts) {
        const low = p.toLowerCase();
        if (TAGS.includes(low)) {
          if (low === 'done') task.status = 'done';
          else if (low === 'active') task.status = 'active';
          else if (low === 'crit') task.crit = true;
          else if (low === 'milestone') task.milestone = true;
        } else {
          rest.push(p);
        }
      }

      // Interpret the remaining 1-3 positional tokens.
      if (rest.length >= 3) {
        task.id = rest[0];
        task.start = rest[1];
        task.duration = rest[2];
      } else if (rest.length === 2) {
        // Could be (id, dur) or (start, dur). Mermaid treats a lone leading
        // token as the start unless it's clearly an id (not a date/after/dur).
        if (looksLikeStart(rest[0]) || looksLikeDurOrEnd(rest[1])) {
          task.start = rest[0];
          task.duration = rest[1];
        } else {
          task.id = rest[0];
          task.duration = rest[1];
        }
      } else if (rest.length === 1) {
        task.duration = rest[0];
      }

      if (task.id) used.add(task.id);
      pending.push(task);
    }

    // Second pass: hand out unique auto-ids to id-less tasks.
    let autoId = 0;
    for (const task of pending) {
      if (!task.id) {
        let candidate;
        do { candidate = `t${++autoId}`; } while (used.has(candidate));
        used.add(candidate);
        task.id = candidate;
      }
      result.tasks.push(task);
    }
    return result;
  }

  function looksLikeStart(tok) {
    return DATE_RE.test(tok) || /^after\s+/i.test(tok);
  }
  function looksLikeDurOrEnd(tok) {
    return DUR_RE.test(tok) || DATE_RE.test(tok) || /^until\s+/i.test(tok);
  }

  // Serialize a task model back into gantt code text. Canonical task line:
  //   <name> :[tags,] <id>, <start,> <duration>
  // We always emit an id so dependencies and Kanban refs stay stable.
  function serializeGantt(model) {
    const lines = ['gantt'];
    if (model.dateFormat) lines.push(`    dateFormat ${model.dateFormat}`);
    if (model.title) lines.push(`    title ${model.title}`);
    // Projector metadata travels as Mermaid comments inside the block: invisible
    // to other Mermaid renderers, and preserved across round-trips.
    if (model.profile) lines.push(`    %% projector:profile ${model.profile}`);
    if (model.color) lines.push(`    %% projector:color ${model.color}`);

    // Group tasks by assignee, preserving first-seen order. Mermaid needs a
    // section per task, so unassigned tasks are emitted under "Unassigned".
    const order = [];
    const byAssignee = new Map();
    for (const t of model.tasks) {
      const key = t.assignee || UNASSIGNED_LABEL;
      if (!byAssignee.has(key)) { byAssignee.set(key, []); order.push(key); }
      byAssignee.get(key).push(t);
    }

    for (const key of order) {
      lines.push('');
      lines.push(`    section ${key}`);
      for (const t of byAssignee.get(key)) {
        lines.push(`        ${serializeTask(t)}`);
      }
    }
    return lines.join('\n');
  }

  function serializeTask(t) {
    const tags = [];
    if (t.milestone) tags.push('milestone');
    if (t.crit) tags.push('crit');
    if (t.status === 'done') tags.push('done');
    else if (t.status === 'active') tags.push('active');

    const meta = [...tags, t.id];
    if (t.start) meta.push(t.start);
    if (t.duration) meta.push(t.duration);
    return `${t.name || 'Untitled'} :${meta.join(', ')}`;
  }

  // Swap an updated gantt model back into a full markdown document, creating
  // the fenced block if the document didn't already have one.
  function writeBackToMarkdown(md, model) {
    const code = serializeGantt(model);
    const block = extractMermaidBlock(md);
    if (block.code === null) {
      const base = md.trimEnd();
      return `${base}${base ? '\n\n' : ''}\`\`\`mermaid\n${code}\n\`\`\`\n`;
    }
    return `${block.before}${code}${block.after}`;
  }

  // ---- date / duration helpers, used by the editor and Kanban ----

  function parseDurationDays(dur) {
    if (!dur) return 1;
    const m = String(dur).match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|min)?$/i);
    if (!m) return 1;
    const n = parseFloat(m[1]);
    const unit = (m[2] || 'd').toLowerCase();
    if (unit === 'w') return n * 7;
    if (unit === 'd') return n;
    if (unit === 'h') return n / 24;
    return n; // sub-day units: treat as ~n days for display purposes
  }

  function addDays(isoDate, days) {
    const d = new Date(isoDate + 'T00:00:00');
    d.setDate(d.getDate() + Math.round(days));
    return toISO(d);
  }

  function toISO(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function todayISO() {
    return toISO(new Date());
  }

  // Resolve each task's start/end to absolute timestamps, replaying Mermaid's
  // scheduling to a fixpoint so out-of-order "after" refs and bare-duration
  // chains settle: an absolute date wins; "after a b" starts at the latest end
  // of its refs; a blank start follows the previous task in document order; a
  // date in the duration slot is an explicit end, otherwise end = start +
  // duration (milestones have zero length). Tasks whose dates never resolve
  // (e.g. an "after" pointing at an undated task) are simply absent from the
  // returned maps. Single source of truth shared by the Gantt view (span/width
  // sizing) and the PDF export (placing bars).
  function resolveSchedule(model) {
    const DAY = 86400000;
    const tasks = (model && model.tasks) || [];
    const startMs = new Map();
    const endMs = new Map();

    for (let pass = 0; pass <= tasks.length; pass++) {
      let progressed = false;
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        if (!startMs.has(t.id)) {
          let s = null;
          if (t.start && DATE_RE.test(t.start)) {
            const v = Date.parse(t.start + 'T00:00:00');
            if (!Number.isNaN(v)) s = v;
          } else if (t.start && /^after\s+/i.test(t.start)) {
            const ids = t.start.trim().split(/\s+/).slice(1);
            let mx = -Infinity;
            let ok = ids.length > 0;
            for (const id of ids) {
              if (endMs.has(id)) mx = Math.max(mx, endMs.get(id));
              else ok = false;
            }
            if (ok && Number.isFinite(mx)) s = mx;
          } else if (!t.start) {
            const prev = tasks[i - 1];
            if (prev && endMs.has(prev.id)) s = endMs.get(prev.id);
          }
          if (s != null) { startMs.set(t.id, s); progressed = true; }
        }
        if (startMs.has(t.id) && !endMs.has(t.id)) {
          let e = null;
          if (t.duration && DATE_RE.test(t.duration)) {
            const v = Date.parse(t.duration + 'T00:00:00');
            if (!Number.isNaN(v)) e = v;
          } else {
            const dur = t.milestone ? 0 : Math.max(0, parseDurationDays(t.duration));
            e = startMs.get(t.id) + dur * DAY;
          }
          if (e != null) { endMs.set(t.id, e); progressed = true; }
        }
      }
      if (!progressed) break;
    }
    return { startMs, endMs };
  }

  const api = {
    extractMermaidBlock,
    parseGantt,
    serializeGantt,
    serializeTask,
    writeBackToMarkdown,
    parseDurationDays,
    addDays,
    toISO,
    todayISO,
    resolveSchedule,
    DATE_RE,
    DUR_RE,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.GanttParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
