# Gerenciador de Projetos

Aplicação **local** (Windows) para gerenciar projetos de migração: pasta raiz, N bases SQL Server por projeto
(cada uma com seu diretório), planilhas DE-PARA do Google Sheets, importação de XLSX para o banco e um
cronograma opcional e simples.

## Como usar

**Aplicativo desktop (recomendado):** dê dois cliques em `Gerenciador de Projetos.lnk` (ou em `app\Gerenciador de Projetos.exe`).
Abre numa janela própria, com ícone; não precisa de Node.js instalado (só do *ODBC Driver 17 ou 18 for SQL Server* para a
autenticação do Windows). Só uma janela por vez: abrir de novo traz a existente para frente.

**Modo web (alternativa):** `iniciar.bat` (na primeira vez instala as dependências; requer Node.js 20+) e abra http://localhost:4317.

Os dois modos usam a **mesma pasta de dados**, `data\` (na raiz do projeto; `projects.json` e `audit.log`), então enxergam os
mesmos projetos. O servidor escuta **somente em 127.0.0.1** e recusa requisições de outras origens. Para mudar o local dos
dados: variável `GP_DATA_DIR`; a porta: `PORT` (no desktop, se a 4317 estiver ocupada, usa a próxima livre).

## Executável e visual
- `build_exe.bat` (ou `npm run build:desktop`) gera `app\Gerenciador de Projetos.exe` + o atalho na raiz, usando Electron
  (a primeira vez baixa o Electron; a pasta `app\` tem ~400 MB, dos quais ~235 MB são do próprio Electron). Rode de novo após mudar qualquer código.
- Tema baseado na marca TOTVS (https://marca.totvs.com/identidade-visual), com **modo claro e escuro** (alternador no rodapé da barra lateral: Claro / Escuro / Sistema
  — "Sistema" acompanha o tema do Windows; a escolha fica salva no navegador). Escuro (padrão) usa os tokens dos demais apps (`totvs_ctk.py`): azul-marinho #002233,
  azul #00DBFF, roxo #A44DFF, verde #00FFD4, laranja #FF8900, rosa #FF009E. Claro usa fundo quase branco, texto azul-marinho e o azul #0A46EA como destaque — é o
  "azul primário" que o próprio site institucional usa para botões/links sobre fundo branco (o ciano não tem contraste suficiente aí). Tipografia de sistema Verdana
  (a fonte institucional é proprietária). Definições em `public\styles.css`. Selos de status: verde = em dia, laranja = próximo do prazo, rosa = atrasado, azul = concluído.
- Ícone: `assets\icone.ico` (gerado por `assets\gerar_icone.py`, mesmo método do `Icones_Apps\gerar_icones.py`; desenho original, sem o logotipo da marca).

## O que faz

| Recurso | Detalhe |
|---|---|
| Projetos | Vários projetos, cada um com **pasta raiz**: uma pasta local (seletor nativo do Windows) OU o link de uma pasta do Google Drive — pensada para ser o diretório "oficial" do projeto (o diretório de cada Base é independente e continua sempre local, ex.: o repositório do Git). Remover um projeto apaga só o cadastro. |
| Conexões | Cadastro central de conexões (senha com DPAPI), teste, conexão padrão geral e por projeto, uso nas bases e importação das conexões repetidas. Ver “Conexões cadastradas”. |
| Bases de dados | N por projeto, cada uma com **diretório próprio** (sempre local) e duas conexões: **Produção** e **Localhost (teste)**. Windows ou login SQL. |
| Planilhas do projeto (Google Sheets) | Cadastre a planilha (link opcional + pasta onde o arquivo fica). Baixe o .xlsx pelo Google Sheets (Arquivo → Fazer download → Microsoft Excel) e clique em **Anexar arquivo…**: o app lista os .xlsx recentes da pasta Downloads, copia o escolhido para a pasta (o original não é alterado) e passa a usá-lo. Uma versão nova é só anexar de novo. Cada planilha tem a opção **"Permitir importar esta planilha para o banco"** (marcada por padrão): desmarque para planilhas guardadas só como referência — o botão "Importar no banco" fica desabilitado para elas, e o servidor recusa a importação mesmo que a chamada venha de fora da tela. |
| Importar XLSX → banco | Assistente em 4 passos (ver abaixo). Cada aba vira uma tabela; você escolhe abas, nomes de tabela/coluna e tipos. |
| Scripts SQL | Aba própria: scripts de tratamento de dados guardados como **arquivos `.sql`** na pasta `data\scripts` do aplicativo (cadastre, edite, importe um `.sql` existente, abra no SSMS ou na pasta). Na importação de uma planilha, marque **“Executar scripts SQL depois de importar”**, escolha quais e a ordem: eles rodam **na mesma base e na mesma transação**, logo após as tabelas serem criadas e conferidas (ver “Scripts SQL depois da importação”). |
| Workspace | Global: uma pasta raiz (ex.: `C:\Projetos`) com vários projetos, cada um com seu repositório Git. Pastas e arquivos reais, cópia entre projetos (Origem ⇄ Destino, com tratamento de conflitos), busca, abrir no VS Code, e Git de cada projeto (status, commit, pull, push, fetch, histórico). Ver “Workspace”. |
| Cronograma | Opcional. Prazos/entregas por projeto; indicador **Sem cronograma / Em dia / Próximo do prazo / Atrasado / Concluído**. Dias de aviso: padrão global (7, em Configurações) ou por prazo. |
| Responsáveis (coordenadores e analistas) | Em **Configurações → Geral**: um só cadastro de pessoas (nome, cargo, e-mail, telefone/WhatsApp e observações). Cada projeto escolhe daqui o seu **coordenador** e o seu **analista** (aparecem discretos no topo do projeto); no projeto, os botões **WhatsApp** (abre a conversa via `wa.me`, no WhatsApp Web/Desktop em que você já está logado) e **E-mail** (`mailto:`) abrem com um clique. Telefone com 10–11 dígitos é tratado como Brasil (+55); número internacional deve começar com “+”. Excluir uma pessoa só desvincula dos projetos (coordenador e analista). |
| Tipos, ciclos, estágios e checklists | Em **Configurações → Ciclos e checklists**: tipos de projeto (cada um com seu ciclo padrão), **ciclos de migração reutilizáveis** (versões revisadas e aplicadas por projeto), **estágios** e **checklists** como cadastros reutilizáveis — e, em cada ciclo, quais **checklists cada estágio usa naquele ciclo** (o mesmo estágio pode usar checklists diferentes em ciclos diferentes). Cada projeto mostra a barra do seu ciclo (✓ concluído / ● em andamento / ○ não iniciado, com N/M itens), a etapa atual e o histórico. Ver “Ciclos de migração por tipo de projeto”. |
| Tipo de projeto e Sistema de origem | Em **Configurações**: dois catálogos de tags com nome e cor (ex.: "TOTVS Educacional", "TOTVS Folha" para tipo; o sistema de onde os dados vêm para origem). Cada projeto escolhe um de cada, mostrados como tags no cabeçalho. Catálogos vazios por padrão — cadastre os que você usa. |
| Correções | Cada projeto pode anexar N **planilhas de Correções** (link do Google Sheets), ex.: uma por rodada. |
| Documentos e Modelos | Aba própria: biblioteca de modelos/documentos (arquivo local ou link), agrupada por etapa do ciclo, com busca e filtros. O projeto mostra automaticamente os documentos **da etapa em que está**. Arquivos abrem no programa padrão do Windows — só tipos de documento (PDF, Office, texto, imagem, zip…); executáveis e scripts são recusados. |
| Controle de Horas | Cronômetro por atividade (iniciar, pausar, retomar, encerrar), apontamentos confirmados por projeto, meta diária com barra de progresso, dias pendentes, aviso perto do fim do expediente e exportação mensal em Excel. Ver “Controle de Horas”. |
| Auditoria | `data/audit.log`: quem/onde/quando/qual plano, e as ações do checklist (marcar, evidências, avanço bloqueado) e das horas. Sem senhas e sem dados das células. |

## Ciclos de migração por tipo de projeto

```
Tipo de projeto ──► Ciclo de migração ──► Etapa do ciclo (estágio + checklists DESTE ciclo) ──► Checklists ──► Itens (scripts, links, evidências)
```

- **Três cadastros que não se misturam**: **Estágios** (nome e cor, cadastrados uma só vez), **Checklists** (reutilizáveis, com seus itens) e
  **Ciclos** (que dizem como as duas coisas se relacionam). Estágio e checklist são entidades independentes: o que liga os dois é a **etapa do
  ciclo** (`step.checklistIds`: ciclo + estágio + lista **ordenada** de checklists). Associar um checklist a um ciclo **não o copia**: só o id
  entra na lista da etapa, então o mesmo checklist (ex.: *Infraestrutura*) pode ser usado em *Folha / Preparação*, *Educacional / Preparação*…
  com **uma só definição** (só os projetos têm cópias, com o próprio estado de execução).
- **O mesmo estágio, checklists diferentes por ciclo**: *Validação* pode usar *Funcionários, Folha, Financeiro* no ciclo *Migração Folha* e
  *Acadêmico, Matrículas* no ciclo *Migração Educacional*, sem criar “Validação Folha” / “Validação Educacional”. A **ordem** também é da
  associação: o mesmo checklist pode ocupar posições diferentes em ciclos diferentes. Alterar os checklists de um ciclo nunca altera outro.
- **Como configurar** (Configurações → Ciclos e checklists): cadastre os estágios e os checklists (cada checklist é cadastrado **para um
  estágio**; os checklists de um estágio formam o conjunto dele). No cartão do ciclo, expanda **▸**: cada etapa mostra, ao lado do estágio, a
  área **Checklists** — “2/2 selecionados · Todos ativos por padrão” — com o botão **Editar checklists**.
  - **Padrão**: ao adicionar um estágio a um ciclo (ou trocar o estágio de uma etapa), **todos** os checklists do estágio já vêm selecionados;
    não é preciso escolher nada.
  - **Personalizar**: **Editar checklists** abre o editor na própria linha da etapa: marque/desmarque, ajuste a ordem (↑ ↓), crie um checklist
    novo para o estágio ou use um de outro estágio. **Salvar** grava só a associação *ciclo + estágio + checklists* (o resumo passa a “1/2
    selecionados · Personalizado”); **Cancelar** descarta. Não altera o cadastro do checklist, o estágio nem os outros ciclos.
  - A seleção é um retrato: checklist cadastrado depois para o estágio **não** entra sozinho em ciclos existentes (o resumo passa a mostrar
    “N/M”, e você decide em **Editar checklists**).
- **Projeto**: ao criar, escolhe tipo e ciclo (o ciclo segue o tipo até você escolher outro). O projeto recebe uma **cópia das etapas** do ciclo
  (template × execução): progresso, checklists, evidências, execuções e datas são só dele; alterar um projeto nunca altera outro. Trocar o ciclo
  de um projeto em andamento pede confirmação (o histórico e os checklists já feitos ficam guardados).
- **Versões**: mudar as etapas de um ciclo em uso — **ou os checklists de uma etapa** — gera uma **nova versão**. Nada muda sozinho: o projeto
  mostra “Nova versão disponível para este ciclo” e **Revisar alterações** exibe antes/depois (etapas novas, que saem, trocadas e **checklists
  que entram, saem ou mudam de ordem em cada etapa**) com **Aplicar ao projeto**. Depois de aplicar, um checklist já iniciado mostra “O modelo
  deste estágio neste ciclo mudou” e **Sincronizar com o modelo** (que lista o que muda) traz a configuração nova, preservando marcações e
  evidências; o que saiu é arquivado, não apagado. A Visão geral agrupa os
  projetos com versão antiga por ciclo e permite aplicar em lote. Se a etapa atual sair do ciclo, o projeto fica sem etapa (com confirmação).
- **N checklists por etapa do ciclo** (ex.: Técnico, Funcional, Cliente, Produção), cada um com seus itens e todas as funções já existentes
  (obrigatório/opcional, evidências, links, scripts, progresso, bloqueio de avanço). O projeto mostra os itens agrupados por checklist (na
  ordem da associação no ciclo dele), com o progresso de cada um; o bloqueio considera todos os checklists da etapa.
- **Excluir com segurança**: um **checklist** usado por algum ciclo não é excluído em silêncio — a resposta lista “Ciclo / Estágio” onde ele é
  usado (“Remova essas associações antes de excluir”) e nada é apagado; o mesmo vale para um **estágio** usado por ciclos. Excluir um estágio
  nunca apaga checklists (são cadastros à parte). Um checklist sem uso pode ser excluído (junto com seus itens, do modelo; projetos que já
  receberam os itens ficam com a cópia deles) — salvo se algum item dele for dependência de outro (ver “Dependências”).
- **Projetos e dados existentes (migração segura)**: antes desta mudança cada checklist pertencia a um estágio e todo ciclo que usava o estágio
  recebia todos os checklists dele. Na primeira abertura, cada etapa — **dos ciclos e da cópia que cada projeto guarda** — passa a listar
  exatamente os checklists que o estágio tinha, na mesma ordem: nada muda nos projetos, nenhum projeto aparece com “nova versão disponível” por
  causa disso e checklists já iniciados continuam iguais (marcações, evidências, observações, transferências). A migração só atua em etapa sem
  `checklistIds` (idempotente: depois de migrada, a associação que você editar nunca é refeita) e, **antes de reescrever o arquivo, guarda uma
  cópia do original em `data/projects.json.antes-checklists-por-ciclo.bak`** (uma vez só, sem sobrescrever). O vínculo antigo
  (`stageId` do checklist e dos itens) permanece no arquivo apenas como legado (origem); a tela usa-o só para diferenciar checklists de mesmo
  nome (ex.: “Processo Backup · Backup” × “Processo Backup · Backup Produção”).

## Conexões cadastradas

- **Configurações → Conexões**: nome, ambiente (Produção, Homologação, Desenvolvimento, Localhost), servidor, porta, banco padrão (opcional),
  autenticação e login. **Senha**: mesmo mecanismo das bases — criptografada com **DPAPI do Windows** (só este usuário, neste computador); nunca
  volta para a tela nem para a auditoria. **Testar conexão** mostra “✓ Conexão realizada com sucesso” ou “✕ Falha na conexão” com o erro original
  (também dentro do formulário, antes de salvar). Não há uma segunda camada de banco: é o mesmo formato de conexão, o mesmo processo separado com
  timeout e o mesmo teste de rede/VPN.
- **Nas bases**: cada ambiente da base pode **usar uma conexão cadastrada** (escolhe só o banco daquela base) ou continuar com os dados informados à
  mão, como antes. A base guarda só a referência — trocar a senha na conexão vale para todas as bases que a usam.
- **Importar das bases**: agrupa as bases que repetem servidor, porta, login e **a mesma senha** (a comparação é feita em memória, pelo hash da senha
  descriptografada) e, com confirmação, cadastra uma conexão por grupo e vincula as bases (cada uma mantém o seu banco).
- **Conexão padrão** geral e **por projeto** (em “Editar” do projeto): pré-selecionada ao executar scripts pelo checklist.
- **Permitir apagar dados** (por conexão, desligado por padrão fora do localhost): mesma regra da importação para DELETE/DROP/TRUNCATE.

## Executar scripts pelo checklist

Cada script relacionado a um item tem **▶ Executar**: abre uma janela compacta (conexão, banco, variáveis `{{…}}` e resultado) sem sair do
checklist. O texto é lido **do arquivo** da lista de Scripts SQL na hora; as variáveis automáticas (`{{BANCO}}`, `{{SERVIDOR}}`, `{{AMBIENTE}}`,
`{{PROJETO}}`, `{{BASE}}`, `{{SCHEMA}}`) vêm da conexão escolhida e as demais são pedidas na janela.

- **Resultado**: grade com rolagem interna nas duas direções, cabeçalho e nº da linha fixos, célula longa cortada (valor completo na dica), até
  1.000 linhas × 100 colunas por resultado (o total é sempre informado), abas para vários resultados e **Mensagens** (PRINT). Comandos sem SELECT
  mostram “Comando executado com sucesso · N registros afetados”. Tempo, lotes e o servidor/banco realmente conectados aparecem no resumo. Erro:
  mensagem original do banco, número/nível/estado e **lote e linha do arquivo**.
- **Segurança (as mesmas travas dos scripts pós-importação)**: comandos bloqueados (USE, BEGIN TRAN, BACKUP, xp_cmdshell, logins…) nunca rodam; o
  processo-filho revalida cada lote; o script roda **numa transação** (erro → nada é gravado); **Parar** cancela (a transação é desfeita).
  DELETE/DROP/TRUNCATE fora do localhost só com a permissão da conexão/base e sempre com confirmação; fora do localhost, qualquer UPDATE, INSERT,
  MERGE, ALTER, CREATE ou SQL dinâmico pede confirmação. A confirmação é um token do servidor ligado ao texto exato, à conexão e ao banco.
- **Não conclui o item**: executar é apoio. Cada execução fica no **histórico do item** (data, script, conexão, banco, sucesso/erro, duração,
  linhas) e na auditoria (`script-executado` / `script-falhou`, com o hash do texto — nunca o SQL nem os dados).

## Pastas iniciais dos seletores de arquivo

**Anexar planilha** abre o seletor na **pasta do DE-PARA** configurada na planilha; se ela não existir mais, tenta a pasta do último anexo, a pasta
raiz do projeto, o último diretório usado e a pasta Downloads — por fim Documentos. Uma pasta removida nunca vira erro. O mesmo mecanismo
(“último diretório válido” por tipo de arquivo) vale para importar scripts `.sql`.

## Checklist por estágio e evidências

Cada estágio deixa de ser só um status: pode ter **critérios de conclusão**. O checklist faz parte do fluxo do projeto (card **Checklist da
etapa**, logo abaixo do ciclo) e controla o avanço para a etapa seguinte.

**Modelo (Configurações → *Ciclos e checklists* → Checklists)** — cada checklist é uma definição reutilizável (um ou vários por etapa de ciclo, independentes entre si). Cada item tem título, descrição,
**obrigatório/opcional**, ordem (botões ↑ ↓), **links úteis** (título, URL http/https, descrição — abrem em nova aba, com `noopener`),
**scripts relacionados** e **evidência** (não usa / opcional / exige, com o tipo e a quantidade mínima e máxima).

**Regra de avanço** — para ir a uma etapa **à frente**, todos os itens **obrigatórios** da etapa que está sendo deixada precisam estar
concluídos (se pular etapas, vale para cada uma que ficou para trás). Opcionais nunca bloqueiam. Voltar etapa, “Limpar” e repetir a mesma
nunca são bloqueados. Um item obrigatório marcado, mas que **exige evidência sem ter o arquivo**, continua pendente (“aguardando evidência”).
A tela nunca esconde o motivo: o cartão lista o que falta, o botão **Avançar** mostra a janela “Não é possível avançar” com os itens
pendentes, e quando tudo está pronto aparece “Todos os itens obrigatórios foram concluídos → Avançar para …”. A regra é do **servidor**
(`PUT /api/projects/:id/step` responde 409 `CHECKLIST_PENDING`), então não depende da tela.

**Referências não bloqueiam** — descrição, links e scripts são só apoio. Os scripts são **referências** à lista de *Scripts SQL* (nada é
copiado); cada um tem **Abrir** (programa padrão, ex.: SSMS), **VS Code** e **Explorer**. Só “obrigatório” e “exige evidência” bloqueiam.

**Progresso e indicadores** — “7 de 10 itens concluídos”, barra e porcentagem (sobre todos os itens), mais “Obrigatórios 5/6 · Opcionais
2/4”. A barra do ciclo mostra por etapa **✓ Concluído / ● Em andamento / ○ Não iniciado** e “8/12 itens”. Cada item tem **Detalhes ▾**
(descrição, scripts, links, evidências). Marcar registra data/hora e o usuário do Windows; **desmarcar não apaga evidências**.

**Definição × execução** — o modelo (`checklists` e `checklistItems` no `projects.json`, agrupado por checklist) é reutilizado por todos os
ciclos e projetos que o associam; o andamento de cada projeto (`projeto.checklists`, um por **passo do ciclo** — um estágio que se repete no
ciclo tem um checklist para cada passagem) guarda marcações, datas e evidências. Ao **iniciar a etapa** o projeto recebe uma **cópia** dos itens
dos checklists que aquela etapa tem **no ciclo do projeto**. Mudar o modelo depois **não
altera projetos em andamento**: o card avisa “O modelo deste estágio neste ciclo mudou” e **Sincronizar com o modelo** mostra antes o que muda (novos,
alterados, removidos). Sincronizar preserva marcações e evidências; item que saiu do modelo é **arquivado** (fora da conta e do bloqueio,
mas guardado). Excluir um estágio, um checklist ou um item do modelo não mexe nos projetos. Os itens têm um campo `condition` (hoje sempre vazio) reservado
para regras futuras (“exibir só se o tipo do projeto = …”).

### Pendências transferíveis entre etapas

No modelo, um item **obrigatório** pode ter **“Permitir transferir pendência para a próxima etapa”** (`carryForward`). Faz parte dos critérios do
modelo: marcar/desmarcar num item **não muda projetos em andamento** até alguém usar *Sincronizar com o modelo* (o isolamento modelo × projeto
continua o mesmo).

- **Avançar**: obrigatório pendente **não transferível** continua bloqueando (“Não é possível avançar… O item obrigatório abaixo precisa ser
  concluído”). Se só restarem pendências **transferíveis**, o avanço pede confirmação — “Existem N itens obrigatórios pendentes que podem ser
  transferidos… Deseja avançar e transferir para “X”?” — com **Transferir e avançar** / **Cancelar**. Vários itens seguem juntos. A regra é do
  servidor: `PUT /api/projects/:id/step` responde 409 `CHECKLIST_CARRY` com a lista, e só avança com `confirmCarry` + as mesmas chaves (se a
  lista mudou entre a pergunta e a confirmação, pergunta de novo).
- **Transferir não conclui**: o item continua **pendente** (e “exige evidência” continua valendo: só conclui com a marcação + a evidência). Ele
  **não é copiado**: continua sendo o mesmo item da etapa de origem (mesmo id, evidências, execuções de script, links, descrição); só muda de
  localização (`carriedTo`, `carriedAt`) e ganha uma linha no histórico (`carryHistory`: de → para, data/hora, usuário). Transferido várias
  vezes, continua uma só pendência.
- **Na tela**: a etapa atual mostra, separado do checklist dela, **⚠ Pendências herdadas** (origem, data da transferência, quantas etapas
  percorreu, **Ver histórico de transferências**) — funcionam como qualquer item (marcar, anexar evidência, executar script). Na etapa de
  origem o item aparece com “↪ Transferido para X”. Métricas separadas para não haver falso 100%: **Itens próprios**, **Pendências herdadas** e
  **Obrigatórios pendentes no projeto**; a barra do ciclo mostra “⚠ N herdadas” e “↪ N transferidas”; o topo do projeto mostra os obrigatórios
  pendentes e as herdadas; a Home lista o projeto em *Precisam de atenção*.
- **Conclusão do projeto (ir para o último passo do ciclo)**: **nada é transferível** e **todo** obrigatório pendente do projeto bloqueia — da
  etapa atual, herdado ou esquecido numa etapa anterior (“Não é possível concluir este projeto… Todas as pendências obrigatórias devem ser
  concluídas antes da finalização do ciclo”, com a origem de cada uma). Opcionais continuam não bloqueando.
- **Reverter a transferência** (**Restaurar para estágio original**, no item transferido ou herdado): devolve o **mesmo** item à etapa de origem
  (nada é copiado ou apagado: continua pendente, com evidências, observação, scripts, links e histórico) e registra “↩ Restaurado para X” no
  mesmo histórico de transferências. O servidor sempre pede confirmação (`409 RESTORE_CONFIRM`, com os avisos) e valida antes: se a etapa de
  origem saiu do ciclo do projeto ou passou a ser outra, responde `RESTORE_IMPOSSIBLE` com a explicação e **não move nada**; se a origem já foi
  deixada para trás, avisa que o item deixa de ser “pendência herdada”, não trava mais o avanço das etapas seguintes, mas continua impedindo a
  conclusão do projeto. Se o modelo deixou de permitir transferir o item, nada é desfeito sozinho: o item herdado mostra um aviso e a
  restauração é uma ação explícita sua.
- Auditoria: `checklist-pendencia-transferida` (item, de → para, origem), `checklist-pendencia-restaurada`, além de `etapa-concluida` (com quantas foram transferidas) e
  `avanco-bloqueado` (inclusive “Conclusão do projeto bloqueada”). O histórico de etapas do projeto também indica quantas pendências seguiram.

### Observação por item, dependências entre itens

**Observação do item** — no **Detalhes** de cada item (inclusive herdado): **Adicionar observação / Editar / Remover**. É texto da **execução** daquele
projeto (até 1000 caracteres; guarda quando e por quem foi atualizada) e fica dentro do próprio item, então **acompanha o item** nas
transferências e na restauração. É diferente da **descrição**, que vem do modelo. Auditoria: `checklist-observacao` (criada/editada/removida).

**Dependências** — no modelo, cada item pode ter **Dependências** (`dependsOn`: ids de outros itens do modelo, de **qualquer etapa**). Regras:
- O item **não pode ser concluído** enquanto alguma dependência estiver pendente (`409 DEPENDENCY_PENDING`: “Não é possível concluir este
  item. Dependência pendente: …”). Desmarcar continua livre. Todas as dependências precisam estar concluídas.
- “Concluída” é sempre a **regra real** do item de que se depende (marcado **e** evidência exigida), calculada na hora: não existe campo
  “dependência cumprida” gravado. Vale **onde quer que o item esteja** (etapa própria, herdado ou restaurado) — a dependência aponta para a
  identidade do item (id do modelo/`defId`), não para a posição, o título ou a etapa em que ele aparece.
- Um item **opcional** usado como dependência passa a ser exigido **só para aquele item**. **Transferir** um item dependente continua
  permitido (se transferível); só concluir fica bloqueado. Um item já concluído não é reaberto sozinho se a dependência depois voltar a ficar pendente.
- Não aceita **auto-dependência** nem **dependência circular** (direta ou indireta: “Não é possível criar esta dependência. Ela geraria uma
  dependência circular: A → B → C → A”), e no máximo 20 por item. **Remover do modelo** um item (ou checklist com itens) que é
  dependência de outro é **recusado** listando quem depende dele (`ITEM_IS_DEPENDENCY`).
- Se **nenhuma etapa do ciclo daquele projeto usa o checklist** do item de que se depende (ou o item saiu do modelo), a dependência “não se
  aplica” e não bloqueia para sempre — por isso a mesma dependência pode valer num ciclo e não valer noutro; se o checklist (ou a etapa) aparece
  mais de uma vez no ciclo, basta uma passagem concluída.
- **Modelo × projeto**: como os demais critérios, `dependsOn` é copiado no snapshot do item; mudar no modelo **não altera projetos em
  andamento** até **Sincronizar com o modelo** (que lista “dependências” entre as mudanças).
- **Tela**: o item mostra “🔒 Bloqueado por dependência — pendente: Etapa / Item” (cada nome é um link que leva ao item, abrindo a etapa onde
  ele está agora) ou “✓ Dependências atendidas”; o formulário do item no modelo tem **+ Adicionar dependência** (lista agrupada por checklist, sem
  o próprio item nem quem depende dele). O índice de dependências é montado uma vez por resposta (`buildDepIndex`), sem consulta repetida por item.
- Auditoria: `checklist-bloqueado-dependencia` (tentativa de concluir com dependência pendente).

### Evidências

- **Envio**: arraste arquivos, escolha ou **cole uma imagem** (Ctrl+V) na janela de envio. O navegador manda o arquivo cru (sem biblioteca de
  upload); nome, tipo e descrição vão em cabeçalhos.
- **Onde ficam**: `data\evidencias\<projeto>-<id>\<NN>-<etapa>\<id>_<nome original>` — arquivos de verdade no disco; o `projects.json` guarda só
  metadados (nome, caminho **relativo**, tipo, tamanho, data, usuário, descrição). O nome vindo da tela nunca vira caminho, e mesmo nome
  enviado duas vezes **não sobrescreve** (o id é novo a cada anexo; a tela mostra o nome original).
- **Tipos** (por item): Imagem (`.png .jpg .jpeg .webp`), Documento (`.pdf .doc .docx .xlsx .xls .txt`), Imagem ou documento, Qualquer arquivo
  permitido (inclui `.csv .zip .gif .pptx .ppt .rtf .log .json .xml .md`). As listas e o **tamanho máximo por arquivo (padrão 10 MB, até 100)**
  ficam em **Configurações → Evidências** (`settings.evidence`), nada fixo na lógica.
- **Segurança**: extensão na lista do tipo; **assinatura do arquivo** conferida (um `.png` precisa ser PNG de verdade; `.docx/.xlsx` precisam ser
  ZIP; texto não pode ter dados binários); MIME declarado perigoso é recusado; qualquer programa (`MZ`/ELF) é recusado mesmo com outra
  extensão; `.exe .bat .cmd .ps1 .vbs .js .msi .lnk .html .svg …` são **sempre** recusados, mesmo que alguém os coloque na lista; limite de
  tamanho aplicado durante a leitura; caminho resolvido e conferido para nunca sair de `evidencias`. Nada anexado é executado: **Visualizar**
  (imagens, com `nosniff` e CSP `sandbox`), **Abrir** (programa padrão, só tipos permitidos e só arquivos gravados pelo app) e **Baixar**.
- **Remover** move o arquivo para `data\evidencias\.removidas` (nunca apaga) e o item volta a “aguardando evidência” se ela era exigida.
  Remover um projeto do app apaga só o cadastro; as pastas de evidências ficam no disco.
- **Auditoria** (`audit.log`, tela “Auditoria de execuções”): checklist iniciado, item marcado/desmarcado, evidência adicionada/removida,
  sincronização, alteração do modelo, **etapa concluída** e **avanço bloqueado** — com o usuário do Windows; nunca o conteúdo dos arquivos.

## Controle de Horas

Menu **Controle de Horas** (`#/hours`). Registra quanto tempo foi dedicado a cada projeto, compara com a **meta do dia** e gera a planilha mensal.
Tudo funciona dentro do app; a planilha é só uma **saída** (o app é a fonte dos dados e nada é escrito em Excel enquanto o cronômetro roda).

