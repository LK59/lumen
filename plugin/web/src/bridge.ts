// Le pont entre jellyfin-web et lumen-core.
//
// Un seul script classique, chargé AVANT les scripts de jellyfin-web. Il fait trois choses :
//
//   1. il s'annonce : `window.lumenPlayer` rend la classe du lecteur. jellyfin-web la charge parce que
//      ce nom figure dans la liste `plugins` de son `config.json` — c'est le serveur (le plugin) qui l'y
//      ajoute ; ce script n'y touche pas ;
//   2. il devient un lecteur vidéo de jellyfin-web : il hérite de celui de jellyfin-web
//      (`htmlvideoplayer`) et n'en remplace que la source — le fichier brut remuxé par Lumen à la place
//      de `<video src>` ou de hls.js. Interface, sous-titres, volume, plein écran, rapport de progression
//      au serveur : tout cela reste le code de jellyfin-web, sur le même élément `<video>` ;
//   3. il mesure : quel que soit celui qui lit, il relève ce que le spectateur a attendu (première image,
//      sauts, arrêts) et l'envoie au plugin, si son journal est allumé (journal.ts) ;
//   4. il rend la main : pour un fichier que Lumen refuse (le refus est nommé), il annonce au serveur le
//      profil ordinaire de jellyfin-web et se comporte exactement comme son lecteur.
//
// Rien ici n'est une API publique de jellyfin-web : c'est son fonctionnement interne, lu dans la version
// visée (voir docs/jellyfin-web-bridge.md). Chaque hypothèse est vérifiée à l'exécution, et quand l'une
// tombe le pont se retire en le disant dans la console — jellyfin-web lit alors comme sans lui.
import type * as LumenCore from "../../../lumen-core/src/index";
import { PlaybackRecorder, transcodeReasonsOf } from "./journal";
import { PLUGIN_NAME, audioTrackFor, eligible, lumenProfile, streamAddress, televisionClient, type JellyfinItem, type JellyfinMediaSource } from "./rules";

type Core = typeof LumenCore;
type Playback = Awaited<ReturnType<Awaited<ReturnType<Core["probePlaybackPath"]>>["start"]>>;

interface Config {
  /** Faux : le pont s'inscrit mais ne lit rien — jellyfin-web lit seul. */
  enabled: boolean;
  /** Le dossier d'où charger `lumen-core.js` ; par défaut, celui de ce script. */
  base: string;
  /** Le nom du code livré, pour ce que le moteur retient d'un navigateur. */
  build: string;
}

/** Ce que jellyfin-web donne à un plugin chargé par `window`. Seul ce qui sert ici est décrit. */
interface Deps {
  events: { trigger(target: object, name: string, args?: unknown[]): void };
  playbackManager: { getPlayers(): Array<{ id?: string; constructor: Function }> };
  ServerConnections: { getApiClient(serverId?: string): { accessToken(): string; serverAddress(): string; getCurrentUserId(): string } };
}

/** Les options que jellyfin-web passe à `play` puis `setCurrentSrc` (son « streamInfo »). */
interface StreamInfo {
  url?: string;
  playMethod?: string;
  mediaType?: string;
  playerStartPositionTicks?: number;
  item?: JellyfinItem;
  mediaSource?: JellyfinMediaSource;
}

/** Ce que Lumen a répondu pour un élément : il le porte (et ses pistes son), ou non (et pourquoi). */
interface Verdict {
  at: number;
  ok: boolean;
  reason?: string;
  mediaSourceId: string;
  audioTracks: number[];
}

interface State {
  deps: Deps;
  /** Le lecteur de jellyfin-web est-il adopté ? `null` : pas encore essayé ; faux : impossible, dit une fois. */
  adopted: boolean | null;
  playback: Playback | null;
  /** Compte les ouvertures : une ouverture dépassée par la suivante se défait sans rien toucher. */
  opening: number;
  verdicts: Map<string, Verdict>;
  /** Par serveur et compte : les réglages du plugin pour lui, et l'instant où ils ont été demandés. */
  settings: Map<string, { at: number; answer: Promise<Settings> }>;
  /** Le journal de la lecture en cours, quand le plugin en tient un. */
  recorder: PlaybackRecorder | null;
  /** Le serveur de l'élément journalisé : c'est à lui que la lecture est envoyée à l'arrêt. */
  recorderServerId: string | undefined;
  /** L'instant où jellyfin-web a commencé à préparer le flux en cours (sa demande de profil). */
  askedAt: number | null;
  /**
   * Les étapes de l'ouverture en cours, en millisecondes depuis `askedAt`, pour le journal. La première
   * image seule ne disait pas où le temps passait : trois fichiers différents ouverts en 3 545, 3 549 et
   * 3 553 ms (Chrome, 20/11/2026) montraient un délai fixe sans qu'on puisse dire lequel.
   */
  /**
   * La cible du dernier saut confié au moteur, tant qu'il ne l'a pas servi. jellyfin-web calcule un saut
   * relatif (« avance rapide ») depuis la position qu'on lui rend : rendue depuis la tête, qui n'a pas
   * encore bougé, deux appuis rapprochés n'en valaient qu'un (602 s → 637 s au lieu de 662 s, au banc).
   */
  seekTarget: number | null;
  steps: Record<string, number>;
  stepsFrom: number;
  /** L'élément de la lecture en cours, et ce qui fait qu'un arrêt de l'image n'est pas une attente. */
  element: HTMLVideoElement | null;
  busy: number;
  /**
   * L'élément pour lequel le profil de Lumen vient d'être annoncé au serveur, le temps d'une négociation.
   * C'est lui, et non un verdict gardé d'une lecture précédente, qui autorise Lumen à prendre la source :
   * un fichier que Jellyfin lit lui-même en direct (un MP4) revenait avec `DirectPlay` quoi qu'on ait
   * annoncé, et Lumen le lisait encore sur la foi d'un ancien verdict, « Play with Lumen » décoché.
   */
  offered: string | null;
  /** Ce que Lumen lit en ce moment, gardé pour pouvoir le rouvrir — voir `rebuild`. */
  current: { element: HTMLVideoElement; options: StreamInfo; verdict: Verdict } | null;
  /** Les reconstructions récentes : leur instant et leur position, pour en borner le nombre. */
  rebuilds: { at: number; seconds: number }[];
  /** Une reconstruction est en cours : la position où elle rouvre, que le lecteur rend en attendant. */
  rebuilding: number | null;
  /** Un saut demandé pendant une reconstruction, servi dès qu'elle aboutit. */
  seekAfterRebuild: number | null;
  /** La dernière position jouée : une source perdue peut avoir remis l'horloge de l'élément à zéro. */
  lastPosition: number;
  /**
   * Le film était-il en pause, d'après le dernier geste vu sur une source vivante ? L'élément lui-même ne
   * le dit plus après une perte : une source retirée le remet « en pause » quoi qu'il en fût.
   */
  wasPaused: boolean;
  /** La main a déjà été rendue à jellyfin-web pour ce flux : deux pannes ne font pas deux renégociations. */
  handedOver: boolean;
  /** Ce que la lecture en cours fait d'une plage que le serveur refuse — voir `open`. */
  onRangeRefused: ((status: number) => void) | null;
}

