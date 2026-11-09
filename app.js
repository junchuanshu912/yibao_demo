/* 医保合规证据复核台：原生 JS，无外部依赖。 */
(function () {
  "use strict";
  // 全局错误提示：便于排查「点击无反应」等异常
  window.onerror = function (msg, src, line, col, err) {
    try {
      var t = document.getElementById("toast");
      if (t) {
        t.textContent = "页面脚本错误：" + (msg || (err && err.message) || "未知错误") + (line ? "（第 " + line + " 行）" : "");
        t.classList.add("show");
        clearTimeout(t._timer);
        t._timer = setTimeout(function () { t.classList.remove("show"); }, 6000);
      }
    } catch (e) {}
    return false;
  };
  var DATA = null, curPatient = null, curBillIdx = null;
  var curDrawer = { billIdx: null, eviIdx: null, docId: null, evidences: [], docEvs: [] };
  var edits = {};                     // patientId -> { docId: true } 记录未确认保存的修改
  var editState = { editing: false }; // 文书是否处于编辑态
  var docSnapshots = {};              // patientId|docId -> { lineNo: text } 打开时的原文快照
  var editHistory = [];               // 修改历史记录
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c];
    });
  }
  function truncate(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  function money(n) { return "￥" + Number(n || 0).toFixed(2); }
  function silverChip(s, adjusted) {
    var cls = s === "违规" ? "chip-red" : s === "存疑" ? "chip-amber" : s === "自费" ? "chip-blue" : "chip-green";
    var prefix = s === "已修复" ? "复核后" : (adjusted ? "人工 · " : "银海 · ");
    return '<span class="chip ' + cls + '">' + prefix + ' · ' + esc(s) + '</span>';
  }
  function currentSilverStatus(p, idx) {
    return p._adjusted && p._adjusted[idx] ? p._adjusted[idx] : p.bill[idx].silver_status;
  }
  function aiChip(s) {
    var cls = s === "有支持证据" ? "chip-red" : s === "有明确反证" ? "chip-green" : s === "已修复" ? "chip-green" : "chip-amber";
    return '<span class="chip ' + cls + '">' + esc(s) + '</span>';
  }
  function stateClass(s) {
    return s === "有支持证据" ? "support" : s === "有明确反证" ? "contrary" : s === "已修复" ? "contrary" : "unknown";
  }
  function roleName(role) {
    return {candidate: "候选证据", context: "关联事实", missing: "诊断区域", support: "反证定位", hit: "关键证据"}[role] || "证据";
  }
  function highlight(line, quote) {
    var text = String(line || ""), q = String(quote || ""), i = text.indexOf(q);
    if (!q || i < 0) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(q) + "</mark>" + esc(text.slice(i + q.length));
  }

  function primaryReference(ai) {
    var refs = ai.references || [];
    return refs.filter(function (r) { return (r.type || "").indexOf("ICD") < 0; })[0] || refs[0] || null;
  }
  function basisInline(ai) {
    var r = primaryReference(ai);
    if (!r) return '<div class="basis-inline missing">尚未配置对应审核依据，请人工补充核验。</div>';
    return '<div class="basis-inline"><div class="basis-inline-head"><span>对应违规依据</span><b>' + esc(r.type) + ' · ' + esc(r.version || "") + '</b></div>' +
      '<div class="basis-inline-clause">' + esc(r.clause) + '</div>' +
      '<div class="basis-inline-source">' + esc(r.issuer || "") + '｜' + esc(r.source_locator || "") + '</div></div>';
  }

  function bootFrom(d) {
    DATA = d;
    $("hd-info").textContent = d.hospital.name + " · " + d.hospital.level;
    $("patient-total").textContent = d.patients.length;
    $("llm-status").textContent = "离线预计算 · 无实时模型";
    renderPatients();
    if (d.patients.length) {
      var params = new URLSearchParams(window.location.search);
      var requested = params.get("patient");
      var initial = requested ? d.patients.filter(function (p) { return p.id === requested; })[0] : null;
      selectPatient(initial || d.patients[0]);
      var evidence = params.get("evidence");
      var reference = params.get("reference");
      var selected = params.get("select");
      if (selected !== null) selectBill(+selected, false);
      if (evidence) {
        var pair = evidence.split(":");
        setTimeout(function () { openEvidence(+pair[0], +(pair[1] || 0)); }, 50);
      } else if (reference !== null) {
        setTimeout(function () { openReferences(+reference); }, 50);
      }
    }
  }

  function inlineData() {
    var el = document.getElementById("ui-data");
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  }

  fetch("data/ui_data.json").then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function (d) {
    bootFrom(d);
  }).catch(function (e) {
    var d = inlineData();
    if (d) {
      bootFrom(d);
      var st = $("llm-status");
      st.textContent = "离线模式 · 内置演示数据";
      st.classList.add("off");
    } else {
      $("patient-list").innerHTML = '<div class="empty-evidence">数据加载失败：' + esc(e.message) +
        '<br>请通过 HTTP 服务访问（如 python -m http.server），或部署到 GitHub Pages。</div>';
    }
  });

  function filteredPatients() {
    var kw = $("patient-search").value.trim().toLowerCase();
    var filter = $("patient-filter").value;
    return DATA.patients.filter(function (p) {
      var text = [p.name, p.department, p.id, p.diagnoses.join(" ")].join(" ").toLowerCase();
      if (kw && text.indexOf(kw) < 0) return false;
      if (filter === "通过") return p.bill.every(function (b) { return b.silver_status === "通过" || b.silver_status === "已修复"; });
      if (filter !== "all") return p.bill.some(function (b) { return b.silver_status === filter; });
      return true;
    });
  }

  function renderPatients() {
    var list = filteredPatients(), box = $("patient-list");
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = '<div class="empty-evidence">没有符合当前条件的患者</div>';
      return;
    }
    list.forEach(function (p) {
      var nv = p.bill.filter(function (b) { return b.silver_status === "违规"; }).length;
      var nc = p.bill.filter(function (b) { return b.silver_status === "存疑"; }).length;
      var nf = p.bill.filter(function (b) { return b.silver_status === "已修复"; }).length;
      var card = document.createElement("div");
      card.className = "patient-card" + (curPatient && curPatient.id === p.id ? " active" : "");
      card.setAttribute("data-id", p.id);
      card.innerHTML = '<div class="pc-top"><span class="pc-name">' + esc(p.name) + '</span><span class="pc-id">' + esc(p.id.toUpperCase()) + '</span></div>' +
        '<div class="pc-meta">' + esc(p.sex) + ' · ' + p.age + ' 岁 · ' + esc(p.department || "未分科") + '</div>' +
        '<div class="pc-diagnosis">' + esc(p.diagnoses.join("；")) + '</div>' +
        '<div class="pc-badges">' + (nv ? '<span class="mini-badge mini-red">违规 ' + nv + '</span>' : '') +
        (nc ? '<span class="mini-badge mini-amber">存疑 ' + nc + '</span>' : '') +
        (nf ? '<span class="mini-badge mini-green">已修复 ' + nf + '</span>' : '') +
        (!nv && !nc && !nf ? '<span class="mini-badge mini-green">全部通过</span>' : '') + '</div>';
      card.onclick = function () { selectPatient(p); };
      box.appendChild(card);
    });
  }

  function selectPatient(p) {
    curPatient = p;
    curBillIdx = null;
    closeDrawer();
    snapshotPatient(p.id);
    renderPatients();
    $("crumb-dept").textContent = p.department || "未分科";
    $("crumb-id").textContent = p.id.toUpperCase();
    $("patient-name").textContent = p.name;
    $("patient-basic").textContent = p.sex + " · " + p.age + " 岁 · " + (p.department || "");
    $("patient-diagnosis").textContent = "诊断：" + p.diagnoses.join("；");
    $("patient-date").textContent = p.admit_date;
    $("document-count").textContent = Object.keys(p.emr).length + " 份病历文书";
    renderStats();
    renderClues();
  }

  function renderStats() {
    var counts = {"违规": 0, "存疑": 0, "自费": 0, "通过": 0, "已修复": 0};
    curPatient.bill.forEach(function (b, idx) {
      var status = currentSilverStatus(curPatient, idx);
      counts[status] = (counts[status] || 0) + 1;
    });
    var specs = [
      ["审核项目", curPatient.bill.length, "blue"], ["违规", counts["违规"], "red"],
      ["存疑", counts["存疑"], "amber"], ["已修复", counts["已修复"], "green"], ["通过", counts["通过"], "green"]
    ];
    $("patient-stats").innerHTML = specs.map(function (s) {
      return '<div class="stat-card ' + s[2] + '"><span>' + s[0] + '</span><b>' + s[1] + '</b></div>';
    }).join("");
  }

  function renderClues() {
    var rows = curPatient.bill.map(function (b, idx) {
      var clickable = !!b.ai, current = currentSilverStatus(curPatient, idx);
      var adjusted = current !== b.silver_status;
      var statusCell = silverChip(current, adjusted) +
        (adjusted ? '<div class="original-result">银海原结果：' + esc(b.silver_status) + '</div>' : '');
      return '<tr class="silver-row' + (clickable ? ' clickable' : '') + (curBillIdx === idx ? ' selected' : '') + '"' +
        (clickable ? ' data-bill="' + idx + '"' : '') + '>' +
        '<td><div class="silver-item">' + esc(b.item) + '</div></td><td class="silver-amount">' + money(b.amount) + '</td>' +
        '<td>' + statusCell + '</td><td class="silver-clause">' + esc(b.clause || "—") + '</td>' +
        '<td class="silver-action"><div class="audit-actions">' +
        (clickable ? '<button class="locate-btn" data-open-bill="' + idx + '">证据定位</button>' : '') +
        '<button class="selfpay-btn' + (current === "自费" ? ' current' : '') + '" data-adjust="自费" data-idx="' + idx + '">自费</button>' +
        '<button class="pass-btn' + (current === "通过" ? ' current' : '') + '" data-adjust="通过" data-idx="' + idx + '">通过</button>' +
        '</div></td></tr>';
    }).join("");
    $("clue-list").innerHTML = '<div class="silver-table-wrap"><table class="silver-table"><thead><tr>' +
      '<th>医保项目</th><th>金额</th><th>银海审核结果</th><th>银海判定违规／存疑条款</th><th>操作</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div id="clue-detail" class="clue-detail"><div class="detail-placeholder"><b>请选择需要复核的项目</b>' +
      '<span>点击上方违规或存疑项目后，在此查看我们的证据定位、复核提示与审核依据</span></div></div>';
    document.querySelectorAll(".silver-row[data-bill]").forEach(function (el) {
      el.onclick = function () { selectBill(+el.getAttribute("data-bill"), true); };
    });
    document.querySelectorAll("[data-adjust]").forEach(function (el) {
      el.onclick = function (event) {
        event.stopPropagation();
        adjustResult(+el.getAttribute("data-idx"), el.getAttribute("data-adjust"));
      };
    });
    if (curBillIdx !== null) renderClueDetail(curBillIdx);
  }

  function adjustResult(idx, status) {
    if (!curPatient._adjusted) curPatient._adjusted = {};
    curPatient._adjusted[idx] = status;
    renderStats();
    renderClues();
  }

  function selectBill(idx, scroll) {
    curBillIdx = idx;
    document.querySelectorAll(".silver-row").forEach(function (row) {
      row.classList.toggle("selected", +row.getAttribute("data-bill") === idx);
    });
    renderClueDetail(idx);
    if (scroll) setTimeout(function () {
      $("clue-detail").scrollIntoView({behavior: "smooth", block: "start"});
    }, 50);
  }

  function renderClueDetail(idx) {
    var b = curPatient.bill[idx], box = $("clue-detail");
    if (!b.ai) {
      box.innerHTML = '<div class="detail-placeholder"><b>' + esc(b.item) + ' · 银海审核通过</b><span>当前项目没有违规或存疑线索，无需证据定位。</span></div>';
      return;
    }
    var ai = b.ai, state = ai.three_state;
    var fixed = b.silver_status === "已修复";
    var conflict = (ai.references || []).filter(function (r) { return r.conflict; });
    var evidences = ai.evidences.map(function (ev, evi) {
      return '<article class="evidence-card" data-evi="' + evi + '" data-bill="' + idx + '">' +
        '<div class="ev-meta"><span class="ev-doc">' + esc(ev.type || ev.file) + '</span><span>第 ' + ev.line_no + ' 行</span>' +
        '<span>字符 ' + ev.char_start + '–' + ev.char_end + '</span><span class="ev-role">' + roleName(ev.role) + '</span></div>' +
        '<div class="ev-context">' + highlight(ev.line_text, ev.quote) + '</div>' +
        '<div class="ev-note">' + esc(ev.note || "原文位置已通过逐字校验") + '</div>' +
        '<div class="ev-open">查看完整文书与上下文 →</div></article>';
    }).join("");
    box.innerHTML = '<article class="clue-card selected-clue">' +
      '<div class="clue-top"><span class="clue-id">证据复核</span><span class="clue-item">' + esc(b.item) + '</span>' +
      '<span class="amount">' + money(b.amount) + '</span>' + silverChip(b.silver_status) + '</div>' +
      '<div class="clue-body"><div class="ai-summary ' + stateClass(state) + '"><div class="ai-title">' + aiChip(state) +
      '<span class="path-tag">' + (fixed ? '已修复 · 符合支付限定' : esc(ai.path) + '路径 · 辅助复核，非最终结论') + '</span></div>' +
      '<div class="ai-explain">' + esc(fixed ? '问题已解决：相关病历已按要求修改，本线索复核通过。' : ai.explanation) + '</div></div>' + basisInline(ai) +
      (conflict.length ? '<div class="conflict"><b>审核口径差异 · 需医保办确认</b>' + esc(conflict[0].conflict) + '</div>' : '') +
      '<div class="evidence-head"><h3>病历证据与完整上下文（' + ai.evidences.length + '）</h3>' +
      (state === "无法确定" && ai.path === "语义" ? '<span class="candidate-label">' +
        (ai.pipeline_note.indexOf("降级模式") >= 0 ? '仅候选证据 · 未完成 LLM 判读' : '候选证据 · 需人工复核') + '</span>' : '') + '</div>' +
      (evidences ? '<div class="evidence-grid">' + evidences + '</div>' : '<div class="empty-evidence">当前没有可定位的病历证据，请人工补充核查。</div>') +
      '<div class="clue-actions"><button class="reference-link" data-ref="' + idx + '">查看审核依据（' + (ai.references || []).length + '）→</button>' +
      '<label class="review-control">人工复核状态（仅本页）<select data-review="' + idx + '"><option>待复核</option><option>需补充材料</option><option>已转专业复核</option><option>人工已确认</option></select></label></div>' +
      '</div></article>';
    box.querySelectorAll(".evidence-card").forEach(function (el) {
      el.onclick = function () { openEvidence(+el.getAttribute("data-bill"), +el.getAttribute("data-evi")); };
    });
    box.querySelector("[data-ref]").onclick = function () { openReferences(idx); };
  }

  function showDrawer() {
    $("drawer").classList.remove("hidden");
    $("drawer-backdrop").classList.remove("hidden");
  }
  function closeDrawer() {
    $("drawer").classList.add("hidden");
    $("drawer-backdrop").classList.add("hidden");
    if (editState.editing) {
      editState.editing = false;
      var eb = $("edit-toggle");
      if (eb) { eb.textContent = "编辑"; eb.classList.remove("active"); }
    }
  }
  function switchTab(tab) {
    var evidence = tab === "evidence";
    $("tab-evidence").classList.toggle("active", evidence);
    $("tab-reference").classList.toggle("active", !evidence);
    $("drawer-evidence").classList.toggle("hidden", !evidence);
    $("drawer-reference").classList.toggle("hidden", evidence);
  }

  function renderDrawerCase(b) {
    var r = primaryReference(b.ai);
    var basisHtml = r
      ? '<div class="drawer-case-basis" data-open-ref title="点击查看完整审核依据"><span>对应依据</span>' + esc(r.type) + '：' + esc(truncate(r.clause, 46)) + '</div>'
      : '';
    $("drawer-case").innerHTML =
      '<div class="drawer-case-main"><b>' + esc(b.item) + '</b><span>' + money(b.amount) + '</span>' + silverChip(b.silver_status) + '</div>' +
      '<div class="drawer-case-clause"><span>银海条款</span>' + esc(b.clause || "—") + '</div>' + basisHtml;
    var ref = $("drawer-case").querySelector("[data-open-ref]");
    if (ref) ref.onclick = function () { openReferences(curBillIdx); };
    renderSuggestions(b);
    updateSaveBar();
  }

  function openEvidence(billIdx, eviIdx) {
    if (curBillIdx !== billIdx) selectBill(billIdx, false);
    var b = curPatient.bill[billIdx], ev = b.ai.evidences[eviIdx];
    renderDrawerCase(b);
    curDrawer.billIdx = billIdx;
    curDrawer.eviIdx = eviIdx;
    curDrawer.evidences = b.ai.evidences;
    curDrawer.docId = ev.docId;
    $("drawer-kicker").textContent = b.item + " · 原文定位";
    switchTab("evidence");
    renderReferences(b.ai.references || []);
    renderDocument(true);
    showDrawer();
  }
  function openReferences(billIdx) {
    if (curBillIdx !== billIdx) selectBill(billIdx, false);
    var b = curPatient.bill[billIdx];
    renderDrawerCase(b);
    curDrawer.billIdx = billIdx;
    curDrawer.evidences = b.ai.evidences;
    curDrawer.docId = b.ai.evidences.length ? b.ai.evidences[0].docId : curPatient.emr_order[0];
    $("drawer-kicker").textContent = b.item + " · 审核依据";
    renderReferences(b.ai.references || []);
    renderDocument(false);
    $("drawer-title").textContent = "审核依据与来源";
    switchTab("reference");
    showDrawer();
  }

  function renderDocument(scrollToEvidence) {
    var p = curPatient, select = $("document-select");
    select.innerHTML = p.emr_order.map(function (id) {
      var d = p.emr[id];
      return '<option value="' + esc(id) + '"' + (id === curDrawer.docId ? " selected" : "") + '>' + esc(d.type + "｜" + d.file) + '</option>';
    }).join("");
    var d = p.emr[curDrawer.docId];
    if (!d) return;
    $("drawer-title").textContent = d.type + " · 完整原文";
    var seen = {}, docEvs = [];
    curDrawer.evidences.forEach(function (ev) {
      if (ev.docId !== curDrawer.docId) return;
      var key = [ev.line_no, ev.char_start, ev.quote].join("|");
      if (!seen[key]) { seen[key] = true; docEvs.push(ev); }
    });
    curDrawer.docEvs = docEvs;
    $("anchor-count").textContent = "本线索在此文书 " + docEvs.length + " 处";
    $("drawer-anchors").innerHTML = docEvs.length ? docEvs.map(function (ev, i) {
      return '<button class="anchor" data-anchor="' + i + '">证据 ' + (i + 1) + ' · 第 ' + ev.line_no + ' 行 · ' + roleName(ev.role) + '</button>';
    }).join("") : '<span style="font-size:11px;color:#8796a5">本线索在此文书没有高亮位置，可阅读完整上下文</span>';
    var html = "";
    d.lines.forEach(function (ln) {
      var marks = [];
      docEvs.forEach(function (ev, i) {
        if (ev.line_no === ln.no) marks.push({start: ev.char_start, end: ev.char_end, index: i, quote: ev.quote});
      });
      marks.sort(function (a, b) { return a.start - b.start; });
      var hasIssue = marks.length > 0;
      if (editState.editing) {
        html += '<div class="doc-line' + (hasIssue ? ' has-evidence' : '') + '" data-no="' + ln.no + '">' +
          '<span class="doc-no">' + ln.no + '</span><span class="doc-text" contenteditable="true">' + esc(ln.text) + '</span></div>';
      } else {
        var text = ln.text, pos = 0, rendered = "";
        marks.forEach(function (m) {
          if (m.start < pos || text.slice(m.start, m.end) !== m.quote) return;
          rendered += esc(text.slice(pos, m.start)) + '<mark data-local="' + m.index + '">' + esc(text.slice(m.start, m.end)) + '</mark>';
          pos = m.end;
        });
        rendered += esc(text.slice(pos));
        html += '<div class="doc-line" data-no="' + ln.no + '"><span class="doc-no">' + ln.no + '</span><span class="doc-text">' + rendered + '</span></div>';
      }
    });
    $("drawer-doc").innerHTML = html;
    document.querySelectorAll("[data-anchor]").forEach(function (el) {
      el.onclick = function () {
        var i = +el.getAttribute("data-anchor");
        if (editState.editing) {
          var ev = docEvs[i];
          var lineEl = document.querySelector('#drawer-doc .doc-line[data-no="' + ev.line_no + '"]');
          if (lineEl) lineEl.scrollIntoView({behavior: "smooth", block: "center"});
        } else {
          jumpTo(i);
        }
      };
    });
    if (editState.editing) {
      document.querySelectorAll("#drawer-doc .doc-text[contenteditable]").forEach(function (el) {
        el.addEventListener("input", function () {
          var no = +el.closest(".doc-line").getAttribute("data-no");
          d.lines.forEach(function (l) { if (l.no === no) l.text = el.textContent; });
          markDirty(curPatient.id, curDrawer.docId);
        });
      });
    }
    if (scrollToEvidence && curDrawer.eviIdx != null) {
      var target = curDrawer.evidences[curDrawer.eviIdx], local = -1;
      docEvs.forEach(function (ev, i) {
        if (ev.line_no === target.line_no && ev.char_start === target.char_start && ev.quote === target.quote) local = i;
      });
      if (local >= 0) setTimeout(function () { jumpTo(local); }, 80);
    } else {
      $("drawer-doc").scrollTop = 0;
    }
  }
  function jumpTo(local) {
    var mark = document.querySelector('#drawer-doc mark[data-local="' + local + '"]');
    if (!mark) return;
    mark.scrollIntoView({behavior: "smooth", block: "center"});
    mark.classList.add("flash");
    setTimeout(function () { mark.classList.remove("flash"); }, 1300);
  }

  function renderReferences(refs) {
    $("reference-count").textContent = refs.length ? refs.length : "";
    var html = '<div class="reference-intro">审核依据与银海原始条款分开展示。医保目录／政策用于说明支付限定；ICD 与术语映射仅用于编码和语义归一，不单独作为违规依据。正式使用时须由院方确认本地适用范围、版本和生效期。</div>';
    html += refs.map(function (r) {
      var params = r.parameters && Object.keys(r.parameters).length ? Object.keys(r.parameters).map(function (k) {
        return esc(k) + "：" + esc(r.parameters[k]);
      }).join("；") : "";
      return '<article class="reference-card"><div class="reference-head"><span class="reference-type">' + esc(r.type) + '</span><span class="reference-title">' + esc(r.title) + '</span></div>' +
        '<div class="reference-body"><div class="ref-meta"><div><b>发布／维护机构</b>' + esc(r.issuer || "—") + '</div><div><b>版本／批次</b>' + esc(r.version || "—") + ' · ' + esc(r.document_no || "—") + '</div>' +
        '<div><b>规则类型</b>' + esc(r.rule_type || "术语映射") + '</div><div><b>生效与适用范围</b>' + esc(r.effective || "—") + '</div></div>' +
        '<div class="ref-clause">' + esc(r.clause || "—") + '</div>' +
        (params ? '<div class="ref-params">结构化参数：' + params + '</div>' : '') +
        '<div class="ref-source">来源文件：' + esc(r.source_file || "—") + '<br>来源位置：' + esc(r.source_locator || "—") + '</div></div>' +
        (r.conflict ? '<div class="ref-conflict"><b>口径差异：</b>' + esc(r.conflict) + '</div>' : '') + '</article>';
    }).join("");
    if (!refs.length) html += '<div class="empty-evidence">本线索尚未配置独立审核依据，请由医保办补充并核验。</div>';
    $("reference-list").innerHTML = html;
  }

  // ===== AI 修改建议 + 编辑保存 =====
  function showToast(msg) {
    var t = $("toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove("show"); }, 2400);
  }

  function copyText(text, btn) {
    function done() {
      showToast("已复制建议到剪贴板");
      if (btn) {
        var old = btn.textContent;
        btn.textContent = "已复制";
        setTimeout(function () { btn.textContent = old; }, 1600);
      }
    }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { showToast("复制失败，请手动选择复制"); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  function snapshotPatient(pid) {
    var p = DATA.patients.filter(function (x) { return x.id === pid; })[0];
    if (!p) return;
    Object.keys(p.emr).forEach(function (docId) {
      var key = pid + "|" + docId;
      if (docSnapshots[key]) return;
      var snap = {};
      p.emr[docId].lines.forEach(function (l) { snap[l.no] = l.text; });
      docSnapshots[key] = snap;
    });
  }

  function buildChanges(pid) {
    var p = DATA.patients.filter(function (x) { return x.id === pid; })[0];
    if (!p) return [];
    var changes = [];
    Object.keys(edits[pid] || {}).forEach(function (docId) {
      if (!edits[pid][docId]) return;
      var key = pid + "|" + docId;
      var snap = docSnapshots[key];
      var doc = p.emr[docId];
      if (!doc) return;
      doc.lines.forEach(function (l) {
        var oldText = snap ? snap[l.no] : undefined;
        if (oldText !== undefined && oldText !== l.text) {
          changes.push({ docId: docId, docType: doc.type, lineNo: l.no, from: oldText, to: l.text });
        }
      });
    });
    return changes;
  }

  function markDirty(pid, docId) {
    if (!edits[pid]) edits[pid] = {};
    edits[pid][docId] = true;
    updateSaveBar();
  }

  function updateSaveBar() {
    var btn = $("save-btn"), hint = $("save-hint");
    if (!btn) return;
    var map = edits[curPatient.id] || {};
    var dirty = Object.keys(map).filter(function (k) { return map[k]; });
    if (dirty.length) {
      btn.disabled = false;
      hint.textContent = "已修改 " + dirty.length + " 份文书，请人工确认后保存";
    } else {
      btn.disabled = true;
      hint.textContent = "尚未修改";
    }
  }

  function saveEdits() {
    var map = edits[curPatient.id] || {};
    var dirty = Object.keys(map).filter(function (k) { return map[k]; });
    if (!dirty.length) { showToast("暂无需要保存的修改"); return; }
    var changes = buildChanges(curPatient.id);
    var names = dirty.map(function (did) {
      return curPatient.emr[did] ? curPatient.emr[did].type : did;
    });
    // 记录修改历史
    if (changes.length) {
      editHistory.unshift({
        time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        patientId: curPatient.id,
        patientName: curPatient.name,
        item: curBillIdx != null ? curPatient.bill[curBillIdx].item : "",
        changes: changes,
        result: "待判定"
      });
      updateHistoryBadge();
    }
    // 更新快照，使下次保存只记录新变化
    dirty.forEach(function (docId) {
      var key = curPatient.id + "|" + docId;
      var snap = {};
      var doc = curPatient.emr[docId];
      if (doc) doc.lines.forEach(function (l) { snap[l.no] = l.text; });
      docSnapshots[key] = snap;
    });
    edits[curPatient.id] = {};
    updateSaveBar();
    showToast("已写回原始《" + names.join("》《") + "》，正在重新判定…");
    setTimeout(function () { rejudge(curBillIdx); }, 900);
  }

  function rejudge(idx) {
    if (idx == null || !curPatient) return;
    var b = curPatient.bill[idx];
    if (!b.ai || !b.ai.suggestions || !b.ai.suggestions.length) return;
    var allFixed = b.ai.suggestions.every(function (sg) {
      var doc = curPatient.emr[sg.docId];
      if (!doc) return false;
      var line = doc.lines.filter(function (l) { return l.no === sg.line_no; })[0];
      if (!line) return false;
      return line.text.indexOf(sg.replacement) >= 0;
    });
    var rec = editHistory[0];
    if (allFixed) {
      if (b.silver_status !== "已修复") {
        b.silver_status = "已修复";
        if (b.ai) b.ai.three_state = "已修复";
        renderPatients();
        renderStats();
        renderClues();
      }
      if (rec) rec.result = "已修复";
      showToast("✓ 重新判定完成：本线索已修复，符合支付限定");
    } else {
      if (rec) rec.result = "未修复";
      showToast("重新判定：仍有待修改项，请继续完善");
    }
  }

  function updateHistoryBadge() {
    var badge = $("history-count");
    if (badge) {
      badge.textContent = editHistory.length;
      badge.style.display = editHistory.length ? "inline-flex" : "none";
    }
  }

  function renderHistory() {
    var box = $("history-list");
    if (!box) return;
    if (!editHistory.length) {
      box.innerHTML = '<div class="empty-evidence">暂无修改记录。对病历应用 AI 建议或手动编辑并保存后，这里会记录修改历史。</div>';
      return;
    }
    box.innerHTML = editHistory.map(function (h) {
      var resultCls = h.result === "已修复" ? "hist-fixed" : h.result === "未修复" ? "hist-unfixed" : "hist-pending";
      var changes = h.changes.map(function (c) {
        return '<div class="hist-change">' +
          '<div class="hist-loc"><b>' + esc(c.docType) + '</b><span>第 ' + c.lineNo + ' 行</span></div>' +
          '<div class="hist-diff"><div class="hist-from"><i>改前</i>' + esc(c.from) + '</div>' +
          '<div class="hist-to"><i>改后</i>' + esc(c.to) + '</div></div>' +
          '</div>';
      }).join("");
      return '<div class="hist-item">' +
        '<div class="hist-top"><span class="hist-time">' + esc(h.time) + '</span>' +
        '<span class="hist-patient">' + esc(h.patientName) + '</span>' +
        '<span class="hist-item-name">' + esc(h.item) + '</span>' +
        '<span class="hist-result ' + resultCls + '">' + esc(h.result) + '</span></div>' +
        changes + '</div>';
    }).join("");
  }

  function openHistory() {
    renderHistory();
    $("history-modal").classList.remove("hidden");
    $("history-backdrop").classList.remove("hidden");
  }
  function closeHistory() {
    $("history-modal").classList.add("hidden");
    $("history-backdrop").classList.add("hidden");
  }

  function renderSuggestions(b) {
    var panel = $("suggestion-panel");
    if (!panel) return;
    var sgs = (b.ai && b.ai.suggestions) || [];
    if (!sgs.length) {
      panel.classList.add("hidden");
      if ($("sg-open-btn")) $("sg-open-btn").classList.add("hidden");
      return;
    }
    panel.classList.remove("hidden");
    panel.classList.remove("collapsed");
    if ($("sg-open-btn")) $("sg-open-btn").classList.add("hidden");
    if ($("sg-count")) $("sg-count").textContent = sgs.length;
    var body = $("sg-body");
    body.innerHTML = sgs.map(function (sg, i) {
      var applied = !!sg.applied;
      return '<div class="sg-card' + (applied ? ' applied' : '') + '">' +
        '<div class="sg-loc"><span class="sg-doc">' + esc(sg.docId) + '</span><span class="sg-line">第 ' + sg.line_no + ' 行</span>' +
        (applied ? '<span class="sg-tag">已应用</span>' : '') + '</div>' +
        '<div class="sg-row"><label>原文</label><div class="sg-orig">' + esc(sg.quote) + '</div></div>' +
        '<div class="sg-row"><label>建议</label><div class="sg-new">' + esc(sg.replacement) + '</div></div>' +
        '<div class="sg-reason">' + esc(sg.reason) + '</div>' +
        '<div class="sg-actions">' +
          '<button class="sg-btn" data-copy="' + i + '">复制建议</button>' +
          '<button class="sg-btn sg-apply" data-apply="' + i + '"' + (applied ? ' disabled' : '') + '>' + (applied ? '已应用' : '应用到文书') + '</button>' +
          '<button class="sg-btn sg-locate" data-locate="' + i + '">定位该行</button>' +
        '</div></div>';
    }).join("");
    body.querySelectorAll("[data-copy]").forEach(function (el) {
      el.onclick = function () { copyText(sgs[+el.getAttribute("data-copy")].replacement, el); };
    });
    body.querySelectorAll("[data-apply]").forEach(function (el) {
      el.onclick = function () { applySuggestion(+el.getAttribute("data-apply")); };
    });
    body.querySelectorAll("[data-locate]").forEach(function (el) {
      el.onclick = function () { locateSuggestion(+el.getAttribute("data-locate")); };
    });
  }

  function applySuggestion(i) {
    var b = curPatient.bill[curBillIdx];
    var sg = b.ai.suggestions[i];
    var doc = curPatient.emr[sg.docId];
    if (!doc) return;
    var line = null;
    doc.lines.forEach(function (l) { if (l.no === sg.line_no) line = l; });
    if (!line) { showToast("未找到目标行，请手动编辑"); return; }
    var pos = line.text.indexOf(sg.quote);
    if (pos < 0) { showToast("原文已变化，未找到可替换片段，请手动编辑"); return; }
    line.text = line.text.slice(0, pos) + sg.replacement + line.text.slice(pos + sg.quote.length);
    sg.applied = true;
    markDirty(curPatient.id, sg.docId);
    renderSuggestions(b);
    renderDocument(false);
    showToast("已应用建议，请点击「人工确认保存」写回");
    setTimeout(function () {
      var lineEl = document.querySelector('#drawer-doc .doc-line[data-no="' + sg.line_no + '"]');
      if (lineEl) { lineEl.scrollIntoView({behavior: "smooth", block: "center"}); lineEl.classList.add("flash-line"); setTimeout(function () { lineEl.classList.remove("flash-line"); }, 1300); }
    }, 80);
  }

  function locateSuggestion(i) {
    var sg = curPatient.bill[curBillIdx].ai.suggestions[i];
    curDrawer.docId = sg.docId;
    renderDocument(false);
    setTimeout(function () {
      var lineEl = document.querySelector('#drawer-doc .doc-line[data-no="' + sg.line_no + '"]');
      if (lineEl) { lineEl.scrollIntoView({behavior: "smooth", block: "center"}); lineEl.classList.add("flash-line"); setTimeout(function () { lineEl.classList.remove("flash-line"); }, 1300); }
    }, 80);
  }

  function toggleEdit() {
    editState.editing = !editState.editing;
    var btn = $("edit-toggle");
    if (btn) btn.textContent = editState.editing ? "完成编辑" : "编辑";
    if (btn) btn.classList.toggle("active", editState.editing);
    renderDocument(false);
    if (editState.editing) showToast("编辑模式：点击正文即可修改，完成后点「人工确认保存」");
  }

  $("patient-search").oninput = renderPatients;
  $("patient-filter").onchange = renderPatients;
  $("document-select").onchange = function () { curDrawer.docId = this.value; renderDocument(false); };
  $("edit-toggle").onclick = toggleEdit;
  $("save-btn").onclick = saveEdits;
  $("sg-close").onclick = function () {
    $("suggestion-panel").classList.add("collapsed");
    $("sg-open-btn").classList.remove("hidden");
  };
  $("sg-open-btn").onclick = function () {
    $("suggestion-panel").classList.remove("collapsed");
    $("sg-open-btn").classList.add("hidden");
  };
  $("tab-evidence").onclick = function () { switchTab("evidence"); };
  $("tab-reference").onclick = function () { switchTab("reference"); };
  $("drawer-close").onclick = closeDrawer;
  $("drawer-backdrop").onclick = closeDrawer;
  $("drawer-full").onclick = function () {
    var full = $("drawer").classList.toggle("fullscreen");
    this.textContent = full ? "退出全屏" : "全屏";
  };
  document.onkeydown = function (e) {
    if (e.key !== "Escape") return;
    if (!$("help-modal").classList.contains("hidden")) { hideHelp(); return; }
    if (!$("history-modal").classList.contains("hidden")) { closeHistory(); return; }
    if (!$("drawer").classList.contains("hidden")) closeDrawer();
  };

  // ---- 操作指引 ----
  function showHelp() {
    $("help-modal").classList.remove("hidden");
    $("help-backdrop").classList.remove("hidden");
  }
  function hideHelp() {
    $("help-modal").classList.add("hidden");
    $("help-backdrop").classList.add("hidden");
  }
  $("help-btn").onclick = showHelp;
  $("help-close").onclick = hideHelp;
  $("help-start").onclick = hideHelp;
  $("help-backdrop").onclick = hideHelp;
  $("history-btn").onclick = openHistory;
  $("history-close").onclick = closeHistory;
  $("history-backdrop").onclick = closeHistory;
  // 首次打开自动显示操作指引
  try {
    if (!localStorage.getItem("yb_help_seen")) {
      showHelp();
      localStorage.setItem("yb_help_seen", "1");
    }
  } catch (e) {}
})();
