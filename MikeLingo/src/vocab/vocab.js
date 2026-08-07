import '../common/shared.js';
import { schedule, describeInterval, describeDue, GRADES } from '../common/schedule.js';

const DST = globalThis.DST;

const el = (id) => document.getElementById(id);

const ui = {
  statTotal: el('statTotal'),
  statDue: el('statDue'),
  statNew: el('statNew'),
  statLearning: el('statLearning'),
  statMastered: el('statMastered'),
  tabList: el('tabList'),
  tabReview: el('tabReview'),
  tabReviewBadge: el('tabReviewBadge'),
  viewList: el('viewList'),
  viewReview: el('viewReview'),
  search: el('searchInput'),
  filter: el('filterSelect'),
  sort: el('sortSelect'),
  listMeta: el('listMeta'),
  list: el('wordList'),
  listEmpty: el('listEmpty'),
  tpl: el('wordTpl'),
  exportJson: el('exportJson'),
  exportCsv: el('exportCsv'),
  importBtn: el('importBtn'),
  importFile: el('importFile'),
  clearBtn: el('clearBtn'),
  ioResult: el('ioResult'),
  reviewCard: el('reviewCard'),
  reviewDone: el('reviewDone'),
  reviewDoneTitle: el('reviewDoneTitle'),
  reviewDoneDesc: el('reviewDoneDesc'),
  reviewProgress: el('reviewProgress'),
  reviewStatus: el('reviewStatus'),
  reviewWord: el('reviewWord'),
  reviewPhonetic: el('reviewPhonetic'),
  reviewSpeak: el('reviewSpeak'),
  speakHint: el('speakHint'),
  revealBtn: el('revealBtn'),
  reviewAnswer: el('reviewAnswer'),
  reviewTranslation: el('reviewTranslation'),
  reviewExplain: el('reviewExplain'),
  reviewContext: el('reviewContext'),
  reviewSource: el('reviewSource'),
  reviewRestart: el('reviewRestart'),
  backToList: el('backToList')
};

const STATUS_TEXT = { new: '新词', learning: '学习中', mastered: '已掌握' };

async function send(message) {
  try {
    const res = await chrome.runtime.sendMessage(message);
    return res || { ok: false, error: '扩展后台无响应，请刷新页面重试' };
  } catch (err) {
    return { ok: false, error: `扩展后台连接失败：${err?.message || err}` };
  }
}

/* --------------------------------- 概况 --------------------------------- */

async function refreshStats() {
  const res = await send({ type: 'VOCAB_STATS' });
  if (!res.ok) return;
  const s = res.stats;
  ui.statTotal.textContent = s.total;
  ui.statDue.textContent = s.due;
  ui.statNew.textContent = s.new;
  ui.statLearning.textContent = s.learning;
  ui.statMastered.textContent = s.mastered;
  ui.tabReviewBadge.hidden = !s.due;
  ui.tabReviewBadge.textContent = s.due;
}

/* --------------------------------- 朗读 --------------------------------- */

async function speak(btn, entry, hintEl) {
  btn.disabled = true;
  btn.classList.add('playing');
  if (hintEl) hintEl.textContent = '';
  const res = await send({ type: 'SPEAK', text: entry.word, audioUrl: entry.audioUrl || '' });
  btn.disabled = false;
  setTimeout(() => btn.classList.remove('playing'), 700);
  if (!res.ok && hintEl) hintEl.textContent = res.error || '朗读失败';
}

/* --------------------------------- 词表 --------------------------------- */

let listTimer = 0;

