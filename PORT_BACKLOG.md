# SteamFarm Python → React — backlog de port

Electron (SteamFarm Comunidade) fica **só comunidade** apontando para `https://chat.example.com`.
O web React absorve o restante do ASF Flask (`vps.example.com`) no mesmo Postgres `steamfarm`.

## Princípios

- Strangler: Flask continua farm/bots até cada módulo migrar.
- Contratos JSON `{ ok, error }` e mesmas tabelas quando possível.
- Cada módulo: Prisma → Nest → SPA → smoke local → deploy React (sem tocar Flask salvo deprecações).

## Prioridades

| Prio | Área | Estado | Entrega |
|------|------|--------|---------|
| **P0** | Contas Steam / bots / farm ASF | missing | API Nest + UI contas, idle, cards, Guard (`bot.py`, `manager.py`, `cards.py`) |
| **P1** | CS2 inventário / preços / histórico + trade offers bot | partial | Completar além de OpenID/vitrine/trades comunidade |
| **P2** | Partidas CS2 (fila/veto/RCON) | missing | Port `matches/*` |
| **P3** | Auth recover, signup WA, personificar | missing | Paridade Flask (`signup.py`, recover) |
| **P4** | Admin: desktop upload, game-servers, avisos/billing | partial | Painéis React |
| **P5** | WA ops/admin groups | partial | Hub comunidade já OK; falta ops `/whatsapp` |

## Já no React

- Auth JWT (login/register/setup/captcha), comunidade (servers/channels/DM/roles/voice), WhatsApp hub, Steam OpenID/vitrine/trades comunidade, desktop Electron thin-client.
