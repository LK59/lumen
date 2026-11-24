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
type Probe = Awaited<ReturnType<Core["probePlaybackPath"]>>;
type Playback = Awaited<ReturnType<Probe["start"]>>;

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
  playbackManager: {
    getPlayers(): Array<{ id?: string; constructor: Function }>;
    play?: (options: { startPositionTicks?: number }) => unknown;
    getPlaylist?: () => Promise<JellyfinItem[]>;
    getCurrentPlaylistIndex?: () => number;
  };
  ServerConnections: {
    getApiClient(serverId?: string): { accessToken(): string; serverAddress(): string; getCurrentUserId(): string; getItem?(userId: string, itemId: string): Promise<JellyfinItem> };
    currentApiClient?(): { accessToken(): string; serverAddress(): string; getCurrentUserId(): string } | null | undefined;
  };
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
}

/**
 * Une vérification gardée ouverte : la sonde du moteur, lancée quand jellyfin-web demande le profil, et
 * qui devient l'ouverture si la lecture qui suit est bien celle qu'elle a préparée.
 *
 * Le verdict (« Lumen porte ce fichier ») tombe dès l'en-tête lu ; la sonde, elle, continue — premières
 * trames, amorçage de l'encodeur du son — pendant que jellyfin-web négocie avec le serveur et crée son
 * élément vidéo. Avant, ces deux attentes se suivaient : la sonde entière, refermée, puis la négociation,
 * puis une seconde sonde (banc du 24/11/2026 : 340 ms de vérification avant même que la négociation parte,
 * 1,4 à 2,0 s à 40 ms de latence).
 */