/** Ce que le plugin répond pour un compte : Lumen lit-il pour lui, et ses lectures sont-elles journalisées ? */
interface Settings {
  enabled: boolean;
  journal: boolean;
}

const w = window as unknown as Record<string, any>;
const script = document.currentScript as HTMLScriptElement | null;
const config: Config = { enabled: true, base: script?.src ? new URL(".", script.src).href : new URL("lumen/", document.baseURI).href, build: "dev", ...(w.LumenConfig ?? {}) };

const log = (...args: unknown[]) => console.info("[Lumen]", ...args);
const states = new WeakMap<object, State>();
/** Le lecteur que jellyfin-web a construit — un seul par page —, pour `window.Lumen.status()`. */
let instance: object | null = null;

/** Un refus vaut dix minutes : le temps d'une séance de navigation, pas celui d'un fichier remplacé. */
const VERDICT_MS = 10 * 60_000;
/** Le nombre de refus rapprochés du serveur après lequel la lecture est rendue à jellyfin-web. */
const REFUSALS_BEFORE_HANDOVER = 4;
/** Au-delà de ce délai sans refus, le compte repart de zéro : un incident passager n'est pas une panne. */
const REFUSAL_WINDOW_MS = 10_000;
/** Le temps pendant lequel une réponse des réglages vaut pour les questions qui suivent : une préparation de flux. */
const SETTINGS_MS = 5_000;
/** Au-delà, la vérification n'a pas répondu à temps : on lit comme jellyfin-web plutôt que de faire attendre. */
const CHECK_TIMEOUT_MS = 8_000;

// --- le moteur, chargé à la première vérification -------------------------------------------------

let core: Promise<Core> | null = null;

function loadCore(): Promise<Core> {
  // Une adresse calculée : rien à résoudre à la construction, le moteur reste un module à part, servi
  // à côté de ce script avec son worker et ses décodeurs.
  core ??= (import(/* @vite-ignore */ new URL("lumen-core.js", config.base).href) as Promise<Core>).catch((error) => {
    core = null;
    throw error;
  });
  return core;
}

// --- 2. le lecteur ------------------------------------------------------------------------------

/**
 * L'objet que jellyfin-web construit et enregistre au démarrage.
 *
 * À ce moment-là le lecteur vidéo de jellyfin-web n'est pas forcément chargé (les plugins le sont tous
 * en même temps), et sa classe n'est exportée nulle part : on ne peut pas en hériter d'avance. Ce
 * lecteur naît donc sans rien savoir lire, et se greffe sur celui de jellyfin-web la première fois qu'on
 * lui demande ce qu'il lit (`adopt`). C'est le même objet avant et après — jellyfin-web compare ses
 * lecteurs par identité et y accroche ses écouteurs à l'enregistrement.
 */
class LumenPlayer {
  name = "Lumen";
  type = "mediaplayer";
  id = "lumenplayer";
  /** Avant le lecteur de jellyfin-web (1) : à type de média égal, le premier de la liste est pris. */
  priority = -1;
  isLocalPlayer = true;

  constructor(deps: Deps) {
    states.set(this, { deps, adopted: null, playback: null, opening: 0, verdicts: new Map(), settings: new Map(), recorder: null, recorderServerId: undefined, askedAt: null, element: null, busy: 0, seekTarget: null, steps: {}, stepsFrom: 0, offered: null, current: null, rebuilds: [], rebuilding: null, seekAfterRebuild: null, lastPosition: 0, wasPaused: false, handedOver: false, onRangeRefused: null });
    instance = this;
  }

  canPlayMediaType(mediaType: string): boolean {
    return adopt(this) ? (this as unknown as Adopted).canPlayMediaType(mediaType) : false;
  }

  // jellyfin-web greffe `getVolume`/`setVolume` sur un lecteur qui ne les a pas, à l'enregistrement —
  // des propriétés de l'objet, qui masqueraient ensuite celles du lecteur adopté. Elles existent donc
  // d'avance ; rien ne les appelle tant que ce lecteur ne lit rien.
  getVolume(): number {
    return 100;
  }
  setVolume(): void {}
}

/** Le lecteur une fois adopté : les méthodes du lecteur de jellyfin-web, dont celles surchargées ici. */
interface Adopted {
  canPlayMediaType(mediaType: string): boolean;
  getDeviceProfile(item: JellyfinItem, options?: { isRetry?: boolean }): Promise<Record<string, unknown>>;
  setCurrentSrc(element: HTMLVideoElement, options: StreamInfo): Promise<void>;
  play(options: StreamInfo): Promise<void>;
  getStats?(): Promise<{ categories?: Array<{ type?: string; name?: string; stats: Array<{ label: string; value: string }> }> }>;
  currentTime(ms?: number): number | undefined;
  stop(destroyPlayer?: boolean): Promise<void>;
  destroy(): void;
}

/**
 * Greffe ce lecteur sur celui de jellyfin-web : son prototype devient un descendant du sien, et son
 * constructeur est rejoué sur cet objet (il y pose ses champs).
 *
 * Deux hypothèses, vérifiées : le lecteur `htmlvideoplayer` est enregistré, et sa classe peut être
 * appelée sur un objet existant (elle est compilée en fonction, pas en `class` native). Si l'une tombe
 * avec une autre version de jellyfin-web, ce lecteur reste sans rien lire et le dit — une fois.
 */
