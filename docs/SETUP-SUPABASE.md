# SETUP-SUPABASE — passo a passo

> Para quem nunca configurou Supabase. Siga na ordem. Cada bloco **AÇÃO NECESSÁRIA DO USUÁRIO** é algo que só você pode fazer
> (depende da sua conta). Nenhum valor real vai neste documento nem no Git: os nomes entre `<...>` são marcadores.
> Arquitetura: [ARCHITECTURE-MIGRATION-PLAN.md](architecture/ARCHITECTURE-MIGRATION-PLAN.md) · Segurança: [SECURITY.md](SECURITY.md)

## Visão geral — o que vai onde

| Item | Onde fica | Quem vê | Vai para o Git? |
|---|---|---|---|
| Project URL (`https://<ref>.supabase.co`) | `.env` local do build | qualquer usuário do app (não é segredo) | **não** (fica fora para não expor o endpoint) |
| Publishable key (`sb_publishable_...`) | `.env` local do build | qualquer usuário do app (feita para clientes) | **não** |
| Secret key / service role (`sb_secret_...`) | **só** no runtime das Edge Functions (o Supabase injeta sozinho) | ninguém | **nunca** |
| `GP_KEK_V1` (chave-mestra de criptografia) | Secrets das Edge Functions + **cópia offline sua** | ninguém | **nunca** |
| Senha do banco Postgres | seu gerenciador de senhas | só você | **nunca** |
| Migrations (`supabase/migrations/*.sql`) | Git | — | **sim** |

Dois projetos: **`gp-dev`** (testes, pode ser apagado) e **`gp-prod`** (dados reais). Tudo abaixo é feito primeiro no **dev**.
Nunca use a mesma KEK nos dois.

---

## 1. Criar o projeto

> **AÇÃO NECESSÁRIA DO USUÁRIO**
> 1. Acesse https://supabase.com e entre (ou crie a conta). Use autenticação em dois fatores na sua conta Supabase (Account → Security).
> 2. **New project** → Organization: a sua → Name: `gp-dev` → **Region: South America (São Paulo)** (dados no Brasil).
> 3. **Database password**: clique em *Generate a password*, copie e salve no seu gerenciador de senhas como “Supabase gp-dev — banco”. **NÃO** cole em chat, e-mail, documento ou no projeto.
> 4. Plano: Free serve para o dev. Para **produção**, prefira **Pro**: o Free **pausa o projeto após 7 dias sem uso** e não tem backup diário.
> 5. Aguarde o projeto ficar “Healthy”.

## 2. Autenticação (Auth)

> **AÇÃO NECESSÁRIA DO USUÁRIO** — no painel do projeto, menu **Authentication**:
> 1. **Sign In / Providers → Email**: habilitado · **Confirm email**: ligado.
> 2. **Allow new users to sign up**: **DESLIGADO** (só entra quem for convidado). Mesmo que fique ligado por engano, a conta nasce sem acesso — mas desligue.
> 3. Demais provedores (Google, GitHub…): desligados.
> 4. **Policies / Passwords** (nome pode variar): comprimento mínimo **12**, exigir letras minúsculas, maiúsculas, números e símbolos. Se disponível no plano: *Leaked password protection* ligado.
> 5. **Email OTP Expiration**: `86400` (24 h — tempo para aceitar o convite) · **Email OTP Length**: `6` ou `8`.
> 6. **Sessions / JWT**: mantenha *Refresh token rotation* ligado (padrão). Expiração do access token: 3600 s (padrão).
> 7. **URL Configuration → Site URL**: `http://localhost:4317` (o app desktop não usa links de redirecionamento; usa o **código** do e-mail).

### 2.1 Modelos de e-mail com CÓDIGO (o app desktop não abre links)
Texto oficial versionado em `supabase/templates/invite.html` e `supabase/templates/recovery.html` (o Supabase local usa os mesmos).

