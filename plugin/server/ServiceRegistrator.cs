using System;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Lumen.Jellyfin;

/// <summary>
/// Place le traitement des deux fichiers du client web en tête de la chaîne de traitement des requêtes.
///
/// Jellyfin n'offre pas de point d'accroche pour modifier la page de son client web. Il laisse en
/// revanche un plugin inscrire des services au démarrage, et ASP.NET applique tout <see cref="IStartupFilter"/>
/// inscrit avant de construire la chaîne : c'est la seule porte qui ne demande ni de réécrire un fichier
/// du serveur, ni de modifier son code en mémoire.
/// </summary>
public class ServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddTransient<IStartupFilter, WebClientStartupFilter>();
        serviceCollection.AddHostedService<FfmpegCpuMeter>();
    }
}

internal sealed class WebClientStartupFilter : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.UseMiddleware<WebClientMiddleware>();
            next(app);
        };
    }
}