function adopt(self: LumenPlayer): boolean {
  const state = states.get(self)!;
  if (state.adopted !== null) return state.adopted;
  if (televisionClient(navigator.userAgent)) {
    // Les applications Jellyfin des téléviseurs affichent ce même client web, donc ce même script. Leur
    // navigateur est ancien et leur processeur modeste, alors que leur lecteur d'origine lit déjà les
    // fichiers tels quels : Lumen n'y a rien à gagner et n'y a jamais été essayé.
    state.adopted = false;
    log("téléviseur ou console : lecture laissée à jellyfin-web");
    return false;
  }
  const html = state.deps.playbackManager.getPlayers().find((player) => player.id === "htmlvideoplayer");
  // Pas encore chargé : on réessaiera à la prochaine question.
  if (!html) return false;
  const Base = html.constructor as { prototype: Adopted; call(target: object): void };
  const own = { ...self };
  const before = Object.getPrototypeOf(self);
  try {
    for (const name of ["getDeviceProfile", "setCurrentSrc", "play", "currentTime", "stop", "destroy", "canPlayMediaType"] as const) {
      if (typeof Base.prototype[name] !== "function") throw new Error(`le lecteur de jellyfin-web n'a pas de méthode « ${name} »`);
    }
    Object.setPrototypeOf(self, lumenPrototype(Base.prototype));
    Base.call(self);
    // Le constructeur a posé son nom, son identifiant et sa priorité : on reprend les nôtres, et les
    // écouteurs que jellyfin-web avait déjà accrochés à cet objet.
    const htmlName = String((self as { name: unknown }).name || "Html Video Player");
    Object.assign(self, own);
    // Le nom, lui, dit qui lit en ce moment. Le panneau « Playback Info » de jellyfin-web affiche le nom
    // du lecteur choisi — et ce lecteur est toujours choisi, même quand il laisse lire celui de
    // jellyfin-web : sous un nom fixe, le panneau annonçait « Lumen » pendant un transcodage.
    Object.defineProperty(self, "name", { configurable: true, enumerable: true, get: () => (state.playback ? "Lumen" : htmlName) });
    state.adopted = true;
    log("prêt — greffé sur le lecteur vidéo de jellyfin-web");
  } catch (error) {
    Object.setPrototypeOf(self, before);
    state.adopted = false;
    console.warn("[Lumen] inactif : le lecteur vidéo de cette version de jellyfin-web ne se laisse pas étendre —", error);
  }
  return state.adopted;
}

