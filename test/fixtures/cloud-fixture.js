// Estado fictício completo (mesmo formato do projects.json) para testar o mapeamento nuvem/local.
// Cobre todo tipo de campo que precisa de tratamento: caminhos de disco, senhas DPAPI, contatos, evidências, execuções de script,
// e-mails gerados, modelos com destinatário literal, horas. Nenhum valor real. Os textos-CANÁRIO (SENSIVEL_*) nunca podem
// aparecer em claro nas partes que vão para a nuvem.
'use strict';

const CANARY = {
  projectName: 'SENSIVEL_Cliente Exemplo Ltda',
  description: 'SENSIVEL_descricao do contrato',
  contactName: 'SENSIVEL_Pessoa Contato',
  contactEmail: 'sensivel.contato@exemplo.test',
  personEmail: 'sensivel.pessoa@exemplo.test',
  personPhone: '+55 11 90000-0000',
  server: 'sensivel-srv.exemplo.test',
  note: 'SENSIVEL_observacao do item',
  evidenceName: 'SENSIVEL_print_tela.png',
  emailBody: 'SENSIVEL_corpo do email',
  templateAddr: 'sensivel.destino@exemplo.test',
  driveUrl: 'https://drive.google.com/drive/folders/SENSIVEL123',
  waUrl: 'https://chat.whatsapp.com/SENSIVELabc',
};
const PATHS = { root: 'C:\\Clientes\\SENSIVEL_PASTA', baseDir: 'C:\\Repos\\SENSIVEL_BASE', target: 'C:\\Planilhas\\SENSIVEL', envDir: 'C:\\RM\\HMG\\SENSIVEL', ref: 'C:\\Docs\\SENSIVEL.pdf', doc: 'C:\\Modelos\\SENSIVEL.docx' };
const DPAPI = 'DPAPI_FAKE_BLOB_conexao'; // representa um blob DPAPI (nunca pode ir à nuvem)

