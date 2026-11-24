using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Lumen.Jellyfin;

/// <summary>
/// Lumen pour Jellyfin. Ce plugin ne calcule rien : il livre à jellyfin-web le lecteur qui remuxe et
/// décode dans le navigateur, et tient ses réglages.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        JournalDirectory = Path.Combine(applicationPaths.DataPath, "lumen");
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Lumen";

    public override Guid Id => Guid.Parse("6f1b0a3e-52c8-4d0e-9a7b-1c7e5d9a4b20");

    // Jellyfin affiche cette description sur la page du plugin installé, à la place de celle du dépôt de
    // plugins : package.sh et publish.sh la lisent ici pour que le catalogue dise la même chose.
    public override string Description => "Plays files as they are: the browser remuxes them and decodes the audio, the server only sends bytes. Measured against the regular player, on files the server would otherwise repackage or transcode: playback starts 2 to 4 times sooner, seeks are 3 to 4 times faster, and changing the audio track is about 8 times faster.";

    /// <summary>
    /// Le dossier des fichiers du lecteur (le pont, le moteur, ses décodeurs), livrés à côté de l'assemblage.
    /// </summary>
    public string WebDirectory => Path.Combine(Path.GetDirectoryName(AssemblyFilePath) ?? string.Empty, "web");

    private string? _webStamp;

    /// <summary>
    /// L'empreinte des fichiers du lecteur tels qu'ils sont livrés : la version, et un condensé de leurs
    /// noms, tailles et dates. Elle entre dans leur adresse (<c>Lumen/web/@empreinte/…</c>), ce qui permet au
    /// navigateur de les garder sans jamais redemander s'ils ont changé — une adresse, un contenu.
    ///
    /// Avant, chaque fichier était revalidé à chaque page : le moteur, ses morceaux, le worker et le décodeur
    /// se chargent l'un après l'autre, soit cinq allers-retours à la suite avant le premier son d'un film
    /// à ré-encoder (0,45 s à 40 ms de latence, banc du 24/11/2026).
    ///
    /// Calculée une fois : les fichiers ne changent pas sous un serveur qui tourne (une mise à jour du
    /// plugin le redémarre). La version seule ne suffirait pas à une construction refaite sans la changer.
    /// </summary>
    public string WebStamp
    {
        get
        {
            if (_webStamp is not null)
            {
                return _webStamp;
            }

            var digest = new System.Text.StringBuilder();
            try
            {
                foreach (var file in new DirectoryInfo(WebDirectory).GetFiles().OrderBy(f => f.Name, StringComparer.Ordinal))
                {
                    digest.Append(file.Name).Append('|').Append(file.Length).Append('|').Append(file.LastWriteTimeUtc.Ticks).Append('\n');
                }
            }
            catch (IOException)
            {
                // Dossier illisible : l'empreinte ne dit que la version, et rien n'est servi de toute façon.
            }

            var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(digest.ToString()));
            return _webStamp = Version + "-" + Convert.ToHexString(hash, 0, 4).ToLowerInvariant();
        }
    }

    /// <summary>
    /// Le dossier du journal des lectures, dans les données du serveur.
    ///
    /// Pas dans le dossier de données que Jellyfin propose aux plugins : celui-ci est <c>plugins/Lumen</c>,
    /// à côté du dossier du plugin (<c>plugins/Lumen_&lt;version&gt;</c>), et au redémarrage suivant
    /// Jellyfin l'a pris pour le plugin lui-même — et a supprimé le vrai, sans une ligne dans son journal.
    /// </summary>
    public string JournalDirectory { get; }

    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = Name,
            // Dans le menu latéral du tableau de bord : le journal se consulte souvent, et le chemin
            // ordinaire (Plugins, puis Lumen, puis Réglages) fait trois écrans pour y arriver.
            DisplayName = Name,
            EnableInMainMenu = true,
            MenuSection = "server",
            MenuIcon = "play_circle",
            EmbeddedResourcePath = GetType().Namespace + ".Configuration.configPage.html"
        };
    }
}