function lumenPrototype(base: Adopted): object {
  return Object.assign(Object.create(base), {
    canPlayMediaType(this: LumenPlayer, mediaType: string): boolean {
      return config.enabled && (mediaType ?? "").toLowerCase() === "video";
    },

    /** Seulement les fichiers vidéo de la bibliothèque : pour le reste, jellyfin-web prend son lecteur. */
    canPlayItem(this: LumenPlayer, item: JellyfinItem): boolean {
      return config.enabled && eligible(item);
    },

    /**
     * Le profil annoncé au serveur — c'est ici que se décide qui lira.
     *
     * jellyfin-web le demande avant de négocier la lecture. On pose donc la question au moteur à ce
     * moment-là, sur le fichier : s'il le porte, le profil dit « lecture directe » et le serveur répond
     * par l'adresse du fichier brut ; s'il le refuse, le profil est celui de jellyfin-web et tout se
     * passe comme sans Lumen, transcodage compris. Le refus ne coûte ainsi ni erreur à l'écran ni
     * seconde négociation.
     *
     * `isRetry` : jellyfin-web renégocie après une erreur de lecture, pour obtenir un transcodage. Ce
     * n'est plus le moment de proposer le chemin qui vient d'échouer.
     */
    async getDeviceProfile(this: LumenPlayer, item: JellyfinItem, options?: { isRetry?: boolean }): Promise<Record<string, unknown>> {
      const state = states.get(this)!;
      // Le chronomètre du journal part d'ici : c'est le premier geste de jellyfin-web vers son lecteur, et
      // la vérification du fichier par Lumen, qui suit, fait partie de ce que le spectateur attend.
      state.askedAt = performance.now();
      state.stepsFrom = state.askedAt;
      state.steps = {};
      state.offered = null;
      if (options?.isRetry) state.recorder?.error();
      const profile = await base.getDeviceProfile.call(this, item, options);
      step(state, "profile");
      if (!config.enabled || options?.isRetry || !eligible(item)) return profile;
      const allowed = (await settings(state, item)).enabled;
      step(state, "settings");
      if (!allowed) return profile;
      const verdict = await check(this, item);
      step(state, "check");
      if (!verdict?.ok) return profile;
      state.offered = item.Id ?? null;
      return lumenProfile(profile);
    },

    /**
     * La source. jellyfin-web appelle ceci avec l'élément `<video>` qu'il vient de créer et ce que le
     * serveur a répondu.
     *
     * Hors lecture directe d'un fichier accepté, c'est le lecteur de jellyfin-web tel quel. Sinon, sa
     * méthode est tout de même appelée — elle prépare les sous-titres, la piste son, l'état que le reste
     * du lecteur relit — mais sur un élément dont deux gestes sont détournés : poser `src` ne fait rien,
     * et `play()` ouvre Lumen sur le vrai élément avant de lancer la lecture. Un échec de l'ouverture
     * rejette `play()`, que jellyfin-web traite comme toute erreur de lecture : il renégocie.
     */
    /**
     * Le départ d'un flux : une ouverture, ou un changement de flux pendant la lecture (piste son,
     * qualité, repli). Rien n'est changé à ce que fait jellyfin-web ; le journal de la lecture s'ouvre ici.
     */
    async play(this: LumenPlayer, options: StreamInfo): Promise<void> {
      const state = states.get(this)!;
      const item = options.item;
      // Le serveur a répondu, jellyfin-web appelle son lecteur. Entre « check » et « negotiated » il y a
      // deux attentes distinctes, la négociation avec le serveur puis la création de l'élément vidéo :
      // 13 s y sont passées une fois (Chrome, 21/11/2026, 0,4 s d'ordinaire) sans qu'on sache dans laquelle.
      step(state, "answered");
      claimPlaybackAudio();
      if (item?.Id && (await settings(state, item)).journal) {
        if (state.recorder?.itemId !== item.Id) {
          flush(state);
          state.recorderServerId = item.ServerId;
          state.recorder = new PlaybackRecorder(item.Id, [item.SeriesName, item.Name].filter(Boolean).join(", "));
        }
        const verdict = state.verdicts.get(item.Id);
        if (verdict && !verdict.ok && verdict.reason) state.recorder.refused(verdict.reason);
      } else {
        state.recorder = null;
      }
      return base.play.call(this, options);
    },

    async setCurrentSrc(this: LumenPlayer, element: HTMLVideoElement, options: StreamInfo): Promise<void> {
      const state = states.get(this)!;
      // Un changement de flux rappelle cette méthode sans arrêt préalable : ce qui jouait se ferme d'abord.
      close(state);
      step(state, "negotiated");
      observe(state, element, options);
      alignSubtitles(state, element);
      const verdict = options.item?.Id ? state.verdicts.get(options.item.Id) : undefined;
      if (!config.enabled || options.playMethod !== "DirectPlay" || !verdict?.ok || !options.mediaSource?.Id || !options.item?.Id || state.offered !== options.item.Id) {
        return base.setCurrentSrc.call(this, element, options);
      }
      const self = this;
      const shield = new Proxy(element, {
        set(target, property, value) {
          // `src` et `autoplay` : c'est Lumen qui attache la source, et la lecture part quand elle est prête.
          if (property !== "src" && property !== "autoplay") (target as any)[property] = value;
          return true;
        },
        get(target, property) {
          if (property === "play") {
            return () => {
              state.current = { element: target, options, verdict };
              state.rebuilds = [];
              state.wasPaused = false;
              return open(self, target, options, verdict);
            };
          }
          // L'erreur de l'élément est l'affaire du moteur, qui a ses reprises ; il dit lui-même quand il
          // renonce (`onError`). Le lecteur de jellyfin-web, lui, basculerait au premier incident.
          if (property === "addEventListener") return (type: string, ...rest: unknown[]) => (type === "error" ? undefined : (target.addEventListener as Function)(type, ...rest));
          const value = (target as any)[property];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return base.setCurrentSrc.call(this, shield, options);
    },

    /** La position, en millisecondes. Un saut passe par le moteur ; la position lue est celle du film. */
    currentTime(this: LumenPlayer, ms?: number): number | undefined {
      const state = states.get(this)!;
      const playback = state.playback;
      const seeking = ms !== undefined && ms !== null;
      if (seeking) timeSeek(state);
      if (state.rebuilding !== null) {
        // Pendant une reconstruction, il n'y a pas de moteur à qui parler : le saut attend qu'elle
        // aboutisse, et la position rendue est celle où le film va reprendre — pas le zéro d'un élément vidé.
        if (seeking) state.seekAfterRebuild = ms / 1000;
        return seeking ? undefined : (state.seekAfterRebuild ?? state.rebuilding) * 1000;
      }
      if (!playback) return base.currentTime.call(this, ms);
      if (seeking) {
        const seconds = ms / 1000;
        const element = state.element;
        // Une cible déjà chargée : poser la tête suffit, et le moteur sert ce geste sans rien relire
        // (`onSeeking`, chemin « mémoire » — c'est par là que passent les commandes de Laterna). Son
        // `seek()`, lui, vide les tampons et recharge, même pour dix secondes déjà là. Seulement hors
        // d'un saut en cours : celui-ci va vider les tampons, et le dernier geste doit l'emporter.
        if (element && !playback.seekPending && !element.seeking && loadedAt(element, seconds)) {
          state.seekTarget = null;
          element.currentTime = seconds;
        } else {
          state.seekTarget = seconds;
          void playback.seek(seconds);
        }
        return undefined;
      }
      // Le moteur dit quand le saut est fini : il peut avoir posé la tête ailleurs que sur la cible.
      if (state.seekTarget !== null && !playback.seekPending) state.seekTarget = null;
      // Une source perdue a pu remettre l'horloge de l'élément à zéro : jellyfin-web, à qui la main
      // est rendue, reprendrait alors au début (constaté au banc : 602 s au lieu de 619 s).
      const position = playback.lost && playback.position === 0 ? state.lastPosition : playback.position;
      return (state.seekTarget ?? position) * 1000;
    },

    /**
     * Changer de piste son dans le tampon vivant : jamais. jellyfin-web renégocie alors le flux, et
     * rappelle `setCurrentSrc` avec la nouvelle piste et la position — la reconstruction que le moteur
     * demande de toute façon.
     */
    canSetAudioStreamIndex(this: LumenPlayer): boolean {
      if (states.get(this)!.playback) return false;
      return (base as unknown as { canSetAudioStreamIndex(): boolean }).canSetAudioStreamIndex.call(this);
    },

    /**
     * Les statistiques du panneau « Playback Info » : celles de jellyfin-web, et quand Lumen lit, ce que
     * le moteur fait du fichier — c'est là qu'on vérifie d'un coup d'œil qui lit, et comment.
     */
    async getStats(this: LumenPlayer) {
      const stats = (await base.getStats?.call(this)) ?? {};
      const diagnostics = states.get(this)!.playback?.diagnostics;
      if (!diagnostics) return stats;
      const lines = [
        ["Video", diagnostics["Vidéo"]],
        ["Audio", diagnostics["Audio"]?.replace(/ canaux?$/, " ch")],
        ["Audio handling", englishAudio(diagnostics["Traitement audio"])],
        ["Buffered ahead", diagnostics["Avance sur la tête"]],
      ].filter((line): line is [string, string] => !!line[1]);
      return { ...stats, categories: [...(stats.categories ?? []), { type: "lumen", name: "Lumen", stats: lines.map(([label, value]) => ({ label, value })) }] };
    },

    stop(this: LumenPlayer, destroyPlayer?: boolean): Promise<void> {
      releasePlaybackAudio();
      flush(states.get(this)!);
      close(states.get(this)!);
      return base.stop.call(this, destroyPlayer);
    },

    destroy(this: LumenPlayer): void {
      releasePlaybackAudio();
      flush(states.get(this)!);
      close(states.get(this)!);
      base.destroy.call(this);
    },
  });
}

/**
 * Sur iPhone et iPad : dire au système que ce que la page joue est un film.
 *
 * iOS range le son d'une page dans une catégorie. « Lecture » ignore le bouton silencieux, comme toute
 * application vidéo ; « ambiance » le respecte, comme un jeu. Laissé à lui-même (`auto`), WebKit choisit
 * d'après ce qu'il trouve dans la page — et dans l'application Jellyfin pour iOS, avec ce script présent,
 * il choisissait « ambiance » : aucun son en mode silencieux, que Lumen lise ou qu'il laisse lire
 * (constaté sur iPhone le 20/11/2026 ; le son revenait script retiré). La cause exacte de ce choix n'est
 * pas établie. La page le déclare donc elle-même le temps d'une lecture, par l'interface prévue pour
 * cela (`navigator.audioSession`, iOS 16.4 et suivants), et rend la main à l'arrêt.
 *
 * Absente ailleurs que sur les systèmes d'Apple : rien ne se passe.
 */
let audioSessionBefore: string | null = null;

function claimPlaybackAudio(): void {
  try {
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (!session || typeof session.type !== "string" || session.type === "playback") return;
    audioSessionBefore ??= session.type;
    session.type = "playback";
  } catch {
    /* un réglage du son refusé ne doit pas empêcher la lecture */
  }
}

function releasePlaybackAudio(): void {
  try {
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session && audioSessionBefore !== null) session.type = audioSessionBefore;
  } catch {
    /* rien */
  }
  audioSessionBefore = null;
}

/** Ce que le moteur fait du son, dit en anglais comme le reste du panneau de jellyfin-web. */
function englishAudio(text: string | undefined): string | undefined {
  if (text === "copié tel quel") return "copied as is";
  const encoded = /^décodé puis ré-encodé en (.+)$/.exec(text ?? "");
  return encoded ? `decoded here, re-encoded to ${encoded[1]}` : text;
}

function close(state: State, rebuilding = false): void {
  if (!rebuilding) {
    state.handedOver = false;
    state.current = null;
    state.rebuilding = null;
    state.seekAfterRebuild = null;
  }
  state.opening += 1;
  state.onRangeRefused = null;
  const playback = state.playback;
  state.playback = null;
  state.seekTarget = null;
  try {
    playback?.destroy();
  } catch (error) {
    console.warn("[Lumen] fermeture :", error);
  }
}

/**
 * Les réglages du plugin pour ce compte (sa page de réglages) : Lumen lit-il pour lui, et ses lectures
 * sont-elles journalisées ? Le script est le même pour tous ; c'est le serveur qui répond, d'après le jeton.
 *
 * Sans réponse — le script injecté à la main sur un serveur sans le plugin, ou un serveur muet —, Lumen
 * lit et rien n'est journalisé : il n'y a alors ni réglage à respecter ni journal où écrire. Un refus
 * d'authentification, lui, coupe les deux.
 */
function settings(state: State, item: JellyfinItem): Promise<Settings> {
  const api = state.deps.ServerConnections.getApiClient(item.ServerId);
  const key = `${api.serverAddress()}|${api.getCurrentUserId()}`;
  // Redemandés à chaque lecture (une préparation de flux pose plusieurs fois la question en quelques
  // millisecondes : celles-là partagent une réponse). Gardés pour la durée de la page, un interrupteur
  // basculé dans les réglages ne prenait effet qu'après un rechargement — et la lecture suivante, dans
  // le même onglet, se faisait encore à l'ancienne façon.
  const known = state.settings.get(key);
  let answer = known && Date.now() - known.at < SETTINGS_MS ? known.answer : null;
  if (!answer) {
    answer = fetch(`${api.serverAddress().replace(/\/+$/, "")}/Lumen/Settings`, { headers: { Authorization: `MediaBrowser Token="${api.accessToken()}"` } })
      .then(async (response): Promise<Settings> => {
        if (response.status === 401 || response.status === 403) return { enabled: false, journal: false };
        if (!response.ok) return { enabled: true, journal: false };
        const answered = (await response.json()) as { Enabled?: boolean; Journal?: boolean };
        if (answered.Enabled === false) log("lecture par jellyfin-web : Lumen ne lit pas pour ce compte (réglages du plugin)");
        return { enabled: answered.Enabled !== false, journal: answered.Journal === true };
      })
      .catch((): Settings => ({ enabled: true, journal: false }));
    state.settings.set(key, { at: Date.now(), answer });
  }
  return answer;
}

// --- le journal ---------------------------------------------------------------------------------

/** La prochaine image présentée par l'élément, une fois qu'il ne saute plus ; `null` au bout de `cap` ms. */
function nextFrame(element: HTMLVideoElement, cap = 120_000): Promise<number | null> {
  return new Promise((resolve) => {
    const until = performance.now() + cap;
    const arrived = () => {
      if (!element.seeking) return resolve(performance.now());
      if (performance.now() > until || !element.isConnected) return resolve(null);
      element.requestVideoFrameCallback?.(arrived);
    };
    if (typeof element.requestVideoFrameCallback !== "function") return resolve(null);
    element.requestVideoFrameCallback(arrived);
    setTimeout(() => resolve(null), cap);
  });
}

const watched = new WeakSet<HTMLVideoElement>();

/**
 * Mesure le flux qui démarre sur cet élément : sa première image, puis les arrêts de l'image et le film
 * joué. Les mêmes gestes pour les deux lecteurs — c'est l'élément `<video>` qu'on regarde, pas le moteur.
 * Mesure seulement : rien ici ne touche à la lecture, et rien ne lève.
 */
function observe(state: State, element: HTMLVideoElement, options: StreamInfo): void {
  const recorder = state.recorder;
  state.element = element;
  if (!recorder) return;
  try {
    const startedAt = state.askedAt ?? performance.now();
    state.askedAt = null;
    state.busy += 1;
    void nextFrame(element).then((at) => {
      state.busy -= 1;
      if (state.recorder !== recorder || at === null) return;
      recorder.stream({
        player: state.playback ? "lumen" : "jellyfin",
        playMethod: options.playMethod ?? null,
        transcodeReasons: transcodeReasonsOf(options.url),
        audio: state.playback?.diagnostics["Traitement audio"] ?? null,
      });
      if (!recorder.opened) recorder.opening({ ...state.steps });
      recorder.frame(at - startedAt);
    });
    if (watched.has(element)) return;
    watched.add(element);
    let waitingSince: number | null = null;
    let lastTime: number | null = null;
    element.addEventListener("waiting", () => {
      // Pendant une ouverture, un saut ou un changement de flux, l'arrêt a déjà sa mesure.
      if (state.busy === 0 && !element.seeking && state.recorder?.opened) waitingSince ??= performance.now();
    });
    const resumed = () => {
      if (waitingSince !== null) state.recorder?.wait(performance.now() - waitingSince);
      waitingSince = null;
    };
    element.addEventListener("playing", resumed);
    for (const type of ["pause", "play", "playing"]) {
      element.addEventListener(type, () => {
        if (state.playback && !state.playback.lost && state.rebuilding === null && element.readyState > 0) state.wasPaused = element.paused;
      });
    }
    element.addEventListener("seeking", () => (waitingSince = null));
    element.addEventListener("timeupdate", () => {
      if (state.playback && !element.seeking && element.currentTime > 0) state.lastPosition = element.currentTime;
      if (lastTime !== null) state.recorder?.watched(element.currentTime - lastTime);
      lastTime = element.currentTime;
    });
  } catch {
    /* une mesure ne devient pas une panne */
  }
}

const aligned = new WeakSet<HTMLVideoElement>();
const shifted = new WeakSet<TextTrackCue>();

/**
 * Cale les sous-titres de jellyfin-web sur l'image quand Lumen lit.
 *
 * Le remux pose l'image sur l'horloge du lecteur avec un retard fixe sur celle du fichier (les images
 * sont réordonnées avant d'être montrées : un quart de seconde sur du HEVC). Les sous-titres que
 * jellyfin-web reçoit du serveur sont datés sur l'horloge du fichier ; affichés tels quels, ils
 * devançaient l'image d'autant. Chaque réplique est donc décalée de ce retard, une fois.
 *
 * Seulement les répliques posées dans une piste de texte du navigateur, ce que fait jellyfin-web pour
 * les sous-titres texte sur ordinateur. Les sous-titres dessinés par ses propres moteurs (ASS, PGS) ont
 * leur horloge à eux, hors de portée d'ici : ils gardent cette avance.
 */
function alignSubtitles(state: State, element: HTMLVideoElement): void {
  if (aligned.has(element)) return;
  aligned.add(element);
  element.addEventListener("timeupdate", () => {
    try {
      const delay = state.playback?.presentationDelay ?? 0;
      if (!(delay > 0.02)) return;
      for (const track of Array.from(element.textTracks)) {
        const cues = track.cues;
        // Déjà fait pour cette piste : la première et la dernière réplique le disent sans tout relire.
        if (!cues || cues.length === 0 || (shifted.has(cues[0]!) && shifted.has(cues[cues.length - 1]!))) continue;
        for (const cue of Array.from(cues)) {
          if (shifted.has(cue)) continue;
          shifted.add(cue);
          // La fin d'abord : une réplique ne doit jamais, même un instant, finir avant de commencer.
          cue.endTime += delay;
          cue.startTime += delay;
        }
      }
    } catch {
      /* un sous-titre mal calé vaut mieux qu'une lecture interrompue */
    }
  });
}

/** Note une étape de l'ouverture — voir `State.steps`. La première image clôt le relevé. */
function step(state: State, name: string): void {
  if (!(name in state.steps)) state.steps[name] = Math.round(performance.now() - state.stepsFrom);
}

/** La marge gardée avant la fin d'une zone chargée : y poser la tête la laisserait aussitôt à sec. */
const LOADED_MARGIN_S = 1;

/** L'élément a-t-il déjà cette position en mémoire, avec de quoi jouer derrière ? */
function loadedAt(element: HTMLVideoElement, seconds: number): boolean {
  const spans = element.buffered;
  for (let i = 0; i < spans.length; i += 1) {
    if (seconds >= spans.start(i) && seconds <= spans.end(i) - LOADED_MARGIN_S) return true;
  }
  return false;
}

/** Un saut : de l'ordre à la première image présentée après lui. */
function timeSeek(state: State): void {
  const recorder = state.recorder;
  const element = state.element;
  if (!recorder || !element) return;
  const startedAt = performance.now();
  state.busy += 1;
  // L'élément n'est « en saut » qu'un instant après l'ordre : on attend qu'il l'ait pris avant de guetter l'image.
  setTimeout(() => {
    void nextFrame(element, 60_000).then((at) => {
      state.busy -= 1;
      if (state.recorder === recorder && at !== null) recorder.seek(at - startedAt);
    });
  }, 0);
}

/** Envoie la lecture au plugin, et ferme son journal. `keepalive` : la requête survit à la page qui se ferme. */
function flush(state: State): void {
  const recorder = state.recorder;
  state.recorder = null;
  if (!recorder) return;
  try {
    const entry = recorder.finish();
    // Rien à dire d'une lecture qui n'a ni montré d'image ni échoué.
    if (entry.firstFrameMs === null && entry.errors === 0 && !entry.refusal) return;
    // Le serveur de l'élément lu, retenu à l'ouverture : à l'arrêt, plus rien ne le nomme — et demander
    // « le serveur de rien » à jellyfin-web lève. Le journal restait vide, sans un mot.
    const api = state.deps.ServerConnections.getApiClient(state.recorderServerId);
    void fetch(`${api.serverAddress().replace(/\/+$/, "")}/Lumen/Journal`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", Authorization: `MediaBrowser Token="${api.accessToken()}"` },
      body: JSON.stringify(entry),
    }).catch(() => {});
  } catch (error) {
    // Une mesure ne devient pas une panne — mais un journal qui se tait doit pouvoir se comprendre.
    console.debug("[Lumen] journal non envoyé :", error);
  }
}

function hostFor(state: State, core: Core, item: JellyfinItem) {
  const api = state.deps.ServerConnections.getApiClient(item.ServerId);
  // Le jeton en en-tête, lu à chaque requête : jamais dans l'adresse, et toujours le jeton courant.
  core.configureHost({
    build: config.build,
    requestHeaders: () => ({ Authorization: `MediaBrowser Token="${api.accessToken()}"` }),
    rangeRefused: (status) => state.onRangeRefused?.(status),
  });
  return api;
}

/**
 * Lumen porte-t-il ce fichier ? La question est posée au moteur, qui ouvre le fichier et choisit son
 * chemin comme pour le lire, puis referme : ce qu'il a lu (en-tête, index, premiers morceaux) reste en
 * mémoire sous l'adresse du fichier et sert à l'ouverture qui suit.
 *
 * Rend `null` quand la question n'a pas pu être posée à temps (moteur introuvable, serveur muet) : ce
 * n'est pas un refus du fichier, et rien n'est retenu.
 */
async function check(self: LumenPlayer, item: JellyfinItem): Promise<Verdict | null> {
  const state = states.get(self)!;
  const id = item.Id!;
  const known = state.verdicts.get(id);
  if (known && Date.now() - known.at < VERDICT_MS) return known;
  const source = item.MediaSources?.find((s) => s.Id === id) ?? item.MediaSources?.[0];
  const mediaSourceId = source?.Id ?? id;
  let engine: Core;
  try {
    engine = await loadCore();
  } catch (error) {
    // Le moteur ne se charge pas : cela ne dit rien du fichier, et rien n'est retenu.
    log("moteur introuvable, lecture par jellyfin-web —", error instanceof Error ? error.message : error);
    return null;
  }
  try {
    const api = hostFor(state, engine, item);
    const video = source?.MediaStreams?.find((s) => s.Type === "Video");
    const asked = engine.probePlaybackPath({
      streamUrl: streamAddress(api.serverAddress(), id, mediaSourceId),
      knownSize: source?.Size ?? null,
      fileVersion: source?.ETag ?? null,
      videoRangeType: video?.VideoRangeType ?? null,
      startSeconds: 0,
      onError: () => {},
    });
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), CHECK_TIMEOUT_MS));
    const probe = await Promise.race([asked, timeout]);
    if (probe === "timeout") {
      // Arrivée trop tard, elle sera refermée ; son refus éventuel n'intéresse plus personne.
      void asked.then((late) => late.discard()).catch(() => {});
      log(`vérification trop longue (${CHECK_TIMEOUT_MS / 1000} s) — lecture par jellyfin-web`);
      return null;
    }
    const verdict: Verdict = { at: Date.now(), ok: true, mediaSourceId, audioTracks: probe.audioTracks.map((track) => track.number) };
    probe.discard();
    state.verdicts.set(id, verdict);
    return verdict;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Un réseau absent ou une session finie ne disent rien du fichier : ce n'est pas un refus à retenir.
    if (error instanceof engine.NetworkUnavailable || error instanceof engine.SessionEnded) {
      log("vérification impossible, lecture par jellyfin-web —", reason);
      return null;
    }
    const verdict: Verdict = { at: Date.now(), ok: false, reason, mediaSourceId, audioTracks: [] };
    state.verdicts.set(id, verdict);
    log("refus, lecture par jellyfin-web —", reason);
    return verdict;
  }
}