interface Standby {
  itemId: string;
  mediaSourceId: string;
  startSeconds: number;
  probe: Promise<Probe>;
  /** Le moteur a dit que le chemin tient (`onViable`) : c'est ce qu'attend le verdict, pas la sonde entière. */
  viable: Promise<void>;
  /** Ce que la sonde dira en cours de lecture : branché par l'ouverture qui la reprend. */
  hooks: ProbeHooks;
  /** La piste son que le serveur désignait à la vérification, traduite pour le moteur ; `undefined` tant que l'en-tête n'est pas lu. */
  picked: () => number | null | undefined;
  /** La sonde a-t-elle déjà été rendue ou reprise ? Elle ne se referme qu'une fois. */
  spent: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface State {
  deps: Deps;
  standby: Standby | null;
  /** Le dernier ordre de lecture vu passer : son instant et la position demandée — voir `watchPlayOrders`. */
  order: { at: number; seconds: number } | null;
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
  current: { element: HTMLVideoElement; options: StreamInfo } | null;
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
/** Une vérification que personne n'a reprise au bout de ce délai est refermée : elle tient un décodeur, un encodeur et une connexion. */
const STANDBY_MS = 20_000;
/** Un ordre de lecture plus vieux que cela ne dit plus rien de la préparation de flux en cours. */
const ORDER_MS = 15_000;
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

/**
 * Charge le moteur et ses décodeurs d'avance, quand le navigateur n'a rien d'autre à faire.
 *
 * Sans cela la première lecture d'une page les attendait : le moteur (300 Ko), puis, pour un son à
 * ré-encoder, le worker et le décodeur (1 Mo), chargés l'un après l'autre au moment où le spectateur
 * attend son film — 100 ms en local, 450 ms à 40 ms de latence. Le moteur ne télécharge pas les décodeurs
 * en mode économie de données (`warmPlayerDecoders`). Un échec ne coûte rien : la lecture les chargera.
 */
let warmed = false;

function warmEngine(): void {
  if (warmed || !config.enabled) return;
  warmed = true;
  const warm = () => void loadCore().then((engine) => engine.warmPlayerDecoders()).catch(() => {});
  const idle = (window as unknown as { requestIdleCallback?: (run: () => void, options?: { timeout: number }) => void }).requestIdleCallback;
  // Après les premières requêtes de l'interface, jamais en concurrence avec elles.
  setTimeout(() => (idle ? idle(warm, { timeout: 5000 }) : warm()), 1500);
}

/**
 * La fiche d'un film ou d'un épisode est à l'écran : son en-tête et son index sont lus d'avance, pour
 * que « Lire » n'ait plus à les attendre (`scheduleHeaderWarmup`, repris de Laterna — une seconde de
 * fiche d'abord, un fichier à la fois, rien en économie de données).
 *
 * jellyfin-web annonce chaque écran par un événement `viewshow` qui remonte jusqu'au document, avec
 * l'identifiant de l'élément pour une fiche. Sans cet événement (un autre client web), rien n'est préparé
 * et l'ouverture lit l'en-tête elle-même, comme avant.
 */
let stopSheetWarmup: () => void = () => {};

function watchSheets(state: State): void {
  document.addEventListener("viewshow", (event) => {
    stopSheetWarmup();
    stopSheetWarmup = () => {};
    try {
      const page = event.target as HTMLElement | null;
      const params = (event as CustomEvent<{ params?: { id?: string; serverId?: string } }>).detail?.params;
      if (!config.enabled || !page?.classList?.contains("itemDetailPage") || !params?.id) return;
      // Pendant un film (la fiche peut s'afficher derrière un lecteur réduit), le lien est à la lecture.
      if (state.playback || state.rebuilding !== null) return;
      let stopped = false;
      stopSheetWarmup = () => (stopped = true);
      const api = state.deps.ServerConnections.getApiClient(params.serverId);
      if (typeof api.getItem !== "function") return;
      const id = params.id;
      // Les réglages d'abord : rien n'est lu pour un compte que Lumen ne sert pas.
      void settingsOf(state, api)
        .then((answer) => {
          if (stopped || !answer.enabled) return;
          warmEngine();
          return api.getItem!(api.getCurrentUserId(), id);
        })
        .then(async (item) => {
          if (!item) return;
          const source = item.MediaSources?.find((s) => s.Id === item.Id) ?? item.MediaSources?.[0];
          if (stopped || !eligible(item) || !source?.Id) return;
          // Un fichier déjà refusé ne sera pas lu par Lumen : rien à préparer.
          const verdict = state.verdicts.get(item.Id!);
          if (verdict && !verdict.ok && Date.now() - verdict.at < VERDICT_MS) return;
          const engine = await loadCore();
          if (stopped) return;
          hostFor(state, engine, item);
          const cancel = engine.scheduleHeaderWarmup({
            streamUrl: streamAddress(api.serverAddress(), item.Id!, source.Id),
            knownSize: source.Size ?? null,
            fileVersion: source.ETag ?? null,
            // Là où ce compte s'était arrêté : « Reprendre » y trouvera ses premiers octets.
            resumeSeconds: (item.UserData?.PlaybackPositionTicks ?? 0) / 1e7,
          });
          stopSheetWarmup = () => {
            stopped = true;
            cancel();
          };
        })
        .catch(() => {});
    } catch {
      /* préparer n'est pas lire */
    }
  });
}

/** À moins de tant de secondes de la fin, l'élément suivant de la file est préparé. La minute de Laterna. */
const NEXT_WARMUP_S = 60;
/** Les éléments déjà préparés dans cette page : un seul essai chacun. */
const preparedNext = new Set<string>();

/**
 * L'épisode suivant, préparé pendant le générique : son en-tête et son index sont lus à une minute de
 * la fin, pour que l'enchaînement n'ait plus à les attendre (repris de Laterna, `nextEpisodeWarmup.ts`).
 *
 * La file de lecture est celle de jellyfin-web. Sans elle, ou sans élément suivant, rien ne se passe.
 */
function watchForNext(state: State, element: HTMLVideoElement, current: JellyfinItem): void {
  let asked = false;
  const look = () => {
    if (asked || !state.playback || !(element.duration - element.currentTime < NEXT_WARMUP_S)) return;
    asked = true;
    element.removeEventListener("timeupdate", look);
    void (async () => {
      const manager = state.deps.playbackManager;
      if (typeof manager.getPlaylist !== "function" || typeof manager.getCurrentPlaylistIndex !== "function") return;
      const next = (await manager.getPlaylist())[manager.getCurrentPlaylistIndex() + 1];
      if (!next?.Id || next.Id === current.Id || preparedNext.has(next.Id)) return;
      preparedNext.add(next.Id);
      const api = state.deps.ServerConnections.getApiClient(next.ServerId ?? current.ServerId);
      if (typeof api.getItem !== "function") return;
      const item = await api.getItem(api.getCurrentUserId(), next.Id);
      const source = item.MediaSources?.find((s) => s.Id === item.Id) ?? item.MediaSources?.[0];
      if (!eligible(item) || !source?.Id || !state.playback) return;
      const engine = await loadCore();
      stopSheetWarmup();
      stopSheetWarmup = engine.scheduleHeaderWarmup({ streamUrl: streamAddress(api.serverAddress(), item.Id!, source.Id), knownSize: source.Size ?? null, fileVersion: source.ETag ?? null }, 0);
    })().catch(() => {});
  };
  element.addEventListener("timeupdate", look);
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
    const state: State = { deps, standby: null, order: null, adopted: null, playback: null, opening: 0, verdicts: new Map(), settings: new Map(), recorder: null, recorderServerId: undefined, askedAt: null, element: null, busy: 0, seekTarget: null, steps: {}, stepsFrom: 0, offered: null, current: null, rebuilds: [], rebuilding: null, seekAfterRebuild: null, lastPosition: 0, wasPaused: false, handedOver: false, onRangeRefused: null };
    states.set(this, state);
    instance = this;
    // Dès la construction, et non à l'adoption du lecteur de jellyfin-web : celle-ci n'arrive qu'à la
    // première question posée à ce lecteur, qui peut être la première lecture elle-même.
    if (!televisionClient(navigator.userAgent)) watchSheets(state);
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
    log("TV or game console: playback left to the web client");
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
    watchPlayOrders(state);
    // Les réglages du compte, demandés d'avance : la première lecture saura déjà si Lumen le sert.
    try {
      const api = state.deps.ServerConnections.currentApiClient?.();
      if (api?.accessToken()) void settingsOf(state, api).then((answer) => answer.enabled && warmEngine());
    } catch {
      /* pas encore de session : ils seront demandés à la première lecture */
    }
    log("ready, plugged into the web client's video player");
  } catch (error) {
    Object.setPrototypeOf(self, before);
    state.adopted = false;
    console.warn("[Lumen] inactive: the video player of this web client version cannot be extended:", error);
  }
  return state.adopted;
}

/**
 * Regarde passer les ordres de lecture de jellyfin-web, pour savoir où la lecture va commencer.
 *
 * Quand il demande le profil, jellyfin-web ne dit pas à son lecteur la position de départ : elle n'arrive
 * qu'avec la source, après la négociation. La vérification gardée ouverte préparait donc toujours le
 * début du film, et une reprise en cours de film la refermait pour tout refaire à la bonne position. L'ordre
 * de lecture, lui, la porte (`startPositionTicks`) : on la note au passage, sans rien changer à l'appel.
 *
 * Sans cette méthode (un autre client web), la position attendue reste zéro, comme avant.
 */
function watchPlayOrders(state: State): void {
  try {
    const manager = state.deps.playbackManager;
    const play = manager.play;
    if (typeof play !== "function") return;
    manager.play = function (this: unknown, options: { startPositionTicks?: number }, ...rest: unknown[]) {
      try {
        state.order = { at: performance.now(), seconds: (Number(options?.startPositionTicks) || 0) / 1e7 };
      } catch {
        /* un ordre illisible : la position attendue reste celle d'avant */
      }
      return (play as Function).call(this, options, ...rest);
    };
  } catch {
    /* rien n'est regardé, rien n'est changé */
  }
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
      // Un film s'ouvre : la préparation de la fiche s'arrête, l'ouverture lit ce qu'il lui faut elle-même.
      stopSheetWarmup();
      if (options?.isRetry) state.recorder?.error();
      const asked = base.getDeviceProfile.call(this, item, options);
      if (!config.enabled || options?.isRetry || !eligible(item)) {
        dropStandby(state);
        return asked;
      }
      // Les trois questions partent ensemble : le profil de jellyfin-web (80 ms à froid), les réglages du
      // compte (un aller-retour) et le fichier. Elles se suivaient, et chacune attendait la précédente
      // pour rien. Seule exception : un compte que le plugin a dit ne pas servir, ou dont on ne sait
      // encore rien — on ne lit pas un fichier pour un compte que Lumen ne servira peut-être pas.
      const allowing = settings(state, item);
      // En cours de lecture (changement de piste, de qualité), seulement le verdict : voir `check`.
      const speculate = state.playback === null && state.rebuilding === null;
      const checking = settingsHint(state, item) === true ? check(this, item, speculate) : null;
      checking?.catch(() => {});
      const profile = await asked;
      step(state, "profile");
      const allowed = (await allowing).enabled;
      step(state, "settings");
      if (!allowed) {
        dropStandby(state);
        return profile;
      }
      const verdict = await (checking ?? check(this, item, speculate));
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
      if (item?.Id && state.offered === item.Id) skipOpeningAnimation();
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
      // `verdict` et non `verdict.ok` : un fichier accepté d'avance puis refusé pendant la négociation
      // (voir `check`) passe aussi par ici, pour que son ouverture échoue — plus bas — au lieu d'être
      // confiée telle quelle au lecteur de jellyfin-web.
      if (!config.enabled || options.playMethod !== "DirectPlay" || !verdict || !options.mediaSource?.Id || !options.item?.Id || state.offered !== options.item.Id) {
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
              // Le serveur a répondu « lecture directe » au profil de Lumen, et Lumen ne lira pas : ce
              // fichier brut n'est pas pour autant lisible par le lecteur de jellyfin-web (sous une
              // politique de sécurité stricte, il jouait un film en AC-3 sans le son, banc du 24/11/2026).
              // L'ouverture échoue donc, et jellyfin-web renégocie avec son propre profil.
              if (!verdict.ok) return Promise.reject(new Error(verdict.reason ?? "Lumen declined this file"));
              watchForNext(state, target, options.item!);
              state.current = { element: target, options };
              state.rebuilds = [];
              state.wasPaused = false;
              return open(self, target, options);
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
     * Changer de piste son : Lumen le fait lui-même, en rouvrant le fichier sur la nouvelle piste à la
     * position courante (`switchAudio`) — le moteur ne change jamais de piste dans le tampon vivant.
     *
     * Répondre « non » ici faisait renégocier le flux par jellyfin-web : le profil redemandé, un
     * aller-retour au serveur, puis `setCurrentSrc` — pour aboutir à la même réouverture. Seulement
     * quand le moteur porte toutes les pistes du fichier : sinon la piste choisie pourrait être celle
     * qu'il refuse, et c'est la renégociation qui sait alors passer la main au serveur.
     */
    canSetAudioStreamIndex(this: LumenPlayer): boolean {
      const state = states.get(this)!;
      const playback = state.playback;
      if (!playback) return (base as unknown as { canSetAudioStreamIndex(): boolean }).canSetAudioStreamIndex.call(this);
      return state.current !== null && state.rebuilding === null && playback.audioTracks.every((track) => playback.canCarryAudio(track.number));
    },

    setAudioStreamIndex(this: LumenPlayer, index: number): void {
      const state = states.get(this)!;
      if (!state.playback || !state.current) return (base as unknown as { setAudioStreamIndex(index: number): void }).setAudioStreamIndex.call(this, index);
      switchAudio(this, index);
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
      dropStandby(states.get(this)!);
      return base.stop.call(this, destroyPlayer);
    },

    destroy(this: LumenPlayer): void {
      releasePlaybackAudio();
      flush(states.get(this)!);
      close(states.get(this)!);
      dropStandby(states.get(this)!);
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
  // Une ouverture abandonnée ne laisse pas l'image cachée à qui reprend l'élément (jellyfin-web, au repli).
  if (state.element) releasePicture(state.element);
  const playback = state.playback;
  state.playback = null;
  state.seekTarget = null;
  try {
    playback?.destroy();
  } catch (error) {
    console.warn("[Lumen] closing:", error);
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
  return settingsOf(state, state.deps.ServerConnections.getApiClient(item.ServerId));
}

function settingsOf(state: State, api: ReturnType<Deps["ServerConnections"]["getApiClient"]>): Promise<Settings> {
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
        settingsSeen.set(key, answered.Enabled !== false);
        if (answered.Enabled === false) log("regular player: Lumen does not play for this user (plugin settings)");
        return { enabled: answered.Enabled !== false, journal: answered.Journal === true };
      })
      .catch((): Settings => ({ enabled: true, journal: false }));
    state.settings.set(key, { at: Date.now(), answer });
  }
  return answer;
}

/** La dernière réponse connue des réglages pour ce compte, quel que soit son âge ; `null` : jamais reçue. */
const settingsSeen = new Map<string, boolean>();

function settingsHint(state: State, item: JellyfinItem): boolean | null {
  try {
    const api = state.deps.ServerConnections.getApiClient(item.ServerId);
    return settingsSeen.get(`${api.serverAddress()}|${api.getCurrentUserId()}`) ?? null;
  } catch {
    return null;
  }
}

/**
 * Ne pas attendre la fin de l'animation d'ouverture de jellyfin-web pour commencer à lire.
 *
 * Son lecteur crée l'élément vidéo, l'insère, puis lance sur son conteneur un zoom de 240 ms et n'appelle
 * `setCurrentSrc` qu'à la fin (`createMediaElement`). L'élément est là dès le début ; l'attente n'est que
 * visuelle. Mesurée au banc : 250 à 330 ms entre la réponse du serveur et la source, à chaque ouverture.
 * On annonce donc la fin de l'animation dès que le conteneur apparaît : jellyfin-web enchaîne, et le zoom
 * se joue pendant que Lumen ouvre le fichier.
 *
 * Seulement pour une lecture que Lumen prend. Sans conteneur dans les trois secondes (un client web qui
 * ne ferait plus ainsi), rien n'est touché.
 */
function skipOpeningAnimation(): void {
  try {
    if (document.querySelector(".videoPlayerContainer")) return;
    const announce = (node: Node) => {
      if (!(node instanceof HTMLElement) || !node.classList.contains("videoPlayerContainer")) return false;
      holdPictureUntilZoomed(node);
      for (const type of ["animationend", "webkitAnimationEnd"]) node.dispatchEvent(new Event(type));
      return true;
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (!announce(node)) continue;
          observer.disconnect();
          clearTimeout(timer);
          return;
        }
      }
    });
    const timer = setTimeout(() => observer.disconnect(), 3000);
    observer.observe(document.body, { childList: true });
  } catch {
    /* l'animation se joue alors comme avant */
  }
}

