# ARCHITECTURE MIGRATION PLAN — Gerenciador de Projetos multiusuário

> Versão 0.1 — **Fase 0 (inventário e arquitetura)**, 2026-10-05. Nenhum código foi alterado.
> Decisões: seção 22 (D1, D2, D4, D5 decididas em 2026-10-05). O que depende de ação sua: **AÇÃO NECESSÁRIA DO USUÁRIO**.
> Classificação detalhada: [DATA-CLASSIFICATION.md](../DATA-CLASSIFICATION.md).

---

## 1. Situação atual (inventário verificado no código)

### 1.1 Processos
```
Electron (main.js) ─► Express 127.0.0.1:4317+ (server.js) ─► SPA vanilla (public/*.js)
   src/*-api.js (rotas)  →  regras puras (checklist, cycles, hours, sqlplan, sqlscan, email)
   Store: data/projects.json (UM arquivo, reescrito inteiro a cada mutação) + data/audit.log
   SQL Server: processo-filho · Git: spawn sem shell · PowerShell: scripts fixos (DPAPI, diálogos)
```
Modo web alternativo (`node server.js`) usa a mesma pasta `data/`. Sem login; identidade = usuário do Windows (`os.userInfo()`).

### 1.2 Persistência
| Local | Conteúdo | Volume atual |
|---|---|---|
| `data/projects.json` | **tudo**: projetos, configurações, conexões, horas, e-mails gerados | 1,4 MB · 14 projetos · 6 pessoas · 22 estágios · 3 ciclos · 17 checklists / 93 itens · 12 scripts · 3 modelos de e-mail · 25 e-mails gerados · 1 conexão · 26 apontamentos de horas |
| `data/projects.json.bak`, `.antes-checklists-por-ciclo.bak` | cópias automáticas | |
| `data/audit.log` | JSON Lines, 1.730 eventos, 66 tipos de ação | 0,5 MB |
| `data/evidencias/` | anexos do checklist, observações de horas, imagens de e-mail, `.removidas` | 1,2 MB |
| `data/scripts/` | `.sql` + `.versoes` + `.removidos` | 0,2 MB |
| `localStorage` (tela) | tema, pastas recentes, preferências de execução, soneca do aviso de horas | sem dado sensível |

**Ponto de acoplamento:** 98 chamadas `store.save()` em 12 arquivos; as regras puras operam sobre o objeto `store.data`; `GET /api/state` devolve tudo.

### 1.3 Achados que mudam o desenho
| # | Achado | Consequência |
|---|---|---|
| A1 | Caminhos de disco dentro do projeto (`rootDir`, `bases[].directory`, `deparas[].targetDir/sourceDir/lastDownload.path`, `environments.*.dir`, refs de observações, documentos tipo arquivo, raiz do Workspace) | caminho é **da máquina**, não do projeto → vínculo local por usuário/máquina **[D2]** |
| A2 | Horas estão **dentro** de `projects.json` (`hours`, `timers`, `timeEntries`, `timeNotes`) + `evidencias/horas` | precisam ser **extraídas** para a pasta local do usuário antes de qualquer envio à nuvem |
| A3 | Evidências e imagens de e-mail são arquivos locais referenciados por estado compartilhado | em outra máquina o checklist mostraria evidência inacessível **[D1]** |
| A4 | Scripts SQL são arquivos editados fora do app (SSMS/VS Code) e referenciados por itens de checklist globais | compartilhar exige cópia de trabalho local + envio **[D5]** |
| A5 | `data/` fica dentro da pasta do código | atualização do código pode atingir dados → separar |
| A6 | Senha de conexão com DPAPI (`passwordEnc`) | correto para segredo local; **não** pode ir à nuvem (outro usuário não decifra) |
| A7 | Auditoria local guarda nome de projeto, servidor e trecho de SQL | não vai para a nuvem como está; revisar campos |
| A8 | Código **não está no Git** | sem rollback de código: Git local é pré-requisito da Fase 1 |
| A9 | `integrations.gmail` (legado) vazio | não migrar |
| A10 | Regras de fluxo (`checkAdvance`, carry, dependências) rodam no servidor local, que para o Supabase é **cliente** | autorização tem de estar no banco (RLS/RPC); regras de fluxo continuam locais (limitação documentada) |

### 1.4 Buscas atuais
Todas em memória na tela (checklists por nome, documentos por título/descrição, auditoria por filtros) ou no disco (Workspace).
**Nenhuma busca server-side sobre campo que será cifrado** → blind index não é necessário agora.

### 1.5 Baseline de testes
2026-10-05, Node 24: **187/187**, 0 falhas (`node --test "test/*.test.js"`).

---

## 2. Situação alvo