**Jornada × apontamentos (conceitos separados)**
- **Jornada** (Configurações → *Jornada e controle de horas*): início, término e intervalo padrão; a **meta** pode ser calculada (`fim − início − intervalo`) e
  ajustada à mão. Há **meta por dia da semana** (sábado/domingo = 00:00 = dia sem meta, nunca “pendente”), **fim previsto** por dia e **exceções por
  data** (feriado, expediente reduzido) — a meta de um dia é a exceção, se existir, senão a do dia da semana. O intervalo da jornada só entra na meta;
  é outra coisa que a **pausa do cronômetro**, que vale só para aquela atividade.
- **Apontamentos**: como as horas foram distribuídas. Só os **confirmados** contam para a meta.

**Cronômetro**
- **Iniciar trabalho** (Home, página do projeto, barra lateral ou página de horas): projeto (ou **Interno / Administrativo**, para o que não é de um projeto),
  atividade (**obrigatória**) e observação. O coordenador vem do cadastro do projeto.
- **Só uma atividade rodando**: iniciar outra pergunta se deseja *pausar a atual e iniciar a nova* (a atual fica pausada e pode ser **retomada**).
- **Pausar / Retomar**: o tempo parado **não conta** (09:00→12:00 com pausa 10:00–10:30 = 02:30). Encerrar uma atividade pausada termina onde ela foi pausada.
- **Encerrar** mostra o resumo (projeto, atividade, início, fim, pausas, tempo líquido e como o dia fica) → **Confirmar apontamento**, **Editar** ou **Cancelar**
  (cancelar deixa o cronômetro como está). O fim gravado é o do resumo, não o do clique.
