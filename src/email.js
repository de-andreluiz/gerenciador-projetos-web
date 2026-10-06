// Comunicações (gerador de e-mails) — regras puras (sem HTTP/disco): modelos, REGISTRO CENTRAL de variáveis, destinatários e corpo.
// A aplicação NÃO ENVIA e-mail: monta destinatários/assunto/corpo a partir do modelo e do projeto, mostra a prévia e o usuário COPIA
// e cola no Gmail/Outlook — ou abre a composição do Gmail no navegador (link com Para/CC/CCO/Assunto; o corpo vai pela área de
// transferência) e envia por conta própria. Sem Gmail API, SMTP, OAuth nem mailto. Montar o texto funciona offline.
//
// MODELO × GERAÇÃO (mesma ideia de checklist modelo × execução):
//  - Modelo (data.emailTemplates): definição reutilizável — nome, assunto/corpo com {{variáveis}}, destinatários (fixos e/ou papéis).
//    Escopo "global" (reutilizável; pode ser usado em itens de checklist) ou "project" (só aquele projeto).
//  - Geração (data.emailGenerations): FOTOGRAFIA do que foi gerado/copiado (para/cc/cco, assunto, corpo, o que foi copiado). Não é
//    "envio": a aplicação não sabe se o e-mail foi mesmo enviado. Mudar o modelo depois nunca altera o histórico.
//  - Gerar/copiar NÃO conclui item de checklist.
//
// VARIÁVEIS: só as do registro VARIABLES abaixo existem. Toda substituição passa por renderText(); modelo com variável desconhecida é
// recusado ao salvar. Variável conhecida SEM valor no projeto continua visível no texto ({{...}}) e gera aviso — nunca some em silêncio.
// Para criar uma variável nova: acrescentar aqui (chave, grupo, rótulo, como obter o valor e a mensagem de "faltando").
const { httpError, uid, str } = require('./util');
const { isEmail } = require('./contacts');
const HS = require('./html-safe');

const MAX_SUBJECT = 250;
const MAX_BODY = 20000;
const MAX_RECIPIENTS = 30; // por campo (Para/CC/CCO), depois de resolvidos
const MAX_GENERATIONS = 2000; // histórico guardado no arquivo (as mais antigas saem primeiro)
const CONTACT_KINDS = { stakeholder: 'Stakeholder', client: 'Cliente', other: 'Outro' };