/**
 * L'image reste cachée tant que le zoom d'ouverture se joue.
 *
 * Une ouverture rapide (page chaude, fiche préparée) montre sa première image en moins de 240 ms : elle
 * apparaissait alors dans le cadre encore en train de grandir, à demi transparent, ce que le client web ne
 * fait jamais de lui-même (il n'attache la source qu'après le zoom). Le film se prépare pendant le zoom et
 * se montre à sa fin : à l'écran, rien ne distingue cette ouverture de celle de jellyfin-web, sauf sa durée.
 *
 * La vraie fin d'animation se reconnaît à `isTrusted` (celle qu'on annonce soi-même ne l'est pas). Le
 * délai de garde couvre un navigateur qui ne jouerait pas l'animation : l'image ne reste jamais cachée.
 */
function holdPictureUntilZoomed(container: HTMLElement): void {
  const video = container.querySelector("video");
  if (!video || !container.style.animation) return;
  holdPicture(video, "zoom");
  const types = ["animationend", "webkitAnimationEnd", "animationcancel"];
  const show = (event?: Event) => {
    if (event && !event.isTrusted) return;
    releasePicture(video, "zoom");
    clearTimeout(guard);
    for (const type of types) container.removeEventListener(type, show);
  };
  for (const type of types) container.addEventListener(type, show);
  const guard = setTimeout(show, 400);
}