async function refreshList() {
  const query = {
    search: ui.search.value.trim(),
    filter: ui.filter.value,
    sort: ui.sort.value,
    limit: 500
  };
  const res = await send({ type: 'VOCAB_LIST', query });
  if (!res.ok) {
    ui.listMeta.textContent = res.error || '读取生词本失败';
    return;
  }

  ui.list.innerHTML = '';
  const shown = res.items.length;
  ui.listMeta.textContent = shown
    ? `共 ${res.total} 条${shown < res.total ? `，显示前 ${shown} 条` : ''}`
    : '';
  ui.listEmpty.hidden = shown > 0;
  if (query.search && !shown) {
    ui.listEmpty.hidden = false;
    ui.listEmpty.textContent = `没有匹配「${query.search}」的生词。`;
  } else if (!query.search) {
    ui.listEmpty.textContent = '还没有生词。在网页上选中单词，卡片里点「加入生词本」就会出现在这里。';
  }

  for (const entry of res.items) ui.list.appendChild(renderWord(entry));
}

function renderWord(entry) {
  const node = ui.tpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.w-text').textContent = entry.word;
  node.querySelector('.w-phonetic').textContent = entry.phonetic || '';
  node.querySelector('.w-translation').textContent = entry.translation || '（没有译文）';

  // 详解默认折叠：词表要一眼扫完，展开的详解会把列表撑得读不下去
  const explainHtml = DST.explainHtml(entry.explain);
  const explain = node.querySelector('.w-explain');
  explain.hidden = !explainHtml;
  if (explainHtml) explain.querySelector('.w-explain-body').innerHTML = explainHtml;

  node.querySelector('.w-context').textContent = entry.context || '';

  const status = node.querySelector('.w-status');
  status.textContent = STATUS_TEXT[entry.status] || '';
  status.classList.add(`is-${entry.status}`);

  node.querySelector('.w-due').textContent = `${describeDue(entry.due)} · 复习 ${entry.reps} 次`;

  const source = node.querySelector('.w-source');
  if (entry.sourceUrl) {
    source.hidden = false;
    source.href = entry.sourceUrl;
    source.textContent = entry.sourceTitle || new URL(entry.sourceUrl).hostname;
    source.title = entry.sourceUrl;
  }

  node.querySelector('.w-speak').addEventListener('click', (e) => speak(e.currentTarget, entry, null));
  node.querySelector('.w-remove').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const res = await send({ type: 'VOCAB_REMOVE', key: entry.key });
    if (!res.ok) {
      btn.disabled = false;
      btn.textContent = '删除失败';
      return;
    }
    node.remove();
    await refreshStats();
    await refreshList();
  });
  return node;
}

/* --------------------------------- 复习 --------------------------------- */

const review = { queue: [], index: 0, total: 0, revealed: false };

function currentCard() {
  return review.queue[review.index] || null;
}

async function startReview() {
  const res = await send({ type: 'VOCAB_DUE', limit: 100 });
  if (!res.ok) {
    ui.reviewDoneTitle.textContent = '读取复习队列失败';
    ui.reviewDoneDesc.textContent = res.error || '';
    ui.reviewCard.hidden = true;
    ui.reviewDone.hidden = false;
    return;
  }
  review.queue = res.items;
  review.index = 0;
  review.total = res.items.length;
  renderReview();
}

