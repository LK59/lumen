// L'API publique de lumen-core : ce qu'un hôte (page de test, pont jellyfin-web) a le droit d'importer.
//
// Petite exprès. Tout le reste de `engine/` peut changer de forme d'une version à l'autre ; ce qui est
// nommé ici est le contrat. Un hôte qui a besoin d'autre chose le demande ici plutôt que d'aller le
// chercher dans un fichier interne.

// --- ce que l'hôte fournit au moteur -------------------------------------------------------------
export { configureHost, type LumenHost, type LinkShaper } from "./host";

// --- ouvrir un fichier et le lire ----------------------------------------------------------------
// `probePlaybackPath` ouvre l'adresse, lit l'en-tête et décide ; elle rejette avec un motif nommé quand
// ce chemin ne porte pas le fichier (à l'hôte de passer la main à un autre lecteur). `start(video)`
// rend le `RemuxPlayback` : pistes, sous-titres, sauts, changement de piste, `destroy`.
export { probePlaybackPath, RemuxPlayback, type RemuxPlaybackOptions, type PathProbe } from "./engine/remuxPlayback";
export type { PlayerTrack } from "./engine/playerTrack";
export type { PlayerWarning } from "./engine/playerWarning";
export type { DialogueMode } from "./engine/dialogueEnhance";
export type { TrackPreferences } from "./support/trackPreferences";
export { NetworkUnavailable, SessionEnded } from "./engine/byteSource";

// --- sous-titres dans un fichier à part ----------------------------------------------------------
export { ExternalSubtitleTrack, type ExternalSubtitleSource } from "./engine/externalSubtitles";

// --- ce que le moteur dit de lui-même ------------------------------------------------------------
// Le journal d'une ouverture (en mémoire, borné) et l'état du réseau vu par les requêtes du fichier.
export { traceText, traceRecent, traceElapsed } from "./engine/trace";
export { subscribeNetworkTrouble, networkUnstable } from "./support/networkTrouble";

// --- facultatif ----------------------------------------------------------------------------------
// Télécharger d'avance, hors de tout film, les décodeurs WebAssembly qu'un premier film attendrait.
export { warmPlayerDecoders } from "./engine/decoderWarmup";