```
                         GitHub (privado)
          código · tags de versão · migrations · Edge Functions · docs
                               │  build assinado (MASTER)
                               ▼
┌────────────────────────── Máquina do usuário ───────────────────────────┐
│ Electron ─► servidor local 127.0.0.1 (Express)  ◄── SPA (sem tokens)    │
│              │  services (regras puras, sem mudança)                     │
│              │  Store/UnitOfWork ─► Repositories ─► SupabaseBackend      │
│              │                      │               (LocalJsonBackend só │
│              │                      │                p/ testes e import) │
│              │  CryptoService (AES-256-GCM, DEKs só em memória)          │
│              │  LocalData: %LOCALAPPDATA%\GerenciadorProjetos\users\<uuid>\
│              │     horas · vínculos de pastas · senhas DPAPI · sessão DPAPI│
└──────────────┼──────────────────────────────────────────────────────────┘
               │ HTTPS + JWT do usuário (publishable key)
               ▼
┌──────────────────────────── Supabase ───────────────────────────────────┐
│ Auth (convite, senha, recuperação, ban)                                 │
│ Postgres: profiles · permissions · project_members · projects · config  │
│           RLS deny-by-default · RPCs SECURITY DEFINER para admin        │
│           colunas `enc` = ciphertext (envelope AES-256-GCM)             │
│           audit_events (append-only, triggers)                          │
│ Edge Functions: gp-keys (KEK → DEKs) · gp-admin (convite/suspensão)     │
│ Storage privado: evidências cifradas [D1] · releases assinadas [D4]     │
└─────────────────────────────────────────────────────────────────────────┘
```
Regra de ouro: **GitHub = código; Supabase = dados compartilhados e identidade; máquina = horas, vínculos locais, segredos locais.**

---

## 3. Classificação de dados
Resumo (detalhe em DATA-CLASSIFICATION.md): níveis PUBLIC/TECHNICAL · INTERNAL · CONFIDENTIAL · PERSONAL · SECRET · LOCAL-PERSONAL.
- **Cifrado na aplicação**: nome/descrição do projeto, links (Drive, planilhas, correções, WhatsApp, download RM), observações, contatos, pessoas,
  destinatários fixos de modelos, e-mails gerados, observações de itens, metadados e arquivos de evidência, nome/servidor/usuário de conexões.
- **Em claro (com RLS)**: ids, datas, estados, flags, estrutura de ciclos/checklists/estágios, ordem, versões — tudo o que FK, filtro, RLS ou regra precisa.
- **Nunca na nuvem**: horas, caminhos de disco, senhas de banco, tokens.

---

## 4. Modelo de identidade

- **Supabase Auth** é a única fonte de identidade. O app nunca armazena senha nem hash.
- **Login por e-mail + senha** **[D3]**. `username` (ex.: `Elton.Oliveira`) é identificador de exibição em `profiles`, único, nunca usado como chave nem como regra.
- `profiles(id uuid PK → auth.users, username, display_name, role, status, …)` criado por **trigger** em `auth.users` com `role='USER'`, `status='pending'`, sem permissões.
- **Estados**
  | status | Como chega | Acesso |
  |---|---|---|
  | `invited` | MASTER/ADMIN convida (Edge Function `gp-admin`) | nenhum (ainda sem senha) |
  | `pending` (PENDING_SETUP) | primeiro login após definir a senha | só a tela “Aguardando configuração pelo administrador” |
  | `active` | MASTER/ADMIN provisiona (RPC) | conforme role + permissões + projetos |
  | `suspended` | MASTER/ADMIN suspende (RPC + ban no Auth) | nenhum; refresh de sessão falha |
  O bloqueio é no banco: **toda** política RLS de dado compartilhado começa com `gp.is_active()`; UI apenas reflete.
- **Convite sem URL de retorno**: app desktop não tem página web. O e-mail de convite/recuperação traz um **código** (`{{ .Token }}`);
  a tela “Primeiro acesso / Esqueci a senha” chama `verifyOtp({ type: 'invite'|'recovery' })` e em seguida `updateUser({ password })`.
- **Sessão**: tokens ficam **só no processo local (Node)**, nunca no renderer/`localStorage`. Refresh automático; “manter conectado” grava o
  refresh token em arquivo **DPAPI** na pasta do usuário. Expirada/revogada → 401 `AUTH_REQUIRED` → tela de login. Logout: `signOut`
  (revoga refresh token), zera DEKs e cache em memória, apaga o arquivo DPAPI, recarrega a SPA na tela de login.
- **Senha nunca “123”**: o primeiro usuário é criado por **convite** no painel do Supabase; a senha é definida pelo próprio usuário.
- **MASTER**: `profiles.role = 'MASTER'`, atribuído uma única vez por `select gp_admin.bootstrap_master('<uuid>')` no SQL Editor
  (só funciona se não existir MASTER). Proteções por **trigger**:
  - não é possível apagar o profile de um MASTER nem o usuário do Auth (FK `ON DELETE RESTRICT`);
  - `role` de um MASTER só muda via `gp_admin.transfer_master(novo)`, executada **pelo próprio MASTER**, que garante que sempre resta ≥ 1 MASTER;
  - ADMIN nunca altera, suspende ou rebaixa MASTER; ninguém concede `MASTER` via UI.
  - recuperação de acesso do MASTER continua sendo o fluxo de recuperação do Supabase Auth; o *break-glass* (dono do projeto Supabase no SQL Editor) é documentado.

---

## 5. Modelo de autorização

**role + permissões granulares + participação em projeto**, tudo avaliado no Postgres.