- **Não se perde ao recarregar ou trocar de tela**: o servidor guarda início, pausas e situação (timestamps reais) e a tela recalcula a cada segundo.
  Se o app for **reiniciado** (ou a atividade passar a noite rodando), aparece “Atividade não encerrada” com **Continuar / Corrigir / Encerrar agora**.

**Apontamentos manuais e correções** — *+ Apontamento manual* na página do dia (qualquer data passada), *Editar* e *Excluir* (com confirmação) em cada
apontamento. **Sobreposição de horários é bloqueada** com o motivo (as pausas de outra atividade ficam livres para apontar). Não aceita data/horário futuro,
atividade vazia nem período de menos de 1 minuto. Todo total (dia, mês, %, restante, status, dashboard, exportação) é **recalculado** a partir dos apontamentos.

**Meta do dia** — meta, apontado, restante, atingimento e barra (vermelha muito abaixo, amarela próxima, verde ao atingir). Com cronômetro rodando aparecem
**Confirmado / Em andamento / Projeção** separados. Acima da meta: “Meta atingida · Excedente” (o apontamento nunca é limitado à meta).
Status do dia: **Completo, Pendente, Excedente, Sem apontamento, Sem meta**. **Dias pendentes** (Home e página de horas) lista dias anteriores com meta > 0 não
atingida, só a partir de *Considerar pendências a partir de* (por padrão, o primeiro apontamento). O painel mensal mostra meta acumulada, apontado, diferença e
dias completos/pendentes/excedentes; filtros do histórico: período, projeto e status.

