using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;

namespace Lumen.Jellyfin;

/// <summary>
/// Ajoute Lumen à deux réponses du client web : la page d'entrée reçoit son script en tête, et
/// <c>config.json</c> son nom dans la liste des plugins que jellyfin-web charge au démarrage.
///
/// Ces deux réponses sont produites par le reste du serveur, comme toujours, puis complétées ici au
/// passage. Elles ne sont pas relues sur le disque : d'autres plugins modifient la même page (File
/// Transformation et ceux qui s'en servent, des thèmes, des injecteurs de script), et une page resservie
/// depuis le fichier d'origine effacerait leur travail. Ce qu'ils ont fait arrive ici déjà fait.
///
/// Aucun fichier n'est modifié. Tout le reste, et ces deux réponses aussi au moindre doute (plugin
/// désactivé, réponse qui n'est pas celle attendue), passe tel quel.
/// </summary>
internal sealed class WebClientMiddleware
{
    /// <summary>
    /// Le nom sous lequel le lecteur s'annonce dans la page (<c>window.lumenPlayer</c>, voir le pont).
    /// </summary>
    internal const string PluginName = "lumenPlayer";

    /// <summary>
    /// Ce qui, dans une page, dit que le script y est déjà.
    /// </summary>
    private const string ScriptMarker = "Lumen/web/lumen-jellyfin.js";

    /// <summary>
    /// Au-delà, ce n'est ni la page d'entrée ni la configuration du client web : on ne garde pas en mémoire
    /// une réponse qu'on ne comprend pas.
    /// </summary>
    private const int MaxBytes = 2 * 1024 * 1024;

    private readonly RequestDelegate _next;
    private readonly ILogger<WebClientMiddleware> _logger;
    private bool _warned;

