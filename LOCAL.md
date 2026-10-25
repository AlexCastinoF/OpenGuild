# SteamFarmReact — desenvolvimento local

## Bancos (Postgres Windows `H:\PostGreSQL`)

| DB | Uso |
|----|-----|
| `steamfarm_prod_ref` | Dump produção ASF — **referência** |
| `steamfarm_react` | App Prisma (**já populado**) |

Dump: `H:\cs2teste\_db_dumps\steamfarm_prod.dump`

### Re-migrar dump → app
```powershell
cd H:\cs2teste\SteamFarmReact
python scripts/migrate_from_prod_ref.py
```

## Subir

```powershell
cd H:\cs2teste\SteamFarmReact
npm run dev
```

Em outro terminal (hub WhatsApp da Comunidade):

```powershell
npm run dev:wa
```

- Web: http://127.0.0.1:5174  
- API: http://127.0.0.1:8014  
- Zapo gateway: http://127.0.0.1:8788  

Login com os **mesmos usuários/senhas** da Comunidade ASF (hash Werkzeug → bcrypt no 1º login).  
Há 2 usuários `super_admin`.

## Dados migrados (última run)

15 users · 4 servers · 19 channels · 17 members · 16 roles · 19 invites · 5 DMs · 91 live sessions · **3 trades** · **5 WA sessions** · **14 user_whatsapp** · campos Steam/`showcase_items` nos users

## Steam / trocas (local)

Na comunidade (userbar): ícone **link** = conectar Steam + vitrine; **setas** = minhas trocas.  
Perfil → aba **Steam** → “Conectar / vitrine”. Perfil de membro → **Propor troca**.

`PUBLIC_BASE_URL=http://127.0.0.1:5174` (OpenID callback via proxy Vite `/steam`).

## WhatsApp hub (Comunidade)

- API Nest: `/api/community/wa/*` (JWT) → gateway com `X-Zapo-Secret`
- Metadados de slot: `user_wa_sessions` em `steamfarm_react`
- Sessões Baileys (`zapo_*`): ficam em `steamfarm_prod_ref` via `ZAPO_DATABASE_URL`
- Telefone no perfil (aba Conta): `/api/community/me/whatsapp`
- Env: `ZAPO_PORT`, `ZAPO_GATEWAY_SECRET`, `ZAPO_DATABASE_URL` no `.env`

Fora do escopo ainda: painel admin `/whatsapp` de alertas de farm, Guard inbound, partidas CS2.

- **Sem deploy VPS** nesta fase  
- Produção só via `pg_dump` (`scripts/dump_prod_db.py`)

## LiveKit

Preencha `LIVEKIT_*` no `.env` se for testar voz. Prefixos: `sfr-*`.
