import type {
  ItemKind,
  FieldSync,
  StashScene,
  ProviderRootResponse,
  MatchResponse,
  MatchResult,
  MetadataResponse,
  MetadataItem,
  ChildrenResponse,
  ImagesResponse,
  MatchRequest,
} from '@plex2stash/plex-types';
import { DEFAULT_FIELD_SYNC, PROVIDER_ID_PREFIX, PROVIDER_VERSION } from '../config/constants.js';
import { configService } from './config.service.js';
import { stashService } from './stash.service.js';
import { cacheService } from './cache.service.js';
import { loggerService } from './logger.service.js';

// ============================================================
// ID helpers
// ============================================================

function sanitizeIdentifier(stashId: string): string {
  return stashId
    .replace(/[^a-zA-Z0-9.]/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

function buildIdentifier(stashId: string): string {
  return `${PROVIDER_ID_PREFIX}.${sanitizeIdentifier(stashId)}`;
}

function buildGuid(identifier: string, kind: ItemKind, sceneId: string): string {
  return `${identifier}://${kind}.${sceneId}`;
}

function buildRatingKey(kind: ItemKind, sceneId: string): string {
  return `${kind}.${sceneId}`;
}

function parseItemId(id: string): { kind: ItemKind; sceneId: string } {
  if (id.startsWith('movie.'))   return { kind: 'movie',   sceneId: id.slice(6) };
  if (id.startsWith('show.'))    return { kind: 'show',    sceneId: id.slice(5) };
  if (id.startsWith('season.'))  return { kind: 'season',  sceneId: id.slice(7) };
  if (id.startsWith('episode.')) return { kind: 'episode', sceneId: id.slice(8) };
  return { kind: 'movie', sceneId: id };
}

// ============================================================
// Utility helpers
// ============================================================

function yearFromDate(date?: string): number {
  if (!date) return 0;
  const y = parseInt(date.slice(0, 4), 10);
  return isNaN(y) ? 0 : y;
}

function titleScore(query: string, target: string): number {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase().trim();
  if (q === t) return 100;
  if (t.includes(q) || q.includes(t)) return 80;
  const qWords = new Set(q.split(/\s+/));
  const tWords = new Set(t.split(/\s+/));
  let overlap = 0;
  for (const w of qWords) if (tWords.has(w)) overlap++;
  const maxLen = Math.max(qWords.size, tWords.size, 1);
  return Math.round((overlap / maxLen) * 70);
}

function proxyImageUrl(stashId: string, rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined;
  return `/providers/${stashId}/imageProxy?url=${encodeURIComponent(rawUrl)}`;
}

function resolveFieldSync(fs?: Partial<FieldSync> | null): FieldSync {
  return { ...DEFAULT_FIELD_SYNC, ...(fs ?? {}) };
}

// ============================================================
// Scene → Plex item mappers
// ============================================================

/** Map a Stash scene to a Plex match candidate */
function sceneToMatchResult(
  identifier: string,
  stashId: string,
  scene: StashScene,
  queryTitle: string,
  kind: ItemKind,
  queryYear: number | undefined,
): MatchResult {
  const sceneYear = yearFromDate(scene.date);
  let score = titleScore(queryTitle, scene.title);
  if (queryYear && sceneYear === queryYear) score = Math.min(score + 15, 100);

  const ratingKey = buildRatingKey(kind, scene.id);

  return {
    guid: buildGuid(identifier, kind, scene.id),
    ratingKey,
    key: `/library/metadata/${ratingKey}`,
    title: scene.title,
    year: sceneYear || new Date().getFullYear(),
    score,
    type: kind === 'show' ? 'show' : 'movie',
  };
}

/**
 * Merge full rich metadata fields into an already-built match candidate.
 * Used when Plex requests includeFullMetadata=1 and the candidate's score
 * clears the positive-match threshold (85) — Plex expects the complete
 * item embedded here instead of following up with a separate GET
 * /library/metadata/{id} call, which is what caused summary/date/genre to
 * silently never sync on automatic matches and refreshes.
 */
function enrichMatchResultWithFullMetadata(
  result: MatchResult,
  stashId: string,
  scene: StashScene,
  fs: FieldSync,
): void {
  result.summary = fs.summary ? (scene.details || '') : '';
  result.originallyAvailableAt = fs.date ? (scene.date || undefined) : undefined;
  result.thumb = fs.poster ? proxyImageUrl(stashId, scene.paths?.screenshot) : undefined;
  result.art = fs.background ? proxyImageUrl(stashId, scene.paths?.preview) : undefined;

  if (fs.studio && scene.studio) result.studio = scene.studio.name;
  if (fs.tags && scene.tags?.length) result.Genre = scene.tags.map((t) => ({ tag: t.name }));
  if (fs.performers && scene.performers?.length) {
    result.Role = scene.performers.map((p) => ({
      tag: p.name,
      thumb: fs.poster ? proxyImageUrl(stashId, p.image_path) : undefined,
    }));
  }
}

function sceneToMovieMetadata(
  identifier: string,
  stashId: string,
  scene: StashScene,
  fs: FieldSync,
): MetadataItem {
  const rk = buildRatingKey('movie', scene.id);
  const sceneYear = yearFromDate(scene.date);

  const item: MetadataItem = {
    ratingKey: rk,
    key: `/library/metadata/${rk}`,
    guid: buildGuid(identifier, 'movie', scene.id),
    type: 'movie',
    title: scene.title,
    summary: fs.summary ? (scene.details || '') : '',
    year: sceneYear || new Date().getFullYear(),
    originallyAvailableAt: fs.date ? (scene.date || undefined) : undefined,
    addedAt: scene.created_at ? Math.floor(new Date(scene.created_at).getTime() / 1000) : undefined,
    updatedAt: scene.updated_at ? Math.floor(new Date(scene.updated_at).getTime() / 1000) : undefined,
    thumb: fs.poster ? proxyImageUrl(stashId, scene.paths?.screenshot) : undefined,
    art:   fs.background ? proxyImageUrl(stashId, scene.paths?.preview) : undefined,
  };

  if (fs.studio && scene.studio) item.studio = scene.studio.name;
  if (fs.tags && scene.tags?.length) item.Genre = scene.tags.map((t) => ({ tag: t.name }));
  if (fs.performers && scene.performers?.length) {
    item.Role = scene.performers.map((p) => ({
      tag: p.name,
      thumb: fs.poster ? proxyImageUrl(stashId, p.image_path) : undefined,
    }));
  }

  return item;
}

function sceneToShowMetadata(
  identifier: string,
  stashId: string,
  scene: StashScene,
  fs: FieldSync,
): MetadataItem {
  const rk = buildRatingKey('show', scene.id);
  const sceneYear = yearFromDate(scene.date);

  const item: MetadataItem = {
    ratingKey: rk,
    key: `/library/metadata/${rk}`,
    guid: buildGuid(identifier, 'show', scene.id),
    type: 'show',
    title: scene.title,
    summary: fs.summary ? (scene.details || '') : '',
    year: sceneYear || new Date().getFullYear(),
    originallyAvailableAt: fs.date ? (scene.date || undefined) : undefined,
    addedAt: scene.created_at ? Math.floor(new Date(scene.created_at).getTime() / 1000) : undefined,
    updatedAt: scene.updated_at ? Math.floor(new Date(scene.updated_at).getTime() / 1000) : undefined,
    thumb: fs.poster ? proxyImageUrl(stashId, scene.paths?.screenshot) : undefined,
    art:   fs.background ? proxyImageUrl(stashId, scene.paths?.preview) : undefined,
    childCount: 1,
    leafCount: 1,
  };

  if (fs.studio && scene.studio) item.studio = scene.studio.name;
  if (fs.tags && scene.tags?.length) item.Genre = scene.tags.map((t) => ({ tag: t.name }));

  return item;
}

function sceneToSeasonMetadata(
  identifier: string,
  stashId: string,
  scene: StashScene,
  fs: FieldSync,
): MetadataItem {
  const rk = buildRatingKey('season', scene.id);
  const showRk = buildRatingKey('show', scene.id);
  const sceneYear = yearFromDate(scene.date);

  return {
    ratingKey: rk,
    key: `/library/metadata/${rk}`,
    guid: buildGuid(identifier, 'season', scene.id),
    type: 'season',
    title: 'Season 1',
    summary: fs.summary ? (scene.details || '') : '',
    year: sceneYear || new Date().getFullYear(),
    index: 1,
    leafCount: 1,
    parentRatingKey: showRk,
    parentTitle: scene.title,
    parentThumb: fs.poster ? proxyImageUrl(stashId, scene.paths?.screenshot) : undefined,
    thumb: fs.poster ? proxyImageUrl(stashId, scene.paths?.screenshot) : undefined,
    art:   fs.background ? proxyImageUrl(stashId, scene.paths?.preview) : undefined,
  };
}

function sceneToEpisodeMetadata(
  identifier: string,
  stashId: string,
  scene: StashScene,
  fs: FieldSync,
): MetadataItem {
  const rk = buildRatingKey('episode', scene.id);
  const seasonRk = buildRatingKey('season', scene.id);
  const showRk = buildRatingKey('show', scene.id);
  const sceneYear = yearFromDate(scene.date);

  const item: MetadataItem = {
    ratingKey: rk,
    key: `/library/metadata/${rk}`,
    guid: buildGuid(identifier, 'episode', scene.id),
    type: 'episode',
    title: scene.title,
    summary: fs.summary ? (scene.details || '') : '',
    year: sceneYear || new Date().getFullYear(),
    originallyAvailableAt: fs.date ? (scene.date || undefined) : undefined,
    addedAt: scene.created_at ? Math.floor(new Date(scene.created_at).getTime() / 1000) : undefined,
    updatedAt: scene.updated_at ? Math.floor(new Date(scene.updated_at).getTime() / 1000) : undefined,
    index: 1,
    parentIndex: 1,
    parentRatingKey: seasonRk,
    parentTitle: 'Season 1',
    grandparentRatingKey: showRk,
    grandparentTitle: scene.title,
    thumb: fs.poster ? proxyImageUrl(stashId, scene.paths?.screenshot) : undefined,
    art:   fs.background ? proxyImageUrl(stashId, scene.paths?.preview) : undefined,
  };

  if (fs.tags && scene.tags?.length) item.Genre = scene.tags.map((t) => ({ tag: t.name }));
  if (fs.performers && scene.performers?.length) {
    item.Role = scene.performers.map((p) => ({
      tag: p.name,
      thumb: fs.poster ? proxyImageUrl(stashId, p.image_path) : undefined,
    }));
  }

  return item;
}

// ============================================================
// Provider Service
// ============================================================

class ProviderService {
  async getProviderRoot(stashId: string): Promise<ProviderRootResponse> {
    const stash = await configService.getStash(stashId);
    const name = stash?.name || `Stash ${stashId}`;
    const identifier = buildIdentifier(stashId);

    loggerService.info(`Provider root requested`, stashId);

    return {
      MediaProvider: {
        identifier,
        title: name,
        version: PROVIDER_VERSION,
        protocols: 'metadata',
        Type: [
          { id: 1, Scheme: [{ scheme: identifier }] },
          { id: 2, Scheme: [{ scheme: identifier }] },
        ],
        Feature: [
          { type: 'match',    key: `/library/metadata/matches` },
          { type: 'metadata', key: `/library/metadata` },
          { type: 'images',   key: `/library/metadata/images` },
        ],
      },
    };
  }

  async matchMetadata(stashId: string, request: MatchRequest): Promise<MatchResponse> {
    const kind: ItemKind = request.type === 2 ? 'show' : 'movie';
    const manual = request.manual === 1;
    const wantsFullMetadata = request.includeFullMetadata === 1;
    const cacheKey = `${cacheService.matchKey(stashId, request.title, request.year, manual, wantsFullMetadata)}:${kind}`;
    const cached = cacheService.getMatch(cacheKey) as MatchResponse | undefined;
    if (cached) return cached;

    const stash = await configService.getStash(stashId);
    if (!stash) return { MediaContainer: { size: 0, Metadata: [] } };

    try {
      const identifier = buildIdentifier(stashId);
      const scenes = await stashService.findScenes(stash, request.title, request.year);

      const paired = scenes.map((scene) => ({
        scene,
        result: sceneToMatchResult(identifier, stashId, scene, request.title, kind, request.year),
      }));
      paired.sort((a, b) => b.result.score - a.result.score);

      // Per Plex's official docs, scores over 85 are considered a positive
      // match; anything at or below that may be treated as ambiguous/ignored.
      paired.forEach((p, i) => {
        p.result.score = Math.max(100 - i, 86);
      });

      // Plex may request includeFullMetadata=1 to have the complete item
      // embedded directly in the match response for anything that clears
      // the positive-match threshold (85), skipping a follow-up GET
      // /library/metadata/{id} entirely.
      if (wantsFullMetadata) {
        const fs = resolveFieldSync(stash.fieldSync);
        for (const p of paired) {
          if (p.result.score > 85) {
            enrichMatchResultWithFullMetadata(p.result, stashId, p.scene, fs);
          }
        }
      }

      const results = paired.map((p) => p.result);

      loggerService.info(
        `Match "${request.title}" → ${results.length} results (${kind})`,
        stashId,
      );

      const response: MatchResponse = {
        MediaContainer: { size: results.length, Metadata: results },
      };
      cacheService.setMatch(cacheKey, response);
      return response;
    } catch (err: any) {
      loggerService.error(`match error: ${err.message}`, stashId);
      return { MediaContainer: { size: 0, Metadata: [] } };
    }
  }

  async matchMetadataWithFallback(primaryStashId: string, request: MatchRequest): Promise<MatchResponse> {
    const primary = await this.matchMetadata(primaryStashId, request);
    if (primary.MediaContainer.Metadata.length > 0) return primary;

    const allStashes = await configService.getStashes();
    const fallbacks = allStashes
      .filter((s) => s.enabled && s.id !== primaryStashId)
      .sort((a, b) => a.priority - b.priority);

    for (const stash of fallbacks) {
      try {
        const result = await this.matchMetadata(stash.id, request);
        if (result.MediaContainer.Metadata.length > 0) {
          loggerService.info(
            `Fallback match "${request.title}" resolved via stash=${stash.id}`,
            primaryStashId,
          );
          return result;
        }
      } catch { continue; }
    }

    return { MediaContainer: { size: 0, Metadata: [] } };
  }

  async getMetadata(stashId: string, itemId: string): Promise<MetadataResponse> {
    const cacheKey = cacheService.metadataKey(stashId, itemId);
    const cached = cacheService.getMetadata(cacheKey) as MetadataResponse | undefined;
    if (cached) return cached;

    const stash = await configService.getStash(stashId);
    if (!stash) return { MediaContainer: { size: 0, Metadata: [] } };

    const { kind, sceneId } = parseItemId(itemId);
    const fs = resolveFieldSync(stash.fieldSync);

    try {
      const scene = await stashService.findScene(stash, sceneId);
      if (!scene) return { MediaContainer: { size: 0, Metadata: [] } };

      const identifier = buildIdentifier(stashId);
      let metadata: MetadataItem;

      switch (kind) {
        case 'show':    metadata = sceneToShowMetadata(identifier, stashId, scene, fs); break;
        case 'season':  metadata = sceneToSeasonMetadata(identifier, stashId, scene, fs); break;
        case 'episode': metadata = sceneToEpisodeMetadata(identifier, stashId, scene, fs); break;
        default:        metadata = sceneToMovieMetadata(identifier, stashId, scene, fs);
      }

      loggerService.debug(`Metadata fetched: ${itemId} (${kind})`, stashId);

      const response: MetadataResponse = {
        MediaContainer: { size: 1, Metadata: [metadata] },
      };
      cacheService.setMetadata(cacheKey, response);
      return response;
    } catch (err: any) {
      loggerService.error(`metadata error id=${itemId}: ${err.message}`, stashId);
      return { MediaContainer: { size: 0, Metadata: [] } };
    }
  }

  async getChildren(stashId: string, itemId: string): Promise<ChildrenResponse> {
    const emptyContainer = (key: string): ChildrenResponse => ({
      MediaContainer: { size: 0, key, Metadata: [] },
    });

    const { kind, sceneId } = parseItemId(itemId);
    const key = `/library/metadata/${itemId}/children`;

    if (kind !== 'show' && kind !== 'season') return emptyContainer(key);

    const stash = await configService.getStash(stashId);
    if (!stash) return emptyContainer(key);

    const fs = resolveFieldSync(stash.fieldSync);

    try {
      const scene = await stashService.findScene(stash, sceneId);
      if (!scene) return emptyContainer(key);

      const identifier = buildIdentifier(stashId);

      if (kind === 'show') {
        const season = sceneToSeasonMetadata(identifier, stashId, scene, fs);
        return {
          MediaContainer: {
            size: 1,
            key,
            parentRatingKey: buildRatingKey('show', sceneId),
            parentTitle: scene.title,
            Metadata: [season],
          },
        };
      }

      const episode = sceneToEpisodeMetadata(identifier, stashId, scene, fs);
      return {
        MediaContainer: {
          size: 1,
          key,
          parentRatingKey: buildRatingKey('season', sceneId),
          parentTitle: 'Season 1',
          Metadata: [episode],
        },
      };
    } catch (err: any) {
      loggerService.error(`children error id=${itemId}: ${err.message}`, stashId);
      return emptyContainer(key);
    }
  }

  async getImages(stashId: string, itemId: string): Promise<ImagesResponse> {
    const stash = await configService.getStash(stashId);
    if (!stash) return { MediaContainer: { size: 0, Metadata: [] } };

    const { sceneId } = parseItemId(itemId);
    const identifier = buildIdentifier(stashId);
    const fs = resolveFieldSync(stash.fieldSync);

    try {
      const scene = await stashService.findScene(stash, sceneId);
      if (!scene) return { MediaContainer: { size: 0, Metadata: [] } };

      const rk = `${stashId}.${scene.id}`;
      const images: ImagesResponse['MediaContainer']['Metadata'] = [];

      if (fs.poster && scene.paths?.screenshot) {
        images.push({
          type: 'poster',
          url: proxyImageUrl(stashId, scene.paths.screenshot)!,
          provider: identifier,
          ratingKey: rk,
        });
      }
      if (fs.background && scene.paths?.preview) {
        images.push({
          type: 'art',
          url: proxyImageUrl(stashId, scene.paths.preview)!,
          provider: identifier,
          ratingKey: rk,
        });
      }
      if (fs.poster) {
        for (const p of scene.performers ?? []) {
          if (p.image_path) {
            images.push({
              type: 'poster',
              url: proxyImageUrl(stashId, p.image_path)!,
              provider: identifier,
              ratingKey: rk,
            });
          }
        }
      }

      return { MediaContainer: { size: images.length, Metadata: images } };
    } catch {
      return { MediaContainer: { size: 0, Metadata: [] } };
    }
  }
}

export const providerService = new ProviderService();