**Aviso de horas faltando** — perto do fim previsto do expediente (minutos configuráveis), **só se houver pendência** (meta atingida/excedida não avisa): aviso
na tela e, opcionalmente, notificação do Windows. Apenas informa; **nunca cria horas** — você informa projeto, atividade e horários.

**Exportação** — *Exportar Excel* (mês/ano) gera `Apontamentos_AAAA_MM.xlsx` só de leitura (pode repetir sempre). Abas: **Apontamentos** (período, data, dia da
semana, projeto, coordenador, **analista**, atividade, início, fim, pausas, horas trabalhadas, meta, **% da meta – atividade** e **% da meta – dia**, total do dia, restante,
excedente, observação; cabeçalho e primeira linha congelados, filtros, datas/horas/percentuais como tipos do Excel, durações `[h]:mm` que passam de 24 h),
**Resumo Mensal** (meta, apontado, diferença e status por dia + totais, mais a coluna **Observações** com a contagem do dia; dias antes do início do controle aparecem como “Antes do controle”), **Resumo por Projeto** (com coordenador(es) e analista(s)) e **Observações** (veja abaixo).

**Dados** (`projects.json`): `hours` (jornada, exceções, aviso), `timeEntries` (confirmados) e `timers` (em andamento/pausados). Um apontamento guarda data
(local, AAAA-MM-DD), início/fim em **minutos** desde a meia-noite, pausas em minutos, atividade, observação e — em **fotografia** — o nome do projeto e do
**coordenador e do analista na hora do apontamento** (mudar o coordenador/analista ou remover o projeto não altera o histórico; o analista vem do projeto, não é escolhido no formulário). A duração **nunca é gravada**, é calculada
(`fim − início − pausas`, em minutos inteiros). Projeto “concluído” = no último passo do ciclo: sai das opções padrão (há “Mostrar projetos concluídos”), mas o
histórico e os relatórios continuam. Datas e horários são locais (mesmo padrão do resto do app); o tempo do cronômetro vem do servidor.
Auditoria: iniciar, pausar, retomar, confirmar, criar, editar, excluir, descartar, exportar e alterar a jornada.

