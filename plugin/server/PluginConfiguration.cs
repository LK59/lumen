using System;
using MediaBrowser.Model.Plugins;

namespace Lumen.Jellyfin;

/// <summary>
/// Les réglages du plugin. Trois interrupteurs indépendants, pour pouvoir comparer : le plugin présent
/// dans la page ou non, Lumen qui lit ou qui regarde lire, et le journal des lectures.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Faux : la page de jellyfin-web est servie telle quelle, sans le script de Lumen — rien n'est lu
    /// par Lumen, et rien n'est journalisé.
    /// </summary>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// Vrai : Lumen lit ce qu'il sait lire. Faux : le script reste dans la page mais laisse jellyfin-web
    /// lire seul — de quoi journaliser les mêmes lectures « sans Lumen », mesurées de la même façon.
    /// </summary>
    public bool Playback { get; set; } = true;

    /// <summary>
    /// Vrai : Lumen lit pour tous les comptes. Faux : seulement pour ceux de <see cref="UserIds"/>.
    /// </summary>
    public bool AllUsers { get; set; } = true;

    /// <summary>
    /// Les comptes pour lesquels Lumen lit, quand <see cref="AllUsers"/> est faux.
    /// </summary>
    public Guid[] UserIds { get; set; } = Array.Empty<Guid>();

    /// <summary>
    /// Vrai : chaque lecture du client web est consignée (qui, quoi, par quel lecteur, ce que le
    /// spectateur a attendu). Éteint d'origine : c'est un relevé de ce que chacun regarde.
    /// </summary>
    public bool Journal { get; set; }
}