/** Ouvre Lumen sur l'élément et lance la lecture. C'est le `play()` que le lecteur de jellyfin-web attend. */
async function open(self: LumenPlayer, element: HTMLVideoElement, options: StreamInfo, verdict: Verdict, resume?: { seconds: number; paused: boolean }): Promise<void> {
  const state = states.get(self)!;
  const mine = ++state.opening;
  const item = options.item!;
  const source = options.mediaSource!;
  step(state, "play");
  const engine = await loadCore();
  const api = hostFor(state, engine, item);
  const video = source.MediaStreams?.find((s) => s.Type === "Video");
  const ask = (audioTrackNumber: number | null) =>
    engine.probePlaybackPath({
      streamUrl: streamAddress(api.serverAddress(), item.Id!, source.Id!),
      knownSize: source.Size ?? null,
      fileVersion: source.ETag ?? null,
      videoRangeType: video?.VideoRangeType ?? null,
      startSeconds: resume?.seconds ?? (options.playerStartPositionTicks ?? 0) / 1e7,
      // Une reconstruction ne relance pas un film que le spectateur avait mis en pause.
      startPaused: resume?.paused ?? false,
      audioTrackNumber,
      onWarning: (warning) => log("avertissement du moteur —", warning.code, warning.detail ?? ""),
      // Le moteur a épuisé ses reprises sur cette source. On la rouvre à la même position, quelques
      // fois ; au-delà, c'est une erreur de lecture pour jellyfin-web, qui renégocie et transcode.
      onError: (message, kind) => {
        if (states.get(self)!.opening !== mine) return;
        log("le moteur renonce —", message);
        void rebuild(self, kind === "network" ? "réseau" : "source perdue").then((rebuilt) => {
          if (!rebuilt) handOver(self, kind === "network" ? "network" : "mediadecodeerror");
        });
      },
    });
  // Un serveur qui refuse le fichier (403, 500…) n'est pas un réseau absent. Le moteur, lui, ne fait pas
  // la différence : il redemande, puis attend 48 s que le réseau revienne — c'est juste dans Laterna, où
  // l'autre lecteur a besoin du même réseau. Ici jellyfin-web sait transcoder : au quatrième refus
  // rapproché (le moteur a épuisé ses tentatives sur un morceau), on lui rend la main tout de suite.
  let refusals = 0;
  let lastRefusal = 0;
  state.onRangeRefused = (status) => {
    if (states.get(self)!.opening !== mine) return;
    const now = performance.now();
    refusals = now - lastRefusal > REFUSAL_WINDOW_MS ? 1 : refusals + 1;
    lastRefusal = now;
    if (refusals !== REFUSALS_BEFORE_HANDOVER) return;
    log(`le serveur refuse le fichier (statut ${status}) — lecture rendue à jellyfin-web`);
    handOver(self, "network");
  };
  // La piste que le serveur a retenue (préférences du compte, choix au menu), traduite pour le moteur.
  const known = verdict.mediaSourceId === source.Id ? verdict.audioTracks : [];
  let probe = await ask(audioTrackFor(source.MediaStreams, source.DefaultAudioStreamIndex, known));
  if (known.length === 0) {
    // Une autre version du fichier que celle vérifiée : ses pistes ne sont connues que maintenant.
    const wanted = audioTrackFor(source.MediaStreams, source.DefaultAudioStreamIndex, probe.audioTracks.map((track) => track.number));
    if (wanted !== null && wanted !== probe.audioTrack) {
      probe.discard();
      probe = await ask(wanted);
    }
  }
  if (state.opening !== mine) {
    probe.discard();
    return;
  }
  step(state, "probed");
  // jellyfin-web crée son élément avec `autoplay` : sur une source neuve, le navigateur relançait de
  // lui-même un film rouvert en pause, sans qu'aucun `play()` ne soit appelé.
  if (resume?.paused) element.autoplay = false;
  const playback = await probe.start(element);
  step(state, "started");
  if (state.opening !== mine) {
    playback.destroy();
    return;
  }
  state.playback = playback;
  // Un départ de zéro part avec sa première image, pas avant (`openingHold`, contrat du moteur).
  await (playback.openingHold() ?? Promise.resolve());
  step(state, "released");
  if (state.opening !== mine) return;
  log(`lecture — ${playback.diagnostics["Vidéo"] ?? "?"}, son ${playback.diagnostics["Traitement audio"] ?? "?"}`);
  if (!resume?.paused) await element.play();
}

