using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;

namespace SfKillSounds;

/// <summary>
/// Sons de kill Quake (Workshop) — só o host configura via sf_pm_sounds.json.
/// Sem menus/comandos para jogadores (não mute, não prefs locais).
/// </summary>
public class SfKillSoundsPlugin : BasePlugin
{
    public override string ModuleName => "SteamFarm Kill Sounds";
    public override string ModuleVersion => "1.4.4";
    public override string ModuleAuthor => "SteamFarm";
    public override string ModuleDescription =>
        "Kill sounds + red system chat (host-only via sf_pm_sounds.json)";

    private readonly object _gate = new();
    private SoundsConfig _cfg = SoundsConfig.Disabled();
    private readonly Dictionary<ulong, int> _streak = new();
    private readonly Dictionary<ulong, int> _shotsSinceKill = new();
    private bool _firstBloodDone;
    private DateTime _lastLoadUtc = DateTime.MinValue;
    private string _lastMamCmd = "";

    private string SoundsPath => ResolveCfgFile("sf_pm_sounds.json") ??
        Path.Combine(Server.GameDirectory, "csgo", "cfg", "sf_pm_sounds.json");

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
        ReloadConfig(force: true);
        EnsureWorkshopAddons();
        Server.PrintToConsole($"[SfKillSounds] loaded v{ModuleVersion} cfg={SoundsPath} enabled={_cfg.Enabled}");

        RegisterListener<Listeners.OnServerPrecacheResources>(manifest =>
        {
            SoundsConfig cfg;
            lock (_gate) cfg = _cfg;
            // Precache mesmo se ainda disabled — host pode ligar a quente antes do próximo mapa
            var evts = string.IsNullOrWhiteSpace(cfg.SoundEventFile)
                ? "soundevents/soundevents_quakesounds.vsndevts"
                : cfg.SoundEventFile;
            if (cfg.Enabled || cfg.WorkshopIds.Count > 0)
            {
                try
                {
                    manifest.AddResource(evts);
                    Server.PrintToConsole($"[SfKillSounds] precache {evts}");
                }
                catch (Exception ex)
                {
                    Server.PrintToConsole($"[SfKillSounds] precache fail: {ex.Message}");
                }
            }
        });

        RegisterListener<Listeners.OnMapStart>(_ =>
        {
            lock (_gate)
            {
                _streak.Clear();
                _shotsSinceKill.Clear();
                _firstBloodDone = false;
            }
            ReloadConfig(force: true);
            EnsureWorkshopAddons();
        });

        RegisterEventHandler<EventRoundStart>((_, _) =>
        {
            lock (_gate)
            {
                _streak.Clear();
                _shotsSinceKill.Clear();
                _firstBloodDone = false;
            }
            return HookResult.Continue;
        });

        RegisterEventHandler<EventWeaponFire>((@event, _) =>
        {
            var shooter = @event.Userid;
            if (shooter is null || !shooter.IsValid) return HookResult.Continue;
            var key = PlayerKey(shooter);
            lock (_gate)
            {
                _shotsSinceKill[key] = (_shotsSinceKill.TryGetValue(key, out var n) ? n : 0) + 1;
            }
            return HookResult.Continue;
        });

        RegisterEventHandler<EventPlayerDeath>(OnPlayerDeath);