    public WebClientMiddleware(RequestDelegate next, ILogger<WebClientMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var request = context.Request;
        var path = request.Path.Value ?? string.Empty;
        var index = IsWebIndex(path);
        var config = !index && path.EndsWith("/web/config.json", StringComparison.OrdinalIgnoreCase);
        var plugin = Plugin.Instance;
        var get = HttpMethods.IsGet(request.Method);
        if ((!index && !config) || (!get && !HttpMethods.IsHead(request.Method)) || plugin is null || !plugin.Configuration.Enabled)
        {
            await _next(context).ConfigureAwait(false);
            return;
        }

        if (!get)
        {
            // Une requête sans corps : rien à compléter, mais ses en-têtes ne doivent pas décrire le
            // fichier d'origine (sa taille, son empreinte) — ce n'est pas lui qu'un GET rendrait.
            context.Response.OnStarting(() =>
            {
                context.Response.Headers.Remove(HeaderNames.ETag);
                context.Response.Headers.Remove(HeaderNames.LastModified);
                context.Response.ContentLength = null;
                context.Response.Headers.CacheControl = "no-cache";
                return Task.CompletedTask;
            });
            await _next(context).ConfigureAwait(false);
            return;
        }

        // La réponse doit arriver entière et lisible : ni compressée, ni réduite à « rien n'a changé »
        // (le navigateur peut tenir une copie d'avant l'installation du plugin, ou d'avant qu'on le désactive).
        request.Headers.Remove(HeaderNames.AcceptEncoding);
        request.Headers.Remove(HeaderNames.IfNoneMatch);
        request.Headers.Remove(HeaderNames.IfModifiedSince);
        request.Headers.Remove(HeaderNames.Range);

        var response = context.Response;
        var downstream = response.Body;
        using var produced = new MemoryStream();
        response.Body = produced;
        try
        {
            await _next(context).ConfigureAwait(false);
        }
        finally
        {
            response.Body = downstream;
        }

        var body = produced.ToArray();
        if (response.StatusCode == StatusCodes.Status200OK
            && !response.Headers.ContainsKey(HeaderNames.ContentEncoding)
            && body.Length > 0 && body.Length <= MaxBytes)
        {
            var transformed = Transform(body, index, plugin.Version.ToString());
            if (transformed is not null)
            {
                body = transformed;
                // Ce n'est plus le fichier dont ces en-têtes parlaient ; et la réponse est toujours
                // revalidée, pour qu'activer ou désactiver le plugin se voie au prochain chargement.
                response.Headers.Remove(HeaderNames.ETag);
                response.Headers.Remove(HeaderNames.LastModified);
                response.Headers.Remove(HeaderNames.AcceptRanges);
                response.Headers.CacheControl = "no-cache";
            }
        }

        if (response.StatusCode != StatusCodes.Status304NotModified && response.StatusCode != StatusCodes.Status204NoContent)
        {
            response.ContentLength = body.Length;
        }

        if (body.Length > 0)
        {
            await downstream.WriteAsync(body).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// La page d'entrée du client web : <c>…/web/</c> ou <c>…/web/index.html</c>, quel que soit le
    /// préfixe d'adresse réglé sur le serveur — ce code passe avant que Jellyfin ne le retire.
    /// </summary>
    internal static bool IsWebIndex(string path)
    {
        return path.EndsWith("/web/", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// La réponse complétée, ou null quand elle doit partir telle qu'elle a été produite.
    /// </summary>
    private byte[]? Transform(byte[] body, bool index, string version)
    {
        try
        {
            var text = Encoding.UTF8.GetString(body);
            var transformed = index ? InjectScript(text, version) : AddPlugin(text);
            if (transformed is null)
            {
                Warn((index ? "la page du client web" : "config.json") + " n'a pas la forme attendue : servi sans Lumen.");
                return null;
            }

            return ReferenceEquals(transformed, text) ? null : Encoding.UTF8.GetBytes(transformed);
        }
        catch (JsonException ex)
        {
            Warn("config.json est illisible (" + ex.Message + ") : servi sans Lumen.");
            return null;
        }
    }

    /// <summary>
    /// Ajoute le script juste après l'ouverture de l'en-tête : il doit s'exécuter avant ceux de
    /// jellyfin-web. L'adresse est relative à la page (<c>…/web/</c>) : elle tient sous n'importe quel
    /// préfixe d'adresse. Une page qui le porte déjà est rendue telle quelle.
    /// </summary>
    internal static string? InjectScript(string html, string version)
    {
        if (html.Contains(ScriptMarker, StringComparison.Ordinal))
        {
            return html;
        }

        var head = html.IndexOf("<head", StringComparison.OrdinalIgnoreCase);
        var end = head < 0 ? -1 : html.IndexOf('>', head);
        if (end < 0)
        {
            return null;
        }

        var script = "<script>window.LumenConfig={build:\"" + version + "\"}</script>"
            + "<script src=\"../" + ScriptMarker + "?v=" + version + "\"></script>";
        return html.Insert(end + 1, script);
    }

    /// <summary>
    /// Ajoute le lecteur à la liste <c>plugins</c> de la configuration du client web. jellyfin-web charge
    /// chaque nom de cette liste, et prend dans <c>window</c> celui qui s'y trouve : c'est la porte prévue
    /// pour un lecteur qui ne fait pas partie de ses fichiers.
    /// </summary>
    internal static string? AddPlugin(string json)
    {
        if (JsonNode.Parse(json) is not JsonObject config || config["plugins"] is not JsonArray plugins)
        {
            return null;
        }

        foreach (var entry in plugins)
        {
            if (entry is JsonValue value && value.TryGetValue<string>(out var name) && name == PluginName)
            {
                return json;
            }
        }

        plugins.Add(PluginName);
        return config.ToJsonString();
    }

    private void Warn(string message)
    {
        if (_warned)
        {
            return;
        }

        _warned = true;
        _logger.LogWarning("Lumen : {Message}", message);
    }
}
