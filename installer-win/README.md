# Central de Deploy (Windows → VPS)

Um assistente único para os sistemas da VPS Castino. Na entrada você escolhe o sistema e informa o acesso SSH. Depois usa as três abas:

| Aba | O que faz |
|-----|-----------|
| **Servidor** | Instala do zero ou atualiza o código na VPS pelo `deploy/remote-bootstrap.sh` do próprio sistema. **Verificar serviço** mostra o `systemctl` e a versão do feed desktop. |
| **App desktop** | Troca a versão no `apps/desktop/package.json`, roda `npm run dist:publish`, envia o instalador por SFTP e (opcional) publica como padrão. |
| **Versões na VPS** | Lista os instaladores guardados na VPS, define qual é o padrão (rollback), exclui versões e limpa as antigas mantendo as N mais novas. |

## Abrir

Na raiz do repositório:

```bat
INSTALLAR.cmd
```

Ou:

```bat
cd installer-win
pip install -r requirements.txt
python install_gui.py
```

## Sistemas

Os projetos são procurados ao lado deste repositório (a pasta pode ser trocada na tela inicial, por sistema ou para todos).

| Sistema | Pasta local | Na VPS | Porta | App desktop |
|---|---|---|---|---|
| SteamFarm Comunidade | `SteamFarmReact` | `/opt/steamfarm-react` | 5071 | sim (`chat.example.com/desktop/`) |
| WOULZ Meeting React | `WoulzMeetingReact` | `/opt/woulzmeeting-react` | 5070 | sim (`meet.example.com/desktop/`) |
| SteamFarm (Flask) | `archi-steam-farm-py` | `/opt/steamfarm` | 5050 | — |
| WOULZ Meeting (Flask) | `WoulzMeeting` | `/opt/woulzmeeting` | 5060 | — |
| VPS Control Panel | `VpsControlPanel` | `/opt/vps-control` | 5080 | — |
| SoundPulse | `App de musica` (ou `H:\App de musica`) | `/opt/soundpulse` | 5090 | — |
| RH WhatsApp | `RHWhatsAppPlan` (ou `H:\RHWhatsAppPlan`) | `/opt/rhwhatsapp` | 5110 | — |

O SoundPulse não tem app desktop. A porta 5090 escuta só em localhost; o público entra pelo Nginx do domínio `midia.example.com`. O bootstrap não cria Postgres, não mexe em Redis/LiveKit e só grava o site Nginx `soundpulse`. `data/` e `uploads/` ficam de fora do pacote e da atualização.

O RH WhatsApp também não tem app desktop. A porta 5110 escuta só em localhost; o público entra pelo Nginx do domínio `rh.example.com`. O Postgres é o embutido do próprio sistema, em `127.0.0.1:54329`, dentro de `data/`. O bootstrap não cria banco no Postgres da VPS, não mexe em Redis/LiveKit e só grava o site Nginx `rhwhatsapp`. `data/`, `uploads/` e `auth_data/` ficam de fora do pacote e da atualização.

Os perfis (excludes do pacote, variáveis do bootstrap, pastas do feed) ficam em `deploy_core.py` → `PROFILES`.

## Estado da VPS

Ao clicar em **Conectar** (e depois de cada operação), a Central roda um script só de leitura na VPS e mostra:

- Por sistema, nos cards: se está instalado, se o serviço está no ar e há quanto tempo, se a porta local responde, RAM, reinícios automáticos, domínio (`PUBLIC_URL` do `.env`), versão do app desktop no feed e o último deploy.
- Da VPS: sistema operacional, tempo ligada, carga, RAM, disco livre, serviços de infraestrutura (Nginx, Postgres, Redis, LiveKit, gateway WA, RustDesk) e outras pastas em `/opt` que a Central não gerencia.

Cada operação da Central grava uma linha em `/var/lib/central-deploy/history.jsonl` na VPS: data, sistema, ação, commit, branch, se havia alteração não commitada, versão e quem fez. A aba **Servidor** mostra as últimas 10 do sistema. Deploys feitos antes da Central (ou por outros scripts) não têm registro; para eles aparece a data estimada pela última gravação de arquivo de código na pasta.

## Atualizar código

Preserva `.env`, banco, Nginx, SSL e a pasta `/desktop` como os bootstraps já faziam. No SteamFarm Comunidade o update envia `REUSE_STEAMFARM_DB=1` para **não** rodar `prisma db push` no Postgres compartilhado. O VPS Control Panel reescreve o próprio Nginx no update, por isso pede domínio e e-mail também nesse modo.

## App desktop

1. **Nova versão**: sugere a próxima correção a partir do `package.json`. Os botões `+ correção / + recurso / + maior` sobem o número.
2. **Gerar e publicar**: grava a versão no `package.json`, roda o build e confere que `desktop-releases/latest.yml` saiu na versão pedida. Se o build falhar, o `package.json` volta para a versão anterior.
3. **Envio**: sobe `.exe` e `.blockmap` como `.part` e só renomeia no fim, então nenhum cliente baixa arquivo pela metade. Os espelhos (ex.: `/opt/steamfarm/asf_py/static/desktop`) recebem cópia na própria VPS.
4. **Publicar como padrão**: o `latest.yml` é gerado na VPS e o hash SHA-512 é conferido contra o do build local.

Desligando **Publicar como padrão**, o instalador fica na VPS como beta e pode ser promovido depois.

**Só enviar o último build** reaproveita o que já está em `desktop-releases/` (útil quando o build passou mas o envio falhou).

O `package.json` alterado não é commitado. Faça o commit depois de conferir a versão.

## Versões na VPS e rollback

- **★ Padrão** gera um `latest.yml` novo para aquela versão em todas as pastas servidas. Guarda backup do anterior (`latest.yml.bak-*`, os 5 últimos) e atualiza a pasta `desktop-releases/` da VPS quando ela tem um `latest.yml` (senão o próximo deploy traria o feed antigo de volta).
- **Excluir / Limpar antigas** apaga `.exe` e `.blockmap` de todas as pastas do feed. A versão padrão nunca é apagada.
- **Limite do rollback**: o app não usa `allowDowngrade`. Voltar o padrão para uma versão anterior vale para instalações novas e para quem está abaixo dela; quem já pegou a versão ruim continua nela até sair uma correção com número maior.

## Segurança

- A senha SSH fica só na memória. Host, usuário e porta vão para `%APPDATA%\CentralDeploy\config.json`.
- Na primeira conexão com um servidor aparece a impressão digital da chave SSH para confirmar. Ela fica em `%APPDATA%\CentralDeploy\known_hosts`. Se a chave mudar depois, a conexão é recusada.
- A senha pode vir de `SF_DEPLOY_PASS` (ou `WM_DEPLOY_PASS`) no ambiente ou de `~/.steamfarm-deploy.env`.

## Gerar o .exe

```bat
cd installer-win
build.bat
```

Saída: `installer-win\dist\Central-de-Deploy.exe`. O `.exe` lê o código das pastas dos projetos, então precisa rodar numa máquina que tenha os repositórios.
