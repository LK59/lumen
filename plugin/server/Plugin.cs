using System;
using System.Collections.Generic;
using System.IO;
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

    public override string Description => "Plays files as they are: the browser remuxes them and decodes the audio, the server only sends bytes.";

    /// <summary>
    /// Le dossier des fichiers du lecteur (le pont, le moteur, ses décodeurs), livrés à côté de l'assemblage.
    /// </summary>
    public string WebDirectory => Path.Combine(Path.GetDirectoryName(AssemblyFilePath) ?? string.Empty, "web");

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