/**
 * Les raisons pour lesquelles l'image d'un élément est cachée : le zoom d'ouverture, une position de
 * départ pas encore atteinte. L'image se montre quand il n'en reste aucune — deux retenues qui se
 * chevauchent (une reprise pendant le zoom) ne se lèvent pas l'une l'autre.
 */
const pictureHolds = new WeakMap<HTMLVideoElement, Set<string>>();

function holdPicture(element: HTMLVideoElement, reason: string): void {
  const reasons = pictureHolds.get(element) ?? new Set<string>();
  pictureHolds.set(element, reasons);
  reasons.add(reason);
  element.style.visibility = "hidden";
}

/** Sans `reason` : les retenues de position tombent toutes (la lecture se ferme ou change de mains) ; celle du zoom reste. */
function releasePicture(element: HTMLVideoElement, reason?: string): void {
  const reasons = pictureHolds.get(element);
  if (!reasons) return;
  if (reason !== undefined) reasons.delete(reason);
  else for (const held of Array.from(reasons)) if (held !== "zoom") reasons.delete(held);
  if (reasons.size === 0) element.style.visibility = "";
}

/** En deçà, un départ est un départ de zéro : rien à retenir, la première image est la bonne. */
const HOLD_FROM_SECONDS = 1;
/** Une image présentée à moins de cela avant la position demandée est tenue pour la bonne. */
const HOLD_TOLERANCE_SECONDS = 1;
/** Après les premières données, l'image n'attend pas davantage : mieux vaut une image de travers que rien. */
const HOLD_GUARD_MS = 1500;
/** Sans aucune donnée au bout de ce délai, la retenue tombe : l'élément a peut-être changé de mains. */
const HOLD_CAP_MS = 15_000;
/** Les premières images relevées par ouverture, pour le journal. */
const TRACED_FRAMES = 8;
let holdCount = 0;

