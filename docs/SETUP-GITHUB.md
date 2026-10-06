# SETUP-GITHUB — passo a passo

> GitHub guarda **código, scripts e documentação técnica**. Nunca dados, segredos ou builds.
> Comandos em Bash/Git Bash, na pasta do projeto. Cada **AÇÃO NECESSÁRIA DO USUÁRIO** depende da sua conta.

## 1. O que NUNCA entra no Git
| Nunca | Por quê | Proteção |
|---|---|---|
| `data/`, `projects.json*`, `audit.log`, `backups/`, `exports/`, `*.gphours` | dados reais, PII, horas | `.gitignore` + `scan-secrets` (caminho proibido) |
| `.env`, `*.pem`, `*.key`, `*.pfx`, `signing/` | segredos | `.gitignore` + `scan-secrets` |
| `GP_SECRET_KEY`, senhas de banco, tokens | segredos | padrões do `scan-secrets` |
| nomes de clientes, contatos, e-mails, telefones, servidores reais (inclusive em docs) | dado de cliente/pessoal | **canários**: o `scan-secrets` compara com os valores reais de `data/projects.json` |
| `node_modules/`, `dist/` | dependências/build (~400 MB) | `.gitignore` |

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
Confira a lista: **não** pode aparecer `data/`, `node_modules/`, `.env`, `backups/`. Se aparecer, pare e corrija o `.gitignore`.
```bash
git commit -m "Versão inicial"
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
- Antes de cada commit o hook confere segredos.
- Versão publicada = **tag**: `git tag v1.1.0` e `git push origin v1.1.0`.

## 6. Segunda máquina
O app é local/web (`npm run start:web`); não há pacote desktop nem sincronização em nuvem. Para rodar em outra máquina:
```bash
git clone https://github.com/<usuario>/gerenciador-projetos.git
```
```bash
npm ci
```
Copie `.env.example` para `.env`, gere um `GP_SECRET_KEY` próprio (veja `.env.example`) e rode `npm run start:web`.
Os dados (`data/app.db` ou `data/projects.json`) **não vão pelo Git** — cada máquina tem os seus. Para levar dados de uma
máquina para outra, copie a pasta `data/` manualmente (ou exporte/importe pelas telas do app, quando disponível).

## 7. Atualizar o código
```bash
git pull
```
```bash
npm ci
```
`data/` é ignorado pelo Git — o `pull` não o altera.

## 8. Recuperar
| Situação | Comando |
|---|---|
| Ver histórico | `git log --oneline --decorate -20` |
| Desfazer um commit já publicado | `git revert <hash>` (não reescreve histórico) |
| Voltar para uma versão | `git switch --detach v1.0.0` |
| Perdeu a máquina | clonar de novo (seção 6); dados locais só existem se houver backup da pasta `data/` |

## 9. Validar que nenhum segredo foi commitado
```bash
npm run scan:secrets
```
Histórico inteiro (padrões principais):
```bash
git log -p --all | grep -E "GP_SECRET_KEY|BEGIN.*PRIVATE KEY"
```
Opcional, mais completo: [gitleaks](https://github.com/gitleaks/gitleaks) → `gitleaks git` na pasta do projeto.

## 10. Se um segredo vazou
1. **Primeiro rotacione** o segredo (gere um `GP_SECRET_KEY` novo e re-cifre as senhas salvas; ele já deve ser considerado público).
2. Depois limpe o histórico (`git filter-repo`) e force o push com cuidado — isso **não** desfaz o vazamento; só evita novas cópias.
3. Registre o incidente (`data/audit.log` ou onde sua equipe acompanha incidentes).

## 11. Checklist
- [ ] Repositório privado criado, 2FA ligado, regra de proteção na `main`
- [ ] `git config core.hooksPath .githooks` feito
- [ ] `npm run scan:secrets` limpo antes do primeiro commit
- [ ] `git status` sem `data/`, `node_modules/`, `.env`
- [ ] Push feito sem PAT em arquivo