| Objeto | Conteúdo |
|---|---|
| `gp.app_role` (enum) | `MASTER`, `ADMIN`, `USER` |
| `permissions(code)` | catálogo fixo (migration) |
| `role_permissions(role, code)` | padrão por role (MASTER = tudo, implícito) |
| `user_permissions(user_id, code, granted_by, granted_at)` | concessões individuais |
| `project_members(project_id, user_id, access, granted_by, granted_at)` | `viewer` · `editor` · `manager` (gerencia membros do projeto) |

Permissões iniciais (strings centralizadas em **um** módulo JS `src/auth/permissions.js` + migration; nada espalhado):
`projects.view_all` · `projects.edit_all` · `projects.create` · `config.cycles.manage` · `config.checklists.manage` · `config.catalogs.manage` ·
`config.comms.manage` · `config.documents.manage` · `config.scripts.manage` · `config.people.manage` · `connections.manage` ·
`users.manage` · `audit.view` · `releases.publish`.
Padrões: **ADMIN** = `users.manage`, `audit.view`, `projects.create`, `projects.view_all` · **USER** = nenhuma (o MASTER/ADMIN concede no provisionamento, ex.: `projects.create`; assim dá para retirar de um usuário específico). `users.manage` e `releases.publish` só o MASTER concede.

Funções SQL (`SECURITY DEFINER`, `search_path` fixo, `STABLE`): `gp.is_active()`, `gp.is_master()`, `gp.has_perm(code)`,
`gp.can_read_project(id)` = ativo ∧ (MASTER ∨ `projects.view_all` ∨ dono ∨ membro), `gp.can_edit_project(id)` = ativo ∧ (MASTER ∨ `projects.edit_all` ∨ dono ∨ membro editor/manager).

**USE × MANAGE**: configuração global → `SELECT` para qualquer usuário ativo; `INSERT/UPDATE/DELETE` só com `config.<área>.manage`.

**Anti-escalonamento** (no banco, não na UI):
- `profiles`: usuário só altera o próprio `display_name`; `role`, `status`, permissões e membros só por RPC `gp_admin.*`.
- RPC verifica: chamador ativo com `users.manage`; alvo não é MASTER; ADMIN não concede `ADMIN` nem permissão que ele próprio não tem; só MASTER cria ADMIN.
- Toda RPC administrativa grava `audit_events` na mesma transação.
- **Fail closed**: erro em função de permissão → exceção → operação negada; o servidor local converte em 403 sem detalhes.

---

## 6. Modelo de persistência

### 6.1 Decisão: agregados + Unit of Work (não reescrever os 12 módulos)
Os módulos de regra já trabalham sobre agregados inteiros (projeto, ciclo, checklist…). Em vez de espalhar chamadas Supabase:
- `Store` vira uma **sessão em memória** com os dados que o usuário pode ver, carregados após o login pelos **Repositories**.
- `store.save()` passa a `await store.save()`: o Unit of Work compara o *hash* de cada agregado com o carregado e grava **só os alterados**,
  pelo repository correspondente, com **concorrência otimista** (`revision`). Conflito → 409 `STALE_DATA` (“alterado por outra pessoa; recarregado”).
- Repositories: `ProjectRepository`, `ProjectChecklistRepository`, `ContactRepository`, `PeopleRepository`, `ConfigurationRepository`
  (estágios, tipos, origens, ciclos, checklists, itens, documentos, modelos, settings), `ScriptRepository`, `ConnectionRepository`,
  `EvidenceRepository`, `UserRepository`, `AuditRepository`. Só eles conhecem Supabase. A UI continua falando só com a API local.
- Backends: **SupabaseBackend** (produção) e **LocalJsonBackend** (o comportamento atual — usado pela suíte de testes e como fonte da migração).
  Os 187 testes continuam válidos sobre o LocalJsonBackend; testes novos cobrem o SupabaseBackend com fake + testes SQL/RLS.
- Mudança mecânica: handlers que gravam passam a `async` (Express 5 já propaga rejeições ao error handler). **Feito na Fase 3.**
- Projeto: em claro só a lista `PROJECT_PLAIN` (mapping.js); todo campo novo nasce cifrado. Campo novo na RAIZ do estado sem classificação faz o mapeamento falhar (não some em silêncio).
- Erros para a tela: `STALE_DATA` 409 (outra pessoa alterou; memória recarregada), `FORBIDDEN` 403, `OFFLINE` 503, `AUTH_REQUIRED` 401. Após falha, a memória volta ao estado confirmado (recarga; sem rede, snapshot) e gravações já enfileiradas são recusadas — nunca há “salvo” falso.
- **Gravação atômica**: o Unit of Work envia o lote inteiro para `public.apply_changes` (SECURITY INVOKER — RLS vale; uma transação; `expected_revision` obrigatório em update). Assim um “salvar” que toca vários agregados (ex.: excluir estágio limpa checklists e documentos) nunca fica pela metade.