/**
 * Suit une ouverture du moteur sur l'élément : relève ses premiers événements et ses premières images
 * pour le journal et, quand elle part d'une position (reprise, changement de piste, reconstruction),
 * garde l'image cachée jusqu'à ce que cette position soit à l'écran.
 *
 * Symptôme d'origine (enregistrements d'écran sur iPhone, le 24/11/2026) : à un changement de piste son,
 * une image d'un autre plan apparaissait 0,2 s, puis un noir, puis le film ; la même image passait à
 * l'ouverture d'une reprise. Hypothèse non vérifiée faute de Safari au banc : l'image clé d'où le
 * décodage repart, quelques secondes avant la position, montrée le temps d'y arriver. Le relevé
 * (`openings` du journal : la position de chaque image présentée) est là pour le confirmer ou l'infirmer.
 *
 * L'image se montre à la première de ces preuves : une image présentée à la position, hors saut ; ou,
 * pour un navigateur qui n'annoncerait pas les images d'un élément caché, l'élément lui-même posé à la
 * position avec de quoi l'afficher. Deux gardes pour qu'elle ne reste jamais cachée.
 */
function watchOpening(state: State, element: HTMLVideoElement, target: number, alive: () => boolean): void {
  // Une retenue par ouverture : celle d'une ouverture remplacée ne lève pas celle de la suivante.
  const reason = `position#${(holdCount += 1)}`;
  try {
    const from = performance.now();
    const since = () => Math.round(performance.now() - from);
    const holding = target >= HOLD_FROM_SECONDS;
    const marks: Record<string, number> = {};
    const frames: number[][] = [];
    let shown: { heldMs: number; shownBy: string } | null = null;
    let reported = false;
    let guard: ReturnType<typeof setTimeout> | undefined;
    // Les secondes de film en mémoire devant la position : ce qui dit si une image figée attend des
    // octets (rien devant) ou le navigateur (de quoi lire, et pourtant rien ne bouge).
    const ahead = () => {
      const { buffered, currentTime } = element;
      for (let i = 0; i < buffered.length; i += 1) if (buffered.start(i) <= currentTime + 0.1 && currentTime <= buffered.end(i)) return Math.round((buffered.end(i) - currentTime) * 10) / 10;
      return 0;
    };
    const types = ["loadeddata", "canplay", "canplaythrough", "seeked", "play", "playing", "waiting", "stalled", "pause", "timeupdate"];
    const show = (by: string) => {
      if (shown) return;
      shown = { heldMs: since(), shownBy: by };
      clearTimeout(guard);
      if (holding) releasePicture(element, reason);
    };
    // Le relevé part une fois ses images réunies, ou au bout du délai : il couvre ainsi le démarrage de la
    // lecture après la première image, là où une reprise restait figée jusqu'à deux secondes sur iPhone
    // (journal du 24/11/2026) sans que rien ne dise ce qu'elle attendait.
    const report = (why?: string) => {
      if (reported) return;
      reported = true;
      show(why ?? "report");
      clearTimeout(cap);
      for (const type of types) element.removeEventListener(type, onEvent);
      // Une ouverture remplacée entre-temps (autre flux, fermeture) n'a rien à dire de celle qui suit.
      if (alive()) state.recorder?.openingTrace({ target: Math.round(target * 10) / 10, ...(holding && shown ? shown : {}), marks, frames });
    };
    const there = (seconds: number) => !element.seeking && seconds >= target - HOLD_TOLERANCE_SECONDS;
    const onEvent = (event: Event) => {
      if (!alive()) return report("replaced");
      marks[event.type] ??= since();
      if (shown) return;
      // Les premières données sont là : à partir d'ici, l'image ne peut plus attendre longtemps.
      if (holding) guard ??= setTimeout(() => show("guard"), HOLD_GUARD_MS);
      if (!holding || (element.readyState >= 2 && there(element.currentTime))) show("position");
    };
    for (const type of types) element.addEventListener(type, onEvent);
    const cap = setTimeout(() => report("cap"), HOLD_CAP_MS);
    if (holding) holdPicture(element, reason);
    if (typeof element.requestVideoFrameCallback !== "function") return;
    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      if (!alive()) return report("replaced");
      if (reported) return;
      // [ms depuis l'ouverture, position de l'image, position de l'élément, saut en cours, secondes en
      //  mémoire devant, readyState]
      frames.push([since(), Math.round(meta.mediaTime * 100) / 100, Math.round(element.currentTime * 100) / 100, element.seeking ? 1 : 0, ahead(), element.readyState]);
      if (!holding || there(meta.mediaTime)) show("frame");
      if (frames.length >= TRACED_FRAMES) return report();
      element.requestVideoFrameCallback?.(onFrame);
    };
    element.requestVideoFrameCallback(onFrame);
  } catch {
    releasePicture(element, reason);
  }
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
 * Relève aussi, journal allumé ou non, la dernière position jouée et l'état de pause, dont les
 * réouvertures repartent. Rien ici ne touche à la lecture, et rien ne lève.
 */
