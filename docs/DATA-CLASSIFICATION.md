# Classificação de Dados — Gerenciador de Projetos

> Status: **proposta (Fase 0)** — base para o schema, a criptografia e o RLS. Revisar antes da Fase 2.
> Nenhum valor real (cliente, pessoa, servidor) aparece neste documento — só nomes de campos.
> Plano completo: [ARCHITECTURE-MIGRATION-PLAN.md](architecture/ARCHITECTURE-MIGRATION-PLAN.md).

## Níveis

| Nível | Significado | Onde pode ficar | Proteção mínima |
|---|---|---|---|
| **PUBLIC/TECHNICAL** | Estrutura do app, defaults, schemas, migrations, constantes | GitHub, nuvem, local | nenhuma especial |
| **INTERNAL** | Configuração funcional sem dado pessoal nem de cliente (estágios, cores, ordem de passos, flags) | Supabase (RLS) | Auth + RLS |
| **CONFIDENTIAL** | Dado de cliente/projeto que identifica o cliente ou revela operação (nome do projeto = nome do cliente, links de planilhas, servidores, URLs de download, observações) | Supabase **cifrado na aplicação** | Auth + RLS + AES-256-GCM |
| **PERSONAL** | Dado pessoal (LGPD): nome, e-mail, telefone, cargo, observações sobre pessoas; destinatários e corpo de e-mails | Supabase **cifrado na aplicação**, em tabelas próprias e rastreáveis | Auth + RLS + AES-256-GCM + auditoria |
| **SECRET** | Credenciais e chaves: senhas de banco, tokens, refresh token, KEK, service role | **Nunca** no Git nem no banco em claro. Local: DPAPI. Servidor: secrets da Edge Function | DPAPI / secret store; nunca em log |
| **LOCAL-PERSONAL** | Dado do próprio usuário que não é compartilhado (controle de horas) | Só na máquina, pasta do usuário | permissões NTFS do perfil Windows; export cifrado |

## Matriz