### 6.2 Tabelas (resumo; SQL na Fase 2)
| Grupo | Tabelas |
|---|---|
| Identidade/autorização | `profiles`, `permissions`, `role_permissions`, `user_permissions`, `project_members` |
| Projeto (granular para reduzir conflito) | `projects` (núcleo: colunas de FK/estado + `doc jsonb` não sensível + `enc jsonb` cifrado — inclui observações, marcos, planilhas, bases — + `revision`) · `project_checklists` (1 linha por passo; metadados de evidência no próprio passo) · `project_contacts` (PII, tabela própria) · `email_generations` · `email_templates` (globais ou do projeto) |
| Configuração global | `stages`, `project_types`, `origin_systems`, `cycles`, `checklists`, `checklist_items`, `email_templates`, `email_images`, `documents`, `scripts` + `script_versions`, `people`, `connections`, `app_settings` |
| Segurança/operação | `data_keys`, `audit_events`, `migration_runs`, `app_releases`, `client_versions` (versão do app por usuário, mínimo necessário) |

IDs: **os ids atuais (texto) são preservados** como PK → migração idempotente e os apontamentos locais de horas (`projectId`) continuam válidos.
Usuários: sempre **UUID** de `auth.users`. Campos `doneBy/by/createdBy` passam a guardar UUID + nome de exibição; valores antigos ficam como texto histórico.

### 6.3 Vínculos locais (por usuário e máquina) **[D2]**
`users\<uuid>\bindings.json`: `{ projects: { <id>: { rootDir, bases: { <baseId>: { directory } }, deparas: { <id>: { targetDir, sourceDir, lastDownload } }, environments: {…}, noteRefs: {…} } }, documents: { <id>: path } }`.
A API local mescla vínculos com o agregado na leitura e separa na gravação: as telas não mudam.

### 6.4 Sincronização, cache e offline
- Leitura: carga completa no login; recarga incremental (`updated_at > último sync`) ao abrir projeto/tela e a cada 60 s. Realtime fica para depois.
- **Sem cache em disco de dado da nuvem** nesta etapa (nada de JSON em claro “para acelerar”). Se um dia for preciso: arquivo cifrado com DEK local DPAPI.
- Sem internet / Supabase fora / timeout: telas da nuvem mostram “Sem conexão — nada foi alterado”; **nenhuma fila de gravação silenciosa**
  (o formulário continua aberto para tentar de novo). Horas funcionam 100% offline. Iniciar offline: só o módulo de horas do último usuário
  que já fez login neste usuário Windows (marcador DPAPI), sem dados da nuvem.

---

## 7. Criptografia em nível de aplicação

- **Algoritmo**: AES-256-GCM (`node:crypto`), IV de 96 bits **aleatório** por cifragem (nunca reutilizado; limite de 2³² cifragens por DEK com folga enorme
  para o volume), tag de 128 bits preservada.
- **AAD** = `gp:v1:<tabela>:<id da linha>:enc` → um ciphertext copiado para outra linha/tabela **falha** na autenticação.
- **Unidade**: uma coluna `enc jsonb` por linha contendo o JSON dos campos sensíveis daquela linha (menos operações, mesma proteção).
- **Formato versionado**: `{ "v": 1, "alg": "A256GCM", "kid": "<uuid da DEK>", "iv": "<b64>", "ct": "<b64>", "tag": "<b64>" }`.
- Proibido: Base64 como cifra, XOR, ECB, algoritmo próprio, chave derivada de username, chave no código.
- **Hash ≠ cifra**: nada que precise ser lido é guardado como hash. Blind index (HMAC-SHA256 normalizado) só se surgir busca server-side.
- Arquivos (evidências) **[D1]**: mesmo esquema, cifrados antes do upload; o Storage guarda só ciphertext.

## 8. Gerenciamento de chaves

Hierarquia (envelope encryption, mesmo padrão de KMS):
```
KEK v1 (32 bytes aleatórios) ─ secret GP_KEK_V1 da Edge Function + backup offline do MASTER
   └─ embrulha DEKs (AES-256-GCM, AAD = escopo+versão) guardadas em data_keys (sem acesso de cliente)
         ├─ DEK "global"            → pessoas, destinatários de modelos, conexões
         └─ DEK "project:<id>"      → todos os campos/arquivos cifrados do projeto
```
- **Edge Function `gp-keys`**: valida o JWT (`auth.getUser`), exige `status='active'`, chama `gp.can_read_project` **com o JWT do usuário**
  (RLS decide), desembrulha e devolve a DEK por TLS. Criar DEK de projeto exige `can_edit_project`. Qualquer erro → nega (fail closed).
- **Cliente**: DEKs só em memória, zeradas no logout/expiração; nunca em disco, log ou renderer.
- **Por que não descriptografar tudo na Edge Function (proxy)?** Avaliado: o proxy faria toda leitura/gravação passar por ela (latência,
  disponibilidade, custo, a função vira uma API de dados inteira). Com envelope, a KEK nunca sai do servidor, a DEK só vai para quem o banco
  autoriza e o usuário autorizado já vê o texto em claro de qualquer forma. Revogação: RLS corta o acesso ao ciphertext imediatamente;
  para máxima garantia, “Rotacionar chave do projeto” re-cifra o projeto com DEK nova. Escolha: **envelope** (pode ser revista — [D7]).
