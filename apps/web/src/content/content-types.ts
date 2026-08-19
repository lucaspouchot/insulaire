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

export const WORLD_SCHEMA_VERSION = 1;
export const TILE_SET_SCHEMA_VERSION = 1;

export interface TileVisual {
  visualId: string;
  fallbackColor: string;
  hints?: Record<string, string>;
}

export interface TileDefinition {
  id: string;
  name?: string;
  terrain: string;
  /** `0` means impassable. */
  movementCost: number;
  tags?: string[];
  visual: TileVisual;
}

export interface TileSetDefinition {
  id: string;
  schemaVersion: number;
  name?: string;
  tiles: TileDefinition[];
}

/** How the renderer projects a world; mirrors the engine's `ProjectionMode`. */
export type ProjectionMode = 'topDown' | 'isometric';

/** Authored elevation is packed as one signed byte per cell for the renderer. */
export const MIN_ELEVATION = -128;
export const MAX_ELEVATION = 127;

/** A cell whose tile differs from {@link WorldDefinition.defaultTile}. */
export interface PlacedTile {
  at: OffsetPair;
  tile: string;
  /** Whole steps of relief, `MIN_ELEVATION`..`MAX_ELEVATION`. Omitted when `0`. */
  elevation?: number;
  tags?: string[];
}

export interface EntityDefinition {
  id: string;
  templateId: string;
  at: OffsetPair;
  tags?: string[];
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
 * whole project is loaded (`docs/adr/ADR-0017-map-links.md`).
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
   * (`docs/adr/ADR-0021-map-zones.md`).
   */
  zone?: string;
  width: number;
  height: number;
  orientation?: 'pointy' | 'flat';
  /** Presentation only; defaults to `topDown` when absent. */
  projection?: ProjectionMode;
  tileSetId: string;
  defaultTile: string;
  tiles?: PlacedTile[];
  entities?: EntityDefinition[];
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
 * (`docs/adr/ADR-0018-client-delivery-build.md`).
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
 * the map the player stands on (`docs/adr/ADR-0021-map-zones.md`). Zones are
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
 * (`docs/adr/ADR-0023-localised-content-keys.md`).
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
 * (`docs/adr/ADR-0024-authored-title-screen.md`).
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

export const SETTINGS_SCHEMA_VERSION = 1;

/**
 * How a setting is presented, and therefore what values it accepts.
 *
 * Mirrors `crates/world/src/settings.rs`. The **same** vocabulary describes the
 * application's own settings and the game's, so one component renders both
 * (`docs/adr/ADR-0025-settings.md`).
 */
export type ControlKind =
  | 'toggle'
  | 'checkbox'
  | 'select'
  | 'multiSelect'
  | 'slider'
  | 'number'
  | 'text'
  | 'color';

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

/** Mirrors `CHARACTER_SCHEMA_VERSION`; `2` is the sprite format (ADR-0029). */
export const CHARACTER_SCHEMA_VERSION = 2;

/** Largest sprite canvas a character may declare, on either side. */
export const MAX_SPRITE_RESOLUTION = 256;

/**
 * What a character definition is used for.
 *
 * Filing, not behaviour: neither the resolver nor the renderer reads it. It
 * exists so an editor can group definitions and a later feature can ask for
 * "the playable ones" without a naming convention
 * (`docs/adr/ADR-0028-character-definitions.md`).
 */
export type CharacterCategory = 'player' | 'npc' | 'enemy' | 'monster' | 'other';

/**
 * The canvas a character's sprites are authored on, in pixels.
 *
 * Every {@link PixelRect} is a position on *this* grid, so a host knows how big
 * the character is without loading a single image
 * (`docs/adr/ADR-0029-characters-are-composed-sprites.md`).
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
  /** Where it is drawn on the character's canvas. */
  rect?: PixelRect;
  sprite: Sprite;
}

/** One piece a character is drawn from. Layers draw back to front. */
export interface CharacterLayer {
  id: string;
  /** The appearances it can take, most specific first — the first match wins. */
  variants: LayerVariant[];
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
}

/** Chosen values by parameter id — a character's customisation. */
export type CharacterValues = Record<string, SettingValue>;

/** One layer of a resolved character, ready to draw. */
export interface ResolvedLayer {
  layer: string;
  variant: string;
  rect: PixelRect;
  /** Path of the image to blit, under the content root. */
  asset: string;
  /** CSS colour to recolour it with. **Empty means draw it as authored.** */
  tint: string;
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
}