// ---------- Registro de variáveis ----------
// ctx = { project, data, item, stageName } (montado por contextFor). Valor vazio = "faltando": fica {{chave}} no texto + aviso (campo miss).
const fmtDate = (iso) => { if (!iso) return ''; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR'); };
const person = (ctx, id) => (id ? ctx.data.coordinators.find((c) => c.id === id) || null : null);
const currentStage = (ctx) => {
  const step = (ctx.project.steps || []).find((s) => s.id === ctx.project.stepId);
  return step ? ctx.data.stages.find((s) => s.id === step.stageId)?.name || '' : '';
};
const contactsOf = (ctx, kind) => (ctx.project.contacts || []).filter((c) => !kind || c.kind === kind);
// "Início" = quando o projeto entrou na primeira etapa do ciclo (histórico de etapas); o projeto não tem um campo de data de início próprio.
const startedAt = (ctx) => fmtDate((ctx.project.stageHistory || []).find((x) => x.stepId)?.at);
// Saudação pelo horário LOCAL do momento da geração (ctx.now); a regra (faixas) mora em src/greeting.js, compartilhada com o checklist.
const { greetingFor } = require('./greeting');
const nowOf = (c) => c.now || new Date();
const VARIABLES = [
  { key: 'project.name', group: 'Projeto', label: 'Nome do projeto', miss: 'Projeto sem nome.', get: (c) => c.project.name },
  { key: 'project.description', group: 'Projeto', label: 'Descrição do projeto', miss: 'Projeto sem descrição.', get: (c) => c.project.description },
  { key: 'project.current_stage', group: 'Projeto', label: 'Etapa atual do ciclo', miss: 'Projeto sem etapa atual (ciclo ainda não iniciado).', get: currentStage },
  { key: 'project.type', group: 'Projeto', label: 'Tipo de projeto', miss: 'Tipo de projeto não definido.', get: (c) => c.data.projectTypes.find((t) => t.id === c.project.projectTypeId)?.name },
  { key: 'project.cycle', group: 'Projeto', label: 'Ciclo de migração', miss: 'Projeto sem ciclo.', get: (c) => c.data.cycles.find((x) => x.id === c.project.cycleId)?.name },
  { key: 'project.origin_system', group: 'Projeto', label: 'Sistema de origem', miss: 'Sistema de origem não definido.', get: (c) => c.data.originSystems.find((t) => t.id === c.project.originSystemId)?.name },
  { key: 'project.start_date', group: 'Projeto', label: 'Data de início (entrada na 1ª etapa)', miss: 'Projeto sem data de início (nenhuma etapa iniciada).', get: startedAt },
  { key: 'project.created_at', group: 'Projeto', label: 'Data de cadastro do projeto', miss: 'Projeto sem data de cadastro.', get: (c) => fmtDate(c.project.createdAt) },
  { key: 'project.coordinator', group: 'Pessoas', label: 'Nome do coordenador', miss: 'Coordenador não cadastrado no projeto.', get: (c) => person(c, c.project.coordinatorId)?.name },
  { key: 'project.coordinator_email', group: 'Pessoas', label: 'E-mail do coordenador', miss: 'Coordenador sem e-mail cadastrado.', get: (c) => person(c, c.project.coordinatorId)?.email },
  { key: 'project.analyst', group: 'Pessoas', label: 'Nome do analista', miss: 'Analista não cadastrado no projeto.', get: (c) => person(c, c.project.analystId)?.name },
  { key: 'project.analyst_email', group: 'Pessoas', label: 'E-mail do analista', miss: 'Analista sem e-mail cadastrado.', get: (c) => person(c, c.project.analystId)?.email },
  { key: 'project.stakeholders', group: 'Pessoas', label: 'Nomes dos stakeholders do projeto', miss: 'Projeto sem stakeholder definido.', get: (c) => contactsOf(c, 'stakeholder').map((x) => x.name).join(', ') },
  { key: 'checklist.item', group: 'Checklist', label: 'Item do checklist (quando gerado a partir de um item)', miss: 'Variável de checklist usada fora de um item do checklist.', get: (c) => c.item?.title },
  { key: 'checklist.stage', group: 'Checklist', label: 'Etapa do item do checklist', miss: 'Variável de checklist usada fora de um item do checklist.', get: (c) => c.stageName },
  { key: 'today', group: 'Geral', label: 'Data de hoje', miss: '', get: (c) => nowOf(c).toLocaleDateString('pt-BR') },
  { key: 'greeting', group: 'Geral', label: 'Saudação pelo horário da geração (Bom dia / Boa tarde / Boa noite)', miss: '', get: (c) => greetingFor(nowOf(c)) },
];
const VAR_KEYS = new Set(VARIABLES.map((v) => v.key));
const VAR_RE = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi;
const publicVariables = () => VARIABLES.map(({ key, group, label }) => ({ key, group, label }));

function unknownVariables(text) {
  return [...new Set([...String(text || '').matchAll(VAR_RE)].map((m) => m[1].toLowerCase()).filter((k) => !VAR_KEYS.has(k)))];
}
// Só as variáveis COM valor entram no mapa; as demais (conhecidas) ficam de fora e viram aviso em renderText.
function variableValues(ctx) { return Object.fromEntries(VARIABLES.map((v) => [v.key, String(v.get(ctx) ?? '').trim()]).filter(([, val]) => val)); }
// Única função que substitui {{variáveis}}. Conhecida sem valor = "missing" (marcador mantido); desconhecida = "unknown" (marcador mantido).
function renderText(text, values) {
  const unknown = new Set(); const missing = new Set();
  const out = String(text || '').replace(VAR_RE, (m, k) => {
    const key = k.toLowerCase();
    if (key in values) return values[key];
    (VAR_KEYS.has(key) ? missing : unknown).add(key);
    return m;
  });
  return { text: out, unknown: [...unknown], missing: [...missing] };
}
const missingMessage = (key) => VARIABLES.find((v) => v.key === key)?.miss || `Sem valor para {{${key}}}.`;

// ---------- Destinatários ----------
// Cada entrada é um e-mail fixo ou um papel "role:<x>" resolvido no projeto atual.
const ROLES = {
  'role:coordinator': { label: 'Coordenador do projeto' },
  'role:analyst': { label: 'Analista do projeto' },
  'role:stakeholders': { label: 'Stakeholders do projeto' },
  'role:clients': { label: 'Contatos do cliente' },
  'role:contacts': { label: 'Todos os contatos do projeto' },
};
const LEGACY_ROLES = new Set(['role:sender']); // existia quando o app enviava pelo Gmail ("Eu"); ignorado ao salvar/resolver
const publicRoles = () => Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label }));
const norm = (e) => String(e || '').trim().toLowerCase();

