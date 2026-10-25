# OpenGuild

Comunidade open source no estilo Discord: servidores, canais de texto e voz, compartilhamento de tela com link público, trocas de itens Steam, acesso remoto (RustDesk), temas, YouTube, WhatsApp e partidas de CS2. Você hospeda na sua máquina ou numa VPS.

O app de desktop (Electron) é um cliente fino: a interface vem do site. Atualizar o servidor atualiza a comunidade para todo mundo; o `.exe` fica com a bandeja, a captura de áudio, o acesso remoto e o auto-update.

```
Self-hosted Discord-style community: servers, text, voice, screen share, public watch, Steam trades, remote desktop, and a desktop app.
```

## Sumário

1. [O que é](#o-que-é)
2. [Recursos](#recursos)
3. [Tecnologias](#tecnologias)
4. [Arquitetura](#arquitetura)
5. [Antes de publicar no GitHub](#antes-de-publicar-no-github)
6. [Rodar localmente](#rodar-localmente)
7. [Instalar numa VPS com o instalador](#instalar-numa-vps-com-o-instalador)
8. [Instalar ou atualizar sem o instalador](#instalar-ou-atualizar-sem-o-instalador)
9. [O que o bootstrap faz na VPS](#o-que-o-bootstrap-faz-na-vps)
10. [Steam, vitrine e trocas](#steam-vitrine-e-trocas)
11. [Compartilhamento de tela e link público](#compartilhamento-de-tela-e-link-público)
12. [Acesso remoto (RustDesk)](#acesso-remoto-rustdesk)
13. [WhatsApp](#whatsapp)
14. [App desktop](#app-desktop)
15. [Partidas CS2](#partidas-cs2)
16. [Operação](#operação)
17. [Contribuindo](#contribuindo)
18. [Licença e créditos](#licença-e-créditos)

## O que é

O OpenGuild é um servidor de comunidade que você mesmo sobe. Cada instalação tem os próprios usuários, servidores e arquivos. Não depende de um serviço central.

No navegador você entra, cria o primeiro administrador em `/setup` e usa a comunidade (chat, voz, tela, trocas Steam, WhatsApp). No Windows, o app de desktop abre o mesmo site e acrescenta captura de jogo, tray, acesso remoto e partidas de CS2 no PC do host.

A Central de Deploy (`installer-win`) também instala outros sistemas da mesma família (reuniões, mídia, RH). Este README cobre o OpenGuild. Os demais têm o próprio guia na pasta do projeto.

## Recursos

### Comunidade

- Servidores, categorias e canais de texto, voz e tela
- Mensagens em tempo real (Socket.IO), DMs com badge de não lidas e presença online
- Página **Descobrir** (`/descobrir`): servidores listados publicamente e pedido de entrada
- Cargos com permissões na API (incluindo `@everyone`). O dono tem tudo; só o dono edita o cargo Admin
- Convites (`/convite/:codigo`), expulsar, bloquear e remover servidor (a pessoa sai da voz e do socket na hora)
- Pedidos de entrada: o admin aprova ou recusa
- Lista de membros, roster de voz sem precisar entrar no canal
- Status de trabalho (disponível, ocupado, em ligação…) e ramal no perfil; overlay de chamada se houver PABX
- Tour de boas-vindas no primeiro acesso
- Uma sessão de voz por usuário: outra aba no mesmo canal toma o lugar da anterior

### Voz e transmissão

- Canais de voz com LiveKit: entrar, mute, ensurdecimento, volume por participante
- A voz continua ao navegar; card flutuante ao sair da sala
- Seletor de microfone e fone na barra inferior
- Compartilhar tela (monitor ou janela) com resolução, FPS e bitrate travados
- No Electron: áudio do jogo ou de um aplicativo (loopback WASAPI)
- Link público `/assistir/:slug` — convidado assiste sem conta, com limite de espectadores
- Chat opcional na página pública (só leitura ou convidados podem escrever)
- Filtros de ruído no cliente: Krisp, DeepFilterNet, RNNoise, DTLN, com AEC e medidores
- Retransmissão RTMP para Twitch/YouTube **ainda não** está nesta versão

### Customização e marca

- Temas por superfície: cabeçalho, barra de servidores, canais, chat, palco e membros
- Cor, imagem ou vídeo de fundo, desfoque, opacidade e painéis flutuantes
- Chrome do tema: acento, texto, links, painéis, bordas, cartões, inputs, perigo, sucesso
- Fonte, tamanho, contraste claro/escuro/automático e estilo padrão ou flutuante
- Presets prontos e upload de mídia (png, jpg, gif, webp; mp4/webm nos temas; `.ico` só da marca)
- Temas premium (flag no usuário), persistidos em `user_themes`
- Painel admin de marca: logo, nome e cores da instalação

### Perfil e Steam

- Avatar, nome, ramal, contas de stream e histórico
- Ligar Steam (OpenID), vitrine de até 5 itens no perfil, detalhe do item (raridade, exterior, inspect, float)
- Propostas de troca entre membros da comunidade (inventário público + Trade URL); a oferta real fecha na Steam
- OpenID da Steam pelo proxy `/steam` (precisa de `PUBLIC_BASE_URL` certo)

### YouTube

- Página `/youtube`, busca e player persistente
- Dock no desktop e slot no cabeçalho da voz
- Ajustes de YouTube no admin

### WhatsApp

- Hub no mesmo login da comunidade
- Várias sessões por usuário (QR ou código de 8 dígitos)
- Chats, grupos, mídia, áudio e status, no layout do WhatsApp Web
- Gateway isolado em `127.0.0.1` — o navegador não fala com o WhatsApp direto

### Administração

- Primeiro acesso em `/setup` (cria o super admin)
- Usuários: papel, premium, desativar (vale na hora; trocar senha derruba sessões antigas)
- Storage e uploads com lista fechada de formatos e verificação de assinatura
- Configuração de YouTube e temas
- Login com limite de tentativas, `helmet`, JWT obrigatório em produção (≥ 32 caracteres)

### Desktop (Windows)

- Cliente Electron com bandeja: fechar a janela mantém a voz; sair de verdade desliga
- Auto-update pelo feed `/desktop/`
- Captura de tela e áudio de jogo (loopback)
- Acesso remoto entre membros via RustDesk self-hosted (pedir controlo ou pedir ajuda)
- Host de partidas CS2 (dedicated local + UPnP)

### Partidas CS2

- Canal Competitive: lobby, convites, pronto e veto de mapa
- Mapas com foto (Mirage, Inferno, Dust2, Nuke, Ancient, Anubis)
- Dedicated `cs2.exe` no PC do host, porta UDP 27015–27030
- Amigos entram com `steam://connect` no IP público do host
- Match packs remotos (DLL + manifesto) servidos pela API
- Sons de kill estilo Quake, chat de kill, bots no assistente de sala

## Tecnologias

| Camada | Stack |
|--------|--------|
| API | NestJS, Prisma, PostgreSQL, Redis, Socket.IO, JWT, Helmet, LiveKit Server SDK |
| Web | React 19, Vite, TypeScript, Zustand, TanStack Query, LiveKit Client, Socket.IO Client |
| Desktop | Electron 35, electron-builder, electron-updater, loopback de áudio, UPnP |
| Voz | LiveKit (salas `sfr-{serverId}-ch-{channelId}`) |
| WhatsApp | [zapo-js](https://github.com/vinikjkkj/zapo) e [`@zapo-js/store-postgres`](https://www.npmjs.com/package/@zapo-js/store-postgres) |
| Deploy | Nginx, systemd, Certbot, script `deploy/remote-bootstrap.sh` |
| Instalador Windows | Python, CustomTkinter, Paramiko (`INSTALLAR.cmd`) |
| CS2 | Plugin C# (`SfAssignTeams`, `SfKillSounds`), GSI, GSLT |

Node 20 ou 22. Python 3.10+ só para o instalador e os scripts de deploy.

## Arquitetura

```
OpenGuild/
  apps/api          API NestJS (JWT, Socket.IO, Prisma, LiveKit, Steam/trocas, remoto, temas, YouTube, CS2)
  apps/web          Interface React (comunidade, voz, tela, watch público, Steam, WhatsApp)
  apps/desktop      Electron (bandeja, captura, RustDesk, updater, dedicated CS2)
  packages/shared   Tipos e helpers compartilhados
  whatsapp/         Gateway Zapo (Node), só em 127.0.0.1
  deploy/           Bootstrap da VPS e scripts de install/update
  installer-win/    Central de Deploy (GUI Windows → VPS)
  match-packs/      Manifestos e DLLs das partidas CS2
```

| Ambiente | Endereço típico | Porta do app | Banco |
|----------|-----------------|--------------|--------|
| Dev | http://127.0.0.1:5174 (web) e API 8014 | — | Postgres local (ou o do `docker-compose`) |
| VPS | https://seu-dominio | **5071** (só localhost; o Nginx publica 80/443) | Postgres `steamfarm_react` |

Cookie de sessão: `sf_react_token`. Sem `REDIS_URL`, presença e adaptador do Socket.IO ficam na memória do processo (serve para um nó só).

## Antes de publicar no GitHub

Revisei o que o Git rastreia neste computador:

- O `.env` **não** entra no repositório (está no `.gitignore`).
- Não há `.pem`, `.key` nem arquivos de credencial versionados.
- Não há senha, token JWT, chave LiveKit, chave Steam nem senha SSH commitados.
- O `.env.example` só tem placeholders (`change-me-to-a-long-random-string`) e host de exemplo do RustDesk.
- O `docker-compose.yml` usa usuário/senha locais `steamfarm`/`steamfarm` só do container de desenvolvimento. Troque se for expor essa composição.

Antes do `git push`, confira na sua máquina:

```powershell
git status
git check-ignore -v .env
git ls-files ".env" ".env.*" "*.pem" "*.key"
```

Não commite `data/`, `uploads/`, `desktop-releases/*.exe`, `installer-win/payload/` nem dumps de banco. A senha SSH da VPS fica na memória do instalador ou em variável de ambiente (`SF_DEPLOY_PASS`); não coloque no Git.

Se este clone já apontava para um remoto antigo, crie o repositório **OpenGuild** vazio no GitHub e troque o `origin`, ou faça um push do histórico atual para o nome novo.

## Rodar localmente

### O que você precisa

- Node.js 20+ (22 de preferência)
- npm
- PostgreSQL 16 (instalado na máquina ou via Docker)
- Redis (opcional no dev; recomendado se for testar presença em mais de um processo)
- LiveKit (opcional; sem ele a comunidade sobe, a voz não)
- Python 3.10+ só se for usar o instalador ou os scripts da pasta `deploy/`

### 1. Código e ambiente

```powershell
git clone https://github.com/SEU-USUARIO/openguild.git
cd openguild
copy .env.example .env
npm install
```

Edite o `.env`:

- `JWT_SECRET` — texto longo e aleatório (em produção, no mínimo 32 caracteres)
- `DATABASE_URL` — Postgres vazio, por exemplo `postgresql://postgres@127.0.0.1:5432/openguild?schema=public`
- `PUBLIC_BASE_URL` e `CORS_ORIGIN` — `http://127.0.0.1:5174`
- `VITE_API_URL` e `VITE_WS_URL` — `http://127.0.0.1:8014`
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — se for testar voz ou compartilhamento de tela
- `RUSTDESK_ID_SERVER` e `RUSTDESK_KEY` — se for testar acesso remoto (servidor hbbs/hbbr próprio)
- `ZAPO_GATEWAY_SECRET` e `ZAPO_DATABASE_URL` — se for testar WhatsApp

Crie o banco no Postgres (`CREATE DATABASE openguild;`) ou use o compose:

```powershell
docker compose up -d postgres redis
```

O compose sobe Postgres em `127.0.0.1:5434` e Redis em `127.0.0.1:6380`. Ajuste o `.env` para essas portas.

### 2. Banco e API

```powershell
npm run build -w @steamfarm/shared
cd apps\api
npx prisma generate
npx prisma db push
cd ..\..
```

### 3. Subir o site

```powershell
npm run dev
```

- Interface: http://127.0.0.1:5174
- API: http://127.0.0.1:8014
- Primeiro usuário: http://127.0.0.1:5174/setup

### 4. WhatsApp local (opcional)

```powershell
npm run dev:wa
```

O gateway escuta em `http://127.0.0.1:8788`. Sem `ZAPO_GATEWAY_SECRET` no `.env` da API e do gateway, o hub não autentica.

### 5. Desktop em modo dev (opcional)

Com `npm run dev` já no ar:

```powershell
cd apps\desktop
npm install
npm run dev
```

Para apontar o app para um site já publicado:

```powershell
$env:SF_COMMUNITY_URL = "https://seu-dominio"
npm run start -w @steamfarm/desktop
```

## Instalar numa VPS com o instalador

O caminho mais simples no Windows. O assistente empacota o monorepo, envia por SFTP e roda `deploy/remote-bootstrap.sh`. Ele **não** reinicia os outros serviços da VPS e só grava o site Nginx deste sistema.

### VPS

- Ubuntu ou Debian
- SSH como **root**
- Domínio com DNS **A** no IP da VPS
- Portas 80 e 443 abertas
- Porta local livre (padrão **5071**)

### No seu Windows

```bat
INSTALLAR.cmd
```

Ou:

```bat
cd installer-win
pip install -r requirements.txt
python install_gui.py
```

1. Escolha **SteamFarm Comunidade** (é este projeto; o nome interno ainda é esse).
2. Informe host, usuário `root` e senha SSH.
3. **Instalar do zero**: domínio (`chat.seudominio.com`), porta **5071**, HTTPS e e-mail do Let's Encrypt.
4. Deixe *Reutilizar o Postgres do SteamFarm Flask* desmarcado numa VPS limpa. Marque só se `/opt/steamfarm` já existir e você quiser o mesmo banco.
5. LiveKit: pode reutilizar um servidor já instalado ou configurar depois em `/opt/steamfarm-react/.env`.
6. Confirme. O bootstrap cria `/opt/steamfarm-react`, o serviço `steamfarm-react`, o certificado e o Nginx só deste domínio.

Abra `https://seu-dominio/setup` e crie o administrador.

Para **atualizar** depois: o mesmo assistente, modo *Atualizar código*. Preserva `.env`, banco, Nginx, certificado e a pasta `/desktop`.

A Central também instala outros produtos se as pastas existirem ao lado. Isso não é obrigatório para o OpenGuild.

## Instalar ou atualizar sem o instalador

Tudo o que o GUI faz cabe em SSH + o script da pasta `deploy/`. Os exemplos usam PowerShell no Windows; no Linux, exporte as mesmas variáveis.

### Instalação numa VPS limpa

```powershell
pip install paramiko

$env:SF_DEPLOY_PASS = 'senha-root'
$env:SF_DEPLOY_HOST = '203.0.113.10'
$env:SF_DEPLOY_DOMAIN = 'chat.seudominio.com'
$env:SF_DEPLOY_EMAIL = 'voce@seudominio.com'
$env:SF_DEPLOY_APP_PORT = '5071'
$env:SF_REUSE_STEAMFARM_DB = '0'
$env:SF_REUSE_LIVEKIT = '0'

python deploy/install_vps.py
Remove-Item Env:SF_DEPLOY_PASS
```

O script empacota o repositório, sobe o tarball e executa `deploy/remote-bootstrap.sh` como root. Na VPS limpa ele cria o banco `steamfarm_react` e roda `prisma db push`.

### Mesma VPS de um SteamFarm Flask antigo

```powershell
$env:SF_REUSE_STEAMFARM_DB = '1'
$env:SF_REUSE_LIVEKIT = '1'
python deploy/install_vps.py
```

Aí o bootstrap **não** faz `prisma db push` destrutivo. Aplica só o SQL aditivo (`deploy/add_react_columns.sql`) no banco `steamfarm`.

### Atualizar só o código

```powershell
$env:SF_DEPLOY_PASS = 'senha-root'
$env:SF_DEPLOY_HOST = '203.0.113.10'
$env:SF_DEPLOY_DOMAIN = 'chat.seudominio.com'
$env:SF_REUSE_STEAMFARM_DB = '1'
python deploy/update_vps.py
```

No update, `REUSE_STEAMFARM_DB=1` é o padrão seguro: não apaga tabelas de WhatsApp, Steam nem faturamento se o banco for compartilhado.

### Na própria VPS (sem o PC Windows)

1. Copie o repositório para um tarball (sem `node_modules`, `.env`, `data/`, `uploads/`).
2. Envie para `/tmp/steamfarm-react.tgz`.
3. Envie `deploy/remote-bootstrap.sh` para `/tmp/steamfarm-react-bootstrap.sh`.
4. Rode, como root:

```bash
export APP_ARCHIVE=/tmp/steamfarm-react.tgz
export DOMAIN_NAME=chat.seudominio.com
export SSL_EMAIL=voce@seudominio.com
export APP_PORT=5071
export ENABLE_SSL=1
export MODE=install          # ou update
export REUSE_STEAMFARM_DB=0
export REUSE_LIVEKIT=0
bash /tmp/steamfarm-react-bootstrap.sh
```

Não rode `prisma db push` à mão num banco que já tenha dados de outro sistema.

## O que o bootstrap faz na VPS

Script: [`deploy/remote-bootstrap.sh`](deploy/remote-bootstrap.sh)

1. Pacotes (nginx, certbot, Node, rsync)
2. Usuário `steamfarmreact` e pasta `/opt/steamfarm-react`
3. Extrai o código e **preserva** `data/`, `uploads/`, `.env`, `desktop/` e `desktop-releases/`
4. Resolve o banco (novo, reusa o Flask ou reusa o `.env`)
5. Gera ou atualiza o `.env` (não sobrescreve segredos já gravados)
6. `npm ci` → `prisma generate` → SQL aditivo **ou** `db push` (só install limpo) → `npm run build`
7. Nginx só deste domínio + systemd `steamfarm-react`
8. Certbot no domínio informado

| Caminho | Uso |
|---------|-----|
| `/opt/steamfarm-react` | Aplicação |
| `/opt/steamfarm-react/.env` | Segredos |
| `/opt/steamfarm-react/apps/web/dist` | Site |
| `/opt/steamfarm-react/desktop/` | Feed do Electron |
| `/etc/nginx/sites-available/steamfarm-react` | Vhost |
| `/etc/systemd/system/steamfarm-react.service` | Serviço |

```bash
systemctl status steamfarm-react
journalctl -u steamfarm-react -f
nginx -t && systemctl reload nginx
curl -I https://SEU-DOMINIO/
```

## Steam, vitrine e trocas

A comunidade não substitui a Steam. Ela organiza a proposta; a oferta de itens fecha no cliente Steam, com a Trade URL de cada um.

### Ligar a conta

1. No perfil, **Ligar Steam**. O OpenID volta para `/api/steam/link/callback`.
2. `PUBLIC_BASE_URL` tem de ser o endereço público real (no desktop o app abre o navegador e devolve o vínculo).
3. Cole a **Trade URL** (Inventário → Ofertas de troca → Privacidade → URL de oferta). Sem ela ninguém consegue propor troca com você.
4. O inventário precisa estar **público** na Steam. Inventário privado aparece como indisponível.

### Vitrine

No perfil você escolhe até **5 itens** do inventário. Eles aparecem no cartão do membro (raridade, exterior, inspect, float quando a Steam devolve). Outro membro pode abrir o item e, dali, começar uma proposta.

### Como funciona a troca

1. Abra o perfil do parceiro (ou **Minhas trocas**) e monte o que você dá e o que pede.
2. Os dois lados precisam de Steam ligada, Trade URL salva e inventário público.
3. A proposta entra como `Proposta`. Só o parceiro aceita ou recusa.
4. Ao aceitar no app, o status vira **Envio manual na Steam**. Cada um abre a Trade URL do outro, monta a mesma oferta no cliente Steam e confirma lá.
5. Quando a oferta da Steam concluir, marque **Concluída** na comunidade. O proponente pode cancelar enquanto não fechou; o parceiro pode recusar.

Histórico: até 50 trocas por par, com contagem de pendentes, concluídas e canceladas.

A API **não** envia a oferta pela Steam Web API. Não pedimos `sessionid` nem cookie da Steam. Quem forkar o projeto e quiser automação de oferta assume os termos da Valve.

## Compartilhamento de tela e link público

Isso é LiveKit, não RustDesk. Serve para o grupo ver a tela na sala — e, se quiser, para gente de fora assistir sem conta.

### Na sala

1. Entre num canal de **voz** ou **tela**.
2. **Compartilhar tela** abre o assistente: título, resolução (fonte / 480 / 720 / 1080), FPS (15 / 30 / 60), bitrate fixo ou automático, áudio da tela (desligado, só da janela, ou sistema).
3. No desktop o padrão é **só vídeo** (a call de voz fica estável). Áudio do jogo ou de um app usa loopback WASAPI; escolha uma **janela**, não o ecrã inteiro, no modo “só da janela”.
4. No Chrome/Edge marque “Compartilhar áudio” no seletor do navegador se quiser som da aba.
5. Quem está na sala vê o palco, pode focar em tela cheia e ajustar volume por pessoa.
6. **Parar transmissão** encerra a sessão. Outra live do mesmo usuário substitui a anterior.

Permissão: `live.go_live` (o cargo `@everyone` pode ter isso ou não; o dono decide).

### Link público (`/assistir/:slug`)

No mesmo assistente, em **Link público (sem login)**:

- Gerar link para qualquer pessoa assistir
- Limite de espectadores (1–500; o padrão é 50). Extra recebe `watch_full`
- Convidados podem escolher o nome
- Chat na página pública (só ver, ou também escrever)

O endereço fica `https://seu-dominio/assistir/<slug>`. Quem tem o link entra como convidado: vê a tela compartilhada e, se você ligou, o chat. Não precisa de conta. A contagem de espectadores é real.

Twitch e YouTube no assistente ainda são placeholders — retransmissão RTMP não está nesta versão.

LiveKit precisa estar no `.env` (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`). Sem isso a comunidade sobe; voz, tela e o link público não.

## Acesso remoto (RustDesk)

Acesso ao **PC** do membro (rato e teclado), não à tela da call. Roda no app desktop, com um RustDesk **self-hosted** (hbbs/hbbr) da sua instalação. Não use o servidor público da RustDesk: o ID e o tráfego ficariam fora da sua VPS.

### O que o membro vê

Dois sentidos, a partir do cartão de outro membro (quem pede precisa de **premium** ou ser super admin; os dois têm de ser do mesmo servidor):

- **Controlar o PC dele** — o outro aceita e você entra na máquina dele
- **Pedir que ele ajude no seu PC** — você é o anfitrião; o outro controla

O pedido aparece no desktop do alvo, com contagem (~60 s). Só avança se aceitar. Dá para encerrar a qualquer momento. Sessão ativa dura até 2 h. Uma sessão por pessoa de cada vez.

Os dois PCs precisam do **app desktop** desta comunidade. O agente registra o ID RustDesk e manda heartbeat; a lista de membros mostra quem está online para remoto.

### Servidor RustDesk

Na VPS (ou na sua rede): hbbs (ID) + hbbr (relay). No `.env` da API:

```
RUSTDESK_ID_SERVER=seudominio
RUSTDESK_RELAY_SERVER=seudominio
RUSTDESK_KEY=chave-publica-do-hbbs
# opcional, para a API confirmar que o ID existe no hbbs:
# RUSTDESK_DB_PATH=/opt/rustdesk/data/db_v2.sqlite3
```

O desktop lê `/api/remote/config`, grava ID Server + chave no RustDesk local (pode pedir UAC uma vez) e **não** aponta para o servidor público da RustDesk. Há um script de instalação em `deploy/install_rustdesk.sh`.

A senha da sessão é gerada no host e não aparece para outros membros. Sem `RUSTDESK_*` no `.env`, o pedido de remoto falha de propósito.

## WhatsApp

O hub da comunidade fala com um gateway Node em `whatsapp/gateway.mjs`. Esse processo é o único que abre sessão no WhatsApp Web.

Biblioteca: **[zapo-js](https://github.com/vinikjkkj/zapo)** (WhatsApp Web em TypeScript), de [vinikjkkj](https://github.com/vinikjkkj). Persistência das sessões: **[@zapo-js/store-postgres](https://www.npmjs.com/package/@zapo-js/store-postgres)** (tabelas com prefixo `zapo_`). Utilitários de mídia: `@zapo-js/media-utils`.

O OpenGuild não é o zapo-js. Nós só o usamos. Créditos e licença da biblioteca ficam com o autor; veja o repositório deles antes de redistribuir.

### Como encaixa

1. A API Nest (`/api/community/wa/*`) autentica o usuário da comunidade (JWT).
2. Ela chama o gateway em `127.0.0.1` com o cabeçalho `X-Zapo-Secret`.
3. O gateway mantém várias sessões (`user-{id}-1`, `user-{id}-2`, …), QR, código de pareamento e eventos (`auth_qr`, `auth_paired`, `connection`, `message`).
4. O front (`apps/web/src/components/wa/`) desenha chats, mídia e áudio.

Variáveis: `ZAPO_PORT` (padrão 8788), `ZAPO_GATEWAY_SECRET`, `ZAPO_DATABASE_URL`. Sem a URL, o gateway tenta `DATABASE_URL`. Em produção o gateway **não** deve escutar na internet — só no localhost, atrás da API.

WhatsApp é conta pessoal. Quem forkar o projeto precisa seguir os termos do WhatsApp e da biblioteca. Sessões, QR e o banco `zapo_*` são dados sensíveis: não vão para o Git.

## App desktop

Pasta `apps/desktop`. Versão atual do pacote: **1.2.43**. O `appId` do instalador Windows é `app.openguild.desktop`.

O `.exe` instalado carrega a UI remota (`SF_COMMUNITY_URL`, padrão o domínio da sua VPS). Por isso um `git pull` + update na VPS muda temas, YouTube, trocas e comunidade sem gerar outro instalador. O remoto e o host de CS2 ficam no processo Electron.

```powershell
# gerar o instalador Windows
npm run dist:desktop

# enviar o feed para a VPS (latest.yml + .exe + .blockmap)
$env:SF_DEPLOY_PASS = 'senha-root'
python deploy/upload_desktop_and_wa.py
```

| Variável | Efeito |
|----------|--------|
| `SF_COMMUNITY_URL` | Site que o app abre |
| `SF_DESKTOP_UPDATE_URL` | Feed do updater (padrão `{URL}/desktop/`) |

Fechar a janela com “minimizar para a bandeja” mantém a voz. Sair de verdade tira da sala e marca presença offline.

## Partidas CS2

Modo **no PC do host**: o dedicated roda na máquina de quem criou a sala. Não é um servidor na VPS e não é VPN.

1. Host no Electron, com CS2 instalado, cria a sala no canal de partidas.
2. Cola um GSLT do App ID **730** em [Steam Game Server Accounts](https://steamcommunity.com/dev/managegameservers).
3. O grupo veta o mapa.
4. O desktop sobe `cs2.exe -dedicated` numa UDP livre (27015–27030), com `sv_lan 0`.
5. UPnP (se o roteador deixar) e descoberta do IPv4 público.
6. Host entra em `steam://connect/127.0.0.1:<porta>`.
7. Amigos entram em `steam://connect/<IPv4-público>:<porta>`.

Se o ISP usar CGNAT, UPnP não chega. Aí só VPN real (Tailscale, ZeroTier) ou um dedicated com IP público.

Os match packs (`match-packs/`) são DLLs + manifesto. A API publica em `/api/match-packs`. Sons de kill e atribuição de time entram por esses packs.

## Operação

| Sintoma | Causa comum | O que fazer |
|---------|-------------|-------------|
| Login / API 500 `P2022` | Coluna React ausente | Rodar `deploy/add_react_columns.sql` |
| `prisma db push` quer apagar `zapo_*` | Update com banco compartilhado | Abortar; use `REUSE_STEAMFARM_DB=1` |
| Upload 500 | Usuário do serviço sem escrita em `uploads/` | Conferir dono e permissão da pasta |
| Sem voz / sem tela / link público 404 | LiveKit vazio no `.env` | Preencher `LIVEKIT_*` e reiniciar o serviço |
| Troca recusada com `inventory_unavailable` | Inventário Steam privado | Inventário público nos dois lados + Trade URL |
| Remoto não abre | Sem RustDesk self-hosted ou sem desktop | `RUSTDESK_ID_SERVER` + `RUSTDESK_KEY`; os dois no app desktop; quem pede precisa de premium |
| Pedido remoto some | Expirou ou outra sessão ativa | Aceitar em ~60 s; uma sessão por pessoa |
| WhatsApp não conecta | Gateway parado ou segredo diferente | `ZAPO_GATEWAY_SECRET` igual na API e no gateway |
| Electron sem update | `/desktop/latest.yml` ausente | Gerar o build e enviar o feed |
| CS2 “AppID inválido” | Sem GSLT ou endereço errado | Token App 730; amigos no `WAN:2701x` |
| Amigos não entram | NAT / CGNAT / firewall | Encaminhar UDP ou usar VPN |

```bash
journalctl -u steamfarm-react -n 100 --no-pager
```

## Contribuindo

O OpenGuild é open source e aceita gente de fora. Vale **código**, **fork**, **issue**, **tradução**, **tema**, **documentação** e **teste em VPS diferente da nossa**.

1. Faça um fork e uma branch (`feat/nome-curto` ou `fix/nome-curto`).
2. Rode localmente com um banco vazio — não aponte o Prisma para produção.
3. Não commite `.env`, dumps, sessões de WhatsApp, `uploads/` nem instaladores `.exe`.
4. Mantenha o isolamento: um PR do OpenGuild não deve reiniciar nem reescrever o Nginx de outro sistema.
5. Abra o pull request descrevendo o que muda e como testou.

Ideias boas para começar: temas, acessibilidade, i18n, testes da API, empacotar o desktop para outro SO, documentar LiveKit do zero, separar de vez os nomes internos `steamfarm-*`.

Dúvida ou bug: abra uma issue com sistema operacional, Node, se é dev ou VPS, e o trecho de log (sem senha, cookie ou QR).

Código de conduta implícito: respeito no tracker e nos PRs. Assédio ou doxxing não entram.

## Licença e créditos

O OpenGuild é licenciado sob a **[GNU Affero General Public License v3.0](LICENSE)** (AGPL-3.0-or-later). O aviso de copyright está em [`COPYRIGHT`](COPYRIGHT).

Isso significa, em linguagem simples:

- Pode usar, estudar, modificar e **vender** (hospedagem, suporte, instalação, temas).
- Se distribuir o programa ou uma versão modificada, o código-fonte dessa versão também tem de ir junto, na mesma licença.
- Se **subir uma versão modificada numa VPS ou na nuvem** para outras pessoas usarem, essas pessoas têm o direito de receber o código dessa versão (cláusula 13 da AGPL). Um link “Código-fonte” no site resolve.
- Não pode fechar o OpenGuild e vender só o binário. Pode vender o serviço, desde que o código continue aberto.

Bibliotecas de terceiros (LiveKit, zapo-js, Electron, etc.) continuam nas licenças delas. CS2 e Steam são da Valve; Discord e WhatsApp não são deste projeto.

### Créditos

- Comunidade, voz, desktop e partidas: este repositório
- **WhatsApp Web:** [zapo-js](https://github.com/vinikjkkj/zapo) e o ecossistema `@zapo-js/*`, por [vinikjkkj](https://github.com/vinikjkkj)
- **Voz:** [LiveKit](https://livekit.io/)
- **Filtros de ruído:** Krisp (`@livekit/krisp-noise-filter`), DeepFilterNet, RNNoise, DTLN
- Ícones: [Lucide](https://lucide.dev/)
- CS2 e Steam são marcas da Valve. Este projeto não é afiliado à Valve, à Discord nem ao WhatsApp.

Issues e PRs são bem-vindos. Forks também: o objetivo do OpenGuild é que cada um possa subir a própria comunidade.