### Observações do dia

Dentro da própria tela de horas (não é um módulo à parte): registra **ocorrências do dia** — problema, erro, atraso, indisponibilidade — que ajudam a explicar
por que um dia ficou incompleto, com **evidências** (prints, documentos).

- **Uma observação vale para UM OU MAIS DIAS do mesmo mês** (não de um apontamento): ex. “os dias 05, 12 e 19 não foram lançados porque o sistema do
  cliente estava fora do ar”, com o motivo e a evidência lançados uma vez só. Pode haver **várias por dia e várias por mês, de tipos diferentes**, e nenhuma
  precisa de apontamento. Campos: **mês + dias marcados num calendário** (nunca no futuro; no máximo 31; um mês por observação — para outro mês, crie outra),
  **título** curto (obrigatório), descrição, **projeto opcional** (“Nenhum / Geral”), **categoria** (Informação, Problema,
  Erro, Atraso, Indisponibilidade, Ajuste, Outro), criada/atualizada em e por quem (usuário do Windows). Já existem, reservados para depois e sem tela
  ainda, `severity` (baixa/média/alta) e `entryId` (ligar a um apontamento do mesmo dia; o servidor confere).
- **Na tela**: no card do mês, **Observações do mês** (**+ Adicionar observação do mês**) e, abaixo dos apontamentos de cada dia, *Observações do dia*
  (o mesmo formulário, já com aquele dia marcado). No calendário, os dias com borda laranja ficaram sem lançamento/incompletos e **Marcar dias pendentes**
  marca os dias anteriores a hoje nessa situação. **Salvar**, **Salvar e adicionar evidência** ou **Salvar e adicionar outra** (mantém o mês, para lançar outro
  tipo de observação). Uma observação de vários dias aparece **em cada um deles**, com a mesma evidência. Editar muda dias, título, texto, projeto e categoria —
  **as evidências nunca são removidas por uma edição**. Excluir pede confirmação e informa quantos dias e quantas evidências serão afetados.