function cleanRecipientList(list, what) {
  const raw = Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/);
  const out = [];
  for (const v of raw.map((x) => str(x, 200)).filter(Boolean)) {
    if (LEGACY_ROLES.has(v)) continue;
    if (ROLES[v]) { if (!out.includes(v)) out.push(v); continue; }
    if (!isEmail(v)) throw httpError(400, `${what}: “${v}” não é um e-mail válido nem um contato do projeto.`);
    if (!out.some((x) => norm(x) === norm(v))) out.push(v.trim());
  }
  if (out.length > MAX_RECIPIENTS) throw httpError(400, `${what}: no máximo ${MAX_RECIPIENTS} entradas.`);
  return out;
}

// Resolve papéis no projeto. Tudo que falta vira AVISO (não impede gerar nem copiar): warnings = lista de mensagens.
function resolveRecipients(list, ctx) {
  const emails = []; const warnings = [];
  const add = (e) => { if (!emails.some((x) => norm(x) === norm(e))) emails.push(String(e).trim()); };
  const people = (id, label) => {
    const p = person(ctx, id);
    if (!p) return warnings.push(`${label} não cadastrado no projeto.`);
    if (!p.email) return warnings.push(`${label} (${p.name}) sem e-mail cadastrado.`);
    if (!isEmail(p.email)) return warnings.push(`E-mail do ${label.toLowerCase()} (${p.name}) inválido: ${p.email}.`);
    add(p.email);
  };
  const contacts = (kind, none) => {
    let n = 0;
    for (const c of contactsOf(ctx, kind)) { if (c.email && isEmail(c.email)) { add(c.email); n++; } else warnings.push(`Contato “${c.name}” sem e-mail válido (ignorado).`); }
    if (!n) warnings.push(none);
  };
  for (const v of list || []) {
    if (v === 'role:coordinator') people(ctx.project.coordinatorId, 'Coordenador');
    else if (v === 'role:analyst') people(ctx.project.analystId, 'Analista');
    else if (v === 'role:stakeholders') contacts('stakeholder', 'Projeto sem stakeholder com e-mail definido.');
    else if (v === 'role:clients') contacts('client', 'Projeto sem contato do cliente com e-mail definido.');
    else if (v === 'role:contacts') contacts(null, 'Projeto sem contatos com e-mail definidos.');
    else if (isEmail(v)) add(v);
  }
  return { emails, warnings };
}

