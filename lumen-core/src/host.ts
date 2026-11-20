// Ce que le moteur demande à qui l'héberge — et rien d'autre.
//
// Dans Laterna, le moteur importait cinq modules de l'application : la session expirée (un en-tête de
// son proxy), le simulateur de lien de sa page de test, le numéro de build, et les requêtes partaient
// sans en-tête parce qu'un cookie les authentifiait. Aucun de ces quatre points n'a de sens hors de
// Laterna, et un moteur qui les importerait ne lirait que chez elle. Ils passent donc par ici : l'hôte
// (une page de test, le pont jellyfin-web) les règle une fois, avant d'ouvrir un fichier.
//
// Global, comme `trace` et `playbackDiagnosis` : un lecteur à la fois dans une page. Sans réglage, le
// moteur se comporte exactement comme dans Laterna hors session et hors simulateur — c'est ce que ses
// tests, repris tels quels, vérifient.

/**
 * Un lien bridé, pour mesurer le lecteur sur une connexion lente ou coupée sans toucher au réseau.
 * `gate` lève pour faire échouer la requête qui part (une coupure) ; `transfer` attend ce que le corps
 * reçu aurait mis à arriver, et lève si la coupure est survenue entre-temps.
 */
export interface LinkShaper {
  gate(): void;
  transfer(bytes: number, headersAt: number, signal?: AbortSignal | null): Promise<void>;
}

export interface LumenHost {
  /**
   * Le nom du code qui tourne. Ce que le moteur retient d'un navigateur (une forme d'AAC qu'il a
   * refusée) ne vaut que pour ce code : une mise à jour peut lever le refus, et doit le réessayer.
   */
  build: string;
  /**
   * Les en-têtes que le serveur exige sur chaque requête du fichier et des sous-titres — pour Jellyfin,
   * `Authorization: MediaBrowser Token="…"`. Appelée à chaque requête : un jeton renouvelé est pris
   * à la suivante. `Range` reste au moteur.
   */
  requestHeaders: (() => Record<string, string>) | null;
  /**
   * Ce 401 dit-il que l'accès a pris fin (session expirée, jeton révoqué) ? Vrai : la lecture
   * s'arrête sans rien redemander (`SessionEnded`), et c'est à l'hôte de renvoyer vers la connexion.
   * Faux ou absent : le 401 est un refus du serveur comme un autre. Peut être appelée plusieurs fois
   * pour une même expiration (chaque plage en vol la découvre).
   */
  sessionEnded: ((res: Response) => boolean) | null;
  linkShaper: LinkShaper | null;
}

const DEFAULTS: LumenHost = { build: "dev", requestHeaders: null, sessionEnded: null, linkShaper: null };

let host: LumenHost = { ...DEFAULTS };

/** Règle ce que l'hôte fournit. Ce qui n'est pas nommé garde sa valeur. */
export function configureHost(next: Partial<LumenHost>): void {
  host = { ...host, ...next };
}

/** Pour les tests : l'hôte qui ne fournit rien. */
export function resetHost(): void {
  host = { ...DEFAULTS };
}

export function hostBuild(): string {
  return host.build;
}

/**
 * Les options d'une requête, avec les en-têtes de l'hôte s'il en a. Sans eux, l'objet reçu est rendu
 * tel quel : la requête d'un moteur sans hôte est, au caractère près, celle d'avant.
 */
export function withHostHeaders<T extends RequestInit | undefined>(init: T): T | RequestInit {
  let extra: Record<string, string> | null = null;
  try {
    extra = host.requestHeaders?.() ?? null;
  } catch {
    // Un hôte qui lève ici ne doit pas devenir la panne : la requête part sans, et le serveur répondra.
  }
  if (!extra || Object.keys(extra).length === 0) return init;
  // Les en-têtes du moteur passent après : `Range` ne se laisse pas réécrire.
  return { ...init, headers: { ...extra, ...(init?.headers as Record<string, string> | undefined) } };
}

export function hostSaysSessionEnded(res: Response): boolean {
  try {
    return res.status === 401 && host.sessionEnded?.(res) === true;
  } catch {
    return false;
  }
}

export function linkShaper(): LinkShaper | null {
  return host.linkShaper;
}