        AddTimer(2.0f, () =>
        {
            ReloadConfig(force: false);
            EnsureWorkshopAddons();
        }, TimerFlags.REPEAT);
    }

    /// <summary>
    /// Garante MultiAddonManager com o Workshop Quake (sem isto EmitSound fica mudo).
    /// </summary>
    private void EnsureWorkshopAddons()
    {
        SoundsConfig cfg;
        lock (_gate) cfg = _cfg;
        if (!cfg.Enabled) return;
        var ids = cfg.WorkshopIds.Count > 0
            ? cfg.WorkshopIds
            : new List<string> { "3461824328" };
        var joined = string.Join(",", ids.Where(id => !string.IsNullOrWhiteSpace(id)).Select(id => id.Trim()));
        if (string.IsNullOrWhiteSpace(joined)) return;
        var cmd = $"mm_extra_addons \"{joined}\"";
        if (cmd == _lastMamCmd) return;
        try
        {
            Server.ExecuteCommand(cmd);
            _lastMamCmd = cmd;
            Server.PrintToConsole($"[SfKillSounds] {cmd}");
        }
        catch (Exception ex)
        {
            Server.PrintToConsole($"[SfKillSounds] mm_extra_addons fail: {ex.Message}");
        }
    }

    private static ulong PlayerKey(CCSPlayerController p) =>
        p.SteamID != 0 ? p.SteamID : (ulong)(p.Slot + 1);

    private HookResult OnPlayerDeath(EventPlayerDeath @event, GameEventInfo info)
    {
        SoundsConfig cfg;
        lock (_gate) cfg = _cfg;
        if (!cfg.Enabled) return HookResult.Continue;

        var attacker = @event.Attacker;
        var victim = @event.Userid;
        if (attacker is null || !attacker.IsValid) return HookResult.Continue;
        if (victim is null || !victim.IsValid) return HookResult.Continue;
        // Só ignora suicídio / teamkill; bots como atacante OK (treino)
        if (attacker.SteamID != 0 && victim.SteamID != 0 && attacker.SteamID == victim.SteamID)
            return HookResult.Continue;
        if (attacker.TeamNum == victim.TeamNum) return HookResult.Continue;

        var steam = PlayerKey(attacker);
        int streak;
        bool firstBlood;
        int shots;
        lock (_gate)
        {
            streak = (_streak.TryGetValue(steam, out var s) ? s : 0) + 1;
            _streak[steam] = streak;
            firstBlood = !_firstBloodDone;
            if (firstBlood) _firstBloodDone = true;
            shots = _shotsSinceKill.TryGetValue(steam, out var sh) ? sh : 0;
            _shotsSinceKill[steam] = 0;
        }

        var knife = IsKnifeWeapon(@event);
        var headshot = @event.Headshot;
        var noscope = @event.Noscope;
        var penetrations = @event.Penetrated;

        // Tags visíveis na mensagem (todas as que aplicam)
        var tags = new List<string>();
        if (firstBlood) tags.Add("First Blood");
        if (knife) tags.Add("Faca");
        if (headshot) tags.Add("Headshot");
        if (noscope) tags.Add("No-Scope");
        if (penetrations > 0) tags.Add(penetrations == 1 ? "Wallbang" : $"Wallbang x{penetrations}");
        if (streak == 2) tags.Add("Double Kill");
        else if (streak == 3) tags.Add("Triple Kill");
        else if (streak >= 5) tags.Add($"Killstreak x{streak}");
        if (shots > 0) tags.Add(shots == 1 ? "1 tiro" : $"{shots} tiros");

        string? soundKey = null;
        if (firstBlood && !string.IsNullOrWhiteSpace(cfg.Events.FirstBlood))
            soundKey = cfg.Events.FirstBlood;
        else if (knife && !string.IsNullOrWhiteSpace(cfg.Events.Knife))
            soundKey = cfg.Events.Knife;
        else if (headshot && !string.IsNullOrWhiteSpace(cfg.Events.Headshot))
            soundKey = cfg.Events.Headshot;
        else if (streak == 3 && !string.IsNullOrWhiteSpace(cfg.Events.TripleKill))
            soundKey = cfg.Events.TripleKill;
        else if (streak == 2 && !string.IsNullOrWhiteSpace(cfg.Events.DoubleKill))
            soundKey = cfg.Events.DoubleKill;
        else if (streak >= 5 && !string.IsNullOrWhiteSpace(cfg.Events.Killstreak))
            soundKey = cfg.Events.Killstreak;
        else if (!string.IsNullOrWhiteSpace(cfg.Events.Kill))
            soundKey = cfg.Events.Kill;

        var attackerName = SafeName(attacker);
        var victimName = SafeName(victim);
        AnnounceKill(attackerName, victimName, tags);

        if (!string.IsNullOrWhiteSpace(soundKey))
            PlayToAll(attacker, soundKey!);

        return HookResult.Continue;
    }

    private static string SafeName(CCSPlayerController p)
    {
        try
        {
            var n = (p.PlayerName ?? "").Trim();
            return string.IsNullOrWhiteSpace(n) ? $"Jogador#{p.Slot}" : n;
        }
        catch
        {
            return "Jogador";
        }
    }

    /// <summary>
    /// Chat vermelho no estilo [Sistema] — espaço inicial obrigatório para a cor funcionar.
    /// </summary>
    private void AnnounceKill(string attacker, string victim, List<string> tags)
    {
        var detail = tags.Count > 0 ? $" ({string.Join(" · ", tags)})" : "";
        var msg =
            $" {ChatColors.Red}[Sistema] {ChatColors.LightRed}{attacker}{ChatColors.Red} eliminou {ChatColors.LightRed}{victim}{ChatColors.Red}{detail}{ChatColors.Default}";
        try
        {
            Server.PrintToChatAll(msg);
            Server.PrintToConsole($"[SfKillSounds] chat {attacker} -> {victim}{detail}");
        }
        catch (Exception ex)
        {
            Server.PrintToConsole($"[SfKillSounds] chat fail: {ex.Message}");
            try
            {
                foreach (var p in Utilities.GetPlayers())
                {
                    if (p is null || !p.IsValid || p.IsBot) continue;
                    p.PrintToChat(msg);
                }
            }
            catch
            {
                /* ignore */
            }
        }
    }

    /// <summary>
    /// Igual aos commits 1.4.1/1.4.2 (Kandru): EmitSound sem volume.
    /// Se a sig CS2 estiver partida, o mesmo path de ficheiro do Workshop
    /// via `play sounds/...` (não precisa sv_cheats — snd_sos_* precisa).
    /// </summary>
    private void PlayToAll(CCSPlayerController source, string soundKey)
    {
        try
        {
            var recipients = Utilities.GetPlayers()
                .Where(p => p is not null && p.IsValid && !p.IsBot && !p.IsHLTV)
                .ToList();
            if (recipients.Count == 0)
            {
                Server.PrintToConsole($"[SfKillSounds] skip {soundKey} (no recipients)");
                return;
            }

            var filter = new RecipientFilter();
            foreach (var p in recipients) filter.Add(p);

            try
            {
                _ = source.EmitSound(soundKey, filter);
                Server.PrintToConsole($"[SfKillSounds] play {soundKey} → {filter.Count}p");
            }
            catch (Exception ex)
            {
                Server.PrintToConsole($"[SfKillSounds] emit source fail: {ex.Message}");
            }

            var filePath = SoundEventToPlayPath(soundKey);
            var played = 0;
            foreach (var p in recipients)
            {
                try
                {
                    p.ExecuteClientCommand($"play {filePath}");
                    played++;
                }
                catch
                {
                    /* ignore */
                }
            }
            Server.PrintToConsole($"[SfKillSounds] play-file {filePath} → {played}p");
        }
        catch (Exception ex)
        {
            Server.PrintToConsole($"[SfKillSounds] emit fail: {ex.Message}");
        }
    }

    /// <summary>
    /// QuakeSoundsD.Headshot → sounds/cs2/quakesounds/default/headshot
    /// QuakeSoundsF.* → female. Path do VPK 3461824328.
    /// </summary>
    private static string SoundEventToPlayPath(string soundKey)
    {
        if (soundKey.StartsWith("sounds/", StringComparison.OrdinalIgnoreCase))
            return soundKey;
        var pack = "default";
        var name = soundKey;
        var dot = soundKey.LastIndexOf('.');
        if (dot >= 0)
        {
            var prefix = soundKey[..dot];
            name = soundKey[(dot + 1)..];
            if (prefix.EndsWith("F", StringComparison.OrdinalIgnoreCase))
                pack = "female";
            else if (prefix.EndsWith("E", StringComparison.OrdinalIgnoreCase) ||
                     prefix.Contains("extra", StringComparison.OrdinalIgnoreCase))
                pack = "extra";
        }
        if (string.IsNullOrWhiteSpace(name)) name = soundKey;
        return $"sounds/cs2/quakesounds/{pack}/{name.ToLowerInvariant()}";
    }

    private static bool IsKnifeWeapon(EventPlayerDeath ev)
    {
        try
        {
            var w = Convert.ToString(ev.Weapon)?.ToLowerInvariant() ?? "";
            return w.Contains("knife") || w.Contains("bayonet");
        }
        catch
        {
            return false;
        }
    }

    private void ReloadConfig(bool force)
    {
        try
        {
            var path = SoundsPath;
            if (!File.Exists(path))
            {
                lock (_gate) _cfg = SoundsConfig.Disabled();
                Server.PrintToConsole($"[SfKillSounds] no cfg at {path}");
                return;
            }
            var mtime = File.GetLastWriteTimeUtc(path);
            if (!force && mtime <= _lastLoadUtc) return;
            var json = File.ReadAllText(path);
            var next = SoundsConfig.FromJson(json);
            lock (_gate)
            {
                _cfg = next;
                _lastLoadUtc = mtime;
            }
            Server.PrintToConsole(
                $"[SfKillSounds] cfg reload enabled={next.Enabled} intensity={next.Intensity} kill={next.Events.Kill}");
        }
        catch (Exception ex)
        {
            Server.PrintToConsole($"[SfKillSounds] cfg error: {ex.Message}");
        }
    }
}

