# Partidas CS2 — mock (canal no servidor)

**Ideia:** Partidas não é um item no rail (misturado com servers). É um **canal do servidor**, na lista à esquerda, na secção **Competitivo**, abaixo de Texto e Voz.

```
Rail          Sidebar do server           Main
[DM]          Castino Scrims
[WA]          TEXTO
[C] server ←  # geral
[A]           # avisos
              VOZ
              ◎ Lobby
              ◎ Scrim
              COMPETITIVO
              ▶ Partidas ──────────────► Hub / Lobby / Ao vivo / Host / Histórico
```

## Avaliar

1. Entra em **#geral** ou **Lobby** (voz) — fluxo normal do Discord.
2. Clica **Partidas** na sidebar — tabs Início · Lobby · Ao vivo · Host · Histórico.
3. Compara: rail só tem servers; Partidas só aparece **dentro** do server.

## Abrir

http://127.0.0.1:4173

```bash
cd prototypes/cs2-private-match
npx --yes serve -l 4173
```
