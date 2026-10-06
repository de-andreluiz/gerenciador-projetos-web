# SECURITY — Gerenciador de Projetos

> Estado: arquitetura multiusuário em implantação por fases. O que já existe no código está marcado **[implementado]**;
> o que ainda será feito, **[fase N]**. Plano: [ARCHITECTURE-MIGRATION-PLAN.md](architecture/ARCHITECTURE-MIGRATION-PLAN.md) ·
> Classificação: [DATA-CLASSIFICATION.md](DATA-CLASSIFICATION.md).
> Este documento descreve controles técnicos. **Não** é declaração de conformidade com a LGPD: conformidade depende também de base legal,
> política de privacidade, contratos, retenção definida pelo negócio, atendimento ao titular e processos.

## 1. Camadas (defesa em profundidade)
```
Supabase Auth (identidade) → estado da conta (ACTIVE) → role + permissões + participação no projeto
→ RLS no Postgres (deny-by-default) → criptografia de aplicação nos campos sensíveis → auditoria append-only
```
Nenhuma camada substitui outra. A tela só **reflete** permissões; quem decide é o banco.

## 2. Autenticação
- Supabase Auth; o app nunca guarda senha nem hash. Cadastro aberto **desligado**: só entra quem é convidado. **[implementado: schema]**
- Convite e recuperação por **código** no e-mail (o app desktop não usa links). Senha mínima 12 com complexidade (config do Auth).
- Tokens ficam no processo local (Node), nunca no navegador/`localStorage`; refresh token só com “manter conectado”, em arquivo DPAPI
  (`%LOCALAPPDATA%\GerenciadorProjetos\session.dpapi.json`). Renovação automática antes de expirar; refresh revogado/expirado → sessão encerrada. **[implementado]**
- Logout revoga a sessão no Auth (`/logout?scope=local`), zera chaves, cópias temporárias e dados em memória, apaga o arquivo DPAPI e volta à tela de login. **[implementado]**
- Antes do login (modo nuvem) o app sobe **vazio**: nenhum dado local é carregado; toda rota de dados responde 401 `AUTH_REQUIRED`; pendente → 403 `ACCOUNT_PENDING`. **[implementado]**
- Falha ao carregar os dados após o login encerra a sessão (fail closed). Erros de login não revelam se o e-mail existe. **[implementado]**
- **Cookie de inicialização**: no modo nuvem a API local só atende quem abriu o app pelo endereço com o token aleatório da execução
  (cookie HttpOnly, SameSite=Strict). Motivo: `localhost` é compartilhado entre usuários do Windows na mesma máquina (Terminal Server/RDS). **[implementado]**
- “Feito por” nos registros = nome de exibição do usuário logado (`src/auth/identity.js`); o UUID autoritativo de cada alteração está em `audit_events`.
  Auditoria local passa a ser por usuário (`users\<uuid>\audit.log`), sem e-mail nem senha.

## 3. Autorização (RBAC + permissões + projeto)
- Papéis: `MASTER` > `ADMIN` > `USER`. Permissões granulares em `permissions`/`user_permissions`; padrão por papel em `role_permissions`. **[implementado]**
- Códigos de permissão: fonte única `src/auth/permissions.js` **[fase 3]** espelhando `supabase/migrations/…_permissions.sql`.
- Projeto: dono + `project_members` (`viewer`/`editor`/`manager`); visão global só com `projects.view_all`.
- USO × GESTÃO: configuração global é lida por qualquer usuário ativo; alterada só com `config.<área>.manage`.
- Estados: `invited` → `pending` (sem acesso a nada) → `active` ↔ `suspended`. Suspensão vale **na hora** (RLS confere a cada consulta) e o
  ban no Auth impede renovar a sessão.
- Anti-escalonamento: papel/estado/permissões só por RPC que confere hierarquia; ADMIN não administra ADMIN/MASTER nem concede
  `users.manage`/`releases.publish`; ninguém altera o próprio papel. Testado em `supabase/tests/rls.test.js`.

