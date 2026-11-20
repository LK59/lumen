using System;
using System.IO;
using System.Linq;
using System.Net.Mime;
using System.Text.Json;
using System.Collections.Generic;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Lumen.Jellyfin;

/// <summary>
/// Les deux choses que le navigateur demande au plugin : les fichiers du lecteur, et s'il doit s'en servir.
/// </summary>
[ApiController]
[Route("Lumen")]
public class LumenController : ControllerBase
{
    private readonly ILibraryManager _libraryManager;

    public LumenController(ILibraryManager libraryManager)
    {
        _libraryManager = libraryManager;
    }

    /// <summary>
    /// Un fichier du lecteur. Sans authentification : le script est chargé par la page avant toute
    /// connexion, et rien ici n'est secret — c'est du code, le même pour tous.
    /// </summary>
    [HttpGet("web/{*file}")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public IActionResult GetWebFile([FromRoute] string file)
    {
        var root = Plugin.Instance?.WebDirectory;
        if (string.IsNullOrEmpty(root) || string.IsNullOrEmpty(file))
        {
            return NotFound();
        }

        // Le chemin résolu doit rester sous le dossier du lecteur : « .. » ne mène nulle part.
        var rootFull = Path.GetFullPath(root) + Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(Path.Combine(rootFull, file));
        if (!full.StartsWith(rootFull, StringComparison.Ordinal) || !System.IO.File.Exists(full))
        {
            return NotFound();
        }

        var contentType = Path.GetExtension(full).ToLowerInvariant() switch
        {
            ".js" or ".mjs" => "text/javascript",
            ".map" => MediaTypeNames.Application.Json,
            ".txt" => "text/plain; charset=utf-8",
            _ => MediaTypeNames.Application.Octet
        };

        // Le script d'entrée porte la version dans son adresse, les morceaux une empreinte dans leur nom ;
        // le worker et les décodeurs gardent leur nom d'une version à l'autre, d'où la revalidation.
        Response.Headers.CacheControl = "no-cache";
        return PhysicalFile(full, contentType, enableRangeProcessing: false);
    }

    /// <summary>
    /// Les réglages pour le compte qui demande : Lumen lit-il pour lui, et ses lectures sont-elles
    /// journalisées ? C'est ici que « pour qui » se décide : le script est le même pour tous, et pose la
    /// question une fois connecté.
    /// </summary>
    [HttpGet("Settings")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<LumenSettings> GetSettings()
    {
        var configuration = Plugin.Instance?.Configuration;
        if (configuration is null || !configuration.Enabled)
        {
            return new LumenSettings();
        }

        var reads = configuration.Playback;
        if (reads && !configuration.AllUsers)
        {
            // L'identité vient du jeton, jamais de la requête : on ne demande pas pour quelqu'un d'autre.
            var claim = User.Claims.FirstOrDefault(c => string.Equals(c.Type, "Jellyfin-UserId", StringComparison.Ordinal))?.Value;
            reads = Guid.TryParse(claim, out var userId) && configuration.UserIds.Contains(userId);
        }

        return new LumenSettings { Enabled = reads, Journal = configuration.Journal };
    }

    /// <summary>
    /// Une lecture terminée, telle que le navigateur l'a mesurée. Ignorée quand le journal est éteint.
    /// </summary>
    [HttpPost("Journal")]
    [Authorize]
    [RequestSizeLimit(16 * 1024)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public IActionResult PostJournal([FromBody] JsonElement entry)
    {
        var configuration = Plugin.Instance?.Configuration;
        if (configuration is { Enabled: true, Journal: true } && entry.ValueKind == JsonValueKind.Object)
        {
            // Le fichier de l'élément lu : c'est par lui que le relevé de ffmpeg se rattache à cette lecture.
            string? path = null;
            if (entry.TryGetProperty("itemId", out var id) && Guid.TryParse(id.GetString(), out var itemId))
            {
                path = _libraryManager.GetItemById(itemId)?.Path;
            }

            PlaybackJournal.Append(entry, User.Identity?.Name ?? string.Empty, FfmpegCpuMeter.Take(path));
        }

        return NoContent();
    }

    /// <summary>
    /// Les dernières lectures, pour la page de réglages. Réservé aux administrateurs : c'est un relevé de
    /// ce que chacun a regardé.
    /// </summary>
    [HttpGet("Journal")]
    [Authorize(Policy = "RequiresElevation")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<JsonElement>> GetJournal([FromQuery] int limit = 500)
    {
        return Ok(PlaybackJournal.Read(Math.Clamp(limit, 1, 2000)));
    }

    /// <summary>
    /// Efface le journal.
    /// </summary>
    [HttpDelete("Journal")]
    [Authorize(Policy = "RequiresElevation")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public IActionResult DeleteJournal()
    {
        PlaybackJournal.Clear();
        return NoContent();
    }
}

/// <summary>
/// La réponse faite au script.
/// </summary>
public class LumenSettings
{
    /// <summary>
    /// Lumen lit-il pour ce compte ?
    /// </summary>
    public bool Enabled { get; set; }

    /// <summary>
    /// Les lectures de ce compte sont-elles journalisées ?
    /// </summary>
    public bool Journal { get; set; }
}
