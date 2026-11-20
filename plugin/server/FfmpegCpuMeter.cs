using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;

namespace Lumen.Jellyfin;

/// <summary>
/// Le processeur que ffmpeg consomme pour chaque fichier, relevé pendant que le journal est allumé.
///
/// Le navigateur mesure ce que le spectateur attend ; il ne voit pas ce que la lecture coûte au serveur.
/// Ce coût, c'est ffmpeg : Jellyfin en lance un par transcodage, remux ou extraction de sous-titres. Toutes
/// les deux secondes, ce relevé lit dans <c>/proc</c> le temps de processeur de chaque ffmpeg en cours et
/// l'ajoute au compte du fichier qu'il lit ; la ligne de journal d'une lecture emporte le compte de son
/// fichier (<see cref="Take"/>).
///
/// Deux limites, assumées. Linux seulement : sans <c>/proc</c>, rien n'est relevé et le champ reste vide.
/// Et le compte est par fichier, pas par séance : deux comptes qui lisent le même film en même temps se
/// partagent un seul chiffre. Mesure seulement — rien ici ne touche à ffmpeg, et rien ne lève.
/// </summary>
internal sealed class FfmpegCpuMeter : BackgroundService
{
    /// <summary>
    /// Les « ticks » de <c>/proc/&lt;pid&gt;/stat</c> par seconde : 100 sur tous les noyaux Linux courants.
    /// </summary>
    private const double TicksPerSecond = 100;
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(2);
    private static readonly object Lock = new();
    private static readonly Dictionary<int, (long Ticks, string Input)> Running = new();
    private static readonly Dictionary<string, (double Seconds, DateTime Seen)> ByInput = new(StringComparer.Ordinal);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!Directory.Exists("/proc"))
        {
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            if (Plugin.Instance?.Configuration is { Enabled: true, Journal: true })
            {
                Sample();
            }

            try
            {
                await Task.Delay(Interval, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    /// <summary>
    /// Les secondes de processeur que ffmpeg a consommées pour ce fichier depuis le dernier appel, ou null
    /// si rien ne peut être relevé ici. Le compte est remis à zéro : il appartient à la lecture qui se termine.
    /// </summary>
    public static double? Take(string? path)
    {
        if (string.IsNullOrEmpty(path) || !Directory.Exists("/proc"))
        {
            return null;
        }

        // Un dernier relevé : la lecture vient de s'arrêter, et son ffmpeg va disparaître.
        Sample();
        lock (Lock)
        {
            var seconds = ByInput.TryGetValue(path, out var counted) ? counted.Seconds : 0;
            ByInput.Remove(path);
            return Math.Round(seconds, 1);
        }
    }

    private static void Sample()
    {
        try
        {
            lock (Lock)
            {
                var alive = new HashSet<int>();
                foreach (var directory in Directory.EnumerateDirectories("/proc"))
                {
                    if (!int.TryParse(Path.GetFileName(directory), NumberStyles.None, CultureInfo.InvariantCulture, out var pid))
                    {
                        continue;
                    }

                    try
                    {
                        if (File.ReadAllText(Path.Combine(directory, "comm")).Trim() != "ffmpeg")
                        {
                            continue;
                        }

                        var ticks = CpuTicks(File.ReadAllText(Path.Combine(directory, "stat")));
                        if (!Running.TryGetValue(pid, out var known))
                        {
                            var input = InputOf(File.ReadAllText(Path.Combine(directory, "cmdline")));
                            if (input is null)
                            {
                                continue;
                            }

                            // Vu pour la première fois : tout ce qu'il a déjà consommé compte.
                            known = (0, input);
                        }

                        alive.Add(pid);
                        var spent = Math.Max(0, ticks - known.Ticks) / TicksPerSecond;
                        Running[pid] = (ticks, known.Input);
                        ByInput[known.Input] = ((ByInput.TryGetValue(known.Input, out var counted) ? counted.Seconds : 0) + spent, DateTime.UtcNow);
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or FormatException)
                    {
                        // Un processus qui se termine pendant qu'on le lit : il n'y a plus rien à lire.
                    }
                }

                foreach (var pid in new List<int>(Running.Keys))
                {
                    if (!alive.Contains(pid))
                    {
                        Running.Remove(pid);
                    }
                }

                // Un compte que personne n'est venu chercher (lecture hors du client web, onglet fermé net)
                // n'est pas gardé indéfiniment.
                foreach (var input in new List<string>(ByInput.Keys))
                {
                    if (DateTime.UtcNow - ByInput[input].Seen > TimeSpan.FromHours(6))
                    {
                        ByInput.Remove(input);
                    }
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // /proc illisible : pas de relevé cette fois.
        }
    }

    /// <summary>
    /// Le temps de processeur (utilisateur + noyau) d'une ligne <c>/proc/&lt;pid&gt;/stat</c>. Le nom du
    /// processus, entre parenthèses, peut contenir des espaces : on compte les champs après la dernière.
    /// </summary>
    internal static long CpuTicks(string stat)
    {
        var fields = stat[(stat.LastIndexOf(')') + 2)..].Split(' ');
        // Après le nom : état (champ 3), puis utime et stime aux champs 14 et 15.
        return long.Parse(fields[11], CultureInfo.InvariantCulture) + long.Parse(fields[12], CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Le fichier que ce ffmpeg lit : l'argument qui suit <c>-i</c>, débarrassé de son préfixe <c>file:</c>.
    /// </summary>
    internal static string? InputOf(string commandLine)
    {
        var arguments = commandLine.Split('\0');
        for (var i = 0; i + 1 < arguments.Length; i++)
        {
            if (arguments[i] == "-i")
            {
                var input = arguments[i + 1].Trim('"');
                return input.StartsWith("file:", StringComparison.Ordinal) ? input[5..].Trim('"') : input;
            }
        }

        return null;
    }
}
