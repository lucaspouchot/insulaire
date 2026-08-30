/**
 * TypeScript mirror of the authored content schema.
 *
 * Kept in step with `crates/world/src/definition.rs` and
 * `crates/world/src/tileset.rs`; `docs/content-format.md` is the shared
 * specification. These types describe files on disk — they are not runtime
 * state, and the editor never mutates a definition in place.
 */

/** `[col, row]` in odd-r offset coordinates. */
export type OffsetPair = [number, number];

/**
 * `3` added authored grid appearance shared by editor and Play; `4` made a map
 * a set of hexes rather than a rectangle
 * (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`); `5` adds the authored
 * {@link RevealStyle} (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
 */
export const WORLD_SCHEMA_VERSION = 6;

export const DEFAULT_GRID_LINE_WIDTH = 1;
export const MIN_GRID_LINE_WIDTH = 1;
export const MAX_GRID_LINE_WIDTH = 4;
export const DEFAULT_GRID_COLOR = '#000000';
export const DEFAULT_GRID_ALPHA = 0.25;

/** Authored grid appearance. Visibility remains a per-view toggle. */
export interface GridStyle {
  /** Stroke width in screen pixels, independent of camera zoom. */
  lineWidth: number;
  /** Six-digit RGB colour; opacity is stored separately. */
  color: string;
  /** Stroke opacity from `0` (transparent) to `1` (opaque). */
  alpha: number;
}

export const DEFAULT_GRID_STYLE: Readonly<GridStyle> = {
  lineWidth: DEFAULT_GRID_LINE_WIDTH,
  color: DEFAULT_GRID_COLOR,
  alpha: DEFAULT_GRID_ALPHA,
};

/** Hex rings revealed around the hex the pointer rests on, when none is authored. */
export const DEFAULT_REVEAL_RADIUS = 1;
/**
 * Largest authored reveal radius.
 *
 * Every revealed hex costs one coverage measurement, so the radius is bounded
 * rather than free (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
 */
export const MAX_REVEAL_RADIUS = 6;
/**
 * Opacity of the relief in front of the pointed-at hex, when none is authored.
 *
 * Not `0`: a cell drawn away entirely takes its silhouette with it, and where
 * nothing stands behind it that is a hole in the map rather than a hex seen
 * through (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
 */
export const DEFAULT_REVEAL_OPACITY = 0.25;
/** Opacity of the relief in front of a revealed neighbour, when none is authored. */
export const DEFAULT_REVEAL_NEIGHBOUR_OPACITY = 0.55;

/**
 * How far relief may be seen through when the pointer rests on a buried hex.
 *
 * Both opacities are those of **what stands in the way**, not of the hex behind
 * it: seeing a buried hex means drawing the relief in front of it see-through,
 * since drawing the hex back over that relief puts it in front of the cliff it
 * is behind (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
 *
 * Presentation only, and per map: how tall a map's relief is decides how much
 * of it hides its own hexes, so the dials belong to the map rather than to the
 * application.
 */
export interface RevealStyle {
  /** Hex rings around the pointed-at hex revealed with it; `0` reveals it alone. */
  radius: number;
  /** Opacity of the relief in front of the pointed-at hex; `1` reveals nothing. */
  opacity: number;
  /** The same for the relief in front of the ring around it. */
  neighbourOpacity: number;
}

export const DEFAULT_REVEAL_STYLE: Readonly<RevealStyle> = {
  radius: DEFAULT_REVEAL_RADIUS,
  opacity: DEFAULT_REVEAL_OPACITY,
  neighbourOpacity: DEFAULT_REVEAL_NEIGHBOUR_OPACITY,
};

/** `true` when nothing but the defaults is authored. */
export function isDefaultRevealStyle(reveal: RevealStyle): boolean {
  return (
    reveal.radius === DEFAULT_REVEAL_RADIUS &&
    reveal.opacity === DEFAULT_REVEAL_OPACITY &&
    reveal.neighbourOpacity === DEFAULT_REVEAL_NEIGHBOUR_OPACITY
  );
}

/**
 * `2` added authored tile art
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`); `3` adds
 * the flat view a top-down world is drawn from, and makes `art.flatHeight`
 * required wherever a set declares a grid
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
 */
export const TILE_SET_SCHEMA_VERSION = 3;

/** Authored width of a tile image when a set declares no geometry. */
export const DEFAULT_TILE_WIDTH = 32;
/** Authored height of a surface image when a set declares no geometry. */
export const DEFAULT_SURFACE_HEIGHT = 20;
/**
 * Authored height of a flat image when a set declares no geometry.
 *
 * The untilted hexagon's own bounding box: a pointy-top hexagon is
 * `2 / sqrt(3)` times as tall as it is wide, so `32` wide is `37` tall.
 */
export const DEFAULT_FLAT_HEIGHT = 37;
/** Authored pixels one level of relief lifts a tile, when none is declared. */
export const DEFAULT_ELEVATION_STEP = 8;

/**
 * Authored height of an elevation image when a set declares no geometry.
 *
 * The faces' own bounding box: the `V` the hexagon's lower edges cut, a quarter
 * of the surface height deep, plus one whole step of face below it.
 */
export const DEFAULT_ELEVATION_HEIGHT = DEFAULT_SURFACE_HEIGHT / 4 + DEFAULT_ELEVATION_STEP;
/** Largest tile image this build accepts, on either side. */
export const MAX_TILE_IMAGE_SIZE = 512;
/** Most explicit elevation levels one tile may author. */
export const MAX_ELEVATION_LEVELS = 32;
/** Most variants one surface or one elevation level may offer. */
export const MAX_TILE_VARIANTS = 16;