function fixture() {
  return {
    version: 1,
    settings: { warnDays: 7, defaultConnectionId: 'cx1' },
    defaultCycleId: 'cyc-1',
    integrations: {},
    stages: [{ id: 'st-a', name: 'Homologação', color: '#00DBFF' }, { id: 'st-b', name: 'Produção', color: '#00FFD4' }],
    cycles: [{ id: 'cyc-1', name: 'Ciclo A', description: '', version: 2, updatedAt: '2026-10-01T10:00:00.000Z',
      steps: [{ id: 'cy-1', stageId: 'st-a', checklistIds: ['ck-1'] }, { id: 'cy-2', stageId: 'st-b', checklistIds: [] }] }],
    projectTypes: [{ id: 'pt-1', name: 'Tipo X', color: '#111111', cycleId: 'cyc-1' }],
    originSystems: [{ id: 'os-1', name: 'Origem Y', color: '#222222' }],
    checklists: [{ id: 'ck-1', name: 'Infra', stageId: 'st-a' }],
    checklistItems: [
      { id: 'it-1', checklistId: 'ck-1', title: 'Backup', description: 'd', required: true, carryForward: false, dependsOn: [],
        evidence: { mode: 'required', type: 'image', min: 1, max: 3 }, links: [], scriptIds: ['sc-1'], condition: null },
      { id: 'it-2', checklistId: 'ck-1', title: 'Validar', description: '', required: false, carryForward: false, dependsOn: ['it-1'],
        evidence: { mode: 'none', type: 'any', min: 0, max: 1 }, links: [], scriptIds: [], condition: null },
    ],
    documents: [
      { id: 'doc-1', createdAt: '2026-09-01T00:00:00.000Z', title: 'Guia', kind: 'modelo', stageId: 'st-a', description: '', source: { type: 'link', url: 'https://exemplo.test/guia' } },
      { id: 'doc-2', createdAt: '2026-09-02T00:00:00.000Z', title: 'Modelo local', kind: 'documento', stageId: null, description: '', source: { type: 'file', path: PATHS.doc } },
    ],
    emailImages: [{ id: 'img-1', name: 'logo.png', file: 'comunicacoes/imagens/img-1.png', mime: 'image/png', size: 10, at: '2026-09-03T00:00:00.000Z' }],
    scripts: [{ id: 'sc-2', name: 'B', description: '', file: 'b.sql', createdAt: '2026-09-05', updatedAt: '2026-09-05' },
      { id: 'sc-1', name: 'A', description: '', file: 'a.sql', createdAt: '2026-09-04', updatedAt: '2026-09-04' }],
    coordinators: [{ id: 'pe-1', name: 'SENSIVEL_Coordenadora', role: 'Coord', email: CANARY.personEmail, phone: CANARY.personPhone, notes: '' }],
    connections: [{ id: 'cx1', name: 'SENSIVEL_Producao Cliente', env: 'prod', server: CANARY.server, port: 1433, database: 'DB', auth: 'sql', user: 'sensivel_user',
      encrypt: true, trustServerCertificate: true, passwordEnc: DPAPI, allowDestructive: false, notes: '', createdAt: '2026-09-01', updatedAt: '2026-09-01' }],
    emailTemplates: [
      { id: 'tp-1', name: 'Aviso', description: '', subject: '[{{project.name}}] Aviso', body: 'Olá', to: [CANARY.templateAddr, 'role:coordinator'], cc: [], bcc: [],
        active: true, scope: 'global', projectId: null, attachments: [], createdAt: '2026-09-01', updatedAt: '2026-09-01' },
      { id: 'tp-2', name: 'Do projeto', description: '', subject: 'S', body: 'B', to: ['role:clients'], cc: [], bcc: [], active: true, scope: 'project', projectId: 'p1',
        attachments: [], createdAt: '2026-09-01', updatedAt: '2026-09-01' },
    ],
    emailGenerations: [
      { id: 'g1', at: '2026-09-10T10:00:00.000Z', by: 'usuario', projectId: 'p1', projectName: CANARY.projectName, templateId: 'tp-1', templateName: 'Aviso',
        checklist: null, to: [CANARY.contactEmail], cc: [], bcc: [], subject: 'Assunto', body: CANARY.emailBody, attachments: [], edited: false, copied: ['all'], copiedAt: '2026-09-10T10:01:00.000Z' },
    ],
    projects: [{
      id: 'p1', name: CANARY.projectName, description: CANARY.description, createdAt: '2026-09-01T00:00:00.000Z',
      rootDirKind: 'local', rootDir: PATHS.root, rootDriveUrl: CANARY.driveUrl, coordinatorId: 'pe-1', analystId: null,
      projectTypeId: 'pt-1', originSystemId: 'os-1', defaultConnectionId: 'cx1', cycleId: 'cyc-1', cycleVersion: 2, stepId: 'cy-1',
      steps: [{ id: 'cy-1', stageId: 'st-a', checklistIds: ['ck-1'] }, { id: 'cy-2', stageId: 'st-b', checklistIds: [] }],
      stageHistory: [{ stepId: 'cy-1', stageId: 'st-a', name: 'Homologação', color: '#00DBFF', at: '2026-09-02T00:00:00.000Z' }],
      bases: [
        { id: 'b1', name: 'SENSIVEL_Base', directory: PATHS.baseDir, allowProdOverwrite: false, prod: { connectionId: 'cx1', database: 'DB1' }, local: { server: 'localhost', port: null, database: 'L', auth: 'windows', user: '', encrypt: true, trustServerCertificate: true, passwordEnc: null } },
        { id: 'b2', name: 'Base propria', directory: PATHS.baseDir, allowProdOverwrite: false, prod: { server: CANARY.server, port: null, database: 'X', auth: 'sql', user: 'u', encrypt: true, trustServerCertificate: true, passwordEnc: DPAPI }, local: null },
      ],
      deparas: [{ id: 'd1', label: 'SENSIVEL_Planilha', url: 'https://docs.google.com/spreadsheets/d/SENSIVEL', targetDir: PATHS.target, fileName: 'x.xlsx', importable: true,
        lastDownload: { at: '2026-09-03', path: `${PATHS.target}\\x.xlsx`, size: 10, manual: true }, importMode: 'file', sourceDir: '', importConfig: null }],
      milestones: [{ id: 'm1', title: 'SENSIVEL_Entrega', dueDate: '2026-12-01', alertDays: null, done: false, note: '' }],
      corrections: [{ id: 'cr1', label: 'Rodada 1', url: 'https://docs.google.com/spreadsheets/d/SENSIVELcorr', note: '' }],
      contacts: [{ id: 'ct1', name: CANARY.contactName, email: CANARY.contactEmail, kind: 'client', role: 'TI', phone: '', notes: '' },
        { id: 'ct2', name: 'SENSIVEL_Outro', email: '', kind: 'stakeholder', role: '', phone: '', notes: '' }],
      emailTemplateIds: null, whatsappGroupUrl: CANARY.waUrl,
      environments: { hml: { downloadUrl: 'https://exemplo.test/SENSIVEL.zip', dir: PATHS.envDir }, prod: { downloadUrl: '', dir: '' } },
      notes: [{ id: 'n1', title: 'SENSIVEL_Nota', text: 'SENSIVEL_texto', createdAt: '2026-09-01', updatedAt: '2026-09-01', by: 'usuario',
        refs: [{ id: 'r1', kind: 'link', label: 'Wiki', url: 'https://exemplo.test/w' }, { id: 'r2', kind: 'file', label: 'Contrato', path: PATHS.ref }] }],
      workspace: { sqlRoot: PATHS.root, gitRoot: '', dialect: 'mssql' },
      checklists: [
        { id: 'ci-1', stepId: 'cy-1', stageId: 'st-a', stageName: 'Homologação', createdAt: '2026-09-02T00:00:00.000Z', syncedAt: null,
          items: [{ id: 'ii-1', defId: 'it-1', checklistId: 'ck-1', title: 'Backup', description: 'd', required: true, evidence: { mode: 'required', type: 'image', min: 1, max: 3 },
            links: [], scriptIds: ['sc-1'], condition: null, done: true, doneAt: '2026-09-03', doneBy: 'usuario', completedAt: '2026-09-03', completedBy: 'usuario',
            note: { text: CANARY.note, updatedAt: '2026-09-03', updatedBy: 'usuario' },
            evidences: [{ id: 'e1', name: CANARY.evidenceName, file: 'sensivel-cliente-exemplo-ltda-p1/01-homologacao/e1_SENSIVEL_print_tela.png', mime: 'image/png', kind: 'image', size: 100, description: 'SENSIVEL_desc', at: '2026-09-03', by: 'usuario' }],
            runs: [{ at: '2026-09-03', by: 'usuario', scriptId: 'sc-1', target: CANARY.server, ok: true }], carriedTo: null, carriedAt: null, carryHistory: [], dependsOn: [], carryForward: false, archived: false }] },
        { id: 'ci-0', stepId: 'cy-2', stageId: 'st-b', stageName: 'Produção', createdAt: '2026-09-01T00:00:00.000Z', syncedAt: null, items: [] },
      ],
    }],
    hours: { schedule: { start: '08:00', end: '17:00', breakMin: 60, week: {} }, overrides: [], alert: { enabled: true }, trackingFrom: null, noteCategories: [] },
    timers: [],
    timeEntries: [{ id: 'te1', projectId: 'p1', projectName: CANARY.projectName, date: '2026-09-03', startMin: 480, endMin: 540, pausedMin: 0, activity: 'x', note: '' }],
    timeNotes: [],
    workspace: { root: PATHS.root, aliases: {} },
  };
}

module.exports = { fixture, CANARY, PATHS, DPAPI };
