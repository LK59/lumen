using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;

namespace Lumen.Jellyfin;

/// <summary>
/// Le journal des lectures : une ligne JSON par lecture, dans les données du serveur (<c>lumen/lectures.jsonl</c>).
///
/// Un fichier texte plutôt qu'une base : quelques lectures par jour, lues en entier pour être
/// affichées, et qu'on peut ouvrir ou effacer à la main. Borné — au-delà de <see cref="MaxBytes"/>, la
/// moitié la plus ancienne est retirée — pour qu'un journal oublié allumé ne grossisse pas sans fin.
/// </summary>
internal static class PlaybackJournal
{
    private const long MaxBytes = 2 * 1024 * 1024;
    private static readonly object Lock = new();

    /// <summary>
    /// UTF-8 sans marque en tête de fichier. Avec elle (ce que fait <see cref="Encoding.UTF8"/> à la
    /// création), la première ligne ne commençait plus par une accolade : illisible comme JSON, elle
    /// disparaissait de la page sans un mot — la première lecture journalisée n'y figurait jamais.
    /// </summary>
    private static readonly Encoding Utf8 = new UTF8Encoding(false);

    private static string? FilePath
    {
        get
        {
            var folder = Plugin.Instance?.JournalDirectory;
            return string.IsNullOrEmpty(folder) ? null : Path.Combine(folder, "lectures.jsonl");
        }
    }

    public static void Append(JsonElement entry, string user, double? ffmpegCpuSeconds)
    {
        var path = FilePath;
        if (path is null)
        {
            return;
        }

        // Ce que le navigateur a mesuré, tel quel, et ce que seul le serveur sait : l'heure, le compte, et
        // le processeur que ffmpeg a consommé pour ce fichier pendant la lecture.
        var line = JsonSerializer.Serialize(new { at = DateTime.UtcNow, user, ffmpegCpuSeconds, entry });
        lock (Lock)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.AppendAllText(path, line + "\n", Utf8);
            var file = new FileInfo(path);
            if (file.Length > MaxBytes)
            {
                var lines = File.ReadAllLines(path, Encoding.UTF8);
                File.WriteAllLines(path, lines.Skip(lines.Length / 2), Utf8);
            }
        }
    }

    /// <summary>
    /// Les dernières lectures, la plus récente d'abord.
    /// </summary>
    public static IReadOnlyList<JsonElement> Read(int limit)
    {
        var path = FilePath;
        var entries = new List<JsonElement>();
        if (path is null)
        {
            return entries;
        }

        string[] lines;
        lock (Lock)
        {
            if (!File.Exists(path))
            {
                return entries;
            }

            lines = File.ReadAllLines(path, Encoding.UTF8);
        }

        for (var i = lines.Length - 1; i >= 0 && entries.Count < limit; i--)
        {
            try
            {
                // Un journal commencé par une version antérieure garde sa marque en tête : on la retire.
                using var document = JsonDocument.Parse(lines[i].TrimStart('\uFEFF'));
                entries.Add(document.RootElement.Clone());
            }
            catch (JsonException)
            {
                // Une ligne coupée (arrêt du serveur en pleine écriture) ne cache pas les autres.
            }
        }

        return entries;
    }

    public static void Clear()
    {
        var path = FilePath;
        if (path is null)
        {
            return;
        }

        lock (Lock)
        {
            File.Delete(path);
        }
    }
}