export interface TileVisual {
  visualId: string;
  fallbackColor: string;
  hints?: Record<string, string>;
}

/**
 * The pixel grid a tile set's images are authored on.
 *
 * Mirrors `crates/world/src/tile_art.rs`. A **flat** image holds the whole
 * untilted hexagon, which is what a top-down world draws
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`). A **surface**
 * image holds the tilted top face alone. An **elevation** image holds only the
 * side faces: its first row is the hexagon's lower shoulder line, so its top
 * {@link shoulderDepth} rows are the `V` the two lower edges cut, and below
 * that it carries a band {@link faceHeight} thick following the same `V`
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`). How far
 * that band lifts a cell is {@link TileArtGeometry.elevationStep}, which may be
 * shorter — one image then spans several levels; see {@link bandLevels}.
 */
export interface TileArtGeometry {
  width: number;
  /** Height of a flat image: `width * 2 / sqrt(3)`, the untilted hexagon. */
  flatHeight: number;
  surfaceHeight: number;
  elevationHeight: number;
  elevationStep: number;
}

/** One image a tile may be drawn with. */
export interface TileArtVariant {
  id: string;
  /** Path under the content root. */
  asset: string;
}

/** One authored step of relief: the images that may draw it. */
export interface ElevationLevel {
  name?: string;
  variants: TileArtVariant[];
}

/**
 * What draws the levels above the last explicit one.
 *
 * Absent reuses the highest explicit level.
 */
export type ElevationRepeat = { level: number } | { pattern: number[] };

/** A tile's ladder of relief. Level `0` is the surface. */
export interface TileElevation {
  levels: ElevationLevel[];
  repeat?: ElevationRepeat | null;
}

/**
 * Everything a tile is drawn from, in either projection.
 *
 * {@link flat} draws a top-down world; {@link surface} and {@link elevation}
 * draw an isometric one. Whatever the world's projection finds nothing for is
 * drawn in `visual.fallbackColor`
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
 */
export interface TileArt {
  /** Images for the untilted hexagon. Top-down worlds only. */
  flat?: TileArtVariant[];
  /** Images for the tilted top face. Isometric worlds only. */
  surface?: TileArtVariant[];
  /** The ladder of relief. Isometric worlds only. */
  elevation?: TileElevation;
}

export interface TileDefinition {
  id: string;
  name?: string;
  terrain: string;
  /** `0` means impassable. */
  movementCost: number;
  tags?: string[];
  visual: TileVisual;
  art?: TileArt;
}

export interface TileSetDefinition {
  id: string;
  schemaVersion: number;
  name?: string;
  /** The pixel grid every image in this set is authored on. */
  art?: TileArtGeometry;
  tiles: TileDefinition[];
}

/** The geometry a set declares, or the shipped defaults. */
export function tileArtGeometry(tileSet: Pick<TileSetDefinition, 'art'>): TileArtGeometry {
  return {
    width: tileSet.art?.width ?? DEFAULT_TILE_WIDTH,
    flatHeight: tileSet.art?.flatHeight ?? DEFAULT_FLAT_HEIGHT,
    surfaceHeight: tileSet.art?.surfaceHeight ?? DEFAULT_SURFACE_HEIGHT,
    elevationHeight: tileSet.art?.elevationHeight ?? DEFAULT_ELEVATION_HEIGHT,
    elevationStep: tileSet.art?.elevationStep ?? DEFAULT_ELEVATION_STEP,
  };
}

/**
 * How far the hexagon's lower edges fall, from its shoulders to its south
 * vertex.
 *
 * A quarter of the top face's height, exactly: a pointy-top hexagon puts its
 * `±30°` corners half a radius off centre and the projection scales both by the
 * same tilt. This is the depth of the `V` an elevation image leaves above its
 * faces — **not** how far down that image sits; see {@link shoulderLine}.
 */
export function shoulderDepth(geometry: TileArtGeometry): number {
  return Math.floor(geometry.surfaceHeight / 4);
}

/**
 * The row of a surface image the hexagon's **lower** shoulders sit on, which is
 * where an elevation image is blitted.
 *
 * A pointy-top hexagon reaches its full width a quarter of the way down and
 * narrows again a quarter from the bottom, so the lower shoulders are three
 * quarters down: `surfaceHeight - shoulderDepth`. An elevation image's own row
 * `0` is that line, and its `V` then falls exactly onto the two lower edges
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
 */
export function shoulderLine(geometry: TileArtGeometry): number {
  return geometry.surfaceHeight - shoulderDepth(geometry);
}

/** Height of the faces themselves, below the `V`. */
export function faceHeight(geometry: TileArtGeometry): number {
  return Math.max(0, geometry.elevationHeight - shoulderDepth(geometry));
}

/**
 * How many levels of elevation one drawn band of faces spans.
 *
 * A band is as thick as the canvas leaves room for — {@link faceHeight} — and a
 * level lifts `elevationStep`, so a set whose step is a whole band answers `1`:
 * one image per level, edge to edge, which is what every set said before the
 * two were told apart. A **shorter** step means one image covers several
 * levels, which is how the same art draws a lower cliff without being sliced
 * into a repeating strip
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
 *
 * Rounds down and never to zero, so a band that does not divide evenly overlaps
 * its neighbour by the remainder rather than leaving a gap.
 */
export function bandLevels(geometry: TileArtGeometry): number {
  const step = Math.max(1, geometry.elevationStep);
  return Math.max(1, Math.floor(faceHeight(geometry) / step));
}

/** How the renderer projects a world; mirrors the engine's `ProjectionMode`. */
export type ProjectionMode = 'topDown' | 'isometric';

