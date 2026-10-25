using System.Globalization;
using System.Text;
using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;

namespace SfAssignTeams;

public class SfAssignTeamsPlugin : BasePlugin
{
    public override string ModuleName => "SteamFarm Assign Teams";
    public override string ModuleVersion => "1.3.11";
    public override string ModuleAuthor => "SteamFarm";
    public override string ModuleDescription =>
        "Assigns CT/T + cvars + dinheiro extra (wizard = total, plugin = diferença vs padrão CS2)";

    // Padrões do competitive CS2 (o jogo já paga isto; o wizard pede o TOTAL desejado)
    private const int DefaultKillCash = 300;
    private const int DefaultWinCash = 4000;
    private const int DefaultLoseCash = 1400;

    private readonly object _gate = new();
    private List<RosterEntry> _roster = [];
    private AdminSettings _admin = new();
    private int _lastRosterLogCount = -1;
    private readonly HashSet<ulong> _welcomedSteam = [];
    private float _lastAdminApplyAt;
    private long _lastCmdSeq = -1;
    /// <summary>0 = 1.ª metade (roster); ímpar = lados invertidos após half/OT.</summary>
    private int _sideSwapParity;
    /// <summary>Durante intermission/half, não forçar SwitchTeam contra o motor.</summary>
    private float _assignQuietUntil;
    /// <summary>Evita mp_warmup_start repetido (reinicia o timer → aquecimento infinito).</summary>
    private bool _warmupBootstrapped;
    private float _lastBotAddAt;

    private string RosterPath => ResolveCfgFile("sf_pm_teams.json") ??
        Path.Combine(Server.GameDirectory, "csgo", "cfg", "sf_pm_teams.json");

    private string AdminPath => ResolveCfgFile("sf_pm_admin.json") ??
        Path.Combine(Server.GameDirectory, "csgo", "cfg", "sf_pm_admin.json");

    private string CmdPath => ResolveCfgFile("sf_pm_cmd.json") ??
        Path.Combine(Server.GameDirectory, "csgo", "cfg", "sf_pm_cmd.json");

    private string CmdAckPath
    {
        get
        {
            var cmd = CmdPath;
            var dir = Path.GetDirectoryName(cmd) ?? Path.Combine(Server.GameDirectory, "csgo", "cfg");
            return Path.Combine(dir, "sf_pm_cmd_ack.json");
        }
    }

    private static string? ResolveCfgFile(string fileName)
    {
        var root = Server.GameDirectory;
        var candidates = new[]
        {
            Path.Combine(root, "csgo", "cfg", fileName),
            Path.Combine(root, "cfg", fileName),
            Path.Combine(root, "..", "csgo", "cfg", fileName),
        };
        foreach (var p in candidates)
        {
            try
            {
                var full = Path.GetFullPath(p);
                if (File.Exists(full)) return full;
            }
            catch
            {
                /* ignore */
            }
        }
        return null;
    }

    public override void Load(bool hotReload)
    {
        ReloadRoster();
        ReloadAdmin();
        Server.PrintToConsole($"[SfAssignTeams] loaded v{ModuleVersion} roster={RosterPath}");
        Server.PrintToConsole($"[SfAssignTeams] admin={AdminPath}");
        RegisterListener<Listeners.OnMapStart>(_ =>
        {
            lock (_gate)
            {
                _welcomedSteam.Clear();
            }
            _sideSwapParity = 0;
            _assignQuietUntil = 0;
            _warmupBootstrapped = false;
            _lastBotAddAt = 0;
            ReloadRoster();
            ReloadAdmin();
            Server.PrintToConsole($"[SfAssignTeams] map start · players={_roster.Count} parity=0");
            AddTimer(1.0f, () => ApplyAdmin("map:1s", forceWarmup: true));
            AddTimer(3.0f, () => ApplyAdmin("map:3s", forceWarmup: false));
            AddTimer(6.0f, () => ApplyAdmin("map:6s", forceWarmup: false));
        });
        RegisterListener<Listeners.OnClientPutInServer>(OnPutInServer);
        RegisterEventHandler<EventPlayerConnectFull>(OnConnectFull);
        RegisterEventHandler<EventPlayerTeam>(OnPlayerTeam);
        RegisterEventHandler<EventPlayerSpawn>(OnPlayerSpawn);
        RegisterEventHandler<EventRoundStart>(OnRoundStart);
        RegisterEventHandler<EventPlayerDeath>(OnPlayerDeath);
        RegisterEventHandler<EventRoundEnd>(OnRoundEnd);
        AddTimer(1.5f, () =>
        {
            ReloadRoster();
            MaybeBumpParityFromScores("timer");
            if (IsAssignQuiet()) return;
            foreach (var player in Utilities.GetPlayers())
                AssignNow(player, "timer");
        }, TimerFlags.REPEAT);
        AddTimer(5.0f, () =>
        {
            ReloadAdmin();
            if (Server.CurrentTime - _lastAdminApplyAt > 10f)
                ApplyAdmin("tick", forceWarmup: false);
            EnsureBots("tick");
        }, TimerFlags.REPEAT);
        AddTimer(0.35f, DrainCmdQueue, TimerFlags.REPEAT);
        Server.PrintToConsole($"[SfAssignTeams] cmd queue={CmdPath}");
    }

    private void DrainCmdQueue()
    {
        try
        {
            var path = CmdPath;
            if (path is null) return;
            if (!File.Exists(path)) return;
            string json;
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new StreamReader(fs))
                json = reader.ReadToEnd();
            if (string.IsNullOrWhiteSpace(json)) return;
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var seq = root.TryGetProperty("seq", out var seqEl) ? seqEl.GetInt64() : 0L;
            if (seq == 0 || seq == _lastCmdSeq) return;
            _lastCmdSeq = seq;
            var cmds = new List<string>();
            if (root.TryGetProperty("cmds", out var arr) && arr.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in arr.EnumerateArray())
                {
                    var s = (item.GetString() ?? "").Trim();
                    if (s.Length > 0) cmds.Add(s);
                }
            }
            else if (root.TryGetProperty("cmd", out var one))
            {
                var s = (one.GetString() ?? "").Trim();
                if (s.Length > 0) cmds.Add(s);
            }

