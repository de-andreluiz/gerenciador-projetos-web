// Estágios e ciclo de migração padrão. Ids fixos (determinísticos): assim os dados antigos, que ainda não têm
// estágios, recebem os mesmos ids a cada carga até serem salvos.
const DEFAULT_STAGES = [
  { id: 'st-homologacao', name: 'Homologação', color: '#00DBFF' },
  { id: 'st-documentacao', name: 'Documentação', color: '#A44DFF' },
  { id: 'st-correcoes', name: 'Correções', color: '#FF8900' },
  { id: 'st-producao', name: 'Produção', color: '#00FFD4' },
  { id: 'st-concluido', name: 'Concluído', color: '#D9FF65' },
];

// Homologação → Documentação → Correções → Produção → Documentação → Correções → Concluído
const DEFAULT_CYCLE = [
  { id: 'cy-1', stageId: 'st-homologacao' },
  { id: 'cy-2', stageId: 'st-documentacao' },
  { id: 'cy-3', stageId: 'st-correcoes' },
  { id: 'cy-4', stageId: 'st-producao' },
  { id: 'cy-5', stageId: 'st-documentacao' },
  { id: 'cy-6', stageId: 'st-correcoes' },
  { id: 'cy-7', stageId: 'st-concluido' },
];

const clone = (x) => JSON.parse(JSON.stringify(x));
const { ensureHours } = require('./hours');
const { ensureCycles } = require('./cycles');

// Completa dados antigos com os campos novos, sem alterar nada do que já existe (idempotente).
function applyDefaults(data) {
  if (!Array.isArray(data.coordinators)) data.coordinators = [];
  if (!Array.isArray(data.documents)) data.documents = [];
  if (!Array.isArray(data.stages)) data.stages = clone(DEFAULT_STAGES);
  // Tipo de projeto (ex.: TOTVS Educacional, TOTVS Folha) e sistema de origem: catálogos livres, sem padrão pré-cadastrado.
  if (!Array.isArray(data.projectTypes)) data.projectTypes = [];
  if (!Array.isArray(data.originSystems)) data.originSystems = [];
  // Scripts SQL executados depois da importação (os .sql ficam em <data>\scripts; aqui só os metadados).
  if (!Array.isArray(data.scripts)) data.scripts = [];
  // Controle de horas: jornada (data.hours), apontamentos confirmados (timeEntries) e cronômetros em andamento/pausados (timers).
  ensureHours(data);
  // Checklists reutilizáveis (modelo): itens agrupados por checklistId; quem os associa a estágio e ciclo é o passo do ciclo
  // (step.checklistIds). A execução de cada projeto fica em project.checklists.
  if (!Array.isArray(data.checklistItems)) data.checklistItems = [];
  // Conexões de banco cadastradas uma vez e reutilizadas (senha com DPAPI, como nas bases).
  if (!Array.isArray(data.connections)) data.connections = [];
  // Workspace: pasta raiz com vários projetos (repositórios). Aqui só a pasta e nomes de exibição; os arquivos ficam no disco.
  if (!data.workspace || typeof data.workspace !== 'object') data.workspace = { root: '', aliases: {} };
  if (!data.workspace.aliases || typeof data.workspace.aliases !== 'object') data.workspace.aliases = {};
  // Comunicações: modelos de e-mail reutilizáveis e o histórico de e-mails GERADOS (a aplicação não envia). Ver src/email.js.
  if (!Array.isArray(data.emailTemplates)) data.emailTemplates = [];
  if (!Array.isArray(data.emailGenerations)) data.emailGenerations = [];
  if (!Array.isArray(data.emailImages)) data.emailImages = []; // imagens do corpo dos modelos (arquivos em data/evidencias/comunicacoes/imagens)
  for (const p of data.projects || []) {
    if (p.coordinatorId === undefined) p.coordinatorId = null;
    // Contatos externos do projeto (stakeholders/cliente) e modelos de e-mail habilitados (null = todos os globais ativos).
    if (!Array.isArray(p.contacts)) p.contacts = [];
    if (p.emailTemplateIds === undefined) p.emailTemplateIds = null;
    if (p.stepId === undefined) p.stepId = null;
    if (p.projectTypeId === undefined) p.projectTypeId = null;
    if (p.originSystemId === undefined) p.originSystemId = null;
    if (!Array.isArray(p.stageHistory)) p.stageHistory = [];
    if (!Array.isArray(p.corrections)) p.corrections = [];
    if (!Array.isArray(p.checklists)) p.checklists = [];
    // Pasta raiz: local (padrão, compatível com o que já existia) ou link de uma pasta do Google Drive.
    if (p.rootDirKind === undefined) p.rootDirKind = 'local';
    if (p.rootDriveUrl === undefined) p.rootDriveUrl = '';
    // Planilhas cadastradas antes desta versão sempre puderam ser importadas: continuam podendo.
    for (const d of p.deparas || []) if (d.importable === undefined) d.importable = true;
    // Origem da importação: planilhas antigas continuam no modo de arquivo único.
    for (const d of p.deparas || []) { if (d.importMode === undefined) d.importMode = 'file'; if (d.sourceDir === undefined) d.sourceDir = ''; }
  }
  if (!data.integrations || typeof data.integrations !== 'object') data.integrations = {}; // legado: credenciais do Gmail da versão anterior (só criptografadas); o usuário pode apagá-las em Configurações → Comunicações
  if (data.settings && data.settings.defaultConnectionId === undefined) data.settings.defaultConnectionId = null;
  for (const p of data.projects || []) if (p.defaultConnectionId === undefined) p.defaultConnectionId = null;
  // Ciclos por tipo de projeto (o ciclo único antigo vira o "Ciclo de migração padrão") e N checklists por passo do ciclo
  // (os que o estágio tinha viram os checklists de cada passo que o usa: nada muda nos projetos).
  ensureCycles(data, DEFAULT_CYCLE);
  return data;
}

module.exports = { DEFAULT_STAGES, DEFAULT_CYCLE, applyDefaults, clone };