> **AÇÃO NECESSÁRIA DO USUÁRIO** — **Authentication → Emails → Templates**:
> - **Invite user** — Assunto: `Convite — Gerenciador de Projetos` · Corpo:
>   ```html
>   <p>Você foi convidado para o Gerenciador de Projetos.</p>
>   <p>No aplicativo, escolha <b>Primeiro acesso</b>, informe este e-mail e o código abaixo, e defina a sua senha:</p>
>   <p style="font-size:22px;letter-spacing:4px"><b>{{ .Token }}</b></p>
>   <p>O código vale por 24 horas. Se você não esperava este convite, ignore este e-mail.</p>
>   ```
> - **Reset password** — Assunto: `Redefinição de senha — Gerenciador de Projetos` · Corpo igual, trocando o texto para
>   “No aplicativo, escolha <b>Esqueci minha senha</b>…”.
> - Não inclua `{{ .ConfirmationURL }}` (o link levaria a uma página que não existe).

### 2.2 SMTP próprio (obrigatório antes de convidar outras pessoas)
O SMTP padrão do Supabase só entrega para e-mails de membros da sua organização no Supabase e tem limite muito baixo por hora.
Para convidar a Maria (ou qualquer pessoa), configure um SMTP.

> **AÇÃO NECESSÁRIA DO USUÁRIO** — **Authentication → Emails → SMTP Settings**: *Enable custom SMTP* → host, porta, usuário e senha do
> seu provedor (SMTP corporativo, Resend, Brevo, Amazon SES…). A senha do SMTP fica **só** nesse formulário do Supabase.
> Remetente: um endereço do seu domínio. Envie um convite de teste para você mesmo.

## 3. API e chaves

> **AÇÃO NECESSÁRIA DO USUÁRIO** — **Project Settings → API Keys** (e **Data API**):
> 1. Copie a **Project URL** e a **Publishable key** (`sb_publishable_...`).
> 2. Na sua máquina de desenvolvimento, copie `.env.example` para `.env` (na raiz do projeto) e preencha:
>    ```
>    GP_SUPABASE_URL=<Project URL>
>    GP_SUPABASE_PUBLISHABLE_KEY=<publishable key>
>    GP_ENV=dev
>    ```
> 3. **NÃO** copie a *secret key* / *service_role* para lugar nenhum. O app não precisa dela.
> 4. **Data API → Exposed schemas**: apenas `public` (e `graphql_public`, se já estiver). O schema `gp` **não** pode ser exposto.
> 5. Rode `npm run scan:secrets` — o `.env` não aparece (está no `.gitignore`).

## 4. Aplicar as migrations

Arquivos em `supabase/migrations/`, **nesta ordem** (o nome já ordena):
`…120000_base` → `…120100_identity` → `…120200_permissions` → `…120300_configuration` → `…120400_projects` →
`…120500_keys_audit_operations` → `…120600_rls` → `…120700_apply_changes` → `…120800_admin_rpc` → `…120900_storage`.

Antes, confirme que passam localmente: `npm run test:rls` (Postgres embutido; esperado: todos `pass`).

**Opção A — sem instalar nada (SQL Editor)**
> **AÇÃO NECESSÁRIA DO USUÁRIO**
> 1. Painel → **SQL Editor** → *New query*.
> 2. Abra o 1º arquivo no VS Code, copie **todo** o conteúdo, cole e clique **Run**. Deve aparecer *Success. No rows returned*.
> 3. Repita para cada arquivo, **na ordem**. Se algum der erro: pare, não pule, e me envie a mensagem de erro (sem dados).

**Opção B — Supabase CLI (recomendada para as próximas versões: registra o que já foi aplicado)**
```bash
npx supabase login
```
```bash
npx supabase link --project-ref <ref-do-projeto-dev>
```
```bash
npx supabase db push
```
O `link` pede a senha do banco: digite no terminal (não salve em arquivo).

## 5. Validar tabelas e RLS

> **AÇÃO NECESSÁRIA DO USUÁRIO** — SQL Editor, rode e confira:
> ```sql
> -- a) RLS ligado em todas as tabelas (esperado: 0 linhas)
> select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
>  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
> -- b) anon sem nenhum acesso a tabelas (esperado: 0 linhas)
> select table_name, privilege_type from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public';
> -- c) catálogo de permissões (esperado: 14 linhas)
> select code, master_only_grant from public.permissions order by code;
> ```
> **Table Editor**: as tabelas aparecem com o selo *RLS enabled*. Não crie políticas pelo painel: toda política vem de migration.

## 6. Chave-mestra (KEK) e Edge Functions