            var details = new List<string>();
            var ok = 0;
            var failed = 0;
            var reloadAdmin = false;
            foreach (var c in cmds)
            {
                if (c.Equals("sf_reload_admin", StringComparison.OrdinalIgnoreCase))
                {
                    reloadAdmin = true;
                    ok++;
                    details.Add("sf_reload_admin=queued");
                    continue;
                }

                var expanded = ExpandAliases(c);
                foreach (var line in expanded)
                {
                    var captured = line;
                    ApplyResult r;
                    if (captured.StartsWith("sf_set_money ", StringComparison.OrdinalIgnoreCase) ||
                        captured.StartsWith("sf_add_money ", StringComparison.OrdinalIgnoreCase) ||
                        captured.Equals("sf_dump_money", StringComparison.OrdinalIgnoreCase) ||
                        captured.StartsWith("sf_money_win", StringComparison.OrdinalIgnoreCase) ||
                        captured.StartsWith("sf_money_lose", StringComparison.OrdinalIgnoreCase))
                    {
                        r = HandleMoneyCommand(captured);
                    }
                    else
                    {
                        r = ApplyEngineLine(captured);
                    }
                    if (r.Ok) ok++;
                    else failed++;
                    details.Add($"{captured}=>{r.Detail}");
                    Server.PrintToConsole($"[SfAssignTeams] {(r.Ok ? "OK" : "FAIL")}: {captured} · {r.Detail}");
                }
            }

            if (reloadAdmin)
            {
                ReloadAdmin();
                ApplyAdmin("cmd_queue", forceWarmup: false);
            }

