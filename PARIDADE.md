# Plano de paridade SteamFarm Comunidade

Escopo: portar **tudo do MVP de escritório** do Flask (`SteamFarmMeeting`) para `SteamFarmMeetingReact`.
Fora: WhatsApp, CS2/Steam, Twitch/YouTube live wizard, Electron completo (fase depois).

## Ordem de execução

### P1 — Dia a dia
1. Criar / editar / excluir canais (dialogs + botões)
2. Reordenar canais (API + UI)
3. Configurações do servidor (nome, desc, listed, icon/banner)
4. Editar perfil (display name, ramal, avatar, senha)
5. Dialog de convite (criar + copiar URL)
6. Excluir mensagem no chat
7. Upload de mídia (Nest `POST /api/community/media` + static)

### P2 — Comunidade
8. DMs (listar, enviar, unread badge)
9. Join requests (pedir / aprovar / negar)
10. Discover com pedir entrada
11. Roles CRUD + assign + permissions
12. Kick membro + menu no card

### P3 — Voz / tela
13. Presence real por canal (identities LiveKit ou heartbeat voice)
14. Stage tiles (avatar, speaking, mute)
15. Share screen + leave/mute/deafen
16. Voice float bar + permanecer em voz ao mudar canal texto
17. Seletor de dispositivos de áudio

### P4 — Admin
18. Admin servers + channels (super)
19. Polish PABX desk (já parcial)

### P5 — Depois
20. Electron `sfDesktop`, captura com áudio, updater

## Status (sessão atual)

**Feito:**
- Canais criar/excluir/reordenar (setas), server settings + upload
- Perfil, convite dialog, excluir mensagem, media upload
- DMs no layout `is-dm-hub` (lista na sidebar + chat principal), discover com cards + pedido de entrada
- Cargos UI completa (CRUD + permissões + atribuir) dentro de Configurações do servidor
- Presence por canal, share screen wizard (resolução/FPS/áudio), focus/fullscreen, tiles S/M/L
- Áudio: mic/speaker picker + aba Notificações, noiseSuppression toggle, deafen, float bar
- Modais nativos (`showModal` + `::backdrop`) alinhados ao Flask: criar/entrar, canal, settings, perfil, share, requests, perfil do membro
- Electron `@steamfarm/desktop` com `sfDesktop` preload + displayMedia loopback
- Admin PABX/servers/channels/pedidos

**Opcional / refinamento futuro:**
- DeepFilterNet neural no Electron (toggle áudio; browser continua com `noiseSuppression`)
- Drag-and-drop visual de canais (hoje setas)
- Captação game-audio PCM chunked igual ao desktop legado
- Public watch / live wizard Twitch-YouTube (fora do escopo MVP escritório)
- Steam / CS2 / WhatsApp (fora do escopo)