/** Projected tile-face heights occupied by a 128-pixel character by default. */
export const DEFAULT_CHARACTER_HEIGHT_TILES = 2;
/** Editor and Rust validation bounds for the map-wide character scale. */
export const MIN_CHARACTER_HEIGHT_TILES = 0.25;
export const MAX_CHARACTER_HEIGHT_TILES = 8;

/** Authored elevation is packed as one signed byte per cell for the renderer. */
export const MIN_ELEVATION = -128;
export const MAX_ELEVATION = 127;

/**
 * A cell's own answer to "which picture", by id rather than by index.
 *
 * Mirrors `PlacedTileArt` in `crates/world/src/definition.rs`. Three
 * independent choices, all optional, and an absent one means "roll it" — which
 * is what nearly every cell of nearly every map says
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
 */
export interface PlacedTileArt {
  /** Id of a surface variant of this cell's own tile. */
  surface?: string;
  /**
   * Id of the tile whose elevation ladder cuts the faces.
   *
   * How a meadow stands on a rock cliff. The top face is unaffected: it always
   * comes from the cell's own tile.
   */
  elevationTile?: string;
  /** Id of the elevation variant; absent follows {@link surface}. */
  elevation?: string;
}

/** A cell whose tile differs from {@link WorldDefinition.defaultTile}. */
export interface PlacedTile {
  at: OffsetPair;
  tile: string;
  /** Whole steps of relief, `MIN_ELEVATION`..`MAX_ELEVATION`. Omitted when `0`. */
  elevation?: number;
  tags?: string[];
  /** What this cell is drawn with; absent rolls everything. */
  art?: PlacedTileArt;
}

export interface EntityDefinition {
  id: string;
  templateId: string;
  at: OffsetPair;
  tags?: string[];
  /**
   * Opaque authored values. The map editor conventionally stores
   * `previewCharacter` here; simulation ignores it and player creation remains
   * authoritative in Play.
   */
  properties?: Record<string, unknown>;
}

export interface LocationDefinition {
  id: string;
  at: OffsetPair;
  name?: string;
  tags?: string[];
}

/** What makes a {@link MapLink} fire. Only `enter` is implemented. */
export type LinkTrigger = 'enter' | 'interact';

/**
 * A cell that sends the player to another map.
 *
 * The only cross-file reference in the world schema: `targetWorld` names a
 * world that lives in another file, so the editor can only check it once the
 * whole project is loaded (`docs/adr/ADR-0014-map-links.md`).
 */
export interface MapLink {
  id: string;
  at: OffsetPair;
  targetWorld: string;
  targetAt: OffsetPair;
  /** Omitted when `enter`, which is the default. */
  trigger?: LinkTrigger;
  name?: string;
  tags?: string[];
}