internal sealed class SoundsConfig
{
    public bool Enabled { get; set; }
    public string Intensity { get; set; } = "med";
    public string SoundEventFile { get; set; } = "soundevents/soundevents_quakesounds.vsndevts";
    public List<string> WorkshopIds { get; set; } = [];
    public EventMap Events { get; set; } = new();

    public static SoundsConfig Disabled() => new() { Enabled = false };

    public static SoundsConfig FromJson(string json)
    {
        using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
        var root = doc.RootElement;
        var cfg = new SoundsConfig
        {
            Enabled = root.TryGetProperty("enabled", out var en) && (
                en.ValueKind == JsonValueKind.True ||
                (en.ValueKind == JsonValueKind.String &&
                 string.Equals(en.GetString(), "true", StringComparison.OrdinalIgnoreCase)) ||
                (en.ValueKind == JsonValueKind.Number && en.TryGetInt32(out var n) && n != 0)),
            Intensity = root.TryGetProperty("intensity", out var inten)
                ? (inten.GetString() ?? "med")
                : "med",
            SoundEventFile = root.TryGetProperty("soundEventFile", out var sef)
                ? (sef.GetString() ?? "soundevents/soundevents_quakesounds.vsndevts")
                : "soundevents/soundevents_quakesounds.vsndevts",
        };
        if (root.TryGetProperty("workshopIds", out var ids) && ids.ValueKind == JsonValueKind.Array)
        {
            foreach (var id in ids.EnumerateArray())
            {
                var s = id.GetString();
                if (!string.IsNullOrWhiteSpace(s)) cfg.WorkshopIds.Add(s!);
            }
        }
        if (cfg.WorkshopIds.Count == 0) cfg.WorkshopIds.Add("3461824328");
        if (root.TryGetProperty("events", out var ev) && ev.ValueKind == JsonValueKind.Object)
        {
            cfg.Events = new EventMap
            {
                Kill = GetStr(ev, "kill"),
                Headshot = GetStr(ev, "headshot"),
                FirstBlood = GetStr(ev, "firstBlood"),
                Knife = GetStr(ev, "knife"),
                DoubleKill = GetStr(ev, "doubleKill"),
                TripleKill = GetStr(ev, "tripleKill"),
                Killstreak = GetStr(ev, "killstreak"),
            };
        }
        return cfg;
    }

    private static string GetStr(JsonElement obj, string key) =>
        obj.TryGetProperty(key, out var el) ? (el.GetString() ?? "") : "";
}

internal sealed class EventMap
{
    public string Kill { get; set; } = "";
    public string Headshot { get; set; } = "";
    public string FirstBlood { get; set; } = "";
    public string Knife { get; set; } = "";
    public string DoubleKill { get; set; } = "";
    public string TripleKill { get; set; } = "";
    public string Killstreak { get; set; } = "";
}