### 6.1 Gerar a KEK (sem que ela apareça na tela)
> **AÇÃO NECESSÁRIA DO USUÁRIO** — no PowerShell da sua máquina:
> ```powershell
> $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) | Set-Clipboard; $b = $null
> ```
> A chave está na área de transferência (não foi impressa). Agora, **na sequência**:
> 1. Cole no seu gerenciador de senhas como “GP KEK V1 — gp-dev” (**este é o backup obrigatório**: sem ele, dados cifrados se perdem para sempre).
> 2. Painel → **Edge Functions → Secrets** → *Add new secret*: Name `GP_KEK_V1`, Value: cole → Save.
> 3. Outro secret: Name `GP_KEK_CURRENT`, Value `1`.
> 4. Limpe a área de transferência: `Set-Clipboard -Value ' '`.
> 5. **NÃO** cole a KEK em chat, e-mail, `.env`, documento ou no projeto. Para produção, gere **outra** KEK.

### 6.2 Publicar as funções
**Opção A — pelo painel**
> **AÇÃO NECESSÁRIA DO USUÁRIO**
> 1. **Edge Functions → Deploy a new function → Via Editor**.
> 2. Nome **`gp-keys`** → apague o exemplo → cole o conteúdo de `supabase/functions/gp-keys/index.ts` → **Deploy**.
> 3. Repita com o nome **`gp-admin`** e o arquivo `supabase/functions/gp-admin/index.ts`.
> 4. Em cada função → **Details/Settings**: *Enforce JWT verification* (Verify JWT) **ligado**.

**Opção B — CLI**
```bash
npx supabase functions deploy gp-keys
```
```bash
npx supabase functions deploy gp-admin
```

## 7. Criar o MASTER (o seu usuário) — sem senha padrão

> **AÇÃO NECESSÁRIA DO USUÁRIO**
> 1. **Authentication → Users → Add user**.
>    - **Dev**: *Create new user* → seu e-mail → **você mesmo** digita uma senha forte (gerenciador de senhas) → *Auto Confirm User* ligado.
>    - **Prod**: *Send invitation* → seu e-mail. Aceite pelo app (Primeiro acesso + código), quando a tela de login existir (Fase 4).
> 2. Copie o **UID** do usuário criado.
> 3. SQL Editor:
>    ```sql
>    select gp.bootstrap_master('<SEU_UID>');
>    update public.profiles set username = 'Elton.Oliveira', display_name = 'Elton Oliveira' where id = '<SEU_UID>';
>    select username, role, status from public.profiles where id = '<SEU_UID>';   -- esperado: Elton.Oliveira | MASTER | active
>    ```
>    `bootstrap_master` só funciona uma vez (se já existir MASTER, recusa) e não pode ser chamado pelo app.
> 4. Nunca existe senha “123” nem senha em código, migration, seed, README ou log.

Proteções do MASTER (no banco): não pode ser excluído, suspenso nem rebaixado; ninguém vira MASTER pela tela; transferir exige
outro MASTER ativo e senha digitada há menos de 10 minutos. Detalhes e *break-glass* em [SECURITY.md](SECURITY.md).

## 7.1 Testar o login no gp-dev (Fase 4)
> **AÇÃO NECESSÁRIA DO USUÁRIO**
> 1. No `.env` (raiz do projeto, fora do Git): `GP_MODE=cloud`, `GP_SUPABASE_URL` e `GP_SUPABASE_PUBLISHABLE_KEY` do **gp-dev**, `GP_ENV=dev`.
> 2. Rode `iniciar.bat` — o próprio servidor abre o navegador no endereço com o token desta execução (sem ele a API recusa: proteção contra
>    outros usuários do Windows na mesma máquina).
> 3. Entre com o seu e-mail e senha (MASTER). Esperado: tela do app **vazia** (o gp-dev ainda não tem os seus projetos — a migração é a Fase 6).
>    Seus dados locais (`data\projects.json`) **não aparecem e não são alterados** no modo nuvem.
> 4. Teste “Sair”, “Manter conectado” (feche e abra de novo: entra sozinho) e “Esqueci minha senha” (código chega por e-mail).
> 5. Volte ao uso normal: `GP_MODE=local` no `.env` (ou apague a linha). O `.exe` atual continua sempre local.
> Usuário de teste: convide pelo `gp-admin` (ou pelo painel), aceite com “Primeiro acesso” → ele fica **aguardando liberação** até você
> provisionar (`admin_provision_user`; a tela de administração é a Fase 8).

