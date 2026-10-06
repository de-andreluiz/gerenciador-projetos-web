// Comunicações (gerador de e-mails) — rotas. Regras em src/email.js. A aplicação NÃO ENVIA e-mail: gera o conteúdo (variáveis e
// destinatários resolvidos do projeto) e o usuário copia e cola no Gmail/Outlook. Nenhuma rota aqui acessa a internet.
// Fluxo: gerar (resolve e devolve a prévia; registra "gerado") → [usuário ajusta na tela] → copiar (a tela copia para a área de
// transferência e avisa o servidor só para o histórico/auditoria). Gerar/copiar não conclui item de checklist.
const fs = require('fs');
const path = require('path');
const { httpError, str, uid } = require('./util');
const EH = require('./evidence-http');
const E = require('./evidence');
const M = require('./email');
const HS = require('./html-safe');

const IMG_MAX_BYTES = 2 * 1024 * 1024; // imagem do corpo: o e-mail precisa ficar leve (a tela reduz para ≤ 720 px de largura)
const IMG_FOLDER = 'comunicacoes/imagens';

function mount(app, { store, audit, getProject, getIn, publicProject, dataDir }) {
  const data = () => store.data;
  const files = () => store.files('email-images'); // local: mesma pasta das evidências · nuvem: bucket email-images (cifrado)
  const images = () => (data().emailImages ||= []);
  const log = (action, p, extra = {}) => audit.log({ action, project: p?.name, by: EH.whoAmI(), ...extra });
  const tpl = (id) => data().emailTemplates.find((t) => t.id === id) || null;
  const tplOrThrow = (id) => tpl(id) || (() => { throw httpError(404, 'Modelo de e-mail não encontrado.'); })();
  // Projeto criado nesta sessão ainda não passou por applyDefaults (só roda na carga): garante os campos de Comunicações.
  const proj = (id) => { const p = getProject(id); if (!Array.isArray(p.contacts)) p.contacts = []; if (p.emailTemplateIds === undefined) p.emailTemplateIds = null; return p; };
  const gens = () => (data().emailGenerations ||= []);

  const publicTemplate = (t) => ({ ...t, editHtml: t.bodyHtml || M.bodyToHtml(t.body, { wrap: false }), attachmentsInfo: resolveAttachments(t.attachments), usage: M.templateUsage(data(), t.id), projectName: t.projectId ? data().projects.find((p) => p.id === t.projectId)?.name || '(projeto removido)' : null });
  const brief = (t) => ({ id: t.id, name: t.name, description: t.description, scope: t.scope, active: t.active });

  // ---------- Modelos ----------
  app.get('/api/email-templates', (req, res) => res.json({
    templates: data().emailTemplates.map(publicTemplate), variables: M.publicVariables(), roles: M.publicRoles(), contactKinds: M.CONTACT_KINDS,
  }));

  app.post('/api/email-templates', async (req, res) => {
    const now = new Date().toISOString();
    const t = { id: uid(), ...M.cleanTemplate(req.body, data()), createdAt: now, updatedAt: now };
    data().emailTemplates.push(t);
    await store.save();
    log('email-modelo-criado', null, { detalhe: t.name });
    res.json(publicTemplate(t));
  });

  app.put('/api/email-templates/:tid', async (req, res) => {
    const t = tplOrThrow(req.params.tid);
    const merged = { ...t, ...req.body };
    if ('body' in req.body && !('bodyHtml' in req.body)) delete merged.bodyHtml; // edição só do texto (API/modelo antigo)
    const clean = M.cleanTemplate(merged, data(), t.id);
    if (!clean.bodyHtml) delete t.bodyHtml;
    if (t.scope === 'global' && clean.scope === 'project' && M.templateUsage(data(), t.id).checklistItems) throw httpError(409, 'Este modelo está ligado a itens de checklist (modelos reutilizáveis) e precisa continuar global.');
    const wasActive = t.active;
    delete t.attachments; // campo da versão com envio; não é mais usado
    Object.assign(t, clean, { updatedAt: new Date().toISOString() });
    await store.save();
    log(wasActive && !t.active ? 'email-modelo-desativado' : !wasActive && t.active ? 'email-modelo-reativado' : 'email-modelo-editado', null, { detalhe: t.name });
    res.json(publicTemplate(t));
  });

  app.post('/api/email-templates/:tid/duplicate', async (req, res) => {
    const t = tplOrThrow(req.params.tid);
    let name = `${t.name} (cópia)`.slice(0, 80);
    for (let i = 2; data().emailTemplates.some((x) => x.name.toLowerCase() === name.toLowerCase()); i++) name = `${t.name} (cópia ${i})`.slice(0, 80);
    const now = new Date().toISOString();
    const c = { ...JSON.parse(JSON.stringify(t)), id: uid(), name, createdAt: now, updatedAt: now };
    data().emailTemplates.push(c);
    await store.save();
    log('email-modelo-criado', null, { detalhe: `${c.name} (duplicado de ${t.name})` });
    res.json(publicTemplate(c));
  });

  // Excluir só modelo nunca usado (sem gerações, sem item de checklist, sem projeto). Em uso → desativar.
  app.delete('/api/email-templates/:tid', async (req, res) => {
    const t = tplOrThrow(req.params.tid);
    const u = M.templateUsage(data(), t.id);
    if (u.checklistItems || u.projectItems || u.generations || u.projects) throw httpError(409, `O modelo “${t.name}” já foi usado (e-mails gerados, itens de checklist ou projetos). Desative-o em vez de excluir — o histórico continua intacto.`, { code: 'EMAIL_TEMPLATE_IN_USE' });
    data().emailTemplates = data().emailTemplates.filter((x) => x.id !== t.id);
    await store.save();
    log('email-modelo-excluido', null, { detalhe: t.name });
    res.json({ ok: true });
  });

  // ---------- Projeto: modelos habilitados, contatos, histórico ----------
  const projectEmails = (p) => ({
    contacts: p.contacts, contactKinds: M.CONTACT_KINDS,
    selection: p.emailTemplateIds, available: M.availableFor(data(), p).map(brief),
    globals: data().emailTemplates.filter((t) => t.scope === 'global').map(brief),
    generations: gens().filter((s) => s.projectId === p.id).slice(-50).reverse(),
  });
  app.get('/api/projects/:id/emails', (req, res) => res.json(projectEmails(proj(req.params.id))));

  // ids = null → todos os modelos globais ativos; lista → só esses (os específicos do projeto sempre aparecem).
  app.put('/api/projects/:id/email-templates', async (req, res) => {
    const p = proj(req.params.id);
    if (req.body.ids === null) p.emailTemplateIds = null;
    else {
      const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => str(x, 40)))];
      for (const id of ids) if (tpl(id)?.scope !== 'global') throw httpError(400, 'Um dos modelos escolhidos não existe ou não é global.');
      p.emailTemplateIds = ids;
    }
    await store.save();
    log('email-modelos-do-projeto', p, { detalhe: p.emailTemplateIds === null ? 'todos os globais' : `${p.emailTemplateIds.length} modelo(s)` });
    res.json({ ...projectEmails(p), project: publicProject(p) });
  });

  app.post('/api/projects/:id/contacts', async (req, res) => {
    const p = proj(req.params.id);
    if (p.contacts.length >= 100) throw httpError(400, 'No máximo 100 contatos por projeto.');
    const c = { id: uid(), ...M.cleanContact(req.body) };
    p.contacts.push(c);
    await store.save();
    log('contato-criado', p, { detalhe: `${c.name} (${M.CONTACT_KINDS[c.kind]})` });
    res.json({ ...projectEmails(p), project: publicProject(p) });
  });
  app.put('/api/projects/:id/contacts/:cid', async (req, res) => {
    const p = proj(req.params.id);
    const c = getIn(p.contacts, req.params.cid, 'Contato');
    Object.assign(c, M.cleanContact(req.body));
    await store.save();
    log('contato-editado', p, { detalhe: c.name });
    res.json({ ...projectEmails(p), project: publicProject(p) });
  });
  app.delete('/api/projects/:id/contacts/:cid', async (req, res) => {
    const p = proj(req.params.id);
    const c = getIn(p.contacts, req.params.cid, 'Contato');
    p.contacts = p.contacts.filter((x) => x.id !== c.id);
    await store.save();
    log('contato-removido', p, { detalhe: c.name });
    res.json({ ...projectEmails(p), project: publicProject(p) });
  });

  // ---------- Gerar (NÃO envia nada) ----------
  // Origem: item de checklist (o modelo vem do item) ou "Gerar e-mail" no projeto (modelo escolhido entre os disponíveis).
  function sourceOf(p, b) {
    if (b.stepId || b.itemId) {
      const inst = p.checklists.find((c) => c.stepId === str(b.stepId, 40)) || (() => { throw httpError(404, 'Checklist deste passo ainda não foi iniciado.'); })();
      const item = inst.items.find((i) => i.id === str(b.itemId, 40)) || (() => { throw httpError(404, 'Item não encontrado.'); })();
      if (!item.emailTemplateId) throw httpError(400, 'Este item do checklist não tem modelo de e-mail associado.');
      const t = tpl(item.emailTemplateId);
      const why = M.usableIn(data(), p, t, { fromItem: true });
      if (why) throw httpError(409, why, { code: 'EMAIL_TEMPLATE_UNAVAILABLE' });
      return { t, item, stageName: inst.stageName, checklist: { stepId: inst.stepId, itemId: item.id, itemTitle: item.title, stageName: inst.stageName } };
    }
    const t = tpl(str(b.templateId, 40));
    const why = M.usableIn(data(), p, t);
    if (why) throw httpError(409, why, { code: 'EMAIL_TEMPLATE_UNAVAILABLE' });
    return { t, item: null, stageName: '', checklist: null };
  }

  // ---------- Imagens do corpo (mesmo armazenamento das evidências; no e-mail viram data URL ao gerar/copiar) ----------
  // As imagens citadas no corpo são carregadas ANTES de montar o e-mail (na nuvem a leitura é assíncrona); ausente = aviso, nunca erro.
  async function imagesFor(fragment) {
    const ids = [...new Set([...String(fragment || '').matchAll(/\/api\/email-images\/([A-Za-z0-9_-]{1,64})/g)].map((m) => m[1]))];
    const found = new Map();
    for (const id of ids) {
      const im = images().find((x) => x.id === id);
      if (!im || !files().has(im.file)) continue;
      try { found.set(id, `data:${im.mime};base64,${(await files().read(im.file)).toString('base64')}`); } catch { /* fica de fora com aviso */ }
    }
    return (id) => found.get(id) || null;
  }
  app.post('/api/email-images', async (req, res) => {
    const cfg = E.getConfig(data().settings);
    // limite do e-mail conferido ANTES de gravar (na nuvem nada de grande demais chega ao Storage)
    const rec = await EH.receiveUpload(req, { files: files(), cfg, type: 'image', folder: IMG_FOLDER, maxBytes: IMG_MAX_BYTES, limitText: `O limite no e-mail é ${IMG_MAX_BYTES / 1048576} MB.` });
    const im = { id: rec.id, name: rec.name, file: rec.file, mime: rec.mime, size: rec.size, at: rec.at };
    images().push(im);
    await store.save();
    log('email-imagem-adicionada', null, { detalhe: im.name, resultado: `${im.size} bytes` });
    res.json({ id: im.id, name: im.name, url: `/api/email-images/${im.id}` });
  });
  app.get('/api/email-images/:id', async (req, res) => {
    const im = images().find((x) => x.id === req.params.id) || (() => { throw httpError(404, 'Imagem não encontrada.'); })();
    await EH.sendEvidence(res, files(), { name: im.name, file: im.file }, { inline: true });
  });

  // ---------- Anexos sugeridos (referências a Documentos e Modelos; nada é enviado nem copiado de lugar) ----------
  // Resolve cada referência no cadastro de documentos. Documento removido ou arquivo sumido NÃO quebra a geração: vira aviso.
  function resolveAttachments(list) {
    return (list || []).map((a) => {
      const d = data().documents.find((x) => x.id === a.documentId);
      if (!d) return { documentId: a.documentId, title: a.title, missing: true, problem: 'Documento não encontrado (foi excluído de Documentos e Modelos). Corrija o anexo no modelo.' };
      const isFile = d.source.type === 'file';
      const exists = isFile ? files_exists(d.source.path) : true;
      return { documentId: d.id, title: d.title, kind: d.kind, sourceType: d.source.type, name: isFile ? path.basename(d.source.path) : d.source.url, path: isFile ? d.source.path : null, url: isFile ? null : d.source.url,
        missing: false, fileMissing: isFile && !exists, problem: isFile && !exists ? 'Arquivo não encontrado no caminho cadastrado (foi movido ou apagado). Corrija em Documentos e Modelos.' : null };
    });
  }
  const files_exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

  // Corpo final para a tela: HTML wrapper (prévia = cópia), texto puro e fragmento editável (imagens como referência).
  const outFor = async (fragment) => M.renderOut(fragment, await imagesFor(fragment));

  app.post('/api/projects/:id/emails/generate', async (req, res) => {
    const p = proj(req.params.id);
    const src = sourceOf(p, req.body);
    const g = M.generate(src.t, M.contextFor(data(), p, { item: src.item, stageName: src.stageName }));
    const attachments = resolveAttachments(src.t.attachments);
    const out = await outFor(g.bodyHtml);
    const extra = [...attachments.filter((a) => a.problem).map((a) => `⚠ ${a.title}: ${a.problem}`), ...(out.missingImages.length ? ['⚠ Uma imagem do modelo não foi encontrada e ficou de fora.'] : [])];
    const rec = M.generationRecord({ project: p, template: src.t, checklist: src.checklist, g, by: EH.whoAmI(), attachments });
    gens().push(rec);
    if (gens().length > M.MAX_GENERATIONS) gens().splice(0, gens().length - M.MAX_GENERATIONS);
    await store.save();
    log('email-gerado', p, { detalhe: src.t.name, item: src.checklist?.itemTitle });
    res.json({ ...g, warnings: [...g.warnings, ...extra], generationId: rec.id, template: brief(src.t), checklist: src.checklist, attachments, html: out.html, text: out.text });
  });

  // Corpo editado na tela (HTML do editor): sanitiza e devolve o MESMO HTML/texto que a prévia mostra e a cópia usa.
  // Também aceita { body } (texto simples antigo) e { html } só para sanitizar um colar (sem imagens inlinadas).
  app.post('/api/emails/render', async (req, res) => {
    if (typeof req.body.bodyHtml === 'string') {
      const fragment = HS.sanitize(req.body.bodyHtml);
      const out = await outFor(fragment);
      return res.json({ bodyHtml: fragment, html: out.html, text: out.text });
    }
    const body = String(req.body.body ?? '').slice(0, 20000);
    const fragment = M.bodyToHtml(body, { wrap: false });
    res.json({ bodyHtml: fragment, html: M.bodyToHtml(body), text: M.bodyToText(body) });
  });
  app.post('/api/emails/sanitize', (req, res) => res.json({ html: HS.sanitize(String(req.body.html ?? '')) })); // colar no editor
  // “Abrir no Gmail”: URL de composição só com Para/CC/CCO/Assunto (valores finais da tela, normalizados). O corpo NUNCA vai na URL.
  app.post('/api/emails/gmail-url', (req, res) => res.json(M.buildGmailComposeUrl(req.body || {})));

  // ---------- Copiar (só histórico/auditoria; a cópia em si é feita pela tela) ----------
  const genOrThrow = (gid) => gens().find((s) => s.id === gid) || (() => { throw httpError(404, 'Geração não encontrada.'); })();
  app.post('/api/email-generations/:gid/copied', async (req, res) => {
    const rec = genOrThrow(req.params.gid);
    const what = ['to', 'cc', 'bcc', 'subject', 'body', 'all', 'gmail'].includes(req.body.what) ? req.body.what : (() => { throw httpError(400, 'O que foi copiado é inválido.'); })();
    M.applyCopy(rec, req.body, what);
    await store.save();
    log('email-copiado', { name: rec.projectName }, { detalhe: rec.templateName, item: rec.checklist?.itemTitle, resultado: what });
    res.json({ ok: true, copied: rec.copied });
  });

  // ---------- Histórico ----------
  app.get('/api/email-generations', (req, res) => {
    const pid = str(req.query.projectId, 40);
    res.json(gens().filter((s) => !pid || s.projectId === pid).slice(-200).reverse());
  });
  app.get('/api/email-generations/:gid', async (req, res) => {
    const s = genOrThrow(req.params.gid);
    const out = s.bodyHtml ? await outFor(s.bodyHtml) : null;
    res.json({ ...s, html: out ? out.html : M.bodyToHtml(s.body), attachmentsInfo: resolveAttachments(s.attachments) });
  });

  // ---------- Credenciais do Gmail da versão anterior (não são mais usadas) ----------
  // A integração com o Gmail foi removida. Se ainda houver client secret / token salvos (DPAPI), o usuário pode apagá-los daqui,
  // com confirmação na tela. Nada é apagado automaticamente. A autorização no Google só se revoga lá (myaccount.google.com/permissions).
  const legacy = () => data().integrations?.gmail || null;
  app.get('/api/email-legacy-gmail', (req, res) => {
    const g = legacy();
    res.json({ stored: !!(g && (g.clientSecretEnc || g.refreshTokenEnc || g.clientId)), account: g?.account || null, connectedAt: g?.connectedAt || null });
  });
  app.delete('/api/email-legacy-gmail', async (req, res) => {
    const had = !!legacy();
    if (had) { delete data().integrations.gmail; await store.save(); }
    log('gmail-credenciais-removidas', null, { resultado: had ? 'apagadas deste computador' : 'nada salvo' });
    res.json({ stored: false });
  });
}

module.exports = { mount };
