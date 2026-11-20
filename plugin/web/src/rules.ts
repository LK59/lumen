// Les règles du pont qui ne touchent ni au navigateur ni à jellyfin-web : ce qui se teste sans eux.

/**
 * Le nom sous lequel le lecteur s'annonce : `window[PLUGIN_NAME]`, et l'entrée que le plugin serveur
 * ajoute à la liste `plugins` de `config.json` (la même chaîne, écrite dans WebClientMiddleware.cs).
 */
export const PLUGIN_NAME = "lumenPlayer";

export interface JellyfinItem {
  Id?: string;
  ServerId?: string;
  MediaType?: string;
  Name?: string;
  SeriesName?: string;
  Type?: string;
  LocationType?: string;
  VideoType?: string;
  IsPlaceHolder?: boolean;
  MediaSources?: JellyfinMediaSource[];
}

export interface JellyfinMediaStream {
  Type?: string;
  Index?: number;
  IsExternal?: boolean;
  Codec?: string;
  VideoRangeType?: string;
}

export interface JellyfinMediaSource {
  Id?: string;
  Size?: number;
  ETag?: string;
  Protocol?: string;
  IsRemote?: boolean;
  DefaultAudioStreamIndex?: number | null;
  MediaStreams?: JellyfinMediaStream[];
}

/**
 * Lumen lit-il ce genre d'élément ? Un fichier vidéo de la bibliothèque, et rien d'autre : ni chaîne
 * en direct ni enregistrement en cours (pas de fichier fini à lire par plages), ni dossier de disque
 * (DVD, Blu-ray, ISO : plusieurs fichiers), ni élément sans fichier. Pour tout le reste, ce lecteur ne
 * se propose pas et celui de jellyfin-web est choisi comme avant.
 */
export function eligible(item: JellyfinItem | null | undefined): boolean {
  if (!item?.Id || item.MediaType !== "Video" || item.IsPlaceHolder) return false;
  if (item.LocationType && item.LocationType !== "FileSystem") return false;
  if (item.VideoType && item.VideoType !== "VideoFile") return false;
  return !["TvChannel", "LiveTvChannel", "Program", "LiveTvProgram", "Recording"].includes(item.Type ?? "");
}

/**
 * L'adresse du fichier brut. Écrite par le pont, la même à la vérification et à la lecture, et sans
 * jeton : le moteur garde ce qu'il a lu d'un fichier sous son adresse (en-tête, premiers morceaux), et
 * une adresse qui changerait d'un appel à l'autre lui ferait tout relire. Le jeton part en en-tête.
 */
export function streamAddress(server: string, itemId: string, mediaSourceId: string): string {
  return `${server.replace(/\/+$/, "")}/Videos/${encodeURIComponent(itemId)}/stream?static=true&mediaSourceId=${encodeURIComponent(mediaSourceId)}`;
}

/**
 * Le profil annoncé au serveur pour un fichier que Lumen vient d'accepter : lecture directe, quels
 * que soient le conteneur et les codecs.
 *
 * Le profil ordinaire de jellyfin-web décrit ce que l'élément `<video>` lit seul ; avec lui, le serveur
 * répond « transcodage » pour un MKV en DTS. Ici la question a déjà été posée au moteur, sur le fichier
 * lui-même : inutile de la reposer au serveur par une liste de codecs, il suffit qu'il ne s'y oppose
 * pas. Tout le reste du profil est gardé — le débit maximal (un spectateur qui a choisi une qualité
 * réduite l'obtient toujours : le serveur refuse alors la lecture directe et ce lecteur se comporte
 * comme celui de jellyfin-web), les profils de transcodage (le repli) et de sous-titres.
 */
export function lumenProfile<T extends Record<string, unknown>>(base: T): T {
  return { ...base, DirectPlayProfiles: [{ Type: "Video" }], CodecProfiles: [], ContainerProfiles: [] };
}

/**
 * Le numéro de piste, pour le moteur, du flux son que Jellyfin désigne par son index.
 *
 * Les deux ne se correspondent pas : l'index de Jellyfin compte tous les flux du fichier (et les
 * sous-titres externes après eux), le numéro est celui que le conteneur donne à la piste — sur un
 * fichier dont le son précède l'image, la piste 1 est du son. Ce qui se correspond, c'est l'ordre :
 * le n-ième flux son interne est la n-ième piste son. `null` quand rien ne se retrouve — le moteur
 * ouvre alors sur la piste qu'il choisit lui-même.
 */
export function audioTrackFor(streams: JellyfinMediaStream[] | undefined, wantedIndex: number | null | undefined, trackNumbers: number[]): number | null {
  if (wantedIndex === null || wantedIndex === undefined || wantedIndex < 0) return null;
  const internal = (streams ?? []).filter((s) => s.Type === "Audio" && !s.IsExternal).sort((a, b) => (a.Index ?? 0) - (b.Index ?? 0));
  const rank = internal.findIndex((s) => s.Index === wantedIndex);
  // Autant de flux que de pistes, sinon l'ordre ne prouve rien : mieux vaut laisser le moteur choisir.
  if (rank < 0 || internal.length !== trackNumbers.length) return null;
  return trackNumbers[rank] ?? null;
}
