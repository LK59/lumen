import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpByteSource, forgetHandover, SessionEnded, NetworkUnavailable } from "@lumen/engine/byteSource";
import { ExternalSubtitleTrack } from "@lumen/engine/externalSubtitles";
import { configureHost, resetHost } from "@lumen/host";

// Les coutures entre le moteur et son hôte (host.ts) : ce que Laterna écrivait dans le moteur — son
// en-tête de session, son simulateur de lien — et ce dont elle n'avait pas besoin, un cookie
// authentifiant ses requêtes : les en-têtes que Jellyfin exige.

const CHUNK = 1 << 20;
const SIZE = 6 * CHUNK;

type Seen = { url: string; init: (RequestInit & { headers?: Record<string, string> }) | undefined };
let seen: Seen[] = [];

function stubFetch(rangeStatus = 206) {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit & { headers?: Record<string, string> }) => {
    seen.push({ url, init });
    if (init?.method === "HEAD") return { ok: true, headers: { get: (name: string) => (name === "Content-Length" ? String(SIZE) : null) } };
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "")!.map(Number);
    return {
      status: rangeStatus,
      ok: rangeStatus === 206,
      headers: { get: () => (rangeStatus === 206 ? `bytes ${from}-${to}/${SIZE}` : null) },
      arrayBuffer: async () => new Uint8Array(to - from + 1).buffer,
    };
  });
}

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  forgetHandover();
  seen = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetHost();
});

describe("les en-têtes de l'hôte", () => {
  it("sans hôte, les requêtes sont celles du moteur d'origine, au champ près", async () => {
    stubFetch();
    const source = await HttpByteSource.open("/film.mkv");
    await source.read(2 * CHUNK, 4);
    source.close();
    expect(seen[0].init).toEqual({ method: "HEAD" });
    for (const { init } of seen.slice(1)) expect(Object.keys(init!.headers!)).toEqual(["Range"]);
  });

  it("le jeton part sur le HEAD et sur chaque plage, et un jeton renouvelé est pris à la requête suivante", async () => {
    stubFetch();
    let token = "un";
    configureHost({ requestHeaders: () => ({ Authorization: `MediaBrowser Token="${token}"` }) });
    const source = await HttpByteSource.open("/film.mkv");
    await settle();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const { init } of seen) expect(init!.headers!.Authorization).toBe('MediaBrowser Token="un"');
    const before = seen.length;
    token = "deux";
    await source.read(3 * CHUNK, 4);
    source.close();
    expect(seen.length).toBeGreaterThan(before);
    for (const { init } of seen.slice(before)) {
      expect(init!.headers!.Authorization).toBe('MediaBrowser Token="deux"');
      expect(init!.headers!.Range).toMatch(/^bytes=\d+-\d+$/);
    }
  });

  it("l'hôte ne peut pas réécrire la plage demandée", async () => {
    stubFetch();
    configureHost({ requestHeaders: () => ({ Range: "bytes=0-" }) });
    const source = await HttpByteSource.open("/film.mkv", SIZE);
    await source.read(2 * CHUNK, 4);
    source.close();
    for (const { init } of seen) expect(init!.headers!.Range).toMatch(/^bytes=\d+-\d+$/);
  });

  it("un hôte qui lève en donnant ses en-têtes ne devient pas la panne", async () => {
    stubFetch();
    configureHost({
      requestHeaders: () => {
        throw new Error("jeton illisible");
      },
    });
    const source = await HttpByteSource.open("/film.mkv", SIZE);
    await expect(source.read(2 * CHUNK, 4)).resolves.toHaveLength(4);
    source.close();
  });

  it("les sous-titres d'un fichier à part partent avec le même jeton", async () => {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit & { headers?: Record<string, string> }) => {
      seen.push({ url, init });
      return { ok: true, text: async () => "1\n00:00:01,000 --> 00:00:02,000\nBonjour\n" };
    });
    configureHost({ requestHeaders: () => ({ Authorization: 'MediaBrowser Token="un"' }) });
    const track = await ExternalSubtitleTrack.load({ id: 1001, url: "/sous-titres.srt" } as never);
    expect(seen[0].init!.headers!.Authorization).toBe('MediaBrowser Token="un"');
    expect(track.id).toBe(1001);
  });
});

describe("un 401", () => {
  it("sans règle de l'hôte, c'est un refus du serveur — pas une session terminée", async () => {
    stubFetch(401);
    const source = await HttpByteSource.open("/film.mkv", SIZE);
    const failure = await source.read(2 * CHUNK, 4).catch((error: unknown) => error);
    source.close();
    expect(failure).toBeInstanceOf(NetworkUnavailable);
    expect(failure).not.toBeInstanceOf(SessionEnded);
    expect((failure as Error).message).toContain("statut 401");
  }, 15_000);

  it("quand l'hôte dit que l'accès a pris fin, la plage n'est demandée qu'une fois", async () => {
    stubFetch(401);
    const asked = vi.fn(() => true);
    configureHost({ sessionEnded: asked });
    const source = await HttpByteSource.open("/film.mkv", SIZE);
    await settle();
    const before = seen.length;
    await expect(source.read(2 * CHUNK, 4)).rejects.toBeInstanceOf(SessionEnded);
    await settle();
    source.close();
    // Le morceau lu, et ceux que la lecture en avance a demandés avec lui : chacun une seule fois.
    const ranges = seen.slice(before).map(({ init }) => init!.headers!.Range);
    expect(new Set(ranges).size).toBe(ranges.length);
    expect(asked).toHaveBeenCalled();
  });

  it("la règle n'est consultée que pour un 401", async () => {
    stubFetch(206);
    const asked = vi.fn(() => true);
    configureHost({ sessionEnded: asked });
    const source = await HttpByteSource.open("/film.mkv", SIZE);
    await source.read(2 * CHUNK, 4);
    source.close();
    expect(asked).not.toHaveBeenCalled();
  });
});

describe("le lien bridé", () => {
  it("une coupure simulée fait échouer la requête avant qu'elle parte, comme un réseau tombé", async () => {
    stubFetch();
    let cut = true;
    configureHost({
      linkShaper: {
        gate: () => {
          if (cut) throw new TypeError("coupure simulée");
        },
        transfer: async () => {},
      },
    });
    const source = await HttpByteSource.open("/film.mkv", SIZE);
    const reading = source.read(2 * CHUNK, 4);
    await settle();
    expect(seen).toEqual([]);
    cut = false;
    // La tentative suivante passe : la coupure était une panne réseau ordinaire, redemandée.
    await expect(reading).resolves.toHaveLength(4);
    source.close();
  });

  it("chaque corps reçu passe par le lien, avec sa taille", async () => {
    stubFetch();
    const transfer = vi.fn(async (_bytes: number) => {});
    configureHost({ linkShaper: { gate: () => {}, transfer } });
    const source = (await HttpByteSource.open("/film.mkv", SIZE)).withoutReadahead();
    await source.read(2 * CHUNK, 4);
    source.close();
    expect(transfer.mock.calls.some(([bytes]) => bytes === CHUNK)).toBe(true);
  });
});
