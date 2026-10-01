/* Production views adapted from the approved FLOAT AI prototype.
 * Account data comes from the API. Preferences are scoped to the signed-in user;
 * API keys and query results are retained in memory only. */
window.FloatWorkspace = function (ctx) {
  'use strict';
  const {main, el, button, field, select, icon, notify, api, mutation, show, heading,
    getSession, getPageToken, updateMe, mergeSession, allBanks, bankBrowser, types, dialog,
    readDialog, paged, download, editQuestion, confirmImport} = ctx;
  const assets = window.FloatUIAssets, avatars = assets.avatars;
  const replace = (node, ...children) => node.replaceChildren(...children.filter(item => item !== null && item !== undefined));
  const value = f => f.input.value.trim();
  const prefsKey = () => 'float-web-v2:' + (getSession()?.principal?.userId || 'guest');
  let preferenceUser = null, prefs = {}, keySession = null, catalog = null;
  let history = [], searchMode = 'search', questionTypeFilter = null;
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  function clearSecretFields() { document.querySelectorAll('input[data-model-secret]').forEach(input => { input.value = ''; }); }
  function clearModelKey() { if (keySession) keySession.apiKey = ''; keySession = null; clearSecretFields(); }
  window.addEventListener('pagehide', clearModelKey);
  function loadPreferences() {
    const id = getSession()?.principal?.userId;
    if (id === preferenceUser) return;
    preferenceUser = id; clearModelKey(); catalog = null; history = [];
    try { prefs = JSON.parse(localStorage.getItem(prefsKey()) || '{}'); } catch { prefs = {}; }
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) prefs = {};
    if (!['light', 'dark', 'system'].includes(prefs.appearance)) prefs.appearance = 'system';
    if (!avatars.some(a => a.id === prefs.avatarId)) savePreference('avatarId', avatars[Math.floor(Math.random() * avatars.length)].id);
    applyTheme();
  }
  function savePreference(name, val) {
    prefs[name] = val;
    const stored = {appearance: prefs.appearance, avatarId: prefs.avatarId, modelKey: prefs.modelKey, aiFallback: prefs.aiFallback === true};
    try { localStorage.setItem(prefsKey(), JSON.stringify(stored)); } catch { notify('当前浏览器无法记住偏好，本次仍已生效'); }
  }
  function applyTheme() {
    const dark = prefs.appearance === 'dark' || (prefs.appearance !== 'light' && systemTheme.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]').content = dark ? '#191e1a' : '#f7f8f2';
  }
  systemTheme.addEventListener('change', () => { if (prefs.appearance === 'system') applyTheme(); });
  function reset() {
    clearModelKey(); catalog = null; history = []; prefs = {}; preferenceUser = null;
    document.documentElement.dataset.theme = 'light';
  }
  const account = () => getSession()?.account || {};
  const points = () => Number(account().pointsAvailable || 0);
  function avatar() { return avatars.find(a => a.id === (account().avatarId || prefs.avatarId)) || avatars[0]; }
  function portrait(a, className = '') { return el('img', {class: 'float-avatar ' + className, src: a.src, alt: a.name, width: 72, height: 72}); }
  function iconButton(label, name, action, cls = '') {
    const b = button(label, action, 'icon-button ' + cls);
    replace(b, icon(name)); b.title = label; b.setAttribute('aria-label', label); return b;
  }
  function pageHeader(title, back = 'profile', extra = null) {
    replace(main, el('header', {class: 'float-page-header'}, iconButton('返回', 'left', () => show(back)), el('h1', {}, title), extra || el('span', {class: 'header-spacer', 'aria-hidden': 'true'})));
  }
  function menu(label, name, action, detail = '') {
    const b = button(label, action, 'float-menu-row');
    replace(b, icon(name), el('span', {}, label), detail ? el('small', {}, detail) : null, icon('right')); return b;
  }
  function rightsCard() {
    return el('section', {class: 'float-rights-card', 'aria-label': '我的权益'},
      el('div', {class: 'float-rights-top'}, el('span', {}, icon('coins'), '我的权益'), button('查看权益', () => show('benefits'), 'float-text-button')),
      el('div', {class: 'float-point-value'}, el('span', {}, '可用点数'), el('strong', {'data-points': ''}, String(points()), el('small', {}, '点'))),
      menu('兑换套餐', 'gift', () => show('redeem')));
  }
  function priceTable() {
    const rows = [
      ['豆包 Mini、豆包 Lite', 1], ['Qwen 3.5 Plus', 1], ['MiniMax M2.5、MiniMax M2.7', 1],
      ['GLM 4.7', 1], ['GLM 5.0、GLM 5-Turbo', 2], ['豆包 2.1 Pro', 2]
    ];
    return el('table', {class: 'float-price-table'}, el('caption', {}, '内置模型价目'),
      el('thead', {}, el('tr', {}, el('th', {scope: 'col'}, '模型'), el('th', {scope: 'col'}, '每次调用'))),
      el('tbody', {}, rows.map(([name, fee]) => el('tr', {}, el('th', {scope: 'row'}, name), el('td', {}, fee + ' 点')))));
  }
  function pointRules() {
    return el('section', {class: 'float-help-section'}, el('h2', {}, '点数与模型'),
      el('p', {}, el('strong', {}, '有点数，才可使用基础功能。'), '可用点数大于 0 时，可以启动悬浮窗、导入题库等；余额为 0 时，这些功能暂不可用。'),
      el('p', {}, '余额为 0 时，仍可查看已导入题库、预览已有记录和删除自己的私人题库。'),
      el('p', {}, el('strong', {}, '基础功能本身不扣点。'), '本地题库匹配不扣点，只有调用内置模型才消耗点数。'),
      priceTable(),
      el('p', {}, '按每次模型调用计算。剩余 1 点时，可以使用基础功能和 1 点模型；调用 2 点模型需要至少 2 点。'),
      el('p', {}, el('strong', {}, '自带 API Key 不扣平台点数。'), '例如自行接入 DeepSeek，费用由相应模型服务商结算。基础功能仍要求账户可用点数大于 0。'),
      el('p', {}, '内置模型可由 Coze 项目集成提供，无需你填写供应商 Key；仍按成功调用的 1／2 点档位结算。可用型号与实际名称以模型选择页为准。'),
      el('p', {class: 'muted'}, '未配置、测试未通过或暂时停用的模型不会发起调用。请求失败不扣平台点数；超时后先找回结果，避免重复发送。'));
  }
  async function profilePage(alive) {
    loadPreferences();
    const render = () => {
      const p = getSession().principal, a = account();
      replace(main, el('header', {class: 'float-profile-heading'}, el('h1', {}, 'FLOAT AI'), iconButton('客服', 'headset', () => show('support'))),
        el('section', {class: 'float-profile-summary'},
          buttonWithAvatar(() => show('avatars')),
          el('div', {}, el('h2', {}, a.displayName || p.displayName || p.phoneNumber || p.username), el('p', {class: 'muted'}, p.phoneNumber || p.username)),
          iconButton('个人资料', 'right', () => show('personal'))), rightsCard(),
        el('section', {class: 'float-menu'},
          menu('历史记录', 'history', () => show('history')),
          menu('模型选择', 'layers-2', () => show('userModels')),
          menu('外观设置', 'contrast', () => show('appearance'), {light: '亮色', dark: '暗色', system: '跟随系统'}[prefs.appearance]),
          menu('公告', 'megaphone', () => show('announcements')),
          menu('使用帮助', 'circle-help', () => show('help')),
          menu('点数明细', 'coins', () => show('ledger'))));
    };
    render(); await updateMe(); if (alive()) render();
  }
  function buttonWithAvatar(action) { const b = button('更换头像', action, 'float-avatar-button'); replace(b, portrait(avatar())); b.setAttribute('aria-label', '更换头像'); return b; }
  async function avatarsPage() {
    loadPreferences(); pageHeader('更换头像');
    const current = avatar(), selection = el('div', {class: 'float-avatar-current'}, portrait(current), el('p', {}, current.name));
    const grid = el('div', {class: 'float-avatar-grid'});
    for (const a of avatars) {
      const selected = a.id === current.id;
      const b = button(a.name, async () => {
        const result = await mutation('/v1/me/profile', {avatarId: a.id}, 'PATCH'); mergeSession(result); savePreference('avatarId', a.id);
        notify('头像已更换'); await show('avatars');
      }, 'float-avatar-option' + (selected ? ' selected' : ''));
      replace(b, portrait(a), el('span', {}, a.name), selected ? icon('check') : null); b.setAttribute('aria-pressed', String(selected)); grid.append(b);
    }
    main.append(selection, el('div', {class: 'row spread'}, el('h2', {}, '精选插画'), el('span', {class: 'muted'}, '6 款')), grid, el('p', {class: 'float-caption'}, '首次随机分配 · 点选即更换'));
  }
  async function personalPage() {
    loadPreferences(); pageHeader('个人资料');
    const name = field('昵称', 'text', account().displayName || getSession().principal.displayName || ''); name.input.maxLength = 40;
    const error = el('p', {class: 'error-text', role: 'alert'}), submit = el('button', {type: 'submit', class: 'primary'}, '保存昵称');
    const form = el('form', {class: 'float-form'}, buttonWithAvatar(() => show('avatars')), name.node,
      el('p', {class: 'muted'}, '手机号：' + (getSession().principal.phoneNumber || getSession().principal.username)), error, submit);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (submit.disabled) return; submit.disabled = true; error.textContent = '';
      try { const r = await mutation('/v1/me/profile', {displayName: value(name)}, 'PATCH'); mergeSession(r); notify('昵称已保存'); }
      catch (e) { error.textContent = e.message; notify(e.message, true); } finally { submit.disabled = false; }
    });
    main.append(form, button('退出登录', ctx.signOut, 'float-signout'));
  }
  function appearancePage() {
    loadPreferences(); pageHeader('外观设置');
    const mock = el('div', {class: 'float-theme-preview', 'aria-hidden': 'true'}, portrait(avatar()),
      el('div', {class: 'theme-skeleton'}, el('b'), el('span'), el('span')),
      el('div', {class: 'theme-skeleton'}, el('b'), el('span'), el('span')));
    const choices = el('div', {class: 'float-theme-options'});
    for (const [id, label, name] of [['light', '亮色', 'sun'], ['dark', '暗色', 'moon'], ['system', '跟随系统', 'contrast']]) {
      const b = button(label, () => { savePreference('appearance', id); applyTheme(); choices.querySelectorAll('button').forEach(n => { n.classList.toggle('selected', n.dataset.theme === id); n.setAttribute('aria-pressed', String(n.dataset.theme === id)); }); }, prefs.appearance === id ? 'selected' : '');
      replace(b, icon(name), el('span', {}, label)); b.dataset.theme = id; b.setAttribute('aria-pressed', String(prefs.appearance === id)); choices.append(b);
    }
    main.append(mock, choices, el('p', {class: 'float-caption'}, '选择后立即生效'));
  }
  function helpPage() {
    pageHeader('使用帮助'); main.append(pointRules(),
      el('section', {class: 'float-help-section'}, el('h2', {}, '导入与复审'),
        el('p', {}, '选择文件后，先核对候选题。需要核对的题排在前面，点击题卡可查看、纠错；原题号保持不变。结构问题全部处理后，点击确认私人入库。'),
        el('p', {}, '支持 DOCX、XLSX、TXT、CSV、TSV、JSON、JSONL 和文字 PDF，单文件不超过 10 MB。网页暂不支持图片和扫描 PDF 识别；请先转为可复制的文字，再使用人工导入。')),
      el('section', {class: 'float-help-section'}, el('h2', {}, '网站与 App'),
        el('p', {}, '网站与 App 使用同一账号和私人题库。网站修改、导入后，在 App 更新题库即可同步。网页不具备跨应用悬浮窗权限，悬浮窗请在安卓 App 启动。'),
        el('p', {}, '网页 AI 搜索是主动调用所选模型。模型 Key 仅在本次网页登录中保留，刷新或退出后需要重新输入；不会写入浏览器本地存储。')));
  }
  function benefitsPage() { pageHeader('我的权益'); main.append(rightsCard(), pointRules()); }
  function redeemPage() { pageHeader('兑换套餐'); main.append(el('section', {class: 'float-empty'}, icon('gift'), el('h2', {}, '套餐兑换暂未开放'), el('p', {}, '需要补充点数时，请联系管理员。'), button('查看点数明细', () => show('ledger')))); }
  function supportPage() { pageHeader('客服'); main.append(el('section', {class: 'float-empty'}, icon('headset'), el('h2', {}, '需要帮助'), el('p', {}, '常见问题和点数规则可在使用帮助中查看；账户与套餐问题请联系管理员。'), button('使用帮助', () => show('help'), 'primary'))); }
  function historyPage() {
    pageHeader('历史记录');
    main.append(el('p', {class: 'muted'}, '本次网页登录的 AI 搜题记录。安卓浮窗记录保存在对应设备。'));
    if (!history.length) { main.append(el('section', {class: 'float-empty'}, icon('history'), el('h2', {}, '暂无搜题记录'))); return; }
    const groups = new Map();
    for (const item of history) { const day = dateOnly(item.time); if (!groups.has(day)) groups.set(day, []); groups.get(day).push(item); }
    for (const [day, rows] of groups) {
      const content = rows.map(item => {
        const open = button(item.question, () => readDialog('搜题记录', el('div', {}, el('p', {class: 'answer'}, item.answer), el('p', {class: 'pre'}, item.question))));
        const remove = iconButton('删除这条记录', 'trash-2', () => { history = history.filter(h => h !== item); return show('history'); });
        return el('article', {class: 'float-history-row'}, open, remove);
      });
      main.append(el('details', {class: 'float-history-day', open: true}, el('summary', {}, day + ' · ' + rows.length + ' 条'), content));
    }
  }
  function modelBrand(model) { return model?.provider?.includes('doubao') ? 'doubao' : model?.provider?.includes('glm') ? 'glm' : model?.provider?.includes('mini') ? 'minimax' : model?.provider?.includes('qwen') ? 'qwen' : model?.provider === 'deepseek' ? 'deepseek' : 'custom'; }
  function brandIcon(brand) {
    const source = assets.brands[brand];
    if (!source) return icon('layers-2');
    const span = el('span', {class: 'float-model-logo', 'aria-hidden': 'true'});
    // Repository-owned SVG markup from the same icon package as the approved prototype.
    span.innerHTML = typeof source === 'string' ? source : (source.svg || ''); return span;
  }
  async function getCatalog() {
    try { catalog = await api('/v1/models/catalog'); if (Number.isFinite(catalog.pointsAvailable)) mergeSession({account: {...account(), pointsAvailable: catalog.pointsAvailable}}); return catalog; }
    catch (error) { catalog = null; throw error; }
  }
  function modelCatalogHint(error) {
    return error.code === 'MODEL_SERVICE_NOT_DEPLOYED' ? '需要先更新配套后台，再重新读取模型。仅拉取 Coze 页面代码不会更新后台。' : '请检查连接后重试，模型状态确认前不会发起调用。';
  }
  function modelCatalogFailure(error, retry) {
    return el('div', {}, el('p', {class: 'error-text', role: 'alert'}, error.message || '模型目录读取失败'), el('p', {class: 'muted'}, modelCatalogHint(error)), button('重新读取模型', retry));
  }
  function selectedModel() { return catalog?.items?.find(m => m.key === prefs.modelKey); }
  function selectedLabel() { return prefs.modelKey === 'byok' ? (keySession?.name || '自带模型') : (selectedModel()?.name || '选择模型'); }
  async function modelPage(alive) {
    loadPreferences(); pageHeader('模型选择', 'search', iconButton('模型设置', 'settings', () => show('modelSettings')));
    const area = el('div', {class: 'float-model-groups'}, el('p', {role: 'status', class: 'muted'}, '正在读取模型…')); main.append(area);
    try {
      const data = await getCatalog(); if (!alive()) return; replace(area, );
      const grouped = new Map();
      for (const m of data.items) { const brand = modelBrand(m); if (!grouped.has(brand)) grouped.set(brand, []); grouped.get(brand).push(m); }
      const names = {doubao: '豆包', glm: '智谱 GLM', minimax: 'MiniMax', qwen: '通义千问', deepseek: 'DeepSeek', custom: '其他模型'};
      for (const [brand, items] of grouped) {
        const section = el('section', {class: 'float-model-group'}, el('h2', {}, brandIcon(brand), names[brand]));
        for (const m of items) {
          const selected = prefs.modelKey === m.key;
          const b = button(m.name, () => { savePreference('modelKey', m.key); notify('已选择 ' + m.name); return show('userModels'); }, 'float-model-option' + (selected ? ' selected' : ''));
          replace(b, el('span', {}, m.name, el('small', {}, m.available ? m.pointsPerCall + ' 点 / 次' : ({MODEL_NOT_CONFIGURED:'尚未配置',MODEL_CONFIG_MISMATCH:'配置待调整',MODEL_KEY_NOT_CONFIGURED:'尚未配置密钥',MODEL_NOT_VERIFIED:'尚未验证',MODEL_DISABLED:'暂时停用',COZE_INTEGRATION_NOT_READY:'Coze 内置集成尚未就绪',INSUFFICIENT_POINTS:'可用点数不足'}[m.unavailableReason] || '暂不可用'))), selected ? icon('check') : el('strong', {}, m.pointsPerCall + ' 点'));
          b.disabled = !m.available; b.setAttribute('aria-pressed', String(selected)); section.append(b);
        }
        area.append(section);
      }
      area.append(el('section', {class: 'float-model-group'}, el('h2', {}, brandIcon('deepseek'), '自带模型'),
        menu(keySession ? keySession.name : '接入 DeepSeek / 自定义模型', 'plus', () => show('byok'), '不扣平台点数')));
      main.append(el('p', {class: 'float-caption'}, '基础功能需可用点数大于 0 · 内置模型按次计点'));
    } catch (error) { if (alive()) replace(area, modelCatalogFailure(error, () => show('userModels'))); }
  }
  function modelSettingsPage() {
    loadPreferences(); pageHeader('模型设置', 'userModels');
    const input = el('input', {type: 'checkbox', role: 'switch', checked: prefs.aiFallback === true, 'aria-label': '本地题库未命中时调用 AI 搜索'});
    input.addEventListener('change', () => savePreference('aiFallback', input.checked));
    main.append(el('label', {class: 'float-toggle-row'}, el('span', {}, el('strong', {}, '本地题库未命中时调用 AI 搜索'), el('small', {}, '自动补充题库未收录的答案')), input),
      el('p', {class: 'muted'}, '此浏览器已记住选择。网页当前提供主动 AI 搜索，本地自动回退需使用具备本地检索的客户端。'),
      menu('点数计费规则', 'coins', () => show('help')));
  }
  async function byokPage(alive) {
    loadPreferences(); pageHeader('自带模型', 'userModels');
    const area = el('div', {}, el('p', {role: 'status', class: 'muted'}, '正在读取服务商…')); main.append(area);
    let data;
    try { data = catalog || await getCatalog(); if (!alive()) return; area.remove(); }
    catch (error) { if (alive()) replace(area, modelCatalogFailure(error, () => show('byok'))); return; }
    const providers = Object.fromEntries(data.byokProviders.map(p => [p.id, p.name]));
    const provider = select('服务商', providers, keySession?.provider || (providers.deepseek ? 'deepseek' : Object.keys(providers)[0]));
    const model = field('模型 ID', 'text', keySession?.modelId || 'deepseek-chat');
    const key = field('API Key', 'password'); key.input.autocomplete = 'off'; key.input.spellcheck = false; key.input.dataset.modelSecret = '';
    const name = field('显示名称', 'text', keySession?.name || 'DeepSeek');
    const submit = el('button', {type: 'submit', class: 'primary'}, '使用此模型'), error = el('p', {class: 'error-text', role: 'alert'});
    const form = el('form', {class: 'float-form'}, provider.node, name.node, model.node, key.node,
      el('p', {class: 'muted'}, '不扣平台点数。Key 仅在本次网页登录中保留，刷新或退出后清除。费用由所选模型服务商结算。'), error, submit);
    form.addEventListener('submit', event => {
      event.preventDefault(); error.textContent = '';
      if (!value(model) || !value(key)) { error.textContent = '请填写模型 ID 和 API Key'; notify(error.textContent, true); return; }
      if (keySession) keySession.apiKey = '';
      keySession = {provider: value(provider), modelId: value(model), apiKey: value(key), name: value(name) || providers[value(provider)]}; key.input.value = '';
      savePreference('modelKey', 'byok'); notify('已选择自带模型'); void show('search');
    }); main.append(form);
  }
  async function searchPage(alive) {
    loadPreferences(); heading('搜题', '');
    const switcher = el('div', {class: 'float-dual-tabs'}, button('搜题', () => { searchMode = 'search'; return show('search'); }, 'selected'), button('导题', () => { searchMode = 'capture'; return show('imports'); }));
    main.querySelector('.page-heading').append(switcher);
    const top = el('div', {class: 'float-search-model'}, button(selectedLabel(), () => show('userModels')), iconButton('模型设置', 'settings', () => show('modelSettings')));
    const question = field('输入题目', 'textarea', '', '可粘贴题干和选项。网页将调用所选 AI 模型，不会显示为本地题库命中。');
    question.input.maxLength = 12000;
    const submit = el('button', {type: 'submit', class: 'primary'}, icon('search'), 'AI 搜索'), result = el('section', {class: 'float-search-result', 'aria-live': 'polite'});
    const gate = el('p', {class: 'muted', role: 'status'});
    let operation = null;
    const recovery = button('找回结果', async () => {
      if (!operation?.uncertain) return;
      const pending = operation;
      try {
        const response = await api('/v1/ai/receipt', {key: pending.key});
        if (alive() && operation === pending) complete(response, pending.question);
      } catch (error) {
        if (!alive()) return;
        if (error.code && error.code !== 'AI_REQUEST_PENDING') operation = null;
        const message = error.code === 'AI_REQUEST_NOT_FOUND' ? '未找到这次请求的回执，未发起新的模型调用。你可以重新提交。' : error.code === 'AI_REQUEST_PENDING' ? '模型仍在处理，可稍后再次找回；不会重复调用。' : error.message;
        replace(result, el('p', {class: 'error-text'}, message)); notify(message, true);
      } finally { if (alive()) updateGate(); }
    }); recovery.hidden = true;
    const retryCatalog = button('重新读取模型', () => loadCatalog()); retryCatalog.hidden = true;
    const form = el('form', {class: 'float-search-form'}, top, question.node, gate, retryCatalog, submit, recovery);
    let catalogReady = false, catalogError = null, catalogLoading = false;
    function updateGate() {
      const model = selectedModel(), byok = prefs.modelKey === 'byok';
      const pending = operation?.uncertain === true;
      const usable = !pending && catalogReady && points() > 0 && (byok ? !!keySession : !!model?.available && points() >= model.pointsPerCall);
      submit.disabled = !usable;
      recovery.hidden = !pending; question.input.readOnly = pending;
      retryCatalog.hidden = !catalogError || pending; retryCatalog.disabled = catalogLoading;
      gate.className = catalogError && !pending ? 'error-text' : 'muted';
      gate.textContent = pending ? '上次请求结果待确认，请先找回结果；查询回执不扣点，也不需要重新提供 Key。' : !catalogReady ? catalogError ? (catalogError.message || '模型目录读取失败') + '。' + modelCatalogHint(catalogError) : '正在读取模型可用状态…' : points() <= 0 ? '可用点数为 0，请先补充点数。已有题库仍可查看。' : (byok && !keySession) ? '请重新输入本次会话的 API Key。' : !usable ? '请先选择已配置且可用的模型。' : byok ? '自带模型不扣平台点数，费用由服务商结算。' : '本次调用成功后消耗 ' + model.pointsPerCall + ' 点。';
    }
    function complete(response, query) {
      if (response.status !== 'completed') throw Error('模型结果尚未确认，请稍后找回结果');
      mergeSession({account: {...account(), pointsAvailable: response.pointsAvailable}});
      replace(result, el('h2', {}, '答案'), el('div', {class: 'answer'}, response.answer), response.explanation ? el('div', {class: 'pre'}, response.explanation) : null,
        el('p', {class: 'muted'}, 'AI · ' + response.model.name + ' · 本次 ' + response.pointsCharged + ' 点'), el('details', {}, el('summary', {}, '查看题目'), el('p', {class: 'pre'}, query)));
      history.unshift({time: Date.now(), question: query, answer: response.answer}); history = history.slice(0, 50); operation = null;
    }
    updateGate();
    question.input.addEventListener('input', () => { operation = null; });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (submit.disabled) return;
      if (!value(question)) { notify('请输入题目', true); question.input.focus(); return; }
      if (!prefs.modelKey || (prefs.modelKey === 'byok' && !keySession)) { notify('请先选择可用模型', true); void show('userModels'); return; }
      if (points() <= 0) { notify('可用点数为 0，请先补充点数', true); return; }
      const selected = selectedModel();
      if (prefs.modelKey !== 'byok' && (!selected?.available || points() < selected.pointsPerCall)) { notify(!selected?.available ? '该模型暂不可用，请重新选择' : '点数不足以调用所选模型', true); return; }
      const body = prefs.modelKey === 'byok' ? {mode: 'byok', question: value(question), byok: {provider: keySession.provider, modelId: keySession.modelId, apiKey: keySession.apiKey}} : {mode: 'builtin', modelKey: prefs.modelKey, question: value(question)};
      const fingerprint = [body.mode, body.modelKey || keySession?.modelId, body.question].join('|');
      if (!operation || operation.fingerprint !== fingerprint) operation = {fingerprint, key: crypto.randomUUID(), question: body.question, uncertain: false};
      submit.disabled = true; question.input.readOnly = true; submit.classList.add('is-busy'); replace(result, el('p', {role: 'status'}, '正在等待模型回答…'));
      try {
        const r = await api('/v1/ai/search', {method: 'POST', key: operation.key, body});
        if (!alive()) return;
        complete(r, body.question);
      } catch (error) {
        if (error.code && error.code !== 'AI_REQUEST_PENDING') operation = null;
        else if (operation) operation.uncertain = true;
        if (alive()) { replace(result, el('p', {class: 'error-text'}, error.message)); notify(error.message, true); }
      } finally { delete body.byok?.apiKey; updateGate(); submit.classList.remove('is-busy'); }
    }); main.append(form, result);
    async function loadCatalog() {
      if (catalogLoading || !alive()) return;
      catalogLoading = true; catalogReady = false; catalogError = null; updateGate();
      try { await getCatalog(); if (alive()) { catalogReady = true; replace(top.firstChild, el('span', {}, selectedLabel())); } }
      catch (error) { if (alive()) catalogError = error; }
      finally { catalogLoading = false; if (alive()) updateGate(); }
    }
    await loadCatalog();
  }
  function dateOnly(date) { const d = new Date(date); return Number.isNaN(d.getTime()) ? '—' : d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function editBank(bank, done) {
    const title = field('题库名称', 'text', bank.title), description = field('简介', 'textarea', bank.description || '');
    title.input.maxLength = 200; description.input.maxLength = 1000;
    dialog('编辑题库', [title.node, description.node], '保存', async key => {
      await mutation('/v1/banks/' + encodeURIComponent(bank.bankId), {expectedBankVersion: bank.dataVersion, title: value(title), description: value(description)}, 'PATCH', key);
      notify('题库名称与简介已保存'); await done();
    });
  }
  function deleteBank(bank, done) {
    dialog('删除题库', [el('p', {}, '删除“' + bank.title + '”？'), el('p', {class: 'muted'}, '将删除你的私人题库及云端对应内容。此操作无法撤销。')], '删除', async key => {
      await mutation('/v1/banks/' + encodeURIComponent(bank.bankId), {expectedBankVersion: bank.dataVersion}, 'DELETE', key); notify('题库已删除'); await done();
    });
  }
  async function banksPage(alive) {
    loadPreferences(); heading('我的题库', '');
    main.querySelector('.page-heading').append(iconButton('快速导入', 'arrow-up-from-line', () => show('imports')));
    const summary = el('section', {class: 'float-summary', 'aria-label': '题库汇总'}), controls = el('form', {class: 'float-bank-search'});
    const input = el('input', {type: 'search', placeholder: '搜索题库', 'aria-label': '搜索题库'}), search = el('button', {type: 'submit'}, '搜索');
    controls.append(icon('search'), input, search);
    const list = el('div', {class: 'float-bank-list'}); main.append(summary, controls, list);
    const banks = await allBanks(); if (!alive()) return;
    let selectedType = questionTypeFilter; questionTypeFilter = null;
    const counts = {}; for (const b of banks) for (const [t, n] of Object.entries(b.typeCounts || {})) counts[t] = (counts[t] || 0) + n;
    const total = banks.reduce((sum, b) => sum + b.questionCount, 0);
    const categories = [[null, '总题数', total, 'total'], ['choice', '选择', (counts.single_choice || 0) + (counts.multiple_choice || 0), 'choice'], ['true_false', '判断', counts.true_false || 0, 'judgment'], ['fill_blank', '填空', counts.fill_blank || 0, 'blank'], ['short_answer', '简答', counts.short_answer || 0, 'short']];
    for (const [id, label, n, color] of categories) {
      const b = button(label, () => { selectedType = id; summary.querySelectorAll('button').forEach(x => { x.classList.toggle('selected', x.dataset.type === (id || '')); x.setAttribute('aria-pressed', String(x.dataset.type === (id || ''))); }); renderList(); }, 'float-stat ' + color + (selectedType === id ? ' selected' : ''));
      replace(b, el('span', {}, label), el('strong', {}, String(n))); b.dataset.type = id || ''; b.setAttribute('aria-pressed', String(selectedType === id)); summary.append(b);
    }
    const matchesType = b => !selectedType || (selectedType === 'choice' ? ((b.typeCounts?.single_choice || 0) + (b.typeCounts?.multiple_choice || 0)) > 0 : (b.typeCounts?.[selectedType] || 0) > 0);
    function renderList() {
      const q = input.value.trim().toLocaleLowerCase();
      const items = banks.filter(b => b.title.toLocaleLowerCase().includes(q) && matchesType(b));
      replace(list, ...items.map(b => {
        const owns = b.visibility === 'private' && b.ownerUserId === getSession().principal.userId;
        const title = button(b.title, () => bankBrowser.open(b.bankId, selectedType), 'float-bank-name');
        replace(title, el('i', {class: 'float-bank-dot', 'aria-hidden': 'true'}), el('span', {}, b.title)); title.title = b.title;
        const actions = el('div', {class: 'float-bank-actions'});
        if (owns) actions.append(iconButton('删除 ' + b.title, 'trash-2', () => deleteBank(b, () => show('banks'))));
        actions.append(iconButton('题库信息', 'ellipsis', () => readDialog(b.title, el('div', {}, el('p', {}, b.description || '暂无简介'), el('p', {class: 'muted'}, b.visibility === 'private' ? '私人题库' : '公共题库'), owns ? button('编辑名称与简介', () => { document.querySelectorAll('dialog').forEach(d => d.close()); editBank(b, () => show('banks')); }) : null))));
        return el('article', {class: 'float-bank-row'}, title, actions, el('span', {class: 'float-bank-count'}, b.questionCount + ' 题'), el('time', {datetime: b.importedAt || ''}, dateOnly(b.importedAt)));
      }));
      if (!items.length) list.append(el('section', {class: 'float-empty'}, icon(q ? 'search-x' : 'library'), el('h2', {}, q ? '没有找到匹配的题库' : selectedType ? '这个题型还没有题目' : '还没有题库'), !q && !selectedType ? button('导入题库', () => show('imports'), 'primary') : button('清除筛选', () => { input.value = ''; selectedType = null; return show('banks'); })));
    }
    controls.addEventListener('submit', event => { event.preventDefault(); renderList(); }); input.addEventListener('input', renderList); renderList();
  }
  async function importsPage(alive) {
    loadPreferences(); pageHeader('导入题库', 'banks');
    const formats = [['图片', 'image', 'image/*', '网页暂不支持'], ['PDF', 'file-text', '.pdf', '仅文字 PDF'], ['Word', 'file-text', '.docx', 'DOCX'], ['Excel', 'sheet', '.xlsx,.csv,.tsv', 'XLSX / CSV'], ['TXT', 'file-type', '.txt,.json,.jsonl', '文本文件'], ['人工导入', 'pencil-line', 'manual', '粘贴题目']];
    const picker = el('div', {class: 'float-import-formats'}), body = el('section', {class: 'float-upload-surface'});
    const file = el('input', {type: 'file', accept: '.docx,.xlsx,.csv,.tsv,.txt,.json,.jsonl,.pdf', class: 'sr-only', 'aria-label': '选择题库文件'}), title = field('题库名称（可选）');
    const selected = el('p', {class: 'float-file-name'}, '选择格式后上传文件'), status = el('p', {class: 'muted', role: 'status'});
    const access = el('p', {class: 'float-caption', role: 'status'}), writeControls = [];
    const upload = button('选择文件', () => { if (points() <= 0) throw Error('可用点数为 0，请先补充点数再导入'); file.click(); }, 'primary'); let fileData = null, uploadKey = crypto.randomUUID();
    function checkFile(candidate) {
      if (!candidate) throw Error('请先选择文件');
      if (candidate.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?)$/iu.test(candidate.name)) throw Error('网页暂不支持图片识别，请使用安卓 App 或人工导入');
      if (!/\.(docx|xlsx|csv|tsv|txt|json|jsonl|pdf)$/iu.test(candidate.name)) throw Error('此格式暂不支持，请选择 DOCX、XLSX、文本文件或文字 PDF');
      if (candidate.size > 10 * 1024 * 1024) throw Error('文件超过 10 MB，请拆分后导入');
      return /\.pdf$/iu.test(candidate.name);
    }
    function updateAccess() {
      const blocked = points() <= 0;
      for (const control of writeControls) control.disabled = blocked;
      access.textContent = blocked ? '可用点数为 0，暂不能导入或纠错；已有题库和导入记录仍可查看。' : '导入本身不扣点，账户可用点数需大于 0。';
    }
    const send = button('上传并解析', async () => {
      const candidate = fileData, isPdf = checkFile(candidate), requestKey = uploadKey;
      await updateMe(); if (!alive()) return; updateAccess(); if (points() <= 0) throw Error('可用点数为 0，请先补充点数再导入');
      const data = new FormData(); data.append('file', candidate); if (value(title)) data.append('title', value(title));
      status.textContent = isPdf ? '正在读取 PDF 文本层；不会对扫描页进行 OCR…' : '正在上传文件并解析题目…'; body.classList.add('is-processing');
      try { const r = await api('/v1/imports', {method: 'POST', body: data, key: requestKey}); if (!alive()) return; status.textContent = r.status === 'failed' ? '解析失败，请查看原因' : ['ready', 'needs_review'].includes(r.status) ? '解析完成，请核对题卡' : '文件已提交，请查看实际处理状态'; await preview(r.importId); }
      catch (e) { status.textContent = e.message; throw e; } finally { body.classList.remove('is-processing'); }
    }, 'primary'); send.hidden = true;
    writeControls.push(upload, send);
    for (const [label, name, accept, caption] of formats) {
      const b = button(label, () => {
        if (accept === 'image/*') return readDialog('图片导入', el('div', {}, el('p', {}, '网页暂不支持图片文字识别。可在安卓 App 选择相册或拍照，识别后核对导入；也可把文字粘贴到人工导入。'), button('人工导入', () => { document.querySelectorAll('dialog').forEach(d => d.close()); manualImport(); })));
        if (points() <= 0) throw Error('可用点数为 0，请先补充点数再导入');
        if (accept === 'manual') return manualImport();
        picker.querySelectorAll('button').forEach(n => { n.classList.toggle('selected', n === b); n.setAttribute('aria-pressed', String(n === b)); });
        file.accept = accept; upload.textContent = '选择 ' + label + ' 文件'; file.click();
      }, 'float-import-format'); replace(b, el('span', {class: 'format-icon'}, icon(name)), el('span', {}, label), el('small', {class: 'muted'}, caption)); b.setAttribute('aria-pressed', 'false'); picker.append(b);
      if (accept !== 'image/*') writeControls.push(b);
    }
    file.addEventListener('change', () => {
      const candidate = file.files[0] || null; fileData = null; send.hidden = true; status.textContent = '';
      if (!candidate) { selected.textContent = '尚未选择文件'; return; }
      try { const isPdf = checkFile(candidate); fileData = candidate; uploadKey = crypto.randomUUID(); selected.textContent = candidate.name; send.hidden = false; status.textContent = isPdf ? '仅支持文字可复制的 PDF；扫描件和图片 PDF 无法识别，请勿上传。' : ''; }
      catch (error) { file.value = ''; selected.textContent = '请重新选择支持的文件'; status.textContent = error.message; notify(error.message, true); }
    });
    body.append(icon('file-up'), selected, upload, send, el('details', {}, el('summary', {}, '题库名称'), title.node), el('div', {class: 'float-processing-line', 'aria-hidden': 'true'}), status);
    main.append(el('p', {class: 'float-caption'}, '网页可导入文字文件。图片、扫描 PDF 暂不支持，且不会自动转为 OCR 任务。'), picker, access, file, body, el('p', {class: 'float-caption'}, 'DOCX / XLSX / TXT / CSV / TSV / JSON / JSONL / 文字 PDF · 最大 10 MB'), el('h2', {class: 'section-title'}, '导入记录'));
    updateAccess();
    try { await updateMe(); if (!alive()) return; updateAccess(); } catch (error) { if (!alive()) return; notify(error.message, true); }
    await paged('/v1/imports', ['文件', '状态', '题数', '操作'], i => [i.filename, ({ready: '待确认', needs_review: '需要纠错', confirmed: '已入库', failed: '解析失败', processing: '解析中'})[i.status] || i.status, i.questionCount, el('div', {class: 'row'}, button('预览 / 纠错', () => preview(i.importId)), button('下载原件', () => download('/v1/imports/' + i.importId + '/source')))]);
  }
  function manualImport() {
    if (points() <= 0) { notify('可用点数为 0，请先补充点数再导入', true); return; }
    const name = field('题库名称', 'text'), content = field('题目文本', 'textarea', '', '按题号粘贴题干、选项和答案。上传后仍需核对候选题。');
    dialog('人工导入', [name.node, content.node], '生成预览', async key => {
      if (!value(content)) throw Error('请填写题目文本'); await updateMe(); if (points() <= 0) throw Error('请先补充点数');
      const body = new FormData(); body.append('file', new File([value(content)], '人工导入.txt', {type: 'text/plain'})); if (value(name)) body.append('title', value(name));
      const r = await api('/v1/imports', {method: 'POST', body, key}); document.querySelectorAll('dialog').forEach(d => d.close()); await preview(r.importId);
    });
  }
  async function preview(importId) {
    const owner = getSession()?.principal?.userId, pageToken = getPageToken();
    const info = await api('/v1/imports/' + encodeURIComponent(importId));
    if (owner !== getSession()?.principal?.userId || pageToken !== getPageToken()) return;
    let offset = 0, request = 0, current = null, items = [], total = info.questionCount;
    const heading = el('h2', {}, info.title || info.filename), counter = el('p', {class: 'muted', role: 'status'});
    const grid = el('div', {class: 'float-review-grid'}), detail = el('section', {class: 'float-review-detail'});
    const range = el('input', {type: 'range', min: 1, max: Math.max(1, total), value: 1, step: 1, 'aria-label': '快速定位复审顺序'});
    const jump = el('input', {type: 'number', min: 1, max: Math.max(1, total), value: 1, 'aria-label': '复审顺序位置'});
    const body = el('div', {class: 'dialogbody'}, heading,
      el('p', {class: 'float-review-summary'}, info.status === 'failed' ? '解析失败，请查看原因并更换文件' : info.status === 'processing' ? '文件尚在处理，完成后请重新打开' : info.reviewQuestionCount > 0 ? info.reviewQuestionCount + ' 题需要核对 · 已排在前面' : '候选题已解析 · 请核对后入库'),
      el('p', {class: 'muted'}, '题卡保留原题号，优先展示需要核对的题。'),
      info.warnings?.length ? el('p', {class: 'error-text'}, info.warnings.join('\n')) : null,
      el('div', {class: 'float-review-layout'}, el('div', {}, grid), el('aside', {class: 'float-review-rail'}, el('span', {}, '快速定位'), range)),
      el('div', {class: 'float-review-jump'}, el('label', {}, '复审位置', jump), button('前往', () => { const pos = Math.min(total || 1, Math.max(1, Number(jump.value) || 1)); return load(Math.floor((pos - 1) / 48) * 48, pos); })), counter, detail);
    const box = el('dialog', {class: 'float-review-dialog'}, body); box.addEventListener('close', () => { request++; box.remove(); }); document.body.append(box); box.showModal();
    const active = () => box.isConnected && box.open && getSession()?.principal?.userId === owner;
    function renderQuestion(q) {
      current = q.questionId; grid.querySelectorAll('button').forEach(b => b.classList.toggle('current', b.dataset.id === current));
      const edit = iconButton('编辑第 ' + q.ordinal + ' 题', 'pencil', () => { box.close(); editQuestion(importId, q, info.revision, () => preview(importId)); }); edit.disabled = points() <= 0; if (edit.disabled) edit.title = '补充点数后可编辑';
      replace(detail, el('div', {class: 'row spread'}, el('h3', {}, '第 ' + q.ordinal + ' 题 · ' + (types[q.questionType] || '未确定')), info.status !== 'confirmed' ? edit : null),
        q.errors?.length ? el('p', {class: 'error-text'}, q.errors.join('\n')) : null,
        el('p', {class: 'pre'}, q.stem), q.options?.length ? el('ol', {class: 'reader-options'}, q.options.map(o => el('li', {}, el('span', {class: 'option-label'}, o.id + '.'), el('span', {}, o.text)))) : null,
        el('h3', {}, '答案'), el('p', {class: 'answer'}, q.answerText || '来源未提供答案'), q.explanation ? el('p', {class: 'pre'}, q.explanation) : null);
    }
    async function load(next, focusPosition = next + 1) {
      const serial = ++request; grid.setAttribute('aria-busy', 'true');
      try {
        const result = await api('/v1/imports/' + encodeURIComponent(importId) + '/questions?order=review&offset=' + Math.max(0, next) + '&limit=48');
        if (!active() || serial !== request) return;
        if (result.revision !== info.revision) throw Error('预览已更新，请关闭后重新打开');
        offset = Math.max(0, next); items = result.items; total = result.total; range.max = jump.max = String(Math.max(1, total)); range.value = jump.value = String(Math.min(focusPosition, total || 1));
        replace(grid, ...items.map(q => {
          const issue = q.errors?.length || !q.answerComplete;
          const b = button(String(q.ordinal), () => renderQuestion(q), 'float-review-number' + (issue ? ' needs-review' : ''));
          b.dataset.id = q.questionId; b.setAttribute('aria-label', '原第 ' + q.ordinal + ' 题' + (issue ? '，需要核对' : '')); return b;
        }));
        counter.textContent = total ? '复审顺序 ' + (offset + 1) + '–' + (offset + items.length) + ' / ' + total + ' 题' : '没有候选题';
        replace(detail, ); if (items.length) renderQuestion(items[Math.max(0, Math.min(items.length - 1, focusPosition - offset - 1))]);
      } catch (error) { if (active()) { counter.textContent = error.message; notify(error.message, true); } }
      finally { if (active()) grid.removeAttribute('aria-busy'); }
    }
    range.addEventListener('input', () => { jump.value = range.value; });
    range.addEventListener('change', () => { const pos = Number(range.value); void load(Math.floor((pos - 1) / 48) * 48, pos); });
    const confirm = button('确认私人入库', async () => { box.close(); await confirmImport(info); }, 'primary');
    confirm.disabled = points() <= 0 || !['ready', 'needs_review'].includes(info.status) || info.questionCount < 1 || info.errorCount > 0;
    body.append(el('div', {class: 'dialogactions'}, button('关闭', () => box.close()), info.status !== 'confirmed' ? confirm : null));
    if (info.errorCount > 0) body.append(el('p', {class: 'error-text'}, '仍有 ' + info.errorCount + ' 处结构问题，请纠正后再入库。'));
    if (points() <= 0 && info.status !== 'confirmed') body.append(el('p', {class: 'muted'}, '可用点数为 0，可以继续查看预览；补充点数后可纠错和确认入库。'));
    await load(0);
  }
  return {reset, leavePage: clearSecretFields, loadPreferences, preview, editBank, pages: {
    profile: profilePage, avatars: avatarsPage, personal: personalPage, appearance: appearancePage,
    help: helpPage, benefits: benefitsPage, redeem: redeemPage, support: supportPage, history: historyPage,
    userModels: modelPage, byok: byokPage, modelSettings: modelSettingsPage, search: searchPage,
    banks: banksPage, imports: importsPage
  }};
};