function observe(state: State, element: HTMLVideoElement, options: StreamInfo): void {
  const recorder = state.recorder;
  state.element = element;
  try {
    if (recorder) {
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
    }
    // L'élément est suivi même sans journal : la position et la pause relevées ici servent aux
    // réouvertures (retour au premier plan, changement de piste). Tant qu'elles n'étaient relevées que
    // journal allumé, un serveur au journal éteint reprenait le film à zéro après une coupure du réseau, et
    // relançait un film mis en pause dont on changeait la piste son (cas-limites.mjs, LOSS=1, le 24/11/2026).
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

/** Ce que la sonde dit en cours de lecture ; rebranché sur l'ouverture qui la reprend. */
interface ProbeHooks {
  onWarning: (warning: { code: string; detail?: unknown }) => void;
  onError: (message: string, kind?: "network" | "playback") => void;
}

/**
 * Le verdict est-il rendu d'avance, dès que le moteur dit que le chemin tient ? Vrai jusqu'au premier
 * refus tombé après coup dans cette page : ce qui l'a causé (un décodeur que la page n'a pas le droit de
 * charger, par exemple) vaudra pour les fichiers suivants, et chacun paierait une ouverture ratée puis
 * une renégociation. La vérification attend alors la sonde entière, comme avant.
 */
let optimistic = wasmAllowed();

/**
 * La page a-t-elle le droit de compiler du WebAssembly ? Sous une politique de sécurité qui l'interdit,
 * tout fichier dont le son se décode ici sera refusé — après le verdict d'avance. Autant le savoir
 * tout de suite : le plus petit module qui soit, huit octets, compilé une fois au chargement.
 */
function wasmAllowed(): boolean {
  try {
    new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    return true;
  } catch {
    return false;
  }
}

/** Ce qu'a fait de la vérification gardée la dernière ouverture — pour les bancs (`window.Lumen.status()`). */
let lastStandby: "reused" | "mismatch" | "failed" | "none" = "none";

/** Pose la question au moteur : ce fichier, à cette position, sur la piste son que le serveur a retenue. */
function ask(state: State, engine: Core, item: JellyfinItem, source: JellyfinMediaSource | undefined, startSeconds: number, more: Partial<Parameters<Core["probePlaybackPath"]>[0]> & { picked?: (track: number | null) => void }, hooks: ProbeHooks): Promise<Probe> {
  const api = hostFor(state, engine, item);
  const video = source?.MediaStreams?.find((s) => s.Type === "Video");
  const { picked, ...options } = more;
  return engine.probePlaybackPath({
    streamUrl: streamAddress(api.serverAddress(), item.Id!, source?.Id ?? item.Id!),
    knownSize: source?.Size ?? null,
    fileVersion: source?.ETag ?? null,
    videoRangeType: video?.VideoRangeType ?? null,
    startSeconds,
    // La piste que le serveur a retenue (préférences du compte, choix au menu), traduite pour le moteur
    // une fois ses pistes connues : il ouvre dessus, au lieu d'ouvrir sur la sienne puis de recommencer.
    pickAudioTrack: (tracks) => {
      const track = audioTrackFor(source?.MediaStreams, source?.DefaultAudioStreamIndex, tracks.map((t) => t.number));
      picked?.(track);
      return track;
    },
    onWarning: (warning) => hooks.onWarning(warning),
    onError: (message, kind) => hooks.onError(message, kind),
    ...options,
  });
}

/** Referme la vérification gardée ouverte, si personne ne l'a reprise. */
function dropStandby(state: State): void {
  const standby = state.standby;
  state.standby = null;
  if (!standby || standby.spent) return;
  standby.spent = true;
  clearTimeout(standby.timer);
  void standby.probe.then((probe) => probe.discard()).catch(() => {});
}

/** Reprend la vérification gardée ouverte pour ce fichier, s'il y en a une : à l'appelant de s'en servir ou de la refermer. */
function takeStandby(state: State, itemId: string, mediaSourceId: string): Standby | null {
  const standby = state.standby;
  if (!standby || standby.spent || standby.itemId !== itemId || standby.mediaSourceId !== mediaSourceId) return null;
  state.standby = null;
  standby.spent = true;
  clearTimeout(standby.timer);
  return standby;
}

/** La position où la lecture qui se prépare va commencer, d'après le dernier ordre vu ; zéro sans ordre récent. */
function expectedStart(state: State): number {
  return state.order && performance.now() - state.order.at < ORDER_MS ? state.order.seconds : 0;
}

/**
 * Lumen porte-t-il ce fichier ? La question est posée au moteur, qui ouvre le fichier et choisit son
 * chemin comme pour le lire. La réponse est rendue dès que le moteur sait que le chemin tient (`onViable` :
 * en-tête lu, codecs acceptés par le navigateur) ; la sonde continue derrière et reste ouverte pour
 * l'ouverture qui suit — voir `Standby`.
 *
 * `speculate` faux : seulement le verdict, sans rien garder ouvert — pour un changement de flux en cours
 * de lecture, dont ni la position ni la piste ne se devinent d'ici.
 *
 * Rend `null` quand la question n'a pas pu être posée à temps (moteur introuvable, serveur muet) : ce
 * n'est pas un refus du fichier, et rien n'est retenu.
 */
async function check(self: LumenPlayer, item: JellyfinItem, speculate = true): Promise<Verdict | null> {
  const state = states.get(self)!;
  const id = item.Id!;
  const known = state.verdicts.get(id);
  const fresh = known && Date.now() - known.at < VERDICT_MS ? known : null;
  if (fresh && (!fresh.ok || !speculate)) return fresh;
  const source = item.MediaSources?.find((s) => s.Id === id) ?? item.MediaSources?.[0];
  const mediaSourceId = source?.Id ?? id;
  let engine: Core;
  try {
    engine = await loadCore();
  } catch (error) {
    // Le moteur ne se charge pas : cela ne dit rien du fichier, et rien n'est retenu.
    log("engine not found, regular player:", error instanceof Error ? error.message : error);
    return null;
  }
  const refusal = (error: unknown): Verdict | null => {
    const reason = error instanceof Error ? error.message : String(error);
    // Un réseau absent ou une session finie ne disent rien du fichier : ce n'est pas un refus à retenir.
    if (error instanceof engine.NetworkUnavailable || error instanceof engine.SessionEnded) {
      log("could not check the file, regular player:", reason);
      return null;
    }
    const verdict: Verdict = { at: Date.now(), ok: false, reason, mediaSourceId };
    state.verdicts.set(id, verdict);
    log("declined, regular player:", reason);
    return verdict;
  };
  const startSeconds = expectedStart(state);
  // jellyfin-web pose la question plusieurs fois pendant une préparation de flux : la même sonde sert.
  let standby = state.standby;
  if (!standby || standby.spent || standby.itemId !== id || standby.mediaSourceId !== mediaSourceId || standby.startSeconds !== startSeconds) {
    dropStandby(state);
    let announce!: () => void;
    const viable = new Promise<void>((resolve) => (announce = resolve));
    const hooks: ProbeHooks = { onWarning: () => {}, onError: () => {} };
    let picked: number | null | undefined;
    let probe: Promise<Probe>;
    try {
      probe = ask(state, engine, item, source, startSeconds, { onViable: announce, picked: (track) => (picked = track) }, hooks);
    } catch (error) {
      return refusal(error);
    }
    const mine: Standby = { itemId: id, mediaSourceId, startSeconds, probe, viable, hooks, picked: () => picked, spent: false, timer: setTimeout(() => state.standby === mine && dropStandby(state), STANDBY_MS) };
    standby = state.standby = mine;
    // Un refus tardif — après le verdict rendu d'avance — est retenu : la prochaine fois, la question ne
    // sera plus posée, et l'ouverture en cours le lira (`open`).
    probe.catch((error) => {
      if (state.standby === mine) state.standby = null;
      clearTimeout(mine.timer);
      if ((fresh || state.verdicts.get(id)?.ok) && refusal(error)) {
        optimistic = false;
        log("verdicts will wait for the full check from now on (a file was declined after being accepted)");
      }
    });
  }
  if (fresh) return fresh;
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), CHECK_TIMEOUT_MS));
  try {
    const first = await Promise.race(optimistic ? [standby.viable, standby.probe, timeout] : [standby.probe, timeout]);
    if (first === "timeout") {
      // Arrivée trop tard, elle sera refermée ; son refus éventuel n'intéresse plus personne.
      if (state.standby === standby) dropStandby(state);
      log(`checking the file took too long (${CHECK_TIMEOUT_MS / 1000} s), regular player`);
      return null;
    }
    const verdict: Verdict = { at: Date.now(), ok: true, mediaSourceId };
    state.verdicts.set(id, verdict);
    return verdict;
  } catch (error) {
    return refusal(error);
  }
}