- **Evidências**: até 10 por observação, **o mesmo sistema do checklist** (mesma janela de envio: arrastar, escolher ou colar com Ctrl+V; mesmas
  validações de extensão, assinatura, MIME, tamanho e nome; nada é executado; **Visualizar** com miniatura, **Abrir**, **Baixar**, **Remover**). Os tipos
  aceitos (imagem ou documento) e o tamanho máximo vêm de **Configurações → Evidências**. Arquivos ficam em `data\evidencias\horas\AAAA-MM\AAAA-MM-DD\`;
  remover uma evidência ou excluir a observação move o arquivo para `data\evidencias\.removidas` (não sobra arquivo órfão nem se apaga nada).
- **Onde aparece**: no **histórico** cada dia mostra “⚠ N observações” (e as observações), com filtro **Todos / Com observações / Sem observações**
  (e o filtro de projeto também vale para elas); na **Home**, “Hoje: N observações” e as **ocorrências recentes** (últimos 14 dias); nos **dias pendentes**,
  as primeiras observações do dia dão o contexto do que faltou.
- **Exportação**: nova aba **Observações** — uma linha por observação **e por dia**: Data, Dia da semana, Projeto (“Geral” se não houver), Categoria, Título,
  Observação, Qtd. de evidências, nomes dos arquivos, quando foi registrada e **Dias da observação** (todos os dias que ela cobre). **Não embute imagens** (só a contagem e os nomes); as evidências continuam no app.
- **Projeto removido**: a observação continua, com o nome guardado na hora (“projeto removido”).
- **Dados**: `timeNotes` em `projects.json` (`dates` = dias da observação; observações antigas de um dia só ganham `dates` sozinhas; evidências só com metadados e caminho relativo) e `hours.noteCategories` (lista de categorias com tom de cor;
  ainda sem tela de edição — mexer no arquivo com o app fechado). Auditoria: observação criada, editada, excluída, evidência adicionada e removida.

## Segurança da importação

Nada é executado sem você ver **o quê, onde e como**:

1. **Origem** – a planilha DE-PARA do projeto já vem associada (se ainda não houver arquivo, é só anexar ali mesmo; para usar uma versão mais nova, **Anexar nova versão…**); só se escolhe base (se houver mais de uma) e ambiente (Localhost ou Produção).
2. **Abas e tabelas** – lista compacta (uma linha por aba; as colunas ficam recolhidas e só abrem se você quiser ajustar nome/tipo). Marca abas, confere os nomes e escolhe **uma regra geral** para todas as abas selecionadas (não sobrescrever / apagar e recriar / renomear a antiga como backup). Tipos das colunas: padrão tudo texto, preservando zeros à esquerda. **A seleção de abas, os nomes e os tipos são salvos automaticamente a cada alteração** (por DE-PARA) e voltam na próxima importação: marcar uma aba nova ou desmarcar uma fica lembrado. Há **busca** por nome da aba, da tabela ou de coluna; **Selecionar / Limpar valem só para as abas visíveis na busca** (as escondidas não são alteradas e continuam valendo, com aviso no contador). Cada aba tem ainda uma busca própria de colunas, com marcar/desmarcar só das visíveis. O modo de sobrescrita **nunca** é lembrado (sempre começa em “Não sobrescrever”). Aqui também fica a caixa **Executar scripts SQL depois de importar**; os scripts marcados (e a ordem) são lembrados por DE-PARA, o texto nunca — é sempre lido do arquivo na hora de gerar o plano.
3. **Revisão** – o app gera um **plano** e mostra: servidor, banco e login **reais** (lidos da conexão), situação atual de cada tabela (existe? quantas linhas?), lista de comandos destrutivos, os **scripts SQL que rodarão depois** (nome, arquivo, lotes, selos DELETE/DROP/TRUNCATE/SQL dinâmico) e o **script SQL completo** (prévia + `.sql` para download; o texto de cada script do usuário aparece por inteiro). Não há caixas de confirmação nem texto a digitar: o clique em **Executar** é a autorização.
   - Localhost: **Executar** ou **Simular** (executa tudo e desfaz no final).
   - **Produção**: botão vermelho **Executar em PRODUÇÃO** (sem simulação). Sobrescrever tabelas em produção continua exigindo habilitar isso na configuração da base.
4. **Execução** – roda **exatamente o plano aprovado** (identificado por hash SHA-256, uso único, expira em 20 min), em **uma única transação**: qualquer erro → `ROLLBACK` de tudo. Antes do `COMMIT`, o `COUNT(*)` de cada tabela é conferido contra o esperado.

Proteções adicionais:

- O navegador **nunca envia SQL**; o servidor gera os comandos a partir de nomes/tipos validados e valores escapados.
- Trava no executor: aceita os formatos de comando gerados pelo plano (mais os lotes dos scripts do usuário, que passam pela mesma análise de bloqueio) e recusa `DELETE`, `TRUNCATE`, `ALTER`, `UPDATE`, `MERGE`, `xp_*`, `sp_*` (exceto `sp_rename`), `USE` etc. `DROP`/`RENAME` só passam com autorização destrutiva explícita.
- Se a conexão abrir um banco diferente do configurado, a operação é cancelada.
- **VPN caída / servidor sem resposta nunca trava o app.** Antes de conectar, o app testa a rede (DNS e porta): servidor inalcançável
  falha em ~6 s com a mensagem "confira se a VPN está conectada". Cada operação de banco roda num **processo separado** (`src/dbworker.js`);
  se o SQL Server aceitar a conexão mas não responder, o app desiste em 25 s e encerra esse processo, sem afetar as outras conexões
  (o teste do localhost continua funcionando). Servidores locais pulam o teste de rede. Instância nomeada sem porta (`SERVIDOR\INSTANCIA`)
  só tem o DNS conferido — informe a porta na base para o teste completo.
- A conexão “Localhost” só aceita `localhost`, `127.0.0.1`, `.`… — servidor remoto não pode ser cadastrado como teste.
- Senhas SQL ficam criptografadas com DPAPI do Windows (só este usuário, neste computador).
- **Produção: sobrescrever tabelas vem bloqueado** em cada base. É preciso habilitar “Permitir sobrescrever tabelas em produção” na base. Sem isso, o app só cria tabelas novas.

### Scripts SQL depois da importação

- Cada script é um arquivo `.sql` (UTF-8 com BOM) em `data\scripts`. Ao editar, a versão anterior vai para `data\scripts\.versoes` (últimas 20); ao remover, o arquivo é **movido** para `data\scripts\.removidos`, nunca apagado. Importar um `.sql` existente **copia** o conteúdo (o original não é alterado; ANSI/UTF-16 são convertidos).
- `GO` em linha própria separa lotes (necessário antes de `CREATE PROCEDURE/VIEW/FUNCTION`). Cada lote vira um comando do plano, entra no hash SHA-256 e roda depois das tabelas e da conferência de contagem, **na mesma transação**: se qualquer lote falhar, a importação inteira é desfeita e a mensagem diz **qual script e qual lote** falhou. **Simular** (localhost) também executa os scripts e desfaz tudo.
- **O que roda é o que foi aprovado**: o texto é lido do arquivo ao gerar o plano; editar o arquivo depois não muda a execução daquele plano.
- **Variáveis `{{NOME}}`** – um mesmo script serve a todas as bases. Ao gerar o plano, o app troca cada `{{NOME}}` pelo valor; a análise, o hash, a revisão e a execução usam o texto **já trocado** (a revisão lista `-- Variável {{BANCO}} = …`).
  - Automáticas (preenchidas pelo destino, não podem ser redefinidas): `{{BANCO}}` (banco de destino), `{{SCHEMA}}`, `{{SERVIDOR}}`, `{{AMBIENTE}}` (`LOCAL`/`PRODUCAO`), `{{PROJETO}}`, `{{BASE}}`.
  - Qualquer outro nome (ex.: `{{ORIGEM_1}}`) vira um campo no passo 2 da importação; o valor fica lembrado por planilha.
  - Valores aceitam só letras, números, espaço, `_ . -` (sem aspas, colchetes, `;` nem `--`), então nunca conseguem “sair” de um texto. Escreva a variável entre aspas ou colchetes: `DECLARE @BancoDestino SYSNAME = '{{BANCO}}';` ou `[{{BANCO}}].dbo.TABELA`.
  - Variável sem valor → o plano não é gerado (a mensagem diz quais faltam). A trava de execução recusa qualquer lote que ainda tenha `{{…}}`.
- **Saída do script na tela**: mensagens de `PRINT` e os resultados de `SELECT` (até 20 resultados × 50 linhas) aparecem no fim da execução/simulação — inclusive quando falha. Ficam só na tela, nunca na auditoria.
- **TRY/CATCH**: dentro da transação do app, um erro capturado por `TRY/CATCH` deixa a transação “não confirmável”: o SQL Server desfaz tudo no fim do lote (erro 3998) e o app mostra as mensagens do script, onde está o erro original. Ou seja: o script **não** “pula” a tabela com erro e segue, como faria no SSMS — tudo ou nada.
- **Bloqueados** (o app se recusa a gerar o plano): `USE`/troca de banco, `CREATE/ALTER/DROP DATABASE`, `BACKUP/RESTORE`, `BEGIN/COMMIT/ROLLBACK/SAVE TRAN` (a transação é do app), `SET XACT_ABORT OFF`, `SET NOEXEC/PARSEONLY ON`, `xp_*` e `sp_*` perigosos, `OPENROWSET/OPENDATASOURCE/OPENQUERY`, `BULK INSERT`, `EXECUTE AS`, logins/credenciais/endpoints, `SHUTDOWN`, `KILL`, `RECONFIGURE`, linhas SQLCMD (`:r`, `:connect`…).
- **Sinalizados**: `DELETE`, `TRUNCATE` e `DROP` aparecem como selos na lista, na revisão e no plano — inclusive quando estão dentro de um texto que o lote executa como SQL dinâmico (ex.: `SET @SQL = N'DROP TABLE ' + …; EXEC sp_executesql @SQL`), com o selo “(dinâmico)”. Nesses lotes, os bloqueios inequívocos (xp_*, OPENROWSET, BACKUP, logins…) também valem dentro dos textos. No localhost rodam normalmente; em **produção só rodam se a base permitir sobrescrever/apagar** (senão o plano fica bloqueado e a execução é recusada). SQL dinâmico (`EXEC(...)`, `sp_executesql`) é avisado, pois o app não consegue conferir o que ele fará.
- Auditoria: registra só nome, arquivo, nº de lotes e hash do conteúdo de cada script — nunca o texto.

### Se a tabela já existir (por aba)

| Modo | O que faz | Comando destrutivo? |
|---|---|---|
| Não sobrescrever *(padrão)* | Plano fica bloqueado se a tabela existir | Não |
| Apagar a antiga e criar de novo | `DROP TABLE` + `CREATE` + `INSERT` | **Sim** |
| Renomear a antiga como backup | `sp_rename` para `<tabela>_bkp_<data_hora>` + `CREATE` + `INSERT` | Não apaga dados, mas altera objetos |

> A VPN de produção bloqueia `DROP`/`DELETE`. O modo “Apagar” em produção portanto **falhará** e será desfeito (ROLLBACK), o que é o esperado.
> O modo “Renomear” não usa DROP/DELETE, mas deixa tabelas `_bkp_` no banco — use com critério.

## Workspace (arquivos e Git de todos os projetos)

O **Workspace** (menu lateral → **Workspace (arquivos e Git)**, rota `#/workspace`) é um **gerenciador de arquivos e repositórios**,
não um editor: a edição dos scripts fica com o VS Code/SSMS. Ele é **global**: aponta para uma **pasta raiz** (ex.: `C:\Projetos`) que
contém vários projetos, cada um com seu próprio repositório Git.