/** Rend la lecture à jellyfin-web : pour lui c'est une erreur de lecture, il renégocie et transcode. Une seule fois par flux. */
function handOver(self: LumenPlayer, type: "network" | "mediadecodeerror"): void {
  const state = states.get(self)!;
  if (state.handedOver) return;
  state.handedOver = true;
  state.deps.events.trigger(self, "error", [{ type }]);
}

/** Au plus tant de reconstructions dans cette fenêtre — les bornes de Laterna (`playerLifecycle`). */
const MAX_REBUILDS = 3;
const REBUILD_WINDOW_MS = 3 * 60_000;
/** Deux pertes à moins de cette distance sont « au même endroit » : on rouvre alors au-delà. */
const SAME_PLACE_S = 2;

/**
 * Rouvre Lumen là où le film en était, sur le même élément : la source est morte (le moteur a épuisé ses
 * reprises, ou le système l'a fermée pendant que la page était en arrière-plan), le fichier, lui, est
 * toujours lisible. Dans Laterna c'est l'hôte qui fait ce geste ; sans lui, toute panne finissait ici en
 * transcodage par le serveur pour le reste du film.
 *
 * Borné : au-delà de trois fois en trois minutes, ou si la réouverture échoue, rend faux — à l'appelant
 * de passer la main à jellyfin-web. Une perte répétée au même endroit rouvre à l'image clé suivante.
 */