### MASTER
- Criado uma única vez por `gp.bootstrap_master` (SQL Editor; não exposto à API).
- Não pode ser excluído (trigger + FK `ON DELETE RESTRICT`), suspenso nem rebaixado por nenhuma tela ou RPC comum.
- Conceder/abrir mão do papel: só um MASTER, com senha digitada há < 10 min, e sempre resta ≥ 1 MASTER ativo.
- Recuperação de acesso: fluxo normal de “Esqueci minha senha” do Supabase Auth.
- **Break-glass** (perda total de acesso do MASTER): o dono da organização no Supabase, pelo SQL Editor, numa transação:
  `select set_config('gp.allow_master_change','on',true); update public.profiles set role='MASTER', status='active' where id='<uid>';`
  — registrar como incidente.

## 4. RLS
- RLS ligado em **todas** as tabelas do schema `public`; sem política = negado; `anon` sem grant algum. **[implementado]**
- Escrita do app por `public.apply_changes` (SECURITY INVOKER: RLS vale; lote atômico; concorrência otimista `GP409`).
- `data_keys` sem nenhuma política: nenhum cliente (nem MASTER) lê chaves embrulhadas.
- Testes locais (Postgres embutido): `npm run test:rls`. No Supabase real: `supabase/tests/rls-smoke.sql`.
- Limitação aceita: regras de **fluxo** (ex.: só avançar etapa com checklist completo) rodam no app; um editor que chame a API direto
  pode contorná-las no **seu** projeto. Autorização (quem acessa o quê) nunca depende do app. Toda alteração é auditada.

## 5. Criptografia de aplicação
- AES-256-GCM, IV aleatório de 96 bits por cifragem, tag de 128 bits, AAD `gp:v1:<tabela>:<id>:<campo>`; envelope versionado
  `{v, alg, kid, iv, ct, tag}`. O banco recusa coluna `enc` fora do formato e campos sensíveis em claro no `doc`. **[implementado: `src/crypto/envelope.js` + checks]**
- O que é cifrado e o que não é: DATA-CLASSIFICATION.md. Ordenação/busca de campos cifrados acontecem em memória, depois de decifrar.
- Proibido: Base64/XOR/ECB/algoritmo próprio, chave derivada de nome de usuário, chave no código.
- **Arquivos** (evidências, imagens de e-mail): cifrados no app antes do upload — formato binário `GPF1` (kid, IV 96 bits, tag), AAD
  `gp:file:v1:<bucket>:<caminho>`; caminho do objeto sem nome de arquivo nem de projeto (`<projeto>/<id>`). O Storage só guarda ciphertext. **[implementado]**
  - Cache local de arquivos: **só ciphertext** (`users\<uuid>\cache\files`).
  - **Exceção documentada**: “Abrir no Windows” precisa do arquivo em claro no disco → cópia em `users\<uuid>\tmp-open`, apagada no logout,
    na próxima carga e após 12 h (arquivo travado pelo programa aberto fica para a próxima limpeza).
  - Remover evidência não apaga o objeto (ADR-009); ele continua sob o prefixo do projeto — expurgo é decisão de retenção (§15).
  - Evidências das observações de horas nunca vão ao Storage (locais, ADR-014).

## 6. Gerenciamento de chaves
```
KEK (32 bytes) — secret GP_KEK_V<n> da Edge Function gp-keys + backup offline do MASTER
  └─ embrulha DEKs (data_keys): "global" e "project:<id>"
        └─ DEK cifra os dados; chega ao app só se o banco autorizar (public.key_access com o JWT do usuário); fica só em memória
```
- **Backup da KEK é obrigatório** (gerenciador de senhas do MASTER). Perder a KEK = perder os dados cifrados.
- KEK diferente para dev e prod. Nunca no Git, `.env`, banco, desktop, chat ou documento.
- Service role existe apenas no runtime das Edge Functions.