- **Rotação**: KEK → nova versão `GP_KEK_V2`, função `rewrap` (MASTER) re-embrulha DEKs, sem tocar nos dados. DEK → nova versão, re-cifra linhas do escopo.
- **Perda da KEK = perda definitiva dos dados cifrados.** Backup offline obrigatório + teste de recuperação no SETUP-SUPABASE.
- Supabase Vault/pgsodium TCE não usado: a chave ficaria acessível a quem tem SQL no banco, o que anula o objetivo “consulta direta vê ciphertext”.
- **DPAPI** continua só para segredos **locais**: senhas de conexão por usuário, refresh token, marcador offline. Nunca para dado compartilhado.

---

## 9. RLS

- `ENABLE ROW LEVEL SECURITY` + `FORCE` em **todas** as tabelas do schema público; sem política = negado. `anon` sem nenhum grant.
- Projeto e filhos: `SELECT` → `gp.can_read_project(project_id)`; `INSERT/UPDATE` → `gp.can_edit_project`; `DELETE` → nenhum (exclusão lógica
  `archived_at`, só `manager`/MASTER via RPC, coerente com ADR-009 “nunca apagar de verdade”).
- `projects INSERT` → `projects.create` e `owner_id = auth.uid()`; ao criar, trigger adiciona o dono como `manager` em `project_members`.
- Configuração global → `SELECT` ativo; escrita `has_perm('config.<área>.manage')`.
- `profiles` → `SELECT` próprio; `users.manage` vê todos; `UPDATE` só `display_name` próprio (trigger impede mudar outras colunas).
- `data_keys` → nenhum acesso para `authenticated` (só service role na Edge Function).
- `audit_events` → `INSERT` só via trigger/RPC; `SELECT` com `audit.view`; **sem UPDATE/DELETE** para ninguém além do dono do banco.
- Storage: bucket privado `evidence`, política por caminho `<project_id>/…` com `can_read/edit_project`.
- Testes (Fase 2): matriz MASTER / ADMIN / USER A / USER B em SQL, rodada localmente (Postgres embutido em teste) e no projeto Supabase de dev.

## 10. Auditoria
- **Nuvem (`audit_events`)**: `at, actor uuid, action, entity_type, entity_id, project_id, details jsonb` — triggers em tabelas de dado e de
  permissão + RPC `gp.log_event(action, entity, details)` (ator forçado = `auth.uid()`). Eventos novos: UserInvited, UserActivated,
  UserSuspended, RoleChanged, PermissionGranted/Revoked, ProjectAccessGranted/Revoked, ProjectCreated/Updated/Archived,
  SensitiveDataChanged (sem valores), GlobalConfigurationChanged, KeyCreated/Rotated, MigrationRun.
- **Local (`audit.log` por usuário)**: SQL, Git, Workspace, horas, abrir RM — operações da máquina.
- **Nunca**: senha, token, JWT, refresh token, KEK/DEK, service role, senha de conexão, valores cifrados em claro, corpo de e-mail.
  `details` só leva ids e nomes de campos alterados. Revisar `trecho` (SQL) e `server` na auditoria local (Fase 10).