async function rebuild(self: LumenPlayer, why: string): Promise<boolean> {
  const state = states.get(self)!;
  const current = state.current;
  const playback = state.playback;
  if (!current || !playback || state.rebuilding !== null) return state.rebuilding !== null;
  const now = performance.now();
  state.rebuilds = state.rebuilds.filter((past) => now - past.at < REBUILD_WINDOW_MS);
  if (state.rebuilds.length >= MAX_REBUILDS) {
    log(`${MAX_REBUILDS} reconstructions en ${REBUILD_WINDOW_MS / 60_000} minutes — lecture rendue à jellyfin-web`);
    return false;
  }
  let seconds = playback.position > 0 ? playback.position : state.lastPosition;
  const last = state.rebuilds[state.rebuilds.length - 1];
  if (last && Math.abs(last.seconds - seconds) < SAME_PLACE_S) seconds = playback.nextKeyframeAfter(seconds) ?? seconds;
  state.rebuilds.push({ at: now, seconds });
  // En pause, il le reste : par le spectateur, ou par le système quand la page est passée en arrière-plan.
  const paused = state.wasPaused;
  log(`reconstruction (${why}) à ${seconds.toFixed(1)} s${paused ? ", en pause" : ""} — moteur ${playback.position.toFixed(1)} s, dernière position jouée ${state.lastPosition.toFixed(1)} s`);
  state.recorder?.rebuilt();
  state.rebuilding = seconds;
  close(state, true);
  try {
    // Sans réseau, rouvrir échouerait aussitôt : on attend son retour, comme le fait le moteur.
    if (navigator.onLine === false) await new Promise<void>((resolve) => window.addEventListener("online", () => resolve(), { once: true }));
    if (state.current !== current) return true;
    state.busy += 1;
    try {
      await open(self, current.element, current.options, current.verdict, { seconds, paused });
    } finally {
      state.busy -= 1;
    }
    if (state.current !== current) return true;
    const wanted = state.seekAfterRebuild;
    state.rebuilding = null;
    state.seekAfterRebuild = null;
    if (wanted !== null) void state.playback?.seek(wanted);
    return true;
  } catch (error) {
    if (state.current !== current) return true;
    state.rebuilding = null;
    log("reconstruction impossible —", error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Le retour au premier plan. Sur iPhone, le système peut fermer la source d'une page restée en
 * arrière-plan, sans erreur : le moteur le sait (`lost`) mais n'a personne à qui le dire tant qu'aucun
 * envoi n'échoue, et l'image restait figée. Regardé au retour, puis un peu après — la fermeture arrive
 * parfois juste derrière l'événement (les 400 ms de Laterna, `useNativeRecovery`).
 */
function checkAfterReturn(): void {
  if (document.visibilityState !== "visible") return;
  const look = () => {
    const state = instance ? states.get(instance) : null;
    if (!instance || !state?.playback?.lost || state.rebuilding !== null) return;
    const self = instance as LumenPlayer;
    void rebuild(self, "retour au premier plan").then((rebuilt) => {
      if (!rebuilt) handOver(self, "mediadecodeerror");
    });
  };
  look();
  setTimeout(look, 400);
}
document.addEventListener("visibilitychange", checkAfterReturn);

// --- la porte d'entrée de jellyfin-web ----------------------------------------------------------

// « Une fonction (asynchrone) qui rend la classe du plugin » : c'est ce que jellyfin-web attend d'un nom
// de sa liste `plugins` qu'il trouve dans `window`. Le nom est ajouté à `config.json` côté serveur, et
// non ici en réécrivant la réponse : jellyfin-web 12.4 lit sa configuration par XMLHttpRequest, en
// binaire — une réponse qu'un script ne peut pas corriger au vol sans réécrire la requête entière.
w[PLUGIN_NAME] = async () => LumenPlayer;

// La page qui se ferme en pleine lecture : son journal part quand même. Seulement la vraie fermeture :
// jellyfin-web émet lui aussi des « pagehide », à chaque changement d'écran de son interface, et ils
// remontent jusqu'ici — le premier, à l'affichage du lecteur, clôturait le journal dès la première image.
window.addEventListener("pagehide", (event) => {
  if (event.target !== document && event.target !== window) return;
  const state = instance ? states.get(instance) : null;
  if (state) flush(state);
});

/** Pour les bancs et le diagnostic : ce que le pont est en train de faire, sans rien pouvoir y changer. */
w.Lumen = {
  config,
  trace: () => core?.then((engine) => engine.traceText()) ?? Promise.resolve(""),
  status() {
    const state = instance ? states.get(instance) : null;
    if (!state) return null;
    return {
      adopted: state.adopted,
      playing: state.playback !== null,
      position: state.playback?.position ?? null,
      audioTrack: state.playback?.currentAudioTrack ?? null,
      diagnostics: state.playback?.diagnostics ?? null,
      verdicts: [...state.verdicts].map(([id, verdict]) => ({ id, ok: verdict.ok, reason: verdict.reason ?? null })),
    };
  },
};