## 7. DPAPI (segredos locais do Windows)
- Continua para **segredos locais**: senha de conexão de banco por usuário, refresh token, marcador de modo offline. **[implementado para senhas de conexão]**
- **Nunca** para dado compartilhado (outro usuário/máquina não decifra).
- Senhas de conexão **não** vão à nuvem; cada usuário informa a sua. Na migração, as senhas atuais ficam no arquivo DPAPI do próprio usuário.

## 8. Dados locais
- `%LOCALAPPDATA%\GerenciadorProjetos\users\<uuid>\` — horas, vínculos de pastas, segredos DPAPI, preferências, auditoria local. **[fase 5]**
- Segregação por UUID (nunca por nome). Dados da nuvem **não** são gravados em disco em claro (sem cache sensível).
- Export de horas (`.gphours`): **sempre** cifrado com a senha escolhida no export (scrypt N=2^15 → AES-256-GCM; cabeçalho como AAD — alterar versão/parâmetros invalida).
  Senha errada e arquivo alterado dão o mesmo erro. A senha nunca é guardada; vai no corpo/cabeçalho da requisição local, nunca em URL nem log.
  Importar valida cada registro (anexo executável/caminho inválido é descartado), mostra prévia e nunca sobrescreve nem cria sobreposição. **[implementado]**
- **Modo offline das horas**: sem conexão com o Supabase, só o último usuário que entrou neste usuário do Windows (marcador `last-user.dpapi.json`,
  DPAPI) pode abrir **só** as horas locais; o servidor confere que o Auth está mesmo inalcançável (com conexão, exige login). Demais rotas: 503
  `OFFLINE_MODE`; gravação fora das horas é recusada e desfeita; nada vai à nuvem. Projetos para apontar = id/nome já presentes no próprio histórico local. **[implementado]**

## 9. Nunca commitar
`.env`, `data/`, `backups/`, `exports/`, `*.gphours`, `projects.json*`, `audit.log`, chaves (`*.pem`, `*.key`, `*.pfx`), `*.dpapi*`,
service role/secret keys, KEK, PAT do GitHub, senhas, URL/publishable key do Supabase, nomes reais de clientes/pessoas (inclusive em testes).
Proteções: `.gitignore`, hook `pre-commit` (`scripts/scan-secrets.js` com canários de dados reais), `npm run scan:secrets`.

## 10. Auditoria e logs
- `audit_events` (nuvem): append-only (trigger impede UPDATE/DELETE), ator = `auth.uid()`, só ids/ações/nomes de campos alterados;
  mudança em campo cifrado aparece só como `sensitive: true`. Leitura com `audit.view`. **[implementado]**
- Auditoria local (`audit.log`): operações da máquina (SQL, Git, Workspace, horas). **Revisar na fase 10**: hoje registra nome de projeto,
  servidor e trecho de SQL.
- Nunca em log/auditoria: senha, token, JWT, refresh token, KEK/DEK, service role, senha de conexão, conteúdo decifrado, corpo de e-mail.
  Edge Functions só registram código de erro.

## 11. Threat model (resumo)
| Ameaça | Controle |
|---|---|
| Usuário tenta ver projeto alheio | RLS `can_read_project`; DEK do projeto só com a mesma regra |
| Banco/dump/backup exposto | campos sensíveis cifrados; KEK fora do banco |
| Segredo commitado | `.gitignore`, hook, canários, push protection; rotação |
| Máquina local comprometida | fora do alcance total; DPAPI; nada sensível em disco; sessão revogável |
| Token roubado | expira em 1 h; suspensão imediata; refresh revogado no logout/ban |
| ADMIN tenta escalar | RPCs com hierarquia; colunas de `profiles` travadas; MASTER protegido por trigger |
| Requests manipulados / API direta | toda regra de acesso no banco; publishable key sem JWT não acessa nada |
| Cache local esquecido | sem cache sensível; logout zera memória |
| Backup com PII | backups locais fora do Git, na pasta do usuário; retenção definida |
| Logs vazando dados | regra “só metadados”; varredura de vazamento (fase 10) |
| Pacote de atualização adulterado | hash + assinatura Ed25519 verificados antes de aplicar (fase 9) |

## 12. Rotação
| Segredo | Procedimento |
|---|---|
| Senha de usuário | “Esqueci minha senha” (código) ou MASTER suspende e o usuário redefine |
| Sessões de um usuário | `gp-admin` `set_status: suspended` (ban + RLS) → reativar depois |
| Publishable key | Supabase → API Keys → criar nova e revogar a antiga → novo build com o `.env` atualizado |
| Secret key / service role | Supabase → API Keys → rotacionar (as Edge Functions recebem a nova automaticamente) |
| KEK | gerar `GP_KEK_V2` (secret), backup offline, `gp-keys` `{action:"rewrap", toKekVersion:2}` (MASTER), `GP_KEK_CURRENT=2`, guardar a V1 até conferir, depois remover |
| DEK de um projeto | nova versão da chave + re-cifrar as linhas do projeto **[fase 8]** (ex.: após revogar acesso de alguém) |
| Senha de conexão de banco | trocar no SQL Server e informar a nova em cada máquina (Configurações → Conexões) |
| Senha do banco Postgres | Supabase → Database → Reset password |

## 13. Incidente (procedimento básico)
1. **Conter**: suspender usuário envolvido (`gp-admin`), revogar/rotacionar o segredo exposto (tabela acima).
2. **Preservar**: exportar `audit_events` do período e os logs do Supabase (Auth, Postgres, Edge Functions).
3. **Avaliar**: quais dados/titulares foram afetados (registro de PII, §14).
4. **Comunicar**: responsável pela proteção de dados da organização decide sobre comunicação à ANPD e aos titulares (art. 48 LGPD).
5. **Corrigir e registrar**: causa, correção, data — no Vault (`07-State`) e aqui, se mudar controle.

## 14. Dados pessoais — onde estão (para acesso, correção, eliminação)
| Local | Titulares | Como localizar |
|---|---|---|
| `people` (cifrado) | equipe (coordenadores/analistas) | decifrar no app (MASTER) e buscar |
| `project_contacts` (cifrado) | contatos de clientes | idem; uma linha por pessoa; `anonymized_at` para anonimização |
| `email_templates.enc` | destinatários fixos | idem |
| `email_generations.enc` | destinatários e corpo de e-mails gerados | por projeto/data |
| `profiles` + Auth | usuários do app | painel do Supabase |
| textos livres (observações, notas, evidências) | qualquer pessoa citada | não estruturado — limitação conhecida; orientar a equipe a não registrar dado pessoal desnecessário |
| dados locais / backups | usuário da máquina | pasta local do usuário |
RPC de anonimização de pessoa/contato: **[fase 8]**.

## 15. Retenção (a definir pelo negócio — nada é apagado automaticamente)
| Dado | Proposta para decisão |
|---|---|
| Projetos | permanentes enquanto houver contrato/obrigação; arquivar ao concluir |
| Contatos do projeto | anonimizar X meses após o arquivamento do projeto |
| E-mails gerados | hoje: até 2.000 por instalação; definir prazo |
| Auditoria | definir (ex.: 5 anos); append-only |
| Backups pré-migração (locais) | apagar após validação + prazo combinado (ex.: 90 dias) |
| Objetos do Storage de evidências removidas | hoje permanecem (nunca apagar); definir prazo de expurgo por projeto arquivado |
| Export de horas | responsabilidade do usuário; cifrado |

## 16. Limitações conhecidas
- Regras de fluxo no cliente (§4). · Campos cifrados não são pesquisáveis no banco (busca em memória). · Texto livre pode conter PII.
- Quem tem acesso legítimo vê o dado em claro e pode copiá-lo (nenhuma cifra impede isso). · DEK em memória do cliente autorizado durante a sessão.
- Sem MFA no app ainda (recomendado ativar TOTP no Supabase para o MASTER quando o app suportar).
- Edge Functions, Auth, Storage e PostgREST reais são exercitados pelo teste de integração com o Supabase local (`npm run test:supabase`, Docker); não fazem parte do `npm test`.