            WriteAck(seq, ok, failed, details);
        }
        catch (Exception ex)
        {
            Server.PrintToConsole($"[SfAssignTeams] cmd queue: {ex.Message}");
        }
    }

    private void WriteAck(long seq, int ok, int failed, List<string> details)
    {
        try
        {
            var sb = new StringBuilder();
            sb.Append("{\"seq\":").Append(seq)
                .Append(",\"ok\":").Append(ok)
                .Append(",\"failed\":").Append(failed)
                .Append(",\"at\":").Append(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
                .Append(",\"details\":[");
            for (var i = 0; i < details.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append('"').Append(EscapeJson(details[i])).Append('"');
            }
            sb.Append("]}");
            File.WriteAllText(CmdAckPath, sb.ToString());
        }
        catch
        {
            /* ignore */
        }
    }

    private static string EscapeJson(string s) =>
        s.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal);

    /// <summary>
    /// CS2 não tem cash_team_winner_bonus — expande para cvars reais de vitória.
    /// </summary>
    private static List<string> ExpandAliases(string raw)
    {
        var c = raw.Trim();
        if (c.Equals("sf_bot_ct", StringComparison.OrdinalIgnoreCase) ||
            c.Equals("bot_add_ct", StringComparison.OrdinalIgnoreCase))
        {
            return
            [
                "bot_stop 0",
                "bot_quota 10",
                "bot_quota_mode normal",
                "bot_join_after_player 0",
                "bot_auto_vacate 0",
                "bot_add_ct",
            ];
        }
        if (c.Equals("sf_bot_t", StringComparison.OrdinalIgnoreCase) ||
            c.Equals("bot_add_t", StringComparison.OrdinalIgnoreCase))
        {
            return
            [
                "bot_stop 0",
                "bot_quota 10",
                "bot_quota_mode normal",
                "bot_join_after_player 0",
                "bot_auto_vacate 0",
                "bot_add_t",
            ];
        }
        if (c.Equals("sf_bot_kick", StringComparison.OrdinalIgnoreCase) ||
            c.Equals("bot_kick", StringComparison.OrdinalIgnoreCase))
        {
            return ["bot_kick", "bot_quota 0"];
        }

        // cash_team_winner_bonus N → cvars de vitória CS2
        if (c.StartsWith("cash_team_winner_bonus ", StringComparison.OrdinalIgnoreCase))
        {
            var val = c["cash_team_winner_bonus ".Length..].Trim();
            return
            [
                $"cash_team_elimination_bomb_map {val}",
                $"cash_team_terrorist_win_bomb {val}",
                $"cash_team_win_by_defusing_bomb {val}",
                $"cash_team_win_by_time_running_out_bomb {val}",
                $"cash_team_elimination_hostage_map_ct {val}",
                $"cash_team_elimination_hostage_map_t {val}",
                $"cash_team_win_by_hostage_rescue {val}",
                $"cash_team_win_by_time_running_out_hostage {val}",
                "mp_teamcashawards 1",
                "mp_playercashawards 1",
            ];
        }

        // Dinheiro direto no controller (API CSS real — ConVar sozinha fica no teto 16k)
        if (c.StartsWith("sf_set_money ", StringComparison.OrdinalIgnoreCase) ||
            c.StartsWith("sf_add_money ", StringComparison.OrdinalIgnoreCase) ||
            c.Equals("sf_dump_money", StringComparison.OrdinalIgnoreCase) ||
            c.StartsWith("sf_money_win", StringComparison.OrdinalIgnoreCase) ||
            c.StartsWith("sf_money_lose", StringComparison.OrdinalIgnoreCase))
        {
            return [c];
        }

        return [c];
    }

    private ApplyResult HandleMoneyCommand(string line)
    {
        var trimmed = line.Trim();
        try
        {
            if (trimmed.Equals("sf_dump_money", StringComparison.OrdinalIgnoreCase))
            {
                var maxCv = ConVar.Find("mp_maxmoney");
                var startCv = ConVar.Find("mp_startmoney");
                var parts = new List<string>
                {
                    $"maxmoney={maxCv?.StringValue}",
                    $"startmoney={startCv?.StringValue}",
                };
                foreach (var p in Utilities.GetPlayers())
                {
                    if (p is null || !p.IsValid || p.IsBot || p.IsHLTV) continue;
                    var acc = p.InGameMoneyServices?.Account ?? -1;
                    parts.Add($"{p.PlayerName}:{acc}");
                }
                var detail = string.Join("|", parts);
                Server.PrintToConsole($"[SfAssignTeams] dump_money {detail}");
                return new ApplyResult(true, detail);
            }

            // Garante teto alto ANTES de mexer no Account
            ForceMaxMoneyCeiling(65000);

            if (trimmed.StartsWith("sf_set_money ", StringComparison.OrdinalIgnoreCase))
            {
                if (!int.TryParse(trimmed["sf_set_money ".Length..].Trim(), NumberStyles.Integer,
                        CultureInfo.InvariantCulture, out var amount))
                    return new ApplyResult(false, "bad_amount");
                var n = SetAllHumansMoney(amount, add: false);
                return new ApplyResult(n > 0, $"set={amount} players={n}");
            }

            if (trimmed.StartsWith("sf_add_money ", StringComparison.OrdinalIgnoreCase))
            {
                if (!int.TryParse(trimmed["sf_add_money ".Length..].Trim(), NumberStyles.Integer,
                        CultureInfo.InvariantCulture, out var delta))
                    return new ApplyResult(false, "bad_amount");
                var n = SetAllHumansMoney(delta, add: true);
                return new ApplyResult(n > 0, $"add={delta} players={n}");
            }

            if (trimmed.StartsWith("sf_money_win", StringComparison.OrdinalIgnoreCase))
            {
                var rest = trimmed.Length > "sf_money_win".Length
                    ? trimmed["sf_money_win".Length..].Trim()
                    : "";
                var bonus = 3250;
                if (rest.Length > 0 &&
                    int.TryParse(rest, NumberStyles.Integer, CultureInfo.InvariantCulture, out var w))
                    bonus = w;
                else if (GetAdminCash("cash_team_winner_bonus") is int aw)
                    bonus = aw;
                var n = SetAllHumansMoney(bonus, add: true);
                return new ApplyResult(n > 0, $"win+={bonus} players={n}");
            }

            if (trimmed.StartsWith("sf_money_lose", StringComparison.OrdinalIgnoreCase))
            {
                var rest = trimmed.Length > "sf_money_lose".Length
                    ? trimmed["sf_money_lose".Length..].Trim()
                    : "";
                var bonus = 1400;
                if (rest.Length > 0 &&
                    int.TryParse(rest, NumberStyles.Integer, CultureInfo.InvariantCulture, out var l))
                    bonus = l;
                else if (GetAdminCash("cash_team_loser_bonus") is int al)
                    bonus = al;
                var n = SetAllHumansMoney(bonus, add: true);
                return new ApplyResult(n > 0, $"lose+={bonus} players={n}");
            }

            return new ApplyResult(false, "unknown_money_cmd");
        }
        catch (Exception ex)
        {
            return new ApplyResult(false, ex.Message);
        }
    }

    private int? GetAdminCash(string key)
    {
        lock (_gate)
        {
            if (_admin.Cvars.TryGetValue(key, out var v)) return (int)v;
        }
        return null;
    }

    private static void ForceMaxMoneyCeiling(int floor)
    {
        var cv = ConVar.Find("mp_maxmoney");
        if (cv is null)
        {
            Server.ExecuteCommand($"mp_maxmoney {floor}");
            return;
        }
        try
        {
            if ((cv.Flags & ConVarFlags.FCVAR_CHEAT) != 0)
                cv.Flags &= ~ConVarFlags.FCVAR_CHEAT;
            var cur = 16000;
            _ = int.TryParse(cv.StringValue, NumberStyles.Integer, CultureInfo.InvariantCulture, out cur);
            var next = Math.Max(cur, floor);
            cv.SetValue(next);
            Server.ExecuteCommand($"mp_maxmoney {next}");
        }
        catch
        {
            Server.ExecuteCommand($"mp_maxmoney {floor}");
        }
    }

    private static int SetAllHumansMoney(int amountOrDelta, bool add)
    {
        var n = 0;
        foreach (var player in Utilities.GetPlayers())
        {
            if (SetPlayerMoney(player, amountOrDelta, add, chat: true)) n++;
        }
        return n;
    }

    private static bool SetPlayerMoney(CCSPlayerController? player, int amountOrDelta, bool add, bool chat)
    {
        if (player is null || !player.IsValid || player.IsBot || player.IsHLTV) return false;
        var svc = player.InGameMoneyServices;
        if (svc is null) return false;
        ForceMaxMoneyCeiling(65000);
        var next = add ? svc.Account + amountOrDelta : amountOrDelta;
        if (next < 0) next = 0;
        if (next > 100000) next = 100000;
        svc.Account = next;
        try
        {
            Utilities.SetStateChanged(player, "CCSPlayerController", "m_pInGameMoneyServices");
        }
        catch
        {
            /* ignore UI sync */
        }
        if (chat)
            player.PrintToChat($" {ChatColors.Green}[Sistema] Dinheiro: ${next}{ChatColors.Default}");
        Server.PrintToConsole($"[SfAssignTeams] money {player.PlayerName} => {next}");
        return true;
    }

    private HookResult OnPlayerDeath(EventPlayerDeath ev, GameEventInfo _info)
    {
        try
        {
            var attacker = ev.Attacker;
            var victim = ev.Userid;
            if (attacker is null || !attacker.IsValid || attacker.IsBot) return HookResult.Continue;
            if (victim is not null && attacker.Slot == victim.Slot) return HookResult.Continue;
            // Wizard = total desejado (ex. 500). Jogo já dá 300 → extra = 200
            var desired = GetAdminCash("cash_player_killed_enemy_default") ?? DefaultKillCash;
            var extra = Math.Max(0, desired - DefaultKillCash);
            if (extra <= 0) return HookResult.Continue;
            var slot = attacker.Slot;
            // Depois do prémio nativo do CS2
            AddTimer(0.05f, () =>
            {
                var p = Utilities.GetPlayerFromSlot(slot);
                if (p is null || !p.IsValid) return;
                ForceMaxMoneyCeiling(65000);
                if (SetPlayerMoney(p, extra, add: true, chat: false))
                {
                    p.PrintToChat(
                        $" {ChatColors.Gold}[Sistema] Dinheiro extra por kill: +${extra}{ChatColors.Default}");
                }
            });
        }
        catch (Exception ex)
        {
            Server.PrintToConsole($"[SfAssignTeams] death money: {ex.Message}");
        }
        return HookResult.Continue;
    }

    private HookResult OnRoundEnd(EventRoundEnd ev, GameEventInfo _info)
    {
        var winner = ev.Winner; // 2=T 3=CT
        // Half/OT: actualizar parity ANTES do motor trocar lados (senão AssignNow desfaz o swap)
        AddTimer(0.05f, () => MaybeBumpParityFromScores("round_end"));
        // Sobe o teto YA — senão o +$4000 nativo fica preso em 16k
        ForceMaxMoneyCeiling(65000);
        AddTimer(0.35f, () =>
        {
            try
            {
                var desiredWin = GetAdminCash("cash_team_winner_bonus") ?? DefaultWinCash;
                var desiredLose = GetAdminCash("cash_team_loser_bonus") ?? DefaultLoseCash;
                var afterRound = GetAdminCash("mp_afterroundmoney") ?? 0;
                var extraWin = Math.Max(0, desiredWin - DefaultWinCash);
                var extraLose = Math.Max(0, desiredLose - DefaultLoseCash);
                ForceMaxMoneyCeiling(65000);
                foreach (var p in Utilities.GetPlayers())
                {
                    if (p is null || !p.IsValid || p.IsBot || p.IsHLTV) continue;
                    var team = (int)p.Team;
                    if (team != 2 && team != 3) continue;
                    var isWin = team == winner;
                    var extra = (isWin ? extraWin : extraLose) + afterRound;
                    if (extra <= 0) continue;
                    if (SetPlayerMoney(p, extra, add: true, chat: false))
                    {
                        var label = isWin ? "vitória" : "derrota";
                        p.PrintToChat(
                            $" {ChatColors.Gold}[Sistema] Dinheiro extra por {label}: +${extra}{ChatColors.Default}");
                    }
                }
            }
            catch (Exception ex)
            {
                Server.PrintToConsole($"[SfAssignTeams] roundend money: {ex.Message}");
            }
        });
        return HookResult.Continue;
    }

    private readonly record struct ApplyResult(bool Ok, string Detail);

    /// <summary>
    /// Prefere ConVar.SetValue (fiável). ExecuteCommand sozinho acusa "ok" sem efeito.
    /// </summary>
    private static ApplyResult ApplyEngineLine(string line)
    {
        var trimmed = line.Trim();
        if (trimmed.Length == 0) return new ApplyResult(false, "empty");

        var sp = trimmed.IndexOf(' ');
        var name = sp < 0 ? trimmed : trimmed[..sp];
        var arg = sp < 0 ? "" : trimmed[(sp + 1)..].Trim();

        // Comandos (não ConVar)
        if (IsPureCommand(name))
        {
            try
            {
                Server.NextFrame(() =>
                {
                    try { Server.ExecuteCommand(trimmed); }
                    catch { /* ignore */ }
                });
                return new ApplyResult(true, "queued_cmd");
            }
            catch (Exception ex)
            {
                return new ApplyResult(false, ex.Message);
            }
        }

        var cv = ConVar.Find(name);
        if (cv is null)
        {
            // Pode ser comando desconhecido ou cvar ainda não registada
            try
            {
                Server.ExecuteCommand(trimmed);
                return new ApplyResult(true, "exec_no_convar");
            }
            catch (Exception ex)
            {
                return new ApplyResult(false, ex.Message);
            }
        }

        try
        {
            // Remove CHEAT se bloquear set
            if ((cv.Flags & ConVarFlags.FCVAR_CHEAT) != 0)
                cv.Flags &= ~ConVarFlags.FCVAR_CHEAT;

            if (arg.Length == 0)
            {
                Server.ExecuteCommand(name);
                return new ApplyResult(true, $"toggle/{cv.StringValue}");
            }

            SetConVarFromString(cv, arg);
            // Também IssueServerCommand para replicação / listeners
            Server.ExecuteCommand(trimmed);

            var now = cv.StringValue ?? "";
            var ok = ValuesRoughlyMatch(arg, now);
            return new ApplyResult(ok, ok ? $"set={now}" : $"verify_fail want={arg} got={now}");
        }
        catch (Exception ex)
        {
            try
            {
                Server.ExecuteCommand(trimmed);
                return new ApplyResult(true, $"exec_fallback:{ex.Message}");
            }
            catch (Exception ex2)
            {
                return new ApplyResult(false, ex2.Message);
            }
        }
    }

    private static bool IsPureCommand(string name)
    {
        return name.Equals("bot_add", StringComparison.OrdinalIgnoreCase)
            || name.Equals("bot_add_ct", StringComparison.OrdinalIgnoreCase)
            || name.Equals("bot_add_t", StringComparison.OrdinalIgnoreCase)
            || name.Equals("bot_kick", StringComparison.OrdinalIgnoreCase)
            || name.Equals("exec", StringComparison.OrdinalIgnoreCase)
            || name.Equals("mp_restartgame", StringComparison.OrdinalIgnoreCase)
            || name.Equals("mp_warmup_start", StringComparison.OrdinalIgnoreCase)
            || name.Equals("mp_warmup_end", StringComparison.OrdinalIgnoreCase)
            || name.Equals("changelevel", StringComparison.OrdinalIgnoreCase)
            || name.Equals("map", StringComparison.OrdinalIgnoreCase)
            || name.Equals("say", StringComparison.OrdinalIgnoreCase)
            || name.Equals("status", StringComparison.OrdinalIgnoreCase)
            || name.Equals("users", StringComparison.OrdinalIgnoreCase)
            || name.Equals("kickid", StringComparison.OrdinalIgnoreCase)
            || name.Equals("banid", StringComparison.OrdinalIgnoreCase)
            || name.Equals("host_workshop_map", StringComparison.OrdinalIgnoreCase);
    }

    private static void SetConVarFromString(ConVar cv, string arg)
    {
        var unquoted = arg.Trim().Trim('"');
        switch (cv.Type)
        {
            case ConVarType.Bool:
                cv.SetValue(unquoted is "1" or "true" or "yes" or "on");
                break;
            case ConVarType.Int16:
            case ConVarType.UInt16:
            case ConVarType.Int32:
            case ConVarType.UInt32:
            case ConVarType.Int64:
            case ConVarType.UInt64:
                if (long.TryParse(unquoted, NumberStyles.Integer, CultureInfo.InvariantCulture, out var li))
                    cv.SetValue((int)li);
                else if (float.TryParse(unquoted, NumberStyles.Float, CultureInfo.InvariantCulture, out var fi))
                    cv.SetValue((int)fi);
                else
                    cv.StringValue = unquoted;
                break;
            case ConVarType.Float32:
            case ConVarType.Float64:
                if (float.TryParse(unquoted, NumberStyles.Float, CultureInfo.InvariantCulture, out var f))
                    cv.SetValue(f);
                else
                    cv.StringValue = unquoted;
                break;
            default:
                cv.StringValue = unquoted;
                break;
        }
    }

    private static bool ValuesRoughlyMatch(string want, string got)
    {
        var a = want.Trim().Trim('"');
        var b = (got ?? "").Trim().Trim('"');
        if (string.Equals(a, b, StringComparison.OrdinalIgnoreCase)) return true;
        if (float.TryParse(a, NumberStyles.Float, CultureInfo.InvariantCulture, out var fa) &&
            float.TryParse(b, NumberStyles.Float, CultureInfo.InvariantCulture, out var fb))
            return Math.Abs(fa - fb) < 0.001f;
        // bool aliases
        if (a is "1" or "true" && b is "1" or "true" or "True") return true;
        if (a is "0" or "false" && b is "0" or "false" or "False") return true;
        return false;
    }

    private HookResult OnRoundStart(EventRoundStart _ev, GameEventInfo _info)
    {
        MaybeBumpParityFromScores("round_start");
        AddTimer(0.2f, () => ApplyAdmin("round_start", forceWarmup: false));
        return HookResult.Continue;
    }

    private bool IsAssignQuiet() => Server.CurrentTime < _assignQuietUntil;

    private static int ReadConVarInt(string name, int fallback)
    {
        try
        {
            var cv = ConVar.Find(name);
            if (cv is null) return fallback;
            var s = (cv.StringValue ?? "").Trim();
            if (int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n))
                return n;
        }
        catch
        {
            /* ignore */
        }
        return fallback;
    }

    private static int GetTeamScore(CsTeam team)
    {
        try
        {
            foreach (var ent in Utilities.FindAllEntitiesByDesignerName<CCSTeam>("cs_team_manager"))
            {
                if (ent is null || !ent.IsValid) continue;
                if (ent.TeamNum == (int)team) return ent.Score;
            }
        }
        catch
        {
            /* ignore */
        }
        return 0;
    }

    /// <summary>
    /// Quantos side-swaps o CS2 já deve ter feito (half + OT), alinhado ao placar actual.
    /// </summary>
    private int ExpectedSideSwapParity()
    {
        if (ReadConVarInt("mp_halftime", 1) == 0) return 0;
        var maxRounds = Math.Max(2, ReadConVarInt("mp_maxrounds", 24));
        var half = Math.Max(1, maxRounds / 2);
        var ct = GetTeamScore(CsTeam.CounterTerrorist);
        var t = GetTeamScore(CsTeam.Terrorist);
        var sum = ct + t;
        var swaps = sum >= half ? 1 : 0;
        if (ReadConVarInt("mp_overtime_enable", 1) != 0 && sum >= maxRounds)
        {
            var otMax = Math.Max(2, ReadConVarInt("mp_overtime_maxrounds", 6));
            var otHalf = Math.Max(1, otMax / 2);
            var otRounds = sum - maxRounds;
            // Entrada em OT = +1 swap; depois +1 a cada metade de OT
            swaps = 1 + 1 + (otRounds / otHalf);
        }
        return swaps;
    }

    private void MaybeBumpParityFromScores(string reason)
    {
        var expected = ExpectedSideSwapParity();
        if (expected <= _sideSwapParity) return;
        _sideSwapParity = expected;
        _assignQuietUntil = Server.CurrentTime + 25f;
        var ct = GetTeamScore(CsTeam.CounterTerrorist);
        var t = GetTeamScore(CsTeam.Terrorist);
        Server.PrintToConsole(
            $"[SfAssignTeams] side swap parity={_sideSwapParity} ({reason}) score={ct}:{t} quiet=25s");
    }

    private static CsTeam ApplySideParity(CsTeam team, int parity)
    {
        if (parity % 2 == 0) return team;
        if (team == CsTeam.CounterTerrorist) return CsTeam.Terrorist;
        if (team == CsTeam.Terrorist) return CsTeam.CounterTerrorist;
        return team;
    }

    private void OnPutInServer(int slot)
    {
        var player = Utilities.GetPlayerFromSlot(slot);
        if (player is null) return;
        AddTimer(0.25f, () => AssignNow(player, "putin:0.25"));
        AddTimer(0.8f, () => AssignNow(player, "putin:0.8"));
        AddTimer(2.0f, () => AssignNow(player, "putin:2.0"));
        AddTimer(1.5f, () => ShowWelcomeTo(player));
    }

    private HookResult OnConnectFull(EventPlayerConnectFull ev, GameEventInfo _info)
    {
        var player = ev.Userid;
        if (player is not null)
        {
            AddTimer(0.15f, () => AssignNow(player, "connectfull"));
            AddTimer(1.0f, () => AssignNow(player, "connectfull:1"));
            AddTimer(3.0f, () => AssignNow(player, "connectfull:3"));
            // Nunca mp_warmup_start no connect — reinicia o timer e trava em aquecimento infinito.
            AddTimer(0.5f, () => ApplyAdmin("connect", forceWarmup: false));
            AddTimer(2.0f, () => ShowWelcomeTo(player));
        }
        return HookResult.Continue;
    }

    private HookResult OnPlayerTeam(EventPlayerTeam ev, GameEventInfo _info)
    {
        var player = ev.Userid;
        if (player is null) return HookResult.Continue;
        // Half/OT do CS2: NUNCA reverter CT↔T. Só recoloca quem caiu em SPEC.
        var newTeam = (CsTeam)ev.Team;
        if (newTeam is CsTeam.CounterTerrorist or CsTeam.Terrorist)
        {
            // Observa troca em massa → actualiza parity (para SPEC reentrar no lado certo)
            MaybeObserveEngineSideSwap(player, newTeam);
            return HookResult.Continue;
        }
        Server.NextFrame(() => AssignNow(player, "team_event_spec"));
        return HookResult.Continue;
    }

    private HookResult OnPlayerSpawn(EventPlayerSpawn ev, GameEventInfo _info)
    {
        var player = ev.Userid;
        if (player is not null) AssignNow(player, "spawn");
        return HookResult.Continue;
    }

    /// <summary>True durante warmup — aí ainda forçamos CT/T do roster.</summary>
    private static bool IsWarmupPeriod()
    {
        try
        {
            foreach (var proxy in Utilities.FindAllEntitiesByDesignerName<CCSGameRulesProxy>("cs_gamerules"))
            {
                var rules = proxy?.GameRules;
                if (rules is not null) return rules.WarmupPeriod;
            }
        }
        catch
        {
            /* ignore */
        }
        return false;
    }

    /// <summary>
    /// Se o jogador passou para o lado invertido do roster, alinha parity
    /// (sem SwitchTeam — o motor já trocou).
    /// </summary>
    private void MaybeObserveEngineSideSwap(CCSPlayerController player, CsTeam newTeam)
    {
        var bas = WantedTeamBase(player);
        if (bas is null) return;
        if (bas.Value is not (CsTeam.CounterTerrorist or CsTeam.Terrorist)) return;
        var inverted = ApplySideParity(bas.Value, _sideSwapParity + 1);
        if (inverted != newTeam) return;
        if (ApplySideParity(bas.Value, _sideSwapParity) == newTeam) return;
        _sideSwapParity += 1;
        _assignQuietUntil = Server.CurrentTime + 25f;
        Server.PrintToConsole(
            $"[SfAssignTeams] observed engine side swap → parity={_sideSwapParity} ({player.PlayerName})");
    }

    private void ReloadAdmin()
    {
        try
        {
            var path = AdminPath;
            if (path is null || !File.Exists(path))
            {
                lock (_gate) _admin = new AdminSettings();
                return;
            }
            var json = File.ReadAllText(path);
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var cvars = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
            string welcome = "";
            string welcomeColor = "green";
            foreach (var prop in root.EnumerateObject())
            {
                var name = prop.Name;
                if (name.Equals("welcome_message", StringComparison.OrdinalIgnoreCase))
                {
                    welcome = (prop.Value.GetString() ?? "").Trim();
                    continue;
                }
                if (name.Equals("welcome_color", StringComparison.OrdinalIgnoreCase))
                {
                    welcomeColor = (prop.Value.GetString() ?? "green").Trim().ToLowerInvariant();
                    continue;
                }
                if (prop.Value.ValueKind == JsonValueKind.Number && prop.Value.TryGetSingle(out var f))
                    cvars[name] = f;
                else if (prop.Value.ValueKind == JsonValueKind.String &&
                         float.TryParse(prop.Value.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var fs))
                    cvars[name] = fs;
            }
            lock (_gate)
            {
                _admin = new AdminSettings
                {
                    Cvars = cvars,
                    Welcome = welcome,
                    WelcomeColor = welcomeColor,
                };
            }
        }
        catch (Exception ex)
        {
            Server.PrintToConsole($"[SfAssignTeams] admin error: {ex.Message}");
        }
    }

    private void ApplyAdmin(string reason, bool forceWarmup = false)
    {
        AdminSettings a;
        lock (_gate) a = _admin;
        if (!a.HasAny) return;

        _lastAdminApplyAt = Server.CurrentTime;
        var cmds = new List<string>();
        var cvars = a.Cvars;

        float? Get(string key) => cvars.TryGetValue(key, out var v) ? v : null;

        if (Get("mp_startmoney") is float sm)
        {
            cmds.Add($"mp_startmoney {Fmt(sm)}");
            var max = ResolveMaxMoney(sm, Get("mp_maxmoney"));
            cmds.Add($"mp_maxmoney {Fmt(max)}");
        }
        else if (Get("mp_maxmoney") is float onlyMax)
        {
            cmds.Add($"mp_maxmoney {Fmt(onlyMax)}");
        }
        else
        {
            // Sempre levanta o teto competitive 16k em partidas privadas
            cmds.Add("mp_maxmoney 65000");
        }

        if (Get("mp_roundtime") is float rt)
        {
            cmds.Add($"mp_roundtime {Fmt(rt)}");
            cmds.Add($"mp_roundtime_defuse {Fmt(rt)}");
            cmds.Add($"mp_roundtime_hostage {Fmt(rt)}");
        }

        var skip = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "mp_startmoney", "mp_maxmoney", "mp_roundtime", "mp_warmuptime", "restart",
            "cash_team_winner_bonus", // expandido abaixo
            "bot_quota", "bot_difficulty",
            // Experiências 1.3.6–1.3.10: travam o aquecimento em 1s e deixam o jogador morto.
            "mp_force_pick_time", "mp_force_assign_teams", "sv_human_autojoin_team",
            "mp_respawn_on_death_ct", "mp_respawn_on_death_t",
            "mp_respawnwavetime_ct", "mp_respawnwavetime_t",
        };
        var needCashAwards = false;
        foreach (var (key, val) in cvars)
        {
            if (skip.Contains(key)) continue;
            if (key.StartsWith("welcome_", StringComparison.OrdinalIgnoreCase)) continue;
            cmds.Add($"{key} {Fmt(val)}");
            if (key.StartsWith("cash_", StringComparison.OrdinalIgnoreCase) ||
                key.Equals("mp_afterroundmoney", StringComparison.OrdinalIgnoreCase))
                needCashAwards = true;
        }

        if (Get("cash_team_winner_bonus") is float winBonus)
        {
            foreach (var line in ExpandAliases($"cash_team_winner_bonus {Fmt(winBonus)}"))
                cmds.Add(line);
            needCashAwards = true;
        }

        if (needCashAwards)
        {
            // Mantém prémios nativos do CS2; o plugin só adiciona a diferença do wizard
            cmds.Add("mp_teamcashawards 1");
            cmds.Add("mp_playercashawards 1");
        }

        if (Get("mp_warmuptime") is float wt)
        {
            cmds.Add($"mp_warmuptime {Fmt(wt)}");
            if (wt > 0)
            {
                cmds.Add("mp_do_warmup_period 1");
                // mp_warmup_start reinicia o countdown — só uma vez por mapa (ou comando manual).
                if (forceWarmup && !_warmupBootstrapped && !IsWarmupPeriod())
                {
                    cmds.Add("mp_warmup_start");
                    _warmupBootstrapped = true;
                }
            }
            else
            {
                cmds.Add("mp_do_warmup_period 0");
                cmds.Add("mp_warmup_end");
            }
        }

        var botQuota = Get("bot_quota");
        if (botQuota is > 0)
        {
            var diff = Get("bot_difficulty") ?? 1f;
            cmds.Add("bot_stop 0");
            cmds.Add("bot_join_after_player 0");
            cmds.Add("bot_auto_vacate 0");
            cmds.Add("bot_quota_mode normal");
            cmds.Add($"bot_difficulty {Fmt(diff)}");
            cmds.Add($"custom_bot_difficulty {Fmt(diff)}");
            cmds.Add($"bot_quota {Fmt(botQuota.Value)}");
        }
        else if (botQuota is <= 0)
        {
            cmds.Add("bot_quota 0");
            cmds.Add("bot_kick");
        }

        var ok = 0;
        var fail = 0;
        foreach (var c in cmds.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var r = ApplyEngineLine(c);
            if (r.Ok) ok++;
            else fail++;
        }

        Server.PrintToConsole(
            $"[SfAssignTeams] admin apply ({reason}) ok={ok} fail={fail} freeze={Get("mp_freezetime")} round={Get("mp_roundtime")} max$={ConVar.Find("mp_maxmoney")?.StringValue}");

        // Teto sempre; NÃO resetar Account no tick/round (apagava os drops)
        ForceMaxMoneyCeiling(65000);
        var seedWallet =
            reason.StartsWith("map:", StringComparison.OrdinalIgnoreCase) ||
            reason.StartsWith("connect", StringComparison.OrdinalIgnoreCase);
        if (seedWallet && Get("mp_startmoney") is float startAcc)
            SetAllHumansMoney((int)startAcc, add: false);

        EnsureBots(reason);
    }

    private int CountBots()
    {
        var n = 0;
        foreach (var p in Utilities.GetPlayers())
        {
            if (p is null || !p.IsValid || p.IsHLTV || !p.IsBot) continue;
            n++;
        }
        return n;
    }

    private int CountTeam(CsTeam team)
    {
        var n = 0;
        foreach (var p in Utilities.GetPlayers())
        {
            if (p is null || !p.IsValid || p.IsHLTV) continue;
            if (p.Team == team) n++;
        }
        return n;
    }

    /// <summary>Quota exacta: mode normal + bot_add até bater o número (fill comia bots).</summary>
    private void EnsureBots(string reason)
    {
        float? quota;
        float diff;
        lock (_gate)
        {
            quota = _admin.Cvars.TryGetValue("bot_quota", out var q) ? q : null;
            diff = _admin.Cvars.TryGetValue("bot_difficulty", out var d) ? d : 1f;
        }
        if (quota is null) return;
        var want = (int)Math.Round(quota.Value);
        if (want <= 0)
        {
            Server.ExecuteCommand("bot_quota 0");
            Server.ExecuteCommand("bot_kick");
            return;
        }

        Server.ExecuteCommand("bot_stop 0");
        Server.ExecuteCommand("bot_join_after_player 0");
        Server.ExecuteCommand("bot_auto_vacate 0");
        Server.ExecuteCommand("bot_quota_mode normal");
        Server.ExecuteCommand($"bot_difficulty {Fmt(diff)}");
        Server.ExecuteCommand($"custom_bot_difficulty {Fmt(diff)}");
        Server.ExecuteCommand($"bot_quota {want}");

        var have = CountBots();
        if (have > want)
        {
            Server.ExecuteCommand("bot_kick");
            have = 0;
            _lastBotAddAt = 0;
        }
        if (have < want && _lastBotAddAt > 0 && Server.CurrentTime - _lastBotAddAt < 4f)
        {
            RebalanceBots();
            return;
        }
        var added = 0;
        // Contadores locais: bot_add no mesmo frame ainda não actualiza CountTeam
        // (senão todos iam para o time com menos gente — o adversário).
        var ct = CountTeam(CsTeam.CounterTerrorist);
        var t = CountTeam(CsTeam.Terrorist);
        while (have + added < want && added < 10)
        {
            if (t <= ct)
            {
                Server.ExecuteCommand("bot_add_t");
                t++;
            }
            else
            {
                Server.ExecuteCommand("bot_add_ct");
                ct++;
            }
            added++;
        }
        if (added > 0) _lastBotAddAt = Server.CurrentTime;
        if (added > 0)
        {
            Server.PrintToConsole(
                $"[SfAssignTeams] bots {reason} want={want} had={have} add={added} plan CT={ct} T={t}");
        }
        RebalanceBots();
    }

    /// <summary>Move bots do time cheio para o vazio até |CT-T| ≤ 1.</summary>
    private void RebalanceBots()
    {
        var ct = CountTeam(CsTeam.CounterTerrorist);
        var t = CountTeam(CsTeam.Terrorist);
        if (Math.Abs(ct - t) <= 1) return;
        foreach (var p in Utilities.GetPlayers())
        {
            if (p is null || !p.IsValid || p.IsHLTV || !p.IsBot) continue;
            ct = CountTeam(CsTeam.CounterTerrorist);
            t = CountTeam(CsTeam.Terrorist);
            if (Math.Abs(ct - t) <= 1) break;
            var from = ct > t ? CsTeam.CounterTerrorist : CsTeam.Terrorist;
            var to = ct > t ? CsTeam.Terrorist : CsTeam.CounterTerrorist;
            if (p.Team != from) continue;
            try { p.SwitchTeam(to); } catch { /* ignore */ }
        }
    }

    /// <summary>
    /// Se max ≤ start (ex.: start 17k + default UI 16k), o jogador nunca sobe de dinheiro.
    /// Floor 65k para partidas privadas (competitive default 16k).
    /// </summary>
    private static float ResolveMaxMoney(float start, float? maxOpt)
    {
        var max = maxOpt ?? 65000f;
        if (max < 65000f) max = 65000f;
        if (max < start) max = start;
        if (max <= start) max = Math.Max(65000f, start + 16000f);
        return max;
    }

    private void ShowWelcomeTo(CCSPlayerController? player)
    {
        if (player is null || !player.IsValid || player.IsBot) return;
        if (player.Connected != PlayerConnectedState.PlayerConnected) return;
        string welcome;
        string colorKey;
        lock (_gate)
        {
            welcome = _admin.Welcome;
            colorKey = _admin.WelcomeColor;
        }
        if (welcome.Length == 0) return;

        var steam = player.SteamID;
        lock (_gate)
        {
            if (!_welcomedSteam.Add(steam)) return;
        }

        var color = ResolveChatColor(colorKey);
        try
        {
            player.PrintToChat($" {color}[Sistema] {welcome}{ChatColors.Default}");
            player.PrintToCenter(welcome);
        }
        catch
        {
            try
            {
                player.PrintToChat($" \x04[Sistema]\x01 {welcome}");
            }
            catch
            {
                /* ignore */
            }
        }
    }

    private static char ResolveChatColor(string? key)
    {
        return (key ?? "green").Trim().ToLowerInvariant() switch
        {
            "lime" => ChatColors.Lime,
            "yellow" => ChatColors.Yellow,
            "lightblue" or "blue" => ChatColors.LightBlue,
            "white" => ChatColors.White,
            "olive" => ChatColors.Olive,
            "gold" => ChatColors.Gold,
            "lightpurple" or "purple" => ChatColors.LightPurple,
            "grey" or "gray" => ChatColors.Grey,
            _ => ChatColors.Green,
        };
    }

    private static string Fmt(float v) =>
        v.ToString("0.###", CultureInfo.InvariantCulture);

    private void ReloadRoster()
    {
        try
        {
            var path = RosterPath;
            if (path is null || !File.Exists(path))
            {
                Server.PrintToConsole($"[SfAssignTeams] missing roster under {Server.GameDirectory}");
                return;
            }
            var json = File.ReadAllText(path);
            var parsed = JsonSerializer.Deserialize<RosterFile>(json, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
            });
            var next = new List<RosterEntry>();
            foreach (var row in parsed?.Players ?? [])
            {
                var team = ParseTeam(row.Team);
                if (team is null) continue;
                next.Add(new RosterEntry
                {
                    SteamId = Digits(row.Steamid ?? ""),
                    Names = NormalizeNames(row),
                    Team = team.Value,
                });
            }
            lock (_gate) _roster = next;
            if (next.Count != _lastRosterLogCount)
            {
                _lastRosterLogCount = next.Count;
                Server.PrintToConsole($"[SfAssignTeams] roster reload count={next.Count} path={path}");
            }
        }
        catch (Exception ex)
        {
            Server.PrintToConsole($"[SfAssignTeams] roster error: {ex.Message}");
        }
    }

    private static List<string> NormalizeNames(RosterRow row)
    {
        var names = new List<string>();
        void add(string? s)
        {
            var t = (s ?? "").Trim();
            if (t.Length > 0) names.Add(t);
        }
        add(row.Name);
        add(row.Username);
        add(row.DisplayName);
        if (row.Names is not null)
        {
            foreach (var n in row.Names) add(n);
        }
        return names;
    }

    private static string Digits(string s)
    {
        var chars = s.Where(char.IsDigit).ToArray();
        return new string(chars);
    }

    private static CsTeam? ParseTeam(string? raw)
    {
        var t = (raw ?? "").Trim().ToUpperInvariant();
        if (t is "CT" or "COUNTERTERRORIST" or "3") return CsTeam.CounterTerrorist;
        if (t is "T" or "TR" or "TERRORIST" or "2") return CsTeam.Terrorist;
        if (t is "SPEC" or "SPECTATOR" or "1") return CsTeam.Spectator;
        return null;
    }

    private CsTeam? WantedTeamBase(CCSPlayerController player)
    {
        if (!player.IsValid || player.IsBot || player.IsHLTV) return null;
        var steam = player.SteamID.ToString();
        var name = (player.PlayerName ?? "").Trim();
        lock (_gate)
        {
            foreach (var row in _roster)
            {
                if (row.SteamId.Length >= 13 && row.SteamId == steam)
                    return row.Team;
            }
            if (name.Length > 0)
            {
                foreach (var row in _roster)
                {
                    foreach (var n in row.Names)
                    {
                        if (string.Equals(n, name, StringComparison.OrdinalIgnoreCase))
                            return row.Team;
                    }
                }
            }
        }
        return null;
    }

    private CsTeam? WantedTeam(CCSPlayerController player)
    {
        var bas = WantedTeamBase(player);
        if (bas is null) return null;
        return ApplySideParity(bas.Value, _sideSwapParity);
    }

    private void AssignNow(CCSPlayerController? player, string reason)
    {
        if (player is null || !player.IsValid || player.IsBot || player.IsHLTV) return;
        if (player.Connected != PlayerConnectedState.PlayerConnected) return;
        MaybeBumpParityFromScores(reason);
        var want = WantedTeam(player);
        if (want is null) return;
        if (player.Team == want.Value) return;

        var cur = player.Team;
        var onCtOrT = cur is CsTeam.CounterTerrorist or CsTeam.Terrorist;
        // Só força CT↔T no warmup. Depois do 1.º round / half o CS2 manda —
        // nunca empurrar de volta ao lado inicial do lobby.
        var mayForceSides = IsWarmupPeriod();
        if (onCtOrT && !mayForceSides)
        {
            if (reason is "timer" or "spawn" or "team_event" or "team_event_spec")
                return;
            return;
        }

        var slot = player.Slot;

        try
        {
            player.SwitchTeam(want.Value);
        }
        catch
        {
            /* fallback abaixo */
        }
        try
        {
            if (player.Team != want.Value)
                player.ChangeTeam(want.Value);
        }
        catch
        {
            /* ignore */
        }

        Server.NextFrame(() =>
        {
            try
            {
                var p = Utilities.GetPlayerFromSlot(slot);
                if (p is null || !p.IsValid) return;
                if (p.Team == want.Value) return;
                if ((p.Team is CsTeam.CounterTerrorist or CsTeam.Terrorist) && !mayForceSides)
                    return;
                p.SwitchTeam(want.Value);
                p.ChangeTeam(want.Value);
            }
            catch
            {
                /* ignore */
            }
        });
    }

    private sealed class AdminSettings
    {
        public Dictionary<string, float> Cvars { get; init; } = new(StringComparer.OrdinalIgnoreCase);
        public string Welcome { get; init; } = "";
        public string WelcomeColor { get; init; } = "green";
        public bool HasAny => Cvars.Count > 0 || Welcome.Length > 0;
    }

    private sealed class RosterEntry
    {
        public string SteamId { get; init; } = "";
        public List<string> Names { get; init; } = [];
        public CsTeam Team { get; init; }
    }

    private sealed class RosterFile
    {
        public List<RosterRow>? Players { get; set; }
    }

    private sealed class RosterRow
    {
        public string? Steamid { get; set; }
        public string? Name { get; set; }
        public string? Username { get; set; }
        public string? DisplayName { get; set; }
        public List<string>? Names { get; set; }
        public string? Team { get; set; }
    }
}
