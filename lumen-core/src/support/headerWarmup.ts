/**
 * L'en-tête et l'index d'un fichier, lus avant que quiconque demande à le lire — pendant que sa fiche
 * est à l'écran, par exemple.
 *
 * Repris de Laterna (`sheetHeaderWarmup.ts`), où il a été mesuré du 20 au 28/10/2026 sur 298 ouvertures :
 * l'en-tête et l'index (deux plages aux deux bouts du fichier, 1 à 3 Mo) coûtaient 1,1 s médians depuis
 * le réseau, 6 s sur un lien lent — et entre l'ouverture d'une fiche et l'appui sur « Lire », il y a ce
 * temps-là. Ici, banc du 24/11/2026 : une vérification dont l'en-tête est déjà connu répond sans un octet
 * lu, contre 130 ms en local et 450 ms à 40 ms de latence.
 *
 * L'en-tête lu est gardé là où l'ouverture le cherche déjà (le cache d'en-têtes, nommé par
 * `mediaHeaderKey`). Les morceaux lus le sont aussi, quelques minutes, quand la version du fichier est
 * connue (`HttpByteSource.closePrepared`) — c'est ce qui diffère de Laterna, où ils mouraient avec la
 * source : le premier morceau porte les premières images, et l'ouverture le redemandait.
 *
 * Retenu exprès, comme dans Laterna :
 * - **un délai d'abord** : une fiche traversée ne coûte rien ;
 * - **un fichier à la fois** : la préparation suivante coupe la précédente ;
 * - **coupée par l'appelant** quand la fiche se ferme ou qu'un film s'ouvre — l'ouverture lit l'en-tête
 *   elle-même ;
 * - ni page cachée, ni « économiseur de données » ;
 * - sans lecture en avance : elle téléchargerait plusieurs mégaoctets pour un film qu'on ne lancera
 *   peut-être pas.
 * Un échec ne coûte rien : l'ouverture lit l'en-tête elle-même, comme avant.
 */

import { CHUNK_SIZE, holdsHandover, holdsPrepared, HttpByteSource } from "../engine/byteSource";
import { keptRangeAt } from "../engine/matroska";
import { mediaHeaderKey, openMediaFile } from "../engine/mediaFile";
import { trace } from "../engine/trace";

/** Le temps laissé avant de lire quoi que ce soit. */
export const HEADER_WARMUP_DELAY_MS = 1000;

/** Le fichier à préparer : les mêmes trois valeurs que l'ouverture donnera (`RemuxPlaybackOptions`). */
export interface HeaderWarmupFile {
  streamUrl: string;
  knownSize?: number | null;
  fileVersion?: string | null;
  /**
   * Où ce compte s'était arrêté, s'il s'était arrêté : les deux premiers morceaux de cette position sont
   * lus aussi, pour que « Reprendre » n'ait pas à les attendre. Zéro ou absent : rien de plus que l'en-tête.
   */
  resumeSeconds?: number | null;
}

/** Au plus tant de morceaux (de 1 Mio) lus pour la zone de reprise. */
const RESUME_ZONE_CHUNKS = 7;
/** En deçà, une reprise est un départ du début : le premier morceau la porte déjà. */
const RESUME_FROM_SECONDS = 5;

/** La préparation en cours — une seule : la suivante l'arrête. */
let current: AbortController | null = null;

/** L'appareil demande-t-il d'économiser ses données ? (Chromium seulement ; ailleurs, non.) */
function savesData(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

/**
 * Prépare l'en-tête de `file` après `delayMs`, sauf si l'arrêt rendu est appelé avant.
 *
 * @returns de quoi tout arrêter — à appeler quand la fiche se ferme, change de titre, ou qu'un film s'ouvre.
 */
export function scheduleHeaderWarmup(file: HeaderWarmupFile, delayMs = HEADER_WARMUP_DELAY_MS): () => void {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    if (controller.signal.aborted || document.hidden || savesData()) return;
    void warmHeader(file, controller);
  }, delayMs);
  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}

/** Exportée pour les tests ; ailleurs, passer par `scheduleHeaderWarmup`. */
export async function warmHeader(file: HeaderWarmupFile, controller: AbortController): Promise<void> {
  current?.abort();
  current = controller;
  const { signal } = controller;
  try {
    // Le film vient de se fermer et sa fiche réapparaît : ses octets attendent la réouverture dans le
    // relais, et ouvrir une source les lui prendrait (`HttpByteSource.open`) pour les jeter aussitôt.
    // Son en-tête est de toute façon dans le cache.
    if (holdsHandover(file.streamUrl)) return;
    // Sous sa version, le fichier est déjà préparé : rouvrir la fiche ne relit rien.
    const key = mediaHeaderKey(file.streamUrl, file.fileVersion);
    if (file.fileVersion && holdsPrepared(key)) return;
    const startedAt = Date.now();
    const source = (await HttpByteSource.open(file.streamUrl, file.knownSize ?? null, null)).withoutReadahead();
    // `close(false)` : ses morceaux ne prennent pas la place unique du relais, et ses requêtes en cours
    // meurent avec elle.
    const stop = () => source.close(false);
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (signal.aborted) return;
      const parsed = await openMediaFile(source, key);
      if (signal.aborted) return;
      const resume = file.resumeSeconds ?? 0;
      if (resume > RESUME_FROM_SECONDS) {
        // La zone de reprise : du groupe d'images où elle tombe (son image clé, que le décodeur relit
        // d'abord) jusqu'à l'image clé suivante — ce qu'une ouverture à cette position lit avant de
        // montrer quoi que ce soit. Banc du 24/11/2026 : six morceaux pour un film à 6 Mb/s, demandés
        // l'un après l'autre par le son puis par l'image, soit 0,9 s à 40 ms de latence. Bornée : un
        // groupe d'images très long ne fait pas télécharger des dizaines de mégaoctets depuis une fiche.
        const zone = keptRangeAt(parsed, resume, parsed.tracks.find((t) => t.type === "video")?.number, 0);
        if (zone) {
          // Un morceau avant : le son s'amorce une grappe plus tôt que l'image.
          const first = Math.max(0, Math.floor(zone.from / CHUNK_SIZE) - 1);
          const last = Math.min(Math.floor(Math.min(zone.to, source.size - 1) / CHUNK_SIZE), first + RESUME_ZONE_CHUNKS - 1);
          await Promise.all(Array.from({ length: last - first + 1 }, (_, i) => source.read((first + i) * CHUNK_SIZE, 1)));
        }
        if (signal.aborted) return;
      }
      trace(`fiche : en-tête et index préparés en ${Date.now() - startedAt} ms`);
      // Ce qui vient d'être lu est gardé pour l'ouverture, sous la version du fichier. Sans version, rien
      // ne dit que ce sera encore le même fichier : les octets meurent avec la source, comme avant.
      if (file.fileVersion) source.closePrepared(key);
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
    }
  } catch {
    // Préparer n'est pas lire : l'ouverture refera la lecture, comme avant.
  } finally {
    if (current === controller) current = null;
  }
}

/** Pour les tests : l'état d'une page neuve. */
export function forgetHeaderWarmups(): void {
  current?.abort();
  current = null;
}
