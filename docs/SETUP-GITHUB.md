# SETUP-GITHUB — passo a passo

> GitHub guarda **código, migrations, scripts e documentação técnica**. Nunca dados, segredos ou builds.
> Comandos em PowerShell ou Git Bash, na pasta do projeto. Cada **AÇÃO NECESSÁRIA DO USUÁRIO** depende da sua conta.

## 1. O que NUNCA entra no Git
| Nunca | Por quê | Proteção |
|---|---|---|
| `data/`, `projects.json*`, `audit.log`, `backups/`, `exports/`, `*.gphours` | dados reais, PII, horas | `.gitignore` + `scan-secrets` (caminho proibido) |
| `.env`, `*.pem`, `*.key`, `*.pfx`, `*.dpapi*`, `signing/` | segredos | `.gitignore` + `scan-secrets` |
| service role / secret key, `GP_KEK_*`, PAT do GitHub, senhas, refresh tokens | segredos de servidor | padrões do `scan-secrets` |
| Project URL / publishable key do Supabase | não são segredos, mas ficam no `.env` para não expor o endpoint | padrão do `scan-secrets` |
| nomes de clientes, contatos, e-mails, telefones, servidores reais (inclusive em testes e docs) | dado de cliente/pessoal | **canários**: o `scan-secrets` compara com os valores reais de `data/projects.json` |
| `app/`, `node_modules/`, `dist/` | build/dependências (~400 MB) | `.gitignore` |
Testes usam nomes fictícios (`Cliente Alfa`, `192.0.2.x`). Migrations e `supabase/functions` **entram** (sem segredo).

## 2. Criar o repositório
> **AÇÃO NECESSÁRIA DO USUÁRIO**
> 1. https://github.com → **New repository** → Nome: `gerenciador-projetos` → **Private** (recomendado: o código não tem segredo, mas expõe a estrutura interna).
> 2. **Não** marque “Add README”, “.gitignore” nem “license” (o projeto já tem; evita conflito no primeiro push).
> 3. Conta GitHub com autenticação em dois fatores.
> 4. Depois do primeiro push: **Settings → Code security** → ligue *Secret scanning* e *Push protection* se o seu plano oferecer
>    (em repositório privado pode exigir plano pago; o hook local abaixo cobre o essencial).
> 5. **Settings → Branches → Add rule** para `main`: bloquear *force push* e exclusão.

## 3. Primeiro commit (na máquina atual)
```bash
git init -b main
```
```bash
git config core.hooksPath .githooks
```
O hook `pre-commit` roda `node scripts/scan-secrets.js --staged` e **barra** o commit se achar segredo ou dado real.
```bash
npm run scan:secrets
```
```bash
git add .
```
```bash
git status
```
Confira a lista: **não** pode aparecer `data/`, `app/`, `node_modules/`, `.env`, `backups/`. Se aparecer, pare e corrija o `.gitignore`.
```bash
git commit -m "Versão inicial (código, migrations e documentação)"
```

## 4. Ligar ao GitHub
> **AÇÃO NECESSÁRIA DO USUÁRIO** (troque `<usuario>`):
```bash
git remote add origin https://github.com/<usuario>/gerenciador-projetos.git
```
```bash
git push -u origin main
```
Na primeira vez, o *Git Credential Manager* abre o navegador para você entrar no GitHub. **Não** crie nem cole token pessoal (PAT) em
arquivo, `.env` ou no projeto.

## 5. Fluxo do dia a dia
- Trabalho novo: `git switch -c feature/<nome>` → commits → push → Pull Request para `main`.
- Antes de cada commit o hook confere segredos; antes de cada PR rode `npm test`.
- Versão publicada = **tag**: `git tag v1.1.0` e `git push origin v1.1.0`. O pacote do app é gerado a partir da tag (Central de Atualizações, Fase 9).

## 6. Segunda máquina
Há dois papéis diferentes:

| Máquina | Precisa de | Como |
|---|---|---|
| **Desenvolvimento/build** (você) | Git, Node 24, código | `git clone https://github.com/<usuario>/gerenciador-projetos.git C:\Projetos\GerenciadorProjetos` → `npm ci` → criar `.env` (seção 3 do SETUP-SUPABASE) → `npm test` |
| **Uso** (você em outra máquina, Maria…) | só o aplicativo | instalar o pacote publicado (Central de Atualizações / pasta de instalação). **Sem Git, sem `.env`, sem token.** Login com o próprio usuário |
Os dados de cada pessoa (horas, vínculos de pastas, senhas de conexão) ficam em `%LOCALAPPDATA%\GerenciadorProjetos\` e **nunca**
são tocados por atualização de código. O controle de horas da máquina A só vai para a máquina B por **exportar/importar** (Fase 5).

## 7. Atualizar
- **Máquina de desenvolvimento**: `git pull` na pasta do código → `npm ci` → `npm test` → build. Hoje `data/` ainda fica dentro da pasta
  do código, mas é ignorado pelo Git (o `pull` não o altera). A partir da Fase 5 os dados saem dessa pasta.
- **Máquinas de uso**: nunca `git pull`. A Central de Atualizações baixa o pacote **assinado**, confere hash e assinatura e troca só a
  pasta de instalação, guardando a versão anterior.

## 8. Recuperar
| Situação | Comando |
|---|---|
| Ver histórico | `git log --oneline --decorate -20` |
| Desfazer um commit já publicado | `git revert <hash>` (não reescreve histórico) |
| Voltar para uma versão | `git switch --detach v1.0.0` |
| Perdeu a máquina | clonar de novo (seção 6); dados compartilhados estão no Supabase; dados locais só no backup local |

## 9. Validar que nenhum segredo foi commitado
```bash
npm run scan:secrets
```
Histórico inteiro (padrões principais):
```bash
git log -p --all | findstr /R /C:"sb_secret_" /C:"BEGIN.*PRIVATE KEY" /C:"AQAAANCMnd8BFdERjHoAwE" /C:"service_role"
```
Opcional, mais completo: [gitleaks](https://github.com/gitleaks/gitleaks) → `gitleaks git` na pasta do projeto.

## 10. Se um segredo vazou
1. **Primeiro rotacione** o segredo (ele já deve ser considerado público) — procedimentos em [SECURITY.md](SECURITY.md) §Rotação.
2. Depois limpe o histórico (`git filter-repo`) e force o push com cuidado — isso **não** desfaz o vazamento; só evita novas cópias.
3. Registre o incidente (SECURITY.md §Incidente).

## 11. Checklist
- [ ] Repositório privado criado, 2FA ligado, regra de proteção na `main`
- [ ] `git config core.hooksPath .githooks` feito
- [ ] `npm run scan:secrets` limpo antes do primeiro commit
- [ ] `git status` sem `data/`, `app/`, `node_modules/`, `.env`
- [ ] Push feito sem PAT em arquivo