```
C:\Projetos
├─ ClienteA   (.git próprio, remote e branch próprios)
├─ ClienteB   (.git próprio)
└─ Clientes
   └─ ClienteC (.git próprio)
```

- **Pasta raiz** (link ao lado de “Workspace”, ou na primeira vez que abrir): qualquer pasta existente (ou nova, se você pedir). Raiz de
  disco e pastas do sistema são recusadas. O app guarda **só** essa configuração e os apelidos dos projetos (`workspace` em
  `projects.json`) — nunca o conteúdo dos arquivos. Tudo acontece nos arquivos reais: o que muda fora (VS Code, SSMS, Explorer) aparece
  aqui ao clicar ⟳ ou ao voltar para a janela.
- **Projetos**: cada pasta com `.git` até 3 níveis abaixo da raiz vira um projeto (pastas intermediárias, como `Clientes`, viram grupos);
  pastas comuns do primeiro nível também aparecem, marcadas como “sem Git”. A lista mostra branch e situação (`✓` sincronizado,
  `● 3` alterações, `↑ 1` para Push, `↓ 2` para Pull, `local` sem remote) e, quando houver, o projeto do app ligado àquela pasta
  (pasta raiz, diretório de uma base ou o repositório usado antes). Na página de um projeto do app, **Abrir no Workspace** abre direto
  a pasta dele. Clique direito num projeto: apelido, abrir no VS Code/Explorer, Git.
- **Origem ⇄ Destino** (visão padrão): dois painéis lado a lado, cada um com um projeto e sua árvore de pastas. Por padrão mostram
  só `.sql` (marque **todos os arquivos** para ver o resto). Ctrl/Shift+clique seleciona vários; as caixas também marcam.
  - **Copiar →** / **← Copiar**: copia os itens marcados (arquivos, vários arquivos ou pastas inteiras) para a pasta selecionada do
    outro lado. **Mover** faz o mesmo e remove da origem. **Clonar** copia mantendo o **mesmo caminho relativo** (ex.:
    `ClienteA/scripts/PFUNC.sql` → `ClienteB/scripts/PFUNC.sql`), criando as pastas que faltarem. Também dá para **arrastar e soltar**
    entre os painéis (copia; com Shift, move) ou dentro de um painel (move).
  - **Nunca sobrescreve em silêncio**: o app planeja a cópia antes; se algum arquivo já existe no destino, mostra a lista (tamanho e
    data dos dois lados, **Comparar** com as diferenças linha a linha) e você escolhe, por arquivo ou para todos: **Substituir** (o
    arquivo do destino vai para a **Lixeira do Windows** antes), **Manter ambos** (a cópia vira `nome (2).sql`) ou **Pular**; ou
    **Cancelar** tudo. Arquivos idênticos são indicados. Pastas `.git` dentro do que é copiado são ignoradas.
  - Clique direito num item: abrir no **VS Code** (abre a pasta do projeto com o arquivo), com o **aplicativo padrão** (executáveis e
    scripts são recusados) ou no **Explorer**; copiar/mover para outro projeto ou pasta (“Copiar para…”), clonar para projeto, novo
    arquivo/pasta, renomear, copiar caminho, mostrar no Git e **excluir** (vai para a Lixeira do Windows).
- **Busca** (caixa no topo): procura por nome ou caminho em todos os projetos (ou só `.sql`), sem diferenciar acentos; o resultado
  permite abrir no painel, no VS Code, no Explorer ou copiar os marcados para o Destino.