// Remove repetidos entre os campos: quem está em Para não se repete em CC/CCO; quem está em CC não se repete em CCO.
function dedupeFields({ to = [], cc = [], bcc = [] }) {
  const seen = new Set();
  const take = (list) => list.filter((e) => { const k = norm(e); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  return { to: take(to), cc: take(cc), bcc: take(bcc) };
}

// ---------- Corpo: texto simples com marcação mínima e SEGURA ----------
// Tudo é escapado primeiro; depois só: **negrito**, linhas "- item" viram lista, http(s):// vira link. Nenhum HTML do usuário passa.
// O HTML serve para a prévia e para copiar com formatação (negrito/lista/link) ao colar no Gmail/Outlook.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function inline(line) {
  return esc(line)
    .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, (u) => `<a href="${u}">${u}</a>`);
}
function bodyToHtml(text, { wrap = true } = {}) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null;
  for (const l of lines) {
    const m = l.match(/^\s*[-*•]\s+(.*)$/);
    if (m) { (list ||= []).push(`<li>${inline(m[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    out.push(l.trim() ? `${inline(l)}<br>` : '<br>');
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  const inner = out.join('\n');
  return wrap ? HS.wrap(inner) : inner;
}
// Versão texto puro (colar em campo sem formatação): só tira os ** do negrito.
const bodyToText = (text) => String(text || '').replace(/\r\n?/g, '\n').replace(/\*\*([^*]+?)\*\*/g, '$1');

// ---------- Modelo ----------
function cleanTemplate(b, data, selfId = null) {
  const name = str(b.name, 80);
  if (!name) throw httpError(400, 'Informe o nome do modelo.');
  if (data.emailTemplates.some((t) => t.id !== selfId && t.name.trim().toLowerCase() === name.toLowerCase())) throw httpError(409, `Já existe um modelo chamado “${name}”.`);
  const subject = String(b.subject ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_SUBJECT);
  if (!subject) throw httpError(400, 'Informe o assunto.');
  // Corpo: HTML rico (bodyHtml, sanitizado; "body" passa a ser a versão em texto puro derivada dele) OU, em modelos antigos / API
  // simples, texto puro ("body"): continua válido e é exibido/convertido sem mudar o visual (bodyToHtml).
  let body; let bodyHtml;
  if (typeof b.bodyHtml === 'string' && b.bodyHtml.trim()) {
    bodyHtml = HS.sanitize(b.bodyHtml);
    if (!HS.hasContent(bodyHtml)) throw httpError(400, 'Informe o corpo do e-mail.');
    body = HS.htmlToText(bodyHtml);
  } else body = String(b.body ?? '').replace(/\r\n?/g, '\n');
  if (!body.trim() && !bodyHtml) throw httpError(400, 'Informe o corpo do e-mail.');
  if (body.length > MAX_BODY) throw httpError(400, `O corpo pode ter até ${MAX_BODY} caracteres.`);
  const unknown = unknownVariables(`${subject}\n${body}`);
  if (unknown.length) throw httpError(400, `Variável desconhecida: ${unknown.map((k) => `{{${k}}}`).join(', ')}. Use só as variáveis da lista.`, { code: 'EMAIL_UNKNOWN_VARIABLE' });
  const scope = b.scope === 'project' ? 'project' : 'global';
  const projectId = scope === 'project' ? str(b.projectId, 40) : null;
  if (scope === 'project' && !data.projects.some((p) => p.id === projectId)) throw httpError(400, 'Escolha o projeto deste modelo específico.');
  return {
    name, description: str(b.description, 300), subject, body, ...(bodyHtml ? { bodyHtml } : {}),
    to: cleanRecipientList(b.to, 'Para'), cc: cleanRecipientList(b.cc, 'CC'), bcc: cleanRecipientList(b.bcc, 'CCO'),
    active: b.active === undefined ? true : !!b.active, scope, projectId,
    attachments: cleanAttachments(b.attachments, data),
  };
}

// Anexos SUGERIDOS do modelo: só referências a Documentos e Modelos (data.documents). Nada é copiado nem enviado: o usuário abre os
// arquivos pela tela e anexa à mão no Gmail/Outlook. O título fica como fotografia para avisar quando o documento some.
const MAX_ATTACH = 10;
function cleanAttachments(list, data) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const documentId = str(x && typeof x === 'object' ? x.documentId : x, 40);
    if (!documentId || out.some((o) => o.documentId === documentId)) continue;
    const d = (data.documents || []).find((y) => y.id === documentId);
    out.push({ documentId, title: d ? d.title : str(x?.title, 160) || '(documento)' });
  }
  if (out.length > MAX_ATTACH) throw httpError(400, `No máximo ${MAX_ATTACH} anexos sugeridos por modelo.`);
  return out;
}

// Modelos que um projeto pode usar: globais (todos, ou só os escolhidos em project.emailTemplateIds) + os específicos dele. Só ativos.
function availableFor(data, project) {
  const pick = Array.isArray(project.emailTemplateIds) ? new Set(project.emailTemplateIds) : null;
  return data.emailTemplates.filter((t) => t.active && (t.scope === 'project' ? t.projectId === project.id : !pick || pick.has(t.id)));
}
// Um modelo pode ser usado neste projeto? (item de checklist pode usar um global mesmo fora da seleção do projeto: o item o pede)
function usableIn(data, project, t, { fromItem = false } = {}) {
  if (!t) return 'Modelo de e-mail não encontrado.';
  if (!t.active) return `O modelo “${t.name}” está desativado.`;
  if (t.scope === 'project' && t.projectId !== project.id) return `O modelo “${t.name}” é específico de outro projeto.`;
  if (!fromItem && t.scope === 'global' && Array.isArray(project.emailTemplateIds) && !project.emailTemplateIds.includes(t.id)) return `O modelo “${t.name}” não está habilitado para este projeto.`;
  return null;
}

// Onde o modelo é usado (para não excluir algo em uso e para mostrar no editor).
function templateUsage(data, id) {
  const items = data.checklistItems.filter((i) => i.emailTemplateId === id).length;
  const inst = data.projects.reduce((n, p) => n + (p.checklists || []).reduce((m, c) => m + c.items.filter((i) => i.emailTemplateId === id).length, 0), 0);
  const generations = (data.emailGenerations || []).filter((s) => s.templateId === id).length;
  const projects = data.projects.filter((p) => Array.isArray(p.emailTemplateIds) && p.emailTemplateIds.includes(id)).length;
  return { checklistItems: items, projectItems: inst, generations, projects };
}

// ---------- Geração (sem envio) ----------
// now = instante da geração (padrão: agora); injetável nos testes.
function contextFor(data, project, { item = null, stageName = '', now = new Date() } = {}) { return { data, project, item, stageName, now }; }

// Corpo do modelo com as variáveis resolvidas. Modelo rico (bodyHtml): os valores entram ESCAPADOS no HTML (as tags e estilos
// permitidos ficam intactos) e o resultado passa de novo pela sanitização; "text" é a versão text/plain. Modelo antigo (só texto):
// resolve no texto e converte com bodyToHtml (negrito **, listas "- ", links), sem mudar o visual de sempre.
function renderBody(t, values) {
  if (t.bodyHtml) {
    const esc2 = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, HS.esc(v)]));
    const r = renderText(t.bodyHtml, esc2);
    const fragment = HS.sanitize(r.text);
    return { fragment, text: HS.htmlToText(fragment), missing: r.missing, unknown: r.unknown };
  }
  const r = renderText(t.body, values);
  return { fragment: bodyToHtml(r.text, { wrap: false }), text: r.text, missing: r.missing, unknown: r.unknown };
}
// Fragmento sanitizado → o que a prévia mostra E o que é copiado (o MESMO HTML): imagens do modelo (/api/email-images/<id>) viram
// data URL (conteúdo autossuficiente para colar no e-mail); text = text/plain equivalente. missingImages = referências sem arquivo.
const IMG_TAG = /<img\b[^>]*?src="\/api\/email-images\/([a-f0-9]{12})"[^>]*>/g;
function renderOut(fragment, resolveImg) {
  const missingImages = [];
  const inlined = String(fragment || '').replace(IMG_TAG, (tag, id) => {
    const data = resolveImg ? resolveImg(id) : null;
    if (!data) { missingImages.push(id); return ''; }
    return tag.replace(`/api/email-images/${id}`, data);
  });
  return { html: HS.wrap(inlined), text: HS.htmlToText(fragment), missingImages };
}

// Monta o e-mail do modelo para o projeto. warnings = tudo que o usuário deve corrigir/conferir antes de copiar.
function generate(t, ctx) {
  const values = variableValues(ctx);
  const subject = renderText(t.subject, values);
  const body = renderBody(t, values);
  const r = { to: resolveRecipients(t.to, ctx), cc: resolveRecipients(t.cc, ctx), bcc: resolveRecipients(t.bcc, ctx) };
  const fields = dedupeFields({ to: r.to.emails, cc: r.cc.emails, bcc: r.bcc.emails });
  const warnings = [...new Set([...r.to.warnings, ...r.cc.warnings, ...r.bcc.warnings, ...[...subject.missing, ...body.missing].map(missingMessage)])];
  if ((t.to || []).length && !fields.to.length) warnings.unshift('Nenhum destinatário em “Para” foi resolvido.');
  if (!(t.to || []).length) warnings.unshift('Este modelo não tem destinatários em “Para”.');
  return {
    ...fields, subject: subject.text.replace(/[\r\n]+/g, ' '), body: body.text, bodyHtml: body.fragment,
    missingVariables: [...new Set([...subject.missing, ...body.missing])], unknownVariables: [...new Set([...subject.unknown, ...body.unknown])], warnings,
  };
}

// ---------- Abrir no Gmail (navegador) ----------
// Link de COMPOSIÇÃO do Gmail com Para/CC/CCO/Assunto. O CORPO nunca vai na URL (HTML rico, tabelas e imagens perderiam a formatação e
// estourariam o limite): ele segue pela área de transferência (text/html + text/plain). Não é Gmail API nem automação: é só um endereço que o
// navegador abre; o remetente é a conta já logada no Gmail e quem revisa, anexa e envia é o usuário.
const GMAIL_COMPOSE = 'https://mail.google.com/mail/?view=cm&fs=1';
function buildGmailComposeUrl({ to, cc, bcc, subject } = {}) {
  const invalid = [];
  const addrs = (v) => {
    const seen = new Set(); const out = [];
    for (const x of (Array.isArray(v) ? v : [v]).flatMap((e) => String(e ?? '').split(/[\s,;]+/)).map((e) => e.trim()).filter(Boolean)) {
      if (!isEmail(x)) { invalid.push(x); continue; }
      if (!seen.has(x.toLowerCase()) && out.length < MAX_RECIPIENTS) { seen.add(x.toLowerCase()); out.push(x); }
    }
    return out;
  };
  const lists = { to: addrs(to), cc: addrs(cc), bcc: addrs(bcc) };
  const su = String(subject ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_SUBJECT);
  const enc = encodeURIComponent;
  let url = GMAIL_COMPOSE;
  for (const k of ['to', 'cc', 'bcc']) if (lists[k].length) url += `&${k}=${lists[k].map(enc).join('%2C')}`;
  if (su) url += `&su=${enc(su)}`;
  const warnings = [];
  if (invalid.length) warnings.push(`Endereço(s) inválido(s) não levados ao Gmail: ${[...new Set(invalid)].join(', ')}.`);
  if (!lists.to.length) warnings.push('Nenhum destinatário em “Para” foi levado ao Gmail.');
  return { url, ...lists, subject: su, warnings };
}

// Fotografia gravada no histórico. "copied" = o que o usuário copiou (to, cc, bcc, subject, body, all). Não é um envio.
function generationRecord({ project, template, checklist, g, by, attachments = [] }) {
  return {
    id: uid(), at: new Date().toISOString(), by: by || null, projectId: project.id, projectName: project.name,
    templateId: template?.id || null, templateName: template?.name || null, checklist: checklist || null,
    to: g.to, cc: g.cc, bcc: g.bcc, subject: g.subject, body: g.body, ...(g.bodyHtml ? { bodyHtml: g.bodyHtml } : {}), attachments: attachments.map((a) => ({ documentId: a.documentId, title: a.title })), edited: false, copied: [], copiedAt: null,
  };
}
// Último "Gerar e-mail" feito a partir de um item de checklist (para mostrar no item).
function lastGenerationFor(data, projectId, itemId) {
  const list = data.emailGenerations || [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i].projectId === projectId && list[i].checklist?.itemId === itemId) return list[i];
  return null;
}
// Valores finais (possivelmente editados na tela) que o usuário copiou: atualiza a fotografia.
function applyCopy(rec, b, what) {
  const list = (v) => (Array.isArray(v) ? v : []).map((x) => String(x || '').trim()).filter((x) => isEmail(x) && !/[\r\n]/.test(x)).slice(0, MAX_RECIPIENTS);
  if (b.to !== undefined) rec.to = list(b.to);
  if (b.cc !== undefined) rec.cc = list(b.cc);
  if (b.bcc !== undefined) rec.bcc = list(b.bcc);
  if (b.subject !== undefined) rec.subject = String(b.subject).replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_SUBJECT);
  if (typeof b.bodyHtml === 'string') { rec.bodyHtml = HS.sanitize(b.bodyHtml); rec.body = HS.htmlToText(rec.bodyHtml).slice(0, MAX_BODY); } else if (b.body !== undefined) { rec.body = String(b.body).replace(/\r\n?/g, '\n').slice(0, MAX_BODY); delete rec.bodyHtml; }
  if (b.edited !== undefined) rec.edited = rec.edited || !!b.edited;
  if (!rec.copied.includes(what)) rec.copied.push(what);
  rec.copiedAt = new Date().toISOString();
}

// ---------- Contatos do projeto (stakeholders, cliente, outros) ----------
function cleanContact(b) {
  const name = str(b.name, 120);
  if (!name) throw httpError(400, 'Informe o nome do contato.');
  const email = str(b.email, 200);
  if (email && !isEmail(email)) throw httpError(400, 'E-mail inválido.');
  const kind = CONTACT_KINDS[b.kind] ? b.kind : 'stakeholder';
  return { name, email, kind, role: str(b.role, 120), phone: str(b.phone, 40), notes: str(b.notes, 300) };
}

module.exports = {
  publicVariables, unknownVariables, variableValues, renderText, greetingFor, publicRoles, CONTACT_KINDS,
  bodyToHtml, bodyToText, renderBody, renderOut, cleanAttachments, cleanTemplate, availableFor, usableIn, templateUsage, contextFor, generate, generationRecord, lastGenerationFor, applyCopy, buildGmailComposeUrl, cleanContact,
  MAX_GENERATIONS,
};
