'use strict';

// Synchronous, dependency-free gantt renderer. Turns the body of a ```mermaid
// gantt code block into an inline SVG chart styled to match res/projector-app's
// Gantt view (its mermaid themeVariables: grey To Do, light-blue In Progress,
// soft-green Done, orange Critical; alternating section bands; faint grid; a
// today marker). It reuses GanttParse (parse + schedule resolution) and Palette
// (per-project shading) — no mermaid, no eval, so the renderer's strict CSP and
// the live editor's synchronous innerHTML model both stay intact.
//
// window.GanttRender(code) -> HTML string (a <div class="gantt-block"> wrapping
// the <svg>). Returns a small notice element when there's nothing to schedule.

(function (global) {
  const DAY = 86400000;

  // Status palette mirrors projector-app gantt.js configure() themeVariables.
  const STATUS = {
    todo:   { fill: '#e6e6e6', stroke: '#cfcfcf' },
    active: { fill: '#bfe4f4', stroke: '#89cff0' },
    done:   { fill: '#d7ecdd', stroke: '#9ed4ae' },
  };
  const CRIT   = { fill: '#fbe4dd', stroke: '#e8694a' };
  const TODAY  = '#e8694a';
  const GRID   = '#e2e2e2';
  const BANDS  = ['#f4f6f7', '#ffffff'];
  const TEXT   = '#2a2a2a';
  const MUTED  = '#777777';
  const TITLE  = '#555555';
  const FONT   = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Fill/stroke for a task: critical wins; else a project colour (if the block
  // carries %% projector:color) shaded by status, mirroring projector's recolour;
  // else the plain status palette.
  function colorsFor(task, modelColor) {
    if (task.crit) return CRIT;
    const P = global.Palette;
    if (modelColor && P) {
      if (task.status === 'done') return { fill: '#e8e8e8', stroke: P.cardBorder(modelColor) };
      const sh = P.shade(modelColor, task.status);
      return { fill: sh.fill, stroke: sh.stroke };
    }
    return STATUS[task.status] || STATUS.todo;
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const floorDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const fmtDay = (ms) => { const d = new Date(ms); return d.getDate() + ' ' + MONTHS[d.getMonth()]; };
  const fmtMonth = (d) => MONTHS[d.getMonth()] + " '" + String(d.getFullYear()).slice(2);

  function firstMonday(t0) {
    const d = new Date(t0);
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7)); // 0 for Mon, else days to next Mon
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function monthStarts(t0, t1) {
    const out = [];
    const d = new Date(t0); d.setDate(1); d.setHours(0, 0, 0, 0);
    if (d.getTime() < t0) d.setMonth(d.getMonth() + 1);
    while (d.getTime() <= t1) { out.push(new Date(d)); d.setMonth(d.getMonth() + 1); }
    return out;
  }

  function render(code) {
    const G = global.GanttParse;
    if (!G) return '<div class="gantt-block gantt-empty">Gantt renderer unavailable.</div>';

    const model = G.parseGantt(code);
    const { startMs, endMs } = G.resolveSchedule(model);
    const tasks = (model.tasks || []).filter((t) => startMs.has(t.id) && endMs.has(t.id));
    if (!tasks.length) {
      return '<div class="gantt-block gantt-empty">No dated gantt tasks to chart yet.</div>';
    }

    // Day-aligned domain with a day of lead/trail and a sane minimum span.
    let t0 = Infinity, t1 = -Infinity;
    for (const t of tasks) { t0 = Math.min(t0, startMs.get(t.id)); t1 = Math.max(t1, endMs.get(t.id)); }
    t0 = floorDay(t0) - DAY;
    t1 = floorDay(t1 + DAY - 1) + DAY;
    let days = Math.max(14, Math.round((t1 - t0) / DAY));
    t1 = t0 + days * DAY;

    let pxPerDay, weekly;
    if (days <= 70)        { pxPerDay = Math.min(26, Math.max(11, 900 / days)); weekly = true; }
    else if (days <= 730)  { pxPerDay = Math.min(8, Math.max(2.4, 1100 / days)); weekly = false; }
    else                   { pxPerDay = Math.max(1.1, 1100 / days); weekly = false; }

    const leftPad = 140, rightPad = 16, topPad = 44, botPad = 14, rowH = 30, barH = 18;
    const chartW = Math.round(days * pxPerDay);
    const H = topPad + tasks.length * rowH + botPad;
    const x = (ms) => leftPad + ((ms - t0) / DAY) * pxPerDay;

    // Group by section/assignee, first-seen order.
    const groups = []; const byKey = new Map();
    for (const t of tasks) {
      const key = t.assignee || 'Unassigned';
      if (!byKey.has(key)) { byKey.set(key, { name: key, tasks: [] }); groups.push(byKey.get(key)); }
      byKey.get(key).tasks.push(t);
    }

    // Widen the chart so a task label drawn to the right of a (short) bar isn't
    // clipped: find the rightmost label extent using the same ~7px/char heuristic
    // the inside-label test below uses, and extend W to include it (#2b). The extra
    // width simply scrolls horizontally.
    const estW = (s) => String(s).length * 7;
    let contentRight = leftPad + chartW;
    for (const g of groups) for (const t of g.tasks) {
      const s = startMs.get(t.id), e = endMs.get(t.id);
      if (t.milestone) {
        contentRight = Math.max(contentRight, x(s) + barH / 2 + 6 + estW(t.name));
      } else {
        const bw = Math.max(3, x(e) - x(s));
        const inside = bw > t.name.length * 7 + 12;
        contentRight = Math.max(contentRight, inside ? x(s) + bw : x(s) + bw + 6 + estW(t.name));
      }
    }
    const W = Math.round(Math.max(leftPad + chartW + rightPad, contentRight + rightPad));

    const p = [];
    p.push(`<svg class="gantt-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" `
         + `xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">`);

    if (model.title) {
      p.push(`<text x="${leftPad}" y="20" fill="${TITLE}" font-size="14" font-weight="600">${esc(model.title)}</text>`);
    }

    // Section bands (alternating) behind everything.
    let r = 0;
    groups.forEach((g, gi) => {
      p.push(`<rect x="0" y="${topPad + r * rowH}" width="${W}" height="${g.tasks.length * rowH}" fill="${BANDS[gi % 2]}"/>`);
      r += g.tasks.length;
    });

    // Gridlines + date axis labels.
    const ticks = [];
    if (weekly) {
      for (let ms = firstMonday(t0); ms <= t1; ms += 7 * DAY) ticks.push({ ms, label: fmtDay(ms) });
    } else {
      for (const d of monthStarts(t0, t1)) ticks.push({ ms: d.getTime(), label: fmtMonth(d) });
    }
    for (const tk of ticks) {
      const gx = x(tk.ms).toFixed(1);
      p.push(`<line x1="${gx}" y1="${topPad}" x2="${gx}" y2="${H - botPad}" stroke="${GRID}" stroke-width="1"/>`);
      p.push(`<text x="${(x(tk.ms) + 4).toFixed(1)}" y="${topPad - 9}" fill="${MUTED}" font-size="11">${esc(tk.label)}</text>`);
    }
    // Gutter divider.
    p.push(`<line x1="${leftPad}" y1="${topPad}" x2="${leftPad}" y2="${H - botPad}" stroke="${GRID}" stroke-width="1"/>`);

    // Today marker.
    const now = Date.now();
    if (now >= t0 && now <= t1) {
      const tx = x(now).toFixed(1);
      p.push(`<line x1="${tx}" y1="${topPad - 4}" x2="${tx}" y2="${H - botPad}" stroke="${TODAY}" stroke-width="1.5"/>`);
    }

    // Bars + task labels + section labels.
    r = 0;
    groups.forEach((g) => {
      const gy = topPad + r * rowH, gh = g.tasks.length * rowH;
      p.push(`<text x="12" y="${(gy + gh / 2).toFixed(1)}" dominant-baseline="middle" fill="${TITLE}" `
           + `font-size="12" font-weight="600">${esc(g.name)}</text>`);
      for (const t of g.tasks) {
        const cy = topPad + r * rowH + rowH / 2;
        const c = colorsFor(t, model.color);
        const s = startMs.get(t.id), e = endMs.get(t.id);
        if (t.milestone) {
          const mx = x(s), rad = barH / 2;
          p.push(`<path d="M ${mx.toFixed(1)} ${(cy - rad).toFixed(1)} L ${(mx + rad).toFixed(1)} ${cy.toFixed(1)} `
               + `L ${mx.toFixed(1)} ${(cy + rad).toFixed(1)} L ${(mx - rad).toFixed(1)} ${cy.toFixed(1)} Z" `
               + `fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>`);
          p.push(`<text x="${(mx + rad + 6).toFixed(1)}" y="${cy.toFixed(1)}" dominant-baseline="middle" fill="${TEXT}" font-size="12">${esc(t.name)}</text>`);
        } else {
          const bx = x(s), bw = Math.max(3, x(e) - x(s)), by = cy - barH / 2;
          p.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${barH}" `
               + `rx="3" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/>`);
          const inside = bw > t.name.length * 7 + 12;
          const lx = inside ? bx + 8 : bx + bw + 6;
          p.push(`<text x="${lx.toFixed(1)}" y="${cy.toFixed(1)}" dominant-baseline="middle" fill="${TEXT}" font-size="12">${esc(t.name)}</text>`);
        }
        r++;
      }
    });

    p.push('</svg>');
    return `<div class="gantt-block">${p.join('')}</div>`;
  }

  global.GanttRender = render;
})(window);