Legenda: **Cloud** = Supabase · **Local** = `%LOCALAPPDATA%\GerenciadorProjetos\users\<uuid>\` · **Cifra** = criptografia em nível de aplicação (AES-256-GCM, envelope) · **RLS** = política que restringe a linha · **Aud** = evento de auditoria.

### Projetos

| Dado (campo atual) | Onde | Nível | Cifra | RLS | Aud | Observação |
|---|---|---|---|---|---|---|
| `project.id`, `createdAt`, `cycleId`, `cycleVersion`, `stepId`, `projectTypeId`, `originSystemId` | Cloud | INTERNAL | não | membro/visão global | criação/alteração | chaves, joins e filtros |
| `project.name` | Cloud | CONFIDENTIAL | **sim** | idem | sim (sem o valor) | normalmente é o nome do cliente; ordenação/busca feitas após decifrar, na memória |
| `project.description` | Cloud | CONFIDENTIAL | **sim** | idem | sim | texto livre |
| `rootDriveUrl`, `deparas[].url`, `corrections[].url/label/note` | Cloud | CONFIDENTIAL | **sim** | idem | sim | links que podem dar acesso a documentos do cliente |
| `whatsappGroupUrl` | Cloud | CONFIDENTIAL | **sim** | idem | sim | link de convite = acesso ao grupo |
| `environments.{hml,prod}.downloadUrl` | Cloud | CONFIDENTIAL | **sim** | idem | sim | |
| `rootDir`, `bases[].directory`, `deparas[].targetDir/sourceDir/lastDownload.path`, `environments.*.dir`, `notes[].refs[kind=file|folder].path` | **Local** (vínculo por máquina) | CONFIDENTIAL | — | — | local | caminho de disco é da máquina, não do projeto |
| `milestones[]` (título, data, nota) | Cloud | CONFIDENTIAL (título/nota) / INTERNAL (data, done) | título/nota **sim** | idem | sim | |
| `stageHistory[]`, `steps[]` | Cloud | INTERNAL | não | idem | sim | |
| `notes[]` (título, texto, links) | Cloud | CONFIDENTIAL | **sim** | idem | sim | texto livre pode conter dado pessoal |
| `contacts[]` (nome, e-mail, telefone, cargo, observações) | Cloud, tabela `project_contacts` | **PERSONAL** | **sim** | idem | sim (sem valores) | tabela própria para localizar/anonimizar dados do titular |
| `deparas[]` (rótulo, config. de importação, nomes de abas/colunas) | Cloud | CONFIDENTIAL (rótulo) / INTERNAL (config) | rótulo **sim** | idem | sim | |
| `bases[]` (nome, flags, conexões) | Cloud (metadados) + Local (diretório, senha própria) | CONFIDENTIAL | nome/servidor/usuário **sim** | idem | sim | ver Conexões |

### Checklists (execução por projeto)

| Dado | Onde | Nível | Cifra | RLS | Aud |
|---|---|---|---|---|---|
| estado dos itens (`done`, `doneAt`, `archived`, `carry*`, `runs[].ok/at`) | Cloud `project_checklists` | INTERNAL | não | do projeto | sim |
| `doneBy`, `completedBy`, `by` | Cloud | PERSONAL (identificador) | não — passa a ser **UUID** + nome de exibição | do projeto | — |
| `note.text` (observação do item) | Cloud | CONFIDENTIAL | **sim** | do projeto | sim |
| Evidência: metadados (nome do arquivo, descrição) | Cloud | CONFIDENTIAL | **sim** | do projeto | sim |
| Evidência: referência do arquivo (`file`) | Cloud (envelope) | CONFIDENTIAL | **sim** | do projeto | sim |
| Evidência: arquivo (prints, PDFs) | Storage privado `evidence/<projeto>/<id>`, cifrado na aplicação (GPF1) | CONFIDENTIAL | **sim** | do projeto (RLS do Storage) | sim |

### Configurações globais (compartilháveis)

| Dado | Onde | Nível | Cifra | Leitura | Escrita | Aud |
|---|---|---|---|---|---|---|
| Estágios, tipos de projeto, sistemas de origem | Cloud | INTERNAL | não | usuário ativo | permissão `config.catalogs.manage` | sim |
| Ciclos (passos, versão) | Cloud | INTERNAL | não | usuário ativo | `config.cycles.manage` | sim |
| Checklists e itens (título, descrição, regras de evidência, dependências, links) | Cloud | INTERNAL | não¹ | usuário ativo | `config.checklists.manage` | sim |
| Modelos de e-mail (assunto, corpo) | Cloud | INTERNAL | não¹ | usuário ativo | `config.comms.manage` | sim |
| Modelos de e-mail: destinatários fixos (`to/cc/bcc` com e-mail literal) | Cloud | PERSONAL | **sim** | usuário ativo | `config.comms.manage` | sim |
| Modelo de e-mail com escopo de projeto | Cloud | CONFIDENTIAL | destinatários **sim** | do projeto | editor do projeto | sim |
| Imagens dos modelos de e-mail | **[D1]** Storage | INTERNAL | não | usuário ativo | `config.comms.manage` | sim |
| Documentos e Modelos (título, tipo, etapa, link) | Cloud | INTERNAL | não¹ | usuário ativo | `config.documents.manage` | sim |
| Documento com caminho de arquivo local | Local (vínculo) | — | — | — | — | — |
| Scripts SQL (conteúdo + versões) | **[D5]** Cloud | INTERNAL | não¹ | usuário ativo | `config.scripts.manage` | sim |
| Pessoas (coordenadores/analistas: nome, cargo, e-mail, telefone, observações) | Cloud `people` | **PERSONAL** | **sim** (exceto `id`, `active`) | usuário ativo | `config.people.manage` | sim |
| `settings.warnDays` | Cloud `app_settings` | INTERNAL | não | usuário ativo | `config.catalogs.manage` | sim |

¹ Configuração global é técnica/funcional. Se alguém escrever nome de cliente ou pessoa num título de checklist/modelo, isso vira dado
confidencial **sem cifra**: a regra operacional (SECURITY.md) é não fazer isso; o que é específico de cliente fica no projeto.

### Conexões de banco

| Dado | Onde | Nível | Cifra | Observação |
|---|---|---|---|---|
| `id`, `env`, `auth`, `encrypt`, `trustServerCertificate`, `allowDestructive` | Cloud | INTERNAL | não | precisa para regras (ex.: `local` nunca destrutiva) |
| `name`, `server`, `port`, `database`, `user`, `notes` | Cloud | CONFIDENTIAL | **sim** | metadado compartilhável (item 47) |
| `passwordEnc` (senha) | **Local**, por usuário, DPAPI | **SECRET** | DPAPI | **nunca** vai à nuvem; cada usuário informa a sua senha |

### Comunicações

| Dado | Onde | Nível | Cifra | RLS |
|---|---|---|---|---|
| `emailGenerations[]`: `to/cc/bcc`, `subject`, `body`, `bodyHtml` | Cloud `email_generations` **[D8]** | PERSONAL | **sim** | do projeto |
| `emailGenerations[]`: `at`, `by`, `templateId`, `copied`, ids | Cloud | INTERNAL | não | do projeto |
| `integrations.gmail` (legado, vazio) | **não migrar** | SECRET | — | — |

### Identidade, permissões, auditoria, chaves

| Dado | Onde | Nível | Cifra | Observação |
|---|---|---|---|---|
| Senha do usuário | **Supabase Auth** (hash bcrypt gerenciado) | SECRET | — | o app nunca armazena |
| `auth.users.email` | Supabase Auth | PERSONAL | gerenciado pelo Auth | necessário para login/convite |
| `profiles` (username, display_name, role, status) | Cloud | PERSONAL (baixo) | não | usado por RLS; não cifrável |
| `user_permissions`, `project_members` | Cloud | INTERNAL | não | usado por RLS |
| Access token / refresh token | Memória do processo local; refresh token opcional em arquivo DPAPI | SECRET | DPAPI | nunca no renderer, nunca em log |
| KEK (chave-mestra) | Secret da Edge Function + backup offline do MASTER | SECRET | — | nunca no Git, no banco ou no desktop |
| DEKs (chaves de dados) | Cloud `data_keys`, **embrulhadas** pela KEK; em claro só na memória do cliente autorizado | SECRET | KEK | |
| Service role key | Só no ambiente da Edge Function | SECRET | — | nunca no desktop |
| Auditoria compartilhada (`audit_events`) | Cloud | INTERNAL | não | só ids, ação e metadados não pessoais |
| Auditoria local (`audit.log`: SQL, Git, Workspace, horas) | Local | CONFIDENTIAL | não | hoje tem nome de projeto, servidor e trecho de SQL — revisar campos (Fase 10) |

### Dados locais

| Dado | Onde | Nível | Observação |
|---|---|---|---|
| Controle de horas: jornada, metas, cronômetros, apontamentos, observações do dia | Local `users\<uuid>\hours\` | LOCAL-PERSONAL | **nunca** vai ao Supabase |
| Evidências das observações de horas | Local `users\<uuid>\hours\evidencias\` | LOCAL-PERSONAL | |
| Export de horas (`.gphours`) | arquivo escolhido pelo usuário | LOCAL-PERSONAL | sempre cifrado com senha (scrypt + AES-256-GCM, cabeçalho autenticado) |
| Marcador do último usuário (`last-user.dpapi.json`) | Local (máquina) | INTERNAL | DPAPI; só habilita o modo offline das horas desse usuário |
| Workspace (pasta raiz, apelidos) | Local `users\<uuid>\prefs.json` | INTERNAL | |
| Preferências de UI (tema, pastas recentes) | `localStorage` do app | INTERNAL | já existe; sem dado sensível |
| Backups pré-migração | Local `backups\` | CONFIDENTIAL + PERSONAL | contém tudo; fora do Git; retenção definida no MIGRATION-GUIDE |

## Buscas sobre campos cifrados (mapeadas antes da migração)

| Busca atual | Onde roda | Campo | Impacto |
|---|---|---|---|
| Checklists por nome | memória (tela) | `checklists.name` | nenhum — não cifrado |
| Documentos por título/descrição/etapa | memória (tela) | `documents.*` | nenhum — não cifrado |
| Auditoria por filtros | memória (tela) | eventos | nenhum |
| Workspace (arquivos) | disco local | — | nenhum |
| Lista/ordenação de projetos por nome | memória (tela) | `project.name` (cifrado) | decifra no cliente e ordena em memória (volume pequeno) |

Não há busca no banco por nome de cliente, contato ou e-mail. **Conclusão: blind index não é necessário agora.** O schema deixa
espaço para uma coluna `*_bidx` (HMAC-SHA256 normalizado, chave própria) se surgir busca server-side ou pedido de titular em volume.