function renderReview() {
  const entry = currentCard();
  if (!entry) {
    ui.reviewCard.hidden = true;
    ui.reviewDone.hidden = false;
    const done = review.total;
    ui.reviewDoneTitle.textContent = done ? `复习完成，本轮 ${done} 条` : '今天没有要复习的词';
    ui.reviewDoneDesc.textContent = done
      ? '答「忘记」的词 10 分钟后会再出现一次，点「重新检查」可以补一轮。'
      : '继续在网页上划词收集生词，到期后会出现在这里。';
    refreshStats();
    return;
  }

  ui.reviewDone.hidden = true;
  ui.reviewCard.hidden = false;
  ui.reviewProgress.textContent = `${review.index + 1} / ${review.total}`;
  ui.reviewStatus.textContent = `${STATUS_TEXT[entry.status] || ''}${entry.reps ? ` · 已复习 ${entry.reps} 次` : ''}`;
  ui.reviewWord.textContent = entry.word;
  ui.reviewPhonetic.textContent = entry.phonetic || '';
  ui.speakHint.textContent = '';

  review.revealed = false;
  ui.reviewAnswer.hidden = true;
  ui.revealBtn.hidden = false;

  ui.reviewTranslation.textContent = entry.translation || '（没有译文）';
  // 存过详解的词，答案里连释义和例句一起给——只看一句译文很难判断自己是真记住了
  const explainHtml = DST.explainHtml(entry.explain);
  ui.reviewExplain.hidden = !explainHtml;
  ui.reviewExplain.innerHTML = explainHtml;
  ui.reviewContext.hidden = !entry.context;
  ui.reviewContext.textContent = entry.context || '';
  ui.reviewSource.hidden = !entry.sourceUrl;
  if (entry.sourceUrl) {
    ui.reviewSource.innerHTML = '';
    const link = document.createElement('a');
    link.href = entry.sourceUrl;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.textContent = entry.sourceTitle || new URL(entry.sourceUrl).hostname;
    ui.reviewSource.append('来自 ', link);
  }

  // 四个按钮各自预告下次什么时候再问，用的是后台同一份排程逻辑
  const now = Date.now();
  for (const grade of GRADES) {
    const hint = el(`grade${grade[0].toUpperCase()}${grade.slice(1)}Hint`);
    if (hint) hint.textContent = describeInterval(schedule(entry, grade, now).interval || 0);
  }
}

function reveal() {
  if (!currentCard() || review.revealed) return;
  review.revealed = true;
  ui.reviewAnswer.hidden = false;
  ui.revealBtn.hidden = true;
}

async function grade(value) {
  const entry = currentCard();
  if (!entry || !review.revealed) return;
  const buttons = ui.reviewAnswer.querySelectorAll('.grade');
  buttons.forEach((b) => (b.disabled = true));

  const res = await send({ type: 'VOCAB_GRADE', key: entry.key, grade: value });
  buttons.forEach((b) => (b.disabled = false));
  if (!res.ok) {
    ui.speakHint.textContent = res.error || '保存复习结果失败';
    return;
  }
  // 答"忘记"的词排到队尾，这一轮里还能再见一次
  if (value === 'again') review.queue.push({ ...res.entry, status: res.entry.status });
  review.index++;
  review.total = review.queue.length;
  renderReview();
}

/* -------------------------------- 导入导出 -------------------------------- */