/** Ouvre Lumen sur l'élément et lance la lecture. C'est le `play()` que le lecteur de jellyfin-web attend. */
async function open(self: LumenPlayer, element: HTMLVideoElement, options: StreamInfo, resume?: { seconds: number; paused: boolean }): Promise<void> {
  const state = states.get(self)!;
  const mine = ++state.opening;
  const item = options.item!;
  const source = options.mediaSource!;
  step(state, "play");
  const engine = await loadCore();
  const startSeconds = resume?.seconds ?? (options.playerStartPositionTicks ?? 0) / 1e7;
  const hooks: ProbeHooks = {
    onWarning: (warning) => log("engine warning:", warning.code, warning.detail ?? ""),
    // Le moteur a épuisé ses reprises sur cette source. On la rouvre à la même position, quelques
    // fois ; au-delà, c'est une erreur de lecture pour jellyfin-web, qui renégocie et transcode.
    onError: (message, kind) => {
      if (states.get(self)!.opening !== mine) return;
      log("the engine gave up:", message);
      void rebuild(self, kind === "network" ? "network" : "source lost").then((rebuilt) => {
        if (!rebuilt) handOver(self, kind === "network" ? "network" : "mediadecodeerror");
      });
    },
  };
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
    log(`the server refuses the file (status ${status}), handing over to the regular player`);
    handOver(self, "network");
  };
  let probe: Probe | null = null;
  // La vérification gardée ouverte, si elle a préparé cette lecture-ci : même fichier, même position,
  // même piste son. Sinon elle est refermée et la question est reposée — ce qui se faisait toujours.
  // Jamais pour une reconstruction : elle rouvre en pause ou ailleurs, ce que la vérification ignorait.
  const standby = resume ? null : takeStandby(state, item.Id!, source.Id!);
  lastStandby = "none";
  if (standby) {
    let ready: Probe | null = null;
    try {
      ready = await standby.probe;
    } catch (error) {
      lastStandby = "failed";
      // Le fichier lui-même est refusé (le verdict l'a déjà retenu, voir `check`) : c'est une erreur de
      // lecture pour jellyfin-web, qui renégocie avec son propre profil. Une panne de réseau, elle, ne dit
      // rien du fichier : la question est reposée, et le moteur attend le réseau comme il sait le faire.
      if (!(error instanceof engine.NetworkUnavailable || error instanceof engine.SessionEnded)) throw error;
    }
    if (ready) {
      const wanted = audioTrackFor(source.MediaStreams, source.DefaultAudioStreamIndex, ready.audioTracks.map((track) => track.number));
      if (state.opening === mine && standby.startSeconds === startSeconds && standby.picked() === wanted) {
        standby.hooks.onWarning = hooks.onWarning;
        standby.hooks.onError = hooks.onError;
        probe = ready;
        lastStandby = "reused";
      } else {
        ready.discard();
        lastStandby = "mismatch";
      }
    }
  }
  if (state.opening !== mine) {
    probe?.discard();
    return;
  }
  // Une reconstruction ne relance pas un film que le spectateur avait mis en pause.
  probe ??= await ask(state, engine, item, source, startSeconds, { startPaused: resume?.paused ?? false }, hooks);
  if (state.opening !== mine) {
    probe.discard();
    return;
  }
  step(state, "probed");
  // jellyfin-web crée son élément avec `autoplay` : sur une source neuve, le navigateur relançait de
  // lui-même un film rouvert en pause, sans qu'aucun `play()` ne soit appelé.
  if (resume?.paused) element.autoplay = false;
  watchOpening(state, element, startSeconds, () => state.opening === mine);
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
  log(`playing: ${playback.diagnostics["Vidéo"] ?? "?"}, audio ${englishAudio(playback.diagnostics["Traitement audio"]) ?? "?"}`);
  if (!resume?.paused) await element.play();
}

