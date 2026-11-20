// Le journal d'une lecture : ce que le spectateur a attendu, quel que soit le lecteur.
//
// Le pont est le lecteur choisi par jellyfin-web dans les deux cas — quand Lumen lit, et quand il rend
// la main au lecteur de jellyfin-web dont il hérite. Les mêmes mesures, prises au même endroit, valent
// donc pour les deux : c'est ce qui permet de comparer « avec » et « sans » sur les lectures réelles
// d'un foyer plutôt que sur un banc.
//
// Ici, seulement le décompte — sans navigateur ni horloge à lui, chaque appel reçoit ses durées.

/** Une lecture, telle qu'elle est envoyée au plugin à l'arrêt. Les durées sont en millisecondes. */
export interface PlaybackEntry {
  itemId: string;
  title: string;
  /** Qui a lu : le moteur, ou le lecteur de jellyfin-web. */
  player: "lumen" | "jellyfin";
  /** Ce que le serveur a servi : `DirectPlay`, `DirectStream`, `Transcode`. */
  playMethod: string | null;
  /** Pourquoi le serveur transcode (`TranscodeReasons` de l'adresse du flux), s'il transcode. */
  transcodeReasons: string | null;
  /** Pourquoi Lumen n'a pas lu, quand il a refusé le fichier ; null s'il a lu ou n'était pas sollicité. */
  refusal: string | null;
  /** Ce que Lumen a fait du son (copié, décodé puis réencodé…), quand c'est lui qui lit. */
  audio: string | null;
  /** Du geste de lecture à la première image. Null si aucune image n'est venue. */
  firstFrameMs: number | null;
  /**
   * Où le temps de l'ouverture est passé : chaque étape en millisecondes depuis le geste de lecture
   * (`profile`, `settings`, `check` : la vérification du fichier ; `negotiated` : le serveur a répondu ;
   * `play`, `probed`, `started`, `released` : l'ouverture du moteur). Null avant la première image.
   */
  openingSteps: Record<string, number> | null;
  /** Chaque saut, de l'ordre à la première image après lui. */
  seeksMs: number[];
  /** Chaque changement de flux en cours de lecture (piste son, qualité, repli) jusqu'à l'image suivante. */
  streamChangesMs: number[];
  /** Les arrêts de l'image en pleine lecture, hors sauts et changements : leur nombre et leur durée. */
  waits: number;
  waitsMs: number;
  /** Les secondes de film réellement jouées. */
  watchedSeconds: number;
  /** Une erreur de lecture a-t-elle fait renégocier le flux ? */
  errors: number;
}

/** En dessous, une attente ne se voit pas : le navigateur en signale de très brèves en continu. */
export const MIN_WAIT_MS = 250;

/** Le nombre de sauts et de changements gardés par lecture : une ligne de journal reste une ligne. */
const KEPT = 50;

export class PlaybackRecorder {
  private entry: PlaybackEntry;

  constructor(itemId: string, title: string) {
    this.entry = { itemId, title, player: "jellyfin", playMethod: null, transcodeReasons: null, refusal: null, audio: null, firstFrameMs: null, openingSteps: null, seeksMs: [], streamChangesMs: [], waits: 0, waitsMs: 0, watchedSeconds: 0, errors: 0 };
  }

  get itemId(): string {
    return this.entry.itemId;
  }

  /** Une image est-elle déjà venue ? Avant elle, tout arrêt fait partie de l'ouverture. */
  get opened(): boolean {
    return this.entry.firstFrameMs !== null;
  }

  /** Ce que le serveur sert pour ce flux — redit à chaque changement de flux, le dernier compte. */
  stream(facts: { player: "lumen" | "jellyfin"; playMethod: string | null; transcodeReasons: string | null; audio: string | null }): void {
    Object.assign(this.entry, facts);
  }

  refused(reason: string): void {
    this.entry.refusal = reason.slice(0, 300);
  }

  /** La première image d'un flux : celle de l'ouverture, ou celle qui suit un changement de flux. */
  frame(ms: number): void {
    if (this.entry.firstFrameMs === null) this.entry.firstFrameMs = Math.round(ms);
    else if (this.entry.streamChangesMs.length < KEPT) this.entry.streamChangesMs.push(Math.round(ms));
  }

  opening(steps: Record<string, number>): void {
    this.entry.openingSteps = steps;
  }

  seek(ms: number): void {
    if (this.entry.seeksMs.length < KEPT) this.entry.seeksMs.push(Math.round(ms));
  }

  wait(ms: number): void {
    if (ms < MIN_WAIT_MS) return;
    this.entry.waits += 1;
    this.entry.waitsMs += Math.round(ms);
  }

  watched(seconds: number): void {
    // Un écart d'horloge de plus de deux secondes entre deux relevés est un saut, pas du film regardé.
    if (seconds > 0 && seconds < 2) this.entry.watchedSeconds += seconds;
  }

  error(): void {
    this.entry.errors += 1;
  }

  finish(): PlaybackEntry {
    return { ...this.entry, watchedSeconds: Math.round(this.entry.watchedSeconds) };
  }
}

/** Les raisons du transcodage, lues dans l'adresse que le serveur a rendue. */
export function transcodeReasonsOf(url: string | undefined): string | null {
  const match = /[?&]TranscodeReasons=([^&]+)/i.exec(url ?? "");
  return match ? decodeURIComponent(match[1]) : null;
}