function showIo(message, isError) {
  ui.ioResult.hidden = false;
  ui.ioResult.textContent = message;
  ui.ioResult.classList.toggle('error', Boolean(isError));
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function toCsv(words) {
  const head = ['word', 'phonetic', 'translation', 'explain', 'context', 'source', 'status', 'due', 'reps', 'createdAt'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = words.map((w) =>
    [
      w.word,
      w.phonetic,
      w.translation,
      DST.explainToText(w.explain),
      w.context,
      w.sourceUrl,
      w.reps ? (w.interval >= 21 ? 'mastered' : 'learning') : 'new',
      new Date(w.due).toISOString(),
      w.reps,
      new Date(w.createdAt).toISOString()
    ]
      .map(esc)
      .join(',')
  );
  // Excel 打开 UTF-8 CSV 不加 BOM 会乱码，中文用户十有八九用 Excel
  return `﻿${head.join(',')}\n${rows.join('\n')}`;
}

async function exportData(format) {
  const res = await send({ type: 'VOCAB_EXPORT' });
  if (!res.ok) return showIo(res.error || '导出失败', true);
  if (!res.data.count) return showIo('生词本是空的，没有可导出的内容', true);

  if (format === 'csv') {
    download(`mike-vocab-${stamp()}.csv`, toCsv(res.data.words), 'text/csv');
  } else {
    download(`mike-vocab-${stamp()}.json`, JSON.stringify(res.data, null, 2), 'application/json');
  }
  showIo(`已导出 ${res.data.count} 条生词`);
}

async function importData(file) {
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (err) {
    return showIo(`文件解析失败：${err?.message || err}`, true);
  }
  const res = await send({ type: 'VOCAB_IMPORT', payload });
  if (!res.ok) return showIo(res.error || '导入失败', true);
  const r = res.result;
  showIo(`导入完成：新增 ${r.added} 条，合并 ${r.merged} 条${r.skipped ? `，跳过 ${r.skipped} 条` : ''}`);
  await refreshStats();
  await refreshList();
}

/* --------------------------------- 视图切换 -------------------------------- */

function switchView(view) {
  const isReview = view === 'review';
  ui.tabList.setAttribute('aria-selected', String(!isReview));
  ui.tabReview.setAttribute('aria-selected', String(isReview));
  ui.viewList.hidden = isReview;
  ui.viewReview.hidden = !isReview;
  location.hash = isReview ? '#review' : '';
  if (isReview) startReview();
  else refreshList();
}

/* ---------------------------------- 事件 ---------------------------------- */

ui.tabList.addEventListener('click', () => switchView('list'));
ui.tabReview.addEventListener('click', () => switchView('review'));

ui.search.addEventListener('input', () => {
  clearTimeout(listTimer);
  listTimer = setTimeout(refreshList, 200);
});
ui.filter.addEventListener('change', refreshList);
ui.sort.addEventListener('change', refreshList);

ui.exportJson.addEventListener('click', () => exportData('json'));
ui.exportCsv.addEventListener('click', () => exportData('csv'));
ui.importBtn.addEventListener('click', () => ui.importFile.click());
ui.importFile.addEventListener('change', async () => {
  const file = ui.importFile.files?.[0];
  ui.importFile.value = '';
  if (file) await importData(file);
});

ui.clearBtn.addEventListener('click', async () => {
  const res = await send({ type: 'VOCAB_STATS' });
  const total = res.ok ? res.stats.total : 0;
  if (!total) return showIo('生词本已经是空的', true);
  if (!confirm(`确定要删除全部 ${total} 条生词吗？这个操作不能撤销，建议先导出备份。`)) return;
  const done = await send({ type: 'VOCAB_CLEAR' });
  if (!done.ok) return showIo(done.error || '清空失败', true);
  showIo(`已清空 ${total} 条生词`);
  await refreshStats();
  await refreshList();
});

ui.reviewSpeak.addEventListener('click', (e) => {
  const entry = currentCard();
  if (entry) speak(e.currentTarget, entry, ui.speakHint);
});
ui.revealBtn.addEventListener('click', reveal);
ui.reviewAnswer.querySelectorAll('.grade').forEach((btn) => {
  btn.addEventListener('click', () => grade(btn.dataset.grade));
});
ui.reviewRestart.addEventListener('click', startReview);
ui.backToList.addEventListener('click', () => switchView('list'));

el('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

// 复习是高频操作，键盘要能一路走完：空格看答案，1-4 评分
document.addEventListener('keydown', (event) => {
  if (ui.viewReview.hidden || event.ctrlKey || event.metaKey || event.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    if (!review.revealed) reveal();
    else grade('good');
    return;
  }
  const index = Number(event.key) - 1;
  if (review.revealed && index >= 0 && index < GRADES.length) {
    event.preventDefault();
    grade(GRADES[index]);
  }
});

// 从别处（弹窗、右键菜单）切回这个标签页时数据可能已经变了，重新拉一次
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  refreshStats();
  if (ui.viewList.hidden) return;
  refreshList();
});

window.addEventListener('hashchange', () => {
  const wantReview = location.hash === '#review';
  if (wantReview !== !ui.viewReview.hidden) switchView(wantReview ? 'review' : 'list');
});

/* --------------------------------- 初始化 --------------------------------- */

(async function init() {
  await refreshStats();
  switchView(location.hash === '#review' ? 'review' : 'list');
})();