export interface WorldMetadata {
  author?: string;
  description?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** Whether a cell is part of the map or a hole in it. */
export type CellPresence = 'present' | 'absent';

/**
 * The authored shape of a map: a default plus the cells that differ.
 *
 * The same idiom as `defaultTile` plus `tiles`, and for the same reason — the
 * two ways an author reaches a custom shape are opposites. Carving a coastline
 * out of a full canvas lists holes; drawing an archipelago on an empty one lists
 * hexes. The editor writes whichever list is shorter
 * (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
 */
export interface MapShape {
  /** What a cell is when {@link exceptions} does not name it. */
  default?: CellPresence;
  /** The cells that are the opposite of {@link default}. */
  exceptions?: [number, number][];
}

/**
 * One decoration standing on one cell. Mirrors `PlacedDecoration`.
 *
 * The *definition* says what a tree looks like and which side of the characters
 * it is drawn on; this says which tree, where, and whether **this** one can be
 * interacted with — the only question that needs the thing to exist in a world
 * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
 */
export interface PlacedDecoration {
  /** Stable id, unique within the world; what a scenario addresses. */
  id: string;
  /** Referenced {@link DecorationDefinition} id. */
  decoration: string;
  at: [number, number];
  /**
   * Whole-pixel nudge from where the definition's anchor puts it.
   *
   * Absent — the usual case — is exactly what the decoration editor authored.
   * Positive moves the drawing right and down, in the tile set's authored
   * pixels, which is the direction dragging it in that editor moves it.
   */
  offset?: PixelOffset;
  /** Whether a player may interact with this placement. */
  interactive?: boolean;
  tags?: string[];
}

export interface WorldDefinition {
  id: string;
  schemaVersion: number;
  name?: string;
  /**
   * Id of the {@link ZoneDefinition} this map belongs to.
   *
   * Every map has a zone; absent or empty names the project's default one
   * rather than *no* zone. A zone id only resolves against the project that
   * declares it, so the Rust validator is what checks it
   * (`docs/adr/ADR-0018-map-zones.md`).
   */
  zone?: string;
  /**
   * North-west corner of the extent; the coordinate stored at buffer index `0`.
   *
   * Absent means `[0, 0]`, where every map was anchored before extents could
   * move. Extending a map northwards or westwards moves this rather than
   * renumbering its cells, so an authored coordinate keeps its hex — and its
   * odd-r row parity — forever
   * (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
   */
  origin?: [number, number];
  width: number;
  height: number;
  /**
   * Which of the extent's cells the map actually has.
   *
   * Absent is the full rectangle, which is what every map authored before
   * schema version 4 means.
   */
  shape?: MapShape;
  orientation?: 'pointy' | 'flat';
  /** Presentation only; defaults to `topDown` when absent. */
  projection?: ProjectionMode;
  /** Tile-face heights occupied by a 128-pixel character; defaults to `2`. */
  characterHeightTiles?: number;
  /** Appearance used whenever the grid is visible in the editor or Play. */
  grid?: GridStyle;
  /** How far relief may be seen through around the pointer; defaults apply when absent. */
  reveal?: RevealStyle;
  tileSetId: string;
  defaultTile: string;
  tiles?: PlacedTile[];
  entities?: EntityDefinition[];
  /**
   * Decorations standing on this map's cells, in author order.
   *
   * Author order breaks a tie within a plane: two trees from one definition
   * sort equally, and the later one is drawn over the earlier
   * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   */
  decorations?: PlacedDecoration[];
  locations?: LocationDefinition[];
  links?: MapLink[];
  metadata?: WorldMetadata;
}

export const PROJECT_SCHEMA_VERSION = 1;

/** One content file a project ships, by id and path under the content root. */
export interface ContentRef {
  id: string;
  path: string;
}

/**
 * The manifest of one game: which content files it is made of, and where a
 * session starts.
 *
 * It is what lets a client build boot with no editor and no backend — it reads
 * this file and loads exactly what it lists
 * (`docs/adr/ADR-0015-client-delivery-build.md`).
 */
/**
 * Id of the zone a project falls back on when it declares none.
 *
 * Mirrors `insulaire_world::DEFAULT_ZONE_ID`.
 */
export const DEFAULT_ZONE_ID = 'default';

/**
 * A group of maps that belong together.
 *
 * The unit of simulated scope: a tick advances the maps of one zone, not only
 * the map the player stands on (`docs/adr/ADR-0018-map-zones.md`). Zones are
 * declared by the project, and every map names exactly one.
 */
export interface ZoneDefinition {
  id: string;
  name?: string;
}

/**
 * One language the game is available in, and the files that translate it.
 *
 * Each file's {@link ContentRef.id} is its **namespace**: `locales/fr/menu.json`
 * registered as `menu` provides the keys under `menu.`
 * (`docs/adr/ADR-0020-localised-content-keys.md`).
 */
export interface LanguageDefinition {
  id: string;
  /** Name shown in the language picker, in that language. */
  name?: string;
  files?: ContentRef[];
}

/** The languages a project ships, and which one stands in for the others. */
export interface LocalesDefinition {
  /** Id of the fallback language. Absent means the first declared. */
  default?: string;
  languages?: LanguageDefinition[];
}

export interface ProjectDefinition {
  id: string;
  schemaVersion: number;
  name?: string;
  startWorld: string;
  /** Zones, in author order. The first is the default; absent means one implicit
   * {@link DEFAULT_ZONE_ID} zone. */
  zones?: ZoneDefinition[];
  tileSets: ContentRef[];
  worlds: ContentRef[];
  /** Character definitions to load. Absent means the project ships none. */
  characters?: ContentRef[];
  /** Decoration definitions to load. Absent means the project ships none. */
  decorations?: ContentRef[];
  /** Object definitions to load. Absent means the project ships none. */
  objects?: ContentRef[];
  /** Generic player-character creation declaration. */
  characterCreation?: ContentRef;
  /** The title screen a client opens on. Absent means it starts on a map. */
  titleScreen?: ContentRef;
  /** The settings this game offers. The application's own are not content. */
  settings?: ContentRef;
  /** Languages and their locale files. Absent means the application's own. */
  locales?: LocalesDefinition;
}

export const TITLE_SCREEN_SCHEMA_VERSION = 1;

/**
 * What a title screen button does.
 *
 * A closed set: an action is something the application implements, so a new one
 * is a code change, not a content field
 * (`docs/adr/ADR-0021-authored-title-screen.md`).
 */
export type TitleAction = 'newGame' | 'continue' | 'settings' | 'credits' | 'quit';

export interface TitleButton {
  action: TitleAction;
  /** Key of its label, resolved against the language in use. */
  labelKey: string;
  /** Authored out of the menu without deleting it. */
  hidden?: boolean;
}

export type BackgroundFit = 'cover' | 'contain' | 'tile';

export interface TitleBackground {
  /** Path under the content root. Empty means a plain background. */
  image: string;
  fit: BackgroundFit;
  /** CSS colour over the image, and used alone when there is none. */
  tint: string;
}

export interface TitleLogo {
  image: string;
  /** Width as a percentage of the screen, `1..=100`. */
  maxWidthPercent: number;
}

export interface TitleSplash {
  /** Path under the content root. Empty shows the title alone. */
  image: string;
  durationMs: number;
  skippable: boolean;
}

export interface TitleMusic {
  track: string;
  loops: boolean;
  /** Relative to the music volume setting, `0..=1`. */
  gain: number;
  fadeInMs: number;
}

export interface TitleTheme {
  accent: string;
  text: string;
  panel: string;
  /** CSS font family for the title. */
  font: string;
}

export type TitleLayout = 'left' | 'center' | 'right';

/**
 * The authored title screen: what a delivered client opens on.
 *
 * Mirrors `crates/world/src/title_screen.rs`. Every field the engine fills a
 * default for is required here, because this type describes what comes *out*
 * of `titleScreen()` — the file itself may leave most of it out.
 */
export interface TitleScreenDefinition {
  id: string;
  schemaVersion: number;
  titleKey: string;
  subtitleKey: string;
  background: TitleBackground;
  logo: TitleLogo | null;
  splash: TitleSplash | null;
  music: TitleMusic | null;
  theme: TitleTheme;
  layout: TitleLayout;
  buttons: TitleButton[];
}

/** Version 2 adds the physical-key `keyBinding` control. */
export const SETTINGS_SCHEMA_VERSION = 2;

/**
 * How a setting is presented, and therefore what values it accepts.
 *
 * Mirrors `crates/world/src/settings.rs`. The **same** vocabulary describes the
 * application's own settings and the game's, so one component renders both
 * (`docs/adr/ADR-0022-settings.md`).
 */
export type ControlKind =
  | 'toggle'
  | 'checkbox'
  | 'select'
  | 'multiSelect'
  | 'slider'
  | 'number'
  | 'text'
  | 'color'
  | 'keyBinding';

/** When a setting may be changed. */
export type SettingScope = 'session' | 'newGame';

/** A value a setting can hold. */
export type SettingValue = boolean | number | string | string[];

export interface ControlOption {
  value: string;
  labelKey: string;
}

/** Shows a field only when another one holds a given value. */
export interface ShowIf {
  field: string;
  equals: SettingValue;
}

export interface ControlDefinition {
  /** Stable id; the key its value is stored under. */
  id: string;
  labelKey: string;
  helpKey?: string;
  control: ControlKind;
  default: SettingValue;
  options?: ControlOption[];
  min?: number | null;
  max?: number | null;
  step?: number | null;
  /** Shown next to the value, e.g. `%`. Displayed as written. */
  unit?: string;
  scope?: SettingScope;
  showIf?: ShowIf | null;
}

export interface SettingsGroup {
  id: string;
  labelKey: string;
  fields: ControlDefinition[];
}

export interface SettingsSection {
  id: string;
  labelKey: string;
  groups: SettingsGroup[];
}

/** The settings a project declares. */
export interface SettingsDefinition {
  id: string;
  schemaVersion: number;
  sections: SettingsSection[];
}

/** Values by field id, as stored and as `createGame` receives them. */
export type SettingsValues = Record<string, SettingValue>;

/** Mirrors `CHARACTER_SCHEMA_VERSION`; `3` makes child boxes anchor-relative. */
export const CHARACTER_SCHEMA_VERSION = 3;

/** Largest sprite canvas a character may declare, on either side. */
export const MAX_SPRITE_RESOLUTION = 256;

/**
 * What a character definition is used for.
 *
 * Filing, not behaviour: neither the resolver nor the renderer reads it. It
 * exists so an editor can group definitions and a later feature can ask for
 * "the playable ones" without a naming convention
 * (`docs/adr/ADR-0024-character-definitions.md`).
 */
export type CharacterCategory = 'player' | 'npc' | 'enemy' | 'monster' | 'other';

/**
 * The canvas a character's sprites are authored on, in pixels.
 *
 * Every {@link PixelRect} is a position on *this* grid, so a host knows how big
 * the character is without loading a single image
 * (`docs/adr/ADR-0024-character-definitions.md`).
 */
export interface SpriteResolution {
  width: number;
  height: number;
}

/**
 * Where a tint's colour comes from.
 *
 * `parameter` is what makes "hair colour" a choice instead of one image per
 * colour: a single greyscale sprite is recoloured by the value the
 * customisation holds.
 */
export type ColorSource = { fixed: string } | { parameter: string };

/** The image a layer draws, and how it is recoloured. */
export interface Sprite {
  /** Path under the content root. */
  asset: string;
  /** Recolouring, fixed or read off a parameter. Absent draws it as authored. */
  tint?: ColorSource | null;
}

/**
 * A sprite's box on the character's canvas: `[x, y, width, height]`, in pixels.
 *
 * Whole pixels, always: the renderer blits at an integer zoom, so a sprite
 * lands on the grid it was drawn on. `x` and `y` may be negative — a cape
 * overhangs on purpose.
 */
export type PixelRect = [number, number, number, number];

/** One appearance a layer can take, and the choices it answers to. */
export interface LayerVariant {
  id: string;
  /**
   * Parameter values this variant requires; absent means "always".
   *
   * Every entry must match. A parameter holding a list matches a scalar it
   * *contains*, so one variant can answer "is a helmet worn".
   */
  when?: Record<string, SettingValue>;
  /**
   * Where it is drawn, **relative to the point its layer hangs off**.
   *
   * A child measures from its parent's `parentAnchor`, so a sprite drawn to sit
   * on that joint is `[0, 0, width, height]`; a root measures from the canvas
   * origin (`docs/adr/ADR-0024-character-definitions.md`).
   */
  rect?: PixelRect;
  /**
   * Where this variant is drawn in the stack, overriding the author order.
   *
   * Everything sorts by `order` first and by declaration second, so a variant
   * with `1` draws over every `0` and the `0`s keep the file's order. It is on
   * the variant because that is where a condition already lives: a cape that
   * passes in front of the body when the character is seen from the side is
   * the same `when` that chose the side-on drawing, with one more field.
   */
  order?: number;
  sprite: Sprite;
}

/**
 * A named point on a layer, for another layer to hang off.
 *
 * `at` is measured from its **own layer's** origin — the neck, the hair line,
 * the grip of a hand. A root's origin is the canvas origin, so a root's anchors
 * read as canvas positions; every other layer's anchors travel with it.
 *
 * It is what a child is **placed from**
 * (`docs/adr/ADR-0024-character-definitions.md`). It is also what
 * lets the editor draw the skeleton through the joints, and it is the pivot a
 * rotation will turn about the day there is one.
 */
export interface AttachmentPoint {
  id: string;
  at: PixelOffset;
}

/**
 * One piece a character is drawn from. Layers draw back to front.
 *
 * A layer is also a **node**: `parent` makes it hang off another one, it is
 * *placed* from the anchor it names there, and an animation's offsets compose
 * down the same tree. Parentage and draw order stay independent — a cape hangs
 * off the body and is drawn behind it, until a variant says otherwise.
 */
export interface CharacterLayer {
  id: string;
  /** Id of the layer this one hangs off. Absent makes it a root. */
  parent?: string | null;
  /**
   * Which of the parent's anchors it hangs off, and is **placed from**.
   * Absent measures from the parent's own origin.
   */
  parentAnchor?: string | null;
  /** Points other layers may hang off. */
  anchors?: AttachmentPoint[];
  /** The appearances it can take, most specific first — the first match wins. */
  variants: LayerVariant[];
}

/**
 * A translation in whole canvas pixels: `[x, y]`.
 *
 * The same units and the same reasoning as {@link PixelRect}: a sprite moved by
 * half a pixel is a sprite with a seam down its middle. `y` is positive
 * **downwards**.
 */
export type PixelOffset = [number, number];

/** Mirrors `MAX_ANIMATION_FRAMES`: the longest an animation may be. */
export const MAX_ANIMATION_FRAMES = 240;

/** Mirrors `DEFAULT_FRAME_DURATION_MS`. */
export const DEFAULT_FRAME_DURATION_MS = 120;

/** How a keyframe reaches the one after it. */
export type Interpolation = 'step' | 'linear';

/**
 * One node's value at one frame.
 *
 * The transform is flattened into the keyframe, so a file reads
 * `{ "frame": 1, "offset": [0, -2] }` — the *shape* keeps the concept of a
 * local transform, the file keeps the diff readable.
 */
export interface Keyframe {
  /** Which frame of the animation this value is written at, `0`-based. */
  frame: number;
  /** Translation from the rest pose, in canvas pixels. */
  offset?: PixelOffset;
  /** How it reaches the next keyframe of its track. Absent is `step`. */
  interpolation?: Interpolation;
}

/**
 * The pose values one frame of an animation sets.
 *
 * The values are flattened beside the frame number, so a file reads
 * `{ "frame": 1, "step": "pass" }`. `frame` is therefore the one key a pose
 * may not use.
 */
export interface PoseKey {
  /** Which frame of the animation these values are set at, `0`-based. */
  frame: number;
  /** The values, laid over the animation's own {@link Animation.pose}. */
  [key: string]: SettingValue | undefined;
}

/** Everything one node does over the course of an animation. */
export interface AnimationTrack {
  /** Id of the layer this track drives. */
  node: string;
  keyframes: Keyframe[];
}

/**
 * The gameplay situation an authored animation illustrates.
 *
 * Exact hex directions override the corresponding left/right role. The latter
 * two are therefore enough for a complete character, while all six remain
 * authorable (`docs/adr/ADR-0030-gameplay-selects-character-animations-by-role.md`).
 */
export type AnimationRole =
  | 'idle'
  | 'moveLeft'
  | 'moveRight'
  | 'moveEast'
  | 'moveNorthEast'
  | 'moveNorthWest'
  | 'moveWest'
  | 'moveSouthWest'
  | 'moveSouthEast';

/**
 * A named movement a character can play.
 *
 * Two halves, and they answer different questions. {@link tracks} say what
 * **moves**: offsets from the rest pose, per node, per frame, composing down
 * the layer tree so a node with no track follows its parent. {@link pose} and
 * {@link poses} say what is **drawn**: values that join the customisation for
 * as long as the animation is playing, so a layer picks its sprite through the
 * same `when` conditions it already uses for hair colour or armour
 * (`docs/adr/ADR-0025-characters-animate-by-hierarchy-and-offsets.md`).
 */
export interface Animation {
  /** Stable id, unique within the definition — `idle`, `walk`, `attack`. */
  id: string;
  /** Shown in the editor. Not player-facing, so not a key. */
  name?: string;
  /** Optional gameplay meaning; ids stay arbitrary and author-owned. */
  role?: AnimationRole | null;
  /**
   * Id of the animation this one is the **mirror image** of.
   *
   * A character walking right walks left the same way, seen the other way
   * round. A mirror takes its source's timing, tracks and sprites, and the
   * whole canvas is drawn flipped; nothing else about it is read. A mirror of
   * a mirror is refused.
   */
  mirrorOf?: string | null;
  /**
   * How many frames long it is, `1..=`{@link MAX_ANIMATION_FRAMES}.
   *
   * Optional because a mirror declares no timing of its own.
   */
  frames?: number;
  /** How long each frame lasts, in milliseconds. */
  frameDurationMs?: number;
  /** Whether it starts again when it ends. */
  looping?: boolean;
  /**
   * Pose values that hold for the **whole** animation.
   *
   * What is true of every frame of it: a walk seen from the side is
   * `{ view: 'side' }`, and every layer with a side-on drawing says so once.
   */
  pose?: Record<string, SettingValue>;
  /**
   * Pose values set frame by frame, laid over {@link pose}.
   *
   * Each entry is the complete set of overrides for its frame, and it holds —
   * before the first it is the first, after the last it is the last.
   */
  poses?: PoseKey[];
  /** What moves, and when. */
  tracks?: AnimationTrack[];
}

/**
 * How a kind of character can be drawn, and what may be chosen about it.
 *
 * Mirrors `crates/world/src/character.rs`. A parameter is a
 * {@link ControlDefinition} — the settings vocabulary — so the component that
 * renders a volume slider renders "hair colour" too. `scope` is not part of
 * this format and is ignored on a character's parameters.
 */
export interface CharacterDefinition {
  id: string;
  schemaVersion: number;
  /** Shown in the editor. Not player-facing, so not a key. */
  name?: string;
  category?: CharacterCategory;
  /** The canvas its sprites are authored on. */
  resolution?: SpriteResolution;
  /** The choices it offers, in author order. A definition may offer none. */
  parameters?: ControlDefinition[];
  /** The pieces it is drawn from, back to front. */
  layers?: CharacterLayer[];
  /** The movements it can play. A still character declares none. */
  animations?: Animation[];
}

/** Chosen values by parameter id — a character's customisation. */
export type CharacterValues = Record<string, SettingValue>;

/** Mirrors `CHARACTER_CREATION_SCHEMA_VERSION`. */
export const CHARACTER_CREATION_SCHEMA_VERSION = 1;

/** Where a creation choice sends its resolved value. */
export type CreationBinding = { kind: 'character' } | { kind: 'parameter'; parameter: string };

/** A generic creation choice using the shared control vocabulary. */
export interface CreationChoice extends ControlDefinition {
  binding: CreationBinding;
}

/** A value stored on the player independently of appearance. */
export interface CharacteristicDefinition extends Omit<ControlDefinition, 'default'> {
  default: SettingValue | null;
  nullable?: boolean;
}

/** Animation used when moving between workflow screens. */
export type ScreenTransition = 'none' | 'fade' | 'slideLeft' | 'slideUp';

/** One item placed on a player-facing creation screen. */
export type CreationBlock =
  | { type: 'text'; textKey: string }
  | { type: 'choice'; choice: string }
  | { type: 'characteristic'; characteristic: string }
  | { type: 'preview'; animation?: string; parameters?: Record<string, SettingValue> }
  | { type: 'summary' };

/** One ordered page of the creation workflow. */
export interface CreationScreen {
  id: string;
  titleKey: string;
  textKey?: string;
  transition?: ScreenTransition;
  blocks?: CreationBlock[];
}

/** Authored character creation, entirely neutral about choice semantics. */
export interface CharacterCreationDefinition {
  id: string;
  schemaVersion: number;
  baseCharacter?: string;
  choices?: CreationChoice[];
  characteristics?: CharacteristicDefinition[];
  screens?: CreationScreen[];
}

/** Generic result produced by the Rust creation resolver. */
export interface CharacterCreationResult {
  character: string;
  choices: Record<string, SettingValue>;
  parameters: CharacterValues;
  characteristics: Record<string, SettingValue | null>;
}

/** One layer of a resolved character, ready to draw. */
export interface ResolvedLayer {
  layer: string;
  variant: string;
  /**
   * Where to draw it on the canvas, **placement and animation included** — an
   * absolute box, whatever the file measured it from.
   */
  rect: PixelRect;
  /**
   * Where this node's local frame ended up: what the authored box and the
   * layer's anchors were measured from. A renderer ignores it; an editor needs
   * it to turn a click back into the number an author typed.
   */
  origin: PixelOffset;
  /**
   * How far the animation moved it from its rest pose, inherited transforms
   * included. Already applied to {@link rect}; a renderer ignores it, and an
   * editor uses it to say what the hierarchy did.
   */
  offset: PixelOffset;
  /** Path of the image to blit, under the content root. */
  asset: string;
  /** CSS colour to recolour it with. **Empty means draw it as authored.** */
  tint: string;
}

/** Which moment of which animation a resolved character is. */
export interface ResolvedPose {
  animation: string;
  /** The frame it is showing, `0`-based. */
  frame: number;
  /** The time it was asked for, in milliseconds since the animation started. */
  timeMs: number;
  /** Duration of one pass, using the source timing for a mirror. */
  durationMs: number;
  /**
   * The pose values in force at that moment, which is what chose the variants.
   * Absent when the animation sets none.
   */
  values?: Record<string, SettingValue>;
}

/**
 * A character, resolved: an ordered list of sprites to draw.
 *
 * Produced by the Rust resolver, never assembled here — the editor preview and
 * the game draw the same payload, which is what makes the preview honest.
 */
export interface ResolvedCharacter {
  character: string;
  category: CharacterCategory;
  /** The canvas the layer boxes are positions on. */
  resolution: SpriteResolution;
  /** The customisation actually applied, defaults filled in. */
  values: CharacterValues;
  /** What to draw, back to front. */
  layers: ResolvedLayer[];
  /**
   * Whether to draw the whole canvas flipped left-to-right.
   *
   * A statement about the *output*, not about any layer. Flipping the boxes
   * without flipping the pixels inside them is a character taken apart and put
   * back wrong, so the renderer mirrors the canvas as a whole.
   */
  mirrored: boolean;
  /** The animation and moment this pose came from. Absent is the rest pose. */
  pose?: ResolvedPose;
}

/* -------------------------------------------------------------- decorations */

/** Mirrors `DECORATION_SCHEMA_VERSION`. */
export const DECORATION_SCHEMA_VERSION = 2;

/** Mirrors `MAX_FLIPBOOK_FRAMES`: the longest one flipbook may be. */
export const MAX_FLIPBOOK_FRAMES = 64;

/** Mirrors `MAX_DECORATION_ORDER`: how far a decoration may sort in its plane. */
export const MAX_DECORATION_ORDER = 999;

/** Mirrors `MAX_DECORATION_OFFSET`: how far one placement may be nudged. */
export const MAX_DECORATION_OFFSET = 256;

/** The canvas a decoration is authored on when its file names none. */
export const DEFAULT_DECORATION_RESOLUTION: Readonly<SpriteResolution> = {
  width: 32,
  height: 48,
};

/**
 * What a decoration is, for filing.
 *
 * Filing, not behaviour — the same role {@link CharacterCategory} plays
 * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
 */
export type DecorationCategory = 'nature' | 'building' | 'prop' | 'container' | 'other';

/**
 * Which side of the characters a decoration is drawn on.
 *
 * The two groups of z-index. A character standing on a cell is drawn between
 * them, which is the one thing a single combined ordering cannot say.
 */
export type DecorationPlane = 'behind' | 'front';

/**
 * One appearance a decoration can play, as an ordered list of images.
 *
 * Both an animation (a torch flickering) and a **state** (a chest that is open)
 * are this; the second is one frame long and the scenario asks for it by id.
 */
export interface DecorationAnimation {
  /** Stable id, unique within the definition — `idle`, `open`, `burning`. */
  id: string;
  /** Shown in the editor. Not player-facing, so not a key. */
  name?: string;
  /** Paths under the content root, in play order. */
  frames: string[];
  /** How long each frame lasts, in milliseconds. */
  frameDurationMs?: number;
  /** Whether it starts again when it ends. A state does not; a flame does. */
  looping?: boolean;
}

/**
 * A kind of thing that stands on a hex: a tree, a house, a chest, a bush.
 *
 * Mirrors `crates/world/src/decoration.rs`. What it carries that a character
 * does not is everything about *sharing a cell*: the {@link anchor} pixel that
 * lands on the ground point, the {@link plane} that says whether a character
 * walks in front of it or behind it, and the {@link order} within that plane.
 */
export interface DecorationDefinition {
  id: string;
  schemaVersion: number;
  /** Shown in the editor. Not player-facing, so not a key. */
  name?: string;
  category?: DecorationCategory;
  /** The canvas every frame is drawn on. */
  resolution?: SpriteResolution;
  /**
   * The pixel of that canvas which lands on the cell's ground point.
   *
   * A tree anchors at the foot of its trunk, a lantern at the ring it hangs
   * from. Absent is the canvas origin; the editor starts a new decoration at
   * the bottom middle, which is what a thing standing on the ground wants.
   */
  anchor?: PixelOffset;
  /** Whether characters on the same cell pass in front of it or behind it. */
  plane?: DecorationPlane;
  /** Sort key within {@link plane}; higher draws later, so over. */
  order?: number;
  tags?: string[];
  /** The appearances it can play, in author order. */
  animations?: DecorationAnimation[];
  /** Id of the animation played by default; absent names the first declared. */
  defaultAnimation?: string;
}

/**
 * A decoration, resolved: one image and where to put it.
 *
 * Produced by the Rust resolver, never assembled here — the editor preview and
 * the map place a tree with the same arithmetic.
 */
export interface ResolvedDecoration {
  id: string;
  resolution: SpriteResolution;
  anchor: PixelOffset;
  /** `[x, y, width, height]` relative to the cell's ground point. */
  placement: PixelRect;
  plane: DecorationPlane;
  order: number;
  /** Id of the animation played; empty when the decoration declares none. */
  animation: string;
  /** Index of the frame within that animation. */
  frame: number;
  /** Path of the image to draw; empty when the frame names none. */
  asset: string;
}

/* ------------------------------------------------------------------ objects */

/** Mirrors `OBJECT_SCHEMA_VERSION`. `2` made the icon a flipbook. */
export const OBJECT_SCHEMA_VERSION = 2;

/** Mirrors `MAX_STACK_SIZE`: the largest stack one inventory slot may hold. */
export const MAX_STACK_SIZE = 9999;

/** The canvas an object's icon is drawn on when its file names none. */
export const DEFAULT_ICON_RESOLUTION: Readonly<SpriteResolution> = { width: 32, height: 32 };

/**
 * What an object is for.
 *
 * Filing, and the one seam an inventory screen may group by. No rule reads it:
 * what a consumable does when consumed is scenario content.
 */
export type ObjectKind = 'consumable' | 'equipment' | 'quest' | 'material' | 'other';

/**
 * A kind of thing a character can carry: a potion, a key, a sword, a letter.
 *
 * Mirrors `crates/world/src/object.rs`. The sibling of
 * {@link DecorationDefinition} and its opposite: a decoration stands on a hex
 * and is drawn in the world, an object travels in an inventory and is drawn in
 * a panel (`docs/adr/ADR-0036-an-object-is-carried-not-placed.md`).
 */
export interface ObjectDefinition {
  id: string;
  schemaVersion: number;
  /** Shown in the editor. Not player-facing, so not a key. */
  name?: string;
  kind?: ObjectKind;
  /** Key of the name a player reads. */
  nameKey?: string;
  /** Key of the description a player reads. */
  descriptionKey?: string;
  /**
   * The images of the icon, in play order. One frame is a still icon.
   *
   * Empty is an object blocked out before its art exists
   * (`docs/adr/ADR-0036-an-object-is-carried-not-placed.md`).
   */
  frames?: string[];
  /** How long each frame lasts, in milliseconds. Unread by a still icon. */
  frameDurationMs?: number;
  /** Whether it starts again when it ends. */
  looping?: boolean;
  /** The canvas every frame is drawn on. */
  resolution?: SpriteResolution;
  /** How many fit in one inventory slot. `1` means it does not stack. */
  stackSize?: number;
  /** Where equipment is worn — an author-owned id such as `head`. */
  slot?: string;
  tags?: string[];
}

/**
 * One object icon, ready to blit. Mirrors `ResolvedObject`.
 *
 * Flat on purpose: a panel should not redo the frame arithmetic to draw a
 * glinting gem.
 */
export interface ResolvedObject {
  id: string;
  resolution: SpriteResolution;
  /** How many frames the icon declares. */
  frames: number;
  /** Index of the frame on screen. */
  frame: number;
  /** Path of the image to draw; empty when the icon names none. */
  asset: string;
  /** How long one full play takes, in milliseconds. */
  durationMs: number;
  looping: boolean;
}