## 8. Associar os dados existentes ao seu usuário
É feito pela ferramenta de migração (Fase 6), **com o seu login de MASTER** (nunca com service role): todos os projetos atuais
passam a ter você (`owner_id` = seu UID) como dono e gestor. Roteiro completo em `docs/MIGRATION-GUIDE.md` (criado na Fase 6),
sempre primeiro no **gp-dev** com uma **cópia** dos dados.

## 9. Testar isolamento (antes de existir a tela de login)

> **AÇÃO NECESSÁRIA DO USUÁRIO** (dev)
> 1. Crie 2 usuários de teste (**Add user → Create new user**, e-mails fictícios do seu domínio ou `+teste`, senhas aleatórias do gerenciador; *Auto Confirm*). **Não** os provisione.
> 2. Abra `supabase/tests/rls-smoke.sql`, cole no SQL Editor, troque `<UUID_MASTER>`, `<UUID_TESTE_A>`, `<UUID_TESTE_B>` pelos UIDs e **Run**.
> 3. Esperado nas mensagens: `OK 1` … `OK 9` e `TODOS OS CASOS OK`. Nada é gravado (o script termina em ROLLBACK).
> 4. Qualquer `FALHOU` → pare e me envie só a linha da mensagem.

Testar login (Fase 4): entrar como MASTER e como os usuários de teste; conferir que o pendente vê só “Aguardando configuração”.

## 9.1 Supabase LOCAL (Docker) — testes de integração reais
Opcional, para quem desenvolve. Sobe Auth, PostgREST, Storage, Edge Functions e uma caixa de e-mail de teste (Mailpit) na sua máquina, com as
mesmas migrations, e roda o app contra eles (sem tocar no gp-dev):
```bash
npx supabase start -x studio,imgproxy,logflare,vector,realtime,postgres-meta,supavisor
```
```bash
npm run test:supabase
```
```bash
npx supabase stop
```
A configuração local (`supabase/config.toml`) espelha as regras do gp-dev e não tem segredos (as chaves locais são as de demonstração da CLI).
O teste gera uma KEK aleatória por execução, só em arquivo temporário. **Atenção:** em `[auth.email]`, `enable_signup = false` desliga o login
por e-mail inteiro; quem bloqueia o cadastro aberto é `[auth] enable_signup = false` (no painel: “Allow new users to sign up”).

## 10. Logs e auditoria
- **Logs & Analytics**: *Postgres*, *Auth* (logins, convites) e *Edge Functions* (as funções só registram códigos de erro, nunca chaves).
- Auditoria do app (SQL Editor, como dono): `select at, actor, action, entity_type, entity_id from public.audit_events order by at desc limit 50;`

## 11. Rollback
| Situação | Como voltar |
|---|---|
| Dev — começar de novo | SQL Editor: `supabase/rollback/down_all_DEV_ONLY.sql` (esvazie os buckets antes). Usuários do Auth não são apagados. |
| Dev — descartar o projeto | Project Settings → General → *Delete project* |
| Prod | **Não** use o script de rollback. Restaure o backup (Database → Backups; Pro: diário/PITR) — ver `docs/BACKUP-RESTORE.md` (Fase 6) |
| App | o app antigo continua lendo `data/` local até a migração ser concluída e validada |

## 12. Checklist de implantação (dev)
- [ ] Projeto `gp-dev` em São Paulo; senha do banco no gerenciador
- [ ] Signup desligado; senha mínima 12; templates com `{{ .Token }}`; OTP 24 h
- [ ] `.env` local preenchido (URL + publishable); `npm run scan:secrets` limpo
- [ ] 10 migrations aplicadas; validações da seção 5 OK
- [ ] KEK gerada, **backup offline feito**, secrets `GP_KEK_V1` e `GP_KEK_CURRENT` criados
- [ ] `gp-keys` e `gp-admin` publicadas com Verify JWT
- [ ] Seu usuário MASTER criado (bootstrap) com username `Elton.Oliveira`
- [ ] `rls-smoke.sql` com todos os casos OK
- [ ] SMTP próprio configurado (antes de convidar outras pessoas)