- **Repositórios** (visão geral): tabela com todos os repositórios — branch, alterações, sincronização, remote e quando o remoto foi
  consultado; **Fetch em todos** atualiza a situação sem mexer em nenhum arquivo.
- **Diferenças** (Git e comparação de arquivos): visualizador próprio, linha a linha, com 3 linhas de contexto ou o arquivo inteiro.

### Git por projeto

- **.gitignore**: o cartão do repositório mostra “GitIgnore ✓ configurado” ou “⚠ não encontrado — Criar .gitignore”. O editor (texto simples) só edita `<raiz do repositório>\.gitignore` — a tela nunca envia caminho. **Sugestões** (Temporários, Logs, VS Code, Windows, Segredos, Node, Python, Migração) mostram antes o que será **acrescentado** (só o que ainda não existe) e nada é gravado até salvar. Se o arquivo mudou por fora depois de aberto, salvar é recusado (nada é sobrescrito); a quebra de linha e o BOM do arquivo são mantidos.

O painel Git (embaixo) mostra o projeto da Origem ou do Destino (**Ver Origem / Ver Destino**). **Cada projeto usa o seu próprio
repositório**: toda operação roda com a pasta do projeto (`git_root`) como pasta de trabalho — o commit, o pull e o push de um nunca
afetam outro. Um arquivo copiado para um projeto aparece como novo (`U`) no Git **daquele** projeto.

O app usa o **Git instalado** (`git --version`; procura no PATH e em `C:\Program Files\Git`). Não há Git próprio nem comando livre:
o servidor tem uma rota para cada ação (`/api/wsm/git/commit`, `/push`, `/pull`, `/fetch`, `/checkout`, `/merge`…), monta os argumentos e
valida o projeto (sempre dentro da pasta raiz), nomes de branch (`git check-ref-format`), caminhos e URLs de remote.

- **Alterações**: cartão do repositório (pasta, branch → upstream, remote, status e quando o remoto foi consultado), `M/U/A/D/R` e
  conflitos; clique abre as diferenças (último commit × disco). **Commit só dos arquivos marcados** (`git add -A -- <arquivos>` +
  `git commit -- <arquivos>`, nunca `git add .`). **Fetch** (atualiza o que há no remoto sem mexer nos arquivos), **Pull** e **Push**
  (sem upstream publica a branch atual no `origin` com `-u`; sem `main` fixo), com os contadores ↑/↓ nos botões.
- **⋯ Mais**: branches (criar, trocar, excluir com segurança, merge; em conflito o app para, lista os arquivos e só aceita “Resolvido”
  sem marcadores `<<<<<<<`), histórico em lista e **Repositório e GitHub** (remotes; substituir um remote existente pede confirmação).
- **Histórico**: grafo de commits com branches locais e remotas (☁), tags, HEAD, commits só locais (“↑ push”) e só no remoto
  (“↓ pull”), relação **local × remoto** (“✓ Sincronizado”, “N à frente”, “N atrás”, “Divergiram”), 100 commits por vez; clicar num
  commit mostra detalhes e arquivos, e cada arquivo abre o diff daquele commit.
- Pasta sem Git: **Inicializar Git aqui** (`git init`, só se não houver `.git`) ou **Clonar do GitHub como novo projeto** (`git clone`
  para uma pasta nova dentro da raiz).
- **Autenticação no GitHub**: fica com o **Git Credential Manager** do Git para Windows (login no navegador no primeiro push/pull) ou a
  sua **chave SSH** (`git@github.com:…`). O app **não guarda** usuário, senha nem token; tokens embutidos em URLs nunca são exibidos
  nem gravados na auditoria. Erros mostram uma mensagem clara **e a saída original do Git**.
- **Auditoria** (`audit.log`): pasta raiz configurada, arquivos criados/renomeados/excluídos/copiados/movidos (origem, destino e
  decisões de conflito) e todas as operações Git — nunca o conteúdo dos arquivos.

### Arquitetura (serviços)

| Camada | Arquivo | Papel |
|---|---|---|
| Rotas | `src/workspace-api.js` | uma rota por ação (`/api/wsm/...`): pasta raiz, projetos, listar/buscar/comparar, criar/renomear/excluir, copiar/mover, abrir fora, Git por projeto |
| Arquivos | `src/workspace-files.js` | toda operação por caminho **relativo** validado dentro da pasta raiz (inclusive contra junções/atalhos que apontem para fora), descoberta de projetos, plano de cópia com conflitos, Lixeira |
| Git | `src/git.js` | `GitRepo` (status, diff, commit, pull, push, fetch, branches, merge, histórico em grafo, remotes, clone, init) |
| Tela | `public/workspace.js`, `public/workspace-git.js`, `public/workspace-history.js`, `public/diffview.js` | projetos, painéis Origem/Destino, busca e visão geral; painel Git; histórico em grafo; diferenças |

**Limitações conhecidas**: o Git no Windows não trabalha em pastas com caminho acima de 260 caracteres (o app avisa; habilite
`core.longpaths` ou use uma pasta mais curta); listas com mais de 5.000 itens por pasta e cópias com mais de 5.000 arquivos são
recusadas/truncadas com aviso; ainda não há editor visual de conflitos, stash/rebase/blame nem Pull Requests.

## Testes

```
npm test                      # testes unitários (plano, trava de segurança, cronograma, fórmulas, anexo de planilha, Workspace: projetos, caminhos, cópia entre projetos e conflitos, e Git por projeto com um remoto local; checklist: regras de avanço, sincronização, evidências, validação de anexos, N checklists por estágio e API; ciclos por tipo e versões; conexões (DPAPI, referência nas bases, importação); execução de scripts pelo checklist (travas, variáveis, confirmação, histórico); .gitignore; pasta inicial dos seletores; horas: pausas, sobreposição, meta/pendências, aviso, recuperação e exportação)
node scripts/e2e-local.js     # ponta a ponta no SQL Server LOCAL
```

O e2e cria a base descartável `GP_APP_TESTE` no `localhost`, importa uma planilha pelo fluxo real
(plano → execução; inclui substituição, backup, simulação e falha com rollback, além dos scripts SQL pós-importação: ordem, tratamento de dados, rollback quando um script falha, plano aprovado imutável e bloqueio de DELETE em produção) e a remove ao final.
Ele **nunca** toca em outra base nem em produção.

## Limitações conhecidas

- O app **não baixa** a planilha do Google sozinho (planilhas privadas exigiriam login OAuth do Google): o .xlsx é baixado pelo navegador e anexado ao projeto.
- Valores são lidos como estão na célula (não o texto formatado). Números formatados com máscara (ex.: `00123` via formato numérico) chegam sem a máscara; para preservar, a célula deve ser texto.
- O app não cria schemas nem bancos; usa os existentes.
- A análise dos scripts SQL é **estática, sobre o texto** (comentários, strings e `[identificadores]` são ignorados corretamente, mas não é um parser completo de T-SQL). Em SQL dinâmico ela procura as palavras-chave dentro dos textos, mas não consegue ver comandos montados por concatenação de pedaços (ex.: `'DR' + 'OP'`) nem o que uma procedure já existente executa por dentro. Por isso o texto completo é sempre exibido na revisão, e o banco de produção continua protegido pela VPN e pelas permissões do login usado.
- Fórmulas: importa o valor calculado salvo no arquivo (inclusive `0` e `FALSE`). Fórmula que resulta em vazio, sem valor salvo ou com erro (`#N/A`, `#REF!`…) vira `NULL`. O passo 2 avisa quantas células de cada aba caíram nesses casos.