## 11. GitHub, instalação e atualização **[D4]**
- Repositório **privado**. Entra: código, migrations, Edge Functions, scripts, docs, `.env.example`. Nunca: `.env`, `data/`, backups, exports, `app/`, logs.
- **Separação**: instalação (`…\GerenciadorProjetos\app\` — só binários) · dados locais (`%LOCALAPPDATA%\GerenciadorProjetos\`) · Workspace (pasta escolhida).
  Atualizar substitui **apenas** a pasta de instalação.
- **Sem `git pull` em máquina de usuário.** Proposta: MASTER gera o build a partir de uma **tag**, assina o manifesto (Ed25519; chave
  privada só com o MASTER, pública embutida no app) e publica pacote + manifesto num bucket privado do Supabase (`releases`, leitura para
  usuários ativos). O app compara versões, mostra o changelog, baixa, **verifica hash e assinatura**, aplica no próximo reinício e guarda a
  versão anterior para rollback. Usuário comum não precisa de token do GitHub.
- Proteções no repositório: `.gitignore` revisado, hook `pre-commit` com varredura de segredos (script Node sem dependências + documentação de
  `gitleaks` opcional), *secret scanning* / *push protection* do GitHub.

## 12. Dados locais
```
%LOCALAPPDATA%\GerenciadorProjetos\
  machine.json                    instalação: id aleatório, último usuário (uuid), canal
  users\<auth-uuid>\
     hours\hours.json (+ .bak)    jornada, metas, cronômetros, apontamentos, observações
     hours\evidencias\            anexos das observações de horas
     bindings.json                vínculos de pastas por projeto (6.3)
     secrets.dpapi.json           senhas de conexão (DPAPI) por connectionId
     session.dpapi                refresh token (opcional) — DPAPI
     prefs.json                   Workspace, preferências locais
     audit.log                    auditoria das operações locais
  backups\pre-migration-<stamp>\  cópia integral + manifest SHA-256
  logs\                           sem PII
```
- Segregação por **UUID**, nunca por nome legível. Pasta criada no primeiro login.
- `GP_DATA_DIR` continua existindo para testes/preview.
- **Export/Import de horas**: arquivo `.gphours` versionado `{format, version, userId, exportedAt, sha256, payload cifrado}`;
  cifra obrigatória com **senha escolhida no export** (scrypt + AES-256-GCM; DPAPI não serve porque o destino é outra máquina).
  Import valida formato, versão, integridade e usuário, mostra prévia e mescla por `id` (sem duplicar).

## 13. Conexões de banco
- Metadados (nome, ambiente, servidor, porta, banco, usuário, flags) → **nuvem**, cifrados os identificadores; permissão `connections.manage` para editar.
- **Senha → local, por usuário, DPAPI** (`secrets.dpapi.json`). Cada usuário informa a sua; a tela mostra “Senha não informada nesta máquina”.
- Na migração **nenhuma senha sai da máquina**: o `passwordEnc` atual vai para o `secrets.dpapi.json` do Elton (mesmo usuário Windows → continua legível).
- Conexões próprias de base (sem `connectionId`) viram conexões cadastradas na migração, para não existirem dois caminhos de credencial.

## 14. Documentos, evidências e arquivos **[D1]**
| Tipo | Hoje | Proposta |
|---|---|---|
| Evidências de checklist | `data/evidencias/<proj>/…` | metadados no checklist (campo `file` = `sb:evidence/<projeto>/<id>`, cifrado) + arquivo **cifrado** no Storage privado. “Abrir no Windows” usa cópia decifrada temporária (apagada no logout/próxima carga/12 h). Remover = sai dos metadados; o objeto fica sob o prefixo do projeto (expurgo = decisão de retenção) |
| Imagens dos modelos de e-mail | `data/evidencias/comunicacoes/imagens` | Storage (config global) |
| Evidências das observações de horas | `data/evidencias/horas` | **local** (horas) |
| Documentos e Modelos | links (11/11) | link na nuvem; documento tipo arquivo = vínculo local |
| Planilhas DE-PARA (.xlsx) | pasta do projeto | **local** (arquivo de trabalho), só metadado na nuvem |
| Scripts SQL **[D5]** | `data/scripts/*.sql` | conteúdo em `script_versions` (uma linha por versão; gravar N+1 = controle de concorrência); cópia de trabalho local para abrir no SSMS/VS Code, com “Enviar alterações” (409 `SCRIPT_WC_CONFLICT` se alguém salvou antes). `scripts.content/current_version` não são usados (atualizá-los brigaria com a revisão do cadastro). Remover: a nuvem apaga as versões com o cadastro; fica cópia em `users\<uuid>\scripts\.removidos` |

## 15. Migração dos dados atuais
```
data/ atual ─► BACKUP integral (+SHA-256) ─► carga somente leitura (Store atual, applyDefaults, sem save)
   ─► DRY-RUN: classificação, transformação, relatório de contagens e referências quebradas
   ─► extrai HORAS → users\<uuid-elton>\hours  (verifica contagem/hash)
   ─► extrai VÍNCULOS de pastas e SENHAS DPAPI → users\<uuid-elton>\
   ─► login como Elton (MASTER) — a migração usa o JWT dele, NUNCA service role
   ─► DEKs via gp-keys ─► cifra ─► upsert com ids originais (idempotente; ON CONFLICT compara revision/hash)
   ─► upload de evidências cifradas (caminho determinístico)
   ─► VALIDAÇÃO: relê tudo, decifra, compara JSON canônico agregado a agregado + contagens
   ─► migration_runs.status = 'completed' + marcador local ─► app passa a usar a nuvem
```
- Dono de todos os projetos atuais: **UUID do Elton** (nunca username). Elton também `manager` em `project_members`.
- Os arquivos originais **não são apagados nem alterados**; `data/` fica como somente leitura até você decidir arquivá-lo.
- Ordem obrigatória: cópia dos dados + projeto Supabase **dev** primeiro; produção só após validação.

## 16. Threat model (resumo)
| Ameaça | Controle |
|---|---|
| Usuário legítimo tenta ver projeto alheio | RLS `can_read_project`; DEK do projeto só via `gp-keys` com a mesma checagem |
| Banco exposto / dump / backup do Supabase vazado | campos sensíveis são ciphertext; KEK fora do banco |
| Segredo commitado | `.gitignore`, hook pre-commit, push protection; nada de segredo necessário no repo; rotação documentada |
| Máquina local comprometida | fora do alcance total; DPAPI para segredos locais; tokens não persistidos sem “manter conectado”; dados da nuvem não vão para disco |
| Token roubado | expira (1 h); refresh revogável no logout/suspensão; suspensão vale na hora (RLS checa status a cada consulta) |
| ADMIN tenta virar MASTER / dar-se permissões | só RPCs com checagem de hierarquia; trigger protege MASTER; colunas de `profiles` travadas |
| Manipulação de requests / acesso direto ao PostgREST | toda regra de acesso no banco; publishable key não dá acesso sem JWT + RLS |
| Burlar regra de fluxo (ex.: avançar etapa sem checklist) via API direta | **limitação aceita**: só quem já é editor consegue; triggers auditam toda alteração |
| Cache local esquecido | sem cache em disco de dado da nuvem; logout zera memória |
| Backup com PII | backups locais fora do Git, na pasta do usuário; retenção definida; export de horas cifrado |
| Logs vazando dados | regra “só metadados”; varredura de vazamento com valores-canário (Fase 10) |
| Pacote de atualização adulterado | hash + assinatura Ed25519 verificados antes de aplicar |
| Perda da KEK | backup offline + teste de recuperação |

## 17. LGPD — como o desenho suporta (não é declaração de conformidade)
| Princípio | Suporte técnico |
|---|---|
| Finalidade / necessidade | só migra o que tem uso; legado Gmail descartado; horas não sobem; classificação explícita |
| Segurança / prevenção | Auth, RLS deny-by-default, cifra de aplicação, DPAPI local, fail closed, auditoria |
| Menor privilégio | role + permissões granulares + participação por projeto; USE ≠ MANAGE |
| Rastreabilidade | `audit_events` append-only, sem PII |
| Acesso / correção / eliminação do titular | PII concentrada em `people`, `project_contacts`, `email_generations`, destinatários de modelos (registro de locais em SECURITY.md); RPC de anonimização planejada |
| Retenção | tabela de retenção em SECURITY.md **a definir pelo negócio** (nada é apagado automaticamente sem decisão) |
| Segregação | horas locais por UUID; DEK por projeto; ambientes dev/prod separados |
Conformidade depende também de base legal, política de privacidade, contratos, atendimento ao titular e processos — fora do código.

## 18. Riscos
| Risco | Mitigação |
|---|---|
| Perda da KEK | backup offline obrigatório; teste de recuperação |
| Regressão na troca `save()` → `await save()` (98 pontos) | mudança mecânica + LocalJsonBackend mantém a suíte de 187 testes |
| Conflito de edição simultânea | tabelas granulares; 409 `STALE_DATA` com recarga; nada é sobrescrito em silêncio |
| Plano Free do Supabase **pausa após 7 dias sem uso** e não tem backup diário | produção no plano Pro (ou aceitar o risco conscientemente) |
| SMTP padrão do Supabase só envia para membros da organização e com limite baixo | SMTP próprio antes de convidar outros usuários |
| Supabase indisponível | horas offline; mensagens claras; nada é perdido |
| Caminhos locais (vínculos) confundirem usuário | mesma tela de hoje; “pasta não configurada nesta máquina” |

## 19. Rollback por fase
| Fase | Rollback |
|---|---|
| 1 (Git, layout) | `git revert`/checkout; `data/` nunca tocado |
| 2 (schema) | migrations em projeto **dev**; reset do banco dev; em prod, migration `down` documentada |
| 3–5 (código) | Git; app antigo continua lendo `data/` (LocalJsonBackend) |
| 6–7 (migração) | `data/` intacto + backup; apagar dados migrados no Supabase (script) e voltar ao modo local |
| 8–9 (UI/updates) | Git; versão anterior guardada pelo atualizador |

---

## 20. Fases

| Fase | Entrega | Depende de você? |
|---|---|---|
| **0** | Inventário, este plano, DATA-CLASSIFICATION, threat model | — ✔ **concluída 2026-10-05** |
| **1** | `.gitignore` endurecido, `scripts/scan-secrets.js` + hook `pre-commit` (com canários de dados reais), `.env.example`, anonimização de nomes reais de clientes/IP em testes. Git local: **aguardando sua autorização** (SETUP-GITHUB §3). `src/paths.js` movido para a Fase 5, onde é usado | não ✔ **concluída 2026-10-05** |
| **2** | 10 migrations (schema, profiles/estados, RBAC, RLS, `apply_changes`, RPCs admin, `key_access`, auditoria append-only, Storage, MASTER protegido), Edge Functions `gp-keys`/`gp-admin`, `src/crypto/envelope.js`, testes: 20 de RLS (PGlite) + 6 de cifra; `rls-smoke.sql` e rollback de DEV validados | escrever: ✔ **concluída 2026-10-05** · aplicar no dev: **AÇÃO SUA** (SETUP-SUPABASE) |
| **3** | `src/store.js` (fachada: fila de gravações, geração, recuperação, attach/detach/refresh) · `src/persistence/` (`LocalJsonBackend` = comportamento antigo; `CloudBackend` = Unit of Work + cifra + `apply_changes`; `mapping.js` = os “repositories” por entidade; `supabase-rest.js`; `keys.js`; `local-user-data.js`) · `src/auth/permissions.js` · 98 gravações agora `await store.save()` · mapeamento validado em memória sobre os dados reais (ida e volta idêntica; 0 caminhos/senhas/nomes em claro) | não ✔ **concluída 2026-10-05** |
| **3b** | `src/files/` — áreas de arquivos com a mesma interface assíncrona: `LocalFileArea` (pasta de sempre) e `CloudFileArea` (Storage: `evidence/<projeto>/<id>`, `email-images/<id>`, conteúdo cifrado no app — formato `GPF1`, `src/crypto/file-envelope.js`); `script-content.js` (local `.sql` ou `script_versions` + cópia de trabalho com “Enviar alterações”). Rotas pedem `store.files(área)` / `store.scripts()`. **Sem migration nova.** Corrigido vazamento: `evidences[].file` (slug do nome do projeto) passou a ser cifrado | não ✔ **concluída 2026-10-05** |
| **4** | `src/auth/` (gotrue, session, identity, permissions) · `src/config.js` (`GP_MODE=cloud`) · `public/auth.js` (entrar, primeiro acesso, esqueci a senha, aguardando liberação, Sair) · backend “sem sessão” · cookie de inicialização · auditoria local por usuário · modelos de e-mail versionados · Supabase local (Docker) + `npm run test:supabase` (10 testes reais). Achados corrigidos: falha de carga após login deixava sessão “meio aberta”; 500 do gp-keys aparecia como “sem conexão” | ✔ **concluída** · testar no gp-dev: **AÇÃO SUA** (SETUP-SUPABASE §7.1) |
| **5** | Horas por usuário (pasta por UUID desde a Fase 3) · **exportar/importar `.gphours`** (`src/hours-backup.js`: sempre cifrado com senha — scrypt + AES-256-GCM, cabeçalho autenticado; prévia → aplicar; mescla por id sem duplicar, conflito mantém o atual, nunca cria sobreposição, jornada só se escolhida; anexos das observações) · **modo offline das horas** (`src/persistence/offline-hours-backend.js`: sem conexão, só o último usuário deste Windows — marcador DPAPI —, só rotas de horas, nada vai à nuvem) · a migração (Fase 6) usa o export/import para levar as horas atuais à pasta do usuário | ✔ **concluída** |
| **6** | Ferramenta de migração + dry-run na **cópia** + migração no projeto dev | **sim** (usuários de teste no dev) |
| **7** | Elton MASTER + migração real | **sim** |
| **8** | Administração: Usuários e Permissões, acesso a projetos, Infraestrutura | não |
| **9** | Central de Atualizações (app + configurações funcionais) | **sim** (chave de assinatura) |
| **10** | Varredura de vazamento, regressão, SECURITY/SETUP/MIGRATION/BACKUP docs, Vault, ADRs | não |
Cada fase termina com a suíte verde e um checkpoint. Checkpoint da fase 5: **298/298** + integração real **11/11**. Checkpoint da fase 4: **286/286** + integração real **10/10**. Checkpoint da fase 3b: **265/265** (247 + 18: arquivos na nuvem pelas rotas, RLS do Storage, cifra de arquivos, transporte do Storage). Checkpoint da fase 3: **247/247** (216 + 31 novos: mapeamento, CloudBackend ponta a ponta no PGlite com RLS, API com backend da nuvem, transporte, dados locais, permissões). Checkpoint das fases 1–2: **216/216** (187 do baseline + 29 novos), varredura de segredos limpa.
Não testado localmente: Edge Functions (sem Deno nesta máquina) — validar no projeto dev. Fases 1–3 e 5 podem andar antes de existir o projeto Supabase.

## 21. Validação anti-retrabalho
| Antes de… | Considerado |
|---|---|
| criar repositories | multiusuário (escopo por RLS), cifra (mapeamento campo→`enc`), concorrência (`revision`), testes (backend local) |
| definir `projects` | dono + membros + visão global + ids preservados + migração idempotente + arquivamento lógico |
| cifrar `name` | ordenação/busca em memória após decifrar; nenhuma busca server-side |
| criar role | permissões granulares + participação por projeto desde o início |
| mover horas | pasta por UUID + export/import versionado e cifrado |
| conexões | metadado compartilhado × senha local |
| estado do usuário | INVITED/PENDING/ACTIVE/SUSPENDED já no schema e no RLS |
| atualização | separação instalação × dados × Workspace antes de existir atualizador |

## 22. Decisões
| # | Decisão | Situação |
|---|---|---|
| D1 | Evidências e imagens de e-mail | **Decidido (2026-10-05)**: Storage privado do Supabase, cifrado na aplicação; evidências de horas continuam locais |
| D2 | Caminhos de disco do projeto | **Decidido**: vínculo local por usuário/máquina (`bindings.json`); caminho nunca vai à nuvem |
| D3 | Login | Adotado salvo objeção: e-mail + senha (username só exibição) |
| D4 | Distribuição de atualizações | **Decidido**: repo privado; pacote assinado (Ed25519) publicado no Storage do Supabase |
| D5 | Scripts SQL | **Decidido**: conteúdo e versões na nuvem; cópia de trabalho local com “Enviar alterações” |
| D6 | Ambientes Supabase | Adotado salvo objeção: `gp-dev` e `gp-prod`, região São Paulo |
| D7 | Modelo de cifra | Adotado salvo objeção: envelope (DEK por projeto + global; KEK na Edge Function) |
| D8 | Histórico de e-mails gerados | Adotado salvo objeção: compartilhado no projeto, cifrado |
| D9 | Pessoas (coordenadores/analistas) | Adotado salvo objeção: catálogo global cifrado, vínculo opcional a usuário (`profile_id`) |