/** Rend la lecture à jellyfin-web : pour lui c'est une erreur de lecture, il renégocie et transcode. Une seule fois par flux. */
function handOver(self: LumenPlayer, type: "network" | "mediadecodeerror"): void {
  const state = states.get(self)!;
  if (state.handedOver) return;
  state.handedOver = true;
  state.deps.events.trigger(self, "error", [{ type }]);
}

/**
 * Rouvre le fichier sur une autre piste son, à la position courante, sans repasser par le serveur —
 * voir `canSetAudioStreamIndex`. `index` est celui de Jellyfin ; la source gardée le retient, pour qu'une
 * reconstruction ultérieure rouvre sur la piste choisie et non sur celle de la négociation.
 */
function switchAudio(self: LumenPlayer, index: number): void {
  const state = states.get(self)!;
  const current = state.current;
  const playback = state.playback;
  if (!current || !playback || state.rebuilding !== null) return;
  const source = current.options.mediaSource!;
  const wanted = audioTrackFor(source.MediaStreams, index, playback.audioTracks.map((track) => track.number));
  if (wanted === null || wanted === playback.currentAudioTrack) return;
  current.options = { ...current.options, mediaSource: { ...source, DefaultAudioStreamIndex: index } };
  const seconds = playback.position > 0 ? playback.position : state.lastPosition;
  const startedAt = performance.now();
  const recorder = state.recorder;
  void reopen(self, current, seconds, state.wasPaused).then((reopened) => {
    if (!reopened) handOver(self, "mediadecodeerror");
  });
  // Mesuré comme un changement de flux par renégociation : de l'ordre à la première image de la nouvelle
  // source (l'ancienne vient d'être fermée, plus aucune image n'en sort).
  state.busy += 1;
  void nextFrame(current.element, 60_000).then((at) => {
    state.busy -= 1;
    if (state.recorder === recorder && at !== null) recorder?.frame(at - startedAt);
  });
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
    log(`reopened ${MAX_REBUILDS} times in ${REBUILD_WINDOW_MS / 60_000} minutes, handing over to the regular player`);
    return false;
  }
  let seconds = playback.position > 0 ? playback.position : state.lastPosition;
  const last = state.rebuilds[state.rebuilds.length - 1];
  if (last && Math.abs(last.seconds - seconds) < SAME_PLACE_S) seconds = playback.nextKeyframeAfter(seconds) ?? seconds;
  state.rebuilds.push({ at: now, seconds });
  // En pause, il le reste : par le spectateur, ou par le système quand la page est passée en arrière-plan.
  const paused = state.wasPaused;
  log(`reopening (${why}) at ${seconds.toFixed(1)} s${paused ? ", paused" : ""}; engine at ${playback.position.toFixed(1)} s, last played position ${state.lastPosition.toFixed(1)} s`);
  state.recorder?.rebuilt();
  return reopen(self, current, seconds, paused);
}

/** Ferme la source et la rouvre sur le même élément, à `seconds` : le geste commun à une reconstruction et à un changement de piste. */
async function reopen(self: LumenPlayer, current: NonNullable<State["current"]>, seconds: number, paused: boolean): Promise<boolean> {
  const state = states.get(self)!;
  state.rebuilding = seconds;
  close(state, true);
  try {
    // Sans réseau, rouvrir échouerait aussitôt : on attend son retour, comme le fait le moteur.
    if (navigator.onLine === false) await new Promise<void>((resolve) => window.addEventListener("online", () => resolve(), { once: true }));
    if (state.current !== current) return true;
    state.busy += 1;
    try {
      await open(self, current.element, current.options, { seconds, paused });
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
    log("could not reopen:", error instanceof Error ? error.message : error);
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
    void rebuild(self, "back to the foreground").then((rebuilt) => {
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
      standby: lastStandby,
      position: state.playback?.position ?? null,
      audioTrack: state.playback?.currentAudioTrack ?? null,
      diagnostics: state.playback?.diagnostics ?? null,
      verdicts: [...state.verdicts].map(([id, verdict]) => ({ id, ok: verdict.ok, reason: verdict.reason ?? null })),
    };
  },
};
